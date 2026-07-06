# Task: #15 CBA Web MVP scope (consolidation)

## Owner

- Agent: Claude (executor)
- Human gate: required before push

## Source of truth

- GitHub issue: #15 (Phase 1 — CBA Web MVP)
- Related ADR/spec/docs: `spec/product-roadmap.md`; `docs/adr/0002-cloudflare-nextjs-aws-bff.md`;
  `docs/product/frontend-screen-map.md` (#35); `docs/product/web-bff-contracts.md` (#36);
  `docs/product/saas-data-model.md` (#16); `docs/product/prototypes/stitch-cba-study-coach/`

## Context

Issues #35 (screens + prototype), #36 (BFF contracts), and #16 (data model) are closed. #15 predates
them and asked for the MVP definition those artifacts now largely satisfy. This task consolidates the
CBA Web MVP scope into one document that ties flows → screens → endpoints → entities → Phase 0 CLI
concepts, resolves scope tensions (study plan, coach, persistence), and defines success metrics.

## Do

- `docs/product/cba-web-mvp-scope.md` — MVP goal + learner loop; in-scope flows with the
  screen/endpoint/entity/CLI-concept mapping; non-goals; explicit scope decisions; success metrics
  (completed attempts, returning learners, weak-domain improvement); build order; #15 acceptance
  criteria checklist.

## Do not

- Do not implement anything (docs only).
- Do not widen scope: no billing, no multi-cert ingestion, no autonomous publishing, no free-form AI
  chat (issue #15 non-goals).
- Do not touch the question bank.
- Do not push without explicit human approval.
- Do not change unrelated files (`.gitignore`, the `.agent-handoff/EVENTS.md` local audit).

## Files likely involved

- `docs/product/cba-web-mvp-scope.md` (new)
- `.agent-handoff/active/15-cba-web-mvp-scope.md` (this file; moves to `done/` when finished)

## Validation

- `npm run agent-refresh`
- `git diff --check`
- `npm test`

## Work log

- Assumed by Claude (executor). Boot: `agent-refresh` ok; main synced at `5b026b3` (#16 pushed, CI
  green, issue closed); pre-existing local `EVENTS.md` audit and `.gitignore` change out of scope.
- Read issue #15 body (product intent, scope, non-goals, acceptance criteria, agent guidance).
- Wrote `docs/product/cba-web-mvp-scope.md`: the learner loop to prove; the flow → screen (#35) →
  endpoint (#36) → entity (#16) → Phase 0 CLI concept mapping table; five explicit scope decisions
  (study plan = deterministic guidance, coach deterministic-first/zero-spend, per-learner attempts
  from day one with minimal Cognito auth, admin surfaces out, content = migrated bank); reaffirmed
  non-goals; success metrics with definitions + initial targets (activation, completed attempts,
  returning learners, weak-domain improvement, time-to-first-question, mock-completion guardrail);
  four thin build slices for #11; #15 acceptance-criteria status table (all three met).
- Moved this handoff `active/` → `done/`.

## Final report

- Status: **DONE**; awaiting human gate for push.
- Local commit: `docs: consolidate CBA Web MVP scope for #15` (unpushed — resolve the current SHA
  with `git log --oneline origin/main..HEAD`; do not hardcode an amendable local SHA).
- Files: `docs/product/cba-web-mvp-scope.md` (new), this handoff.
- Validation result: `agent-refresh` ok; `git diff --check` clean; `npm test` 68/68.
- Push/CI status: **not pushed** — pending human gate (Codex remains architect/gate).
- Remaining risks/follow-ups:
  - The **second BFF contract pass** (practice sessions, answers/submit, missed review, progress,
    preferences) is the prerequisite for build slices 1/3 — next design task before/with #11.
  - Metric targets are initial hypotheses; recalibrate after the first cohort (definitions are the
    deliverable).
  - Closing #15 should reference this doc plus #35/#36/#16 as the artifacts that satisfy its
    acceptance criteria.
