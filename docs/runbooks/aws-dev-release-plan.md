---
id: aws-dev-release-plan
kind: runbook
version: 0.1.0
owner: Opus # maintains this document only — it authorizes nothing (SPEC-RUN-001)
humanApprover: Zamp
specs: [SPEC-DEPLOY-001, SPEC-DEPLOY-002, SPEC-DEPLOY-003, SPEC-DEPLOY-005, SPEC-DEPLOY-006, SPEC-DEPLOY-009, SPEC-DEPLOY-010, SPEC-DEPLOY-011, SPEC-DEPLOY-012, SPEC-DEPLOY-013, SPEC-DEPLOY-014, SPEC-LANE-001, SPEC-LANE-003, SPEC-RUN-002]
inputs: [the release SHA, the wave's stack group, a fresh decisionId, Zamp's plan_only cloud authorization value]
outputs: [prepared change sets for the wave, the PLAN_DIGEST, the redacted plan rendering, the run summary]
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
2. Zamp has issued the `plan_only` value for THIS decision — release SHA, assembly digest, the
   wave's stack group, fresh `decisionId`, `planDigest: null`, `approvedAt`/`expiresAt` window
   of at most one hour (SPEC-DEPLOY-002/009/010/011).
3. No other value is set on the Environment from a previous decision (Cleanup of the prior run
   completed).

## Commands

`PLANNED — not executable` in this phase. Templates:

1. Zamp sets the cloud authorization on the dev Environment (variable, writable only through
   repository settings):

   ```text
   gh api -X PATCH repos/<owner>/<repo>/environments/dev/variables/CBA_CLOUD_GATE \
     -f name=CBA_CLOUD_GATE \
     -f value='<the plan_only JSON for this decision>'
   ```

   Expected outcome: the variable holds exactly this decision's value.

2. The operator dispatches the lane:

   ```text
   gh workflow run "Release Pilot" --ref main \
     -f release_sha=<full 40-character release SHA> \
     -f mode=dev_only
   ```

   Expected outcome: identity, preflight and synth run credential-free first (SPEC-LANE-001);
   the entrypoint prepares the wave's named change sets, validates every service page
   (SPEC-DEPLOY-005/012/013), and emits `PLAN_DIGEST` plus the redacted rendering
   (SPEC-DEPLOY-003/006/014). Nothing executes.

3. The operator captures the result:

   ```text
   gh run view <run-id> --log | grep -A 200 'PLAN_DIGEST'
   ```

   Expected outcome: the digest and the rendering, saved into the decision's evidence.

## Evidence

- The run summary with `PLAN_DIGEST`, the redacted rendering, and per-stack prepare results.
- An `EVENTS.md` entry per decision — release SHA, wave, `decisionId`, digest — appended through
  the normal reviewed flow, not by the run.
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

## Rollback

Prepared change sets that will not be executed are abandoned by decision: they expire on the
service side and the next plan run replaces them by name. No stack state changed; there is
nothing else to undo.

## Cleanup

- After the decision concludes (digest reviewed, or stopped), Zamp clears the `CBA_CLOUD_GATE`
  variable — a live value must not linger past its decision.
- The captured evidence is retained; temporary logs are not.
