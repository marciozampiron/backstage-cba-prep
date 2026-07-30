// Smoke-run identity (#75) — the second half of the cleanup scope.
//
// #70's deployed smokes create practice sessions, mock exams, attempts and answers, and the
// `always()` cleanup job has to remove exactly what THAT run created — through the BFF, as the
// smoke learner itself, never with a deploy role reaching DynamoDB directly.
//
// WHY THE RUN IS NOT A TOKEN CLAIM. The first version of this module read `principal.smokeRunId`
// from the validated principal. That cannot work: a Cognito ACCESS token carries `sub`, `token_use`,
// `client_id`, `scope` and groups — not custom attributes. Putting a per-run value in one needs
// either an admin call per run or a pre-token-generation trigger, and both are infrastructure this
// issue is not authorized to introduce. A design whose identity can never be issued is not a design.
//
// WHAT REPLACES IT. #75 explicitly allows "learner-owned deletion through the BFF", so the run is a
// RECORD the BFF mints and owns, exactly like a practice session:
//
//   POST /smoke-runs                  -> the BFF mints a run id and stores it against the caller
//   X-CBA-Smoke-Run: <runId>          -> stamps subsequent writes, ACCEPTED ONLY if that run record
//                                        belongs to the authenticated learner
//   DELETE /smoke-runs/:runId/data    -> capability + ownership, deletes the run's DATA and CLOSES
//                                        the run. The run record itself is never deleted: it
//                                        becomes a tombstone with a bounded expiry, so ownership
//                                        outlives the data and a replay stays deterministic.
//
// The header is therefore a REFERENCE, not an authorization — the same shape as a session id in a
// path. It grants nothing on its own: an unknown run id, or one owned by somebody else, is refused,
// so no caller can name their way into another learner's data.

/**
 * A smoke run id: bounded and opaque.
 *
 * It reaches a route path, a header and a persistence key, so an unbounded string would be both an
 * injection surface and an unbounded partition key. The alphabet excludes separators for the same
 * reason.
 */
export const SMOKE_RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{7,63}$/;

export function isValidSmokeRunId(value) {
  return typeof value === 'string' && SMOKE_RUN_ID_PATTERN.test(value);
}

/** The header that REFERENCES an already-owned run. It never establishes one. */
export const SMOKE_RUN_HEADER = 'x-cba-smoke-run';

/**
 * Read the referenced run id from request headers, or `null`.
 *
 * Deliberately does no authorization: the caller must still hold the smoke capability AND prove the
 * run record belongs to them. `null` here means "not a usable reference"; the dispatcher
 * distinguishes the cases, because a PRESENT header must fail closed — a malformed one is a 400 and
 * an unknown or unowned one a 403. Only an ABSENT header is ordinary traffic.
 */
export function readSmokeRunHeader(headers = {}) {
  const raw = headers[SMOKE_RUN_HEADER];
  return isValidSmokeRunId(raw) ? raw : null;
}

/**
 * The Cognito group whose members may operate smoke runs.
 *
 * A GROUP rather than a custom attribute, because `cognito:groups` is actually present on an access
 * token. Membership is pre-provisioned once per environment for the dedicated smoke learners — this
 * grants nothing per run, so no admin call happens on the smoke path.
 */
export const SMOKE_GROUP = 'cba-smoke';

/** The local-only header that stands in for the group when auth mode is `dev`. */
export const SMOKE_CAPABILITY_HEADER = 'x-cba-smoke';

/**
 * May this caller operate smoke runs at all?
 *
 * This is the authorization; the run id is only a reference. Without it, any authenticated learner
 * could mint a run and reach a deletion endpoint — an opaque id and an absent CORS method are not
 * authorization, they are obscurity.
 */
export function hasSmokeCapability(headers = {}, principal = null, { mode = 'dev' } = {}) {
  if (mode === 'cognito') {
    // Deployed: the validated claim only. A header here would let any learner token self-promote.
    return Array.isArray(principal?.groups) && principal.groups.includes(SMOKE_GROUP);
  }
  return headers[SMOKE_CAPABILITY_HEADER] === SMOKE_GROUP;
}
