# Task: #39 UI parity pass — align slice 1 with the Stitch prototype

## Owner

- Agent: Claude (executor)
- Human gate: required before push

## Source of truth

- GitHub issue: #39 (OPEN — functional slice pushed as `bee5869`; do not close until parity approved)
- Canonical prototype: `docs/product/prototypes/stitch-cba-study-coach/` (`manifest.json`)
- Screens studied: learner_dashboard_(desktop|mobile), practice_setup_desktop,
  practice_session_(desktop|mobile), result_explanation_desktop, mock_results_desktop

## Context

Codex validated the pushed drill loop as functional but not at Stitch parity. This pass restyles the
four surfaces to the prototype's structure without touching BFF contract logic or scope.

## Do

- `web/**` only: app shell (sidebar 260px desktop / navy topbar + bottom tabs mobile), dashboard
  (stat tiles, domain readiness with status colors, recommended actions, recent activity),
  practice setup (Configure Your Session card, segmented difficulty/count, practice-mode cards,
  weak-areas-style toggle, Start Practice →), session focus mode (header with progress + elapsed
  timer + close, competency chip, option rows, visual-only confidence selector, sticky submit),
  feedback as the result-explanation layout (verdict, recolored options, explanation card, source
  chip, next panel), mini-results with score ring + domain breakdown + focus-area card.
- Fix the Next.js workspace-root warning (`outputFileTracingRoot`/`turbopack.root`).
- Out-of-slice surfaces render disabled with a "Soon" marker (no fake AI/mock/review).

## Do not

- No BFF contract/logic changes; browser keeps talking only to `app/api` routes.
- Never expose `correctOption` pre-submit (confidence selector stays client-side only).
- No AI/Bedrock/Strands/auth/DB/mock exam; no root CLI/bank changes.
- No push without human approval; root `.gitignore` and the EVENTS.md local audit untouched.

## Validation

- `npm run agent-refresh`; root `npm test`; `node bin/cli.js validate`; `git diff --check`
- `web`: `npm run build`; runtime smoke of the full drill loop; screenshots (desktop + mobile) if a
  local browser is available

## Work log

- Assumed by Claude (executor). Boot ok; origin/main at `bee5869` (#39 pushed, issue open).
  Studied the 7 canonical prototype screenshots listed above.
- Rebuilt the UI to prototype structure, `web/**` only, zero BFF/contract changes:
  - `components/Shell.js` + `components/icons.js` — 260px sidebar (logo, active-item left bar,
    Soon-tagged disabled items), top tab bar with avatar; mobile navy topbar + bottom tabs.
  - Dashboard — Overview h1, 4 stat tiles (readiness/target/drills/exam-format — all
    contract-derivable, no invented API fields), Domain Readiness card with status-colored
    percentages/bars, Recommended Actions (primary navy row + Soon rows), Recent Activity.
  - Practice Setup — "Configure Your Session" card, two-column segmented difficulty/count,
    practice-mode cards (Review Mode active; Timed Mode disabled/Soon), switch-style
    "only missed" toggle, right-aligned "Start Practice →".
  - Session — focus mode: sticky header (brand, session chip, progress bar, elapsed timer, close),
    competency chip, radio option rows, visual-only confidence selector (client-side, not sent —
    contract §10 unchanged), sticky footer submit.
  - Feedback — result_explanation parity: verdict icon+heading, options recolored with "Correct
    Answer"/"Your Answer" tags, Explanation card with source-reference chip, coach teaser (marked
    Soon, no fake input), "Ready to move on?" panel.
  - Results — score ring (SVG), readiness pill, "Recommended Study Plan" focus-area card, colored
    Domain Breakdown, "Start Targeted Practice"/"New Drill" header actions.
  - `next.config.mjs` — `outputFileTracingRoot`/`turbopack.root` anchored at the repo root
    (workspace-root warning gone) + `devIndicators: false`.
- Verified: `npm run build` clean; E2E smoke **33/33 PASS** (contracts untouched); **11 headless
  Chrome screenshots** captured (desktop 1440px + mobile 390px: dashboard first-run/returning,
  setup, session, results) and visually inspected against the canonical prototype; a mobile
  session-header wrap issue found in the shots was fixed and re-captured.
- Moved this handoff `active/` → `done/`.

## Final report

- Status: **DONE**; awaiting Codex parity review + human gate for push. #39 stays open until the
  architect approves product-readiness against Stitch.
- Local commit: `feat: align #39 drill loop UI with Stitch prototype` (unpushed — resolve the
  current SHA with `git log --oneline origin/main..HEAD`).
- Validation result: root `npm test` 68/68; `node bin/cli.js validate` 60 valid / 0 errors;
  `git diff --check` clean; `agent-refresh` ok; web build clean; smoke 33/33.
- Push/CI status: **not pushed** — pending human gate.
- Remaining risks/follow-ups:
  - Confidence selector is visual-only by design (no contract field); wire it up only if a future
    contract pass adds it (mock results use confidence-vs-correctness — mock slice decision).
  - Disabled "Soon" surfaces (Mock/Review/Coach/Progress/Settings/Timed Mode) are deliberate scope
    honesty; they become live links as their slices land.
  - Screenshots live in the session scratchpad (not committed); architect should also eyeball
    `npm run dev` locally.
