# Task: agent-refresh CLI automation

## Owner

- Agent: Codex
- Human gate: required before push

## Source of truth

- GitHub issue: not created yet
- Project/phase: agent collaboration / repo governance
- Related docs: AGENTS.md, .agent-handoff/README.md, .agent-handoff/CURRENT.md

## Context

The handoff protocol currently requires agents to refresh coordination state manually. The user asked
for partial automation instead of relying only on reading files by hand.

## Do

- Add a no-network `agent-refresh` CLI command.
- Check handoff files, active tasks, git status, unpublished local commits, and obvious stale state.
- Support `--json` for agent-readable output.
- Update handoff docs to use the command as the standard refresh checkpoint.

## Do not

- Do not push without explicit human approval.
- Do not add a daemon/watch process.
- Do not modify CBA question facts.

## Files likely involved

- bin/cli.js
- package.json
- src/commands/agent-refresh.js
- test/agent-refresh.test.js
- AGENTS.md
- .agent-handoff/README.md
- .agent-handoff/CURRENT.md
- .agent-handoff/EVENTS.md

## Validation

- `git diff --check`
- `npm test`
- `node bin/cli.js agent-refresh --json`

## Work log

- Started by Codex.
- Implemented `src/commands/agent-refresh.js`.
- Wired `agent-refresh` into `bin/cli.js` and `package.json`.
- Added offline tests in `test/agent-refresh.test.js`.
- Updated AGENTS.md and `.agent-handoff/README.md` to prefer `npm run agent-refresh`.

## Final report

- Commit SHA: unpublished; inspect with `git log --oneline origin/main..HEAD` after commit.
- Validation result: `node bin/cli.js agent-refresh --json`, `node --check`, `git diff --check`, and `npm test` passed (66/66).
- Push/CI status: not pushed.
- Remaining risks/follow-ups: consider pre-commit/pre-push hooks later; no daemon/watch process added.
