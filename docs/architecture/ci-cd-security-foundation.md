# CI/CD and Security Foundation

This document captures the pilot delivery posture for #48. It should be implemented incrementally through GitHub Actions without deploying paid cloud resources by default.

## Decision Summary

- Keep the pilot in a monorepo.
- Use GitHub Actions as the CI/CD orchestrator.
- Split workflows by delivery boundary and path filters.
- Use GitHub environments for gated deploys.
- Use GitHub OIDC for AWS access; do not store long-lived AWS keys.
- Keep paid AI/model calls out of default CI.
- Treat frontend, BFF, AI orchestration, and IaC as separate deploy lanes even while they live in one repository.

See ADR 0003 for the repo/tooling decision.

## Repository Boundaries

```text
web/                 Next.js learner/admin frontend
src/ + bin/          CLI, shared engine, AI orchestration ports/adapters
services/bff/        future AWS Web BFF
services/ai/         future AWS AI Orchestration Service
infra/aws/           future AWS CDK app
docs/                contracts, architecture, ADRs, product decisions
```

## Workflow Lanes

### Pull Request

PR workflows should be no-spend and safe to run from ordinary branches.

Required checks:

- root quality:
  - `npm ci`
  - `npm test`
  - `npm run validate`
  - `npm run stats`
  - `git diff --check`
- web quality when `web/**` changes:
  - `cd web && npm ci`
  - `cd web && npm run build`
  - deterministic web smokes with `CBA_WEB_STORE=memory`
- docs/contracts when `docs/**` changes:
  - markdown/link checks when available;
  - contract consistency checks when contract schemas exist.
- infra when `infra/aws/**` changes:
  - install CDK app dependencies;
  - `cdk synth`;
  - `cdk diff` only when credentials/environment are explicitly available;
  - static checks before any deploy.

### Main Branch

Main should run all required checks and publish build artifacts where useful.

Main may deploy to a dev/staging environment only after:

- PR checks are green;
- branch protection passed;
- environment gate allows the deploy;
- no pending human approval rule is bypassed.

### Release / Production

Production deployment is manual-gated.

Required inputs:

- release version or tag;
- target environment;
- approved commit SHA;
- post-deploy smoke plan;
- rollback plan.

## Security Baseline

### GitHub Permissions

Workflows should default to least privilege:

```yaml
permissions:
  contents: read
```

Elevate per job only when required:

- `id-token: write` for AWS OIDC role assumption;
- `security-events: write` for CodeQL/SARIF upload;
- `pull-requests: write` only for workflows that intentionally comment on PRs.

### AWS Authentication

Use GitHub OIDC and AWS IAM roles.

Do not store:

- `AWS_ACCESS_KEY_ID`;
- `AWS_SECRET_ACCESS_KEY`;
- long-lived deploy keys;
- model provider keys in frontend-visible variables.

Role trust policy should scope by:

- repository;
- branch or environment;
- workflow/ref when practical.

### Secrets and Config

Secrets belong in GitHub Environments or AWS Secrets Manager/SSM Parameter Store, depending on runtime ownership.

Frontend variables must be treated as public unless proven otherwise. Anything that can spend money, call Bedrock, access data, or mutate state belongs behind the BFF.

### AI Spend Guardrail

Default CI must not call paid models.

Allowed by default:

- `agent-check --json`;
- `bedrock-check --json`;
- deterministic web smokes;
- mocked provider tests.

Disallowed by default:

- live Bedrock/Anthropic/OpenAI generation;
- Strands live tool execution;
- authoring jobs that spend tokens.

Live AI smoke requires an explicit manual workflow input and environment approval.

## Implemented Quality Lanes (#51)

Implemented workflow lanes and the check names branch protection should require:

| Lane | Workflow file | Check name(s) | Trigger | Spend |
| --- | --- | --- | --- | --- |
| Root quality (CLI/core/bank) | `.github/workflows/quality.yml` | `Quality / quality (20)`, `Quality / quality (22)` | every PR + push to `main` | none |
| Web quality (`web/**` + runtime data) | `.github/workflows/web-quality.yml` | `Web Quality / web-quality` | PR + push to `main`, path-filtered on `web/**`, `questions/**`, `spec/blueprint.json`, and the workflow file (the web app loads the bank/blueprint at runtime via `web/lib/bank.js`) | none |
| Code scanning | GitHub CodeQL default setup | `CodeQL` | push to `main` (+ scheduled) | none |

Web lane content: `npm ci` → `npm run build` → deterministic smokes against a shared
`CBA_WEB_STORE=memory` server (blank-mock, review-coach, identity — all order-safe) → the
self-orchestrating restart-persistence smoke (file store in a temp dir). All lanes run with
`permissions: contents: read` and make no paid AI/model calls.

Required-check caveat: a path-filtered workflow that does not run reports no status, which blocks a
PR that requires it. When enabling branch protection (#52), either require only the root lanes plus
CodeQL, or add a no-op twin for `Web Quality` on non-web PRs. Note that the full drill/mock flow
smokes assert first-run state and need a dedicated fresh server per smoke — wiring them into CI is a
follow-up (per-smoke server isolation), not part of the shared-server set.

## Branch Protection

Protect `main` with:

- required PR review before merge;
- required Quality workflow;
- CodeQL/security checks;
- no direct pushes except explicitly authorized maintainers;
- linear history or squash policy if the team chooses one;
- stale approvals dismissed when critical files change.

Critical files:

- `.github/workflows/**`;
- `infra/**`;
- `services/**`;
- `web/app/api/**`;
- `src/domain/**`;
- `src/application/**`;
- `docs/adr/**`;
- `docs/product/web-bff-contracts.md`.

## Web Smoke Strategy

Web smokes should run against:

- local `next start` with `CBA_WEB_STORE=memory`;
- later, a deployed `BASE_URL` after staging deploy.

Default smoke set:

- drill loop;
- mock exam;
- review missed + deterministic coach;
- learner identity isolation;
- persistence restart smoke where file storage is relevant.

Post-deploy smoke must verify:

- health/readiness endpoint;
- dashboard loads;
- no correctness leaks before mock submit;
- deterministic coach mode works without model spend;
- source links are present in review/feedback.

## Deliverables for #48

- Path-scoped GitHub Actions design.
- Security permissions model.
- OIDC/AWS role-assumption plan.
- Branch protection checklist.
- No-spend AI check policy.
- Web smoke policy.
- Follow-up implementation issues for actual workflow files.
