# Roadmap

The GitHub Project board is the execution view. This page explains how to read it.

## Phases

| Phase | Name | Goal |
| --- | --- | --- |
| 0 | CLI Core | Keep the CBA engine reliable, validated, source-grounded, and publishable. |
| 1 | CBA Web MVP | Build the first web simulator around CBA workflows. |
| 2 | Accounts + Progress | Persist users, attempts, mastery, and analytics. |
| 3 | AI Coach | Add grounded model/provider infrastructure and learner coaching. |
| 4 | Authoring Pipeline | Ingest sources, draft questions, review, version, approve, and publish. |
| 5 | Generic Exam Engine | Generalize from CBA after the CBA loop is proven. |
| 6 | SaaS Monetization | Add subscriptions and AI usage metering after retention is proven. |

## Current Execution Rules

- Issues are the unit of work.
- The Project board owns Status and Phase.
- `spec/product-roadmap.md` owns the canonical product direction.
- Work marked Done on the board should also have its issue closed.
- Large future items should remain Todo until they are small enough to execute.

## Adaptive AI Study Track

The adaptive AI study track spans multiple phases and is summarized in `spec/ai-adaptive-study-strategy.md`:

- Phase 2: #44 ProgressSnapshot and #57 deterministic Recommendation Engine.
- Phase 3: #58 Strands-powered study strategy and #61 AgentRunRepository usage reporting.
- Phase 4: #59 weak-domain question authoring and #60 Human Review Gate enforcement.
- Cross-cutting prerequisites: #62 third-pass BFF contracts, #63 no-spend eval/grounding harness, and #64 UsageBudget/rate-limit enforcement.

Progress/recommendation stays deterministic first. AI explains, plans, and drafts; humans approve learner-visible content. Learner requests never synchronously run the authoring agent.

## Active Work

Expected active items:

- Architecture foundation.
- Bedrock/Strands adapter work.
- ModelProvider wiring for CLI authoring commands.

## Closing Criteria

Before an issue moves to Done:

- tests pass locally;
- CI is green after push;
- docs are updated when behavior or direction changed;
- no secrets or local credentials were added;
- issue acceptance criteria are satisfied or explicitly split into follow-up issues.
