# Done: Security assurance architecture and agent rules (#85)

## Status

DONE. Issue #85 is CLOSED. The three canonical documents it defines are on `main`:
`spec/security-rules.md`, `docs/architecture/security-assurance-baseline.md` and
`docs/architecture/ai-agent-security-model.md`. Moved out of `active/` on 2026-07-30 during the #75
closeout audit: the issue is closed and no agent or worktree held ownership.

The individual controls this architecture catalogs are implemented by their own issues, and the
"implementation executor for later controls: unassigned" line below refers to those, not to
unfinished work in #85 itself.

## Ownership

- Architecture/document owner: Codex
- Implementation executor for later controls: unassigned
- Independent reviewer: Claude Opus 5 or another agent, assigned after the architecture commit
- Human gate: required before push and before any cloud, deploy, paid AI, or risk-acceptance action

## Scope

- Create the canonical cross-cutting security baseline and control catalog.
- Create the AI coach/authoring agent security model.
- Add concise mandatory repository rules.
- Add thin Codex and Claude security-review skills that reference the canonical policy.
- Reconcile the security wiki.
- Create #84 with native sub-issues #85-#90 and classify them on Project #3.

## Artifacts

- `spec/security-rules.md`: mandatory, concise rules for every human/coding agent.
- `docs/architecture/security-assurance-baseline.md`: assets, data classes, trust boundaries,
  threat register, controls, roles, review output, and separate release gates.
- `docs/architecture/ai-agent-security-model.md`: learner-coach/authoring profiles, `AI-T01` through
  `AI-T08`, deterministic tool protocol, Bedrock Guardrails position, and adversarial evidence.
- `.agents/skills/review-security/`: Codex review workflow and generated metadata.
- `.claude/skills/security-review/`: Claude executor/independent-review workflow.
- `AGENTS.md` and `docs/wiki/Security-Compliance.md`: durable entry points to canonical policy.

## Project State

- #84: parent epic, In Progress, Phase 1.
- #85: this architecture task, In Progress, Phase 1.
- #86: automated security fitness/supply-chain gates, Todo, Phase 1.
- #87: agentic coach/authoring security, Todo, Phase 3.
- #88: deployed abuse/DAST gate, Todo, Phase 1.
- #89: incident response/risk acceptance/go-live review, Todo, Phase 1.
- #90: API throttling and cost-abuse controls, Todo, Phase 1.
- #85-#90 are native sub-issues of #84 and all seven items are on Project #3.

## Exclusions

- No runtime, BFF, web, CDK, workflow, question-bank, or observability implementation.
- No changes to the active #82 Slice A files.
- No AWS/Cloudflare mutation, deploy, DAST, live model call, or paid eval.
- No edits to the existing #10 spec changes, governance residue, or `.vscode/`.

## Coordination

- #82 has a separate active owner and local commit. This task touches a disjoint architecture/rules
  fileset and must remain a separate commit.
- Do not push this task until #82 ownership/state is reconciled, an independent review is complete,
  and the human approves the exact commit.

## Validation Evidence

- Project/parent/status/phase: verified through GitHub GraphQL.
- Root tests: `77/77` passing.
- Question bank: `60/60` valid, `0` errors.
- Codex and Claude skills: both pass the official `quick_validate.py` validator.
- Local canonical links: present and resolved.
- `git diff --check`: clean.
- Secret/account-ID scan over this task files: no findings.
- Runtime/IaC/workflow/question-bank diff for this task: none.
- `npm run agent-refresh`: `ok`; #82 and #85 own disjoint files.
- Independent Claude Opus 5 review reported three medium and two low findings: cross-agent
  approval ambiguity, missing AI threat ownership/residual risk, missing throttling owner, policy
  precedence, and malformed commit metadata.
- Findings resolved in the same architecture commit: actor-class approval prohibition, one threat
  register row per `AI-T01` through `AI-T08`, stricter-policy precedence, live-invocation budget
  wording, and #90 as the native Phase 1/Todo implementation owner for `SYS-T05`/`SEC-WEB-01`.

## Remaining Gate

1. Create one local architecture commit containing only the files listed under Artifacts.
2. Ask Claude Opus 5 for independent findings-first review using the new security skill.
3. Resolve findings by amend if required.
4. Human authorizes the exact final commit before push.
5. After push and green CI, close #85 and move it to Done; #84 stays open for #86-#90.

No push, deploy, cloud mutation, live security test, or model invocation was performed.
