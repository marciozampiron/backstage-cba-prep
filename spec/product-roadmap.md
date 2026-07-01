# Product Roadmap — SaaS Exam Platform

This document explains the product direction for agents working in this repository. The current project is a CBA-focused CLI/study kit, but the intended path is a source-grounded SaaS platform for certification simulations, adaptive learner progress, and agent-assisted question authoring.

## Product thesis

Build a platform where certification practice questions are trustworthy because every question is mapped to:

- one exam;
- one domain;
- one competency;
- one or more official sources;
- a reviewed question version.

AI should accelerate tutoring and authoring, but it must not become an unreviewed source of truth. The differentiator is not just generating questions; it is generating and coaching inside explicit exam domains with citations, validation, provenance, and human review.

## Current role of this repo

The repository is Phase 0: the engine-neutral CBA core.

It already provides:

- official CBA blueprint modeling;
- source-grounded question bank;
- simulator and scoring;
- local attempt history;
- multi-provider generation prompt;
- validation, stats, JSON output, source auditing, tests, and CI;
- agent instructions shared across Codex, Claude Code, and Gemini CLI.

Do not discard this engine when building the SaaS. The web product should reuse or migrate these concepts deliberately.

## Non-negotiable product rules

1. Source-grounded content only. A question without an official source is not publishable.
2. AI-generated content starts as draft, never published content.
3. Human review is required before learner exposure.
4. Learner coaching must stay inside the exam blueprint and approved sources.
5. Learner progress should be computed deterministically first; AI can explain and personalize later.
6. Multi-cert generalization comes after the CBA web MVP proves the learner loop.
7. Billing comes after quality, retention, and learner value are measurable.

## Phases

| Phase | Name | Goal | Primary GitHub issues |
| --- | --- | --- | --- |
| 0 | CLI Core | Keep the CBA engine reliable, validated, source-grounded, and publishable through CLI/npm. | #1-#7, #9 |
| 1 | CBA Web MVP | Build the first web simulator around CBA only: dashboard, full mock, domain drill, results, study plan. | #11, #15, #16, #8 |
| 2 | Accounts + Progress | Persist user attempts, progress, adaptive mastery, and product analytics. | #13, #17, #18 |
| 3 | AI Coach | Serve a grounded study companion that uses learner progress and approved sources. | #12 |
| 4 | Authoring Pipeline | Ingest official sources, draft questions with agents, review, version, approve, and publish. | #19, #20, #21 |
| 5 | Generic Exam Engine | Generalize from CBA to multiple certifications after CBA web workflows are proven. | #10 |
| 6 | SaaS Monetization | Add subscription and AI usage metering after retention and quality are proven. | #14 |

> **#7 (review-bank) — Phase 0 (foundational); also unblocks Phase 4.** It is foundational quality work, but the same review workflow powers the Phase 4 authoring pipeline. The `Phase` board field is single-select, so on the board #7 lives in Phase 0.

## Recommended execution order

1. Finish semantic quality: #7 review-bank.
2. Define the CBA web MVP scope: #15.
3. Define the SaaS data model: #16.
4. Build the thin web simulator on the existing JSON engine: #11.
5. Add accounts and per-user progress: #13.
6. Add the adaptive study model and analytics: #17, #18.
7. Add AI coach on top of measured progress: #12.
8. Build authoring/review/provenance: #19, #20, #21.
9. Generalize to multiple exams: #10.
10. Add billing and metering: #14.

## SaaS data model direction

Agents should use these entities as the starting point when designing persistence:

- Tenant / Organization
- Learner / User
- Exam
- Domain
- Competency
- Source
- SourceCheck
- Question
- QuestionVersion
- ReviewTask
- Attempt
- AttemptAnswer
- LearnerCompetencyState
- StudyPlan
- AIUsageEvent
- Subscription / Entitlement

Important modeling constraints:

- Attempts must reference the exact QuestionVersion shown to the learner.
- QuestionVersion should preserve answer, options, explanation, difficulty, source references, and provenance metadata.
- Source drift should be able to flag affected questions for review.
- Draft/review/published/deprecated states must be explicit.
- AIUsageEvent must separate coach usage from authoring usage.

## AI roles

### AI Coach

Purpose: help learners study from approved content.

Allowed inputs:

- learner attempt history;
- domain and competency scores;
- approved questions/explanations;
- official sources from the exam content model.

Rules:

- Stay within exam domains and approved sources.
- Do not invent exam facts.
- Explain why the learner missed an item.
- Recommend the next domain/competency drill.
- Prefer deterministic progress metrics over vague conversational memory.

### AI Author

Purpose: help admins create and review new exam content.

Allowed inputs:

- official exam blueprint;
- official documentation links;
- existing approved question bank;
- item-writing rules;
- coverage gaps.

Rules:

- Draft only; never publish directly.
- Cite source URLs for every fact.
- Mark uncertainty instead of filling gaps.
- Avoid duplicates.
- Spread questions across domain, competency, difficulty, and answer position.

## UX direction

The product should start as a usable study application, not a marketing page.

For the learner surface:

- show the exam dashboard first;
- make full mock and domain drill obvious;
- keep progress by domain and competency visible;
- show source links without hiding them behind AI prose;
- make review of missed questions fast;
- avoid decorative UI that slows repeated study.

For the admin/reviewer surface:

- prioritize dense review queues;
- show validation warnings inline;
- keep source evidence close to each draft question;
- expose coverage gaps by domain/competency;
- make approve/reject/request-changes explicit.

## GitHub Project

Project: <https://github.com/users/marciozampiron/projects/3>

The project uses:

- Status: Todo / In Progress / Done
- Phase: Phase 0 through Phase 6
- Labels: shipped, roadmap, epic, saas

When creating new roadmap issues, agents should:

1. assign the correct phase;
2. include Product intent, Acceptance criteria, and Agent guidance;
3. avoid adding SaaS billing work before learner value and quality gates are implemented;
4. link implementation PRs back to the issue;
5. keep CBA as the proof case until the web MVP is working.

## Next decision point

The next strategic decision is whether to start with #7 review-bank or #15 CBA Web MVP scope.

Recommended path: finish #7 first if the goal is trust and content quality; start #15 first if the goal is product validation with users. In both cases, do not start #14 billing or #10 multi-cert generalization yet.
