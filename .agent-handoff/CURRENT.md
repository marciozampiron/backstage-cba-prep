# Current Agent Coordination State

Last updated: 2026-07-06
Updated by: Claude

This file is the fast boot context for agents entering the repository. GitHub Issues and the
Project board remain the source of truth; this file summarizes local coordination state.

## Current baseline

- `origin/main` is the published baseline. Use `git rev-parse --short origin/main` or `git log -1 --oneline origin/main` for the exact current SHA. Do not pin a specific origin/main SHA here — it goes stale on every push.
- Local `main` should match `origin/main` (no unpublished commits). Run `git log --oneline origin/main..HEAD` to confirm; do not rely on `CURRENT.md` for mutable unpublished commit SHAs.
- #34 architecture diagrams are the accepted AWS roadmap diagram version unless a new handoff explicitly reopens them.
- Do not rework architecture diagrams from older commits such as `06f1141`; that context is stale.

## Active priority

- Phase 1 design track (#37/#34/#35/#36/#16/#15/#38) and the #11 Web MVP slices 1–4b
  (#39/#40/#41/#42/#43) are pushed with CI green and issues closed. `main` should be in sync with
  `origin/main` (ahead 0).
- The web app lives in `web/` (self-contained Next.js; not a root workspace) with committed
  regression smokes under `web/scripts/`.
- Next candidates (await architect assignment): real Cognito identity adapter + `/api/me` (§16) +
  sign-in surface; §15 progress screen (ProgressSnapshot/trends); Phase 4 admin review actions.
- Housekeeping: duplicate issue #45 (executor-opened; canonical is #42) is flagged for human closure.

## Do not touch without explicit assignment

- CBA question facts or explanations without official Backstage/LF source evidence.
- Architecture diagrams already accepted for #34.
- Provider/runtime boundaries delivered by #23/#27/#29/#30/#31 unless the task explicitly targets them.
- `docs/product/` contracts/data-model/scope docs and the canonical Stitch prototype
  (`docs/product/prototypes/stitch-cba-study-coach/`) — amend only via an assigned task.
- `web/` BFF-shaped contracts and exam-mode rules (no correctness pre-submit; deterministic-only
  coach) delivered by #39–#43.

## Required behavior

- Run `npm run agent-refresh` before editing, before commit, before push, after git-state changes, and every 5 minutes during long-running work.
- Check `.agent-handoff/active/` before starting work.
- Record any delegated task in `inbox/`, `active/`, or `done/`.
- Update `CURRENT.md` and append to `EVENTS.md` after meaningful state changes.
- Never push without explicit human approval.
