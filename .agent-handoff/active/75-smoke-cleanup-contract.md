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

## Current design (this is the vigent one)

The run is a **record the BFF mints**, and the authorization is a **capability from a validated
group claim** — not a per-run token claim. See "Superseded design" below for what was tried first
and why it could not work.

```
POST   /api/smoke-runs             -> { runId }      requires the smoke capability; caller OWNS it
X-CBA-Smoke-Run: <runId>           -> stamps writes; PRESENT-but-unowned or malformed FAILS CLOSED
DELETE /api/smoke-runs/:id/data    -> capability + ownership, then deletes learner + run
```

| Bound | Source |
| --- | --- |
| may operate smoke runs at all | `cognito:groups` contains `cba-smoke` (deployed) / `x-cba-smoke` header (local dev) |
| learner | the authenticated principal, as every other route resolves it |
| run | a run record owned by that principal |

`cognito:groups` is on an access token, so this capability is genuinely issuable: membership is
pre-provisioned once per environment for the dedicated smoke learners, and nothing is granted per
run. No admin call happens on the smoke path.

No request input names a learner or a run. An **absent** run header is ordinary traffic; a
**present** one that is malformed, unknown or unowned is a refusal and the write never happens.
Records created outside a run are never in scope.

## Superseded design (historical — do not implement)

The first version read a per-run claim, `principal.smokeRunId`, from the validated principal. It
cannot be issued: a Cognito **access** token carries `sub`, `token_use`, `client_id`, `scope` and
groups — not custom attributes. A per-run value there needs an admin call per run or a
pre-token-generation trigger, both infrastructure this issue may not introduce. Nothing in the code
reads `smokeRunId` any more.

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

- (Historical — superseded in review round 1.) This risk described the claim-based design that was
  replaced. The current design needs no per-run claim; see "Current design" at the top.
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

## Codex review round 1 — findings and fix-forward

`a0dd41c` is preserved; the corrections are in a second commit. All three findings were reproduced
against the implementation first.

**HIGH — the route was absent from the deployed surface.** The dispatcher implemented it and
`ApiStack`'s explicit ROUTES list did not, so API Gateway would have answered 404 before Lambda ran.
Both routes are added and carry the JWT authorizer like every other route — this deletes data, and
an unauthenticated caller must not reach the dispatcher. `DELETE` is deliberately NOT added to the
browser CORS methods: #70 is a server-side caller, and widening the preflight surface for a caller
that does not exist would be a cost with no benefit. Asserted in synth.

**HIGH — the deployed principal could never carry the run, so the design was unimplementable.**
This one was worse than a missing mapping, and mapping the claim would not have fixed it. A Cognito
ACCESS token carries `sub`, `token_use`, `client_id`, `scope` and groups — not custom attributes.
Issuing a per-run value in one needs an admin call per run or a pre-token-generation trigger, and
both are infrastructure this issue may not introduce. Rather than leave #70 to invent that, the
boundary moved to the other option #75 explicitly offers: **learner-owned deletion through the BFF**.

The run is now a RECORD the BFF mints (`POST /smoke-runs`), owned by the caller. The
`X-CBA-Smoke-Run` header REFERENCES it and authorizes nothing — the same shape as a session id in a
path — and is honoured only when the run record belongs to the authenticated learner. An unknown run
and someone else's run return the identical `403`, so no caller learns which run ids exist, and ids
are random rather than sequential so ownership is not the only barrier. A write referencing a run
the caller does not own still succeeds but is simply not stamped into that run; honouring it would
either hide the record from its own cleanup or expose it to someone else's.

This removes the Cognito dependency entirely: no claim, no admin permission, no trigger, and no
header trusted as authorization in a deployed runtime.

**MEDIUM — a conditional-delete conflict returned false success.** Zero meant either "nothing
existed" or "a record survived contention", and a partial cleanup answering 200 would let a run be
promoted with records still in the table. Completeness is now VERIFIED rather than inferred: after a
bounded retry the scope is re-queried through a new `countSmokeRunRecords` port method, and anything
still matching raises `409 CLEANUP_INCOMPLETE` with per-class leftover counts and no ids. Two tests
cover it — a record that survives every attempt fails the operation, and a later uncontended retry
finishes the job idempotently.

