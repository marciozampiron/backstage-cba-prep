# Domain-Driven Design Posture

This project should use pragmatic Domain-Driven Design for the SaaS product path. The current CLI can stay simple, but new web, API, persistence, and agentic work should preserve a clean domain model.

## Intent

The product domain is certification practice, not AI orchestration. Agents, model providers, AWS services, and frameworks are implementation details that support the domain.

Use DDD to keep these decisions explicit:

- learner workflows are modeled as exam practice and progress;
- authoring workflows are modeled as content review and provenance;
- approved content is domain state, not an LLM response;
- external services are adapters behind application ports.

## Bounded contexts

### Exam Content

Owns the official exam structure and approved content.

- Exam
- ExamDomain
- Competency
- Source
- Question
- QuestionVersion

Rules:

- Every QuestionVersion must map to one ExamDomain and one Competency.
- Publishable questions must cite approved official sources.
- Attempts reference QuestionVersion, never a mutable Question draft.

### Simulation

Owns learner practice sessions and scoring.

- MockExam
- DomainDrill
- Attempt
- AttemptAnswer
- Score

Rules:

- Scoring must be deterministic.
- The simulator must work without AI.
- Attempt records preserve the question version, answer selected, correctness, and timing.

### Learner Progress

Owns mastery tracking and study planning.

- LearnerCompetencyState
- WeakArea
- StudyPlan
- Recommendation

Rules:

- Progress calculations are deterministic first.
- AI can explain recommendations, but should not be the source of score or mastery state.
- Recommendations should point to domains, competencies, and approved sources.

### Authoring and Review

Owns draft creation, review workflow, and approval.

- DraftQuestion
- ReviewTask
- ReviewDecision
- RejectionReason
- Approval

Rules:

- AI-generated content starts as DraftQuestion.
- Human review is required before learner exposure.
- Review decisions must keep source evidence close to the draft.

### Source Provenance

Owns evidence, drift checks, and source health.

- SourceCheck
- SourceDrift
- Evidence
- ProvenanceRecord

Rules:

- Source drift can reopen review for affected QuestionVersions.
- Dead sources block publication until resolved.
- Bot-blocked or rate-limited sources are operational warnings, not automatic content failures.

### AI Agent Orchestration

Owns agent runs, tool calls, usage accounting, and provider abstraction.

- CoachRequest
- AuthoringJob
- AgentRun
- ToolCall
- AIUsageEvent

Rules:

- Agents call application use cases; they do not mutate domain state or database tables directly.
- Bedrock, Strands, OpenAI, Anthropic, Google, and other providers live behind ports/adapters.
- Tool access should be scoped to the use case being executed.
- Agent traces are operational evidence, not approved content.

### Billing

Owns subscription and entitlement rules after learner value is proven.

- Subscription
- Entitlement
- UsageLimit
- InvoiceEvent

Rules:

- Billing must not decide content correctness or learner mastery.
- AI usage limits should be enforced through application use cases, not provider-specific code.

## Dependency rule

Preferred direction:

```txt
interfaces -> application -> domain
infrastructure -> application/domain ports
```

Forbidden direction:

```txt
domain -> infrastructure
domain -> Bedrock/Strands/OpenAI/etc.
domain -> web framework/database SDK
```

Application use cases orchestrate domain entities, repositories, policies, and provider ports. Infrastructure implements those ports.

## Future code shape

Use this shape when the SaaS codebase starts:

```txt
src/domain/
  exam-content/
  simulation/
  learner-progress/
  authoring-review/
  source-provenance/
  ai-orchestration/
  billing/

src/application/
  use-cases/
  ports/

src/infrastructure/
  bedrock/
  strands/
  database/
  official-sources/
  github/

src/interfaces/
  cli/
  api/
  web/
```

The current CLI does not need to be reshaped immediately. Apply this structure when adding persistence, web/API flows, or production agent orchestration.

## Provider stance

AWS Bedrock and Strands are good candidates for production agent capabilities, especially authoring and review automation. They should remain replaceable adapters.

Use them for:

- source ingestion and extraction;
- draft question generation;
- source and schema validation support;
- review queue preparation;
- grounded learner coaching.

Do not use them for:

- storing approved question state;
- calculating deterministic scores;
- deciding final review approval;
- defining the product language shown to learners.

## Naming note

The exam also uses the word "domain". In code, prefer `ExamDomain` or `ExamSection` when the meaning is an exam blueprint area. Reserve "domain" alone for the DDD/product domain when ambiguity matters.
