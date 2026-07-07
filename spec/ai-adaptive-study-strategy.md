# AI Adaptive Study Strategy

This spec is the short, canonical context for agents implementing the adaptive AI study loop. Read it before touching learner progress, recommendation, coach, or AI authoring work.

## Product Thesis

The product should not be only an online mock exam. Its differentiator is a source-grounded study loop that learns from each learner attempt and turns weak domains into targeted next steps.

The learner sees a study platform. Agentic automation stays behind the BFF, AI Orchestration Service, and admin/review workflows.

## Non-Negotiable Rules

1. Learners only see published, reviewed `QuestionVersion`s.
2. AI-generated questions are drafts until the human review gate approves them.
3. Progress and mastery are deterministic first. AI explains, narrates, plans, and drafts; it does not write mastery truth.
4. Study recommendations stay inside the exam blueprint: Exam -> Domain -> Competency.
5. Coach answers must use approved question explanations, attempt history, and official sources.
6. Agent runs must be recorded through `AgentRunRepository` / `AIUsageEvent` when they invoke models or tools.
7. No direct browser access to Bedrock, Strands, model providers, or authoring tools.
8. Agentic study plans compose deterministic outputs. The model may order, summarize, and explain recommendations; it must not invent drill filters outside the `Recommendation Engine` output space.
9. Learner requests never invoke the authoring agent synchronously. Weakness or coverage shortages enqueue authoring work for admin/batch execution.
10. Learner-derived authoring signals must be aggregated/anonymized at exam/domain/competency level. Do not pass learner-specific attempts or learner IDs into the authoring agent.

## Loop

```text
Learner answers questions
  -> Attempt + AttemptAnswer store exact QuestionVersion evidence
  -> ProgressSnapshot computes strong/weak domains and competencies
  -> Recommendation Engine picks canonical next actions deterministically
  -> Agentic Study Coach explains the plan from deterministic recommendations
  -> Aggregated weakness/coverage signals may enqueue AuthoringJobs
  -> Question Authoring Agent drafts new questions only for queued gaps
  -> Human Review Gate approves/rejects drafts
  -> only published questions enter learner drills/mocks
```

## Components

### ProgressSnapshot

Purpose: deterministic state of learner readiness.

Inputs:

- submitted attempts;
- attempt answers;
- question version domain/competency;
- exam blueprint weights.

Outputs:

- overall readiness;
- per-domain readiness;
- per-competency readiness;
- weakest domain/competency;
- trend over time.

Owner phase: Phase 2. Canonical implementation card: #44.

Rule: ProgressSnapshot is a materialized view, not source of truth. It must be recomputable from attempts.

Boundary: ProgressSnapshot does **not** choose the next drill. It exposes state. The Recommendation Engine owns canonical next actions.

Open design decision for #44: snapshot recompute trigger (`on submit` vs `on read`) and trend storage (`persist snapshots` vs `derive from attempts`).

### Recommendation Engine

Purpose: choose the next best learner action without model spend.

Inputs:

- latest ProgressSnapshot;
- missed question history;
- domain weights;
- available published questions;
- fatigue/repetition guardrails.

Outputs:

- next drill filters: domain, competency, question count, onlyMissed flag;
- canonical reason code;
- fallback when not enough questions exist.

Canonical reason codes:

- `warm_up`
- `weakest_domain`
- `weakest_competency`
- `review_missed`
- `maintain_strength`
- `coverage_shortage`

Rule: Recommendation Engine is deterministic and testable. AI can explain the recommendation, but not decide the canonical next drill in v1.

Implementation note for #57: extract current inline dashboard/practice recommendation logic behind this engine while preserving existing BFF fields. Any reason-code enum used by contracts must point back to this list.

### Agentic Study Coach

Purpose: turn deterministic progress into a learner-facing study strategy.

Runtime:

- server-side only;
- uses `AgentOrchestrator` / Strands behind the application port;
- reads learner progress and approved content through tools or prefetched inputs;
- records usage and run status.

Allowed actions:

- explain why a domain is weak;
- summarize mistakes by competency;
- produce a short study plan;
- suggest how to use the next drill;
- explain approved questions and official sources.

Forbidden actions:

- publish questions;
- alter ProgressSnapshot directly;
- invent CBA facts;
- call AWS MCP or non-official docs for exam facts;
- expose tool traces as the learner UX;
- generate canonical next drill filters independently from the Recommendation Engine.

V1 recommendation: use a single-pass composition profile behind the same `AgentOrchestrator` boundary. Prefetch ProgressSnapshot, missed items, approved explanations, sources, and `getRecommendation(learnerId)` deterministically, then ask the model to explain and format the strategy. Reserve multi-step Strands tool loops for authoring workflows unless a later eval proves value on the learner path.

Plan rule: every action in an AI-generated study plan must trace back to a deterministic recommendation reason code. V1 plans are stateless derived artifacts, not persisted `StudyPlan` entities. Persist a StudyPlan only after plans become editable, trackable, or user-acknowledged.

