---
description: Validate and audit the CBA question bank (schema, coverage, quality, dead source links).
allowed-tools: Bash(node:*)
---

Audit this repo's CBA question bank and report issues.

1. Run `node bin/cli.js validate` and `node bin/cli.js stats`; summarize the output.
2. Coverage: compare per-domain and per-competency counts against `spec/exam-blueprint.md`. Flag
   competencies with too few questions or missing difficulty levels.
3. Quality spot-check (sample ~10 across domains against `spec/item-writing-rules.md`): more than one
   defensible answer, give-away phrasing, "All/None of the above", non-parallel options, or an
   `explanation` that doesn't match the `answer`.
4. Grounding: flag any `source` URL that looks wrong for its claim; WebFetch a few to confirm.
5. Output a prioritized fix list. Do not change files unless I ask.
