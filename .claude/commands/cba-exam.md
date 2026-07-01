---
description: Run a full timed 60-question CBA mock exam with per-domain scoring.
argument-hint: "[count] [minutes]"
allowed-tools: Bash(node:*)
---

Run a full CBA mock exam. Prefer the real timed simulator:

```bash
node bin/cli.js exam --count ${1:-60} --minutes ${2:-90}
```

If the user would rather do it conversationally here, run an inline mock instead: sample
`${1:-60}` questions from `questions/*.json` weighted by `spec/exam-blueprint.md` (14/13/13/20 for 60),
ask them one at a time without revealing answers, then score per domain and summarize readiness vs. the
75% default target with a study plan. Ask which they prefer if it's unclear.
