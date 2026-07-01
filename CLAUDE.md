# CLAUDE.md

This project follows **[AGENTS.md](AGENTS.md)** — read it first. It defines your role as a **CBA coach**
(TUTOR + AUTHOR) and points to the engine-neutral `spec/` and the `questions/` bank.

## Claude Code extras in this repo
- **Skill** — `cba-question-generator` (auto-activates when writing/expanding the bank).
- **Agent** — `cba-coach` at [`.claude/agents/cba-coach.md`](.claude/agents/cba-coach.md); dispatch it
  for a tutoring session or bulk question authoring.
- **Commands** — `/cba-study` (tutor), `/cba-generate` (author), `/cba-exam` (full mock),
  `/cba-review` (validate + audit the bank).

Everything substantive (rules, blueprint, docs-map, bank) lives engine-neutral under `spec/` and
`questions/`, so Codex (`AGENTS.md`) and Gemini (`.gemini/settings.json`) share the exact same brain.
