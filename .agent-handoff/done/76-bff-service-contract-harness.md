# Task: scaffold provider-neutral Web BFF service and contract harness (#76)

## Owner

- Agent: Claude (executor)
- Architect/reviewer: Codex
- Human gate: required before push

## Source of truth

- GitHub issue: #76 (sub-issue of #68; first implementation slice)
- Runtime decision: `docs/architecture/pilot-environment-contract.md` (#47)
- Contracts to preserve verbatim: `docs/product/web-bff-contracts.md` (#36/#38)
- Blueprint consuming this boundary later: `deployed-environment-smoke-workflow-design.md` (#56)

## Scope

- New `services/bff/` (repo JS conventions): HTTP/runtime-neutral application boundary
  (transport-neutral dispatcher) for the implemented learner routes: dashboard, practice, mock,
  results, missed review, deterministic coach. Not in this slice (tracked owners): Progress ->
  #44, `/api/me` -> #69, Preferences -> #79.
- Extract the deterministic use cases from the Next.js runtime boundary; Next routes DELEGATE to
  the shared boundary — zero duplication of scoring, ownership, mock finalization, or exam-mode
  rules.
- Reuse the existing bank/identity/repository ports; memory/file adapters stay for local/dev.
- Offline contract harness: success, ownership, idempotency, pre-submit leak rules — no Next.js,
  Lambda, API Gateway, AWS creds, or network.

## Out of scope (owned elsewhere)

- DynamoDB/DataStack: #77. Lambda/API Gateway: #78. Cognito/CORS: #69. Cleanup contract: #75.
  Deploy: #70. Any live AWS or paid AI: never in this slice.

## Work log

- (in progress)
- Governance cleanup committed first (615e9eb, docs-only), as instructed.
- Implemented `services/bff/` (plain ESM, repo JS conventions, zero deps):
  - `src/store.js` and `src/repository.js` MOVED VERBATIM from web/lib (single owner of scoring,
    ownership, mock finalization, exam-mode rules; memory/file adapters intact).
  - `src/bank.js` moved with one change: content-root resolution is now runtime-neutral
    (`CBA_CONTENT_DIR` override, else module-relative repo root) instead of cwd-relative.
  - `src/identity.js` made runtime-neutral: `resolveLearner(plainHeaders)` (no Fetch Request);
    same dev-provider order (header -> cookie -> dev-learner); Cognito seam (#69) preserved.
  - `src/views.js`: dashboard (§1) + practice options (§7) compositions moved OUT of route files.
  - `src/app.js`: transport-neutral dispatcher `handleApiRequest({method,path,query,headers,body})
    -> {status,body}` — 12 contract routes, per-endpoint body policies mirroring pre-#76 behavior
    (required/optional/none JSON), contract error envelope with requestId, 404 for unknown routes,
    ApiError mapping, 500 INTERNAL fallback.
  - `src/index.js` public surface; README.
- `web/` now delegates: `web/lib/api.js` is a pure transport adapter (`bffRoute(pathFor)`); all 12
  route files are one-line delegations; `web/lib/{store,bank,repository,identity}.js` DELETED
  (no duplication anywhere — verified by grep). Dependency wired as
  `"backstage-cba-prep-bff": "file:../services/bff"` (symlink; package-lock updated).
- Contract harness `services/bff/test/contract.test.js` — 12 offline tests, in-memory store, no
  Next/AWS/network: transport basics (404 envelope, required-vs-optional JSON), dashboard/options,
  drill happy path, answer idempotency (safe re-post / 409 ALREADY_ANSWERED / 409
  VERSION_MISMATCH), ownership 403 on sessions/attempts/mocks, full mock exam-mode suite
  (recursive forbidden-key scan pre-submit on start/view/save payloads + 409s pre-submit +
  idempotent submit + POST-SUBMIT POSITIVE CONTROL via missed review), deterministic coach,
  dev-identity isolation via neutral headers.
- Validation ALL GREEN: bff harness 12/12; root 77/77; `next build` OK; ALL FOUR existing smokes
  pass against the delegating routes (blank-mock, review-coach, identity, restart-persistence —
  zero behavior drift); bank 60/0; `git diff --check` clean; guardrail greps: zero
  next/aws-sdk/cdk/anthropic/openai imports in services/bff; zero web imports of the removed
  modules.
- Out of scope respected: no DynamoDB (#77), no Lambda/API GW (#78), no Cognito (#69), no cleanup
  contract (#75), no deploy (#70), no AWS live, no paid AI.
- Risks/notes for review: (1) CI does not yet run the bff harness — Web Quality lane paths do not
  include `services/**`; wiring it is a small workflow change needing its own reviewed task;
  (2) `file:` dependency creates a symlink — `npm ci` in web resolves it fine from the committed
  lockfile, and Next's tracing/turbopack roots already point at the repo root; (3) bank content
  root is now module-relative — Lambda bundling (#78) uses the `CBA_CONTENT_DIR` seam.

## Final report

- Status: implemented and validated locally; local commit awaiting Codex review + human push gate
  (SHA via `git log --oneline origin/main..HEAD`; sits on top of governance commit 615e9eb).
- #76 stays OPEN until review/push/CI; board update after the gate.

## Codex review (3 findings) — fixed, amended into the same commit

- (1) Async boundary: `handleApiRequest` is now `async` (public Promise contract) and awaits its
  handlers, so the #77 DynamoDB adapter and future async ports slot in without touching runtime
  adapters; the Next adapter awaits it; the harness was converted to async/await (still 12/12).
- (2) CI: `web-quality.yml` now watches `services/bff/**` (pull_request + push paths) and runs
  `npm --prefix ../services/bff test` as its own step before the build — a BFF regression can no
  longer land with green CI.
- (3) Scope wording corrected in app.js/README/this handoff: the boundary owns the 12 IMPLEMENTED
  contract routes (the surface the Next app had), not the "whole contract surface". Unimplemented
  areas have tracked owners: Progress -> #44, /api/me -> #69, Preferences -> #79 (new sub-issue
  of #68).
- Post-amend smoke verification note (environment forensics, NOT a #76 regression): the
  restart-persistence smoke intermittently failed on this machine in BACK-TO-BACK executions.
  Root cause proven at the process layer: the script's `stopServer` SIGTERMs the `npx` wrapper,
  the real `next-server` child can survive it locally, the port-closed loop gives up silently,
  and a crashed/finished run leaves an orphan holding port 3017 whose data dir was already
  removed — every subsequent run then talks to the poisoned orphan (INTERNAL) and cascades.
  Verified: boundary returns 201 direct-in-Node with the file store; ALL FOUR smokes pass from a
  clean port state (CI semantics: one run per fresh runner — historically green). Follow-up
  recommendation (own small web task, not #76): spawn the server detached and kill the process
  GROUP, and fail fast if the port is already bound at start.
