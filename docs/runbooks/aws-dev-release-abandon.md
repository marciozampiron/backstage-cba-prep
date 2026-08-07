---
id: aws-dev-release-abandon
kind: runbook
version: 0.2.0
owner: Opus # maintains this document only — it authorizes nothing (SPEC-RUN-001)
humanApprover: Zamp
specs: [SPEC-RUN-008, SPEC-RUN-002, SPEC-RUN-005, SPEC-RUN-007, SPEC-RUN-009, SPEC-DEPLOY-020, SPEC-DEPLOY-017, SPEC-LANE-002, SPEC-LANE-006]
inputs: [the declined plan's binding record, a caller-generated correlation id, Zamp's abandon-mode cloud authorization]
outputs: [the change sets deleted, any REVIEW_IN_PROGRESS record resolved, a structured abandon artifact]
gateRequired: true
cloudMutation: true
---

# Runbook — dev release, ABANDON a plan that will not execute

> **Status: DESIGN — BLOCKED ON IMPLEMENTATION-PHASE PREREQUISITES.** This runbook cannot be
> executed until the abandon lane and the `abandon` authorization mode exist. Round 4 of this
> design's review rejected the earlier version, correctly, on four counts:
>
> 1. **It was unauthorized.** `DeleteChangeSet` and `DeleteStack` were not effects in the closed
>    authority matrix, and `CBA_CLOUD_GATE` had no abandon mode — the operation claimed an
>    authorization that could not be expressed.
> 2. **It ran outside the release lock.** Raw CLI calls bypass the `release-dev` concurrency
>    group, so an abandon could interleave with a plan or a deploy of the same tier.
> 3. **It skipped the mutation-boundary discipline.** No gate validation, no window re-check, no
>    account re-resolution before each deletion — the very controls SPEC-DEPLOY-008/017 exist for.
> 4. **Describe-then-delete is not atomic.** The documented APIs offer no compare-and-delete, so
>    a status observed in one call can change before the next acts on it.
>
> The fix is structural and belongs to the implementation phase:
>
> - **`abandon-change-sets` is now a closed effect** in `spec/authority-policy.json`, authorized
>   by the cloud instrument and performed by Zamp — that part landed with this design.
> - **An abandon LANE** — a reviewed dispatch path under the same `release-dev` concurrency group
>   (SPEC-LANE-002), running a reviewed entrypoint, never raw operator CLI calls.
> - **An `abandon` mode in the authorization schema** (SPEC-DEPLOY-020), so the instrument names
>   what it permits and an abandon value can never execute or prepare anything.
> - **Identifiers are re-derived inside the lane**, not carried through evidence: the change-set
>   NAME is deterministic for a release (`cba-70-<release-sha-12>`), and the lane resolves the
>   ids itself under the lock. This is why no raw ARN needs to travel through a rendering that
>   redacts them (SPEC-DEPLOY-006/014) — the earlier design's requirement for "protected raw
>   identifiers" dissolves rather than being satisfied by a second, less-protected channel.
> - **Mutation-boundary revalidation inside the entrypoint**: identity, account, window and the
>   change set's own status re-checked immediately before each deletion (SPEC-DEPLOY-017).
>
> **The residual race is stated, not solved.** CloudFormation offers no atomic
> compare-and-delete: between the status read and the delete, the state can change. The
> entrypoint therefore refuses rather than races — it deletes only what it re-observed in the
> expected state, treats an `AlreadyExists`/state error as a stop rather than a retry, and never
> deletes a stack whose status is anything but `REVIEW_IN_PROGRESS` at the moment it acts. A
> reviewed operation that stops on surprise is the honest shape here; an idempotent-looking loop
> would be a race with better manners.

One operation: delete the change sets of ONE declined plan, and resolve the empty stack record a
CREATE change set leaves behind.

## Why it exists

Design round 3 corrected a false claim: unexecuted change sets do **not** expire, and a later
plan run does **not** replace them by name — creating a change set with an existing name fails.
AWS retains a change set until the stack is updated or the set is explicitly deleted, so a
declined plan leaves **executable** change sets behind (SPEC-RUN-008).

