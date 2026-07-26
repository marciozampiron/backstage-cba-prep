# AI Agent Security Model

Status: architecture contract for #84/#87. Read this before implementing or reviewing the learner
coach, authoring agent, review assistant, agent tools, memory/context, guardrails, or live AI
workflows.

## 1. Security Thesis

The model is an untrusted reasoning component inside a deterministic application security boundary.
It can propose text and tool calls. It cannot grant itself authority, derive trusted identity,
change learner truth, publish content, accept risk, or bypass a human gate.

The first learner coach should remain single-pass and read-only. Multi-step tool loops are reserved
for cases where eval evidence proves they add value and the expanded attack/cost surface is accepted.

## 2. Agent Profiles

| Profile | Input | Allowed capability | Forbidden capability |
| --- | --- | --- | --- |
| Learner coach | Minimized ProgressSnapshot, canonical Recommendation, approved explanations/sources | Explain and format a study plan; read approved learner-scoped context | Write score/mastery/recommendation, generic network/shell/MCP, authoring, publish |
| Authoring agent | Blueprint, approved source policy, existing bank, aggregate shortage signal | Read allowlisted sources, detect duplicates, validate, write draft only | Learner-specific context, synchronous learner invocation, approve/publish |
| Review assistant | Draft, source/provenance, validation findings | Suggest corrections and review evidence | Make ReviewDecision, approve, publish |
| Operations assistant | Logical health and usage summaries | Read allowlisted operational metadata | Exam-fact authority, application-data reads, deploy, secrets, model mutation |

Tools are issued per profile and run. There is no universal production tool registry exposed to a
model.

## 3. Threats and Required Controls

### `AI-T01` Direct prompt injection and jailbreak

Attack: a learner asks the coach to ignore policy, reveal prompts, change role, call hidden tools, or
produce unrelated/harmful output.

Controls:

- separate developer/system policy from user content;
- treat the system prompt as non-secret and non-authoritative for permissions;
- validate topic, size, encoding, and supported intent before invocation;
- purpose-specific tool allowlist and deterministic authorization;
- output policy and safe fallback;
- adversarial tests for instruction override, prompt leakage, obfuscation, roleplay, and multi-turn
  persistence.

### `AI-T02` Indirect prompt injection and source/tool poisoning

Attack: retrieved documentation, imported files, tool output, or another agent embeds instructions
that attempt to redirect the model or exfiltrate context.

Controls:

- mark retrieved material as untrusted data, never instruction;
- source URL/host allowlists, redirect limits, DNS/IP/SSRF protections, type/size/time limits;
- strip active markup and unsupported content;
- preserve source provenance and trust label with each excerpt;
- do not concatenate tool output into privileged instructions;
- test malicious source passages, poisoned metadata, and compromised tool output.

Official documentation is authoritative for CBA facts, but its bytes are still untrusted as
instructions or executable markup.

### `AI-T03` Excessive agency and confused deputy

Attack: manipulated model output causes a tool to read/write beyond the current learner, use case,
tenant, certification, or privilege.

Controls:

- the application selects the tool set; the model cannot discover or enable tools;
- derive learner/tenant/certification/role from authenticated server context, not tool arguments;
- authorize every tool call immediately before execution;
- split read, draft-write, approval, publish, deploy, and spend capabilities;
- strict schemas, resource allowlists, timeouts, max steps, max retries, and cancellation;
- no generic shell, filesystem, browser, HTTP, cloud console, or MCP tool in learner flows;
- generated/service principals cannot approve their own output.

### `AI-T04` Sensitive information disclosure and cross-context leakage

Attack: prompts, model output, tools, cache, memory, traces, or logs expose another learner's data,
credentials, private drafts, system configuration, or future tenant/certification context.

Controls:

- minimize/pseudonymize model context and never send credentials or raw tokens;
- session-scoped context and cache keys include learner plus future tenant/certification partition;
- no shared mutable conversation memory across learners;
- redact before invocation and before audit logging;
- do not persist full prompts/responses by default; store template/version, hashes, usage, reason,
  and approved diagnostic metadata;
- cross-learner and cross-certification negative tests.

Provider PII filters are probabilistic and do not remove the need for application minimization.
Amazon Bedrock documents that sensitive-information filters do not inspect PII inside `tool_use`
arguments, so tool schema/authorization must enforce this boundary.

### `AI-T05` Insecure output handling

Attack: model output becomes executable HTML/Markdown, commands, URLs, database input, tool
permission, or published content.

Controls:

- validate output against a versioned application-owned schema;
- render as escaped text or sanitized restricted Markdown;
- resolve citations against approved server-side source IDs;
- reject unknown actions/reason codes/filters;
- never execute code/commands/URLs emitted by the model without a separate deterministic policy;
- drafts enter review; only `ApproveQuestionVersion` publishes.

### `AI-T06` Denial of wallet, availability, or runaway loops

Attack: repeated messages, huge context, recursive tools, retries, concurrency, or adversarial input
causes excessive tokens, Guardrail charges, tool calls, or downstream load.

Controls:

