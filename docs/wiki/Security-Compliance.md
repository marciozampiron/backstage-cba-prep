# Security and Compliance

## Security Posture

The project should be safe by default for local agents, future SaaS operators, and learners.

## Secrets

Never commit:

- API keys;
- AWS credentials;
- GitHub tokens;
- account-specific secrets;
- production environment files.

Use local environment variables and deployment secrets.

## AWS

- Local AWS profiles are developer-only.
- Production should use IAM roles or managed identity patterns.
- Bedrock model IDs and regions are configuration.
- Live smoke tests must be explicit because they can spend tokens.
- CI must remain mock-first and no-spend.

## AI Usage

Capture provider-neutral usage metadata where possible:

- provider;
- model;
- tier;
- input tokens;
- output tokens;
- stop reason.

This supports future cost controls, learner plan limits, and auditability.

## Multi-Tenant Future

Before SaaS launch, define controls for:

- tenant isolation;
- user identity;
- attempt privacy;
- content visibility by tenant;
- audit logs;
- deletion/export policies.

## Compliance Rule

Trust and auditability come before automation speed. If a workflow cannot prove source, review state, and ownership, it should not publish learner-facing content.
