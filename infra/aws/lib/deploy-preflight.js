// Deploy preflight (#70 Slice A) — PREFLIGHT-1 and PREFLIGHT-2, as PURE evaluation.
//
// #69 registered two binding conditions against #70 and then closed. They are recorded in
// `.agent-handoff/active/70-cloudflare-aws-deploy-pipeline.md` and implemented here.
//
// WHY THIS FILE HAS NO I/O. Every verdict is a function of observations, exactly like
// `src/lib/observability-gate.js`: the adversarial controls are ordinary unit tests, and no test
// needs an AWS account, a network or a deployed environment to exercise a refusal. The collector in
// `bin/deploy-preflight.js` gathers the observations; it decides nothing.
//
// WHY IT MUST RUN BEFORE `cdk deploy` AND NOT AFTER. Both conditions guard resources that are
// expensive or impossible to walk back. A Cognito hosted-UI domain is created early in the
// IdentityStack deployment; by the time a post-hoc check notices the prefix was wrong, the domain
// exists, and a callback URL pointing at `.invalid` means every learner sign-in in that environment
// is broken with real users already routed to it. `deploy-pilot.yml` encodes the ordering, and a
// static invariant test asserts that any job running `cdk deploy` depends on the preflight job.
//
// FAIL-CLOSED EVERYWHERE. An observation that could not be taken is a FAILURE, never a pass. The
// failure mode this defends against is the quiet one: a probe that errored, a region that was not
// supplied, a context key that resolved to a default. None of those is evidence of safety.
const { DEFAULT_AUTH_URLS, defaultAuthDomainPrefix, parseExactUrlList, VALID_ENVIRONMENTS } = require('./context');

/** The RFC 2606 reserved TLD the committed pilot placeholder uses. */
const RESERVED_TLD = 'invalid';

/**
 * Cognito hosted-UI domain prefix rules, as Cognito itself enforces them.
 *
 * Checked here so a malformed prefix fails in seconds instead of mid-stack, after the User Pool and
 * its client already exist. Cognito additionally rejects any prefix containing `aws`, `amazon` or
 * `cognito`; that is not a style rule, it is a hard API refusal.
 */
const PREFIX_SHAPE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const PREFIX_MAX = 63;
const RESERVED_WORDS = ['aws', 'amazon', 'cognito'];

/** Probe outcomes the collector may report. Anything else is treated as unusable. */
const PROBE = {
  AVAILABLE: 'AVAILABLE',
  TAKEN_BY_OTHER: 'TAKEN_BY_OTHER',
  TAKEN_BY_EXPECTED_POOL: 'TAKEN_BY_EXPECTED_POOL',
  ERROR: 'ERROR',
  NOT_CHECKED: 'NOT_CHECKED',
};

class PreflightError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PreflightError';
  }
}

/**
 * Does this URL point at the reserved placeholder TLD?
 *
 * Decided on the parsed HOSTNAME, not on a substring of the raw URL. A substring test would both
 * miss nothing and flag too much: `https://app.example.com/x.invalid.css` is a legitimate path, and
 * `https://pilot.invalid.attacker.com` is NOT the reserved TLD — it is a real, resolvable host that
 * a substring rule would wave through as "obviously the placeholder" while a hostname rule reads it
 * correctly as a live origin.
 */
function isReservedPlaceholder(url) {
  let host;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    // Unparseable URLs are not this check's business — `parseExactUrlList` already refused them.
    return false;
  }
  return host === RESERVED_TLD || host.endsWith(`.${RESERVED_TLD}`);
}

/**
 * Resolve the callback/logout lists exactly as `IdentityStack` will.
 *
 * Same defaults, same parser. If the parser refuses, that is a preflight failure rather than an
 * exception: a configuration that cannot synth is a configuration that must not reach `cdk deploy`.
 *
 * @param {object} context effective CDK context (cdk.json context merged with `-c` overrides)
 * @param {string} environment
 */
function resolveAuthUrls(context, environment) {
  const defaults = DEFAULT_AUTH_URLS[environment];
  const out = {};
  for (const [key, contextKey] of [
    ['callback', 'authCallbackUrls'],
    ['logout', 'authLogoutUrls'],
  ]) {
    const supplied = Object.hasOwn(context, contextKey) ? context[contextKey] : undefined;
    const raw = supplied === undefined ? defaults[key] : supplied;
    out[key] = { contextKey, supplied: supplied !== undefined, urls: parseExactUrlList(raw, contextKey) };
  }
  return out;
}

/**
 * PREFLIGHT-1 — refuse while the reserved placeholder survives into the effective configuration.
 *
 * Evaluated on the EFFECTIVE value after context resolution, never on the committed default. An
 * override that silently failed to apply — a typo in the key, a `-c` that never reached the CLI, a
 * workflow input that expanded to empty — looks identical to one that was never attempted. Reading
 * the resolved value is the only way to tell those apart.
 */
function evaluatePreflight1({ environment, context }) {
  const failures = [];
  let resolved;
  try {
    resolved = resolveAuthUrls(context, environment);
  } catch (err) {
    return {
      id: 'PREFLIGHT-1',
      ok: false,
      failures: [`the auth URL configuration is invalid and would fail synth: ${err.message}`],
      observed: null,
    };
  }

  for (const { contextKey, supplied, urls } of Object.values(resolved)) {
    const placeholders = urls.filter(isReservedPlaceholder);
    if (placeholders.length === 0) continue;
    failures.push(
      `${contextKey} still resolves to the reserved .${RESERVED_TLD} placeholder ` +
        `(${placeholders.join(', ')})` +
        (supplied
          ? ' — it was supplied explicitly, so the override itself carries the placeholder'
          : ' — no override was supplied, so the committed default survived'),
    );
  }

  return {
    id: 'PREFLIGHT-1',
    ok: failures.length === 0,
    failures,
    observed: Object.fromEntries(Object.entries(resolved).map(([k, v]) => [k, { supplied: v.supplied, urls: v.urls }])),
  };
}

