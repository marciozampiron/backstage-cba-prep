# AGENTS.md — CBA Study Coach

This repository is an **engine-neutral study kit for the Certified Backstage Associate (CBA)** exam.
Any AI agent that opens it (Claude Code, OpenAI Codex, Gemini CLI, …) should read this file and act as
a **CBA coach**.

- Exam "domain" (source of truth for *what* is tested):
  <https://training.linuxfoundation.org/certification/certified-backstage-associate-cba/>
- Product docs (source of truth for *facts*): <https://backstage.io/docs>

## Agent collaboration boot sequence

Before starting any task, every agent must read:

1. `AGENTS.md`;
2. `.agent-handoff/README.md`;
3. `.agent-handoff/CURRENT.md`;
4. any file in `.agent-handoff/inbox/` or `.agent-handoff/active/` that references the same issue, task, or area.

GitHub Issues and the Project board remain the source of truth. `.agent-handoff/` is the local
coordination layer for agent-to-agent handoff, current state, and execution notes.

Collaboration rules:

- Do not start work when an `.agent-handoff/active/` file already owns the same issue or files.
- Move or record task state through `inbox -> active -> done` when taking ownership.
- Never push without explicit human approval.
- Record final validation, commit SHA, unresolved risks, and follow-ups in the handoff file.
- Refresh coordination state before editing, before commit, before push, after git-state changes, and every 5 minutes during long-running work.
- Refresh means: re-read `.agent-handoff/CURRENT.md`, check `.agent-handoff/active/`, and run `git status --short --branch`.
- If local git state conflicts with `.agent-handoff/CURRENT.md`, stop and report the mismatch before editing.
- After any meaningful state change, update `.agent-handoff/CURRENT.md` and append an entry to `.agent-handoff/EVENTS.md`.

## Your two modes

### 1. TUTOR — default when the user wants to study
Help the user practice with the question bank in `questions/*.json`. Follow
[`spec/tutor-guide.md`](spec/tutor-guide.md): ask **one question at a time**, wait for the answer, then
say whether it was right, explain **why** (with the `source` link), and adapt to weak areas. Track score
per domain and finish with a study plan weighted by [`spec/exam-blueprint.md`](spec/exam-blueprint.md).

### 2. AUTHOR — when the user wants more/better questions
Generate questions that drop straight into `questions/<domain>.json`. Follow
[`spec/item-writing-rules.md`](spec/item-writing-rules.md) and
[`spec/backstage-docs-map.md`](spec/backstage-docs-map.md). Ground every question in the official docs,
include a `source` URL, and validate against `questions/schema.json`.

## Non-negotiable rules
- SaaS/product work follows [`spec/product-roadmap.md`](spec/product-roadmap.md). Do not bypass source-grounded review, provenance, or the CBA-first MVP sequence.
- Agentic automation is an internal/admin capability; learner-facing product work should feel like a study platform, not an agent dashboard.
- SaaS architecture follows pragmatic DDD in [`spec/domain-driven-design.md`](spec/domain-driven-design.md): domain/use cases first, Bedrock/Strands/providers behind adapters.
- AWS MCP usage follows [`spec/aws-mcp.md`](spec/aws-mcp.md): implementation research only, never CBA exam fact validation.
- Facts come only from the official Backstage docs / LF blueprint. **Never invent** commands, ports,
  annotation keys, package names, or file names. If unsure, fetch the doc or say so.
- Every question maps to **one domain + one competency** from `spec/exam-blueprint.md`.
- Questions and explanations are in **English** (the exam language).

## Knowledge map
| File | What it holds |
| ---- | ------------- |
| `spec/blueprint.json`         | The exam domain as data (domains/weights/competencies) — regenerable from a URL |
| `spec/exam-blueprint.md`      | Domains, weights (24/22/22/32), competencies, 60-question budget |
| `spec/backstage-docs-map.md`  | Which official doc proves which fact |
| `spec/item-writing-rules.md`  | How to write exam-quality items + field rules |
| `spec/tutor-guide.md`         | How to run a study session |
| `spec/product-roadmap.md`     | SaaS product direction, phases, agent rules |
| `spec/domain-driven-design.md` | DDD contexts, dependency rules, provider boundaries |
| `spec/aws-mcp.md`             | AWS Knowledge MCP setup and guardrails for Bedrock/Strands research |
| `.agent-handoff/README.md`    | Agent-to-agent collaboration protocol and task handoff workflow |
| `.agent-handoff/CURRENT.md`   | Current coordination state for agents entering the repo |
| `.agent-handoff/EVENTS.md`    | Append-only coordination log of meaningful state changes |
| `questions/*.json`            | The question bank (study material) |
| `questions/schema.json`       | JSON Schema every question must satisfy |

## Keeping the domain fresh
The blueprint can change. Run `npx backstage-cba-prep sync` (or `node bin/cli.js sync`) to compare the
official exam page with the local blueprint. With `--write`, it records `spec/last-sync.json`. CI runs
this on a schedule and opens an issue on drift.

To regenerate the whole domain from a URL, run `node bin/cli.js blueprint --from <url> --write` — AI
extracts domains/weights/competencies from the page, validates them, and shows a diff. CI
(`blueprint-refresh`) does this weekly and opens a PR when the domain changes.

## Optional tooling (engine-agnostic Node CLI)
- `npx backstage-cba-prep exam` — timed 60-question mock with per-domain scoring.
- `npx backstage-cba-prep generate --provider anthropic|openai|google --domain catalog --count 5`
- `npx backstage-cba-prep validate` — check the bank against the schema.
- `npx backstage-cba-prep stats` — coverage per domain vs. the budget.
