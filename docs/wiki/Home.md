# CBA Study Coach Wiki

This wiki is the navigation layer for the CBA Study Coach project. The source of truth remains in the repository so architecture, product direction, and governance changes can be reviewed through normal commits and pull requests.

## Product Direction

CBA Study Coach is moving from an engine-neutral CLI study kit into a source-grounded SaaS for certification simulations, adaptive learner progress, AI coaching, and reviewed agentic authoring.

Current posture:

- Start with Certified Backstage Associate (CBA).
- Keep official sources as the trust boundary.
- Treat AI-generated questions as drafts until human reviewed.
- Keep learner UX focused on study workflows, not agent consoles.
- Keep domain rules independent from model providers, AWS, Strands, databases, and UI frameworks.

## Quick Links

- Product vision: [Product-Vision.md](Product-Vision.md)
- Roadmap model: [Roadmap.md](Roadmap.md)
- Architecture: [Architecture.md](Architecture.md)
- AI and agent strategy: [AI-Agent-Strategy.md](AI-Agent-Strategy.md)
- Content governance: [Content-Governance.md](Content-Governance.md)
- Security and compliance: [Security-Compliance.md](Security-Compliance.md)
- Delivery process: [Delivery-Process.md](Delivery-Process.md)
- ADR index: [ADR-Index.md](ADR-Index.md)

## Canonical Repository Documents

- Product roadmap: `spec/product-roadmap.md`
- DDD guidance: `spec/domain-driven-design.md`
- AWS MCP guidance: `spec/aws-mcp.md`
- Exam blueprint: `spec/exam-blueprint.md`
- Item-writing rules: `spec/item-writing-rules.md`
- Tutor guide: `spec/tutor-guide.md`
- Backstage source map: `spec/backstage-docs-map.md`

## Operating Rule

Use the wiki to orient humans and agents. Use repository files and GitHub issues to make decisions, track delivery, and preserve history.
