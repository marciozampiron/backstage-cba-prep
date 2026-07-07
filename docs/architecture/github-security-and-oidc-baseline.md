# GitHub Security Baseline and AWS OIDC Roles

This document defines the repository's GitHub security baseline and the AWS OIDC role model for
#52 (part of #48; related to #49/#54). It is the **GitHub-side contract**: it says which checks
protect `main`, how workflows are permissioned, which GitHub Environments gate deploys, and which
AWS roles each workflow may assume and under what trust conditions.

Scope boundary:

- **This doc (#52)** owns the GitHub governance surface and the OIDC role *catalog + trust
  conditions* that AWS must satisfy.
- **#54** implements the AWS-side IAM/OIDC provider and role policies against this catalog.
- **#49** materializes those roles in the CDK app (`infra/aws/`).
- **#48** (`ci-cd-security-foundation.md`) is the higher-level CI/CD posture; this doc is its
  security detail. **#51** already implemented the quality lanes referenced below.

Nothing here is applied automatically. Branch protection, Environments, OIDC providers, and roles
are created by a human or a follow-up implementation task — not by this documentation change.

## 1. Branch protection for `main`

Protect `main` with:

- require a pull request before merge (at least 1 approving review);
- dismiss stale approvals when critical files change (see the critical-files list in
  `ci-cd-security-foundation.md`);
- require status checks to pass before merge (list below);
- require branches to be up to date before merge;
- require conversation resolution;
- restrict who can push directly (maintainers only; agents never push directly — they go through
  the human gate documented in `.agent-handoff/`);
- do not allow force pushes or deletions.

### Required status checks

Use the exact check names GitHub reports (from #51's lanes):

| Check | Workflow | Always runs? | Required |
| --- | --- | --- | --- |
| `Quality / quality (20)` | `quality.yml` | yes (every PR/push) | **yes** |
| `Quality / quality (22)` | `quality.yml` | yes | **yes** |
| `CodeQL` | CodeQL default setup | yes (push/schedule) | **yes** |
| `Web Quality / web-quality` | `web-quality.yml` | **no — path-filtered** | see caveat |

### Web Quality required-check strategy (path-filter caveat)

`web-quality.yml` triggers only on `web/**`, `questions/**`, `spec/blueprint.json`, and its own
file. GitHub treats a required check that **does not run** as pending, which would deadlock any PR
that does not touch those paths. Two safe options — pick one when branch protection is actually
enabled:

- **Option A (simplest, recommended first):** require only `Quality / quality (20|22)` and
  `CodeQL`. Web Quality stays a strong signal on web PRs but is not a merge blocker. Lowest risk,
  zero workflow change.
- **Option B (Web Quality as a hard gate):** refactor the lane to **always run** and gate the
  expensive steps by an internal path check (e.g. a `dorny/paths-filter` step), so the
  `Web Quality / web-quality` status always posts success/skip and can be marked required without
  deadlocking non-web PRs. This is a follow-up implementation task, not part of #52.

Do **not** mark the current path-filtered `Web Quality` as required as-is.

## 2. GitHub Actions permissions model

Default every workflow to least privilege at the top level:

```yaml
permissions:
  contents: read
```

Elevate **only** the specific scope a job needs, preferably at the job level:

| Scope | When | Example workflow |
| --- | --- | --- |
| `contents: read` | default for all lanes | `quality.yml`, `web-quality.yml` |
| `id-token: write` | assume an AWS role via OIDC | `blueprint-refresh.yml`, future deploy lanes |
| `contents: write` + `pull-requests: write` | open an automated PR | `blueprint-refresh.yml` (blueprint PR) |
| `security-events: write` | upload SARIF | CodeQL (managed by default setup) |
| `pull-requests: write` | comment on PRs intentionally | future review-comment lanes only |

Rules:

- Never use the org/repo-wide "read and write" default token grant; declare `permissions:`
  explicitly in every workflow.
- Prefer job-scoped `permissions:` over workflow-scoped when a workflow has mixed-privilege jobs.
  (`blueprint-refresh.yml` is single-job, so workflow-level is equivalent today; split to job-level
  if it ever gains a second job.)
- No workflow triggered by `pull_request_target` without an explicit, reviewed reason (it runs with
  repo secrets against untrusted PR code).

## 3. GitHub Environments

Use GitHub Environments as the gate for anything that assumes a deploy/spend role.

| Environment | Purpose | Protection rules |
| --- | --- | --- |
| `dev` | manual/ephemeral validation | optional; no required reviewers |
| `staging` | protected integration | required reviewers; branch restricted to `main` |
| `prod` | manual-gated production pilot | required reviewers; wait timer optional; branch restricted to `main`/tags |
| `ai-batch` | manual token-spending jobs (e.g. blueprint refresh) | required reviewer + the workflow's own `confirm_ai_spend` input |

Environment-scoped secrets/vars (deploy role ARNs, per-env config) live on the Environment, not the
repo, so a role is only assumable from a run that passed that environment's gate. The OIDC trust
policy then scopes by `environment:<name>` (see §4).

## 4. AWS OIDC role model

### Principle

No long-lived AWS keys anywhere. GitHub Actions authenticates to AWS through the GitHub OIDC
identity provider and assumes short-lived IAM roles. Never store `AWS_ACCESS_KEY_ID` /
`AWS_SECRET_ACCESS_KEY` / long-lived deploy keys in GitHub secrets.

### Trust boundary anatomy

Each role's trust policy federates the GitHub OIDC provider and constrains the token claims:

- `aud` (audience) = `sts.amazonaws.com`;
- `sub` (subject) scoped to this repository and the narrowest ref/environment that needs it, e.g.
  - branch-scoped: `repo:marciozampiron/backstage-cba-prep:ref:refs/heads/main`
  - environment-scoped: `repo:marciozampiron/backstage-cba-prep:environment:staging`
  - PR-scoped (read-only jobs only): `repo:marciozampiron/backstage-cba-prep:pull_request`

Scope every role to a **single** purpose and the **least** AWS actions/resources it needs. Prefer
environment-scoped subjects for anything that deploys or spends.

### Role catalog

| Logical role | GitHub reference | Assumed by | Trust subject | AWS permissions (least privilege) | Status |
| --- | --- | --- | --- | --- | --- |
| Bedrock blueprint refresh | secret `AWS_BEDROCK_REFRESH_ROLE_ARN` | `blueprint-refresh.yml` (manual, `main`) | `ref:refs/heads/main` (tighten to `environment:ai-batch` when that env exists) | `bedrock:InvokeModel`, `bedrock:InvokeModelWithResponseStream` on the specific `BEDROCK_MODEL_STANDARD` model/inference-profile ARN, region-locked to `AWS_REGION`; nothing else | **live** (role must be created by #54) |
| CDK synth (CI) | none | infra lane (#53) | n/a | none — `cdk synth` is offline; no AWS creds | planned |
| Web/BFF deploy per env | Environment secret `AWS_DEPLOY_ROLE_ARN` | deploy lanes (#46) | `environment:<staging\|prod>` | scoped to the CloudFormation/CDK stacks and resources for that env only | planned (#54) |
| Post-deploy smoke | reuse deploy role or a read-only sibling | smoke lanes (#46/#50) | `environment:<env>` | minimal read/health perms | planned |

The blueprint-refresh role is the only one that exists as a workflow reference today. It must be:
created by #54, tightly scoped to Bedrock invoke on the standard model ARN, region-locked, and
trusted only for `main` (or the `ai-batch` environment once introduced). It must **not** carry any
data-plane, deploy, or write permissions.

### Bedrock isolation

Bedrock invoke permission is isolated from the Web BFF (ADR-0002): only the AI Orchestration
Service role and the blueprint-refresh CI role may invoke models. The browser and the BFF never hold
Bedrock permissions or model provider keys.

## 5. GitHub Actions variables and secrets registry

Classify config as **variable** (non-sensitive, may appear in logs) vs **secret** (masked, never
logged). Model IDs are configuration, not secrets (consistent with the AI strategy).

| Name | Kind | Scope | Purpose | Notes |
| --- | --- | --- | --- | --- |
| `AWS_REGION` | var | repo (or env) | region for AWS role/session and Bedrock | defaults to `us-east-1` in `blueprint-refresh.yml` |
| `BEDROCK_MODEL_STANDARD` | var | repo (or env) | `standard`-tier Bedrock model / inference-profile id | a model id, not a secret; concrete id stays in config |
| `AWS_BEDROCK_REFRESH_ROLE_ARN` | secret | repo | role the blueprint refresh assumes | ARN carries the account id; kept as a secret to avoid account-id disclosure (a var would also work) |
| `AWS_DEPLOY_ROLE_ARN` | secret | Environment | per-env deploy role | future (#54/#46); Environment-scoped so it is only assumable after the env gate |
| `ANTHROPIC_API_KEY` | secret | repo | first-party Anthropic transport | now unused by `blueprint-refresh.yml` after the Bedrock switch; remove if nothing else consumes it |
| Cloudflare API token | secret | Environment | frontend deploy | future; Environment-scoped |
| model provider keys | secret | server-side only | never frontend-visible | see §6 |

## 6. Secret hygiene and the frontend-public rule

Never commit: API keys, AWS credentials, GitHub tokens, account-specific secrets, or production env
files. Specifics for this repo:

- **MCP configs** — `.mcp.json`, `.mcp.local.json`, `.vscode/mcp.json` are gitignored (they can
  hold model/tool provider keys, e.g. the Stitch API key). Never commit an MCP config; rotate any
  key that appears in plaintext in chat/commands/files.
- **Model provider keys** (Anthropic, Bedrock access, future OpenAI/Google) — server-side only,
  behind the BFF / AI Orchestration Service. Never in frontend env, never in the client bundle.
- **Cloudflare tokens** — deploy-time only, Environment-scoped, never in the frontend.
- **AWS runtime secrets** — in AWS Secrets Manager / SSM Parameter Store (runtime ownership) or
  GitHub Environments (deploy-time ownership); never long-lived keys in GitHub repo secrets.

**Frontend-visible env vars are public.** Anything shipped to the browser (`NEXT_PUBLIC_*` or values
baked into the client bundle) must be treated as disclosed. Anything that can spend money, call a
model, read data, or mutate state belongs behind the BFF — never in a frontend variable.

## 7. Dependency and code scanning posture

- **CodeQL** — default setup enabled; runs on push to `main` and on schedule; a required check.
- **Secret scanning + push protection** — enable both; push protection blocks accidental secret
  commits at push time.
- **Dependabot** — enable alerts and security updates. Dependabot opens dependency PRs (including
  for `web/`); a Dependabot run already fires for the known **moderate `postcss` advisory in
  `/web`**, which remains an open dependency follow-up to merge on its own security cycle.
- **`npm audit`** — do **not** fail default CI on `npm audit` (advisory noise makes CI
  non-deterministic and blocks unrelated work). Use Dependabot as the mechanism and triage audit
  findings on a cadence; a manual/opt-in audit lane is acceptable.
- Keep default CI **no-spend**: no live model calls; token-spending workflows are manual + gated
  (`confirm_ai_spend`, `ai-batch` environment).

## 8. How this unblocks #48/#49/#54

- **#48** — this doc is the security half of the CI/CD foundation; combined with #51's quality
  lanes, #48's design deliverables (permissions model, OIDC plan, branch-protection checklist,
  no-spend policy) are covered.
- **#49** — the OIDC role catalog (§4) and vars/secrets registry (§5) tell the CDK app which roles,
  trust conditions, and least-privilege policies to synthesize in `infra/aws/` (security-stack /
  per-stack resource-local policies).
- **#54** — the trust-boundary anatomy (§4) is the exact contract #54 implements: create the GitHub
  OIDC provider in AWS, then the per-purpose roles with these `sub`/`aud` conditions and minimal
  permissions, starting with the blueprint-refresh Bedrock role that a workflow already references.

## Non-goals

- Not applying branch protection, Environments, OIDC providers, or roles (documentation only).
- No AWS resource creation, no deploy, no `cdk` execution.
- No live/paid AI calls; no secrets added to the repo.
- Actual role policies and the OIDC provider are #54; the CDK app is #49; deploy lanes are #46.

## Follow-up implementation tasks

- Apply the branch-protection ruleset and required checks (human or a small implementation task),
  choosing Option A or B from §1.
- Create the AWS OIDC provider + the blueprint-refresh Bedrock role (#54), then future deploy roles.
- Refactor `web-quality.yml` to always-run-with-internal-path-gate if Web Quality is to become a
  required check (Option B).
- Merge the Dependabot `postcss` advisory fix for `web/` on its security cycle.
- Remove `ANTHROPIC_API_KEY` from repo secrets if no workflow consumes it after the Bedrock switch.
