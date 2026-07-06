# Task: #35 Frontend Prototype design package (screen map + AI design brief)

## Owner

- Agent: Claude (executor)
- Human gate: required before push

## Source of truth

- GitHub issue: #35 (part of #33; related to #11)
- Project/phase: Phase 1 — CBA Web MVP (frontend prototype)
- Related ADR/spec/docs: `docs/adr/0002-cloudflare-nextjs-aws-bff.md`; `spec/product-roadmap.md`;
  `docs/wiki/AI-Agent-Strategy.md`; `docs/architecture/diagrams/`

## Context

Produce a versionable design package so a UI-generation tool (Google Stitch, connected via the
gitignored `.mcp.json`) can generate the first learner prototype screens. No real frontend/backend yet.

## Do

- `docs/product/frontend-screen-map.md` — screen inventory (primary user goal per screen), navigation,
  first-run flow, mobile behavior, extensibility.
- `docs/product/ai-design-brief.md` — the Stitch UI-generation brief (design system, tone, per-screen prompts).
- (optional) `docs/product/ux-flows.md` if flows grow large.

## Do not

- Do not build the real frontend, backend/BFF, or touch AI orchestration.
- Do not surface Bedrock/Strands/AI orchestration in the learner UI.
- Do not push without explicit human approval.
- Do not change unrelated files (`.mcp.json`, the `.agent-handoff/EVENTS.md` audit, `.gitignore`,
  the `stitch_*` output dir).

## Files likely involved

- `docs/product/frontend-screen-map.md`
- `docs/product/ai-design-brief.md`
- `.agent-handoff/active/35-frontend-screen-map.md` (this file)

## Validation

- `git diff --check`
- `npm run agent-refresh`
- `npm test` (docs-only: at least `git diff --check` + `npm run agent-refresh`)

## Work log

- Started by Claude (executor). Pre-edit: `agent-refresh` ok; `.mcp.json` gitignored; `EVENTS.md`
  audit preserved; committed with a targeted `git add` (no `-A`) to avoid sweeping unrelated changes.

## Final report

- Commit SHA: (unpublished; inspect with `git log --oneline origin/main..HEAD`)
- Validation result:
- Push/CI status: not pushed
- Remaining risks/follow-ups:
