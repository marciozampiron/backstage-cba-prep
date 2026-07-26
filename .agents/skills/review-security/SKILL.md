---
name: review-security
description: Review CBA Study Coach web, API, identity, data, AWS/Cloudflare, CI, dependency, observability, and AI-agent changes against the repository security baseline. Use for threat modeling, security architecture, security-sensitive code review, abuse cases, release gates, or changes involving auth, authorization, tools, prompts, model context, secrets, IAM, public endpoints, learner data, or publication.
---

# Review Security

Use repository policy as the source of truth:

1. Read `AGENTS.md` and `spec/security-rules.md`.
2. Read `docs/architecture/security-assurance-baseline.md`.
3. For model, prompt, source ingestion, tool, coach, authoring, or review work, also read
   `docs/architecture/ai-agent-security-model.md`.
4. Read the relevant GitHub issue and handoff before inspecting changes.

## Workflow

1. Identify assets, entry points, trust boundaries, authenticated principal, privileged effects,
   untrusted inputs, and applicable control IDs.
2. Inspect the implementation and tests. Do not infer a control from documentation alone.
3. Try abuse paths: bypass, cross-owner/tenant/certification access, malformed/replayed input,
   leakage, excessive privilege/agency, unsafe output, cost exhaustion, and fail-open behavior.
4. Verify positive and negative controls and the correct CI/deploy gate.
5. Report findings first, ordered critical/high/medium/low, with file/line, exploit path, impact,
   control ID, evidence, and focused remediation.
6. If there are no findings, say so and list residual risk and untested boundaries.

Do not modify code unless explicitly assigned. Never accept residual risk, act as the human approval gate for any security-sensitive work, push,
deploy, spend, or approve or publish AI-generated content. A security review is evidence for the
human gate, not the gate itself.

Publication is role-separated (#91). As the architect/security reviewer you may NEVER publish a
source branch, push `main`, merge, or act as the executor — `agent-publish` refuses your role
before any network call. Identify review targets by full commit SHA, and recommend a gate rather
than acting on one. Reviewed commits are immutable: a finding produces a NEW fix-forward commit,
never an amend or rebase of reviewed history.
