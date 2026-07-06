# CBA Web — Slices 1–4a of the CBA Web MVP (#39, #40, #41, #42 / #11)

Minimal Next.js app implementing the CBA Web MVP learner loop end to end, deterministically:

1. **Drill loop** (#39) — dashboard → practice setup → one question at a time → immediate grounded
   feedback (explanation + official source) → mini-results.
2. **Mock exam** (#40) — 60 questions / 90 minutes, blueprint-weighted, navigator + flagging,
   silent answer saves, idempotent submit with expiry auto-submit.
3. **Review missed + deterministic coach** (#41) — grounded review of every missed item, coach
   with action-scoped deterministic answers, onlyMissed drills.
4. **Persistence boundary** (#42) — repository port with a restart-safe local JSON-file adapter;
   attempts survive restarts.

## Run

```bash
cd web
npm install
npm run dev     # http://localhost:3000
```

Self-contained on purpose: not a root npm workspace; the root CLI, tests, and CI are untouched.

## Persistence

State lives behind the repository port in `lib/repository.js`:

- `CBA_WEB_STORE=file` (default) — JSON file at `CBA_WEB_DATA_DIR`/`simulation.json`
  (default `web/.data/`, gitignored). Atomic write-through; attempts survive restarts.
- `CBA_WEB_STORE=memory` — ephemeral per process. The deterministic smokes assume a fresh state,
  so run their server this way (or point `CBA_WEB_DATA_DIR` at a throwaway dir).

Records are plain JSON, learner-scoped (`learnerId`) — swapping in DynamoDB (ADR-0002) or adding
Cognito identity is an adapter/caller change, not a rewrite. Regression:
`node scripts/smoke-restart-persistence.mjs` boots the server twice on a temp data dir and asserts
attempts survive.

## What is real vs stubbed

| Real (slices 1–4a) | Stubbed / next |
| --- | --- |
| Contract shapes from `docs/product/web-bff-contracts.md` (§1–§4, §7–§14), incl. error envelope, `INSUFFICIENT_QUESTIONS` / `VERSION_MISMATCH` / `ALREADY_ANSWERED` / `MOCK_EXAM_IN_PROGRESS` / `ATTEMPT_NOT_IN_PROGRESS` / `ATTEMPT_NOT_COMPLETED` semantics | Auth — fixed stub learner (`learner-stub`); Cognito identity is the next slice (records already carry `learnerId`) |
| Content — `questions/*.json` + `spec/blueprint.json` through the #16 JSON-bank migration mapping (published `QuestionVersion`s, `legacyExternalId`, source registry) | Managed persistence — DynamoDB (ADR-0002) replaces the local JSON-file adapter behind the same repository port |
| Drill loop with deterministic scoring, per-domain rollups, grounded feedback from the published item (never AI) | Coach grounded AI mode (Phase 3, #12) — swaps in behind the §4 `mode` field, no frontend change |
| Mock exam: blueprint-weighted assembly, exam-mode rule (zero correctness pre-submit), flagging/navigator, idempotent submit, expiry auto-submit | Admin/authoring surfaces (Phase 4) and the advanced progress screen (§15 trends/ProgressSnapshot) |
| Review missed (§14, grounded, paged) + deterministic coach (§4, action-scoped) + onlyMissed drills | — |
| Persistence: repository port + restart-safe JSON-file adapter (atomic write-through) | — |
| Design tokens from the versioned Stitch design system (Academic Precision) | — |

The browser talks **only** to the BFF-shaped routes under `app/api/**` (ADR-0002 boundary). The
stub implements the contracts in-process; pointing the frontend at the real AWS Web BFF later is a
base-URL change, not a rewrite.

## Layout

- `lib/bank.js` — Exam Content adapter: blueprint + bank → domains/competencies/published versions.
- `lib/repository.js` — persistence boundary (port + adapters): in-memory (ephemeral) and JSON-file
  (restart-safe, atomic write-through). Only `lib/store.js` imports it — never routes or pages.
- `lib/store.js` — Simulation application layer: drills, mock exams, missed review, deterministic
  coach; all state behind the repository port, written through on every mutation.
- `lib/api.js` — contract error envelope.
- `app/api/**` — BFF stub routes (§1 dashboard, §2 mock start, §3 results, §7 options, §8 start,
  §9 next, §10 answers, §11 mock get, §12 mock answers, §13 mock submit).
- `app/**` — screens: dashboard, practice setup, drill session, mock exam (navigator + timer),
  results (kind-aware).
