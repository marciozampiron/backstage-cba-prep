# Task: #40 Implement #11 slice 2 — deterministic mock exam flow

## Owner

- Agent: Claude (executor)
- Human gate: required before push

## Source of truth

- GitHub issue: #40 (slice 2 of #11; part of #33; scope per #15)
- Contracts: `docs/product/web-bff-contracts.md` §2, §11–§13 (+ §3 reused for mock results)
- UI: canonical Stitch `mock_exam_desktop`, `mock_results_desktop`, `mock_results_mobile`
- Code base: `web/lib/bank.js`, `web/lib/store.js`, `web/app/**` (slice 1)

## Context

Slice 1 (drill loop) is pushed and closed (#39). Slice 2 adds the 60-question / 90-minute mock exam:
blueprint-weighted assembly, silent answer saves, flagging, navigator, idempotent submit with
auto-submit on expiry, and mock results on the §3 shape. Exam-mode rule is absolute: no
correctness/explanation/source feedback in any pre-submit payload.

## Do

- `web/lib/bank.js`: expose per-domain blueprint targets for mock assembly.
- `web/lib/store.js`: startMockExam (409 MOCK_EXAM_IN_PROGRESS), getMockExam (navigator + question,
  zero correctness), saveMockAnswer (upsert/replace/clear + flag; 409 ATTEMPT_NOT_IN_PROGRESS /
  VERSION_MISMATCH), submitMockExam (idempotent; expiry auto-submit; unanswered scores incorrect);
  extend results/missed counting for mock.
- Routes: POST `/api/mock-exams`, GET `/api/mock-exams/:id`, POST `.../answers`, POST `.../submit`.
- UI: mock session screen (two-panel navigator + question, countdown timer, flag, prev/next, submit
  with confirmation), start/resume entry, results page made kind-aware (Mock vs Drill), Shell nav
  "Mock Exam" enabled; dashboard action + resume wired.
- Smoke additions covering the full mock flow + pre-submit leak checks.

## Do not

- No correct/incorrect, correctOption, explanation, or source feedback before submit — anywhere.
- No AI/Bedrock/Strands/real auth/DB/billing/admin/review-missed surfaces.
- Browser talks only to `app/api/**`; no root CLI/core or question-bank changes.
- No push without explicit human approval; root `.gitignore` and the EVENTS.md local audit untouched.

## Validation

- `npm run agent-refresh`; root `npm test`; `node bin/cli.js validate`; `git diff --check`
- `web`: `npm run build`; runtime smoke (start → navigate → save/replace/clear → flag → navigator
  state → results pre-submit 409 → submit → results → resubmit idempotent → leak scan)

## Work log

- Assumed by Claude (executor). Boot ok (AGENTS.md, handoff README/CURRENT re-read); origin/main at
  `b35abf8`; no active handoffs. Studied `mock_exam_desktop` canonical screenshot (two-panel layout).
- `lib/bank.js`: exposed `mockTarget` per domain (blueprint targets 14/13/13/20) and extracted
  `seededShuffle`. `lib/store.js`: mock functions — `startMockExam` (blueprint-weighted assembly +
  interleave, single in-progress mock via `409 MOCK_EXAM_IN_PROGRESS` with resume id),
  `getMockExam` (navigator answered/flagged only + one question view with the learner's selection —
  **zero correctness**), `saveMockAnswer` (upsert/replace/clear + flag; `409 ATTEMPT_NOT_IN_PROGRESS`,
  `409 VERSION_MISMATCH`), `submitMockExam` (idempotent; correctness computed only at finalize;
  expiry auto-submits with unanswered scoring incorrect), `currentMockResume` (§1 resume shape);
  `missed.count` now `total - correct` (counts unanswered).
- Routes: `POST /api/mock-exams` (§2), `GET /api/mock-exams/:id` (§11), `POST .../answers` (§12),
  `POST .../submit` (§13); dashboard route now returns `resume` for an in-progress mock.
- UI: mock screen at `/mock/[id]` — two-panel parity with `mock_exam_desktop` (Question Overview
  legend + 60-cell navigator with answered/flagged/current states, red countdown timer chip that
  fills red under 5 min, Mark for Review, Previous/Next, Submit Exam with inline confirmation
  showing the unanswered count, client auto-submit at 0); `/mock` start/resume entry; results
  relocated to `/results/[attemptId]` and made kind-aware (Mock Exam Results + Retake Mock vs Drill
  Results + New Drill); Shell nav/tabs "Mock Exam" enabled; dashboard action switches to
  "Resume mock exam (n/60 answered)" when one is in progress.
- Verified: web build clean; **drill smoke (slice 1) ALL PASS** — no regression; **mock smoke
  33/33 ALL PASS** including blueprint weighting 14/13/13/20, leak scans (`correctOption` /
  `explanation` / `isCorrect` / `sourceRefs` absent from §2/§11/§12 payloads), save/replace/clear,
  flag/unflag, navigator state, results pre-submit `409 ATTEMPT_NOT_COMPLETED`, idempotent
  resubmit, save-after-submit `409`, dashboard resume lifecycle; 4 headless screenshots
  (mock desktop/mobile, mock results desktop/mobile) inspected against the canonical prototype.
- Moved this handoff `active/` → `done/`.
- Architect blocker fix (amended into the same commit): submitting a 100% blank mock made
  `GET /api/dashboard` return 500 — `learnerAttemptStats` skipped unanswered slots (empty rollup)
  and the coach nudge dereferenced `weakest.name` with `weakest === null`. Fixes: (1) submitted
  attempts now rate **every** slot into the per-domain rollup (unanswered mock questions count as
  incorrect, matching submit scoring); (2) dashboard falls back deterministically when no weakest
  domain can be rated (warm-up recommendation + neutral nudge); (3) committed regression smoke
  `web/scripts/smoke-blank-mock.mjs` (start → blank submit → results 0/60/60-missed → dashboard
  200 with rated domains); (4) stale slice-1 comment fixed in the results route. Re-verified on a
  fresh server: drill, mock, and blank-mock smokes ALL PASS (an earlier 3-failure run was
  order-dependence of the first-run assertions, not a regression).

## Final report

- Status: **DONE**; awaiting human gate for push.
- Local commit: `feat: implement #11 slice 2 deterministic mock exam flow` (unpushed — resolve the
  current SHA with `git log --oneline origin/main..HEAD`).
- Validation result: root `npm test` 68/68; `node bin/cli.js validate` 60/0; `git diff --check`
  clean; `agent-refresh` ok; web build clean; drill + mock smokes ALL PASS.
- Push/CI status: **not pushed** — pending human gate.
- Remaining risks/follow-ups:
  - `/practice/results/*` was relocated to `/results/*` (kind-aware); no external consumers exist,
    but flag it in review.
  - Mock exam has no dedicated mobile prototype export; the bottom-sheet navigator follows the
    screen map's mobile guidance.
  - In-memory state still resets per process (persistence slice 4); expiry auto-submit is lazy
    (evaluated on access) plus client-side timer submit — a background sweeper belongs to the
    persistence slice.
  - Next slice (3): review missed + deterministic coach panel (§14 + §4 deterministic mode).
