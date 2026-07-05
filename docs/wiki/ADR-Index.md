# ADR Index

Architecture Decision Records live in `docs/adr/`.

## Accepted

- `0001-docs-and-wiki-governance.md` - Repository docs are canonical; GitHub Wiki is a navigation portal.
- `0002-cloudflare-nextjs-aws-bff.md` - Pilot runtime split: Cloudflare-hosted Next.js frontend + AWS-hosted BFF/backend/AI control plane; the AI Orchestration Service is separate from the Web BFF.

## Candidate Future ADRs

- Bedrock transport uses AWS SDK v3, not AWS CLI.
- Strands is adopted as an infrastructure adapter behind `AgentOrchestrator`.
- AI-generated content remains draft until human review.
- GitHub Project is the execution board; repository docs are the canonical product/architecture record.
- CBA remains the proving ground before generic exam support.
