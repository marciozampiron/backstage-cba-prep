# Task: agent-refresh --record support

## Owner

- Agent: Codex
- Human gate: required before push

## Source of truth

- User feedback: `--record` was executed but did not write an audit event.
- Related docs: AGENTS.md, .agent-handoff/README.md, .agent-handoff/EVENTS.md

## Context

`agent-refresh` currently accepts unknown CLI args but ignores `--record`. The user expected `--record`
to write an explicit audit event.

## Do

- Implement `agent-refresh --record`.
- Make it append an event to `.agent-handoff/EVENTS.md`.
- Add offline tests.
- Document the option.

## Do not

- Do not add a daemon/watch process.
- Do not push without explicit human approval.

## Validation

- `npm run agent-refresh`
- `git diff --check`
- `npm test`
- `node bin/cli.js agent-refresh --record`

## Final report

- Commit SHA: unpublished; inspect with `git log --oneline origin/main..HEAD` after commit.
- Validation result: `node --check`, `node bin/cli.js agent-refresh --json`, `git diff --check`, and `npm test` passed (67/67). `--record` write behavior is covered in temp-dir test.
- Push/CI status: not pushed.
- Remaining risks/follow-ups: running `--record` in the real repo intentionally modifies `.agent-handoff/EVENTS.md`; use it only when an explicit audit entry is wanted.
