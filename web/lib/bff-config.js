// Web BFF runtime configuration (#67 Stage A) — SERVER-SIDE ONLY.
//
// `CBA_BFF_BASE_URL` is the environment's Web BFF (API Gateway) origin. Per
// pilot-environment-contract.md §3 and the binding decision on #67, it is a Cloudflare Worker
// RUNTIME variable resolved per request — never a `NEXT_PUBLIC_*` value, because Next.js inlines
// those at build time and that would break the build-once / promote-the-same-artifact rule of the
// #56 smoke design.
//
// Approved design (#67 review): the Worker SERVES this base URL to the browser at request time
// through `/auth/config`, and `apiFetch` prefixes it — the browser calls the AWS API Gateway
// directly, guarded by the exact-origin CORS seam delivered in #69. `apiFetch` stays the single
// door; there is no second access path.

const DEPLOYED_ENVS = ['dev', 'pilot'];
const RUNTIME_ENVS = ['local', ...DEPLOYED_ENVS];

/** @typedef {{ runtimeEnv: 'local'|'dev'|'pilot', bffBaseUrl: string|null, sameOrigin: boolean }} BffConfig */

function validateBaseUrl(raw) {
  if (raw !== raw.trim()) {
    throw new Error('CBA_BFF_BASE_URL must not have leading/trailing whitespace.');
  }
  if (raw.includes('*')) {
    throw new Error('CBA_BFF_BASE_URL must be an exact origin — wildcards are forbidden.');
  }
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`CBA_BFF_BASE_URL must be an absolute URL — got "${raw}".`);
  }
  const isLoopback = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1';
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && isLoopback)) {
    throw new Error('CBA_BFF_BASE_URL must use https:// (http:// is allowed only for localhost).');
  }
  if (parsed.username || parsed.password) {
    throw new Error('CBA_BFF_BASE_URL must not embed credentials.');
  }
  if (parsed.search || parsed.hash) {
    throw new Error('CBA_BFF_BASE_URL must be an origin/base path only — no query string or fragment.');
  }
  // Normalise: no trailing slash, so callers can join paths without doubling separators.
  return raw.replace(/\/+$/, '');
}

/**
 * Resolve the BFF runtime configuration from a plain env-shaped object (Worker binding env in a
 * deployed runtime, `process.env` locally). Pure — no I/O, no globals — so it is fully testable
 * offline.
 *
 * Contract, mirroring services/bff `CBA_RUNTIME_ENV` semantics:
 *   local (or unset) → the base URL is OPTIONAL; when absent the frontend stays same-origin `/api`.
 *   dev | pilot      → the base URL is REQUIRED and validated: a deployed frontend must never
 *                      silently fall back to a same-origin BFF that does not exist there.
 *
 * `onWorkers` tightens both rules, because a Cloudflare Worker IS a deployed runtime: the tier
 * must be stated explicitly (no `local` default to inherit) and `local` is not a legal value
 * there. Only Node hosts — `next dev`, `next start`, tests — may fall back to `local`.
 *
 * @param {Record<string, string|undefined>} env
 * @param {{ onWorkers?: boolean }} [opts]
 * @returns {BffConfig}
 */
