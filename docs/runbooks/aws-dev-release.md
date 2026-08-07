---
id: aws-dev-release
kind: index
version: 0.3.0
owner: Opus # maintains this document only — it authorizes nothing (SPEC-RUN-001)
humanApprover: Zamp
specs: [SPEC-DEPLOY-004, SPEC-LANE-002, SPEC-LANE-004, SPEC-RUN-004, SPEC-RUN-006, SPEC-RUN-008]
inputs: [the release commit's full SHA (an ancestor of main), the dev Environment configuration, the activation prerequisites from the workflow header]
outputs: [a fully released dev tier, one EVENTS.md record per decision]
gateRequired: true
cloudMutation: true
---

# Index — AWS dev release (#70 Slice B1)

> **Status: DESIGN — nothing under this index is to be executed in the current phase.** The lane
> is not yet operable (activation prerequisites in the `release-pilot.yml` header are not
> provisioned) and publication of the branch itself has not been authorized. These documents
> record the PLANNED flow so it is reviewed before it is ever run.

Releasing a reviewed commit to the **dev** tier is a flow of independent decisions, so it is
SEVERAL runbooks (one operation each), linked here in order. Pilot is out of scope — promotion
is mechanically blocked (SPEC-LANE-004).

## Shared preflight

1. The release SHA is a full 40-character ancestor of `main`, already merged through the normal
   flow.
2. The activation prerequisites exist, evidenced read-only: both per-tier bootstraps
   (SPEC-IAM-001), the dev deploy role published as the Environment secret, the dev Environment
   variables, and the Environments' branch policies unchanged since last evidenced.
3. The wave is chosen from the reviewed plan groups (SPEC-DEPLOY-004): fresh tier —
   Identity+Data, then Api, then Observability, one full plan/deploy cycle per wave; steady
   state — the full group in one cycle.
4. No prior run of this release is still executing (the literal `release-dev` concurrency
   group, SPEC-LANE-002, also enforces this).

## The flow, per wave

0. **[Bind](aws-dev-release-bind.md)** — read-only: obtain the release's binding artifact and
   its MANIFEST DIGEST, which the plan authorization must name and which does not exist before a
   run produces it (SPEC-RUN-006, SPEC-DEPLOY-019). No authorization, no cloud mutation.
1. **[Plan](aws-dev-release-plan.md)** — prepare the wave's change sets under a `plan_only`
   cloud authorization; obtain `PLAN_DIGEST` and the complete evidence artifact. Cloud
   mutation: change sets are created (SPEC-RUN-002).
2. **Zamp studies the artifact** — executable semantics first (on-failure, capabilities,
   deployment mode, drift), then the resource changes — and decides whether this exact plan may
   execute.
3. **[Deploy](aws-dev-release-deploy.md)** — execute exactly the reviewed change sets under a
   `deploy` cloud authorization naming the digest.
4. Repeat from step 0 for the next wave until the tier is complete.

If Zamp declines a plan at step 2: **[Abandon](aws-dev-release-abandon.md)** — the prepared
change sets remain EXECUTABLE until deleted, so declining is not the end of the cycle
(SPEC-RUN-008).

**Every runbook under this index is blocked on implementation-phase prerequisites** — the
`bind_only` and abandon lanes, the correlation-id input, the structured artifacts and the
`abandon` authorization mode (SPEC-LANE-005/006, SPEC-DEPLOY-019/020). They specify operations;
they are not yet instructions.

On any halt during step 3: **[Recovery](aws-dev-release-recovery.md)** (read-only assessment).

## Flow-spanning stop conditions

- Any stop condition inside a linked runbook halts the WHOLE flow, not just its step.
- A `PLAN_CHANGED` refusal anywhere restarts the wave at step 0 with a fresh decision — a stale
  digest is never re-authorized, and the superseded change sets are abandoned, not left behind.
- Evidence gaps (a dispatch whose summary or record is missing) halt the flow until reconciled;
  an unrecorded effect is treated as an incident, not as a success.
