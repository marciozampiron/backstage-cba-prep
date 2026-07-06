# Task: #39 Implement #11 slice 1 — deterministic drill loop

## Owner

- Agent: Claude (executor)
- Human gate: required before push

## Source of truth

- GitHub issue: #39 (slice 1 of #11; part of #33; scope per #15)
- Contracts: `docs/product/web-bff-contracts.md` §1, §7–§10 (+ minimal §3 for mini-results)
- Screens: `docs/product/frontend-screen-map.md`; prototype `docs/product/prototypes/stitch-cba-study-coach/`
- Model: `docs/product/saas-data-model.md` (entities + JSON bank migration mapping)
- Runtime: `docs/adr/0002-cloudflare-nextjs-aws-bff.md`

## Context

First implementation slice of the CBA Web MVP: dashboard (first-run) → practice setup → one question
at a time → immediate grounded feedback → mini-results. Deterministic only; learner stub; in-memory
adapters; BFF stubbed in-app with the exact contracted shapes so the frontend speaks the contract.

## Do

- `web/` — self-contained minimal Next.js app (own package.json/lockfile; root untouched):
  screens (dashboard first-run, practice setup, session, mini-results), BFF stub route handlers
  (§1, §7–§10, minimal §3), in-memory bank/session adapters loading `questions/*.json` +
  `spec/blueprint.json` through the #16 migration mapping.
- `web/.gitignore` for `node_modules`/`.next` (do NOT touch the root `.gitignore`).
- Verify end to end (build + run + curl the drill loop) before committing.

## Do not

- No real auth, mock exam, progress/coach surfaces, AI, Bedrock/Strands, database, deployment.
- Do not modify the CLI engine, question bank, root package.json, or product docs.
- Do not expose `correctOption` in any pre-answer payload.
- Do not push without explicit human approval.
- Do not change unrelated files (root `.gitignore`, the `.agent-handoff/EVENTS.md` local audit).

## Files likely involved

- `web/**` (new)
- `.agent-handoff/active/39-drill-loop-slice1.md` (this file; moves to `done/` when finished)

## Validation

- `npm run agent-refresh`; `git diff --check`; root `npm test` (must stay green/untouched)
- `web/`: `npm install`, `npm run build`, runtime smoke of the full drill loop via the API routes

## Work log

- Assumed by Claude (executor). Boot ok; main synced at `5f03c85`. Opened issue #39. Recon:
  `spec/blueprint.json` (domains/weights/competencies), bank shape (`questions/*.json` +
  `schema.json`) confirmed.
- Built `web/` (20 tracked files): hand-rolled minimal Next.js 16 (React 19), plain JS matching repo
  idiom, self-contained (own package.json/lockfile, NOT a root workspace; root untouched).
  - `lib/bank.js` — Exam Content adapter applying the #16 JSON-bank migration mapping (published
    `QuestionVersion`s with `legacyExternalId`, source registry, loud failure on unknown
    domain/competency names).
  - `lib/store.js` — in-memory Simulation adapter (drill start with filters + `onlyMissed`,
    idempotent answers, deterministic scoring/rollups); `lib/api.js` — contract error envelope.
  - `app/api/**` — BFF stub routes with the exact contracted shapes: §1 dashboard (first-run aware),
    §7 options, §8 start (`INSUFFICIENT_QUESTIONS`), §9 next (never exposes `correctOption`),
    §10 answers (`VERSION_MISMATCH`, `ALREADY_ANSWERED`, safe retry), minimal §3 results.
  - Screens: dashboard first-run, practice setup, question session (immediate grounded feedback +
    source chip), mini-results — Academic Precision tokens from the versioned design system; the
    browser talks only to the BFF routes (ADR-0002 boundary).
- E2E verified against `next start`: **33/33 smoke checks PASS** — full drill loop (first-run →
  options → 5 answers with explanation + backstage.io source → results → returning-state dashboard
  with computed readiness), plus all contract error semantics.
- Moved this handoff `active/` → `done/`.

## Final report

- Status: **DONE**; awaiting human/architect review + gate for push.
- Local commit: `feat: implement #11 slice 1 deterministic drill loop` (unpushed — resolve the
  current SHA with `git log --oneline origin/main..HEAD`; do not hardcode an amendable local SHA).
- Files: `web/**` (20 files incl. lockfile), this handoff.
- Validation result: root `npm test` 68/68 (untouched); `git diff --check` clean; `agent-refresh`
  ok; `web`: `npm run build` clean; E2E smoke 33/33 PASS.
- Push/CI status: **not pushed** — pending human gate (Codex remains architect/gate).
- Remaining risks/follow-ups:
  - In-memory state resets per process (documented); persistence slice replaces `lib/store.js`
    behind the same shapes.
  - JS chosen to match repo idiom — flag for architect: decide JS vs TS before the app grows.
  - Root CI does not build `web/` (self-contained by design); consider a web build job when the app
    stabilizes. CodeQL will scan the new JS on push.
  - Language of UI copy follows the prototype (English); revisit i18n post-MVP.
