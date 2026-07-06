# Task: #16 SaaS data model (CBA pilot → generic exam platform)

## Owner

- Agent: Claude (executor)
- Human gate: required before push

## Source of truth

- GitHub issue: #16 (Phase 1 — CBA Web MVP; feeds #33 and the Phase 5 generic engine)
- Related ADR/spec/docs: `spec/domain-driven-design.md`; `spec/product-roadmap.md`;
  `docs/product/web-bff-contracts.md` (#36); `docs/product/frontend-screen-map.md` (#35);
  `docs/adr/0002-cloudflare-nextjs-aws-bff.md`

## Context

Issues #35 (frontend prototype) and #36 (BFF contracts) are closed. #16 documents the canonical SaaS data
model those surfaces assume, grounded in the DDD bounded contexts. Docs only — no database, no API,
no persistence code.

## Do

- `docs/product/saas-data-model.md` — canonical entities (Exam, Domain, Competency, Source, Question,
  QuestionVersion, Attempt, AttemptAnswer, Learner, ProgressSnapshot), each with purpose, key fields,
  relations, pilot-vs-generic notes, and DDD ownership.
- Document the provenance chain (Source → QuestionVersion → Review → Published Question).
- Document the attempt/progress pipeline (Attempt → AttemptAnswer → Score/Readiness → ProgressSnapshot).
- Map entities to the #36 BFF endpoints (reads/writes).
- Persistence posture: no physical DB choice; DynamoDB/Postgres named as future options, no lock-in.

## Do not

- Do not implement database, API, or persistence code.
- Do not touch the question bank.
- Do not expose Bedrock/Strands/provider internals (model IDs, tiers, runs) in the public model.
- Do not push without explicit human approval.
- Do not change unrelated files (`.gitignore`, the `.agent-handoff/EVENTS.md` local audit).

## Files likely involved

- `docs/product/saas-data-model.md` (new)
- `.agent-handoff/active/16-saas-data-model.md` (this file; moves to `done/` when finished)

## Validation

- `npm run agent-refresh`
- `git diff --check`
- `npm test`

## Work log

- Assumed by Claude (executor). Boot: `agent-refresh` ok; main synced with origin/main (#36 pushed,
  CI green, issue closed); pre-existing local `EVENTS.md` audit and `.gitignore` change out of scope.
- Read `spec/domain-driven-design.md` and `spec/product-roadmap.md`; reused the #35/#36 docs already
  authored this cycle.
- Wrote `docs/product/saas-data-model.md`: modeling principles, mermaid entity overview, the ten
  canonical entities (purpose / fields / relations / pilot-vs-generic / DDD ownership), the
  provenance chain (Source → QuestionVersion → Review → Published, with drift reopening review), the
  attempt/progress pipeline (Attempt → AttemptAnswer → deterministic Score → ProgressSnapshot), the
  #36 endpoint read/write mapping, the adjacent internal entities (review, provenance, AI audit —
  explicitly excluded from public payloads), and the deliberately-undecided persistence posture
  (DynamoDB vs Postgres as future options behind repository ports, no lock-in).
- Moved this handoff `active/` → `done/`.
- Architect review pass (pre-push adjustment, amended into the same commit): promoted **ReviewTask**,
  **StudyPlan** *(deferred)*, and **Tenant/Organization** *(deferred)* to full entity sections
  (§11–§13) with purpose/fields/relations/pilot-vs-generic/ownership; added the **JSON bank migration
  mapping** (`questions/*.json` fields → `Question`/`QuestionVersion`/`Domain`/`Competency`/`Source`,
  with `legacyExternalId` traceability and the attempts-pin-versions rule); updated the ERD (ReviewTask
  solid; StudyPlan/Tenant dashed as deferred/future); reworked the adjacent-internals section
  accordingly (ReviewDecision embedded in ReviewTask; Subscription/Entitlement attach to Tenant later).

## Final report

- Status: **DONE**; awaiting human gate for push.
- Local commit: `docs: define SaaS data model for #16` (unpushed — resolve the current SHA with
  `git log --oneline origin/main..HEAD`; do not hardcode an amendable local SHA).
- Files: `docs/product/saas-data-model.md` (new), this handoff.
- Validation result: `agent-refresh` ok; `git diff --check` clean; `npm test` 68/68.
- Push/CI status: **not pushed** — pending human gate (Codex remains architect/gate).
- Remaining risks/follow-ups:
  - Optional cross-link: `web-bff-contracts.md`'s "#16 entity" table could point at the new model doc —
    left untouched to keep #16 scope exact; architect can approve as a follow-up.
  - `ProgressSnapshot` is documented as a materialized view of `LearnerCompetencyState`; if a
    finer-grained mutable state entity is introduced later, keep both consistent.
  - Physical DB decision deferred to #33 implementation (access patterns listed in the doc).
