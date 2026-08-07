---
id: aws-dev-release-plan
kind: runbook
version: 0.1.0
owner: Opus # maintains this document only — it authorizes nothing (SPEC-RUN-001)
humanApprover: Zamp
specs: [SPEC-DEPLOY-001, SPEC-DEPLOY-002, SPEC-DEPLOY-003, SPEC-DEPLOY-005, SPEC-DEPLOY-006, SPEC-DEPLOY-009, SPEC-DEPLOY-010, SPEC-DEPLOY-011, SPEC-DEPLOY-012, SPEC-DEPLOY-013, SPEC-DEPLOY-014, SPEC-DEPLOY-015, SPEC-LANE-001, SPEC-LANE-003, SPEC-RUN-002, SPEC-RUN-005, SPEC-RUN-006, SPEC-RUN-007]
inputs: [the release SHA, the binding run's manifest digests, the wave's stack group, a fresh decisionId, Zamp's plan_only cloud authorization value]
outputs: [prepared change sets for the wave, the PLAN_DIGEST, the complete evidence artifact bound to run id and decision]
gateRequired: true
cloudMutation: true
---

# Runbook — dev release, PLAN one wave

> **Status: DESIGN — `PLANNED — not executable`.** Nothing here runs in the current phase. This
> operation is CLOUD MUTATION even though no stack executes: preparing change sets creates
> CloudFormation resources and publishes assets (SPEC-RUN-002). Its authorization instrument is
> the **cloud authorization** (`CBA_CLOUD_GATE`, `plan_only`), never the publication one.

One operation: prepare ONE wave's change sets and put the plan on the record.

## Preflight

1. The shared preflight of the [index](aws-dev-release.md) holds.
2. The [binding runbook](aws-dev-release-bind.md) has produced this release's manifest digests
   (SPEC-RUN-006). The authorization cannot be authored before them: `assemblyDigest` is emitted
   by `dev-preflight`, not known at dispatch time.
3. Zamp has issued the `plan_only` value for THIS decision — release SHA, the bound assembly
   digest, the wave's stack group, fresh `decisionId`, `planDigest: null`, `approvedAt`/
   `expiresAt` window of at most one hour (SPEC-DEPLOY-002/009/010/011).
4. No value from a previous decision is still set on the Environment (that decision's Cleanup
   completed).

## Commands

`PLANNED — not executable` in this phase. Templates:

1. **Zamp** sets the cloud authorization on the dev Environment (repository administration and a
   cloud instrument — both outside Opus's policy capabilities):

   ```text
   gh api -X PATCH repos/<owner>/<repo>/environments/dev/variables/CBA_CLOUD_GATE \
     -f name=CBA_CLOUD_GATE \
     -f value='<the plan_only JSON for this decision>'
   ```

   Expected outcome: the variable holds exactly this decision's value.

2. **Zamp** records the dispatch instant and dispatches the lane — `prepare-change-sets` is a
   cloud effect, performed by Zamp:

   ```text
   date -u +%Y-%m-%dT%H:%M:%SZ            # recorded BEFORE dispatching
   gh workflow run "Release Pilot" --ref main \
     -f release_sha=<full 40-character release SHA> \
     -f mode=dev_only
   ```

   Expected outcome: the run is queued. Synthesis runs credential-free first (SPEC-LANE-001);
   the entrypoint prepares the wave's named change sets, validates every service page
   (SPEC-DEPLOY-005/012/013) and emits `PLAN_DIGEST` with the redacted rendering
   (SPEC-DEPLOY-003/006/014). Nothing executes.

3. **Zamp** resolves the run id, requiring exactly one match — dispatch returns no id, and a
   concurrent run must never be mistaken for this one (SPEC-RUN-007):

   ```text
   gh run list --workflow "Release Pilot" --branch main \
     --json databaseId,headSha,createdAt,event \
     --jq '[.[] | select(.event=="workflow_dispatch" and .createdAt >= "<dispatch instant>")]'
   ```

   Expected outcome: exactly one entry, whose `headSha` is the release SHA.

4. **Zamp** captures the COMPLETE evidence artifact and digests it — never an excerpt, because a
   larger plan would be silently truncated and a truncated plan is not what was reviewed:

   ```text
   gh run view <run-id> --log > <evidence-dir>/plan-<run-id>.log
   sha256sum <evidence-dir>/plan-<run-id>.log
   ```

   Expected outcome: the full log plus its digest.

5. **Zamp** writes the binding record for this artifact: run id, `decisionId`, release SHA, the
   wave's stack group, the `PLAN_DIGEST` read from the artifact, the change-set ids prepared,
   and the artifact digest. This record is what the deploy decision and any abandon decision
   refer to.

## Evidence

- The COMPLETE run log artifact and its digest — the reviewed material is the artifact, not a
  `grep` window over it (SPEC-RUN-007).
- The binding record: run id, `decisionId`, release SHA, stack group, `PLAN_DIGEST`, the prepared
  change-set ids, artifact digest.
- An `EVENTS.md` entry per decision, appended through the normal reviewed flow, not by the run.
- No secrets, account ids or live ARNs anywhere; the rendering's redaction discipline
  (SPEC-DEPLOY-006) is the contract.

## Stop conditions

1. Any entrypoint refusal code — the run output names it (`CLOUD_GATE_*`,
   `CHANGE_SET_SCHEMA_UNKNOWN`, `CHANGE_SET_PAGINATION_UNCONSUMED`, `PLAN_PREPARE_FAILED`, …).
   Stop; these are never retried blind; a fresh decision is required after the cause is
   understood.
2. A GitHub-side failure of identity, preflight or credentials — stop; nothing after them ran,
   by construction (SPEC-LANE-001).
3. The window lapsed before dispatch — stop; a fresh decision value is required; windows are
   never widened to "make it fit".
4. The run id does not resolve to exactly one entry, or its `headSha` is not the release SHA —
   stop; evidence bound to the wrong run describes a plan nobody produced.

## Rollback

Prepared change sets **persist until they are deleted**: AWS retains a change set until the stack
is updated or the set is explicitly deleted, and a later plan run does NOT replace one by name —
creating a change set with an existing name fails. A plan Zamp declines therefore leaves
EXECUTABLE change sets behind, and removing them is its own authorized operation:
[abandon](aws-dev-release-abandon.md) (SPEC-RUN-008). No stack state changed here; the change
sets are the thing to clean up.

## Cleanup

- After the decision concludes (digest reviewed, or stopped), Zamp clears the `CBA_CLOUD_GATE`
  variable — a live value must not linger past its decision.
- The captured evidence is retained; temporary logs are not.
