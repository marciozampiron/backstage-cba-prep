# ADR 0003: Monorepo Pilot, GitHub Actions, and AWS CDK

## Status

Accepted for the pilot. Revisit after the CBA Web MVP has real deployment, operating data, and a stable BFF contract.

## Context

The project now has a functional CBA Web MVP path and is moving toward delivery foundation work:

- #48 defines CI/CD and security foundation.
- #49 defines AWS IaC foundation.
- #50 defines release, smoke, and rollback process.
- ADR 0002 already decided the runtime split: Cloudflare-hosted Next.js frontend, AWS-hosted BFF/backend/AI control plane.

The team discussed whether to split frontend and backend repositories immediately, and whether infrastructure should use Terraform, raw CloudFormation, or AWS CDK.

The pilot needs enterprise direction without paying the coordination cost of a multi-repo, multi-state platform before the product boundaries are stable.

## Decision

For the pilot:

1. Keep a **single repository**.
2. Split **delivery boundaries**, not repositories.
3. Use **GitHub Actions** as the CI/CD orchestrator.
4. Use **AWS CDK v2** for AWS infrastructure as code.
5. Treat **CloudFormation as the generated AWS deployment substrate**, not as hand-authored infrastructure.
6. Defer **Terraform** unless the project needs one IaC state covering both Cloudflare resources and AWS resources.

Target repository shape:

```text
repo
  web/                 Next.js frontend
  src/ + bin/          CLI / engine / shared core
  services/bff/        future AWS Web BFF
  services/ai/         future AI Orchestration Service
  infra/aws/           future AWS CDK app
  docs/                contracts, ADRs, architecture, product decisions
```

GitHub Actions should run independent lanes by path:

```text
web/**                 -> web build + web smokes
src/**, bin/**         -> CLI/core tests + no-spend AI checks
services/**            -> backend tests + contract tests
infra/aws/**           -> CDK synth/diff + IaC security checks
docs/**                -> docs/link/contract consistency where useful
main/release           -> gated deploy readiness + post-deploy smoke
```

## Why not split repositories now

Repository split is a release and governance tool, not an architecture prerequisite.

Keep the monorepo while:

- the BFF contract is still evolving;
- frontend and BFF slices are being shaped together;
- the same agent/human workflow owns roadmap, contracts, and implementation;
- shared CBA engine behavior still lives close to CLI and web surfaces;
- the team benefits from atomic commits across docs, contracts, and code.

Split repositories later when at least one of these becomes true:

- frontend and backend need independent release cadence;
- backend/IaC needs tighter permissions than frontend contributors should have;
- BFF contracts are stable enough to publish as versioned artifacts;
- Cloudflare and AWS operations need separate teams or approval paths;
- CI time or repository permissions become a bottleneck.

Potential future split:

```text
cba-study-coach-web
cba-study-coach-platform
cba-study-coach-infra
cba-study-coach-contracts
```

## Why GitHub Actions

- It is already the repository's CI surface.
- It integrates naturally with Issues, branch protection, CodeQL, Dependabot, and release gates.
- It supports path-scoped workflows for the monorepo pilot.
- It supports OpenID Connect federation to AWS without long-lived AWS keys.
- It keeps agent/human governance close to commits and issues.

## Why AWS CDK v2 for AWS IaC

Use AWS CDK v2 for AWS-side infrastructure because:

- the backend/control plane is AWS-native per ADR 0002;
- CDK maps well to Cognito, API Gateway, Lambda/App Runner, DynamoDB, S3, EventBridge/SQS, Step Functions, IAM, KMS, Secrets Manager, CloudWatch, and Bedrock permissions;
- the project already uses JavaScript/Node, so CDK in TypeScript is a low-friction path;
- CloudFormation state is managed by AWS, avoiding early Terraform backend/state governance;
- generated CloudFormation templates remain inspectable through `cdk synth`;
- constructs let the project encode enterprise defaults without hand-writing large YAML templates.

Raw CloudFormation is not the primary authoring tool because it is verbose and slower to refactor.

Terraform remains a valid future option if the platform needs one IaC state that manages both Cloudflare resources and AWS resources. Until then, Cloudflare deployment can be handled through GitHub Actions / Cloudflare integration, while AWS infrastructure is managed by CDK.

## Consequences

Positive:

- lower coordination cost during the pilot;
- clear deployment boundaries without premature repository split;
- AWS infrastructure can be tested with `cdk synth` before any deploy;
- CI can enforce no-spend defaults and contract checks before cloud work;
- future split criteria are explicit.

Tradeoffs:

- one repository still contains frontend, contracts, future backend, and future infra;
- CDK does not manage Cloudflare resources unless custom integration is added;
- a later repository split will require contract/version discipline;
- Terraform may still be needed later if Cloudflare DNS/WAF/Pages infrastructure must be governed in the same IaC model as AWS.

## Required Follow-up Issues

- #48: define the GitHub Actions CI/CD and security foundation.
- #49: define AWS CDK IaC foundation and stack boundaries.
- #50: define release, smoke, and rollback process.
- #47: define the AWS pilot environment foundation.
