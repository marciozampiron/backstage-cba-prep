# Task: document push gate protocol

## Owner

- Agent: Codex
- Human gate: required before push

## Source of truth

- User decision: `agent-refresh --record` is a technical checkpoint, not push authorization.
- Related docs: AGENTS.md, .agent-handoff/README.md, .agent-handoff/EVENTS.md

## Context

The user clarified that push permission must be explicitly recorded. The protocol needs to separate
technical state checks from human approval.

## Do

- Document the Push gate in AGENTS.md and .agent-handoff/README.md.
- Keep `agent-refresh --record` as technical audit only.
- Record this protocol clarification in EVENTS.md.

## Do not

- Do not push without explicit human approval.
- Do not make `agent-refresh --record` imply push approval.

## Validation

- `npm run agent-refresh`
- `git diff --check`
- `npm test`

## Final report

- Commit SHA: unpublished; inspect with `git log --oneline origin/main..HEAD` after commit/amend.
- Validation result: `npm run agent-refresh`, `git diff --check`, and `npm test` passed.
- Push/CI status: not pushed.
- Remaining risks/follow-ups: before actual push, append a Human gate event, then run `npm run agent-refresh -- --record` immediately before pushing.
