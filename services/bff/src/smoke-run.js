// Smoke-run identity (#75) — the second half of the cleanup scope.
//
// The #70 deployed smokes create practice sessions, mock exams, attempts and answers, and the
// `always()` cleanup job has to remove exactly what THAT run created — through the BFF, as the
// smoke learner itself, never with a deploy role reaching DynamoDB directly.
//
// Two independent facts bound the deletion, and both come from the AUTHENTICATED principal rather
// than the request:
//
//   learnerId  — who owns the records. Already resolved by `identity.js` from the validated token.
//   runId      — which run created them.
//
// The run id is deliberately NOT a request input. If cleanup accepted a run id from the body, a
// smoke token would be enough to delete another run's records, and the "learner + run" scope would
// reduce to "learner". So the run id rides the principal the transport built from authorizer-
// validated claims, and the route's path parameter only CONFIRMS it — a mismatch is a refusal, not
// a re-scope.

/**
 * A smoke run id: short, opaque, and safe to appear in a route.
 *
 * Bounded on purpose. This value reaches a route path and a persistence key, so an unbounded string
 * would be both an injection surface and an unbounded partition key. The alphabet excludes
 * separators for the same reason.
 */
export const SMOKE_RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{7,63}$/;

export function isValidSmokeRunId(value) {
  return typeof value === 'string' && SMOKE_RUN_ID_PATTERN.test(value);
}

/**
 * Resolve the smoke-run identity for a request, or `null` when this is an ordinary learner.
 *
 * `mode` mirrors `resolveLearner`: in `cognito` mode the value must come from the validated
 * principal, because a deployed runtime has no trustworthy header. In `dev` mode — local only — a
 * header is accepted, since local identity is deterministic and header-based already.
 *
 * @param {Record<string, string|undefined>} headers lowercase-keyed
 * @param {{ provider?: string, smokeRunId?: string } | null} principal neutral principal
 * @param {{ mode: string }} options resolved auth mode
 * @returns {{ runId: string } | null}
 */
export function resolveSmokeRun(headers = {}, principal = null, { mode = 'dev' } = {}) {
  if (mode === 'cognito') {
    // Deployed: the claim, and only the claim. A header here would let anyone with a learner token
    // promote themselves into a smoke principal.
    const claimed = principal?.smokeRunId;
    if (claimed === undefined || claimed === null || claimed === '') return null;
    if (!isValidSmokeRunId(claimed)) return null;
    return { runId: claimed };
  }

  const header = headers['x-cba-smoke-run'];
  if (typeof header !== 'string' || header === '') return null;
  if (!isValidSmokeRunId(header)) return null;
  return { runId: header };
}
