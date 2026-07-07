# Product Vision

## Mission

Build a source-grounded certification simulation platform that helps learners practice, understand weak areas, and improve with trustworthy AI assistance.

## Starting Point

The first supported exam is Certified Backstage Associate (CBA). CBA remains the proving ground for:

- exam simulation workflows;
- domain and competency coverage;
- review quality;
- adaptive progress modeling;
- grounded AI coaching;
- agentic authoring controls.

## Adaptive Study Differentiator

The SaaS differentiator is not only generating questions. It is the loop where submitted attempts become ProgressSnapshots, deterministic recommendations pick the next drill, Strands explains a grounded study strategy, weak-domain shortages create draft authoring work, and the Human Review Gate decides what becomes learner-visible. The short implementation spec is `spec/ai-adaptive-study-strategy.md`.

## Expansion Path

After CBA learner workflows prove value, the platform should become a generic exam engine for other certifications. Generic support must not come before the CBA loop is stable.

## Product Principles

- CBA first; multi-cert later.
- Official sources are the trust boundary.
- AI drafts content; humans approve content.
- Deterministic progress comes before LLM personalization.
- Learners see study and progress workflows.
- Agentic automation stays in internal/admin authoring workflows.
- Billing comes after quality, retention, and learner value.

## User Groups

- Learner: practices, reviews explanations, follows study plans.
- Reviewer: verifies generated or edited questions against official sources.
- Author/admin: manages exams, sources, drafts, and published content.
- Operator: manages cost, provider configuration, auditability, and releases.

## Success Signals

- Learners complete mock exams and return.
- Weak-domain scores improve across attempts.
- Published questions have source and review coverage.
- AI usage is explainable, metered, and bounded.
- New exam creation can reuse the same engine without bypassing governance.
