# Security Assurance Baseline

Status: architecture contract for #84/#85. This document defines how the CBA Study Coach identifies,
owns, tests, and accepts security risk. It complements the delivery-specific GitHub/OIDC baseline
and the operational-observability baseline; it does not replace either.

## 1. Objectives

- Protect learner identity, attempts, progress, and study context.
- Preserve exam integrity and reviewed-content provenance.
- Keep model and tool authority smaller than application authority.
- Prevent one learner, tenant, certification, agent, workflow, or environment from crossing another
  boundary.
- Make controls testable and release evidence reviewable.
- Keep the pilot proportionate: strong invariants and bounded controls before expensive enterprise
  platforms.

Security is continuous. The final gate confirms implemented controls; it is not the first time
security is considered.

## 2. Canonical Sources

| Concern | Source |
| --- | --- |
| Mandatory repository rules | `spec/security-rules.md` |
| System threat model and control ownership | This document |
| AI/agentic threats and controls | `ai-agent-security-model.md` |
| DDD and provider boundaries | `spec/domain-driven-design.md` |
| Adaptive AI behavior | `spec/ai-adaptive-study-strategy.md` |
| GitHub/OIDC/secrets | `github-security-and-oidc-baseline.md` |
| Release and rollback | `pilot-release-runbook.md` |
| Operational telemetry | `aws-observability-baseline.md` |

All listed sources are binding. This detailed baseline owns control and release-gate
interpretation. When two sources appear to conflict, the stricter requirement applies until the
human product/security owner approves a documented reconciliation. Skills and prompts reference
these documents; they never become a competing policy source.

## 3. Protected Assets

- Learner identity, profile, sessions, attempts, answers, progress, preferences, and coach context.
- Exam content, unpublished drafts, explanations, sources, provenance, and review decisions.
- Authentication tokens, cloud credentials, secrets, signing/configuration material, and deploy
  authority.
- Model prompts, tool policies, agent context, usage records, and unpublished outputs.
- Availability and cost budgets for Cloudflare, AWS, Bedrock, and third-party services.
- Audit and release evidence used for incident response and go/no-go decisions.

The current checked-in CBA bank is public by repository design. This does not make future private
drafts, learner data, prompts, review evidence, or tenant content public.

## 4. Data Classes

| Class | Examples | Minimum handling |
| --- | --- | --- |
| Public | Published docs, public architecture summaries, approved public CBA bank | Integrity and provenance checks |
| Internal | Model IDs, prompt-template versions, aggregate metrics, sanitized run metadata | Authenticated/admin access; no browser exposure unless explicitly public |
| Confidential | Learner profile, attempts, progress, unpublished drafts, review evidence, coach context | Encryption, ownership/partition checks, minimization, bounded retention |
| Restricted | Credentials, JWT/cookies, provider tokens, recovery secrets, unredacted sensitive prompts | Never Git/log/model issue/handoff; managed secret store; short-lived access |

Data classification is based on the most sensitive field in a payload. Hashing or pseudonymizing an
identifier does not automatically make the data public.

## 5. Trust Boundaries

1. **Browser -> Cloudflare Worker:** the browser is untrusted. Client state and hidden controls do
   not authorize anything.
2. **Cloudflare -> AWS HTTP API:** public network boundary. CORS narrows browsers; JWT and
   application authorization enforce access.
3. **API Gateway/Cognito -> Lambda BFF:** the transport validates the token; application use cases
   enforce role, learner ownership, state transition, and resource scope.
4. **BFF -> DynamoDB:** only repository adapters use data-plane permissions; keys include the
   authenticated partition and later the certification/tenant partition.
5. **BFF -> AI Orchestration Service:** AI receives a minimized, server-assembled context. The
   browser never receives model/tool credentials.
6. **AI Orchestration -> model/tools/sources:** model output is untrusted. Tool authorization is a
   deterministic application decision.
7. **Authoring -> Human Review Gate -> published content:** draft creation and publication are
   separate capabilities. Only the human-backed approval use case publishes.
8. **GitHub Actions -> Cloudflare/AWS:** short-lived, environment-scoped identities and
   single-purpose roles; no long-lived deploy keys.
9. **External source -> ingestion/authoring:** even an authoritative fact source is untrusted as
   executable instruction or markup.

## 6. Threat Method