### Question Authoring Agent

Purpose: create draft questions when there is a coverage gap or a weak-domain shortage.

Inputs:

- exam blueprint;
- official source map;
- item-writing rules;
- existing approved question bank;
- aggregated/anonymized coverage and weakness signals;
- queued AuthoringJob reason.

Outputs:

- draft `QuestionVersion`s;
- source refs;
- provenance metadata;
- uncertainty notes;
- duplicate-risk notes.

Rule: Draft only. The authoring agent never publishes to learners.

Execution rule: learner requests can enqueue a deterministic shortage signal, but they must not invoke the authoring agent synchronously. The authoring agent runs through admin, batch, or operator-approved workflows.

Tool rule: authoring tools may read sources, inspect existing questions, check duplicates, validate schema, and write drafts. They must not publish.

### Human Review Gate

Purpose: make reviewed content the only learner-visible content.

Inputs:

- draft QuestionVersion;
- source refs;
- validation warnings;
- provenance and agent run record;
- coverage/weak-domain reason;
- duplicate-risk notes.

Decisions:

- approve -> publish;
- reject -> rejected;
- request changes -> new draft version.

Rule: there is no autonomous publish path.

Structural enforcement expected in #60:

- one use case, `ApproveQuestionVersion`, is the only code path allowed to write `status: published`;
- approval requires a human admin identity (`decidedBy`) and a ReviewDecision;
- generated/service principals cannot approve their own output;
- CI should include a guard test that fails if any other route/function writes published status;
- source drift or stale provenance must re-enter the review gate.

### AgentRunRepository / AIUsageEvent

Purpose: audit model/tool work and cost.

Record:

- run id;
- request id / correlation id;
- learner/admin context where allowed;
- provider/model/tier;
- promptTemplateId/version;
- hash of relevant input context, avoiding full learner PII where possible;
- tool calls;
- status/error;
- token usage;
- cost class: learner_coach, authoring, review_assist, ops;
- linked output: study strategy, draft question, review suggestion, or none.

Rule: usage records are internal operational data. Do not leak provider internals to learners.

### UsageBudget Policy

Purpose: enforce AI spend and rate limits before they become a billing problem.

Inputs:

- aggregate AIUsageEvent data;
- learner/admin identity or tenant when available;
- cost class;
- environment;
- daily/monthly limits;
- operator kill-switches.

Outputs:

- allow;
- deny with `429 COACH_RATE_LIMITED` or an admin/operator equivalent;
- warn / degrade to deterministic mode.

Rule: AgentRunRepository is the audit trail; UsageBudget is the enforcement layer. Do not rely on audit after the fact as the only control.

## Tool Allowlist by Cost Class

- `learner_coach`: read-only tools only; ProgressSnapshot, Recommendation Engine, missed review, approved sources.
- `authoring`: read official sources, inspect bank, check duplicates, validate drafts, write draft QuestionVersions / AuthoringJobs.
- `review_assist`: read drafts, validations, sources, provenance, and suggested fixes; no publish.
- `ops`: readiness, usage summaries, health checks; no exam-fact authority.

## Data Flow Boundaries

```text
Browser
  -> Web BFF
    -> Progress / Recommendation use cases
    -> Coach use case
      -> AI Orchestration Service
        -> Strands / ModelProvider / ToolRegistry
        -> AgentRunRepository
        -> UsageBudget
    -> Authoring use cases (admin only)
      -> AuthoringJob
      -> AI Orchestration Service
      -> Human Review Gate
```

The browser reaches only the BFF. The AI Orchestration Service is internal.

## MVP Sequencing

1. #44 ProgressSnapshot and progress screen.
2. #57 Deterministic Recommendation Engine.
3. #62 Third-pass BFF contracts for study plan shape and admin review actions.
4. #58 Agentic Study Coach strategy mode using Strands, starting with single-pass composition.
5. #63 Eval/grounding harness for AI coach responses and authoring drafts.
6. #61 Agent run/usage reporting and #64 UsageBudget enforcement.
7. #59 Question Authoring Agent for weak-domain/coverage gaps.
8. #60 Human Review Gate integration for generated drafts.

## Success Signals

- learner can see their weakest domain and competency;
- next drill improves after each submitted attempt;
- coach explains recommendations using approved facts and sources;
- every AI study-plan action maps back to a deterministic recommendation reason code;
- weak-domain shortages create draft authoring tasks, not learner-visible AI questions;
- every model/tool run is auditable and budget-checked;
- no paid AI call is required for the deterministic learner loop.

## Related Artifacts

- `docs/product/saas-data-model.md`
- `docs/product/web-bff-contracts.md`
- `docs/product/cba-web-mvp-scope.md`
- `docs/wiki/AI-Agent-Strategy.md`
- `spec/product-roadmap.md`
- `spec/domain-driven-design.md`
