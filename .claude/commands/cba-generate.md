---
description: Author new doc-grounded CBA questions and append them to the bank (AUTHOR mode).
argument-hint: "<domain: development-workflow|infrastructure|catalog|customizing> [count]"
---

Act as the **CBA item-writer** (AUTHOR mode). Read `spec/item-writing-rules.md`,
`spec/exam-blueprint.md`, and `spec/backstage-docs-map.md` first.

Task: generate new questions for domain **$1** (count: **$2**, default 5).

Requirements:
- One domain + one competency each; spread across the domain's competencies and difficulties.
- Ground every answer in an official Backstage doc; put its URL in `source`. WebFetch the doc if unsure.
- Exactly one correct option; 3 principled distractors; no "All/None of the above".
- Append to `questions/$1.json` with unique, sequential `id`s.
- Then run `node bin/cli.js validate` and fix any errors. Show me a summary of what you added.
