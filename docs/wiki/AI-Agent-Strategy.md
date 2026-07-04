# AI and Agent Strategy

## Strategic Direction

The product should be agentic inside and study-focused outside.

Learners should experience:

- targeted practice;
- clear explanations;
- next-drill recommendations;
- study plans;
- progress insight.

Internal/admin workflows may use agents for:

- source extraction;
- blueprint extraction;
- question drafting;
- review assistance;
- provenance checks;
- operational automation.

## Provider Model

Application code depends on provider-neutral ports:

- `ModelProvider`: single model invocation.
- `AgentOrchestrator`: model plus tool loop.
- `ToolRegistry`: provider-neutral tool definitions.

Infrastructure adapters implement those ports:

- Anthropic Messages API over HTTP.
- AWS Bedrock Converse through AWS SDK v3.
- Strands agent orchestration behind `AgentOrchestrator`.
- Future OpenAI/Google adapters as needed.

## Model Routing

Use tier names at application boundaries:

- `fast`: high-volume learner assistance and cheap coaching.
- `standard`: generation, blueprint extraction, default authoring.
- `critical`: semantic verification and low-volume high-risk checks.

Concrete model IDs belong in configuration, not in the domain.

## Non-Negotiable AI Rules

- AI-generated questions are drafts until human reviewed.
- AI must not validate CBA facts from AWS docs or MCP docs.
- CBA facts come only from official Backstage docs and the Linux Foundation blueprint.
- Agent tools must be scoped, auditable, and provider-neutral at the application boundary.
- No autonomous publish path for generated content.

## AWS MCP Rule

AWS Knowledge MCP is for implementation research around AWS, Bedrock, Strands, and agent infrastructure. It is not a CBA fact source.
