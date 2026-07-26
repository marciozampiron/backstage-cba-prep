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