### Validation after the fix

root **359/359** · services/bff **214 / 213 pass / 1 skip** · web **71/71** · infra/aws **102/102** ·
bank **60/0** · credential-free `cdk synth` OK for `dev` and `pilot` · `git diff --check` clean.

## Codex review round 2 — findings and fix-forward

`a0dd41c` and `5c7d60c` are preserved; corrections are in a third commit.

**HIGH — any authenticated learner could become a smoke operator.** Correct, and I had settled for
ownership as if it were authorization. It is not: ownership says *whose run this is*, not *who may
operate runs at all*. Both routes now require a capability read from the validated `cognito:groups`
claim — `cba-smoke`. That claim IS on an access token, unlike the custom attribute I rejected the
design over, so it is genuinely issuable: membership is pre-provisioned once per environment for the
dedicated smoke learners and nothing is granted per run. An ordinary learner gets `403` at mint and
at cleanup. In `dev` mode a header stands in, as local identity is header-based already; in a
deployed runtime the header can never promote anyone.

**HIGH — a present-but-unowned run reference failed open.** The write fell through unstamped, which
was worse than it looked: the record landed outside every run, so the caller's own cleanup answered
`200` with zeros while the row stayed in the table — a false green on the exact gate meant to catch
leftovers. An ABSENT header is still ordinary traffic; a PRESENT one that is malformed is `400` and
one naming an unknown or unowned run is `403`, and the write does not happen. Regressions assert
both the status and that nothing was persisted.

**MEDIUM — ownership was consumed before completion, and replay was not deterministic.** The run
record is no longer deleted; it becomes a tombstone once cleanup completes. Ownership therefore
outlives the data, a retry after a partial failure can still prove it and converge, and every replay
answers identically — `200` with zeros. The test no longer accepts `200 || 403`: it asserts `200`
with zeros three times in a row.

**MEDIUM — stale wording.** The vigent design is now at the top of this file and the superseded
claim-based one is marked historical. The code comment that said the run comes from the principal is
corrected, and no source file references `smokeRunId` any more.

### Validation after the fix

root **359/359** · services/bff **219 / 218 pass / 1 skip** · web **71/71** · infra/aws **102/102** ·
bank **60/0** · credential-free `cdk synth` OK for `dev` and `pilot` · `git diff --check` clean.

## Codex review round 3 — findings and fix-forward

All three reviewed commits are preserved; corrections are in a fourth.

**HIGH — a completed run stayed writable.** Replay was deterministic only if nothing was written
between calls: a write could rejoin a run already reported clean, and the next cleanup would find
records the previous one swore were gone. A run is now explicitly `active -> completed`. A completed
run refuses new stamped writes with `409 RUN_CLOSED` while cleanup itself stays authorized against
it, which is what keeps replay deterministic. Finalization also moved: the run is marked complete in
the USE CASE, after the scope is re-queried and proven empty — the adapter was marking it while a
projection was still pending and before anything had been verified.

**HIGH — the capability had no provisioned group.** `IdentityStack` now creates the `cba-smoke`
group, so a deployed smoke learner is not left with a `403` and #70 is not left inventing an
untracked step. Membership is deliberately NOT attached: adding the dedicated learners is a
human-gated operator action done once per environment, precisely so the deploy role never needs a
Cognito admin permission. A synth test asserts the group exists and that no user or attachment
resource does.

**MEDIUM — the capability was not required when referencing a run.** Only mint and cleanup checked
it, so a learner removed from the group could keep operating runs they already owned. It is now
checked whenever the run header is present, before the ownership lookup and before any write.

**MEDIUM — tombstones had unbounded retention.** Ownership outliving the data is what makes replay
deterministic, but ownership is learner data and cannot be kept forever. Completed runs now carry
`expiresAt` with a documented seven-day bound, the managed adapter writes the `ttl` attribute, and
`DataStack` configures DynamoDB TTL on it. TTL is a CLEANUP mechanism and never an authorization
one: `RUN_CLOSED` refuses a completed run immediately, so nothing waits on the row disappearing.

**LOW — three stale statements** in the contract, the module comment and this handoff are corrected.

