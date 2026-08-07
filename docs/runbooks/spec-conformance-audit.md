---
id: spec-conformance-audit
version: 0.1.0
owner: Opus
humanApprover: Zamp
specs: [SPEC-DEPLOY-001, SPEC-DEPLOY-002, SPEC-DEPLOY-003, SPEC-DEPLOY-004, SPEC-DEPLOY-005, SPEC-DEPLOY-006, SPEC-DEPLOY-007, SPEC-DEPLOY-008, SPEC-LANE-001, SPEC-LANE-002, SPEC-LANE-003, SPEC-LANE-004, SPEC-IAM-001, SPEC-IAM-002]
inputs: [the audited commit's full SHA, the spec registry, the mechanical auditor output for that SHA]
outputs: [a SPEC_AUDIT_REPORT document, an EVENTS.md entry recording the audit]
gateRequired: false
cloudMutation: false
---

# Runbook — spec conformance audit

> **Status: DESIGN — the mechanical auditor does not exist yet.** Every command below is
> `PLANNED — not executable`; nothing in this runbook is to be run in the current phase. The
> runbook exists now so the audit flow is reviewed BEFORE the tooling is built, per
> [`spec/spec-anchored-development.md`](../../spec/spec-anchored-development.md).

The order is fixed and is the point of this runbook: **mechanical first, semantics second,
independent review third, human decision last.** No stage substitutes another.

## Preflight

1. The commit to audit is identified by its full 40-character SHA and exists on the reviewed
   branch — never a branch name, never a dirty worktree.
2. The spec registry (`spec/spec-anchored-development.md` §5) parses and every SPEC-ID is unique.
3. The mechanical auditor's version is recorded, so two audits of the same SHA are comparable.
4. No stage of this audit requires credentials, network effects or paid calls; if any invocation
   would, stop — the audit design is wrong, not the environment.

## Commands

All `PLANNED — not executable` until the implementation phase lands and is itself reviewed:

1. `npm run spec:audit -- --commit <sha>` — the MECHANICAL pass: verifies SPEC → code anchors,
   SPEC → test anchors, and code/test → SPEC annotations; exits 0 only when every direction
   holds. Expected outcome: a machine-readable report; **exit 1 closes CI** and stops this
   runbook at Stop condition 1.
2. The **Gemini Spec Auditor** persona runs per its procedure
   ([`spec/agents/gemini-spec-auditor.md`](../../spec/agents/gemini-spec-auditor.md)) over the
   same SHA plus the mechanical output, and produces a `SPEC_AUDIT_REPORT` document. Expected
   outcome: `VERDICT: PASS` or `VERDICT: FINDINGS` with evidence; the persona changes nothing
   and authorizes nothing.
3. **Codex** performs its independent review exactly as for any other change — the audit report
   is one more input to it, never a replacement for it.
4. **Zamp** reads the mechanical result, the audit report and the independent review, and
   decides. Any effect that follows (merge, publication, deployment) uses the normal protocol
   messages; this runbook ends at the decision.

## Evidence

- The mechanical report and the `SPEC_AUDIT_REPORT`, both bound to the audited SHA, attached to
  the issue or review thread.
- An `EVENTS.md` entry: SHA audited, mechanical verdict, audit verdict, where the reports live.
- Evidence never contains secrets, account ids, live ARNs or value-derived markers — paths,
  lines and SPEC-IDs only.

## Stop conditions

1. **Mechanical exit ≠ 0** — divergence exists. Stop; the finding goes to the normal fix-forward
   flow. The semantic stage does not run over a diverged base.
2. **The audit report's `MECHANICAL:` line does not match the actual mechanical verdict** — the
   report is inconsistent; discard it and re-run stage 2.
3. **Any stage attempts an effect** (file mutation outside its report, network call, spend) —
   stop and record it as an incident; the audit design forbids effects.
4. **`VERDICT: FINDINGS`** — the flow continues to Codex and Zamp, but no effect may be prepared
   on top of the audited SHA until the findings are dispositioned.

## Rollback

Nothing to roll back: every stage is read-only over the repository and produces only reports.
A wrong report is superseded by a new report on a new run; reports are never edited in place.

## Cleanup

- Temporary working files of the mechanical run are removed; the reports are retained as record.
- The `EVENTS.md` entry is appended in the same change that archives the reports.
