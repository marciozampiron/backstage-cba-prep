# Agent Coordination Events

Append meaningful coordination changes here. Newest entries should go at the top.

## 2026-07-08 — Governance cleanup (Claude)

- Dedicated governance commit collecting the local EVENTS.md audit residue accumulated since the last
  cleanup (`ed2b7bd`): the architecture-docs / adaptive-AI-strategy push, the blueprint-refresh
  Bedrock fix, and the #48/#49 CI/security foundation cycles (#52, #54, #53, and the Node 20 test-glob
  fix) — every "kept as local audit" note lands here.
- `CURRENT.md` refreshed to 2026-07-08: active priority now reflects the delivered CI/security
  foundation (#51/#52/#53/#54) and three live CI lanes; do-not-touch extended with `infra/aws/**`,
  the `.github/workflows/*`, and the security/OIDC docs; records the Node-20 tooling lesson and the
  open housekeeping (#45 duplicate, postcss advisory). No SHAs pinned.
- Also folds in the one-line `done/52` nit (a leftover empty bullet) removed earlier.
- No product code touched; no feature issues altered; local commit only — push follows the human gate.

## 2026-07-08 — Push + CI + issue closed (Claude) — #53 (+ Node 20 fix)

- Pushed: `3cb9980` (#53 scaffold) then `973fdfa` (Node 20 test-glob fix-forward). `origin/main` is now at `973fdfa`.
- CI: `3cb9980` — Infra Synth first run **success** (28908298318) + Quality(22) success, but Quality(20) FAILED (glob-pattern `--test` path needs Node >=21). `973fdfa` restored green: Quality **20 + 22** success (28908507400), CodeQL success (28908507080).
- Issue #53 closed citing both commits; board Done. CDK app live under `infra/aws/` (JS/CommonJS, owner decision): security stack encoding the #54 OIDC/Bedrock model + 5 placeholder stacks; parseArnList fixes the `-c` override char-spread bug (unit tests + CI regression); Infra Synth lane is credential-free/no-deploy; root test scoped to `test/*.test.js` to decouple infra.
- Lesson: a Node-version-dependent feature (`node --test` glob) slipped past local (Node 22) — verify CI-matrix compatibility for tooling changes. #48/#49 CI/security foundation is now implemented (#51/#52/#53/#54); remaining is human branch-protection + bootstrap runbook, and #46/#47 deploy/env.
- Kept as local audit for the next governance cleanup.

## 2026-07-08T00:30:38Z — agent-refresh --record

- Status: ok
- Git: ## main...origin/main [ahead 1]
- Unpublished commits:
  - 973fdfa ci: scope root test glob for Node 20 compatibility
- Active handoffs: none
- Warnings: none
- Errors: none

## 2026-07-08 — Human gate (push approved) — #53 Node 20 CI fix

- Context: `3cb9980` (#53) went green on Infra Synth + Quality(22) but FAILED Quality(20) — the root `npm test` was changed to `node --test 'test/**/*.test.js'`, and glob-pattern paths need Node >=21 (matrix runs 20 + 22). Main is red until fixed.
- Human gate: approved push for `973fdfa ci: scope root test glob for Node 20 compatibility` (one-line: shell-expanded glob `test/*.test.js` — version-agnostic explicit file list, still scoped to test/).
- Agent will run `npm run agent-refresh -- --record`, push only this commit, confirm Quality goes green on both Node versions, then close #53 citing `3cb9980` + `973fdfa`.
- Out of scope (not pushed): EVENTS.md audit residue + the done/52 nit — next governance cleanup.

## 2026-07-08T00:25:22Z — agent-refresh --record

- Status: ok
- Git: ## main...origin/main [ahead 1]
- Unpublished commits:
  - 3cb9980 feat: scaffold AWS CDK app with synth-only validation for #53
- Active handoffs: none
- Warnings: none
- Errors: none

## 2026-07-07 — Human gate (push approved) — #53

- Human gate: approved push for #53, commit `3cb9980 feat: scaffold AWS CDK app with synth-only validation for #53` (CDK v2 app in JS under infra/aws/: security stack encoding the #54 OIDC/Bedrock model + 5 placeholder stacks, synth-only CI lane; architect review fixes amended: parseArnList override bug fixed with unit tests + CI regression, root npm test scoped to decouple infra; JS-over-TS accepted as a documented owner decision).
- Agent will run `npm run agent-refresh -- --record` immediately before push, then push only this commit, follow Quality + the first real Infra Synth run + CodeQL, and close #53 if green.
- Out of scope (not pushed): the EVENTS.md audit residue and the one-line done/52 nit fix — both fold into the next governance cleanup.

## 2026-07-07 — Push + CI + issue closed (Claude) — #54

- Pushed the approved scope: `ae586ba..3271c78` (`3271c78 docs: define AWS bootstrap and IAM/OIDC model for #54`). `origin/main` is now at `3271c78`.
- CI green: Quality (28903912968) and CodeQL (28903912706); Web Quality correctly did not trigger (docs-only).
- Issue #54 was closed in parallel by the human/Codex while CI was being watched; the delivery comment citing `3271c78` was posted separately (close-with-comment no-ops on an already-closed issue). Board item Done.
- AWS bootstrap + IAM/OIDC model live in `docs/architecture/aws-bootstrap-and-oidc.md`: OIDC provider (no manual thumbprint — architect blocker fixed), blueprint-refresh Bedrock role trust/permission policy JSON (Converse→InvokeModel, inference profile + routed model ARNs, region-locked), vars/secrets, 8-step runbook, CDK target, no-spend verification. Define only — no AWS resources created.
- #48 security track: #51 ✅ #52 ✅ #54 ✅. Remaining: human applies branch protection + runs the bootstrap runbook; #53 (CDK synth lane); #49/#47 (IaC/env foundation). Kept as local audit for the next governance cleanup.

## 2026-07-07T22:45:21Z — agent-refresh --record

- Status: ok
- Git: ## main...origin/main [ahead 1]
- Unpublished commits:
  - 3271c78 docs: define AWS bootstrap and IAM/OIDC model for #54
- Active handoffs: none
- Warnings: none
- Errors: none

## 2026-07-07 — Human gate (push approved) — #54

- Human gate: approved push for #54, commit `3271c78 docs: define AWS bootstrap and IAM/OIDC model for #54` (new `aws-bootstrap-and-oidc.md`: OIDC provider definition, blueprint-refresh Bedrock role with trust + least-privilege permission policy JSON [Converse→InvokeModel over inference profile + routed model ARNs, region-locked], vars/secrets, 8-step bootstrap runbook, CDK target for #49/#53, no-spend verification; architect blocker fixed: thumbprint placeholder removed — flag is optional per official AWS docs).
- Agent will run `npm run agent-refresh -- --record` immediately before push, then push only this commit, follow Quality/CodeQL, close #54 citing `3271c78`, and confirm the board is Done.
- Out of scope (not pushed): the EVENTS.md audit residue and the one-line `done/52` nit fix — both fold into the next governance cleanup.

## 2026-07-07 — Push + CI + issue closed (Claude) — #52

- Pushed the approved scope: `962218c..ae586ba` (`ae586ba docs: define GitHub security baseline and AWS OIDC roles for #52`). `origin/main` is now at `ae586ba`.
- CI green: Quality (28897034189) and CodeQL (28897033652); Web Quality correctly did not trigger (docs-only, no web paths).
- Issue #52 closed with the delivery summary and acceptance checklist; board item Done.
- GitHub security baseline live in `docs/architecture/github-security-and-oidc-baseline.md`: branch protection + required checks + Web Quality path-filter caveat, least-privilege permissions, Environments, AWS OIDC role catalog/trust boundaries, vars/secrets registry, secret hygiene, Dependabot/scanning posture. Design only — nothing applied.
- Post-close nit: removed a leftover empty `- Remaining risks/follow-ups:` bullet at the end of `done/52-github-security-oidc.md` (architect-flagged, cosmetic). Fixed locally to fold into the next commit, not a dedicated push cycle — so the working tree now also carries this one-line handoff fix alongside the EVENTS.md audit residue.
- Next in the #48 track: apply branch protection ruleset (human) choosing Option A/B; #54 (AWS OIDC provider + roles); #53 (CDK synth lane). Kept as local audit for the next governance cleanup.

## 2026-07-07T20:38:00Z — agent-refresh --record

- Status: ok
- Git: ## main...origin/main [ahead 1]
- Unpublished commits:
  - ae586ba docs: define GitHub security baseline and AWS OIDC roles for #52
- Active handoffs: none
- Warnings: none
- Errors: none

## 2026-07-07 — Human gate (push approved) — #52

- Human gate: approved push for #52, commit `ae586ba docs: define GitHub security baseline and AWS OIDC roles for #52` (new `github-security-and-oidc-baseline.md`: branch protection + required checks + Web Quality path-filter strategy, permissions model, GitHub Environments, AWS OIDC role catalog/trust boundaries, vars/secrets registry, secret hygiene, Dependabot/scanning posture; cross-link from the CI/CD foundation doc; SECURITY.md replaced with a real reporting policy). Design only — nothing applied.
- Agent will run `npm run agent-refresh -- --record` immediately before push, then push only this commit, follow Quality/CodeQL, and close #52 if green.
- Out of scope (not pushed): this EVENTS.md audit stays local until the next governance cleanup.

## 2026-07-07 — Push + CI (Claude) — blueprint-refresh Bedrock fix

- Pushed the approved scope: `b1748e9..962218c` (`962218c fix: run blueprint refresh through Bedrock OIDC`). `origin/main` is now at `962218c`.
- CI green: Quality (28873726019) and CodeQL (28873724638). **Web Quality correctly did not trigger** — the commit touches no `web/**`/`questions/**`/`spec/blueprint.json` paths, validating the #51 path filter in production.
- A Dependabot job ran for the known moderate `postcss` advisory in `/web` (run 28873736935, success; no PR opened yet) — the dependency follow-up remains open for a security cycle.
- Blueprint refresh is now Bedrock-native: manual-only + confirm_ai_spend gate, OIDC role assumption, tier-based port with BEDROCK_MODEL_STANDARD config, offline regression (69/69). No issue attached (bugfix cycle).
- Kept as local audit for the next governance cleanup.

## 2026-07-07T14:23:58Z — agent-refresh --record

- Status: ok
- Git: ## main...origin/main [ahead 1]
- Unpublished commits:
  - 962218c fix: run blueprint refresh through Bedrock OIDC
- Active handoffs: none
- Warnings: none
- Errors: none

## 2026-07-07 — Human gate (push approved) — blueprint-refresh Bedrock fix

- Human gate: approved push for `962218c fix: run blueprint refresh through Bedrock OIDC` (Codex-authored fix, Claude-reviewed: manual-only workflow with confirm_ai_spend gate, AWS OIDC via dedicated role, LLM_BACKEND=bedrock honored in blueprint.js with BEDROCK_MODEL_STANDARD mapping, offline regression test 69/69, npm ci added).
- Agent will run `npm run agent-refresh -- --record` immediately before push, then push only this commit, follow Quality/CodeQL, and record the result here. No issue attached (bugfix cycle).
- Out of scope (not pushed): this EVENTS.md audit stays local until the next governance cleanup.

## 2026-07-07 — Push + CI + issue closed (Claude) — #51

- Pushed the approved scope: `d68951d..b1748e9` (`b1748e9 ci: implement monorepo quality lanes for #51`). `origin/main` is now at `b1748e9`.
- CI green 3/3: Quality (28865118330), **Web Quality first real run (28865118187 — all steps passed, including the deterministic memory-store smokes and the restart-persistence smoke on the runner)**, CodeQL (28865117423).
- Issue #51 closed with the delivery summary and acceptance checklist; board item Done.
- Quality-lanes foundation live: root lane untouched, web lane path-filtered on `web/**` + `questions/**` + `spec/blueprint.json` (runtime-data finding incorporated), least-privilege permissions, check names documented for #52 branch protection.
- Next in the #48 track: #52 (branch protection + OIDC roles), #53 (CDK synth lane). Kept as local audit for the next governance cleanup.

## 2026-07-07T12:11:21Z — agent-refresh --record

- Status: ok
- Git: ## main...origin/main [ahead 1]
- Unpublished commits:
  - b1748e9 ci: implement monorepo quality lanes for #51
- Active handoffs: none
- Warnings: none
- Errors: none

## 2026-07-07 — Human gate (push approved) — #51

- Human gate: approved push for #51, commit `b1748e9 ci: implement monorepo quality lanes for #51` (new path-scoped Web Quality lane with deterministic memory-store smokes + restart smoke, least-privilege permissions, lanes/required-checks table in the foundation doc; architect finding amended: `questions/**` + `spec/blueprint.json` added to the web lane's path filters since the app loads them at runtime).
- Agent will run `npm run agent-refresh -- --record` immediately before push, then push only this commit, follow Quality + the first real Web Quality run + CodeQL, and close #51 if green.
- Out of scope (not pushed): this EVENTS.md audit stays local until the next governance cleanup.

## 2026-07-06 — Push + CI (Codex) — architecture docs

- Pushed the approved scope: `ed2b7bd..d68951d` containing:
  - `fbd3b22 docs: define CI/CD and AWS IaC strategy`
  - `d68951d docs: define adaptive AI study strategy`
- CI green: Quality (run 28834910949) and CodeQL (run 28834910646) both passed.
- Roadmap cards #51–#64 are already created/updated and referenced by the docs/specs.
- GitHub reported one existing Dependabot vulnerability (moderate) on the default branch during push; handle as a separate security/dependency follow-up, not part of this architecture-doc push.
- This push-result entry remains local EVENTS.md audit residue until the next governance cleanup.

## 2026-07-07T01:25:12Z — agent-refresh --record

- Status: ok
- Git: ## main...origin/main [ahead 2]
- Unpublished commits:
  - d68951d docs: define adaptive AI study strategy
  - fbd3b22 docs: define CI/CD and AWS IaC strategy
- Active handoffs: none
- Warnings: none
- Errors: none

## 2026-07-06 — Human gate (push approved) — architecture docs

- Human gate: approved push for exactly these two architecture/documentation commits:
  - `fbd3b22 docs: define CI/CD and AWS IaC strategy`
  - `d68951d docs: define adaptive AI study strategy`
- Approved scope: CI/CD + AWS IaC strategy docs, Adaptive AI Study Strategy spec, wiki/AGENTS references, and roadmap cards #51–#64 already created/updated.
- Agent will run `npm run agent-refresh -- --record` immediately before push, then push only these commits, follow Quality/CodeQL, and record the result here.

## 2026-07-06 — Push + CI (Claude) — governance cleanup

- Pushed the approved scope: `ffc16e6..ed2b7bd` (`ed2b7bd docs: reconcile handoff state and audits after #35-#43 cycles`). `origin/main` is now at `ed2b7bd`.
- CI green: Quality (run 28830340035) and CodeQL (run 28830339585) both passed.
- The #35–#43 audit trail, the refreshed CURRENT.md, and the documented `.vscode/mcp.json` ignore are now published; the only local EVENTS.md residue is this cycle's own gate/record/result entries (expected protocol mechanics).
- No issue attached (governance task). Open queue: Cognito adapter + /api/me + sign-in; §15 progress screen; human closes duplicate #45.

## 2026-07-06T23:28:42Z — agent-refresh --record

- Status: ok
- Git: ## main...origin/main [ahead 1]
- Unpublished commits:
  - ed2b7bd docs: reconcile handoff state and audits after #35-#43 cycles
- Active handoffs: none
- Warnings: none
- Errors: none

## 2026-07-06 — Human gate (push approved) — governance cleanup

- Human gate: approved push for the governance commit `ed2b7bd docs: reconcile handoff state and audits after #35-#43 cycles` (EVENTS.md audit trail #35–#43, CURRENT.md refresh, documented `.vscode/mcp.json` ignore).
- Agent will run `npm run agent-refresh -- --record` immediately before push, then push only this commit, follow Quality/CodeQL, and record the result here.
- Note: this gate entry and the post-push result are, by protocol mechanics, the next small local EVENTS.md residue.

## 2026-07-06 — Governance cleanup (Claude)

- Dedicated governance commit collecting the local audit trail of the #35–#43 push cycles (human
  gates, `agent-refresh --record` checkpoints, push + CI + issue-closure records, and the CodeQL
  transient-state resolution) — every prior "kept as local audit" note lands here.
- `CURRENT.md` refreshed post-#43: active priority now reflects Phase 1 design + Web MVP slices
  1–4b delivered; next candidates and the #45-duplicate housekeeping recorded; do-not-touch list
  extended with the product docs/prototype and the delivered web contracts. No SHAs pinned.
- `.gitignore`: documents the intentional, human-made `+.vscode/mcp.json` line — same MCP-secret
  hygiene family as the existing `.mcp.json`/`.mcp.local.json` ignores (protects the Stitch API
  key per the standing "never commit MCP configs/secrets" rule).
- No product code touched; no feature issues altered; local commit only — push follows the normal
  human gate.

## 2026-07-06 — Push + CI + issue closed (Claude) — #43

- Pushed the approved scope: `77989e3..ffc16e6` (`ffc16e6 feat: implement #11 slice 4b learner identity and auth boundary`). `origin/main` is now at `ffc16e6`.
- CI green: Quality (run 28829219681) and CodeQL (run 28829219337) both passed.
- Issue #43 closed with the delivery summary and acceptance-criteria checklist; Project board item Done via automation.
- Slice 4b done: identity port (dev|cognito seam), learnerId through store + 12 routes, ownership 403 NOT_RESOURCE_OWNER, per-learner mock rule, identity smoke 14/14. Web MVP slices 1–4b complete.
- Next: real Cognito adapter + /api/me + sign-in; §15 progress screen; dedicated governance commit for these EVENTS.md audits.
- Kept as local audit for a dedicated governance commit; not committing/pushing just for bookkeeping.

## 2026-07-06T23:03:01Z — agent-refresh --record

- Status: ok
- Git: ## main...origin/main [ahead 1]
- Unpublished commits:
  - ffc16e6 feat: implement #11 slice 4b learner identity and auth boundary
- Active handoffs: none
- Warnings: none
- Errors: none

## 2026-07-06 — Human gate (push approved) — #43

- Human gate: approved push for #43, commit `ffc16e6 feat: implement #11 slice 4b learner identity and auth boundary` (identity port `resolveLearner` with dev|cognito seam, learnerId through store + 12 routes, ownership 403 NOT_RESOURCE_OWNER, per-learner mock rule, committed identity smoke 14/14; architect amend: README slices 1–4b + package.json description).
- Agent will run `npm run agent-refresh -- --record` immediately before push, then push only this commit, follow Quality/CodeQL, and close #43 if green.
- Out of scope (not pushed): local `.gitignore` change; this EVENTS.md audit stays local until a dedicated governance commit.

## 2026-07-06 — Push + CI + issue closed (Claude) — #42

- Pushed the approved scope: `f93ec34..77989e3` (`77989e3 feat: implement #11 slice 4a persistence boundary for web attempts`). `origin/main` is now at `77989e3`.
- CI green: Quality (run 28819896893) and CodeQL (run 28819896162) both passed — CodeQL running normally again, confirming the earlier gap was transient.
- Issue #42 closed with the delivery summary; Project board item already Done via automation. Duplicate issue #45 remains flagged for human closure.
- Slice 4a done: repository boundary (port + in-memory/file adapters, restart-safe), store refactor with JSON-safe learner-scoped records, restart regression committed, NFT warning eliminated, README at slices 1–4a. Next: slice 4b — Cognito identity over the same records/routes.
- Kept as local audit for a dedicated governance commit; not committing/pushing just for bookkeeping.

## 2026-07-06T20:07:44Z — agent-refresh --record

- Status: ok
- Git: ## main...origin/main [ahead 1]
- Unpublished commits:
  - 77989e3 feat: implement #11 slice 4a persistence boundary for web attempts
- Active handoffs: none
- Warnings: none
- Errors: none

## 2026-07-06 — Human gate (push approved) — #42

- Human gate: approved push for #42, commit `77989e3 feat: implement #11 slice 4a persistence boundary for web attempts` (repository port + in-memory/JSON-file adapters, restart-safe write-through, store refactor with JSON-safe records, committed restart regression; architect amend: #45→#42 refs, Turbopack/NFT warning eliminated, README rewritten for slices 1–4a).
- Agent will run `npm run agent-refresh -- --record` immediately before push, then push only this commit, follow Quality/CodeQL, and close #42 if green.
- Out of scope (not pushed): local `.gitignore` change; this EVENTS.md audit stays local until a dedicated governance commit. Duplicate issue #45 flagged for human closure.

## 2026-07-06 — CodeQL resolution + baseline advance (Claude)

- Follow-up on the #41 CodeQL flag: default setup was **already `configured`** (untouched since 2026-07-01) — the 403 "not enabled" + missing run on `b39805a` was a transient repo-security state while the human worked in Settings → Code security (which also produced `f93ec34 Create SECURITY.md`, pushed directly by Márcio).
- Re-trigger via `PATCH code-scanning/default-setup` ran "CodeQL Setup" successfully; CodeQL analyses are green on `f93ec34` (19:05–19:06Z), which descends from `b39805a` — slice 3 code is scanned and clean.
- Local `main` fast-forwarded to `origin/main` (`f93ec34`); `agent-refresh` ok, in sync.

## 2026-07-06 — Push + CI + issue closed (Claude) — #41

- Pushed the approved scope: `2c30373..b39805a` (`b39805a feat: implement #11 slice 3 review missed and deterministic coach`). `origin/main` is now at `b39805a`.
- CI: Quality green (run 28815656680). **CodeQL did not run — code scanning is now DISABLED at the repository level** (API returns "not enabled"; it ran as default setup on every prior push, last at `2c30373`). Flagged for human decision: re-enable in Settings → Code security if unintentional.
- Issue #41 closed with the delivery summary; item added to the Project board and set to **Done** (issues created via `gh` are not auto-added — #39/#41 were missing; #41 added now).
- Slice 3 closes the post-attempt learning loop: §14 missed review + §4 deterministic coach + onlyMissed drill (blocker fix included). Next: slice 4 — auth + persistence + progress + metrics.
- Kept as local audit for a dedicated governance commit; not committing/pushing just for bookkeeping.

## 2026-07-06T18:54:32Z — agent-refresh --record

- Status: ok
- Git: ## main...origin/main [ahead 1]
- Unpublished commits:
  - b39805a feat: implement #11 slice 3 review missed and deterministic coach
- Active handoffs: none
- Warnings: none
- Errors: none

## 2026-07-06 — Human gate (push approved) — #41

- Human gate: approved push for #41, commit `b39805a feat: implement #11 slice 3 review missed and deterministic coach` (§14 missed review + §4 deterministic coach + review UI parity + wiring; architect blocker fix amended: onlyMissed now includes unanswered mock questions from submitted attempts, with committed regression in smoke-review-coach).
- Agent will run `npm run agent-refresh -- --record` immediately before push, then push only this commit, follow CI, close #41 and move the Board to Done if green.
- Out of scope (not pushed): local `.gitignore` change; this EVENTS.md audit stays local until a dedicated governance commit.

## 2026-07-06 — Push + CI + issue closed (Claude) — #40

- Pushed the approved scope: `b35abf8..2c30373` (`2c30373 feat: implement #11 slice 2 deterministic mock exam flow`). `origin/main` is now at `2c30373`.
- CI green: Quality (run 28803585241) and CodeQL (run 28803583746) both passed.
- Issue #40 closed with the delivery summary (contracts §2/§11–§13, Stitch-parity mock UI, blocker fix + committed blank-mock regression); Project board item already Done via automation.
- Next product item (architect): #11 slice 3 — Review Missed + deterministic Coach (§14 + §4 deterministic mode), closing the post-mock learning loop.
- Kept as local audit for a dedicated governance commit; not committing/pushing just for bookkeeping.

## 2026-07-06T15:36:33Z — agent-refresh --record

- Status: ok
- Git: ## main...origin/main [ahead 1]
- Unpublished commits:
  - 2c30373 feat: implement #11 slice 2 deterministic mock exam flow
- Active handoffs: none
- Warnings: none
- Errors: none

## 2026-07-06 — Human gate (push approved) — #40

- Human gate: approved push for #40, commit `2c30373 feat: implement #11 slice 2 deterministic mock exam flow` (mock exam contracts §2/§11–§13 + kind-aware results, Stitch-parity mock UI, architect blocker fix amended: blank-mock rollup counts unanswered as incorrect, dashboard weakest-null fallback, committed blank-mock regression smoke).
- Agent will run `npm run agent-refresh -- --record` immediately before push, then push only this commit, follow CI, and close #40 if green.
- Out of scope (not pushed): local `.gitignore` change; this EVENTS.md audit stays local until a dedicated governance commit.

## 2026-07-06 — Push + CI + issue closed (Claude) — #39

- Pushed the approved scope: `bee5869..b35abf8` (`b35abf8 feat: align #39 drill loop UI with Stitch prototype`). `origin/main` is now at `b35abf8`.
- CI green: Quality (run 28795631540) and CodeQL (run 28795629361) both passed.
- Issue #39 closed: slice 1 of #11 complete — functional drill loop (`bee5869`) + Stitch UI parity (`b35abf8`), deterministic end to end, contracts untouched (smoke 33/33), parity verified against the canonical prototype via headless screenshots.
- Next slices per `cba-web-mvp-scope.md`: mock exam (2), review missed + deterministic coach (3), real auth + persistence + metrics (4).
- Kept as local audit for a dedicated governance commit; not committing/pushing just for bookkeeping.

## 2026-07-06T13:36:05Z — agent-refresh --record

- Status: ok
- Git: ## main...origin/main [ahead 1]
- Unpublished commits:
  - b35abf8 feat: align #39 drill loop UI with Stitch prototype
- Active handoffs: none
- Warnings: none
- Errors: none

## 2026-07-06 — Human gate (push approved) — #39 UI parity

- Human gate: approved push for the #39 UI parity pass, commit `b35abf8 feat: align #39 drill loop UI with Stitch prototype` (shell + four screens restyled to the canonical Stitch prototype; zero BFF/contract changes; workspace-root warning fixed; devIndicators off; done handoff).
- Agent will run `npm run agent-refresh -- --record` immediately before push, then push only this commit, follow CI, and close #39 if green (functional slice `bee5869` + this parity pass complete the issue).
- Out of scope (not pushed): local `.gitignore` change; this EVENTS.md audit stays local until a dedicated governance commit.

## 2026-07-06T12:34:11Z — agent-refresh --record

- Status: ok
- Git: ## main...origin/main [ahead 1]
- Unpublished commits:
  - bee5869 feat: implement #11 slice 1 deterministic drill loop
- Active handoffs: none
- Warnings: none
- Errors: none

## 2026-07-06 — Human gate (push approved) — #39

- Human gate: approved push for #39, commit `bee5869 feat: implement #11 slice 1 deterministic drill loop` (Next.js drill-loop MVP: dashboard first-run, practice setup, one-question session, deterministic feedback with official source, mini-results; done handoff).
- Architect validation before gate: `agent-refresh` ok; `web npm run build` ok with a Next.js workspace-root warning; root `npm test` 68/68; `node bin/cli.js validate` 60/0; runtime smoke passed against `next start`.
- Agent will run `npm run agent-refresh -- --record` immediately before push, then push only this commit, follow CI, and close #39 if green.
- Out of scope (not pushed): local `.gitignore` change; this EVENTS.md audit stays local until a dedicated governance commit.

## 2026-07-06 — Push + CI + issue closed (Claude) — #38

- Pushed the approved scope: `6400160..5f03c85` (`5f03c85 docs: define second-pass Web BFF contracts for #38`). `origin/main` is now at `5f03c85`.
- CI green: Quality (run 28778869962) and CodeQL (run 28778869635) both passed.
- Issue #38 closed: learner-surface BFF contracts complete (§7–§17, fully deterministic); only Phase 4 admin review actions remain deferred; MVP-scope placeholders cleared.
- #11 (thin web simulator) is unblocked — engineering can build against `web-bff-contracts.md` without guessing endpoints.
- Kept as local audit for a dedicated governance commit; not committing/pushing just for bookkeeping.

## 2026-07-06T08:39:33Z — agent-refresh --record

- Status: ok
- Git: ## main...origin/main [ahead 1]
- Unpublished commits:
  - 5f03c85 docs: define second-pass Web BFF contracts for #38
- Active handoffs: none
- Warnings: none
- Errors: none

## 2026-07-06 — Human gate (push approved) — #38

- Human gate: approved push for #38, commit `5f03c85 docs: define second-pass Web BFF contracts for #38` (contracts §7–§17: practice sessions, mock session flow, missed review, progress, me/preferences; stale deferred refs fixed; MVP-scope placeholders cleared; done handoff).
- Agent will run `npm run agent-refresh -- --record` immediately before push, then push only this commit, follow CI, and close #38 if green.
- Out of scope (not pushed): local `.gitignore` change; this EVENTS.md audit stays local until a dedicated governance commit (architect's standing note).

## 2026-07-06 — Push + CI + issue closed (Claude) — #15

- Pushed the approved scope: `5b026b3..6400160` (`6400160 docs: consolidate CBA Web MVP scope for #15`). `origin/main` is now at `6400160`.
- CI green: Quality (run 28777969467) and CodeQL (run 28777968996) both passed.
- Issue #15 closed referencing the consolidation doc plus #35/#36/#16 as the artifacts satisfying its acceptance criteria; success metrics defined.
- Phase 1 design track complete: #37 → #34 → #35 → #36 → #16 → #15. Next design task flagged: second BFF contract pass (prerequisite for #11 build slices).
- Kept as local audit for the next governance commit; not committing/pushing just for bookkeeping.

## 2026-07-06T08:22:58Z — agent-refresh --record

- Status: ok
- Git: ## main...origin/main [ahead 1]
- Unpublished commits:
  - 6400160 docs: consolidate CBA Web MVP scope for #15
- Active handoffs: none
- Warnings: none
- Errors: none

## 2026-07-06 — Human gate (push approved) — #15

- Human gate: approved push for #15, commit `6400160 docs: consolidate CBA Web MVP scope for #15` (MVP scope consolidation: flow mapping table, five scope decisions, success metrics, build slices; done handoff).
- Agent will run `npm run agent-refresh -- --record` immediately before push, then push only this commit, follow CI, and close #15 if green.
- Out of scope (not pushed): local `.gitignore` change; this EVENTS.md audit stays local until the next governance commit.

## 2026-07-06 — Push + CI + issue closed (Claude) — #16

- Pushed the approved scope: `4a2776c..5b026b3` (`5b026b3 docs: define SaaS data model for #16`). `origin/main` is now at `5b026b3`.
- CI green: Quality (run 28777405185) and CodeQL (run 28777404755) both passed.
- Issue #16 closed with the delivery summary (13 entities, provenance chain, attempt/progress pipeline, #36 endpoint mapping, JSON bank migration mapping, persistence posture without lock-in).
- Kept as local audit for the next governance commit; not committing/pushing just for bookkeeping.

## 2026-07-06T08:12:26Z — agent-refresh --record

- Status: ok
- Git: ## main...origin/main [ahead 1]
- Unpublished commits:
  - 5b026b3 docs: define SaaS data model for #16
- Active handoffs: none
- Warnings: none
- Errors: none

## 2026-07-06 — Human gate (push approved) — #16

- Human gate: approved push for #16, commit `5b026b3 docs: define SaaS data model for #16` (canonical data model incl. architect review pass: ReviewTask/StudyPlan/Tenant sections + JSON bank migration mapping + ERD update; done handoff).
- Agent will run `npm run agent-refresh -- --record` immediately before push, then push only this commit.
- Out of scope (not pushed): local `.gitignore` change; this EVENTS.md audit stays local until the next governance commit.

## 2026-07-06 — Push + CI + issue closed (Claude) — #36

- Pushed the approved scope: `ff0ef8e..4a2776c` (`4a2776c docs: define Web BFF contracts for #36`). `origin/main` is now at `4a2776c`.
- CI green: Quality (run 28772003073) and CodeQL (run 28772002437) both passed.
- Issue #36 closed with the delivery summary (contract doc, screen-map link, done handoff, validations).
- Contracts are design-time only; session/practice/missed/progress/review-action endpoints are deferred to the next contract pass (listed in `docs/product/web-bff-contracts.md`).
- Kept as local audit for the next governance commit; not committing/pushing just for bookkeeping.

## 2026-07-06T06:20:18Z — agent-refresh --record

- Status: ok
- Git: ## main...origin/main [ahead 1]
- Unpublished commits:
  - 4a2776c docs: define Web BFF contracts for #36
- Active handoffs: none
- Warnings: none
- Errors: none

## 2026-07-06 — Human gate (push approved) — #36

- Human gate: approved push for #36, commit `4a2776c docs: define Web BFF contracts for #36` (Web BFF contract docs + screen-map link + done handoff).
- Agent will run `npm run agent-refresh -- --record` immediately before push, then push only this commit.
- Out of scope (not pushed): local `.gitignore` change; this EVENTS.md audit stays local until the next governance commit.

## 2026-07-06 — Push + CI + issue closed (Claude) — #35

- Pushed the approved scope: `6969185..ff0ef8e` (`0469638` design package + `ff0ef8e` Stitch prototype export). `origin/main` is now at `ff0ef8e`.
- CI green: Quality (run 28768570895) and CodeQL (run 28768570668) both passed.
- Issue #35 closed with the delivery summary (commits, canonical package path, validations).
- Canonical prototype: `docs/product/prototypes/stitch-cba-study-coach/` (`manifest.json` = source of truth; stale Stitch upstream duplicates are not part of the package).
- Kept as local audit for the next governance commit; not committing/pushing just for bookkeeping.

## 2026-07-06T04:50:03Z — agent-refresh --record

- Status: ok
- Git: ## main...origin/main [ahead 2]
- Unpublished commits:
  - ff0ef8e docs: add Stitch prototype export for #35
  - 0469638 docs: add #35 frontend prototype design package (screen map + AI design brief)
- Active handoffs: none
- Warnings: none
- Errors: none

## 2026-07-06 — Human gate (push approved) — #35

- Human gate: approved push for #35, commits `0469638` + `ff0ef8e`, scope frontend prototype docs + Stitch export.
- Agent will run `npm run agent-refresh -- --record` immediately before push, then push only these two commits.
- Out of scope (not pushed): local `.gitignore` and pre-existing working-tree changes stay uncommitted.

## 2026-07-06 — Push + CI (Claude)

- Pushed the approved scope: `302cdb4..6969185` (`6969185 fix: stop hardcoding origin main baseline in handoff state`).
- CI green: Quality (run 28764821100) and CodeQL (run 28764821077) both passed.
- Loop broken: post-push `agent-refresh` stays `ok` — `CURRENT.md` no longer pins an origin/main SHA, so advancing origin does not re-stale the baseline.
- Kept as local audit for the next governance commit; not committing/pushing just for bookkeeping.

## 2026-07-06T02:58:04Z — agent-refresh --record

- Status: ok
- Git: ## main...origin/main [ahead 1]
- Unpublished commits:
  - 6969185 fix: stop hardcoding origin main baseline in handoff state
- Active handoffs: none
- Warnings: none
- Errors: none

## 2026-07-06 — Human gate (push approved)

- Codex/architect approved the fix; human confirmed push of exactly this commit:
  - `6969185 fix: stop hardcoding origin main baseline in handoff state`
- Approved scope: stop hardcoding the origin/main baseline SHA in the handoff state (agent-refresh warn-not-block, CURRENT.md stable text, README no-hardcode rule, tests, EVENTS.md audit).
- Agent will run `npm run agent-refresh -- --record` immediately before push, then push only this commit.

## 2026-07-06 — Fix: stop hardcoding origin/main baseline (Claude)

- Root cause: pinning the `origin/main` baseline SHA in `CURRENT.md` goes stale on every push and blocked the next boot (reconcile loop).
- `CURRENT.md`: replaced the pinned origin/main SHA with a stable rule (`git rev-parse --short origin/main` / `git log -1 --oneline origin/main`).
- `agent-refresh`: a stale pinned origin/main baseline is now a WARNING, not a blocker; a hardcoded unpublished/amendable local SHA still blocks.
- `README.md`: the no-hardcode rule now covers published and local SHAs.
- Tests: stale-baseline test now asserts warn-not-block; added a no-pinned-SHA-passes test; kept the local-SHA-blocks test.
- No push (pending Codex/architect review).

## 2026-07-06 — Push + CI (Claude)

- Pushed the approved scope: `7d69262..302cdb4` (`d5e34bb docs: reconcile agent handoff state after push`, `302cdb4 docs: add agent command reference`).
- CI green: Quality (run 28764276198) and CodeQL (run 28764276006) both passed.
- `origin/main` is now at `302cdb4`.
- Follow-up: `CURRENT.md` baseline (`7d69262`) is now stale vs `origin/main` (`302cdb4`) — reconcile it in the next governance commit; `agent-refresh` will flag it until then.
- This audit is committed as part of the handoff-baseline fix (see the Fix event above), not a local uncommitted note.

## 2026-07-06T02:40:10Z — agent-refresh --record

- Status: ok
- Git: ## main...origin/main [ahead 2]
- Unpublished commits:
  - 302cdb4 docs: add agent command reference
  - d5e34bb docs: reconcile agent handoff state after push
- Active handoffs: none
- Warnings: none
- Errors: none

## 2026-07-06 — Human gate

- Human approved push in chat of exactly these two commits:
  - `d5e34bb docs: reconcile agent handoff state after push`
  - `302cdb4 docs: add agent command reference`
- Approved scope: reconcile handoff state after the previous push; add `.agent-handoff/COMMANDS.md`; update `.agent-handoff/README.md` to reference COMMANDS.md.
- Agent will run `npm run agent-refresh -- --record` immediately before push, then push only this approved scope.

## 2026-07-06T02:06:36Z — agent-refresh --record

- Status: ok
- Git: ## main...origin/main
- Unpublished commits: none
- Active handoffs: none
- Warnings: none
- Errors: none

## 2026-07-06 — Claude

- Reconciled stale `CURRENT.md` after push: updated the `origin/main` baseline `962300e` -> `7d69262`.
- Removed stale text implying unpublished local handoff/agent-refresh work; `main` is in sync with `origin/main` (ahead 0).
- Kept the prior `agent-refresh --record` blocked event below as valid history.
- No push performed.

## 2026-07-06T02:04:39Z — agent-refresh --record

- Status: blocked
- Git: ## main...origin/main
- Unpublished commits: none
- Active handoffs: none
- Warnings: none
- Errors:
  - CURRENT.md origin/main baseline is stale: 962300e != 7d69262

## 2026-07-06T01:41:29Z — agent-refresh --record

- Status: ok
- Git: ## main...origin/main [ahead 2]
- Unpublished commits:
  - 9f225d3 feat: add agent-refresh handoff state check
  - 6062f68 docs: add agent handoff protocol
- Active handoffs: none
- Warnings: none
- Errors: none

## 2026-07-06T01:41:02Z — Human gate

- Human approved push in chat with: `pode pushar`.
- Approved scope: agent handoff protocol plus agent-refresh handoff state check.
- Current unpublished commits at approval checkpoint:
  - `6062f68 docs: add agent handoff protocol`
  - `b41ce1b feat: add agent-refresh handoff state check`
- Agent must run `npm run agent-refresh -- --record` immediately before push and push only this approved governance scope.

## 2026-07-06 — Codex

- Completed Push gate protocol documentation locally.
- Moved `.agent-handoff/active/push-gate-protocol.md` to `.agent-handoff/done/push-gate-protocol.md`.
- No push performed.

## 2026-07-06 — Codex

- Documented Push gate semantics.
- `agent-refresh --record` is a technical checkpoint only; it does not authorize push.
- Push requires explicit human approval plus a `Human gate` event in `EVENTS.md`, then `npm run agent-refresh -- --record` immediately before push.
- No push performed.

## 2026-07-06T01:30:00Z — agent-refresh --record

- Status: ok
- Git: ## main...origin/main [ahead 2]
- Unpublished commits:
  - 632a4c1 feat: add agent-refresh handoff state check
  - 6062f68 docs: add agent handoff protocol
- Active handoffs: none
- Warnings: none
- Errors: none

## 2026-07-06 — Codex

- Completed `agent-refresh --record` support locally.
- Moved `.agent-handoff/active/agent-refresh-record.md` to `.agent-handoff/done/agent-refresh-record.md`.
- Validation: `node --check`, `node bin/cli.js agent-refresh --json`, `git diff --check`, and `npm test` passed (67/67).
- No push performed.

## 2026-07-06 — Codex

- Implemented explicit `agent-refresh --record` support after user tried the flag and it was ignored.
- `--record` appends an audit entry to `.agent-handoff/EVENTS.md`; normal `agent-refresh` remains read-only.
- No push performed.

## 2026-07-06 — Codex

- Completed `agent-refresh` CLI automation locally.
- Moved `.agent-handoff/active/agent-refresh-cli.md` to `.agent-handoff/done/agent-refresh-cli.md`.
- Validation: `node bin/cli.js agent-refresh --json`, `node --check`, `git diff --check`, and `npm test` passed (66/66).
- No push performed.

## 2026-07-05 — Codex

- Started `agent-refresh` CLI automation for the handoff protocol.
- Added `.agent-handoff/active/agent-refresh-cli.md` to mark task ownership while editing.
- No push performed.

## 2026-07-05 — Claude

- Removed stale unpublished commit SHA from `CURRENT.md`.
- Agents must use `git log --oneline origin/main..HEAD` for exact local unpublished commits.
- No push performed.

## 2026-07-05 23:05 BRT — Codex

- Added 5-minute state refresh cadence to the agent handoff protocol.
- Added `EVENTS.md` as the append-only coordination log.
- Updated `CURRENT.md` to record the local handoff-protocol commit pending human-approved push.
- No push performed.

## 2026-07-05 22:55 BRT — Codex

- Created local commit `b0c77f7 docs: add agent handoff protocol`.
- Added `.agent-handoff/README.md`, `CURRENT.md`, task/decision templates, and flow folders.
- Updated `AGENTS.md` with the required agent collaboration boot sequence.
- Validation: `git diff --check` and `npm test` passed.
- No push performed.
