---
id: aws-dev-release-abandon
kind: runbook
version: 0.9.0
owner: Opus # maintains this document only — it authorizes nothing (SPEC-RUN-001)
humanApprover: Zamp
specs: [SPEC-RUN-008, SPEC-RUN-002, SPEC-RUN-005, SPEC-RUN-007, SPEC-RUN-009, SPEC-DEPLOY-019, SPEC-DEPLOY-021, SPEC-DEPLOY-017, SPEC-LANE-002, SPEC-LANE-006, SPEC-LANE-007]
inputs: [the declined plan's binding record, a caller-generated correlation id, Zamp's abandon-mode cloud authorization]
outputs: [the change sets deleted, any leftover REVIEW_IN_PROGRESS stack record REPORTED, a structured abandon artifact]
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
> **Round 5 removed the stack deletion entirely.** The previous version answered point 4 by
> promising the lane would "delete only what it re-observed in the expected state" — which is
> the race, restated as care. `DeleteStack` accepts no expected-status precondition: nothing
> carries the observation into the call. And the `release-dev` concurrency group serializes only
> THIS repository's lanes; it constrains no other CloudFormation actor, so the guarantee it
> provides is not the guarantee this operation needed. A lane that deletes a stack record on the
> strength of an earlier read can delete a stack that acquired resources in between.
>
> This operation therefore deletes **change sets only**. A leftover `REVIEW_IN_PROGRESS` stack
> record is REPORTED, never deleted here — resolving it is a separate human decision under its
> own effect, `delete-review-in-progress-stack-record`, which
> [`spec/authority-policy.json`](../../spec/authority-policy.json) marks human-performed and no
> automated lane may perform (SPEC-DEPLOY-021). **Round 6 gave that effect its own instrument**:
> it named `cloud-authorization`, which did not authorize it and gave it no mode, so it read as
> authorized and no value could authorize it. It is now `stack-record-authorization` — an
> out-of-band human record, deliberately not an Environment variable, so no lane can consume a
> value permitting it (spec §8b).
>
> The remaining implementation-phase prerequisites:
>
> - **`abandon-change-sets` is a closed effect** in `spec/authority-policy.json`, authorized by
>   the cloud instrument under the `abandon` mode and performed by Zamp — that part landed with
>   this design.
> - **An abandon LANE** — a reviewed dispatch path under the same `release-dev` concurrency group
>   (SPEC-LANE-002), running a reviewed entrypoint, never raw operator CLI calls.
> - **The `abandon` mode in the authorization schema** (SPEC-DEPLOY-019), so the instrument names
>   what it permits and an abandon value can never execute or prepare anything.
> - **Identifiers are re-derived inside the lane**, not carried through evidence: the change-set
>   NAME is deterministic for a release (`cba-70-<release-sha-12>`), and the lane resolves the
>   ids itself under the lock. This is why no raw ARN needs to travel through a rendering that
>   redacts them (SPEC-DEPLOY-006/014).
> - **Mutation-boundary revalidation inside the entrypoint**: identity, account and window
>   re-checked immediately before each deletion (SPEC-DEPLOY-017).
>
> **The residual race on change sets is stated, not solved.** `DeleteChangeSet` has no
> compare-and-delete either. It is acceptable here and was not acceptable for the stack because
> the blast radii differ by kind: deleting a change set removes a proposal that Zamp has already
> declined, and the worst case is deleting a set some other actor prepared under the same name —
> visible, recoverable by re-planning, and destroying no resources. Deleting a stack record whose
> status moved out from under the read can destroy resources. The entrypoint refuses rather than
> races: a state or conflict error is a stop, never a retry.

One operation: delete the change sets of ONE declined plan.

## Why it exists

Design round 3 corrected a false claim: unexecuted change sets do **not** expire, and a later
plan run does **not** replace them by name — creating a change set with an existing name fails.
AWS retains a change set until the stack is updated or the set is explicitly deleted, so a
declined plan leaves **executable** change sets behind (SPEC-RUN-008).

A CREATE change set also creates an empty stack record in `REVIEW_IN_PROGRESS`. That record
holds no resources and blocks the stack NAME, so it must eventually be resolved — but not here,
and not by a lane (SPEC-DEPLOY-021).

## Preflight

1. The abandon lane and the `abandon` authorization mode exist in the reviewed tree. Without
   them this operation does not run.
2. Zamp decided this plan will NOT execute. An abandoned plan cannot be un-abandoned; a new
   binding and plan cycle is what follows.
3. A correlation id is generated for THIS decision with a CSPRNG
   (`cba-70-$(openssl rand -hex 16)`, matching `^cba-70-[0-9a-f]{32}$`) and recorded before
   dispatch (SPEC-LANE-006). The declined plan's binding record is at hand — run
   id, correlation id, `decisionId`, release SHA, stack group, `PLAN_DIGEST` (SPEC-RUN-007). The
   lane re-derives the change-set names from the release; the record is what ties this abandon to
   that decision.
4. Zamp has issued an `abandon`-mode cloud authorization for THIS decision, bound to the same
   manifest digest and stack group, with a fresh `decisionId` and a ≤1h window. That mode
   authorizes `abandon-change-sets` and nothing else — it can neither prepare nor execute
   (`spec/authority-policy.json`), and it does not authorize deleting a stack record.
5. **The lane's deleting capability is verified in review, not assumed here**: the release
   bootstrap's execution authority must permit `cloudformation:DeleteChangeSet` for these stacks.
   It is NOT required to permit `cloudformation:DeleteStack`, and a policy that grants it to the
   lane is a finding — no lane performs that effect. A gap is a finding for the execution policy,
   never a reason to reach for another identity.
6. No plan or deploy run of this tier is in flight; the lane shares the `release-dev` lock, so a
   concurrent dispatch from this repository queues rather than interleaves. This says nothing
   about actors outside this repository, which is why nothing here depends on it for safety.

## Commands

`PLANNED — not executable` in this phase. Templates:

1. **Zamp** sets the abandon-mode authorization:

   ```text
   gh api -X PATCH repos/marciozampiron/backstage-cba-prep/environments/dev/variables/CBA_CLOUD_GATE \
     -f name=CBA_CLOUD_GATE \
     -f value='<the abandon JSON for this decision>'
   ```

2. **Zamp** dispatches the abandon lane with the correlation id:

   ```text
   gh workflow run release-pilot.yml --repo marciozampiron/backstage-cba-prep --ref main \
     -f release_sha=<full 40-character release SHA> \
     -f mode=abandon \
     -f correlation_id=<caller-generated id for this decision>
   ```

   Expected outcome: under the `release-dev` lock, the reviewed entrypoint re-derives the
   release's change-set names, revalidates identity, account and window before EACH deletion, and
   deletes those change sets. Nothing is prepared, nothing is executed, and no stack is deleted.
   Any stack left in `REVIEW_IN_PROGRESS` is recorded in the artifact as a reported condition.

3. **Zamp** resolves the run with [the canonical helper](README.md#resolving-a-run) — which
   re-observes the same single id past the terminal conclusion before printing it
   (SPEC-LANE-007) — and downloads the artifact:

   ```bash
   RUN_ID=$(node bin/resolve-run.mjs --title "cba-release abandon ${CORRELATION_ID}")
   gh run download "$RUN_ID" --repo marciozampiron/backstage-cba-prep --name abandon --dir <evidence-dir>/abandon-"$RUN_ID"
   sha256sum <evidence-dir>/abandon-"$RUN_ID"/abandon.json
   ```

   Expected outcome: an artifact listing, per stack, which change sets were deleted, which were
   already absent, and which stacks remain in `REVIEW_IN_PROGRESS` — with correlation id and
   release SHA for verification.

4. **Zamp** records any reported `REVIEW_IN_PROGRESS` stack for a separate decision. **There is
   no step here that resolves it, and this runbook offers no command that would.** The effect is
   `delete-review-in-progress-stack-record`, authorized only by a `stack-record-authorization`
   record (spec §8b) whose nine keys name the account, region, stack name, immutable stack ARN,
   the exact observed status and the instant, valid for fifteen minutes and re-verified
   immediately before acting. Even so, `DeleteStack` has no compare-and-delete, and that residual
   is unaccepted: `spec/authority-policy.json` records `riskAcceptance: null` and
   `executableProcedure: false` — and round 8 made acceptance a closed RECORD (finding,
   justification, compensating controls, Zamp as owner, review date, expiry), never a boolean a
   later edit could flip. Making it executable is Zamp's risk-acceptance decision, taken on its
   own record — never a step added here (SPEC-DEPLOY-022).

## Evidence

- The structured abandon artifact and its digest, bound to run id, correlation id, `decisionId`
  and the declined plan's `PLAN_DIGEST` (SPEC-RUN-007/009). Change sets appear by NAME; ids are
  ARNs and are never recorded.
- The reported list of stacks left in `REVIEW_IN_PROGRESS`, carried into whatever record the
  separate human decision produces — an unresolved record that nobody wrote down is how a stack
  name silently stays blocked.
- An `EVENTS.md` entry: release SHA, wave, the abandoned `decisionId`, which change sets were
  deleted, which stack records remain, and the explicit note that bootstrap assets are RETAINED —
  they are content-addressed, unreferenced once the change sets are gone, and removing them is a
  separate bootstrap-maintenance decision.

## Stop conditions

1. Identity, account or window fails revalidation at any mutation boundary — stop; the remaining
   deletions do not happen, and the artifact records what already did.
2. A state or conflict error from the service — stop, do not retry: it means the world changed
   between observation and action, which is the residual race, and a surprised operation
   re-observes under a new decision rather than pushing through.
3. The lane reports that it would delete a stack record — stop and treat it as a defect: no lane
   may perform that effect (SPEC-DEPLOY-021), so reaching that point means the reviewed
   entrypoint no longer matches this contract.
4. The artifact's correlation id or release SHA does not match the request — stop; evidence that
   cannot be tied to THIS decision does not close it.
5. Run resolution returns zero matches after the tenth attempt, or more than one at any point —
   stop (SPEC-LANE-007). A second run bearing this correlation id is never disambiguated by
   choosing the newer one.

## Rollback

There is no rollback: a deleted change set is gone. Recovering the intent means a NEW binding and
plan cycle under a new decision — which is the correct outcome, because the plan being abandoned
is the one Zamp declined.

## Cleanup

- **Zamp** clears the `CBA_CLOUD_GATE` value for the abandon decision.
- The abandon artifact is retained; the declined plan's own artifact is retained too, marked
  abandoned, so the record shows what was prepared and what removed it.
- Any reported `REVIEW_IN_PROGRESS` record stays open until its own decision closes it. It is not
  cleanup of this operation, and this operation does not end by pretending it is.
