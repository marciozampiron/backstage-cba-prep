---
id: aws-dev-release-recovery
kind: runbook
version: 0.1.0
owner: Opus # maintains this document only — it authorizes nothing (SPEC-RUN-001)
humanApprover: Zamp
specs: [SPEC-DEPLOY-003, SPEC-DEPLOY-004, SPEC-DEPLOY-008, SPEC-RUN-002]
inputs: [the halted run's summary and honest partial record, the prior known-good release SHA for dev, read access for state assessment]
outputs: [a recorded assessment, a chosen and recorded recovery path, EVENTS.md entries]
gateRequired: true
cloudMutation: true
---

# Runbook — dev release, RECOVERY after a halt

> **Status: DESIGN — `PLANNED — not executable`.** Nothing here runs in the current phase.
> Assessment steps are read-only; any corrective effect is a NEW release decision through the
> [plan](aws-dev-release-plan.md) and [deploy](aws-dev-release-deploy.md) runbooks under their
> own cloud authorizations — there is no side-channel undo, which is why `cloudMutation` is
> true for the flow this runbook re-enters, not for the assessment itself.

One operation: from a halted wave, produce a RECORDED assessment and a chosen recovery path.

## Preflight

1. The halted run's summary is captured, including the honest partial record — exactly which
   stacks executed (SPEC-DEPLOY-008) — and the refusal code or failure line that stopped it.
2. The prior known-good state for dev is identified: the previous successfully deployed release
   SHA of the tier — dev rollback targets prior validated dev releases, never pilot tags.
3. No new dispatch of any kind happens before the assessment is recorded.

## Commands

`PLANNED — not executable` in this phase. Templates (assessment — read-only):

1. Per stack of the halted wave, current status:

   ```text
   aws cloudformation describe-stacks \
     --stack-name <cba-study-coach-dev-…> \
     --query 'Stacks[0].StackStatus'
   ```

   Expected outcome: a terminal status per stack, matched against the run's partial record.

2. If a stack failed mid-execution, what CloudFormation itself did next is read from its events:

   ```text
   aws cloudformation describe-stack-events \
     --stack-name <cba-study-coach-dev-…> --max-items 20
   ```

   Expected outcome: whether the declared `OnStackFailure`/rollback configuration ran, and to
   what state.

3. The assessment — per stack: executed/not-executed, current status, divergence from both the
   halted release and the prior known-good — is written down BEFORE any path is chosen.

## Evidence

- The assessment document, the halted run's summary, and an `EVENTS.md` entry recording the
  halt, the assessment and the chosen path — appended through the normal reviewed flow.
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
- Any `CBA_CLOUD_GATE` value from the halted decision is cleared before the next cycle.
