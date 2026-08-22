---
id: aws-dev-release-recovery
kind: runbook
version: 0.2.0
owner: Opus # maintains this document only — it authorizes nothing (SPEC-RUN-001)
humanApprover: Zamp
specs: [SPEC-DEPLOY-018, SPEC-RUN-004, SPEC-RUN-005, SPEC-RUN-007]
inputs: [the halted run's evidence artifact and honest partial record, the prior known-good release SHA for dev, a reviewed read-only AWS profile]
outputs: [a recorded assessment and a recorded choice of recovery path]
gateRequired: false
cloudMutation: false
---

# Runbook — dev release, RECOVERY after a halt

> **Status: DESIGN — `PLANNED — not executable`.** Nothing here runs in the current phase.

One operation, and it is READ-ONLY: from a halted wave, produce a recorded assessment and a
recorded choice of recovery path. Design round 3 corrected the metadata — this document mutates
nothing and needs no authorization; the corrective effect it points at is a NEW release decision
owned by [plan](aws-dev-release-plan.md) and [deploy](aws-dev-release-deploy.md), each with its
own cloud authorization. A document does not inherit `cloudMutation` from the runbooks it links.

## Preflight

1. The halted run's COMPLETE evidence artifact is at hand, including the honest partial record —
   exactly which change sets executed (SPEC-DEPLOY-018) — and the refusal code that stopped it.
2. The prior known-good state for dev is identified: the previous successfully deployed release
   SHA of the tier — dev rollback targets prior validated dev releases, never pilot tags.
3. A reviewed READ-ONLY AWS profile is available. This operation never uses the deploy identity.
4. No new dispatch of any kind happens before the assessment is recorded.

## Commands

`PLANNED — not executable` in this phase. Templates (assessment — read-only):

0. **Opus or Zamp** verifies the acting identity, account and region before reading anything —
   an unpinned CLI inherits whatever profile the shell happens to carry:

   ```text
   aws sts get-caller-identity \
     --profile <reviewed-read-only-profile> --region us-east-1 --no-cli-pager
   ```

   Expected outcome: the expected account id and a READ-ONLY role. A mismatch stops here.

1. **Opus or Zamp** reads each stack's current status:

   ```text
   aws cloudformation describe-stacks --stack-name <cba-study-coach-dev-…> \
     --profile <reviewed-read-only-profile> --region us-east-1 --no-cli-pager \
     --query 'Stacks[0].StackStatus'
   ```

   Expected outcome: a terminal status per stack, matched against the artifact's partial record.

2. **Opus or Zamp** reads what CloudFormation did after a mid-execution failure:

   ```text
   aws cloudformation describe-stack-events --stack-name <cba-study-coach-dev-…> \
     --profile <reviewed-read-only-profile> --region us-east-1 --no-cli-pager \
     --max-items 20
   ```

   Expected outcome: whether the declared `OnStackFailure`/rollback configuration ran, and to
   what state.

3. **Opus** writes the assessment — per stack: executed/not-executed, current status, divergence
   from both the halted release and the prior known-good — BEFORE any path is chosen. Writing an
   assessment is not an effect; choosing and performing a path is, and that belongs to Zamp.

## Evidence

- The assessment document, bound to the halted run's id, `decisionId` and evidence-artifact
  digest (SPEC-RUN-007), and an `EVENTS.md` entry recording the halt, the assessment and the
  chosen path — appended through the normal reviewed flow.
- No secrets, account ids or live ARNs; stack names and statuses only.

## Stop conditions

1. The live statuses contradict the run's partial record — treat as an incident; nothing further
   until the contradiction is explained.
2. Any assessment command would require mutation to answer — stop; the assessment is read-only
   by definition, and a question it cannot answer read-only goes to Zamp as-is.

## Rollback

The recovery PATHS, each a new decision by Zamp, each through plan → digest study → deploy:

- **Roll forward**: fix on `main` through the normal review flow, then release the fixed SHA.
- **Roll back**: release the prior known-good SHA. CloudFormation computes the change sets that
  return the tier to that template state; the plan rendering shows exactly what returning costs
  (including any `[policy: Delete]` lines), and Zamp reads it like any other plan.
- **Complete the wave**: when the halt was environmental and the assessment shows the executed
  stacks healthy, a fresh plan/deploy cycle for the SAME release finishes the remaining stacks —
  `PLAN_CHANGED` protection still applies; nothing stale executes.

## Cleanup

- The assessment and decisions are retained as record; temporary query outputs are not.
- **Zamp** clears any `CBA_CLOUD_GATE` value left from the halted decision before the next
  cycle; this runbook itself sets nothing.
- If the halted wave left prepared-but-unexecuted change sets that will never run, they are
  removed by the [abandon runbook](aws-dev-release-abandon.md) under its own authorization —
  they do not expire on their own (SPEC-RUN-008).
- A CREATE that failed and rolled back leaves the stack in `ROLLBACK_COMPLETE`: every resource
  of the failed creation was removed by the rollback, the change set was consumed by the
  execution, and CloudFormation permits ONLY deletion of the record before the stack can be
  created again. That deletion is the effect `delete-empty-rollback-complete-stack-record` in
  `spec/authority-policy.json` — human-performed, out of band, and with NO executable procedure
  and no command in any runbook until Zamp records the residual-risk decision in that contract.
  The preconditions any eventual procedure must prove, per the reviewed direction: binding to
  the immutable StackId; observed `ROLLBACK_COMPLETE`; zero remaining resources; zero change
  sets; termination protection off; immediate re-observation before acting; one single standard
  `DeleteStack` (never force, retain or a role override); read-only reconciliation afterwards.
  A deletion once started cannot be interrupted.