export function resolveBffConfig(env = {}, { onWorkers = false } = {}) {
  if (onWorkers && !env.CBA_RUNTIME_ENV) {
    throw new Error(
      `CBA_RUNTIME_ENV is required on Cloudflare Workers and must be one of ${DEPLOYED_ENVS.join('|')} — ` +
        'a deployed runtime never inherits the local default.',
    );
  }
  const runtimeEnv = env.CBA_RUNTIME_ENV ?? 'local';
  const allowed = onWorkers ? DEPLOYED_ENVS : RUNTIME_ENVS;
  if (!allowed.includes(runtimeEnv)) {
    throw new Error(
      `CBA_RUNTIME_ENV must be one of ${allowed.join('|')} — got "${runtimeEnv}"` +
        `${onWorkers ? ' (Cloudflare Workers is a deployed runtime; "local" is not valid there)' : ''}.`,
    );
  }

  const raw = env.CBA_BFF_BASE_URL;
  const deployed = DEPLOYED_ENVS.includes(runtimeEnv);

  if (raw === undefined || raw === '') {
    if (deployed) {
      // Fail fast: a dev/pilot Worker with no BFF origin is a misconfiguration, not a default.
      throw new Error(
        `CBA_RUNTIME_ENV=${runtimeEnv} requires CBA_BFF_BASE_URL (the environment's Web BFF origin). ` +
          'It is a Worker runtime variable — never a NEXT_PUBLIC_* build-time constant.',
      );
    }
    return { runtimeEnv, bffBaseUrl: null, sameOrigin: true };
  }

  const bffBaseUrl = validateBaseUrl(raw);
  if (!deployed) {
    // Explicitly allowed: pointing a local dev server at a deployed BFF while debugging.
    return { runtimeEnv, bffBaseUrl, sameOrigin: false };
  }
  return { runtimeEnv, bffBaseUrl, sameOrigin: false };
}

/** True only inside the Cloudflare Workers runtime. */
export function onCloudflareWorkers() {
  return globalThis.navigator?.userAgent === 'Cloudflare-Workers';
}

/**
 * The env this server code should read: the Cloudflare Worker BINDING env on Workers, merged over
 * `process.env`; plain `process.env` under Node (`next dev` / `next start`).
 *
 * FAIL CLOSED on Workers: the adapter import and the context lookup are NOT wrapped in a catch.
 * If a deployed Worker cannot read its own bindings that is a real misconfiguration, and it must
 * surface — swallowing it would silently degrade a deployed runtime to the local defaults.
 *
 * @returns {Promise<Record<string, string|undefined>>}
 */
export async function getRuntimeEnv() {
  const base = typeof process !== 'undefined' && process.env ? process.env : {};
  if (!onCloudflareWorkers()) return base;
  const { getCloudflareContext } = await import('@opennextjs/cloudflare');
  const context = await getCloudflareContext({ async: true });
  return { ...base, ...context.env };
}

/** @returns {Promise<BffConfig>} */
export async function getBffConfig() {
  return resolveBffConfig(await getRuntimeEnv(), { onWorkers: onCloudflareWorkers() });
}

/**
 * Resolve the Cognito values the Worker serves through `/auth/config` (#67 Stage B).
 *
 * These are runtime variables for the same reason `CBA_BFF_BASE_URL` is: `/auth/config` is served
 * per request from the Worker binding env, so one built artifact can be promoted across tiers
 * unchanged. They are supplied per environment by the #70 deploy, never committed, and never
 * `NEXT_PUBLIC_*`.
 *
 * Presence alone is not enough. The Cognito callback and logout URLs still default to the reserved
 * `.invalid` placeholder while the custom-domain-vs-`workers.dev` decision is open, and a
 * placeholder that reaches a deployed tier renders a sign-in button that cannot complete — the
 * page looks healthy and the flow is dead. So a deployed tier refuses a `.invalid` domain here,
 * where the failure is visible, rather than in the browser after redirect.
 *
 * Pure and env-shaped, like `resolveBffConfig`, so it is testable with no Worker and no network.
 *
 * @param {Record<string, string|undefined>} env
 * @param {{ deployed?: boolean }} options
 * @returns {{ userPoolId: string, clientId: string, domain: string }}
 */
