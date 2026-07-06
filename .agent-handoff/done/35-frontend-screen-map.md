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
- `docs/product/prototypes/stitch-cba-study-coach/` (Stitch export: 15 screens, 47 files, ~1.2 MB)
- `.agent-handoff/active/35-frontend-screen-map.md` (this file)

## Validation

- `git diff --check`
- `npm run agent-refresh`
- `npm test` (docs-only: at least `git diff --check` + `npm run agent-refresh`)

## Work log

- Started by Claude (executor). Pre-edit: `agent-refresh` ok; `.mcp.json` gitignored; `EVENTS.md`
  audit preserved; committed with a targeted `git add` (no `-A`) to avoid sweeping unrelated changes.
- Stitch prototype pass (executor): edited screens via the Stitch MCP to strip all non-CBA exam content
  and align to the four CBA domains (24/22/22/32), source chips (`backstage.io/docs/...`), and
  Coach/Study-Recommendation language.
- Codex (architect) validated and downloaded the clean package to
  `stitch_cba_study_coach_platform/recommended_cba_clean/` (15 screens, `manifest.json` index).
- Organization pass (executor): moved that clean package to the versioned product path
  `docs/product/prototypes/stitch-cba-study-coach/`; wired `frontend-screen-map.md` and
  `ai-design-brief.md` to its `manifest.json`. Stale screens outside the package left untracked, not
  committed.

## Final report

- Status: **DONE** (handoff moved `active/` → `done/`); awaiting human gate for push.
- Local commit: `docs: add Stitch prototype export for #35` (unpushed, amended to include this handoff
  move — resolve the current SHA with `git log --oneline origin/main..HEAD`; do not hardcode an
  amendable local SHA).
- Validations: `agent-refresh` ok; `git diff --check` clean; `npm test` 68/68.
- Push/CI: **pending human gate / not pushed**.
- Risk: the upstream Stitch project still holds duplicate/stale generations; the versioned
  `manifest.json` is the source of truth for the canonical 15 screens.
- Canonical package: `docs/product/prototypes/stitch-cba-study-coach/`.
- Files added (prototype-export commit): `docs/product/prototypes/stitch-cba-study-coach/` — 15 screens
  (desktop + mobile) each with `code.html` + `screen.png` + `metadata.json`, plus `README.md` and
  `manifest.json` (47 files, ~1.2 MB); plus doc edits to `frontend-screen-map.md`, `ai-design-brief.md`,
  and this handoff.
- Validation result: `recommended_cba_clean` had README + manifest + 15 complete screens; forbidden-term
  scan across `*.html`/`*.json`/`*.md` = **0** for AWS (uppercase), Bedrock, Strands, MCP, BFF,
  support_agent, "AI Coach", mentor, "Oct 15 2025", Business Analysis, Financial Accounting.
  `git diff --check` clean; `agent-refresh` ok; `npm test` green.
- Push/CI status: **not pushed** — awaiting human gate (Codex remains architect/gate; human authorizes push).
- Remaining risks/follow-ups:
  - Non-blocker: `study_coach_desktop/code.html` contains `awsS3` — a legitimate Backstage TechDocs
    publisher enum (`local, awsS3, googleGcs, azureBlobStorage`) from official docs, i.e. factual CBA
    content, not runtime-infra exposure. Left as-is per "do not edit factual CBA content".
  - The parent `stitch_cba_study_coach_platform/` (stale/earlier screens + duplicates from the MCP passes)
    stays untracked and is intentionally excluded from the commit; safe to delete later.
  - The upstream Stitch project still holds duplicate/stale generations; cleanup is a Stitch-UI action
    (no MCP delete tool). The versioned `manifest.json` is the source of truth for the canonical 15.
