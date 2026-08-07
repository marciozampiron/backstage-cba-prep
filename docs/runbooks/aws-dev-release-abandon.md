---
id: aws-dev-release-abandon
kind: runbook
version: 0.1.0
owner: Opus # maintains this document only — it authorizes nothing (SPEC-RUN-001)
humanApprover: Zamp
specs: [SPEC-RUN-008, SPEC-RUN-002, SPEC-RUN-005, SPEC-RUN-007]
inputs: [the rejected plan's evidence artifact with its change-set ids, a Zamp cloud authorization for the abandon operation]
outputs: [the change sets deleted, any REVIEW_IN_PROGRESS stack record resolved, an EVENTS.md record]
gateRequired: true
cloudMutation: true
---

# Runbook — dev release, ABANDON a plan that will not execute

> **Status: DESIGN — `PLANNED — not executable`.** Nothing here runs in the current phase.

Design round 3 corrected a false claim in the plan runbook: unexecuted change sets do **not**
expire, and a later plan run does **not** replace them by name — creating a change set with an
existing name fails. AWS retains a change set until the stack is updated or the set is explicitly
deleted, so a rejected plan leaves **executable** change sets behind. This operation removes
them, and it is a cloud mutation with its own authorization (SPEC-RUN-008).

## Preflight

1. Zamp decided this plan will NOT execute. If the decision is still open, this operation does
   not run — an abandoned plan cannot be un-abandoned; a new plan run is required.
2. The plan's evidence artifact is at hand and names the exact change-set ids (SPEC-RUN-007).
   Deleting by name-and-stack instead of by id is not equivalent: the id is what the reviewed
   digest bound.
3. Zamp has issued a cloud authorization for THIS abandon decision.
4. **The deleting identity's capability is verified before use** — the release bootstrap's deploy
   role must hold `cloudformation:DeleteChangeSet` for these stacks, and `cloudformation:DeleteStack`
   where a `REVIEW_IN_PROGRESS` record must also be removed. This is a preflight check, not an
   assumption: it is confirmed against the bootstrap policy in the same review that activates
   this runbook, and any gap is a finding for the execution policy rather than an improvisation
   here.

## Commands

`PLANNED — not executable` in this phase. Templates — every AWS call pins region, profile and
pager, and identity is verified first:

1. **Zamp** verifies the acting identity, region and account:

   ```text
   aws sts get-caller-identity --profile <reviewed-deploy-profile> --region us-east-1 --no-cli-pager
   ```

   Expected outcome: the expected account and the expected assumed role. A mismatch stops here.

2. **Zamp** deletes each change set BY ID, one per prepared stack:

   ```text
   aws cloudformation delete-change-set \
     --change-set-name <exact change-set ARN from the evidence artifact> \
     --profile <reviewed-deploy-profile> --region us-east-1 --no-cli-pager
   ```

   Expected outcome: success, and a subsequent `describe-change-set` on the same id returns
   `ChangeSetNotFound`.

3. **Zamp** resolves any stack left in `REVIEW_IN_PROGRESS`. A change set of type CREATE creates
   a stack RECORD with no resources; deleting the change set leaves that record behind, and it
   blocks the next CREATE for the same stack name:

   ```text
   aws cloudformation describe-stacks --stack-name <cba-study-coach-dev-…> \
     --profile <reviewed-deploy-profile> --region us-east-1 --no-cli-pager \
     --query 'Stacks[0].StackStatus'
   aws cloudformation delete-stack --stack-name <cba-study-coach-dev-…> \
     --profile <reviewed-deploy-profile> --region us-east-1 --no-cli-pager
   ```

   Expected outcome: the record is removed ONLY when the status is `REVIEW_IN_PROGRESS`. Any
   other status stops the operation — deleting a stack that holds resources is not this
   operation and is not authorized by this decision.

4. **Zamp** records what is deliberately RETAINED: the assets the prepare step published to the
   release bootstrap's asset bucket stay. They are content-addressed, unreferenced once the
   change sets are gone, and removing them is a separate bootstrap-maintenance decision — not
   part of abandoning a plan.

## Evidence

- Per change set: the id deleted and the confirming `ChangeSetNotFound`.
- Per stack: the status observed and whether a `REVIEW_IN_PROGRESS` record was removed.
- An `EVENTS.md` entry: release SHA, wave, the abandoned `decisionId`, the ids deleted, and the
  explicit note that bootstrap assets were retained.

## Stop conditions

1. The identity, account or region does not match the expectation — stop before any deletion.
2. A stack's status is anything other than `REVIEW_IN_PROGRESS` when step 3 would delete it —
   stop; this operation never deletes a stack that holds resources.
3. A change set id in the evidence does not exist — stop and reconcile: either it was already
   deleted (record it) or the evidence is bound to the wrong run.
4. The capability check in Preflight 4 fails — stop; the missing permission is a finding for the
   release execution policy, not something to work around with another identity.

## Rollback

There is no rollback: a deleted change set is gone. Recovering the intent means preparing a NEW
plan through the plan runbook, under a new decision — which is the correct outcome, because the
plan being abandoned was the one Zamp declined.

## Cleanup

- Zamp clears the cloud authorization for the abandon decision.
- The evidence is retained; the plan's own evidence artifact is retained too, marked abandoned.