export function resolveCognitoConfig(env = {}, { deployed = false } = {}) {
  const read = (key, { isUrl = false } = {}) => {
    const raw = env[key];
    if (typeof raw !== 'string' || raw.trim() === '') {
      throw new Error(`${key} is required when CBA_WEB_AUTH=cognito.`);
    }
    if (raw !== raw.trim()) {
      throw new Error(`${key} must not have leading/trailing whitespace.`);
    }
    // These values are SERVED PUBLICLY by /auth/config. A misconfiguration that put a secret in one
    // of these variables would publish it to every browser that loads the page, so shape is checked
    // rather than mere presence — the id formats are narrow, and anything outside them is a
    // misconfiguration whatever it turns out to be.
    assertNotCredentialShaped(key, raw, { isUrl });
    return raw;
  };

  const userPoolId = read('COGNITO_USER_POOL_ID');
  const clientId = read('COGNITO_CLIENT_ID');
  // The domain IS a URL by contract, so the URL tripwire does not apply to it — every other
  // tripwire still does, and its shape is validated as a URL below.
  const domain = read('COGNITO_DOMAIN', { isUrl: true });

  // `<region>_<suffix>` — the documented Cognito user-pool id format.
  if (!/^[a-z]{2}(-[a-z]+)+-\d_[A-Za-z0-9]{1,32}$/.test(userPoolId)) {
    throw new Error('COGNITO_USER_POOL_ID must look like "<region>_<id>".');
  }
  // App client ids are lowercase alphanumeric. The bound is generous rather than exactly 26, so a
  // format change does not break a deployment, but it still excludes JWTs, ARNs and URLs.
  if (!/^[a-z0-9]{16,64}$/.test(clientId)) {
    throw new Error('COGNITO_CLIENT_ID must be 16-64 lowercase alphanumeric characters.');
  }

  // `auth-settings.js` uses the domain as a URL BASE (`new URL('/logout', domain)`), so it must be
  // an absolute origin — a bare host would resolve relative to the frontend and send the learner to
  // a logout URL on the wrong site.
  let parsed;
  try {
    parsed = new URL(domain);
  } catch {
    throw new Error('COGNITO_DOMAIN must be an absolute URL.');
  }
  if (parsed.protocol !== 'https:') {
    throw new Error('COGNITO_DOMAIN must use https://.');
  }
  // A path is not cosmetic here: `new URL('/logout', base)` DISCARDS it, so a domain carrying one
  // would silently produce a different logout URL than the operator configured.
  if (parsed.pathname !== '/' || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error('COGNITO_DOMAIN must be an origin only — no path, credentials, query string or fragment.');
  }
  if (deployed && (parsed.hostname === 'invalid' || parsed.hostname.endsWith('.invalid'))) {
    throw new Error(
      'COGNITO_DOMAIN is still the reserved .invalid placeholder — a deployed tier cannot complete '
      + 'a sign-in redirect with it. Set the environment\'s real Cognito domain.',
    );
  }

  // Normalised: the origin, with no trailing path, so callers join paths against a stable base.
  return { userPoolId, clientId, domain: parsed.origin };
}

/**
 * Refuse values that carry the shape of credential material.
 *
 * This is defence in depth, not a boundary — the real boundary is that these variables are supposed
 * to hold ids. It exists because the consequence of being wrong is asymmetric: an id in the wrong
 * place is a broken sign-in, while a secret in the wrong place is published to every browser.
 *
 * The rejected VALUE is never included in the message, and `/auth/config` answers with a generic
 * code, so a mistake cannot be echoed into a log or a response.
 */
function assertNotCredentialShaped(key, value, { isUrl = false } = {}) {
  if (/[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`${key} must not contain control characters.`);
  }
  if (value.length > 256) {
    throw new Error(`${key} is implausibly long for an identifier.`);
  }
  const tripwires = [
    [/^eyJ[A-Za-z0-9_-]/, 'a JSON Web Token'],
    [/^(AKIA|ASIA)[A-Z0-9]{16}$/, 'an AWS access key id'],
    [/^arn:/i, 'an ARN'],
    [/^https?:\/\//i, 'a URL'],
    [/-----BEGIN [A-Z ]+-----/, 'a PEM block'],
    [/^(?:xox[abposr]-|ghp_|github_pat_|sk-)/i, 'a provider token'],
  ];
  for (const [pattern, what] of tripwires) {
    // COGNITO_DOMAIN is a URL by contract; every other tripwire still applies to it.
    if (what === 'a URL' && isUrl) continue;
    if (pattern.test(value)) throw new Error(`${key} looks like ${what}, not an identifier.`);
  }
}
