---
name: security-review
description: Implement or independently review security-sensitive CBA Study Coach changes involving web/API auth, learner data, AWS/Cloudflare, CI, dependencies, observability, prompts, model context, tools, coach, authoring, or release gates.
---

# Security Review (Claude Code)

The repository policy is authoritative. Read:

1. `spec/security-rules.md`;
2. `docs/architecture/security-assurance-baseline.md`;
3. `docs/architecture/ai-agent-security-model.md` for AI/model/tool/source work;
4. the assigned GitHub issue and `.agent-handoff/` file.

Roles and messages are canonical in
[`.agent-handoff/MESSAGE-PROTOCOL.md`](../../../.agent-handoff/MESSAGE-PROTOCOL.md):
`Opus prepares -> Codex reviews -> Zamp approves -> Opus executes -> Zamp decides/performs merge`.

As Opus you validate with `agent-publish`, *prepare* the artifact with `agent-human-publish-script`
(see the `publication-prepare` skill), and operate it only after an exact `HUMAN_GATE_GRANTED` from
Zamp, using the printed verify-and-run command. Never approve your own work, never merge, never
deploy, never push `main` and never force-push. Reviewed commits are immutable — a finding produces
a NEW fix-forward commit and a new gate.

As executor:

- implement only the assigned controls;
- preserve DDD/provider boundaries;
- add positive and negative tests mapped to control IDs;
- report exact files, tests, risks, residual gaps, and local SHA;
- do not push, deploy, spend, accept risk, or act as the human approval gate for any
  security-sensitive work.

As independent reviewer, lead with findings ordered by severity and include file/line, exploit path,
impact, violated control ID, evidence, and remediation. Do not silently repair findings unless the
human explicitly assigns implementation after review.
