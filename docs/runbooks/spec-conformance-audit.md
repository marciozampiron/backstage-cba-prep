---
id: spec-conformance-audit
kind: runbook
version: 0.3.0
owner: Opus
humanApprover: Zamp
specs: [SPEC-GOV-001, SPEC-GOV-002, SPEC-GOV-003, SPEC-GOV-004, SPEC-GOV-005, SPEC-GOV-006, SPEC-GOV-007, SPEC-GOV-008, SPEC-GOV-009, SPEC-AUDIT-001, SPEC-AUDIT-002, SPEC-AUDIT-003, SPEC-AUDIT-004, SPEC-AUDIT-005, SPEC-RUN-001]
inputs: [the audited commit's full SHA, the spec registry at that SHA, the mechanical reports for that SHA, Zamp's per-run spend authorization for the semantic stage]
outputs: [a SPEC_AUDIT_REPORT v1 document bound to the audited SHA]
gateRequired: true
cloudMutation: false
---

# Runbook — spec conformance audit

> **Status: DESIGN — the mechanical layers do not exist yet.** Every command below is
> `PLANNED — not executable`; nothing in this runbook is to be run in the current phase. The
> runbook exists now so the audit flow is reviewed BEFORE the tooling is built
> (SPEC-AUDIT-001).

The order is fixed and is the point: **mechanical first, semantics second, independent review
third, human decision last.** No stage substitutes another. The audit stages are read-only over
the repository; the recording of their outputs is a SEPARATE reconciliation operation (see
Evidence), because "read-only" and "appends a file" cannot both be true of the same stage —
design review round 2 caught exactly that contradiction.

`gateRequired: true` refers to one dependency only: the semantic stage invokes a model service,
which is a paid call, and each run needs Zamp's explicit spend authorization
(SPEC-AUDIT-005 — the registry assigns the spend rule to that id; SPEC-AUDIT-003 is the
input-binding rule). No publication and no cloud effect occurs anywhere in this runbook.

## Preflight

1. The commit to audit is identified by its full 40-character SHA and exists on the reviewed
   branch — never a branch name, never a dirty worktree.
2. The spec registry at that SHA parses; every SPEC-ID is unique; lifecycle statuses are legal
   (SPEC-GOV-002/004).
3. The mechanical layers' versions are recorded, so two audits of the same SHA are comparable.
4. Zamp's spend authorization for THIS run exists, with the model, profile and cost ceiling it
   covers (SPEC-AUDIT-004/005).
5. The input bundle for the semantic stage is assembled from repository content only and its
   digest computed BEFORE invocation (SPEC-AUDIT-003).

## Commands

All `PLANNED — not executable` until the implementation phase lands and is itself reviewed:

1. `npm run spec:lint -- --commit <sha>` — the traceability LINTER: three-way traceability and
   lifecycle legality (SPEC-GOV-002/003). Expected outcome: exit 0 and a machine-readable
   report; exit 1 stops this runbook at Stop condition 1.
2. `npm run spec:conform -- --commit <sha>` — the CONFORMANCE CHECKS: every ACTIVE id's named
   tests and executable checks pass in this tree; governed-path changes without test/check
   changes are flagged. Expected outcome: exit 0 and a report; exit 1 stops at Stop condition 1.
3. The **Gemini Spec Auditor** persona runs per
   [`spec/agents/gemini-spec-auditor.md`](../../spec/agents/gemini-spec-auditor.md) — pinned
   model and limits, digested input bundle, tools disabled — and produces a
   `SPEC_AUDIT_REPORT v1`. Expected outcome: `VERDICT: PASS`, `FINDINGS` or `INCOMPLETE`; the
   persona changes nothing and authorizes nothing (SPEC-AUDIT-002).
4. **Codex** performs its independent review exactly as for any other change — the audit report
   is one more input to it, never a replacement for it.
5. **Zamp** reads the mechanical reports, the audit report and the independent review, and
   decides. This runbook ends at the decision.

## Evidence

- The two mechanical reports and the `SPEC_AUDIT_REPORT v1`, each bound to the audited SHA by
  the digests the report format requires.
- **Reconciliation is a separate operation**: attaching the reports to the issue and appending
  the `EVENTS.md` entry (SHA audited, verdicts, where the reports live) happens as a normal
  reviewed commit by the repository's usual flow — not by any audit stage. The audit stages
  produce documents; they publish nothing.
- Evidence never contains secrets, account ids, live ARNs or value-derived markers — paths,
  lines and SPEC-IDs only.

## Stop conditions

1. **Any mechanical exit ≠ 0** — divergence exists. Stop; the finding goes to the normal
   fix-forward flow. The semantic stage does not run over a diverged base.
2. **The audit report's `MECHANICAL:` line or digests do not match the actual reports** — the
   report is inconsistent; discard it and re-run stage 3 under a fresh authorization.
3. **Any stage attempts an effect** beyond its own report document — repository write, network
   beyond the pinned model endpoint, spend beyond the authorized ceiling — stop and record an
   incident.
4. **`VERDICT: INCOMPLETE`** — a ceiling was hit; Zamp either authorizes a re-run with new
   limits or abandons the audit; an INCOMPLETE is never read as PASS.
5. **`VERDICT: FINDINGS`** — the flow continues to Codex and Zamp, but nothing may be prepared
   on top of the audited SHA until the findings are dispositioned.

## Rollback

Nothing to roll back: every stage is read-only over the repository and produces only report
documents. A wrong report is superseded by a new report that names the one it replaces; reports
are never edited in place.

## Cleanup

- Temporary working files of the mechanical runs and the input bundle are removed; the reports
  are retained as record via the reconciliation operation.
- The spend authorization for the run is closed out — it covered that run only.
