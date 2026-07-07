# AWS IaC Foundation

This document captures the AWS infrastructure-as-code posture for #49. It defines the pilot direction before any real AWS resources are created.

## Tooling Decision

Use **AWS CDK v2** for AWS infrastructure.

Author CDK under:

```text
infra/aws/
```

Language decision (#53): **plain JavaScript (CommonJS, the CDK JS template style)** rather than
TypeScript — zero build step (no tsc/tsconfig), consistent with the repo's JavaScript idiom, per
the "avoid unnecessary complexity" guidance. Revisit if constructs grow enough to want types.

CDK generates CloudFormation templates. Generated CloudFormation is the deployment substrate; hand-authored CloudFormation is not the primary authoring model.

Terraform is deferred unless the project needs one IaC state to govern both Cloudflare resources and AWS resources.

## Why CDK for the Pilot

- AWS is the backend/control-plane home per ADR 0002.
- The team already uses the Node/JavaScript ecosystem.
- CDK makes IAM, Cognito, API Gateway, Lambda/App Runner, DynamoDB, S3, EventBridge/SQS, Step Functions, KMS, Secrets Manager, CloudWatch, and Bedrock permissions easier to model than raw YAML.
- CloudFormation state is AWS-managed, avoiding early remote-state design.
- `cdk synth` gives a no-deploy validation path for CI.
- CDK constructs can encode enterprise defaults as the platform grows.

## Stack Boundaries

Start with explicit stacks. Keep them boring and separately understandable.

```text
infra/aws/
  bin/
    cba-pilot.ts
  lib/
    identity-stack.ts
    data-stack.ts
    api-stack.ts
    ai-orchestration-stack.ts
    observability-stack.ts
    security-stack.ts
```

### Identity Stack

Owns:

- Cognito user pool/client/domain if used;
- callback/logout URLs;
- future mapping from Cognito subject to learner identity;
- outputs consumed by frontend config and BFF.

### Data Stack

Owns:

- DynamoDB tables for attempts, sessions, learners, progress snapshots, review state, and agent runs when promoted from file/local adapters;
- point-in-time recovery posture;
- encryption defaults;
- table naming/tags.

### API Stack

Owns:

- API Gateway or App Runner/Lambda entrypoints;
- Web BFF routing;
- CORS and security headers;
- auth integration;
- health/readiness endpoints.

### AI Orchestration Stack

Owns:

- IAM permissions for Bedrock model invocation;
- internal service role boundaries;
- Secrets Manager/SSM references for provider configuration;
- no public browser reachability;
- future queues/events for async authoring or coach flows.

### Observability Stack

Owns:

- CloudWatch log groups;
- alarms and dashboards;
- cost/billing signals where practical;
- structured log retention rules.

### Security Stack

Owns cross-cutting IAM/KMS/secrets policies only when they are truly shared. Prefer resource-local policies where possible to avoid a central security stack becoming a dependency knot.

## Environment Model

Pilot environments:

```text
dev       manual or ephemeral validation
staging   protected integration environment
prod      manual-gated production pilot
```

Naming convention:

```text
cba-study-coach-<env>-<resource>
```

Required tags:

```text
Project=CBAStudyCoach
Environment=<dev|staging|prod>
ManagedBy=CDK
Owner=<team-or-human-owner>
CostCenter=pilot
```

## CI/CD Rules

Pull requests:

- run `cdk synth`;
- run static checks;
- never deploy by default;
- run `cdk diff` only when environment credentials are available and approved.

Main/staging:

- deploy only through GitHub environment protection;
- use GitHub OIDC to assume AWS roles;
- run post-deploy smoke with `BASE_URL`.

Production:

- manual approval;
- explicit version/tag;
- rollback plan documented before deploy.

## Security Rules

The concrete AWS bootstrap and IAM/OIDC model — the GitHub OIDC provider and the blueprint-refresh
Bedrock role with copy-pasteable trust/permission policy JSON and a runbook — is in
[`aws-bootstrap-and-oidc.md`](aws-bootstrap-and-oidc.md) (#54). The CDK security-stack encodes those
artifacts.

- No long-lived AWS keys in GitHub secrets.
- Use GitHub OIDC + IAM role assumption.
- Least-privilege roles by environment.
- Bedrock permissions are isolated from the Web BFF unless a specific use case requires them.
- Browser-facing code never receives provider/model secrets.
- Secrets live in AWS Secrets Manager/SSM or GitHub Environments depending on deployment-time vs runtime ownership.

## Cloudflare Boundary

Cloudflare remains the frontend hosting boundary from ADR 0002.

For the pilot:

- frontend deploy can be handled by GitHub Actions and Cloudflare integration;
- Cloudflare DNS/WAF/Pages IaC is not required before AWS foundation is proven;
- if Cloudflare resources need strict IaC governance, open a follow-up issue to evaluate Terraform or a separate Cloudflare IaC lane.

## Deliverables for #49

- CDK app skeleton under `infra/aws/`.
- No-deploy `cdk synth` workflow.
- Environment/naming/tagging conventions.
- IAM/OIDC role model.
- Stack boundary doc and generated template inspection.
- Explicit non-goals: no production deploy, no paid AI smoke, no database migration until the persistence adapter is selected.
