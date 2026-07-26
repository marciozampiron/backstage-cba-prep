# Security and Compliance

## Security Posture

The project should be safe by default for local agents, future SaaS operators, and learners.
Security is designed and evidenced continuously; a final review confirms controls rather than
introducing them after implementation.

Canonical sources:

- mandatory rules: `spec/security-rules.md`;
- threat model, data classes, control catalog, roles, and gates:
  `docs/architecture/security-assurance-baseline.md`;
- learner-coach and authoring-agent security:
  `docs/architecture/ai-agent-security-model.md`;
- GitHub/OIDC and secret posture:
  `docs/architecture/github-security-and-oidc-baseline.md`.

The roadmap track is #84. #90 owns API throttling and cost-abuse enforcement required by the
web-pilot gate before #70; agentic controls separately gate live #58/#59/#60 behavior.

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

Agentic coach and authoring runs must be auditable through `AgentRunRepository` / `AIUsageEvent` and
authorized by a deterministic UsageBudget/rate-limit policy before any live model invocation. See
`spec/ai-adaptive-study-strategy.md`.

Models, retrieved content, model output, and tool arguments are untrusted. Provider guardrails are
supplemental: deterministic authorization, purpose-specific tool allowlists, strict schemas,
learner/tenant/certification isolation, bounded execution, output validation, and human review
remain application responsibilities.

The learner coach is read-only and cannot change score, mastery, canonical recommendations, or
content. The authoring agent creates drafts asynchronously and cannot approve or publish them.

## Roles and Gates

- The human product/security owner accepts risk and authorizes push, deploy, spend, and release.
- Codex acts as architect/security reviewer and Project/issue owner.
- Claude acts as implementation executor and supplies tests/evidence.
- A separate reviewer reproduces security evidence; the executor does not self-approve.
- The human cloud operator performs credentialed AWS/Cloudflare mutations.
- A human educator owns final content approval.

One person may hold several human roles during the pilot, but decision records keep them distinct.
No AI agent or service principal accepts risk, serves as a human gate, or approves or publishes
AI-generated questions, including content produced by a different agent or run.

## Multi-Tenant Future

Before SaaS launch, define controls for:

- tenant isolation;
- user identity;
- attempt privacy;
- content visibility by tenant;
- audit logs;
- deletion/export policies.

## Compliance Rule

Trust and auditability come before automation speed. If a workflow cannot prove source, review
state, and ownership, it should not publish learner-facing content.

This internal baseline is not a claim of external certification or legal compliance. Regulatory and
contractual requirements must be assessed separately before commercial launch.
