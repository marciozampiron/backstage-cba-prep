// Operational telemetry for the Web BFF (#82 Slice A) — TRANSPORT BOUNDARY, not application code.
//
// Emits ONE sanitized JSON request-completion event per request to stdout. In a deployed runtime
// CloudWatch Logs ingests stdout directly, so there is deliberately NO CloudWatch SDK, no OTEL, no
// X-Ray and no ADOT here — enabling any of those is a separate, human-gated decision (#82 §12).
//
// Privacy contract (`aws-observability-baseline.md` §7): the event is built from an ALLOWLIST, so
// a field can only appear if it is named below. Nothing derived from a request/response body,
// header, cookie, token, claim, learner id, attempt/session/question id, exam content or URL is
// ever eligible — those values never reach this module.
//
// Cardinality: every dimension is bounded — `routeKey` is the matched route PATTERN (never the
// concrete path, so ids cannot widen it), `errorCode` is a stable contract code, `statusCode` and
// `runtimeEnv` are small closed sets. `requestId` is high-cardinality but is a log FIELD only,
// never a metric dimension, and it is what makes the API-to-Lambda correlation query resolve.

/** The complete set of keys a completion event may carry. Anything else is dropped. */
export const COMPLETION_EVENT_FIELDS = [
  'level',
  'message',
  'requestId',
  'routeKey',
  'method',
  'statusCode',
  'durationMs',
  'errorCode',
  'runtimeEnv',
];

// Values that are safe to render as-is: short, bounded, provider-neutral scalars.
const MAX_SCALAR_LENGTH = 200;

function safeScalar(value) {
  if (value === null || value === undefined) return undefined;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'string') return value.length > MAX_SCALAR_LENGTH ? undefined : value;
  // Objects, arrays, functions and symbols can carry payloads — never emitted.
  return undefined;
}

/**
 * Build the sanitized completion event. PURE: takes already-safe primitives and returns a plain
 * object containing ONLY allowlisted, scalar fields — no I/O, so the allowlist is testable
 * offline and a leak fails in a unit test rather than in production logs.
 */
export function buildCompletionEvent(input = {}) {
  const event = {};
  for (const field of COMPLETION_EVENT_FIELDS) {
    const value = safeScalar(input[field]);
    if (value !== undefined) event[field] = value;
  }
  return event;
}

/**
 * Emit exactly one completion event. Single-line JSON so CloudWatch Logs Insights can parse it
 * without a custom pattern.
 *
 * @param {object} input allowlisted fields; anything else is silently dropped by the allowlist
 * @param {(line: string) => void} [write] injectable sink (tests capture instead of printing)
 */
export function emitCompletionEvent(input, write = (line) => console.log(line)) {
  write(JSON.stringify(buildCompletionEvent(input)));
}
