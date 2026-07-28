# Task: smoke-test data cleanup contract (#75)

## Status

IMPLEMENTED locally; awaiting independent review and the human publication gate. #70 is blocked on
this contract and has not been started.

## Owner

- Executor: Claude Opus 5. Architect/reviewer: Codex. Human gate required before any push.
- No deploy, no AWS live call, no Cloudflare, no secret operation, no paid call was performed.

## The shape of the problem

The deployed smokes create practice sessions, mock exams, attempts and answers. #70's `always()`
cleanup job has to remove exactly what THAT run created — through the BFF, as the smoke learner
itself, never with a deploy role reaching DynamoDB. The failure modes point in opposite directions:
deleting slightly too much is data loss in a shared environment, and deleting too little leaves a
claim or a record that blocks the next run.

## Scope: two bounds, neither supplied by the caller

| Bound | Source |
| --- | --- |
| learner | the authenticated principal, exactly as every other route resolves it |
| run | the validated principal's smoke-run claim (deployed) or `x-cba-smoke-run` (local dev only) |

The run id is **not** a request input. If cleanup accepted one, a smoke token would be enough to
delete another run's records and "learner + run" would collapse to "learner". The `:runId` in the
path exists to **confirm** the authenticated run: a value that disagrees is `403`, never a re-scope.
Records are stamped with the run id at creation from the same principal, so a record with no run id
— every ordinary learner's data — is never in scope.

In a deployed runtime the claim is the only source. A header there would let anyone holding an
ordinary learner token promote themselves into a smoke principal. Local dev keeps the header,
because local identity is header-based already.

## What was built

- `services/bff/src/smoke-run.js` — run-identity resolution and a bounded id format. The value
  reaches a route path and a persistence key, so an unbounded string would be both an injection
  surface and an unbounded partition key.
- `services/bff/src/store.js` — `cleanupSmokeRun`, provider-neutral: it validates the scope and
  delegates to the repository port. `startDrill`/`startMockExam` stamp the run id.
- `services/bff/src/repository.js` — `deleteSmokeRunData({learnerId, runId})` on the port, with
  per-class counts.
- `services/bff/src/dynamodb-repository.js` — the adapter. It reads only the learner's own GSI
  partition (no scan, no cross-learner read, no wildcard), filters by run id in the adapter as well
  as the port, and deletes **conditionally on the revision it read**, so a record written since the
  read is skipped rather than removed blind.
- `services/bff/src/app.js` — `DELETE /smoke-runs/:runId/data`.
- `docs/product/web-bff-contracts.md` §18 — the canonical contract.

No IAM change was needed: the runtime role already holds `dynamodb:DeleteItem` on the table, and
nothing here widens it.

## Two projections that are keyed by learner alone

Neither carries a run id, and both were decided explicitly rather than by default:

- the **active-mock claim** is released once the mock it points at is gone. Left behind it blocks
  every future mock for that learner — a smoke that cleans up and can then never run again is not a
  cleanup.
- the **profile cache** is removed only once the learner has no records left at all. Removing it
  while another run's data survives would damage a run this call was never scoped to touch.

## Observability of failure

The operation answers with a status, and a failed cleanup is a failed job: per
`deployed-environment-smoke-workflow-design.md` §6 the run outcome becomes FAILURE even when every
gate passed, and promotion is blocked. The response echoes the run id — #70 needs it to correlate —
and deliberately **not** the learner id, because the response is written into a workflow summary.

## Tests

`services/bff/test/smoke-cleanup.test.js` (13) — end to end through the BFF: positive coverage,
another learner with a valid token for the same run, the same learner with a different run, a path
run id that disagrees, an ordinary learner, a body naming a different learner and run, replay, and
a run that never existed.

`services/bff/test/repository-behavior.test.js` — seven cases added to the shared adapter suite, so
**memory, file and DynamoDB each prove the same behaviour**: counts, idempotency, no crossing of
learner or run, records with no run id, the active-mock claim, the profile rule, and — for adapters
that persist — that a cleaned-up run stays cleaned up across re-instantiation.

`services/bff/test/dynamodb-repository.test.js` — a concurrent write between read and delete is
skipped and later removed, and the fake client still has no `scan` method.

## Errors found by my own tests, worth naming

- The first seed never actually answered a question (it read a field the practice-session response
  does not carry), so the answer count was zero and the positive test was weaker than it looked.
- The first "unauthenticated fails closed" test asserted a refusal that dev mode does not produce:
  local identity is header-based by contract, so an anonymous caller resolves the default learner.
  The test now asserts what actually matters there — that the anonymous caller is scoped to its own
  learner and cannot touch anyone else's records — and the deployed boundary is asserted separately.

## Residual risks

- The smoke-run claim has to be issued by whatever provisions the smoke learners. This slice
  consumes `principal.smokeRunId`; nothing here mints it, and #70 must not fall back to a header in
  a deployed runtime.
- Cleanup covers the record classes that exist today. A future record type must be added to
  `deleteSmokeRunData` or it will be silently left behind — the port method is the single place to
  change, but nothing forces a new class to register itself.
- The conditional delete skips a contended record rather than retrying. That is deliberate, and the
  operation is idempotent, so #70's retry removes it — but a record contended on every attempt
  would survive, and the count is what makes that visible.
- Counts are per class, not per record: a partially deleted run reports what it removed, and the
  caller has to treat a non-zero count on a replay as a signal rather than noise.

## Validation

root **359/359** · services/bff **212 / 211 pass / 1 skip** · web **71/71** · infra/aws **101/101** ·
bank **60 valid / 0 errors** · credential-free `cdk synth` OK for `dev` and `pilot` ·
`git diff --check` clean.

No deploy, AWS live call, Cloudflare operation, secret operation, paid call or push.
