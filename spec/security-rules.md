# Security Rules

This is the short, mandatory security contract for humans and coding agents working on the CBA
Study Coach. The architecture and control catalog live in
[`docs/architecture/security-assurance-baseline.md`](../docs/architecture/security-assurance-baseline.md).
AI-specific threats and controls live in
[`docs/architecture/ai-agent-security-model.md`](../docs/architecture/ai-agent-security-model.md).

All three documents are binding. The detailed baseline owns control and release-gate
interpretation; if wording conflicts, apply the stricter requirement until the human
product/security owner approves a documented reconciliation.

## 1. Decision Rights

1. Only the human product/security owner may accept residual risk, authorize a push or deployment,
   approve paid AI execution, or make a release go/no-go decision.
2. AI-agent reviews are evidence only. No AI agent or service principal may approve
   security-sensitive work, accept risk, or serve as the human gate, including for work produced by
   a different agent or run.
3. A separate architect/security reviewer must review changes to authentication, authorization,
   identity, sessions, data isolation, AI tools, prompts, infrastructure permissions, workflows,
   secrets, logging, or public endpoints.
4. No AI agent or service principal may approve or publish AI-generated content, including content
   produced by a different agent or run. Only the human-backed `ApproveQuestionVersion` use case may
   publish generated questions.
5. Security findings are not silently suppressed. Record the finding, severity, evidence, owner,
   remediation or accepted residual risk, and review expiry.
