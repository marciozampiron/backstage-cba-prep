# Task: #38 Web BFF contracts — second pass (sessions, review, progress, preferences)

## Owner

- Agent: Claude (executor)
- Human gate: required before push

## Source of truth

- GitHub issue: #38 (part of #33; unblocks #11; relates to #36/#15)
- Related docs: `docs/product/web-bff-contracts.md` (#36 first pass);
  `docs/product/cba-web-mvp-scope.md` (#15); `docs/product/saas-data-model.md` (#16);
  `docs/product/frontend-screen-map.md` (#35); `docs/adr/0002-cloudflare-nextjs-aws-bff.md`

## Context

The #15 consolidation flagged the second contract pass as the prerequisite for the #11 build slices.
This task specifies the remaining learner endpoints (practice sessions, mock session flow, missed
review, progress, me/preferences) in the existing contracts doc. Docs only, fully deterministic —
no endpoint in this pass may trigger paid AI work.

## Do

- Extend `docs/product/web-bff-contracts.md` with sections 7–17 (practice options/sessions/next/answers,
  mock get/answers/submit, attempts missed, progress, me, preferences) under the #36 conventions.
- Rewrite the deferred-endpoints section: only admin review actions remain deferred.
- Clear the "(2nd contract pass)" placeholders in `docs/product/cba-web-mvp-scope.md` and mark the
  build-order prerequisite as satisfied by #38.

## Do not

- Do not implement anything; no data-model or screen changes.
- Do not add AI-triggering endpoints or expose provider internals.
- Do not touch the question bank.
- Do not push without explicit human approval.
- Do not change unrelated files (`.gitignore`, the `.agent-handoff/EVENTS.md` local audit).

## Files likely involved

- `docs/product/web-bff-contracts.md` (extend)
- `docs/product/cba-web-mvp-scope.md` (clear placeholders)
- `.agent-handoff/active/38-web-bff-contracts-pass2.md` (this file; moves to `done/` when finished)

## Validation

- `npm run agent-refresh`
- `git diff --check`
- `npm test`

## Work log

- Assumed by Claude (executor). Boot: `agent-refresh` ok; main synced at `6400160` (#15 closed).
  Opened issue #38 with intent/scope/acceptance/guidance.
- Extended `docs/product/web-bff-contracts.md` with the second pass (§7–§17): practice options /
  sessions / next / answers (instant grounded feedback from the published version, never AI), mock
  session flow (`GET /:id` resume+navigator, `POST .../answers` silent save/replace,
  `POST .../submit` idempotent + auto-submit with unanswered-scores-incorrect), missed review
  (paged, full grounding; add-to-drill via practice-sessions `onlyMissed`), progress (trend +
  mastery + focus areas + cold-start), and me/preferences (partial PUTs). Exam-mode rule enforced
  throughout: no correctness leaves the backend before mock submission. Pass declared fully
  deterministic — no endpoint may trigger paid AI work.
- Updated the header (issues #36+#38) and the deferred section (only Phase 4 admin review actions
  remain). Cleared the "(2nd contract pass)" placeholders in `cba-web-mvp-scope.md`; build-order
  prerequisite marked satisfied by #38.
- Moved this handoff `active/` → `done/`.

## Final report

- Status: **DONE**; awaiting human gate for push.
- Local commit: `docs: define second-pass Web BFF contracts for #38` (unpushed — resolve the current
  SHA with `git log --oneline origin/main..HEAD`; do not hardcode an amendable local SHA).
- Files: `docs/product/web-bff-contracts.md` (extended), `docs/product/cba-web-mvp-scope.md`
  (placeholders cleared), this handoff.
- Validation result: `agent-refresh` ok; `git diff --check` clean; `npm test` 68/68.
- Push/CI status: **not pushed** — pending human gate (Codex remains architect/gate).
- Remaining risks/follow-ups:
  - Learner-surface contracts are now complete; #11 build slices are unblocked. Only admin review
    actions (Phase 4) remain deferred.
  - Idempotency/conflict semantics (ALREADY_ANSWERED vs safe retry, VERSION_MISMATCH) should get
    tests when the BFF is implemented.
  - Pre-existing local `EVENTS.md` audit and `.gitignore` change remain uncommitted, out of scope,
    per the architect's standing note (await a dedicated governance commit).
