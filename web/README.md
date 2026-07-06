# CBA Web — Slice 1: Deterministic Drill Loop (#39 / #11)

Minimal Next.js app implementing the first vertical slice of the CBA Web MVP: dashboard (first-run)
→ practice setup → one question at a time → immediate grounded feedback (explanation + official
source) → mini-results.

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
| Contract shapes from `docs/product/web-bff-contracts.md` (§1, §3, §7–§10), incl. error envelope and `INSUFFICIENT_QUESTIONS` / `VERSION_MISMATCH` / `ALREADY_ANSWERED` semantics | Auth — fixed stub learner (`learner-stub`); Cognito arrives with the persistence slice |
| Content — `questions/*.json` + `spec/blueprint.json` loaded through the #16 JSON-bank migration mapping (published `QuestionVersion`s, `legacyExternalId`, source registry) | Persistence — sessions/attempts are in-memory per process |
| Deterministic scoring, per-domain rollups, grounded feedback from the published item (never AI) | Mock exam, review missed, progress, coach AI mode, admin |
| Design tokens from the versioned Stitch design system (Academic Precision) | — |

The browser talks **only** to the BFF-shaped routes under `app/api/**` (ADR-0002 boundary). The
stub implements the contracts in-process; pointing the frontend at the real AWS Web BFF later is a
base-URL change, not a rewrite.

## Layout

- `lib/bank.js` — Exam Content adapter: blueprint + bank → domains/competencies/published versions.
- `lib/store.js` — Simulation adapter: drill sessions, answers (idempotent), deterministic results.
- `lib/api.js` — contract error envelope.
- `app/api/**` — BFF stub routes (§1 dashboard, §7 options, §8 start, §9 next, §10 answers, §3 results).
- `app/**` — screens: dashboard, practice setup, session, mini-results.
