---
id: aws-dev-release
version: 0.1.0
owner: Opus
humanApprover: Zamp
specs: [SPEC-DEPLOY-001, SPEC-DEPLOY-002, SPEC-DEPLOY-003, SPEC-DEPLOY-004, SPEC-DEPLOY-005, SPEC-DEPLOY-006, SPEC-DEPLOY-007, SPEC-DEPLOY-008, SPEC-LANE-001, SPEC-LANE-002, SPEC-LANE-003, SPEC-LANE-004, SPEC-IAM-001, SPEC-IAM-002]
inputs: [the release commit's full SHA (an ancestor of main), the dev Environment configuration, a per-decision CBA_CLOUD_GATE value, the activation prerequisites from the workflow header]
outputs: [deployed dev change sets matching a reviewed PLAN_DIGEST, run summaries, an EVENTS.md record per decision]
gateRequired: true
cloudMutation: true
---

# Runbook — AWS dev release (#70 Slice B1)

> **Status: DESIGN — nothing in this runbook is to be executed in the current phase.** The lane
> is not yet operable: the activation prerequisites in the `release-pilot.yml` header (per-tier
> release bootstraps, the deploy role, the dev Environment configuration, per-decision
> `CBA_CLOUD_GATE`) have not been provisioned, publication of the branch itself is not
> authorized, and every dispatch below additionally requires its own `HUMAN_GATE_GRANTED`. This
> document records the PLANNED flow so it is reviewed before it is ever run.

This runbook covers exactly one thing: releasing a reviewed commit to the **dev** tier through
the sanctioned entrypoint. Pilot is out of scope — promotion is mechanically blocked
(SPEC-LANE-004) until its own slices land.

## Preflight

1. The release SHA is a full 40-character ancestor of `main`, already merged through the normal
   flow — the lane's identity job enforces this, and the operator verifies it first anyway.
2. The activation prerequisites exist, evidenced read-only: both per-tier bootstraps
   (SPEC-IAM-001), the dev deploy role published as the Environment secret, the dev Environment
   variables, and the Environments' branch policies unchanged since last evidenced.
3. `Zamp` has issued `HUMAN_GATE_GRANTED` for the specific dispatch about to happen (plan or
   deploy), naming the exact SHA — generic approval text authorizes nothing.
4. The wave to run is chosen from the reviewed plan groups (SPEC-DEPLOY-004): fresh tier —
   Identity+Data, then Api, then Observability, one full cycle per wave; steady state — the full
   group in one cycle.
5. No prior run of this release is still executing (the literal `release-dev` concurrency group,
   SPEC-LANE-002, also enforces this).

## Commands

All `PLANNED — not executable` in this phase. Per wave, two dispatches:

1. **Plan.** Zamp sets the dev Environment variable `CBA_CLOUD_GATE` to a `plan_only` value for
   this decision: the exact release SHA, assembly digest, the wave's stack group, a fresh
   `decisionId`, `planDigest: null`, and an `approvedAt`/`expiresAt` window of at most one hour
   (SPEC-DEPLOY-002). The operator dispatches `Release Pilot` with the release SHA and
   `mode: dev_only`. Expected outcome: the run prepares the wave's named change sets and emits
   `PLAN_DIGEST` plus the redacted plan rendering (SPEC-DEPLOY-003, -005, -006); nothing
   deploys.
2. **Digest review.** Zamp reads the rendering — executable semantics first (on-failure,
   capabilities, deployment mode, drift), then the resource changes — and decides. A plan not
   worth executing ends the cycle here; nothing needs rolling back.
3. **Deploy.** Zamp replaces `CBA_CLOUD_GATE` with a `deploy` value naming the SAME release,
   assembly digest and stack group plus the reviewed `planDigest`, under a fresh `decisionId`
   and a fresh ≤1h window. The operator dispatches the workflow again, same inputs. Expected
   outcome: the run re-describes the exact change sets, requires the digest to match
   (`PLAN_CHANGED` otherwise), revalidates window and account before each execution
   (SPEC-DEPLOY-008), executes the wave in dependency order and reports per-stack results.
4. **Repeat** from step 1 for the next wave until the tier is complete (fresh tier: three
   cycles; steady state: one).

## Evidence

- Per dispatch: the run's summary with `PLAN_DIGEST`, the redacted plan rendering, per-stack
  execution results, and the child-evidence lines for any failure (SPEC-DEPLOY-007).
- Per decision: an `EVENTS.md` entry — release SHA, wave, `decisionId`, digest, outcome.
- Evidence never contains secrets, account ids or live ARNs; the rendering's redaction
  discipline (SPEC-DEPLOY-006) is the contract, not an aspiration.

## Stop conditions

Any refusal code from the entrypoint halts the cycle — the run output names it. In particular:

1. `PLAN_CHANGED` — live state moved since the reviewed plan. Stop; a NEW plan_only cycle with a
   new decision is required. Never re-issue a deploy value for a stale digest.
2. `CLOUD_GATE_EXPIRED` / `CLOUD_GATE_TTL_EXCEEDED` / `CLOUD_GATE_NOT_YET_VALID` — the window is
   wrong. Stop; a fresh decision value is required; windows are never widened to "make it fit".
3. `CHANGE_SET_SCHEMA_UNKNOWN` / `CHANGE_SET_PAGINATION_UNCONSUMED` / `CHANGE_SET_UNAVAILABLE` /
   `CHANGE_SET_MISSING` — the service response or the prepared sets are not in a reviewed state.
   Stop and investigate before any new dispatch; these are never retried blind.
4. `EXECUTE_FAILED` / `STACK_EXECUTION_FAILED` — execution refused or a stack failed mid-wave.
   The output records exactly which stacks executed. Stop; proceed to Rollback assessment.
5. Any GitHub-side failure of the identity, preflight or credential steps — stop; nothing after
   them ran, by construction (SPEC-LANE-001).

## Rollback

- "Known-good" for dev is the previous successfully deployed release of the tier — dev rollback
  targets prior validated dev releases, never pilot tags.
- Rollback is a NEW release of that prior SHA through this same runbook (plan → digest review →
  deploy), under its own decisions and windows. There is no side-channel undo, and CloudFormation
  rollback behavior within a failed execution is whatever the reviewed change set's
  `OnStackFailure`/rollback configuration declared — which is exactly why the rendering names
  them (SPEC-DEPLOY-005/006).
- A partially executed wave (stop condition 4) is assessed stack by stack from the honest
  partial record before ANY new dispatch; the assessment and the chosen path are recorded in
  `EVENTS.md`.

## Cleanup

- After each decision concludes (success or stop), Zamp clears the `CBA_CLOUD_GATE` variable —
  an expired value is dead by construction, but a live one must not linger past its decision.
- Run artifacts beyond the retained summaries are not kept; the `EVENTS.md` entries and the
  summaries are the record.
- On success of the final wave: the deployed state, the digests and the decisions are recorded;
  nothing else persists.
