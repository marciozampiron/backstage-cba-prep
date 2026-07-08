# Current Agent Coordination State

Last updated: 2026-07-08
Updated by: Claude

This file is the fast boot context for agents entering the repository. GitHub Issues and the
Project board remain the source of truth; this file summarizes local coordination state.

## Current baseline

- `origin/main` is the published baseline. Use `git rev-parse --short origin/main` or `git log -1 --oneline origin/main` for the exact current SHA. Do not pin a specific origin/main SHA here — it goes stale on every push.
- Local `main` should match `origin/main` (no unpublished commits). Run `git log --oneline origin/main..HEAD` to confirm; do not rely on `CURRENT.md` for mutable unpublished commit SHAs.
- #34 architecture diagrams are the accepted AWS roadmap diagram version unless a new handoff explicitly reopens them.
- Do not rework architecture diagrams from older commits such as `06f1141`; that context is stale.

## Active priority

- Delivered and closed with CI green: Phase 1 design (#37/#34/#35/#36/#16/#15/#38), the #11 Web MVP
  slices 1–4b (#39/#40/#41/#42/#43), the adaptive AI study strategy spec, and the #48/#49 CI/security
  foundation (#51 quality lanes, #52 GitHub/OIDC baseline, #54 AWS bootstrap+IAM/OIDC model, #53 CDK
  scaffold). `main` should be in sync with `origin/main` (ahead 0).
- Three CI lanes are live and proven: `Quality` (Node 20+22), `Web Quality` (path-filtered
  `web/**`/`questions/**`/`spec/blueprint.json`), `Infra Synth` (path-filtered `infra/aws/**`,
  credential-free `cdk synth`), all no-spend + least-privilege, plus CodeQL.
- `web/` = self-contained Next.js MVP (slices 1–4b) with smokes under `web/scripts/`.
  `infra/aws/` = CDK v2 app (JS/CommonJS) — security stack encodes the #54 OIDC/Bedrock model +
  5 placeholder stacks; synth-only, no deploy.
- Next (architect steer): apply GitHub branch protection (`github-security-and-oidc-baseline.md` §1,
  Option A/B). Then the #54 bootstrap runbook (operator creates the Bedrock role + sets
  `AWS_BEDROCK_REFRESH_ROLE_ARN`), #47/#49 AWS env foundation, #46 deploy lanes; product-side: real
  Cognito adapter + `/api/me` (§16) + sign-in, §15 progress screen.
- Housekeeping open: the moderate Dependabot `postcss` advisory in `/web` awaits a dependency PR.
  (Duplicate issue #45 is closed as a duplicate of #42.)
- Tooling lesson (2026-07-08): verify CI-matrix (Node 20+22) compatibility for tooling changes —
  `node --test` glob-pattern paths need Node >=21; root test uses a shell-expanded `test/*.test.js`.

## Do not touch without explicit assignment

- CBA question facts or explanations without official Backstage/LF source evidence.
- Architecture diagrams already accepted for #34.
- Provider/runtime boundaries delivered by #23/#27/#29/#30/#31 unless the task explicitly targets them.
- `docs/product/` contracts/data-model/scope docs and the canonical Stitch prototype
  (`docs/product/prototypes/stitch-cba-study-coach/`) — amend only via an assigned task.
- `web/` BFF-shaped contracts and exam-mode rules (no correctness pre-submit; deterministic-only
  coach) delivered by #39–#43.
- CI/security foundation and the AWS IAM/OIDC model: `.github/workflows/*`, `infra/aws/**`, and the
  `docs/architecture/{ci-cd-security-foundation,github-security-and-oidc-baseline,aws-bootstrap-and-oidc,aws-iac-foundation}.md`
  docs — change only via an assigned #48/#49-track task. Never introduce long-lived AWS keys; AWS
  access is GitHub OIDC role assumption only.

## Required behavior

- Run `npm run agent-refresh` before editing, before commit, before push, after git-state changes, and every 5 minutes during long-running work.
- Check `.agent-handoff/active/` before starting work.
- Record any delegated task in `inbox/`, `active/`, or `done/`.
- Update `CURRENT.md` and append to `EVENTS.md` after meaningful state changes.
- Never push without explicit human approval.