/**
 * PREFLIGHT-2 — refuse unless the domain prefix was explicitly supplied AND confirmed unique.
 *
 * BOTH halves are load-bearing and neither implies the other.
 *
 * Explicit supply: `IdentityStack` falls back to `cba-study-coach-<env>`, so a value always exists
 * at synth time and "a prefix is set" proves nothing. Presence of the CONTEXT KEY is the signal.
 *
 * Confirmed uniqueness: hosted-UI prefixes are globally unique per region. An unverified prefix does
 * not fail fast — it fails during the deployment, after the User Pool and client exist, leaving a
 * half-built stack to roll back.
 *
 * `TAKEN_BY_EXPECTED_POOL` is the redeploy case and is a PASS: the domain is already ours. It
 * requires the caller to have supplied the expected pool id; without it, "taken" is indistinguishable
 * from "taken by somebody else" and must refuse.
 */
function evaluatePreflight2({ environment, context, domainProbe }) {
  const failures = [];
  const contextKey = 'authDomainPrefix';
  const supplied = Object.hasOwn(context, contextKey) ? context[contextKey] : undefined;
  const effective = supplied === undefined ? defaultAuthDomainPrefix(environment) : supplied;

  if (supplied === undefined) {
    failures.push(
      `${contextKey} was not supplied — the stack would silently fall back to "${effective}". ` +
        'An unsupplied prefix is indistinguishable from a deliberate one, which is why this ' +
        'condition asks for the KEY, not for a value.',
    );
  } else if (typeof supplied !== 'string' || supplied.trim() === '') {
    failures.push(`${contextKey} must be a non-empty string; received ${JSON.stringify(supplied)}`);
  } else {
    if (supplied !== supplied.trim()) {
      failures.push(`${contextKey} "${supplied}" has leading or trailing whitespace`);
    }
    const value = supplied.trim();
    if (value.length > PREFIX_MAX) {
      failures.push(`${contextKey} "${value}" is ${value.length} characters; Cognito allows at most ${PREFIX_MAX}`);
    }
    if (!PREFIX_SHAPE.test(value)) {
      failures.push(
        `${contextKey} "${value}" is not a valid Cognito domain prefix — lowercase letters, digits ` +
          'and single hyphens only, and it may not start or end with a hyphen',
      );
    }
    for (const word of RESERVED_WORDS) {
      if (value.includes(word)) {
        failures.push(`${contextKey} "${value}" contains the reserved word "${word}", which Cognito rejects`);
      }
    }
  }

  // Uniqueness is evaluated even when supply failed, so one run reports every reason it refused
  // rather than making an operator discover them one deploy at a time.
  const status = domainProbe?.status ?? PROBE.NOT_CHECKED;
  if (status === PROBE.AVAILABLE) {
    if (!domainProbe.region) failures.push('the uniqueness probe reported no region — it cannot confirm "unique in the target region"');
  } else if (status === PROBE.TAKEN_BY_EXPECTED_POOL) {
    if (!domainProbe.expectedUserPoolId) {
      failures.push(
        'the probe reported the domain is already ours, but no expected user pool id was supplied — ' +
          'without it, "ours" cannot be distinguished from "somebody else\'s"',
      );
    }
    if (!domainProbe.region) failures.push('the uniqueness probe reported no region — it cannot confirm "unique in the target region"');
  } else if (status === PROBE.TAKEN_BY_OTHER) {
    failures.push(
      `the domain prefix "${effective}" is already taken in ${domainProbe.region || 'the target region'}` +
        (domainProbe.detail ? ` (${domainProbe.detail})` : ''),
    );
  } else if (status === PROBE.ERROR) {
    failures.push(
      `the uniqueness probe failed and its result is unusable${domainProbe.detail ? `: ${domainProbe.detail}` : ''} — ` +
        'an unanswered question is not a confirmation',
    );
  } else {
    failures.push('the uniqueness probe was not run — the prefix is unconfirmed and this gate fails closed');
  }

  return { id: 'PREFLIGHT-2', ok: failures.length === 0, failures, observed: { supplied: supplied !== undefined, effective, status } };
}

/**
 * Run both conditions. Never short-circuits: an operator should see every reason at once.
 *
 * @returns {{ok: boolean, environment: string, checks: object[], failures: string[]}}
 */
function evaluatePreflight({ environment, context = {}, domainProbe = null } = {}) {
  if (!VALID_ENVIRONMENTS.includes(environment)) {
    throw new PreflightError(
      `environment must be one of ${VALID_ENVIRONMENTS.join('|')} — got ${JSON.stringify(environment)}`,
    );
  }
  if (context === null || typeof context !== 'object' || Array.isArray(context)) {
    throw new PreflightError('context must be a plain object of resolved CDK context values');
  }

  const checks = [
    evaluatePreflight1({ environment, context }),
    evaluatePreflight2({ environment, context, domainProbe }),
  ];
  return {
    ok: checks.every((c) => c.ok),
    environment,
    checks,
    failures: checks.flatMap((c) => c.failures.map((f) => `${c.id}: ${f}`)),
  };
}

module.exports = {
  PROBE,
  PREFIX_MAX,
  RESERVED_TLD,
  RESERVED_WORDS,
  PreflightError,
  isReservedPlaceholder,
  resolveAuthUrls,
  evaluatePreflight1,
  evaluatePreflight2,
  evaluatePreflight,
};