## Preflight

1. The abandon lane and the `abandon` authorization mode exist in the reviewed tree. Without
   them this operation does not run.
2. Zamp decided this plan will NOT execute. An abandoned plan cannot be un-abandoned; a new
   binding and plan cycle is what follows.
3. The declined plan's binding record is at hand — run id, correlation id, `decisionId`, release
   SHA, stack group, `PLAN_DIGEST` (SPEC-RUN-007). The lane re-derives the change-set ids from
   the release; the record is what ties this abandon to that decision.
4. Zamp has issued an `abandon`-mode cloud authorization for THIS decision, bound to the same
   manifest digest and stack group, with a fresh `decisionId` and a ≤1h window.
5. **The lane's deleting capability is verified in review, not assumed here**: the release
   bootstrap's execution authority must permit `cloudformation:DeleteChangeSet` for these stacks
   and `cloudformation:DeleteStack` for a `REVIEW_IN_PROGRESS` record. A gap is a finding for the
   execution policy — never a reason to reach for another identity.
6. No plan or deploy run of this tier is in flight; the lane shares the `release-dev` lock, so a
   concurrent dispatch queues rather than interleaves.

## Commands

`PLANNED — not executable` in this phase. Templates:

1. **Zamp** sets the abandon-mode authorization:

   ```text
   gh api -X PATCH repos/<owner>/<repo>/environments/dev/variables/CBA_CLOUD_GATE \
     -f name=CBA_CLOUD_GATE \
     -f value='<the abandon JSON for this decision>'
   ```

2. **Zamp** dispatches the abandon lane with the correlation id:

   ```text
   gh workflow run "Release Pilot" --ref main \
     -f release_sha=<full 40-character release SHA> \
     -f mode=abandon \
     -f correlation_id=<caller-generated id for this decision>
   ```

   Expected outcome: under the `release-dev` lock, the reviewed entrypoint re-derives the
   release's change-set ids, revalidates identity, account and window before EACH deletion,
   deletes only what it re-observed in the expected state, and removes a stack record only while
   its status is `REVIEW_IN_PROGRESS`. Nothing is prepared and nothing is executed.

3. **Zamp** waits for a terminal conclusion and downloads the structured artifact:

   ```text
   gh run watch <run-id> --exit-status
   gh run download <run-id> --name abandon --dir <evidence-dir>/abandon-<run-id>
   sha256sum <evidence-dir>/abandon-<run-id>/abandon.json
   ```

   Expected outcome: an artifact listing, per stack, what was deleted, what was already absent,
   and what was left untouched — with correlation id and release SHA for verification.

## Evidence

- The structured abandon artifact and its digest, bound to run id, correlation id, `decisionId`
  and the declined plan's `PLAN_DIGEST` (SPEC-RUN-007/009).
- An `EVENTS.md` entry: release SHA, wave, the abandoned `decisionId`, what was deleted, and the
  explicit note that bootstrap assets are RETAINED — they are content-addressed, unreferenced
  once the change sets are gone, and removing them is a separate bootstrap-maintenance decision.

## Stop conditions

1. Identity, account or window fails revalidation at any mutation boundary — stop; the remaining
   deletions do not happen, and the artifact records what already did.
2. A stack's status is anything other than `REVIEW_IN_PROGRESS` when the record would be
   removed — stop; this operation never deletes a stack that holds resources.
3. A state or conflict error from the service — stop, do not retry: it means the world changed
   between observation and action, which is the residual race, and a surprised operation
   re-observes under a new decision rather than pushing through.
4. The artifact's correlation id or release SHA does not match the request — stop; evidence that
   cannot be tied to THIS decision does not close it.

## Rollback

There is no rollback: a deleted change set is gone. Recovering the intent means a NEW binding and
plan cycle under a new decision — which is the correct outcome, because the plan being abandoned
is the one Zamp declined.

## Cleanup

- **Zamp** clears the `CBA_CLOUD_GATE` value for the abandon decision.
- The abandon artifact is retained; the declined plan's own artifact is retained too, marked
  abandoned, so the record shows what was prepared and what removed it.