- `UsageBudget` allow/deny before inference;
- per-principal, tenant, use-case, and environment quotas;
- input/context/output token ceilings and bounded history;
- maximum steps, tool calls, retries, wall time, and concurrency;
- deterministic fallback for learner coaching;
- circuit breaker/operator kill switch;
- rate-limit events and usage recorded without sensitive content.

### `AI-T07` Integrity, hallucination, and automation bias

Attack: unsupported coach guidance or generated questions are trusted because they appear fluent.

Controls:

- deterministic score, mastery, ProgressSnapshot, and Recommendation Engine remain authoritative;
- coach plan actions trace to canonical recommendation reason codes;
- approved sources and explanations ground learner-facing facts;
- authoring output is draft with provenance, uncertainty, and duplicate-risk metadata;
- human educator approves content; evals measure grounding and unsupported claims;
- UI communicates source and uncertainty without exposing agent internals.

### `AI-T08` Model, dependency, and provider supply-chain compromise

Attack: a changed model/version, SDK, agent framework, tool schema, prompt template, or provider
behavior weakens controls.

Controls:

- provider/model/tier and prompt-template versions are configuration/audit metadata;
- lockfiles and dependency review;
- contract/eval suite before model, guardrail, prompt, tool, or SDK promotion;
- least-privilege provider role and explicit model/resource allowlist;
- rollback and kill switch;
- no provider feature is treated as the sole control.

## 4. Tool Invocation Protocol

1. Interface authenticates the caller and builds an immutable principal.
2. Application authorizes the use case and asks `UsageBudget`.
3. Application assembles minimized context and a purpose-specific tool registry.
4. Guardrail/input policy may detect or block content, but does not grant permission.
5. Model proposes structured output/tool call.
6. Application validates schema, intent, authenticated scope, resource allowlist, state, and budget.
7. Adapter executes with least-privilege credentials and bounded timeout/output.
8. Application validates tool output before returning it to the model.
9. Final output passes schema, grounding, citation, and rendering policy.
10. `AgentRunRepository` records privacy-safe status/usage/tool evidence.

Missing authentication, authorization, ownership, or partition context always fails closed. After those
checks pass, unavailable model/guardrail capacity or a denied AI budget may degrade to the deterministic
learner path.

## 5. Bedrock Guardrails Position

Guardrails can add prompt-attack, harmful-content, denied-topic, sensitive-information, and
grounding checks. They are defense in depth, not the authorization boundary.

Before blocking learner traffic:

- evaluate in detect mode against benign and adversarial fixtures;
- measure false positives/negatives and accessibility/language impact;
- tag/select only the intended user content according to the chosen Bedrock API;
- test input and output paths;
- account for Guardrail cost in `UsageBudget`;
- decide whether invocation logging is disabled or privacy-safe, because AWS documents that blocked
  content can appear in Model Invocation Logs when logging is enabled;
- version the guardrail/config and preserve rollback.

## 6. Required Adversarial Evidence

The no-spend harness for #63/#87 should include:

- direct/indirect injection, prompt leakage, encoding/obfuscation, and instruction collision;
- tool name/argument smuggling, unknown fields, oversized output, repeated calls, and timeout;
- ownership/tenant/certification substitution;
- malicious source text, redirects, internal/private URL targets, active markup, and huge documents;
- ungrounded claim, fake citation, unsupported recommendation action, and publish attempt;
- context reuse between learners and stale/mixed session cache;
- budget exhaustion, cancellation, retry storm, and deterministic fallback;
- positive controls proving allowed grounded coaching and draft creation still work.

Live-model evals are supplemental and human-gated. Default CI remains no-spend.

## 7. Release and Incident Gates

The agentic gate is separate from the web pilot gate. Before a live learner coach or authoring agent:

- the applicable controls in `security-assurance-baseline.md` are evidenced;
- #63 adversarial/grounding harness is green;
- #64 UsageBudget and kill switch are active;
- #61 run/usage audit is active;
- #60 human review is structurally enforced for authoring;
- privacy, retention, incident response, rollback, and model/guardrail change procedures are owned;
- the human product/security owner records go/no-go.

Security events include prompt/tool abuse, suspected cross-learner leakage, unexpected provider/tool
behavior, uncontrolled spend, unsafe published content, or compromised source/dependency. Disable
the affected model/tool path and use deterministic fallback while preserving privacy-safe evidence.

## 8. References

- [OWASP LLM01:2025 Prompt Injection](https://genai.owasp.org/llmrisk/llm01-prompt-injection/)
- [OWASP LLM06:2025 Excessive Agency](https://genai.owasp.org/llmrisk/llm062025-excessive-agency/)
- [NIST AI 600-1 Generative AI Profile](https://nvlpubs.nist.gov/nistpubs/ai/NIST.AI.600-1.pdf)
- [Amazon Bedrock prompt-attack detection](https://docs.aws.amazon.com/bedrock/latest/userguide/guardrails-prompt-attack.html)
- [Amazon Bedrock Guardrails components and logging note](https://docs.aws.amazon.com/bedrock/latest/userguide/guardrails-components.html)
- [Amazon Bedrock sensitive-information filters](https://docs.aws.amazon.com/bedrock/latest/userguide/guardrails-sensitive-filters.html)
- [AWS AgentCore Runtime security best practices](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-security-best-practices.html)
