# backstage-cba-prep

**An engine-neutral study kit for the [Certified Backstage Associate (CBA)](https://training.linuxfoundation.org/certification/certified-backstage-associate-cba/) exam.**
One doc-grounded question bank, a timed mock-exam simulator, and an AI study coach that works the same
in **Claude Code**, **OpenAI Codex**, and **Gemini CLI**.

> ⚠️ **Unofficial.** Community study material. Not affiliated with, endorsed by, or sponsored by The
> Linux Foundation, the CNCF, Spotify, or the Backstage project. All facts are grounded in the official
> [Backstage documentation](https://backstage.io/docs); always confirm against the source links.

---

## Why this design

The capability (coach + author) lives in **engine-neutral files** so every AI CLI reads the *same brain*:

| Layer | Files | Read by |
| ----- | ----- | ------- |
| **Brain** (rules, blueprint, grounding, tutor guide) | `spec/*.md` | everyone |
| **Question bank** (the study material) | `questions/*.json` | everyone + the CLI |
| **Agent brief** (open standard) | `AGENTS.md` | **Codex** (native) · **Gemini** (via `.gemini/settings.json`) |
| **Claude layer** | `CLAUDE.md`, `.claude/` (skill, `cba-coach` agent, `/cba-*` commands) | **Claude Code** |
| **Tooling** (simulator, generator, sync) | `bin/`, `src/` | any terminal (`npx`) |

One brain, three doors. Switch engines without rewriting anything.

---

## Quickstart

### 1. Practice — timed mock exam (no AI, no install beyond Node ≥ 18)

```bash
npx backstage-cba-prep exam                    # full 60-question, 90-min mock
npx backstage-cba-prep exam --domain catalog   # drill one domain
npx backstage-cba-prep stats                   # see bank coverage
npx backstage-cba-prep history                 # review saved attempts
```

Scores per domain against the real exam weights and lists every missed question with an explanation and
the official doc link.

### 2. Study with an AI coach

Clone the repo and open it with your engine of choice — each auto-loads the coach:

```bash
git clone <your-fork-url> && cd backstage-cba-prep

claude        # Claude Code  → reads CLAUDE.md + .claude/  (try /cba-study)
codex         # OpenAI Codex → reads AGENTS.md natively
gemini        # Gemini CLI   → reads AGENTS.md via .gemini/settings.json
```

Then say *"quiz me on the Catalog domain"* or *"run a full mock and coach me on my weak areas."* The
coach asks one question at a time, explains every answer with a source, and ends with a study plan.

### 3. Generate new questions (multi-provider)

```bash
export ANTHROPIC_API_KEY=...   # or OPENAI_API_KEY / GOOGLE_API_KEY
npx backstage-cba-prep generate --provider anthropic --domain customizing --count 5
npx backstage-cba-prep generate --provider openai    --domain catalog     --count 5
npx backstage-cba-prep generate --domain infrastructure --dry-run   # print the prompt, call nothing
```

Or, inside an AI CLI, use AUTHOR mode (`/cba-generate customizing 5` in Claude) — same rules, grounded
in the docs. For a fact-checked batch, run the Workflow at
[`workflows/generate-bank.js`](workflows/generate-bank.js) (Claude Code, opt-in).

---

## CLI reference

| Command | What it does |
| ------- | ------------ |
| `exam` | Timed mock with per-domain scoring. `--count`, `--minutes`, `--domain`, `--pass`, `--no-timer`, `--no-shuffle`, `--no-save` |
| `generate` | Author questions via an LLM. `--provider anthropic\|openai\|google`, `--domain`, `--count`, `--model`, `--dry-run` |
| `validate` | Check the whole bank against `questions/schema.json` (supports `--json`) |
| `stats` | Coverage per domain and competency vs. the 60-question budget (supports `--json`) |
| `sync` | Compare local blueprint weights with the live LF page; exits `3` on drift |
| `blueprint` | Regenerate the domain (`spec/blueprint.json`) from a source URL via AI. `--from`, `--provider`, `--write`; exits `3` when a change is proposed |
| `audit-sources` | HTTP-check every question's `source` URL; supports `--json`; exits `2` only on dead links (404/410), soft on 403/429/5xx/network |
| `review-bank` | Human semantic review queue for answer/source correctness. `next`, `--domain`, `--json` |
| `history` | Show your past exam attempts and progress over time (supports `--json`) |

All commands run with zero runtime dependencies (Node built-ins only). Exam attempts are saved by default to `~/.backstage-cba-prep/history.json`; pass `--no-save` to disable that for a run. Review state is stored in `spec/review-ledger.json`; set `CBA_REVIEW_LEDGER_FILE` to use another ledger path for local experiments/tests.

---

## Exam blueprint

60 multiple-choice questions · 90 minutes. Domain weights drive scoring and the question budget:

| Domain | Weight | Q in a 60-mock |
| ------ | ------ | -------------- |
| Backstage Development Workflow | 24% | 14 |
| Backstage Infrastructure | 22% | 13 |
| Backstage Catalog | 22% | 13 |
| Customizing Backstage | 32% | 20 |

Full competencies live in [`spec/exam-blueprint.md`](spec/exam-blueprint.md).

---

## Keeping the domain fresh

The exam domain (domains, weights, competencies) lives as data in
[`spec/blueprint.json`](spec/blueprint.json). Two layers of automation keep it current:

- **`sync`** (no API key) re-fetches the official page and flags weight drift; the
  [`sync-domain`](.github/workflows/sync-domain.yml) Action runs weekly and opens an issue on drift.
- **`blueprint --from <url>`** regenerates the whole domain from a source page using AI, validates it,
  and shows a diff (`--write` applies it). The
  [`blueprint-refresh`](.github/workflows/blueprint-refresh.yml) Action runs weekly and opens a
  **pull request** when the domain changes — automatic, but you review the diff before merging.

---

## Repo layout

```text
spec/            engine-neutral brain (blueprint, docs-map, item rules, tutor guide, product roadmap)
questions/       the question bank (JSON) + schema
AGENTS.md        agent brief (Codex native; Gemini via .gemini/settings.json)
CLAUDE.md        Claude Code entry pointer
.claude/         Claude skill, cba-coach agent, /cba-* commands
.gemini/         Gemini CLI settings (reads AGENTS.md)
bin/            the npx CLI entrypoint
src/lib/        CLI-facing adapters and compatibility facades
src/domain/     pure domain rules for exam content and simulation
src/application/ application-level question bank use cases
workflows/       Claude Code Workflow for fact-checked bulk generation
test/            Node test runner coverage for core CLI behavior
.github/         CI to validate quality and keep the blueprint in sync
```

## Product direction

The SaaS direction lives in [`spec/product-roadmap.md`](spec/product-roadmap.md). It defines the CBA-first web MVP, adaptive progress model, AI coach, authoring pipeline, content provenance, generic exam engine, and billing sequence. Product posture: agentic inside, study product outside. Learners should see certification practice and progress workflows; agentic automation belongs mainly to internal services and admin/authoring surfaces. Architecture posture lives in [`spec/domain-driven-design.md`](spec/domain-driven-design.md): domain/use cases first, providers behind adapters.

## Contributing questions

Every question must map to one domain + one competency from the blueprint, have exactly one correct
answer, and cite an official doc in `source`. See [`spec/item-writing-rules.md`](spec/item-writing-rules.md),
then run `node bin/cli.js validate` and `npm test` before opening a PR.

## License

[MIT](LICENSE) © 2026 Marcio Zampiron
