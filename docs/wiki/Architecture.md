# Architecture

## Architecture Posture

Use pragmatic Domain-Driven Design. Keep the domain stable, provider-neutral, and testable. Add ports before introducing infrastructure dependencies.

## Layering

```text
interfaces
  CLI, future web/API, GitHub/Wiki integration

application
  use cases and ports
  ModelProvider, AgentOrchestrator, ToolRegistry

domain
  exam content rules, simulation, review, provenance, AI usage shape

infrastructure
  file system, AWS Bedrock, Anthropic, OpenAI, Google, Strands, future DB
```

## Dependency Rule

Dependencies point inward:

```text
interfaces -> application -> domain
infrastructure -> application/domain contracts
domain -> no infrastructure
```

Domain and application modules must not import:

- AWS SDK;
- Strands;
- provider SDKs;
- database clients;
- CLI UI helpers;
- web framework code.

## Current Bounded Contexts

- Exam Content: domains, competencies, question validation.
- Simulation: attempts, scoring, study plan inputs.
- Authoring Review: review ledger, human verification, flagged content.
- Source Provenance: source links, hashes, stale detection.
- AI Orchestration: provider-neutral usage and domain-safe errors.

## Provider Boundary

Model providers and agent frameworks are infrastructure adapters behind application-owned ports. The domain never knows whether a request used Anthropic, Bedrock, Strands, OpenAI, or Google.

## Runtime Split (pilot)

For the SaaS pilot, the learner/admin frontend (Next.js) is hosted at the Cloudflare edge, while the Web BFF, core services, and a separate AI Orchestration Service run on AWS. The browser reaches only the BFF; the AI Orchestration Service (Bedrock/Strands, `AgentRunRepository`) is never called directly from the browser. This is a reversible, pilot-scoped runtime choice — see `docs/adr/0002-cloudflare-nextjs-aws-bff.md`. The concrete environment progression (`local -> dev -> pilot`), runtime path, and configuration registry are fixed by `docs/architecture/pilot-environment-contract.md` (#47).

## Delivery and IaC

For the pilot, keep one repository and split delivery lanes by boundary (`web/`, `services/`, `infra/aws/`, `src/`, `docs/`). GitHub Actions is the CI/CD orchestrator. AWS infrastructure is authored with AWS CDK v2, with CloudFormation as the generated deployment substrate. See `docs/adr/0003-monorepo-github-actions-and-aws-cdk.md`, `docs/architecture/ci-cd-security-foundation.md`, and `docs/architecture/aws-iac-foundation.md`.

## Operational Observability

CloudWatch operational telemetry is a pilot release prerequisite, not product analytics. Workload
stacks own sanitized structured logs and explicit retention; the ObservabilityStack owns alarms,
dashboard, saved investigation queries, and operator notifications. No tokens, learner identity,
exam content, bodies, physical resource ids, or secrets may enter logs. The pilot uses native
metrics plus transport-level structured logs; OTEL/Application Signals is a separate,
auto-instrumentation-first evolution rather than a domain dependency. See
`docs/architecture/aws-observability-baseline.md` and
`docs/architecture/diagrams/out/operational_observability.png` (#82); #70 must enforce its
structural and post-smoke health gates before pilot promotion.

## Canonical Reference

Detailed guidance lives in `spec/domain-driven-design.md`.
