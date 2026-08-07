---
id: aws-dev-release-deploy
kind: runbook
version: 0.3.0
owner: Opus # maintains this document only — it authorizes nothing (SPEC-RUN-001)
humanApprover: Zamp
specs: [SPEC-DEPLOY-002, SPEC-DEPLOY-003, SPEC-DEPLOY-007, SPEC-DEPLOY-008, SPEC-DEPLOY-009, SPEC-DEPLOY-010, SPEC-DEPLOY-011, SPEC-DEPLOY-016, SPEC-DEPLOY-017, SPEC-DEPLOY-018, SPEC-LANE-001, SPEC-LANE-002, SPEC-LANE-003, SPEC-RUN-002, SPEC-RUN-005, SPEC-RUN-007, SPEC-RUN-009, SPEC-DEPLOY-019, SPEC-LANE-006]
inputs: [the release SHA, the wave's stack group, the reviewed PLAN_DIGEST from the plan runbook, a fresh decisionId, Zamp's deploy cloud authorization value]
outputs: [executed change sets for the wave, per-stack results, the complete evidence artifact bound to run id and decision]
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
2. Zamp has issued the `deploy` value for THIS decision: the SAME manifest digest and stack
   group, the reviewed `planDigest`, a FRESH `decisionId` and a fresh ≤1h window
   (SPEC-DEPLOY-002/009/010/011/019). A digest from any other decision is never reused.
3. The plan's change sets still exist. They do NOT expire, and a later plan run does not replace
   them — creating a change set with an existing name fails, so a second plan for the same
   release either failed to prepare or the earlier sets were abandoned. Either way, if another
   plan run happened, restart at [bind](aws-dev-release-bind.md) rather than assume.
4. A correlation id is generated for THIS dispatch and recorded before it (SPEC-LANE-006).

## Commands

`PLANNED — not executable` in this phase. Templates:

1. **Zamp** sets the deploy value (repository administration plus the cloud instrument):

   ```text
   gh api -X PATCH repos/<owner>/<repo>/environments/dev/variables/CBA_CLOUD_GATE \
     -f name=CBA_CLOUD_GATE \
     -f value='<the deploy JSON for this decision, planDigest included>'
   ```

2. **Zamp** records the dispatch instant and dispatches the lane — `execute-change-sets` is a
   cloud effect, performed by Zamp:

   ```text
   gh workflow run "Release Pilot" --ref main \
     -f release_sha=<full 40-character release SHA> \
     -f mode=dev_only \
     -f correlation_id=<caller-generated id for this decision>
   ```

   Expected outcome: the entrypoint re-describes the exact change sets, requires the digest to
   match (`PLAN_CHANGED` otherwise, SPEC-DEPLOY-016), revalidates the account and then the
   window as the last operation before EACH execution (SPEC-DEPLOY-008/017), executes the wave
   in dependency order and reports per-stack results; child text is never echoed
   (SPEC-DEPLOY-007).

3. **Zamp** resolves the run and waits for a terminal conclusion (SPEC-RUN-009):

   ```text
   gh run list --workflow "Release Pilot" --branch main \
     --json databaseId,headSha,status,conclusion,event
   gh run watch <run-id> --exit-status
   ```

4. **Zamp** downloads the structured deploy ARTIFACT and digests it:

   ```text
   gh run download <run-id> --name deploy --dir <evidence-dir>/deploy-<run-id>
   sha256sum <evidence-dir>/deploy-<run-id>/deploy.json
   ```

5. **Zamp** verifies correlation id, release SHA, run id and conclusion, then writes the binding
   record: run id, correlation id, `decisionId`, release SHA, stack group, the `PLAN_DIGEST` this
   decision authorized, the change sets executed, and the artifact digest.

## Evidence

- The structured deploy artifact and its digest — never a log excerpt (SPEC-RUN-007).
- The binding record: run id, `decisionId`, release SHA, stack group, authorized `PLAN_DIGEST`,
  change sets executed, artifact digest.
- Within the artifact: the digest-match line, per-stack results, and — on any failure — the
  child-evidence line (exit, per-stream bytes, framed digest) and the honest partial record of
  which change sets executed (SPEC-DEPLOY-018).
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
6. The artifact's correlation id, release SHA or run id does not match the request, or the run
   has no terminal conclusion — stop; evidence that cannot be tied to THIS decision cannot show
   what executed.

## Rollback

Rollback is not performed inside this runbook: any post-execution correction is a NEW release
decision, handled by the [recovery runbook](aws-dev-release-recovery.md). What a FAILED
execution does to the failing stack is whatever the reviewed change set's
`OnStackFailure`/rollback configuration declared — which is exactly why the rendering names
them and Zamp reads them before authorizing.

## Cleanup

- After the decision concludes, Zamp clears the `CBA_CLOUD_GATE` variable.
- The run summary and the `EVENTS.md` record are retained; nothing else persists.