Use STRIDE for system boundaries and abuse cases for product/AI behavior:

- spoofing: stolen/misvalidated identity or forged service principal;
- tampering: attempts, progress, question versions, sources, prompts, or workflow artifacts;
- repudiation: missing or ambiguous review/agent/deploy evidence;
- information disclosure: learner, exam, prompt, token, tool, or infrastructure leakage;
- denial of service/wallet: request floods, recursive agents, unbounded tokens/tools, expensive
  scans, or hot partitions;
- elevation of privilege: IDOR/BOLA, confused deputy, broad IAM, excessive agency, or publish
  bypass.

Rate each threat by likelihood and impact. Critical/high findings block the applicable release gate.
Only the human product/security owner may accept residual risk, and every acceptance needs rationale,
compensating controls, owner, review date, and expiry.

## 7. Initial Threat Register

| Threat | Abuse scenario / asset | Preventive controls | Detective evidence | Owner | Residual risk |
| --- | --- | --- | --- | --- | --- |
| `SYS-T01` | Stolen, malformed, or confused Cognito token reaches a protected route | `SEC-AUTH-01`, exact issuer/audience/token type, fail-closed deployed config | JWT negative tests and deployed auth abuse tests | Identity/BFF owner | Token theft until expiry; mitigated by short sessions and revocation response |
| `SYS-T02` | IDOR/BOLA reads or mutates another learner, tenant, or certification partition | `SEC-AUTH-01`, `SEC-DATA-01`, server-derived scope, conditional writes | Cross-owner/partition contract tests and DAST | Application/data owner | Future tenant/certification keys require the #10 hardening gate |
| `SYS-T03` | Correct answers or scoring evidence leak before mock submission | `SEC-WEB-01`, server-side exam state and response allowlists | Recursive leak scans with post-submit positive control | Simulation owner | Browser screenshots and user sharing are outside server confidentiality |
| `SYS-T04` | Credential, token, learner data, prompt, or exam content leaks through Git, bundle, logs, traces, or errors | `SEC-DATA-01`, `SEC-OBS-01`, secret/bundle scans and allowlisted telemetry | Positive-control scans and log/error contract tests | Platform/data owners | Third-party provider handling remains subject to provider contract and configuration |
| `SYS-T05` | Public API abuse causes outage, hot partitions, or cloud/model cost growth | `SEC-WEB-01`, `SEC-AI-05`, quotas, throttles, bounded operations | Rate/cost alarms and controlled abuse tests | Platform owner (#90) | Distributed abuse and changing traffic patterns may require later WAF and risk-based tuning |
| `SYS-T06` | Broad CI/deploy/model role or confused deputy mutates unrelated resources | `SEC-IAM-01`, `SEC-GOV-01`, exact OIDC trust and single-purpose roles | CDK assertions, Access Analyzer, CloudTrail and release evidence | Cloud operator/security reviewer | Human operator credentials remain a privileged boundary |
| `SYS-T07` | Dependency, action, build artifact, source, or tool update compromises integrity | `SEC-SUP-01`, lockfiles, review, provenance, and allowlists | CodeQL, dependency, build, and adversarial evidence | Platform/content owner | Upstream compromise cannot be eliminated; rollback and kill switch are required |
| `SYS-T08` | Draft or poisoned content bypasses provenance/review and becomes learner-visible | `SEC-AI-03`, deterministic publish use case, and human review | Static publish-path guard, review ledger, and provenance checks | Content reviewer | Human review error remains; sampling and audit improve detection |
| `AI-T01` | Direct prompt injection or jailbreak changes policy, authority, or deterministic truth | `SEC-AI-01`, `SEC-AI-02`, fixed policy and purpose-specific tools | Direct-injection and obfuscated-jailbreak adversarial cases | AI/application owner | Novel obfuscation and model-behavior drift remain; deterministic authorization and kill switch bound impact |
| `AI-T02` | Retrieved or ingested source text carries indirect instructions or poisoned facts | `SEC-AI-01`, `SEC-AI-02`, `SEC-AI-03`, source allowlists, provenance, and non-execution | Malicious-source, redirect, provenance, and publish-path tests | Ingestion/content/AI owners | Trusted sources or tools can change or be compromised; human review and non-execution reduce but cannot eliminate this risk |
| `AI-T03` | Model or tool acts as confused deputy with excessive agency | `SEC-AI-02`, `SEC-AI-04`, server-derived scope and least-privilege tool policy | Tool authorization, cross-partition, step-limit, and negative capability tests | Application/identity owner | Adapter or policy defects may expose unintended authority; least privilege and cancellation limit blast radius |
| `AI-T04` | Learner, tenant, certification, prompt, or tool context leaks across boundaries | `SEC-AI-01`, `SEC-AI-04`, `SEC-DATA-01`, minimized partitioned context and cache keys | Cross-learner/tenant/certification, cache, log, and trace tests | Data/identity/AI owners | Provider processing, configuration errors, or cache defects can still leak minimized context |
| `AI-T05` | Unsafe model output reaches rendering, storage, tools, or publication | `SEC-AI-01`, `SEC-AI-03`, strict schemas, sanitization, and deterministic publish gate | Output-schema, rendering, tool-chain, and publish-path negative tests | Interface/content owner | Parser or sanitizer defects and human over-trust remain; allowlisted rendering and review reduce impact |
| `AI-T06` | Recursive, replayed, or high-volume model/tool use causes denial of service or wallet | `SEC-AI-02`, `SEC-AI-05`, `SEC-WEB-01`, UsageBudget, quotas, and kill switch | Budget, rate, token/tool-step, loop, cancellation, and cost-alarm tests | Platform/product owner | Distributed abuse, provider pricing changes, and provider availability remain operational risks |
| `AI-T07` | Hallucination or automation bias produces unsupported learning or review guidance | `SEC-AI-03`, grounded output, deterministic truth, and human review | Unsupported-claim, grounding, reviewer, and production-sampling evaluations | Product/content reviewer | Source gaps and human automation bias cannot be eliminated; sampling and provenance improve detection |
| `AI-T08` | Model, prompt, dependency, tool, source, or provider update compromises behavior or integrity | `SEC-SUP-01`, `SEC-AI-01`, `SEC-AI-02`, pinning, promotion evals, and rollback | Dependency, model/tool/prompt-version, provenance, and rollback evidence | Platform/AI owner | Upstream compromise and model drift remain; controlled promotion, kill switch, and rollback contain exposure |

## 8. Core Control Catalog

| Control | Invariant | Primary evidence |
| --- | --- | --- |
| `SEC-GOV-01` | Human gates own push, deploy, spend, publication, release, and risk acceptance | Handoff/event and release decision |
| `SEC-ARCH-01` | Domain/application remain provider-neutral; privileged effects use ports/adapters | Static architecture guard and review |
| `SEC-AUTH-01` | Authenticated principal plus deterministic role/ownership checks protect every resource | Contract and negative authorization tests |
| `SEC-DATA-01` | Data is minimized, classified, partitioned, encrypted, retained, and deleted by policy | Schema/IaC tests and privacy review |
| `SEC-WEB-01` | Inputs, state transitions, errors, idempotency, exam-mode confidentiality, and costly-operation bounds are enforced server-side | API contracts, throttle/limit assertions, and abuse tests |
| `SEC-IAM-01` | Cloud/workflow identities are short-lived, single-purpose, and least privilege | IAM/OIDC template assertions and Access Analyzer |
| `SEC-SUP-01` | Dependencies, actions, artifacts, and lockfiles have reviewed provenance | Dependency/action checks and build evidence |
| `SEC-OBS-01` | Logs/metrics are allowlisted and privacy-safe; security events are actionable | Telemetry tests and operational gates |
| `SEC-AI-01` | Prompts, sources, model output, and tool arguments are untrusted | Adversarial eval harness |
| `SEC-AI-02` | Tool authority is purpose-specific, deterministic, schema-validated, and bounded | Tool-policy contract tests |
| `SEC-AI-03` | AI cannot change deterministic truth or publish content | Use-case/static guards and human-review evidence |
| `SEC-AI-04` | Learner/session/tenant/certification context is isolated and minimized | Cross-partition negative tests |
| `SEC-AI-05` | Spend and execution are bounded before invocation and auditable afterward | UsageBudget and AgentRun evidence |
| `SEC-REL-01` | Pilot and agentic releases each pass their own security go/no-go | DAST/adversarial evidence and signed decision |
| `SEC-IR-01` | Incidents have severity, containment, recovery, communication, and review owners | Tabletop and incident runbook evidence |

The initial #90 API Gateway stage baseline is `dev: 10 requests/second, burst 20` and
`pilot: 25 requests/second, burst 50`. Expensive endpoints require application-level,
server-principal bounds equal to or lower than the stage baseline. These are conservative starting
values, not a capacity promise; increases require traffic/cost evidence and human security review.
Stage throttling limits load but never replaces authentication, ownership, UsageBudget, or tool
authorization.

Every implementation task selects applicable control IDs and supplies evidence. A control can have
multiple tests; a test without a control owner is not a complete security requirement.

## 9. Roles and Decision Rights

One person may hold several roles during the pilot, but the workflow keeps the responsibilities
separate.

| Role | Accountable for | Must not do |
| --- | --- | --- |
| Human product/security owner | Risk tolerance, go/no-go, residual-risk acceptance, push/deploy/spend gates | Delegate final risk acceptance to an AI agent |
| Architect/security reviewer (Codex role) | Threat model, controls, roadmap dependencies, independent design/code review | Act as the human approval gate or mutate production by default |
| Implementation executor (Claude role) | Scoped implementation, tests, evidence, honest risks, local commit | Push/deploy/spend or act as the human approval gate for security-sensitive work |
| Independent reviewer | Reproduce evidence and report findings ordered by severity | Quietly repair findings and erase review evidence |
| Cloud operator (human) | Credentialed AWS/Cloudflare mutations and live verification | Put credentials/account details in Git or agent context |
| Content reviewer/educator (human) | Question correctness, provenance, approve/reject decision | Let authoring/review agents publish autonomously |
| Automated gates | Deterministic evidence and policy enforcement | Accept risk or reinterpret a failed control |

Security-sensitive changes require separation between executor and reviewer. A human gate is still
required after an AI review.

## 10. Delivery Gates

### Gate A: Web pilot, before #70 promotion

- threat model and matrix cover deployed entry points;
- authentication, ownership, CORS, state, exam-mode, and bundle-leak controls are evidenced;
- API/Lambda throttles and endpoint/application bounds are implemented; cost-abuse tests prove
  enforcement without a silent unbounded path;
- IAM/IaC/supply-chain checks are green;
- non-destructive deployed abuse/DAST tests are green;
- observability and incident/rollback readiness are proven;
- critical/high findings are closed or explicitly accepted by the authorized human.

### Gate B: Agentic learner/authoring release

Required before live #58/#59/#60 behavior:

- AI threat model and purpose-specific tool policy are implemented;
- no-spend adversarial evals cover prompt/tool/context/output attacks;
- UsageBudget, rate limits, kill switch, and AgentRun audit are active;
- cross-learner/tenant/certification isolation is proven;
- Guardrails, if used, have detect-mode evaluation and documented limitations;
- learner coach cannot write domain truth; authoring cannot publish; human review remains structural;
- live eval, if needed, is separately approved and budget-capped.

## 11. Security Review Output

Reviews lead with findings ordered `critical -> high -> medium -> low`. Each finding includes:

- affected file/line, endpoint, trust boundary, or resource;
- exploit/abuse path and preconditions;
- impact and likelihood;
- violated control ID;
- evidence and a focused remediation;
- residual risk or test gap.

If no finding exists, state that clearly and list untested boundaries or residual risk. Security
review is not approval to push, deploy, spend, or release.

## 12. Reference Baseline

- [OWASP ASVS 5.0](https://owasp.org/www-project-application-security-verification-standard/)
- [OWASP Top 10 for LLM Applications 2025](https://genai.owasp.org/llm-top-10/)
- [NIST Secure Software Development Framework SP 800-218](https://csrc.nist.gov/pubs/sp/800/218/final)
- [NIST AI Risk Management Framework](https://www.nist.gov/itl/ai-risk-management-framework)
- [NIST AI 600-1 Generative AI Profile](https://nvlpubs.nist.gov/nistpubs/ai/NIST.AI.600-1.pdf)
- [Amazon Bedrock Guardrails](https://docs.aws.amazon.com/bedrock/latest/userguide/guardrails-components.html)
- [AWS AgentCore Runtime security best practices](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-security-best-practices.html)

Record the referenced edition/date when a task maps individual standard requirements. Do not claim
certification or compliance from this internal baseline alone.
