// Application-owned rate bounds for expensive operations (#90, SEC-WEB-01 / SEC-AI-05).
//
// The stage throttle (ApiStack, #90) bounds the WHOLE surface per second; it cannot tell one
// principal from another, so a single caller could still spend the entire stage budget on the
// expensive creations. These bounds are partitioned by the TRUSTED server identity — the
// learnerId the dispatcher resolves from authorizer-validated claims — and by the matched route
// PATTERN, never by anything the caller supplies: a body- or query-supplied identifier cannot
// move a request into another caller's window, because nothing here ever reads one.
//
// The table is CLOSED and each bound is at or below the dev stage default (10 r/s), per the
// baseline: "Expensive endpoints use server-principal application bounds equal to or lower than
// the stage default." Conservative starting values, not a capacity promise; increases require
// traffic/cost evidence and human security review (#90). Cheap read/answer traffic is deliberately
// NOT bounded here — the stage throttle owns it — so normal drill, mock, review, profile and
// coach flows keep working while repeated CREATION abuse is bounded.
//
// Enforcement is a fixed window: window start is floor(now / windowMs) * windowMs, and the
// repository consumes one unit atomically (conditional write in DynamoDB, same contract in the
// local adapters). Fixed windows admit at most 2x the bound across one boundary — accepted and
// documented; the values below leave room for that.
export const RATE_BOUNDS = Object.freeze({
  // Mock creation writes a full attempt record set and claims the active-mock slot.
  'POST /mock-exams': Object.freeze({ limit: 5, windowMs: 60_000 }),
  // The deterministic coach is the seam where future model-backed (paid) calls land (#90:
  // "future learner-triggered AI endpoints") — bounded BEFORE that lands, not after.
  'POST /coach/message': Object.freeze({ limit: 10, windowMs: 60_000 }),
  // Drill creation writes a session record per call.
  'POST /practice-sessions': Object.freeze({ limit: 10, windowMs: 60_000 }),
  // Smoke-run minting is capability-gated already; the bound stops a leaked capability from
  // minting runs in a loop.
  'POST /smoke-runs': Object.freeze({ limit: 5, windowMs: 60_000 }),
});

/** The window a given instant falls in — one canonical derivation for every adapter. */
export function windowStartOf(nowMs, windowMs) {
  return Math.floor(nowMs / windowMs) * windowMs;
}

/**
 * The storage partition for one (learner, operation, window) — used verbatim by every adapter so
 * the same request stream lands in the same window everywhere. The operation component is the
 * matched route PATTERN (bounded vocabulary), never a concrete path, so no session/attempt id can
 * enter a storage key through here.
 *
 * The separator is NUL, deliberately: a dev-mode learner id arrives from a header and may contain
 * any printable text, so a printable separator would let one caller CRAFT a key that collides
 * with another caller's partition ("a" + " POST ..." vs "a POST ..." + ...). NUL cannot travel
 * through an HTTP header, so no caller-controllable component can contain the separator.
 */
export function rateWindowKey(learnerId, routeKey, windowStartMs) {
  // As an ESCAPE, not a literal control byte: editors normalize raw NULs; the escape survives.
  return [learnerId, routeKey, String(windowStartMs)].join('\u0000');
}
