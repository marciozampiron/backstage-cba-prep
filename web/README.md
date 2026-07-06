# CBA Web — Slices 1–2: Drill Loop + Mock Exam (#39, #40 / #11)

Minimal Next.js app implementing the first vertical slices of the CBA Web MVP: the drill loop
(dashboard → practice setup → one question at a time → immediate grounded feedback → mini-results)
and the deterministic mock exam (60 questions / 90 minutes, navigator, flagging, silent answer
saves, idempotent submit with expiry auto-submit, results).

## Run

```bash
cd web
npm install
npm run dev     # http://localhost:3000
```

Self-contained on purpose: not a root npm workspace; the root CLI, tests, and CI are untouched.

## What is real vs stubbed

| Real | Stubbed (later slices) |
| --- | --- |
| Contract shapes from `docs/product/web-bff-contracts.md` (§1–§3, §7–§13), incl. error envelope, `INSUFFICIENT_QUESTIONS` / `VERSION_MISMATCH` / `ALREADY_ANSWERED` / `MOCK_EXAM_IN_PROGRESS` / `ATTEMPT_NOT_IN_PROGRESS` / `ATTEMPT_NOT_COMPLETED` semantics | Auth — fixed stub learner (`learner-stub`); Cognito arrives with the persistence slice |
| Content — `questions/*.json` + `spec/blueprint.json` loaded through the #16 JSON-bank migration mapping (published `QuestionVersion`s, `legacyExternalId`, source registry) | Persistence — sessions/attempts are in-memory per process |
| Deterministic scoring, per-domain rollups, grounded feedback from the published item (never AI) | Review missed, progress screen, coach AI mode, admin |
| Mock exam: blueprint-weighted assembly (per-domain targets), exam-mode rule (zero correctness pre-submit), flagging/navigator, idempotent submit, expiry auto-submit | — |
| Design tokens from the versioned Stitch design system (Academic Precision) | — |

The browser talks **only** to the BFF-shaped routes under `app/api/**` (ADR-0002 boundary). The
stub implements the contracts in-process; pointing the frontend at the real AWS Web BFF later is a
base-URL change, not a rewrite.

## Layout

- `lib/bank.js` — Exam Content adapter: blueprint + bank → domains/competencies/published versions.
- `lib/store.js` — Simulation adapter: drill sessions + mock exams, answers, deterministic results.
- `lib/api.js` — contract error envelope.
- `app/api/**` — BFF stub routes (§1 dashboard, §2 mock start, §3 results, §7 options, §8 start,
  §9 next, §10 answers, §11 mock get, §12 mock answers, §13 mock submit).
- `app/**` — screens: dashboard, practice setup, drill session, mock exam (navigator + timer),
  results (kind-aware).