### Validation after the fix

root **359/359** · services/bff **222 / 221 pass / 1 skip** · web **71/71** · infra/aws **104/104** ·
bank **60/0** · credential-free `cdk synth` OK for `dev` and `pilot` · `git diff --check` clean.

## Codex review round 4 — findings and fix-forward

All four reviewed commits are preserved; corrections are in a fifth.

**HIGH — an in-flight write could land after cleanup reported success.** The dispatcher's
`RUN_CLOSED` check runs before the handler, so on its own it is a time-of-check/time-of-use gap: a
write that passed the check could still commit after cleanup answered zero, leaving records the run
swore were gone — and the next cleanup would find them. The state test now happens AT the write. The
lifecycle is `active -> closing -> completed`, cleanup moves the run out of `active` BEFORE deleting
anything, and every smoke-scoped write is conditional on `active`: check-and-write in the
single-process adapter, and a transaction pairing a condition check on the run item with the record
put in the managed one. The fake DynamoDB client enforces the same rule, so the regression exercises
the real path. Reverting the conditional write makes that test fail.

**MEDIUM — retention was still unbounded, twice over.** Every replay recomputed the expiry and both
adapters overwrote it, so a replay on day six moved the tombstone from day seven to day thirteen and
repeated replays could retain it forever. First completion now wins for both `completedAt` and
`expiresAt`: retention runs from when the run FINISHED, not from the last time somebody asked about
it. Abandoned active runs were the second gap — a run never cleaned up kept ownership indefinitely —
so a run carries an expiry from creation and the managed adapter writes `ttl` for active runs too.
Expiry is enforced by the APPLICATION: an expired run reads as gone from `ownedSmokeRun`, so nothing
waits on eventually consistent TTL deletion.

**MEDIUM — membership was an untracked prerequisite.** The release runbook now carries the operator
procedure: assign, verify, remove, with the note that `cognito:groups` lands on the NEXT token so a
session obtained before assignment keeps failing until re-issued. Evidence recorded for GO/NO-GO is
logical only. The group is created by `IdentityStack` and membership is assigned by a human, so the
deploy role never holds a Cognito admin permission.

**LOW — the module contract still said cleanup deletes the run.** Corrected.

### Validation after the fix

root **359/359** · services/bff **225 / 224 pass / 1 skip** · web **71/71** · infra/aws **104/104** ·
bank **60/0** · credential-free `cdk synth` OK for `dev` and `pilot` · `git diff --check` clean.

## Codex review round 5 — PARTIAL fix; two findings remain open

This commit does NOT close all three findings. It is labelled partial on purpose: the remaining work
is a transaction rewrite in the managed adapter and a retention redesign, and rushing either would
produce the same pattern of half-fixes this review cycle has already shown too much of.

**HIGH 1 — CLOSED. The deployed path could not execute the transaction.** `TransactWriteCommand` is
now imported in the real client factory and wired through the lazy client in `runtime.js`, so the
call the adapter makes actually exists. The Lambda role gains `dynamodb:TransactWriteItems` on the
exact table ARN — nothing wider — and the exact-policy test is updated to match. The #82 alarm test
excludes it explicitly: `TransactWriteItems` is a request type, not a DynamoDB metric `Operation`,
and CloudWatch attributes the writes inside it to `PutItem`, which the alarm already covers.

**HIGH 2 — PARTIALLY closed.** The fence moved from the call sites to the PORT, which closes the
class rather than the instances: `saveSession`, `saveAttempt`, `saveMock` and `claimActiveMock` now
refuse any record carrying a run id whose run is not active. That covers the reported answer-write
and active-mock reproductions for the memory and file adapters, and no future write path has to
remember the rule. **The managed adapter is NOT yet fenced on the update paths** — its
`#saveRecord` still writes unconditionally, so the same delayed-update reproduction would still
succeed against DynamoDB. That is the first thing to do next: route `#saveRecord` through a
transaction with a condition check on the run whenever the record carries a run id, and add the
delayed update/claim regression for the Dynamo adapter.

