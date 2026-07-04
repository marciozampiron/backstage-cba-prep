# CBA Study Coach Wiki

This is the project home for humans and agents working on CBA Study Coach. Use it to understand the product direction, architecture rules, delivery model, and governance before changing code or creating roadmap work.

The repository remains the source of truth. The GitHub Wiki is the readable navigation layer.

## At a Glance

| Area | Current decision |
| --- | --- |
| Product | Start as a Certified Backstage Associate study kit and evolve into a source-grounded SaaS exam platform. |
| First domain | Certified Backstage Associate (CBA). Generic exam automation comes after the CBA loop is proven. |
| Trust boundary | Facts come from the Linux Foundation exam page and official Backstage docs only. |
| AI rule | AI may draft and assist, but reviewed content is the product. Human approval remains required for question correctness. |
| Architecture | Pragmatic DDD with provider-neutral domain/application layers and infrastructure adapters for model providers. |
| Agent posture | The learner experience must feel like a study platform, not an agent console. Agents work behind product workflows. |
| Execution | GitHub Issues are the unit of work. The Project board owns Status and Phase. |

## Start Here

- Product and positioning: [Product Vision](Product-Vision.md)
- Roadmap and phases: [Roadmap](Roadmap.md)
- Architecture rules: [Architecture](Architecture.md)
- AI, Bedrock, and Strands direction: [AI Agent Strategy](AI-Agent-Strategy.md)
- Question quality and review: [Content Governance](Content-Governance.md)
- Secrets, compliance, and tenant posture: [Security and Compliance](Security-Compliance.md)
- Delivery workflow for agents: [Delivery Process](Delivery-Process.md)
- Architecture decision records: [ADR Index](ADR-Index.md)

## Delivery Lanes

| Lane | Purpose | Primary docs |
| --- | --- | --- |
| CLI Core | Keep the current CBA kit validated, source-grounded, and publishable. | [Roadmap](Roadmap.md), `spec/exam-blueprint.md`, `questions/schema.json` |
| Web MVP | Turn the kit into an online simulator with focused learner UX. | [Product Vision](Product-Vision.md), [Roadmap](Roadmap.md) |
| AI Coach | Add grounded learner assistance and model-provider routing. | [AI Agent Strategy](AI-Agent-Strategy.md), [Architecture](Architecture.md) |
| Authoring Pipeline | Ingest sources, draft questions, review, version, approve, and publish. | [Content Governance](Content-Governance.md), [Delivery Process](Delivery-Process.md) |
| Generic Engine | Generalize the exam/domain model after CBA proves the loop. | [Product Vision](Product-Vision.md), `spec/product-roadmap.md` |

## Agent Operating Rules

- Read `AGENTS.md` before acting in the repository.
- Keep facts grounded in official sources. Do not use AWS MCP or general web search to validate exam facts.
- Keep `domain/` and `application/` free from provider SDKs, AWS, Strands, database clients, CLI UI helpers, and web framework code.
- Use ports before infrastructure adapters when adding model, agent, storage, or external service behavior.
- Treat generated questions as drafts until the review workflow marks them verified.
- Update docs or ADRs when a change alters product direction, architecture, or delivery policy.

## Canonical Repository Files

| File | Role |
| --- | --- |
| `AGENTS.md` | Runtime behavior for AI agents working in this repository. |
| `spec/product-roadmap.md` | Canonical product direction and SaaS roadmap. |
| `spec/domain-driven-design.md` | DDD posture, bounded contexts, and dependency rule. |
| `spec/aws-mcp.md` | AWS MCP usage rule and configuration guidance. |
| `spec/exam-blueprint.md` | CBA domains, weights, competencies, and exam budget. |
| `spec/backstage-docs-map.md` | Official documentation map used for source grounding. |
| `spec/item-writing-rules.md` | Rules for exam-quality question authoring. |
| `spec/tutor-guide.md` | Study session behavior and coaching flow. |
| `questions/schema.json` | Structural contract for question bank files. |

## Current Direction

The near-term path is to finish the AI orchestration foundation, wire the remaining authoring commands through provider-neutral ports, and keep Bedrock/Strands adoption aligned with production architecture instead of temporary scripting.

The product direction is enterprise by default: observable AI usage, reviewed content, clean domain boundaries, tenant-ready data modeling, and a UX that helps learners study efficiently.