6. **Publication is gated and role-separated (#91, #93).** Roles and messages are canonical in
   [`.agent-handoff/MESSAGE-PROTOCOL.md`](../.agent-handoff/MESSAGE-PROTOCOL.md); the mechanism is
   canonical in
   [`docs/architecture/agent-publication-runbook.md`](../docs/architecture/agent-publication-runbook.md).
   Opus prepares and, **only after an explicit `HUMAN_GATE_GRANTED` from Zamp naming the exact
   ordered full SHAs and the artifact digest**, operates publication using the verify-and-run command
   that hashes the bytes it executes. Two gates are required and are not interchangeable: a review
   scope bounds preparation and authorizes nothing; the execution gate — supplied as
   `CBA_EXECUTION_GATE`, closed-schema, bounded to 12 hours — is validated by the artifact before the
   operator confirmation and again immediately before the push. Codex reviews read-only and never implements, prepares, executes, pushes, merges or
   deploys. Zamp approves and decides and performs the merge. Gemini holds the seated read-only Gemini Spec Auditor persona — it audits and reports only,
   with no authority: never an approval, a gate, a risk acceptance or any operational permission. The script may do exactly two remote things — push the reviewed commit by SHA to
   `task/<issue>-<slug>` without force, and create or reuse one pull request. It may never merge,
   deploy, push an integration branch, force-push, rewrite history, administer the repository or
   branch protection, handle secrets, or invoke a paid service.
7. Approval and operation are different actors. A gate whose approver is the invoking operator, or
   whose approver looks like an agent identity, is refused. A generic "approved", or a
   `REVIEW_APPROVED`, is review feedback and never a publication gate.
8. The declared `--role`/`--executor` are caller-supplied and authenticate nothing. Treat #91
   Stage A and the #93 bridge as process guardrails, and never describe them as mechanical identity
   separation. Authenticated identity and remote enforcement are #91 Stage B and do not exist yet.
9. Once independent review begins, reviewed commits are immutable. Findings produce a NEW
   fix-forward commit — never an amend, rebase or squash of reviewed history — and a new gate.
10. The publish gate is authored by Zamp **outside the task worktree**. A gate written inside
   the repository is an untracked file, which makes the worktree dirty, which validation refuses;
   the command refuses an in-repository gate path outright. Bookkeeping that writes tracked files
   (`EVENTS.md`, `CURRENT.md`, `agent-refresh --record`) belongs to the main worktree or a later
   commit. A control whose documented procedure cannot be completed is not a control.
11. Publication targets are bound, not assumed: the repository is derived from the `origin` remote
    that the push actually goes to, and the pull request is identified by owner, repository and
    exact base and head — never by branch name alone, which spans forks.

## 2. Architecture Boundaries

1. Preserve the dependency rule in `spec/domain-driven-design.md`.
2. Domain and application code stay provider/runtime neutral. AWS, Cloudflare, Bedrock, Strands,
   model SDKs, database clients, telemetry SDKs, and web frameworks belong in adapters or
   interfaces.
3. Authentication establishes a principal. Application use cases authorize every protected action
   and enforce ownership. CORS, hidden UI controls, model instructions, and opaque identifiers are
   not authorization.
4. Default deployed behavior is fail closed. Missing identity, policy, tenant/certification
   partition, runtime configuration, or required control must not fall back to a development mode.
5. Side-channel failures such as telemetry must not change an otherwise valid business result.
   Security enforcement failures must fail the protected operation.

## 3. Data and Privacy

1. Collect and send the minimum data required for the use case.
2. Never place credentials, JWTs, cookies, authorization headers, secrets, raw learner identity,
   full request/response bodies, unpublished answer keys, prompts, tool arguments, or full model
   context in operational logs, generic traces, or provider invocation logs. Browser responses expose
   only contract-approved fields for the current exam state; post-submit review may expose the
   approved answer and explanation. Purpose-owned application records may store the minimum learner
   identifier required by their contract.
3. Learner attempts, progress, profiles, and coach context are confidential and partitioned by
   authenticated learner. Future tenant and certification identifiers must join that partition.
4. Secrets never enter Git, browser bundles, issue bodies, handoffs, model prompts, or model/tool
   traces. Use short-lived identity and managed secret stores.
5. Retention, deletion, export, backup, and incident evidence must have explicit owners and bounded
   lifetimes.

## 4. Web and API

1. Validate method, content type, size, shape, ranges, identifiers, pagination, and state
   transitions at the interface boundary.
2. Derive identity, ownership, tenant, and certification scope from trusted server context, not
   caller/model-supplied arguments.
3. Preserve exam-mode confidentiality: correctness, explanations, sources, and scoring evidence
   cannot leave the server before mock submission.
4. Use idempotency and optimistic/conditional writes where retries or concurrency can duplicate or
   overwrite state.
5. Rate-limit and bound expensive or abuse-prone operations. Return stable error envelopes without
   stack traces, internal identifiers, policies, or provider details.
6. Public readiness endpoints expose logical status only.

## 5. AI and Agentic Systems

1. Treat every user message, retrieved document, source excerpt, model response, and tool argument
   as untrusted data.
2. System prompts are policy guidance, not a security boundary. Authorization and tool permission
   are deterministic application decisions.
3. Use purpose-specific tool allowlists. The learner coach has read-only tools and no generic
   shell, filesystem, network, MCP, publish, or authoring capability.
4. Validate tool calls with strict schemas, ownership checks, resource allowlists, timeouts, step
   limits, token limits, output limits, and cancellation.
5. Untrusted source text is never executed as instruction. Source ingestion must defend against
   indirect prompt injection, unsafe redirects, SSRF, oversized content, and unsupported formats.
6. Validate and sanitize model output before rendering or passing it to another system. Model
   output never becomes HTML, code, a database command, a tool permission, or published content
   without deterministic validation.
7. Scoring, mastery, ProgressSnapshot, canonical recommendations, entitlements, authorization, and
   publication remain deterministic.
8. Learner requests never invoke authoring synchronously. Learner-derived authoring signals are
   aggregate/anonymized.
9. `UsageBudget` authorizes spend before every live model invocation. `AgentRunRepository` records
   privacy-safe audit evidence after or during execution. Both are required before any
   learner-facing or authoring live model path.
10. Bedrock Guardrails or any provider safety feature is supplemental defense, never a replacement
    for application authorization, data minimization, tool policy, output validation, or human
    review.

## 6. Cloud, CI, and Supply Chain

1. Use short-lived OIDC/SSO credentials and single-purpose least-privilege roles. Never introduce
   long-lived AWS keys.
2. Keep synth, unit, contract, static, and no-spend adversarial tests credential-free by default.
3. Deploy, cloud mutation, paid model execution, notification mutation, and destructive security
   testing each require their own explicit human gate.
4. Pin and review dependencies and automation actions according to the repository supply-chain
   policy. Lockfiles are required where dependencies exist.
5. Infrastructure tests must prove encryption, retention, public-access posture, exact trust
   conditions, and reviewed wildcard exceptions with positive and negative controls.

## 7. Verification and Release

1. Map each security-sensitive acceptance criterion to a control ID from the security baseline.
2. Tests must include positive and negative controls; a grep or assertion that can pass without
   exercising the protection is insufficient.
3. Default CI must remain no-spend. Live AI evaluation is manual, budget-capped, and separately
   approved.
4. The web pilot requires its security gate before #70 promotion. Live learner coach/authoring
   requires the separate agentic gate before #58/#59/#60 release.
5. Critical or high findings block release unless the authorized human records rationale,
   compensating controls, owner, and expiry.