**HIGH 3 — OPEN.** Abandonment expiry and completed-tombstone expiry are still the same field, so a
run completed on day six keeps one day rather than a fresh seven; child records have no independent
TTL, so an abandoned run can expire while its learner data remains; and Dynamo `closeSmokeRun`
rewrites the row without the top-level `ttl`, so a failed cleanup can leave a `closing` row with no
physical expiry. Nothing in this commit addresses any of that.

### Validation

root **359/359** · services/bff **225 / 224 pass / 1 skip** · web **71/71** · infra/aws **104/104** ·
bank **60/0** · `git diff --check` clean.

### Note on this cycle

Five review rounds, sixteen findings, and the last three rounds each uncovered a defect class the
previous fix had not considered — TOCTOU, then every-mutation coverage, then retention. That is a
signal about sequencing, not just about individual mistakes: the contract was being designed while
being implemented. Before #70, the contract for this operation should be written and reviewed on its
own, so this class of problem surfaces in a design review rather than a code review.

## Codex review round 6 — corrections landed

The two red tests are green and the transaction-cancellation handling is now positional.

**The two failures were both mine, and of different kinds.** One was a real classification defect:
`#saveRecord` mapped any `TransactionCanceledException` to `RepositoryConflictError`, which
`saveSmokeScopedRecord` then swallowed as `false` — so a transaction conflict or a capacity failure
was reported as a closed run. `CancellationReasons` is positional, so index 0 (the run's
ConditionCheck) means the run stopped accepting records and index 1 (the record's Put) means a lost
update; anything else now propagates untouched. The other was a fixture mistake: an edit of mine had
duplicated a `saveSmokeRun` line three times, and the second call failed its `attribute_not_exists`
condition. Worth separating, because only the first was a defect in the contract.

**Also closed in this pass:**

- `TRANSACT_WRITE_ITEMS` is in `DYNAMO_ALARMED_OPERATIONS`, the filter encoding my mistaken belief
  is gone, and the alarm's operation set, the synthesized dimensions and the IAM grant are asserted
  aligned. `TransactWriteItems` IS a DynamoDB metric `Operation`; claiming otherwise had left the
  release-blocking alarm blind to failures on the newest write path.
- `claimActiveMock` takes `runId` EXPLICITLY. The first version looked the run up from the mock
  record, but `startMockExam` claims before saving that mock, so the lookup was always `undefined`
  and the fence checked nothing. Fenced in memory, file and DynamoDB — the managed one as a
  ConditionCheck plus the claim Put in a single transaction — and `startMockExam` maps the refusal
  to `RUN_CLOSED` rather than `MOCK_EXAM_IN_PROGRESS`, which would have sent the caller looking for
  a mock that does not exist.
- `#saveRecord` in the managed adapter now transacts against the active run whenever the record
  carries a run id, so UPDATES are fenced and not only creation.

## Retention design — REVISION 6 (recorded before implementation)

Revisions 1–5 are superseded. R6 changes one thing: the retention lease I introduced in R5 to bound
the profile arrived with no bound of its own. Bounding one record by adding an unbounded one is the
same defect wearing a different label, and it is worth naming rather than quietly fixing.

### Carried forward (approved, unchanged)

Three clocks — `writeDeadlineAt` (24h), `ownershipExpiresAt` (8d), `expiresAt` (7d from first
completion). `ttl` mirrors ownership. Cleanup stays authorized after the write deadline and reads
RAW, so verification cannot measure its own blindfold. Children are classified by `runId`; a stamped
child with a missing, malformed or non-finite anchor fails closed on application reads and stays
visible to cleanup. `retainUntil` is repository-owned and write-once. The active-mock claim is
reclaimed logically with its deadline pinned by the transaction. Renewal is monotonic; the horizon is
derived from the stored run; ordinary profile updates never extend it.

### The lease is a record like any other, and is bounded like one

| Field | Meaning |
| --- | --- |
| `learnerId` | the key; one lease per learner |
| `retainUntil` | monotonic — `max(current, run.ownershipExpiresAt)` |
| `rev` | optimistic revision, so every write is conditional |
| `ttl` | epoch seconds derived from `retainUntil` |

An **expired lease is ignored logically**, before TTL removes it — the same rule as every other
record here, and for the same reason: TTL lags by days and must never answer "is this still valid".

### Consumption is application, not deletion

R5 said `loadOrBootstrap` "consumes" the lease without saying what that meant, and the natural
reading — read it, stamp the profile, delete it — produces the exact race reported: bootstrap reads
H1, a concurrent mint advances the lease to H2, bootstrap stamps H1 and deletes the lease, and the
profile now expires before the H2 run's own horizon.

**The lease is never deleted by bootstrap.** It stays authoritative until its own TTL. Bootstrap
reads it and stamps the new profile from that snapshot, but the snapshot is a convenience, not the
source of truth:

```
effectiveHorizon(learner) = max(profile.retainUntil ?? 0, unexpired lease.retainUntil ?? 0)
```

`getProfile` hides a smoke profile only past the EFFECTIVE horizon. This makes the required
invariant hold **by construction** rather than by protocol:

> while an unexpired smoke lease exists, any visible profile has an effective retention horizon
> >= the lease horizon.

A stale bootstrap can no longer shorten anything, because it cannot remove the longer horizon — it
can only fail to copy it, and the lease still supplies it. The partial-write window closes the same
way: if the lease is durable and stamping an existing profile fails, the mint does not report
success AND the effective horizon already includes the lease, so no visible profile is
under-retained in the meantime.

Every lease write is conditional on its revision, so an older concurrent mint loses rather than
overwriting a newer horizon — and because the value is a maximum, losing that race is harmless.

**Failure path A** — a run minted, `/api/me` never called — is now bounded by the lease's own
`retainUntil` and `ttl`: it expires logically at the horizon and is removed physically afterwards,
consumed or not.

### Binding is refused unless the run backs it

`bindProfileToSmokeRun({ learnerId, runId })` reads the STORED run and refuses when it is absent,
expired past `ownershipExpiresAt`, or owned by a different learner. The horizon is taken from that
run, never from the caller. A mismatch is a refusal, not a re-scope — the same rule the cleanup
route already follows.

### Order of operations at mint

1. write the run record (bounded by its own `ownershipExpiresAt`/`ttl`);
2. write or extend the lease, conditional on its revision, monotonic;
3. stamp an existing profile if there is one, revision-conditional;
4. only then report success.

A failure at any step leaves the earlier ones bounded: an orphan run carries its own TTL and its id
is never returned, and a lease without a profile expires on its own. The failure direction is always
a run that cannot be used, never data that cannot expire.

### Expiry stays an application decision, on every path

`ownedSmokeRun`, `getActiveMock`, `getProfile`, the lease read, the write fence and every child read
path evaluate time themselves.

### Full test plan, injected clock throughout

1. run at 25h → writes refused, cleanup still authorized;
2. run at 8d + 1h → cleanup refused, no reachable child remains;
3. completion on day six → `expiresAt` is `completedAt + 7d`;
4. replay on day ten → `expiresAt` unchanged;
5. cleanup failing during `closing` → the row keeps its `ttl`; a retry converges;
6. claim at hour one → logically absent at hour 25 with the row present; a new claim succeeds;
7. claim transaction with a deadline not matching the run's → refused;
8. child `retainUntil` survives ten updates; supplied, removed, mutated and malformed values are
   rejected or preserved, never adopted;
9. expired child hidden from get/list, still found and deleted by cleanup; verification cannot
   report zero while the row exists;
10. child with `runId` and missing/malformed anchor → hidden on every named accessor in every
    adapter, still discovered by cleanup;
11. lease lifecycle:
    a. lease exists and `/api/me` is never called → it expires logically, then physically;
    b. bootstrap reads H1 while a concurrent mint advances to H2 → H2 survives and the profile stays
       visible to H2;
    c. a stale bootstrap cannot delete or shorten a newer lease;
    d. lease durable but the existing-profile stamp fails → no successful mint, and no visible
       profile has an effective horizon shorter than the lease;
    e. an expired physical lease is ignored before TTL removes it;
    f. an absent, expired or mismatched run is refused at binding;
12. profile: bounded before the first profile exists, reverse-order mints, race with a fresh write,
    ordinary learner never leased or stamped;
13. a write and a claim crossing the write deadline mid-request are refused in all three adapters.

Implementation begins only after this revision receives REVIEW_APPROVED.
