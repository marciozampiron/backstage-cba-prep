# Task: <issue-or-title>

Roles and messages follow [`../MESSAGE-PROTOCOL.md`](../MESSAGE-PROTOCOL.md) — the canonical
contract. In short: Opus prepares → Codex reviews → Zamp approves → Opus executes → Zamp decides
and performs the merge.

## Owner

- Implementation executor and publication operator: Opus
- Architect / independent technical and security reviewer (read-only): Codex
- Approval, risk acceptance and merge authority: Zamp
- Next owner:

## Source of truth

- GitHub issue:
- Project/phase:
- Related ADR/spec/docs:

## Context

Briefly explain why this task exists and what state the repo is expected to be in.

## Do

- 

## Do not

- Do not push, open or mutate a pull request, merge, or deploy without an explicit
  `HUMAN_GATE_GRANTED` naming the exact ordered full SHAs. A generic "approved", or a
  `REVIEW_APPROVED`, is review feedback and never a publication gate.
- Do not self-approve, and do not act in a role you were not assigned.
- Do not amend, rebase or squash reviewed commits — corrections are NEW fix-forward commits.
- Do not change unrelated files.
- Do not bypass DDD/provider/source-grounding rules.

## Files likely involved

- 

## Validation

- `npm test`
- `git diff --check`
- add task-specific commands here

## Work log

- 

## Final report

Use the matching envelope from [`message.md`](message.md). It must carry:

- `COMMITS`: exact full 40-character SHAs, in order (never `HEAD`, a short SHA or a branch name)
- `STATUS`
- `NEXT_OWNER`
- `PROHIBITED_ACTIONS`
- validation evidence: commands run and their results
- residual risks and follow-ups
