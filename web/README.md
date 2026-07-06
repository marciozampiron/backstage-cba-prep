# CBA Web — Slices 1–4b of the CBA Web MVP (#39, #40, #41, #42, #43 / #11)

Minimal Next.js app implementing the CBA Web MVP learner loop end to end, deterministically:

1. **Drill loop** (#39) — dashboard → practice setup → one question at a time → immediate grounded
   feedback (explanation + official source) → mini-results.
2. **Mock exam** (#40) — 60 questions / 90 minutes, blueprint-weighted, navigator + flagging,
   silent answer saves, idempotent submit with expiry auto-submit.
3. **Review missed + deterministic coach** (#41) — grounded review of every missed item, coach
   with action-scoped deterministic answers, onlyMissed drills.
4. **Persistence boundary** (#42) — repository port with a restart-safe local JSON-file adapter;
   attempts survive restarts.
5. **Learner identity + auth boundary** (#43) — request-derived learner through the
   `CBA_WEB_AUTH=dev|cognito` port, per-learner state isolation, ownership enforcement
   (`403 NOT_RESOURCE_OWNER`).

## Run

```bash
cd web
npm install
npm run dev     # http://localhost:3000
```

Self-contained on purpose: not a root npm workspace; the root CLI, tests, and CI are untouched.

## Identity / auth

Routes resolve the learner through the identity boundary in `lib/identity.js`
(`CBA_WEB_AUTH=dev|cognito`, default `dev`) and pass the `learnerId` into the store — nothing
hardcodes a learner, and cross-learner access returns `403 NOT_RESOURCE_OWNER`.

Dev-mode resolution order:

1. `x-cba-learner: <token>` header — tools/smokes and multi-learner testing;
2. `cba_learner=<token>` cookie — per-browser identity when you want it;
3. deterministic `dev-learner` — the simple local default (no auth configured).

`CBA_WEB_AUTH=cognito` is a deliberate seam: the Cognito adapter (ADR-0002) implements
`resolveLearner` against the API-Gateway-validated session without touching routes, store, records,
or the frontend. Note: data written before this slice used the old stub learner id and will not
appear under the dev learner — wipe `web/.data/` if that matters.

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

| Real (slices 1–4b) | Stubbed / next |
| --- | --- |
| Contract shapes from `docs/product/web-bff-contracts.md` (§1–§4, §7–§14), incl. error envelope, `INSUFFICIENT_QUESTIONS` / `VERSION_MISMATCH` / `ALREADY_ANSWERED` / `MOCK_EXAM_IN_PROGRESS` / `ATTEMPT_NOT_IN_PROGRESS` / `ATTEMPT_NOT_COMPLETED` / `NOT_RESOURCE_OWNER` semantics | Real Cognito adapter — next: implements `resolveLearner` against the API-Gateway-validated session (ADR-0002); the `dev\|cognito` boundary already exists, so it lands without touching routes, store, records, or frontend |
| Content — `questions/*.json` + `spec/blueprint.json` through the #16 JSON-bank migration mapping (published `QuestionVersion`s, `legacyExternalId`, source registry) | Managed persistence — DynamoDB (ADR-0002) replaces the local JSON-file adapter behind the same repository port |
| Drill loop with deterministic scoring, per-domain rollups, grounded feedback from the published item (never AI) | Coach grounded AI mode (Phase 3, #12) — swaps in behind the §4 `mode` field, no frontend change |
| Mock exam: blueprint-weighted assembly, exam-mode rule (zero correctness pre-submit), flagging/navigator, idempotent submit, expiry auto-submit | Admin/authoring surfaces (Phase 4) and the advanced progress screen (§15 trends/ProgressSnapshot) |
| Review missed (§14, grounded, paged) + deterministic coach (§4, action-scoped) + onlyMissed drills | Learner-facing `/api/me` (§16) + sign-in surface — arrive with the Cognito slice |
| Persistence: repository port + restart-safe JSON-file adapter (atomic write-through) | — |
| Identity/auth boundary: request-derived learner (header → cookie → deterministic dev default), per-learner state, ownership `403`s, per-learner mock rule | — |
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
