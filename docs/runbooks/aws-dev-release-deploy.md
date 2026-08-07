---
id: aws-dev-release-deploy
kind: runbook
version: 0.1.0
owner: Opus # maintains this document only — it authorizes nothing (SPEC-RUN-001)
humanApprover: Zamp
specs: [SPEC-DEPLOY-002, SPEC-DEPLOY-003, SPEC-DEPLOY-007, SPEC-DEPLOY-008, SPEC-DEPLOY-009, SPEC-DEPLOY-010, SPEC-DEPLOY-011, SPEC-LANE-001, SPEC-LANE-002, SPEC-LANE-003, SPEC-RUN-002]
inputs: [the release SHA, the wave's stack group, the reviewed PLAN_DIGEST from the plan runbook, a fresh decisionId, Zamp's deploy cloud authorization value]
outputs: [executed change sets for the wave, per-stack results, the run summary]
gateRequired: true
cloudMutation: true
---

# Runbook — dev release, DEPLOY one reviewed wave

> **Status: DESIGN — `PLANNED — not executable`.** Nothing here runs in the current phase. This
> operation executes stacks; its authorization instrument is the **cloud authorization**
> (`CBA_CLOUD_GATE`, `deploy`, naming the reviewed `PLAN_DIGEST`), never the publication one.

One operation: execute exactly the change sets whose digest Zamp reviewed, for ONE wave.

## Preflight

1. The [plan runbook](aws-dev-release-plan.md) completed for this wave and Zamp studied the
   rendering — semantics first, then the resource changes — and decided this exact plan may
   execute.
2. Zamp has issued the `deploy` value for THIS decision: the SAME release SHA, assembly digest
   and stack group, the reviewed `planDigest`, a FRESH `decisionId` and a fresh ≤1h window
   (SPEC-DEPLOY-002/009/010/011). A digest from any other decision is never reused.
3. The plan's change sets still exist and were not superseded (a later plan run replaces them by
   name — if one ran, restart at plan).

## Commands

`PLANNED — not executable` in this phase. Templates:

1. Zamp sets the deploy value:

   ```text
   gh api -X PATCH repos/<owner>/<repo>/environments/dev/variables/CBA_CLOUD_GATE \
     -f name=CBA_CLOUD_GATE \
     -f value='<the deploy JSON for this decision, planDigest included>'
   ```

2. The operator dispatches the lane, same inputs as the plan run:

   ```text
   gh workflow run "Release Pilot" --ref main \
     -f release_sha=<full 40-character release SHA> \
     -f mode=dev_only
   ```

   Expected outcome: the entrypoint re-describes the exact change sets, requires the digest to
   match (`PLAN_CHANGED` otherwise, SPEC-DEPLOY-003), revalidates window and account before
   EACH execution (SPEC-DEPLOY-008), executes the wave in dependency order and reports
   per-stack results; child text is never echoed (SPEC-DEPLOY-007).

3. The operator captures the result:

   ```text
   gh run view <run-id> --log | grep -B 2 -A 40 'PLAN_DIGEST'
   ```

## Evidence

- The run summary: digest match line with `decisionId`, per-stack execution results, and — on
  any failure — the child-evidence line (exit, per-stream bytes, framed digest).
- An `EVENTS.md` entry per decision, appended through the normal reviewed flow.
- No secrets, account ids or live ARNs anywhere.

## Stop conditions

1. `PLAN_CHANGED` — live state moved since the review. Stop the WAVE; restart at the plan
   runbook with a fresh decision. A stale digest is never re-authorized.
2. `CLOUD_GATE_EXPIRED` / `CLOUD_GATE_TTL_EXCEEDED` / `CLOUD_GATE_NOT_YET_VALID` — the window is
   wrong. Stop; fresh decision; windows are never widened.
3. `CHANGE_SET_MISSING` / `CHANGE_SET_UNAVAILABLE` / `CHANGE_SET_SCHEMA_UNKNOWN` — the prepared
   sets are not in a reviewed state. Stop and investigate; never retried blind.
4. `EXECUTE_FAILED` / `STACK_EXECUTION_FAILED` — execution refused or a stack failed mid-wave.
   The output records exactly which stacks executed. Stop; continue in the
   [recovery runbook](aws-dev-release-recovery.md).
5. Any GitHub-side failure before the entrypoint — stop; nothing mutated, by construction.

## Rollback

Rollback is not performed inside this runbook: any post-execution correction is a NEW release
decision, handled by the [recovery runbook](aws-dev-release-recovery.md). What a FAILED
execution does to the failing stack is whatever the reviewed change set's
`OnStackFailure`/rollback configuration declared — which is exactly why the rendering names
them and Zamp reads them before authorizing.

## Cleanup

- After the decision concludes, Zamp clears the `CBA_CLOUD_GATE` variable.
- The run summary and the `EVENTS.md` record are retained; nothing else persists.
