# Task: #36 Web BFF contracts (CBA SaaS pilot)

## Owner

- Agent: Claude (executor)
- Human gate: required before push

## Source of truth

- GitHub issue: #36 (part of #33; related to #16)
- Project/phase: Phase 1 — CBA Web MVP (BFF boundary design)
- Related ADR/spec/docs: `docs/adr/0002-cloudflare-nextjs-aws-bff.md`;
  `docs/product/frontend-screen-map.md`; `docs/product/ai-design-brief.md`;
  `docs/product/prototypes/stitch-cba-study-coach/manifest.json`; `spec/product-roadmap.md`

## Context

#35 delivered the learner prototype. #36 documents the first Web BFF endpoint contracts so the
frontend and the AWS boundary evolve against the same design-time spec. Docs only — no backend,
no Next.js, no auth implementation.

## Do

- `docs/product/web-bff-contracts.md` — conventions + the six initial endpoints
  (`GET /api/dashboard`, `POST /api/mock-exams`, `GET /api/attempts/:id/results`,
  `POST /api/coach/message`, `GET /api/admin/questions/review`, `POST /api/admin/domains`),
  each with UX goal, request/response sketch, auth expectation, delegated core use case,
  pilot-only vs generic-future fields, error shape, and no-spend/dry-run expectation where AI is involved.
- State explicitly that the browser never reaches AI Orchestration directly.
- Map the contracts to the #16 model: Exam, Domain, Competency, Source, Question, Attempt, Learner.
- Link the contracts from `docs/product/frontend-screen-map.md`.

## Do not

- Do not implement Next.js, APIs, real auth, databases, or AI orchestration.
- Do not expose Bedrock/Strands/ModelProvider/AgentRunRepository (or model IDs/tiers/tokens) in the
  public contract.
- Do not touch the question bank.
- Do not push without explicit human approval.
- Do not change unrelated files (`.gitignore`, the `.agent-handoff/EVENTS.md` local audit).

## Files likely involved

- `docs/product/web-bff-contracts.md` (new)
- `docs/product/frontend-screen-map.md` (link)
- `.agent-handoff/done/36-web-bff-contracts.md` (this file; created under `active/`, moved here at finish)

## Validation

- `npm run agent-refresh`
- `git diff --check`
- `npm test`

## Work log

- Assumed by Claude (executor). Boot: `agent-refresh` ok; main synced with origin/main; pre-existing
  local `EVENTS.md` audit and `.gitignore` change left untouched and out of scope.
- Wrote `docs/product/web-bff-contracts.md`: boundary rules (browser → BFF only; no
  Bedrock/Strands/ports/model-tier exposure), conventions (auth, pagination, error envelope + HTTP
  map, no-spend/dry-run semantics with `mode: grounded|deterministic`), the #16 entity mapping
  (Exam/Domain/Competency/Source/Question/Attempt/Learner), and the six initial endpoint contracts,
  each with UX goal, request/response sketch, auth, delegated core use case, pilot-vs-generic notes,
  and errors. Deferred endpoints listed explicitly.
- Linked the contracts from `docs/product/frontend-screen-map.md` (header pointer).
- Moved this handoff `active/` → `done/`.

## Final report

- Status: **DONE**; awaiting human gate for push.
- Local commit: `docs: define Web BFF contracts for #36` (unpushed — resolve the current SHA with
  `git log --oneline origin/main..HEAD`; do not hardcode an amendable local SHA).
- Files: `docs/product/web-bff-contracts.md` (new), `docs/product/frontend-screen-map.md` (link),
  this handoff.
- Validation result: `agent-refresh` ok; `git diff --check` clean; `npm test` 68/68.
- Push/CI status: **not pushed** — pending human gate (Codex remains architect/gate).
- Remaining risks/follow-ups:
  - Contracts are design-time sketches; field names may shift when the BFF is implemented — regenerate
    against these docs, and consider OpenAPI once shapes stabilize.
  - Session/answer/submit flow for mock exams and the practice/missed/progress endpoints are
    deliberately deferred to a later contract pass (listed in the doc).
  - Pre-existing local `EVENTS.md` audit and `.gitignore` change remain uncommitted, out of this scope.
