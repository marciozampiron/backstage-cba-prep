# Current Agent Coordination State

Last updated: 2026-07-06
Updated by: Claude

This file is the fast boot context for agents entering the repository. GitHub Issues and the
Project board remain the source of truth; this file summarizes local coordination state.

## Current baseline

- `origin/main` includes `7d69262 feat: add agent-refresh handoff state check` (agent handoff protocol + agent-refresh CLI + the #34 architecture diagrams are pushed).
- Local `main` should match `origin/main` (no unpublished commits). Run `git log --oneline origin/main..HEAD` to confirm; do not rely on `CURRENT.md` for mutable unpublished commit SHAs.
- #34 architecture diagrams are the accepted AWS roadmap diagram version unless a new handoff explicitly reopens them.
- Do not rework architecture diagrams from older commits such as `06f1141`; that context is stale.

## Active priority

- Handoff protocol + agent-refresh + #34 are pushed; `main` is in sync with `origin/main` (ahead 0).
- Then move toward #35 frontend screen map / prototype brief and #36 Web BFF contracts after confirming the board state.

## Do not touch without explicit assignment

- CBA question facts or explanations without official Backstage/LF source evidence.
- Architecture diagrams already accepted for #34.
- Provider/runtime boundaries delivered by #23/#27/#29/#30/#31 unless the task explicitly targets them.

## Required behavior

- Run `npm run agent-refresh` before editing, before commit, before push, after git-state changes, and every 5 minutes during long-running work.
- Check `.agent-handoff/active/` before starting work.
- Record any delegated task in `inbox/`, `active/`, or `done/`.
- Update `CURRENT.md` and append to `EVENTS.md` after meaningful state changes.
- Never push without explicit human approval.
