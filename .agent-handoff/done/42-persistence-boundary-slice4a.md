# Task: #42 Implement #11 slice 4a — persistence boundary for Web MVP attempts

## Owner

- Agent: Claude (executor)
- Human gate: required before push

## Source of truth

- GitHub issue: #42 (slice 4a of #11; part of #33; model shapes from #16; scope per #15)
- Runtime: `docs/adr/0002-cloudflare-nextjs-aws-bff.md` (repositories behind ports; DynamoDB later)
- Code base: `web/lib/*`, `web/app/**` (slices 1–3 pushed; origin/main at `f93ec34`)

## Context

Slices 1–3 keep all simulation state in process memory. Slice 4a introduces the repository
boundary: the store (application layer) talks to a `SimulationRepository` port; local adapters are
in-memory (ephemeral) and JSON-file (restart-safe, atomic write-through). Records are plain
JSON-serializable and learner-scoped, so DynamoDB can replace the adapter without touching callers.
Every BFF contract and all deterministic behavior stay identical.

## Do

- `web/lib/repository.js` — port + `InMemorySimulationRepository` + `FileSimulationRepository`
  (atomic tmp+rename write-through; corrupt-file safe), factory via `CBA_WEB_STORE=file|memory`
  (default `file`) and `CBA_WEB_DATA_DIR` (default `web/.data`, gitignored).
- Refactor `web/lib/store.js` to be repository-backed (answers become plain objects keyed by index
  — JSON-safe records); explicit write-through after every mutation.
- Committed regression `web/scripts/smoke-restart-persistence.mjs` (spawns the server twice on a
  temp data dir; attempts survive the restart).
- README persistence section; `.data/` in `web/.gitignore`.

## Do not

- No route/page changes (routes keep calling store functions; pages keep fetching) — repository is
  never imported outside `lib/`.
- No Cognito, AI, admin, schema, or question-bank changes.
- No push without explicit human approval; root `.gitignore` and the EVENTS.md local audit untouched.

## Validation

- `npm run agent-refresh`; root `npm test`; `node bin/cli.js validate`; `git diff --check`
- `web`: `npm run build`; 4 existing smokes on a fresh ephemeral server (`CBA_WEB_STORE=memory`);
  new restart-persistence smoke (file adapter)

## Work log

- Assumed by Claude (executor). Boot ok; origin/main `f93ec34`; no active handoffs. Canonical issue is #42; a duplicate #45 was opened by the executor before learning it — flagged for closure by the human.
- `lib/repository.js` (new): SimulationRepository port with two adapters —
  `InMemorySimulationRepository` (ephemeral) and `FileSimulationRepository` (JSON file, atomic
  tmp+rename write-through, corrupt-file tolerant: a bad file is set aside as `.corrupt` and the
  app starts fresh). Factory: `CBA_WEB_STORE=file|memory` (default `file`), `CBA_WEB_DATA_DIR`
  (default `web/.data/`, added to `web/.gitignore`).
- `lib/store.js` refactored to the repository: all Maps removed; `answers` became plain objects
  keyed by index (records fully JSON-serializable); explicit `saveAttempt`/`saveMock`/`saveSession`
  write-through after every mutation (incl. lazy mock-expiry finalization). Zero behavior change —
  same contracts, same deterministic logic, same error semantics.
- Committed regression `web/scripts/smoke-restart-persistence.mjs`: self-orchestrating (spawns
  `next start` twice on a temp data dir) — attempt survives restart, dashboard not first-run,
  identical deterministic score, missed review intact.
- README: persistence section (modes, smoke guidance, DynamoDB/Cognito seam).
- Verified: build clean; restart-persistence smoke ALL PASS (file adapter); the 4 existing smokes
  ALL PASS on an ephemeral `CBA_WEB_STORE=memory` server; isolation check — `repository.js` is
  imported ONLY by `lib/store.js` (no route/page touches it).
- Moved this handoff `active/` → `done/`.
- Architect review pass (amended into the same commit): canonical issue corrected `#45 → #42`
  everywhere (this handoff renamed from `done/45-...` via `git mv`, `repository.js`,
  `smoke-restart-persistence.mjs`); the duplicate issue #45 opened by the executor is flagged for
  human closure. Turbopack/NFT build warning eliminated — the file adapter's dynamic fs/path calls
  now carry `turbopackIgnore` comments and the default data path is statically scoped
  (`<web>/.data/simulation.json`); build is warning-free. `web/README.md` rewritten for slices
  1–4a (real: drill, mock, review/coach, persistence; remaining stubs: Cognito auth, managed
  DynamoDB, coach grounded AI mode, admin/advanced progress). Re-verified: build clean with ZERO
  warnings; restart-persistence smoke ALL PASS; 4 ephemeral smokes ALL PASS.

## Final report

- Status: **DONE**; awaiting human gate for push.
- Local commit: `feat: implement #11 slice 4a persistence boundary for web attempts` (unpushed —
  resolve the current SHA with `git log --oneline origin/main..HEAD`).
- Validation result: root `npm test` 68/68; `node bin/cli.js validate` 60/0; `git diff --check`
  clean; `agent-refresh` ok; web build clean; 5/5 smokes ALL PASS (4 existing + restart regression).
- Push/CI status: **not pushed** — pending human gate.
- Remaining risks/follow-ups:
  - File adapter is single-writer (one server process) — correct for the pilot; the managed
    adapter (DynamoDB, ADR-0002) owns concurrency later.
  - Records already carry `learnerId` and the repository filters by it — slice 4b (Cognito) swaps
    `STUB_LEARNER_ID` for session identity without touching records or routes.
  - The 4 deterministic smokes assume fresh state: run their server with `CBA_WEB_STORE=memory`
    (documented in the README).
  - Review-state records (reviewed/unreviewed filters from the prototype) ride this same boundary
    when that feature lands.
