# Task: #51 Implement monorepo GitHub Actions quality lanes

## Owner

- Agent: Claude (executor)
- Human gate: required before push

## Source of truth

- GitHub issue: #51 (part of #48)
- Design: `docs/architecture/ci-cd-security-foundation.md`; `docs/adr/0003-monorepo-github-actions-and-aws-cdk.md`
- Current CI: `.github/workflows/quality.yml` (root), CodeQL default setup

## Context

First CI/CD foundation increment: path-scoped quality lanes for the monorepo, no deploy, no AI
spend. Root Quality stays the CLI/core lane; a new Web Quality lane covers `web/**` with install,
build, and the committed deterministic smokes on `CBA_WEB_STORE=memory`.

## Do

- Keep `.github/workflows/quality.yml` as the root lane (already least-privilege, Node 20/22,
  no-spend) — no behavioral change.
- Add `.github/workflows/web-quality.yml`: path-filtered on `web/**`, `contents: read` only,
  Node 22, `npm ci` + `npm run build` + deterministic smokes (shared memory-store server:
  blank-mock, review-coach, identity; then the self-orchestrating restart-persistence smoke).
- Document the implemented check names + branch-protection notes in
  `docs/architecture/ci-cd-security-foundation.md` (deliverable of the issue).
- Verify locally the exact CI smoke sequence (shared server, this order) before committing.

## Do not

- No AWS deploy, no OIDC roles yet (#52/#54), no live AI/model calls, no Bedrock/Strands invocation.
- No product changes outside the pipeline; root `.gitignore` and the EVENTS.md local audit untouched.
- No push without explicit human approval.

## Validation

- `npm run agent-refresh`; `npm test`; `npm run validate`; `npm run stats`; `git diff --check`
- `cd web && npm run build`; local run of the CI smoke sequence

## Work log

- Assumed by Claude (executor). Boot ok (AGENTS/README/CURRENT/COMMANDS re-read; ADR-0003 + CI/CD
  foundation doc read); main synced at `d68951d`; no active handoffs.
- Root lane decision: `.github/workflows/quality.yml` kept **unchanged** — it already satisfies the
  foundation design (least-privilege `contents: read`, Node 20/22 matrix, no-spend; runs tests,
  validate, stats, pack and source audit). `git diff --check` from the doc's list is a
  local/pre-commit check (meaningless on a clean CI checkout) — deliberate omission.
- New `.github/workflows/web-quality.yml`: path-filtered on `web/**` (+ the workflow file), Node 22,
  `contents: read` only, `npm ci` → `npm run build` → deterministic smokes on a shared
  `CBA_WEB_STORE=memory` server (blank-mock → review-coach → identity, all order-safe) → the
  self-orchestrating restart-persistence smoke. Zero paid AI/model calls.
- `docs/architecture/ci-cd-security-foundation.md`: added "Implemented Quality Lanes (#51)" — the
  exact check names for branch protection (`Quality / quality (20|22)`, `Web Quality / web-quality`,
  CodeQL), the path-filter required-check caveat for #52 (no-op twin or root-only requirement), and
  the note that full drill/mock smokes need per-smoke server isolation (follow-up).
- Verified locally the EXACT CI sequence: build → shared memory server → blank-mock ALL PASS →
  review-coach ALL PASS → identity ALL PASS → restart-persistence ALL PASS. Workflow YAML parsed
  valid (pyyaml).
- Moved this handoff `active/` → `done/`.
- Architect finding (amended into the same commit): the web lane's path filter missed the app's
  runtime data dependencies — `web/lib/bank.js` loads `questions/*.json` and `spec/blueprint.json`
  at runtime, so bank/blueprint changes could break the simulator without triggering the lane.
  Added `questions/**` and `spec/blueprint.json` to both PR and push path filters (with an
  explanatory comment) and updated the lanes table in the foundation doc accordingly.

## Final report

- Status: **DONE**; awaiting human gate for push.
- Local commit: `ci: implement monorepo quality lanes for #51` (unpushed — resolve the current SHA
  with `git log --oneline origin/main..HEAD`).
- Validation result: `agent-refresh` ok; `npm test` 68/68; `npm run validate` 60/0; `npm run stats`
  60/60 budgeted; `git diff --check` clean; web build clean; CI smoke sequence 4/4 ALL PASS locally.
- Push/CI status: **not pushed** — pending human gate. First real proof of the web lane happens on
  the push of this very commit (it touches `.github/workflows/web-quality.yml`, which is in its own
  path filter).
- Remaining risks/follow-ups:
  - Branch protection itself is #52 (this task only names the checks); the path-filter caveat is
    documented for it.
  - Full drill/mock smokes (first-run assertions) need per-smoke fresh servers before joining CI.
  - Dependabot moderate vulnerability flagged during the architecture-docs push remains a separate
    security/dependency follow-up (noted in EVENTS.md).
  - Docs/infra lanes arrive with their tracks (#53 CDK synth; docs link-check when tooling lands).
