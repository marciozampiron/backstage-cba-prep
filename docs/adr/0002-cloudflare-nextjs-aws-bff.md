# ADR 0002: Cloudflare Next.js Frontend and AWS BFF/Backend Split

## Status

Accepted for the pilot. This is a reversible, pilot-scoped runtime decision, not a permanent platform lock-in (see "Pilot vs. not lock-in").

## Context

The project is moving from the engine-neutral CBA CLI/study kit (Phase 0) toward a source-grounded SaaS pilot (epic #33). Before building the frontend prototype (#35), the Web BFF contracts (#36), and the AWS architecture diagrams (#34), we need a fixed runtime split so those artifacts describe the same topology.

The AI orchestration foundation already exists: #23 and its follow-ups (#26/#27/#29/#31/#30) delivered provider-neutral `ModelProvider`, `AgentOrchestrator`, `ToolRegistry`, and `AgentRunRepository` ports, with AWS Bedrock (Converse via AWS SDK v3) and Strands as infrastructure adapters, plus opt-in run/usage persistence. `src/domain/` and `src/application/` are provider-neutral and never import AWS/Strands/DB/web-framework code (enforced by a test).

Product constraints that shape the runtime (see `spec/product-roadmap.md`, `docs/wiki/AI-Agent-Strategy.md`):

- The learner experience must feel like a study platform, not an agent console; agentic automation belongs to coach/admin/authoring flows.
- Exam facts stay source-grounded; AI-generated questions are drafts until human review.
- Pilot cost posture: low-cost defaults, no always-on heavy compute unless justified.

## Decision

For the pilot, adopt this runtime split:

- **Frontend:** Next.js web app / prototype.
- **Web/edge hosting:** Cloudflare.
- **BFF, core services, and AI control plane:** AWS.
- **The Web BFF is the only browser-reachable backend surface.** It exposes auth-aware, frontend-shaped endpoints and hides internal services and AI orchestration from the browser.
- **The AI Orchestration Service is a separate service from the Web BFF.** It hosts the `ModelProvider` / `AgentOrchestrator` / `AgentRunRepository` adapters (Bedrock/Strands) and is reached only through core services, never directly from the browser.
- **Bedrock, Strands, and persistence stay behind the ports/adapters from #23** — unchanged by this decision.

### Why Next.js

- React + SSR/SSG/ISR fit a study dashboard, mock-exam flow, and results/coach views, and give fast repeated-study navigation.
- It is the natural target for the UI-generation brief in #35 and pairs with the learner-first UX the roadmap mandates.
- It is portable: it can run on Cloudflare now and move to another host later without rewriting the product, which keeps this a low-regret pilot choice.
- Next.js server code stays presentation/session-oriented; the real BFF lives on AWS (below), so the frontend never becomes the backend.

### Why Cloudflare for the frontend

- Edge hosting gives global low latency for the learner surface with generous low/free tiers — a good fit for the pilot cost posture (no always-on heavy compute at the edge).
- Good Next.js developer experience and CDN/edge caching for a study app that is opened and re-opened often.
- Keeping the learner surface on the edge decouples it from the AWS control plane and keeps the browser far from AI/token-spending paths.

### Why AWS for BFF/backend/AI

- The AI orchestration foundation already targets AWS Bedrock + Strands (#23); colocating the BFF and AI control plane with them reduces latency and keeps one IAM-scoped security boundary.
- The core workflows map cleanly onto AWS primitives named in #33: Cognito (auth), API Gateway, Lambda/App Runner, DynamoDB, S3, Step Functions, SQS/EventBridge, Bedrock, Secrets Manager, IAM, KMS, and CloudWatch.
- AWS is where paid AI spend, provenance, review pipelines, and future tenant data will live, so the control plane belongs there.

### Why separate the Web BFF from the AI Orchestration Service

- **Different profiles:** the BFF is browser-facing, auth-aware, and frontend-shaped; the AI Orchestration Service is internal, tool-capable, and token-spending. They scale and fail independently.
- **Security / blast radius:** the browser can reach only the BFF. Bedrock/Strands and the `AgentRunRepository` sit behind core services, so a browser bug or a leaked frontend token cannot reach model invocation directly.
- **Cost control and observability:** keeping AI behind a dedicated service lets us gate paid calls behind server-side use cases with no-spend/dry-run defaults, and meter usage (`AIUsageEvent`) and rate-limit it independently of the BFF.
- **DDD alignment:** the AI Orchestration Service is the infrastructure host for the application-owned ports; the BFF calls application use cases, not provider SDKs.

## Consequences

Positive:

- Clean separation of the learner-facing edge (Cloudflare/Next.js) from the AWS control plane.
- Reuses the provider-neutral ports from #23; Bedrock/Strands stay swappable and the domain stays clean.
- Cheap to run for the pilot; each tier can scale later without re-architecting.
- The BFF hides internal/AI details from the browser (aligns with the #36 contract goal) and provides a single place for auth and rate limiting.
- AI spend is observable and gated behind server-side use cases.

Tradeoffs:

- Cross-cloud (Cloudflare edge ↔ AWS backend): an extra network hop, CORS and token flow across the boundary, and two operational surfaces.
- Auth needs a deliberate design: Cognito-issued sessions must be mediated by the BFF for a Cloudflare-hosted frontend.
- Next.js server features that assume a colocated backend must be constrained; the frontend stays presentation/session while the authoritative BFF is on AWS.
- Two hosting bills and two deploy pipelines to maintain.

## Pilot vs. not lock-in

Pilot-only and revisitable:

- Cloudflare as the specific edge host — could move to AWS (Amplify / CloudFront + S3), Vercel, or another host without changing the product model.
- The exact AWS compute choice (AWS Lambda vs. App Runner) is intentionally **not** fixed here; it is deferred to #34 and implementation.
- The cross-cloud split can collapse to single-cloud if operational cost outweighs the edge benefit.

Not up for grabs (stable regardless of the runtime host):

- The DDD dependency rule: `domain/` and `application/` stay provider- and runtime-neutral.
- Providers, persistence, and runtime concerns stay behind ports/adapters (#23).
- Learner UX is a study platform; agentic automation stays behind coach/admin/authoring flows.
- Source-grounded content; AI output is draft until human review.

## Relationship to issues

- **#33 (epic):** this ADR fixes the runtime split the epic's target architecture assumes (Web App → Web BFF → Core Services → AI Orchestration Service → AWS Foundation).
- **#34:** the AWS diagrams should render this split, with Next.js on the Cloudflare edge and the BFF / core / AI orchestration / foundation on AWS.
- **#35:** the frontend screen map targets the Cloudflare/Next.js learner and admin surfaces, with no learner-facing agent console.
- **#36:** the Web BFF contracts are the AWS boundary this ADR mandates — frontend-shaped, and never exposing AI orchestration to the browser.
- **#37:** this ADR.
- **#23:** the AI orchestration foundation (ports + Bedrock/Strands adapters + `AgentRunRepository`) that the AWS AI Orchestration Service will host. This decision changes *where* that foundation runs, not *how* it is layered.

## DDD rules that still hold

- Dependencies point inward: `interfaces -> application -> domain`; `infrastructure -> application/domain contracts`; `domain -> no infrastructure`.
- `domain/` and `application/` import no AWS SDK, Strands, database client, or web framework — **Next.js included**. This is enforced by the guard test.
- `ModelProvider`, `AgentOrchestrator`, `ToolRegistry`, and `AgentRunRepository` remain the boundaries. Cloudflare, Next.js, the BFF, and AWS services are interfaces/infrastructure, not domain.
- Model routing uses tier names (`fast` / `standard` / `critical`) at the application boundary; concrete model IDs stay in configuration.
