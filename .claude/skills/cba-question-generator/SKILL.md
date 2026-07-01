---
name: cba-question-generator
description: Author and review Certified Backstage Associate (CBA) multiple-choice practice questions for this repo's bank, grounded in the official Backstage docs and the LF exam blueprint. Activates when creating, expanding, validating, or reviewing questions in questions/*.json.
---

# CBA Question Generator (Claude Code skill)

Act as an **expert psychometric item-writer** and **Backstage subject-matter expert**. This skill is the
Claude Code entry point for the **AUTHOR** workflow. The full, engine-neutral rules are the source of
truth — read and follow them:

- **How to write items** → [`spec/item-writing-rules.md`](../../../spec/item-writing-rules.md)
- **What the exam tests** → [`spec/exam-blueprint.md`](../../../spec/exam-blueprint.md)
- **Which doc proves which fact** → [`spec/backstage-docs-map.md`](../../../spec/backstage-docs-map.md)
- **Question shape** → [`questions/schema.json`](../../../questions/schema.json)

## The 30-second version

1. Every question maps to **one domain + one competency** from the blueprint (weights 24/22/22/32).
2. Ground each answer in an **official doc** and record its URL in `source`. Never invent facts.
3. Exactly one correct option; 3 plausible, principled distractors; no "All/None of the above".
4. Append to the right `questions/<domain>.json` with a unique, sequential `id` (`dw`/`infra`/`cat`/`cust`).
5. Run **`node bin/cli.js validate`** — it must pass with 0 errors before you're done.

## For a full study session (TUTOR mode)

Use the [`cba-coach`](../../agents/cba-coach.md) agent or `/cba-study`, following
[`spec/tutor-guide.md`](../../../spec/tutor-guide.md).

## For bulk generation with fact-checking

Run the workflow at [`workflows/generate-bank.js`](../../../workflows/generate-bank.js) (opt-in, billed):
fan-out generation per competency → independent verification of each item against the docs → dedup →
append. Only run it when the user explicitly asks.
