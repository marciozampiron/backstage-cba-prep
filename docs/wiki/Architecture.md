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

For the SaaS pilot, the learner/admin frontend (Next.js) is hosted at the Cloudflare edge, while the Web BFF, core services, and a separate AI Orchestration Service run on AWS. The browser reaches only the BFF; the AI Orchestration Service (Bedrock/Strands, `AgentRunRepository`) is never called directly from the browser. This is a reversible, pilot-scoped runtime choice — see `docs/adr/0002-cloudflare-nextjs-aws-bff.md`.

## Canonical Reference

Detailed guidance lives in `spec/domain-driven-design.md`.
