// Operational telemetry for the Web BFF (#82 Slice A) — TRANSPORT BOUNDARY, not application code.
//
// Emits ONE sanitized JSON request-completion event per request to stdout. In a deployed runtime
// CloudWatch Logs ingests stdout directly, so there is deliberately NO CloudWatch SDK, no OTEL, no
// X-Ray and no ADOT here — enabling any of those is a separate, human-gated decision (#82 §12).
//
// SECURITY MODEL (hardened after the #85 review). Safety comes from THREE layers together, and the
// key allowlist alone is NOT one of them on its own:
//
//   1. INTERNAL ORIGIN — every field is produced by this service (the dispatcher's own routing
//      table, HTTP status, clock and runtime config) or copied from API Gateway's request id.
//      No header, cookie, body, claim, query value or learner-supplied string is ever eligible.
//   2. KEY ALLOWLIST — only the nine names below can appear at all.
//   3. PER-FIELD VALIDATORS — each key additionally constrains its VALUE to a closed enum or a
//      narrow format. A key allowlist by itself would happily serialize
//      `requestId: "Bearer-super-secret"` or `routeKey: "GET learner@example.test"`, so the
//      validators are what actually bound the content.
//
// A value that fails its validator is OMITTED, never coerced and never logged elsewhere: telemetry
// is a side channel and must not break or reshape a valid business result.
//
// Cardinality: every dimension is bounded — `routeKey` is the matched route PATTERN (never the
// concrete path, so ids cannot widen it), `errorCode` is a stable contract code, `statusCode`,
// `level`, `method` and `runtimeEnv` are small closed sets. `requestId` is high-cardinality but is
// a log FIELD only, never a metric dimension, and it is what makes the API-to-Lambda correlation
// query resolve.

/* ---------------- per-field validators ---------------- */

const LEVELS = new Set(['info', 'error']);
const MESSAGES = new Set(['request.completed']);
const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);
const RUNTIME_ENVS = new Set(['local', 'dev', 'pilot']);

// Contract error codes are stable SCREAMING_SNAKE identifiers (`NOT_FOUND`, `VALIDATION_FAILED`,
// `NOT_RESOURCE_OWNER`, …). Anything with lower case, spaces or punctuation is not one of ours.
const ERROR_CODE = /^[A-Z][A-Z0-9_]{1,63}$/;

// The routeKey the dispatcher builds is `METHOD /contract/pattern`, where the pattern may contain
// `:name` parameters — never a concrete id, query string, host or email.
const ROUTE_KEY = /^(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS) \/[A-Za-z0-9/:_-]*$/;

// Correlation ids we accept: API Gateway's `$context.requestId` and our own `loc_`/`req_` ids.
// Deliberately narrow — no whitespace, no control characters, no `@`, no `/`, no scheme.
const REQUEST_ID = /^[A-Za-z0-9_=.:-]{1,128}$/;

// Defense in depth ONLY — the real boundary is that these fields are internally generated.
//
// SHAPE markers are unambiguous credential encodings, so they are refused in EVERY string field:
// no legitimate route key or contract code looks like an AWS key id or a JWT.
const CREDENTIAL_SHAPE = /AKIA[0-9A-Z]{16}|^eyJ[A-Za-z0-9_-]{6,}|^sk-[A-Za-z0-9]{8,}|^gh[posu]_[A-Za-z0-9]{8,}/;

// WORD markers are English tokens a plausible FUTURE contract code could legitimately use
// (`TOKEN_EXPIRED`, `INVALID_AUTHORIZATION`), so they are refused only in `requestId`, whose value
// is fully opaque and can never legitimately contain them.
const CREDENTIAL_WORD = /bearer|basic|authorization|password|secret|token|credential/i;

function isCleanScalarString(value, pattern) {
  if (typeof value !== 'string') return false;
  // Control characters can forge log lines (CWE-117) even inside an otherwise valid charset.
  if (/[\x00-\x1f\x7f]/.test(value)) return false;
  if (CREDENTIAL_SHAPE.test(value)) return false;
  return pattern.test(value);
}

function isValidRequestId(value) {
  if (!isCleanScalarString(value, REQUEST_ID)) return false;
  return !CREDENTIAL_WORD.test(value);
}

function isHttpStatus(value) {
  return Number.isInteger(value) && value >= 100 && value <= 599;
}

function isDuration(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/**
 * The complete set of keys a completion event may carry, each with the validator its VALUE must
 * satisfy. A field missing from this map can never be emitted; a value failing its validator is
 * dropped.
 */
export const FIELD_VALIDATORS = {
  level: (v) => typeof v === 'string' && LEVELS.has(v),
  message: (v) => typeof v === 'string' && MESSAGES.has(v),
  requestId: isValidRequestId,
  routeKey: (v) => isCleanScalarString(v, ROUTE_KEY),
  method: (v) => typeof v === 'string' && METHODS.has(v),
  statusCode: isHttpStatus,
  durationMs: isDuration,
  errorCode: (v) => isCleanScalarString(v, ERROR_CODE),
  runtimeEnv: (v) => typeof v === 'string' && RUNTIME_ENVS.has(v),
};

/** Field order is stable so log lines stay diffable. */
export const COMPLETION_EVENT_FIELDS = Object.keys(FIELD_VALIDATORS);

/**
 * Build the sanitized completion event. PURE: returns a plain object containing ONLY allowlisted
 * keys whose values passed their own validator — no I/O, so a leak fails in a unit test rather
 * than in production logs.
 */
export function buildCompletionEvent(input = {}) {
  const event = {};
  if (input === null || typeof input !== 'object') return event;
  for (const field of COMPLETION_EVENT_FIELDS) {
    const value = input[field];
    if (FIELD_VALIDATORS[field](value)) event[field] = value;
  }
  return event;
}

/**
 * Emit exactly one completion event. Single-line JSON so CloudWatch Logs Insights can parse it
 * without a custom pattern.
 *
 * The CALLER owns failure isolation: this function may throw if the sink throws, and the
 * dispatcher treats emission as best-effort so a broken sink can never change a business result.
 *
 * @param {object} input allowlisted fields; anything else is dropped by the allowlist/validators
 * @param {(line: string) => void} [write] injectable sink (tests capture instead of printing)
 */
export function emitCompletionEvent(input, write = (line) => console.log(line)) {
  write(JSON.stringify(buildCompletionEvent(input)));
}
