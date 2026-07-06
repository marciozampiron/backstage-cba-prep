# Task: #41 Implement #11 slice 3 — review missed + deterministic coach

## Owner

- Agent: Claude (executor)
- Human gate: required before push

## Source of truth

- GitHub issue: #41 (slice 3 of #11; part of #33; scope per #15)
- Contracts: `docs/product/web-bff-contracts.md` §14 (missed review) + §4 (coach, deterministic mode)
- UI: canonical Stitch `review_desktop`, `review_mobile` (+ result_explanation language from slice 1)
- Code base: `web/lib/*`, `web/app/**` (slices 1–2 pushed as `2c30373`)

## Context

Slices 1–2 are pushed and closed. Slice 3 closes the post-attempt learning loop: grounded review of
every missed question (§14, post-submit only) and the deterministic coach (§4) with its three scoped
actions. No AI — `mode: "deterministic"` everywhere; the grounded mode stays the Phase 3 seam.

## Do

- Store: `missedForAttempt` (§14 shape, paged, `409 ATTEMPT_NOT_COMPLETED`), `coachMessage` (§4:
  explain_question | recommend_next | explain_domain, grounded in published items/sources).
- Routes: `GET /api/attempts/:id/missed`, `POST /api/coach/message`.
- UI: `/review` (attempt picker + empty state), `/review/[attemptId]` (parity with review_desktop:
  filter row, missed cards with difficulty badge + domain chip + source row, expandable REVIEW
  detail with your/correct answer + explanation + source chip, PRACTICE AGAIN via onlyMissed drill;
  right rail Weak Domains + Recommended Drill); coach panel (deterministic) on review items and in
  the drill-feedback teaser; results CTA + dashboard action + Shell nav Review enabled;
  practice setup reads `onlyMissed` from the query.
- Committed regression smoke `web/scripts/smoke-review-coach.mjs`.

## Do not

- No AI/Bedrock/Strands (no model calls — deterministic composition only); no free-form chat.
- §14 never serves in-progress attempts (exam-mode rule stays intact).
- No auth/DB/progress/admin/mock changes; no root CLI or question-bank changes.
- No push without explicit human approval; root `.gitignore` and the EVENTS.md local audit untouched.

## Validation

- `npm run agent-refresh`; root `npm test`; `node bin/cli.js validate`; `git diff --check`
- `web`: `npm run build`; smokes (drill, mock, blank-mock, review-coach) on a fresh server;
  headless screenshots of review desktop/mobile + coach panel

## Work log

- Assumed by Claude (executor). Boot ok; origin/main at `2c30373` (#40 closed, board Done). Opened
  issue #41. Studied `review_desktop`/`review_mobile` canonical screenshots.
- Store: `missedForAttempt` (§14 — grounded missed items incl. unanswered mock questions, cursor
  pagination, `409 ATTEMPT_NOT_COMPLETED` pre-submit) and `coachMessage` (§4 deterministic —
  explain_question grounded in the learner's own answer + published explanation/sources,
  recommend_next from the weakest rated domain with warm-up fallback, explain_domain from blueprint
  data with representative doc sources; guards 400/404; accepts questionId or questionVersionId).
- Routes: `GET /api/attempts/:id/missed`, `POST /api/coach/message`.
- UI: `/review` (attempt picker + empty state), `/review/[attemptId]` with review_desktop parity
  (Domain/Difficulty filter row; cards with domain chip + difficulty badge + competency title +
  source row + Review expand [your/correct answer, explanation, source chips, coach panel] +
  Practice again via onlyMissed drill; right rail Weak Domains + navy Recommended Drill + citation
  note; celebrate state when nothing missed). Reusable `CoachPanel` (action-scoped chips, grounded
  answer, start-recommended-drill) also wired into the drill-feedback teaser (SOON removed).
  Results page gained the "Review Missed Questions" CTA; dashboard action went live; Shell nav +
  bottom tab Review enabled; practice setup reads `onlyMissed` from the query.
- Committed regression smoke `web/scripts/smoke-review-coach.mjs` (18 checks: §14 grounding +
  pagination + pre-submit 409; §4 three actions + guards; no AI/infra vocabulary in payloads;
  pages render).
- Verified on a fresh server: **drill, mock, review-coach, blank-mock smokes — 4/4 ALL PASS**;
  web build clean; 3 headless screenshots (review desktop/mobile, review index) inspected against
  the canonical prototype.
- Moved this handoff `active/` → `done/`.
- Architect blocker fix (amended into the same commit): `startDrill(onlyMissed)` only collected
  `answers` entries with `isCorrect === false`, so a blank mock's unanswered questions (no entry at
  all) were invisible to `onlyMissed` — the Review → Practice again flow died with
  `400 INSUFFICIENT_QUESTIONS`. Fix: the missed set is now built from **every `questionOrder` slot
  of submitted attempts where `answer?.isCorrect !== true`** (wrong answers and unanswered mock
  questions alike; in-progress attempts excluded). Domain/competency/difficulty filters still apply
  after the missed set. Regression added to `web/scripts/smoke-review-coach.mjs` (blank mock → 60
  missed → onlyMissed drill 201, per-domain and all-domains). Exact repro re-verified: 201.
  Fresh-server smokes 4/4 ALL PASS (an intermediate drill-smoke failure was first-run state
  pollution from the repro, not a regression).

## Final report

- Status: **DONE**; awaiting human gate for push.
- Local commit: `feat: implement #11 slice 3 review missed and deterministic coach` (unpushed —
  resolve the current SHA with `git log --oneline origin/main..HEAD`).
- Validation result: root `npm test` 68/68; `node bin/cli.js validate` 60/0; `git diff --check`
  clean; `agent-refresh` ok; web build clean; 4/4 smokes ALL PASS.
- Push/CI status: **not pushed** — pending human gate.
- Remaining risks/follow-ups:
  - Coach is deterministic-only by design; the Phase 3 grounded mode (#12) swaps in behind the same
    §4 shape (`mode` field) — no frontend change expected.
  - `429 COACH_RATE_LIMITED` is contracted but not enforced by the stub (no spend to protect);
    implement with the real BFF.
  - Review filters cover Domain/Difficulty (client-side); the prototype's Status/Source-reviewed
    filters need learner review-state persistence — deferred to the persistence slice.
  - Next slice (4): real auth (Cognito), persistence, ProgressSnapshot + progress screen, metrics
    instrumentation per `cba-web-mvp-scope.md`.
