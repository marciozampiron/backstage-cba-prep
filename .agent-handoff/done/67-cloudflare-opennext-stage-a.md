# Task: Cloudflare Workers / OpenNext learner frontend (#67) — Stage A (DONE)

## Owner

- Agent: Claude (executor)
- Architect/reviewer: Codex
- Human gate: required before ANY push or Cloudflare mutation. Stage A is build-only: NO deploy
  (preview or production), NO Cloudflare account mutation, NO AWS/Bedrock call.

## Source of truth

- GitHub issue #67 — part of #46 as a `[Task]`, not a native sub-issue (closing it will NOT move
  the board automatically). Binding comment (2026-07-25): the browser-facing BFF base URL is
  **Worker RUNTIME config** (`CBA_BFF_BASE_URL`), never `NEXT_PUBLIC_*`, because Next.js freezes
  those at build time and that would break the build-once/promote-same-artifact rule of
  `deployed-environment-smoke-workflow-design.md` §1.
- `docs/adr/0002-cloudflare-nextjs-aws-bff.md` (runtime split; the BFF is the ONLY
  browser-reachable backend), `docs/architecture/pilot-environment-contract.md` §3
  (`CBA_BFF_BASE_URL` as a Worker runtime variable), `pilot-release-runbook.md`,
  `deployed-environment-smoke-workflow-design.md` (leak-scan allowlist), and
  `docs/product/web-bff-contracts.md`.

## Stage A objective

Prepare and PROVE LOCALLY that the Next.js learner frontend builds for Cloudflare Workers through
the officially supported OpenNext path — no deploy, no account mutation.

## Official documentation consulted (2026-07-26)

The Cloudflare Docs MCP server is **not connected in this session** (the available MCP servers are
Canva, Gamma, Gmail, Google Calendar/Drive, Microsoft 365, Postman and Stitch). Research therefore
used the official OpenNext documentation site plus the npm registry metadata directly — no
remembered configuration from older versions was used.

- `https://opennext.js.org/cloudflare` — "All minor and patch versions of Next.js 16 and the
  latest minors of Next.js 14 and 15 are supported." → **Next.js 16 is on the supported path.**
- `https://opennext.js.org/cloudflare/get-started` — existing-app integration: `wrangler.jsonc`
  (`main: .open-next/worker.js`, `assets` binding `ASSETS` from `.open-next/assets`,
  `nodejs_compat` compatibility flag REQUIRED with a compatibility date of 2024-09-23 or later),
  `open-next.config.ts` via `defineCloudflareConfig`, scripts using the `opennextjs-cloudflare`
  CLI (`build`/`preview`/`deploy`/`upload`), `initOpenNextCloudflareForDev()` in the Next config
  for local development, `.open-next` added to `.gitignore`, and `export const runtime = "edge"`
  must NOT be used. NOTE: the prose on that page still says "wrangler 3.99.0 or later", which is
  contradicted by the package's own peer range below — the registry metadata is authoritative and
  the exact config shape must be re-verified against the installed package at implementation time.
- npm registry (authoritative for versions), read-only queries:

| Package | Latest | Peer `next` | Peer `wrangler` | Published |
| --- | --- | --- | --- | --- |
| `@opennextjs/cloudflare` | **1.20.2** | `>=15.5.21 <16 \|\| >=16.2.11` | `^4.86.0` | 2026-07-21 |
| `@opennextjs/cloudflare` | 1.20.1 | `>=15.5.18 <16 \|\| >=16.2.6` | `^4.86.0` | 2026-06-26 |
| `@opennextjs/cloudflare` | 1.20.0 | `>=15.5.18 <16 \|\| >=16.2.6` | `^4.86.0` | 2026-06-25 |
| `@opennextjs/cloudflare` | 1.19.0 | `>=15.5.15 \|\| >=16.2.3` | `^4.65.0` | 2026-04-09 |
| `wrangler` | 4.114.0 | — | — | — |

## BLOCKER — Next.js version vs. the officially supported OpenNext path

Per the standing instruction ("se descobrir incompatibilidade entre a versão atual do Next.js e o
caminho OpenNext oficialmente suportado, pare antes de trocar versões e reporte"), implementation
STOPPED here. Nothing was installed, no version was changed, no config was written.

- `web/` declares `next: ^16.2.10` and has **16.2.10 installed**.
- The latest adapter (1.20.2) supports Next `>=16.2.11` — **16.2.10 is outside that range**, so
  `npm i -D @opennextjs/cloudflare` would fail `ERESOLVE` on the peer conflict.
- Available Next patches: 16.2.11 and 16.2.12 exist. Both are ALREADY inside the declared
  `^16.2.10` caret — satisfying the peer needs no manifest range change, only a lockfile update.

### Options for Codex

- **Option A (recommended): update Next within the existing caret → 16.2.12, adapter 1.20.2,
  wrangler ^4.86.0.** Impact: `web/package.json` keeps `^16.2.10` unchanged; only
  `web/package-lock.json` moves. It is a patch-level upgrade on the newest supported adapter, so
  the pilot does not start one version behind. Requires full revalidation (web build, 14 web
  tests, 4 local smokes, bff harness) because the runtime the learner UI runs on changed.
- **Option B: pin the adapter to 1.20.1 (supports `>=16.2.6`, covers 16.2.10) and leave Next
  untouched.** Impact: zero change to the app runtime, but the pilot starts one adapter release
  behind and the very next adapter upgrade forces the same Next bump anyway; wrangler peer is the
  same `^4.86.0`.
- **Option C: force the install (`--legacy-peer-deps` / `--force`).** REJECTED — it leaves the
  officially supported path and contradicts the "no remembered/unsupported configuration" rule.

Recommendation: **Option A**, because the bump is inside the range the repo already declares, it
keeps us on the newest supported adapter, and the revalidation cost is the same battery Stage A
has to run anyway.

## Stage A plan (once the version decision is made)

- Minimal versioned OpenNext/Cloudflare config: `wrangler.jsonc` (nodejs_compat, current
  compatibility date, ASSETS binding), `open-next.config.ts`, `.open-next` gitignored, and
  `initOpenNextCloudflareForDev()` wired for local dev.
- Reproducible Cloudflare build scripts (build-only; no `deploy`/`preview` script that could
  mutate the account in CI).
- Typed/validated RUNTIME resolution of `CBA_BFF_BASE_URL` reaching the browser through the
  EXISTING `apiFetch` seam only (no second door to the BFF), fail-fast when absent in a deployed
  environment, same-origin `/api` locally. Never `NEXT_PUBLIC_*`.
- Offline test of the configuration resolution.
- Leak scan of the produced artifact against the #56 allowlist (no `questions/*.json`,
  `correctOption`, explanations, credentials, ARNs, account ids, or Bedrock config in public
  assets).
- Short `web/README.md` section: local build and configuration responsibilities.
- Web Quality integration for build/test/leak-scan only — NO deploy workflow (that is #70).

## Out of scope

- Any deploy (preview or production), any Cloudflare account mutation, any Cloudflare token in
  Git/logs/fixtures, any AWS or Bedrock call.
- BFF contract or exam-mode rule changes; a second BFF access path.
- The #82 and #10 local documents and `.vscode/` (owned elsewhere — untouched).

## Work log

- Boot completed: AGENTS.md, `.agent-handoff/README.md`, `CURRENT.md` and `COMMANDS.md` read;
  `npm run agent-refresh` → status ok, `main...origin/main`, no unpublished commits, no active
  handoff owner (`active/` held only `.gitkeep`); issue #67 and its binding comment read.
- Research completed (table above). STOPPED at the version incompatibility before installing or
  changing anything — awaiting the Codex decision between Options A/B.
- **Option A approved by Codex.** Applied exactly: `npm update next` moved the LOCKFILE to
  **16.2.12** while `web/package.json` keeps the declared range `^16.2.10`;
  `@opennextjs/cloudflare@1.20.2` and `wrangler@4.114.0` (satisfies the `^4.86.0` peer) added as
  devDependencies. No `--force`, no `--legacy-peer-deps` — `npm ls` shows a clean tree, and a
  from-scratch `npm ci` reproduces all three versions exactly.
- Config written BY HAND (`opennextjs-cloudflare migrate` never run, per the guardrail — it can
  provision an R2 bucket): `wrangler.jsonc` (nodejs_compat + compatibility_date 2026-07-22 matching
  the bundled workerd 1.20260722, ASSETS binding only — no R2/KV/D1/DO/images/self-service) and
  `open-next.config.ts` (`defineCloudflareConfig({})`, every override left at the default because
  each one would require a Cloudflare resource). `.open-next`/`.wrangler` gitignored.
  `initOpenNextCloudflareForDev()` wired into `next.config.mjs` (adapter-guarded: `next dev` only,
  wrangler's LOCAL miniflare proxy, no account contact).
- Runtime config: `web/lib/bff-config.js` — PURE `resolveBffConfig(env)` (validates an exact
  absolute https origin; rejects wildcards, embedded credentials, query/fragment, whitespace;
  normalises the trailing slash) plus an async `getBffConfig()` that reads the Worker binding via
  `getCloudflareContext` when present and `process.env` otherwise. `CBA_RUNTIME_ENV=dev|pilot`
  REQUIRES `CBA_BFF_BASE_URL` (fail-fast); local/unset → same-origin `/api`. 10 offline tests,
  including a structural guard that the resolver never READS a `NEXT_PUBLIC_*` variable.
- Leak scan: `web/scripts/leak-scan.mjs` (`npm run leak-scan`) — deny-by-default over
  browser-reachable output (`.open-next/assets` and `.next/static`). 8 structural probes
  (AWS key ids, account-bearing ARNs, private keys, Cloudflare/AWS secret assignments, Bedrock and
  DynamoDB handles, and any `NEXT_PUBLIC_*BFF*` build-frozen config) plus **62 probes derived from
  the real question bank** (answer/explanation field names + verbatim question texts), so a schema
  rename cannot silently empty the probe set — that condition throws instead of passing vacuously.
  Evidence: PASS (exit 0) on the real `.next/static`; FAIL (exit 1) on a planted fixture built from
  an actual bank entry (positive control). Added to the Web Quality lane after `Build`.

## Design 2 APPROVED and IMPLEMENTED (Codex)

The browser learns the BFF origin at REQUEST time and calls the AWS API Gateway directly, guarded
by the exact-origin CORS seam delivered in #69. `apiFetch` remains the single door.

- `/auth/config` now serves `{ runtimeEnv, bffBaseUrl }` in BOTH dev and cognito modes, resolved
  from the runtime env (Worker bindings on Workers, `process.env` locally). Cognito ids are read
  from the SAME merged env, so they work from Worker bindings too. A deployed runtime with a
  missing/malformed base URL returns 500 `RUNTIME_MISCONFIGURED` and serves NOTHING partial.
- `apiFetch` prefixes the cached base (the shared `/auth/config` promise in `auth.js` — one
  request per page load) and keeps the bearer. Local with no base → same-origin `/api`;
  dev/pilot → `<CBA_BFF_BASE_URL>/api/...`. No second door: the no-direct-fetch guard still
  passes.
- Fail-closed on Workers (Codex point 9): `getRuntimeEnv()` detects the Workers runtime via
  `navigator.userAgent` and performs the binding lookup with NO try/catch — a Worker that cannot
  read its bindings surfaces the error instead of degrading to local defaults. A structural test
  asserts the absence of `catch` in that function.

### Two explicit build targets (`CBA_BUILD_TARGET`)

| | local (default) | `cloudflare` |
| --- | --- | --- |
| `/api/**` handlers | REAL in-process BFF | aliased to `lib/bff-unavailable.js` (fail-closed 503) |
| tracing root | repo root (linked BFF is outside `web/`) | `web/` (what the OpenNext adapter requires) |
| used by | `dev`, `build`, all four smokes | `cf:build` |

Aliasing the in-process BFF removes the only cross-root import, which is what unblocked the
adapter's `packagePath` mismatch. **`npm run cf:build` now completes and produces
`.open-next/worker.js`.** Local development, the local build and the smokes are unchanged.

### Leak scan

`--cloudflare` mode REQUIRES `.open-next` (exits 1 when absent — the gate can never pass by
scanning nothing) and covers browser assets AND the Worker bundle (`worker.js`,
`server-functions`, `middleware`): 12 structural probes (8 browser + 4 worker: BFF DynamoDB
adapter, AWS SDK client, simulation store, Cognito adapter) plus 62 bank-derived probes.
Evidence at this SHA: PASS over 1194 artifact files; positive controls FAIL (exit 1) for both a
planted bank leak and a planted `@aws-sdk/lib-dynamodb` import. Verified independently that no
verbatim question text appears in any of the 1202 artifact files, and that the `correctOption`
occurrences in the client bundle are property ACCESSES in the post-submit review UI, not bank
data — the scan's JSON-shape regex correctly distinguishes them.

### CI (Web Quality)

Order: bff harness → web tests → local build → leak scan → the three deterministic smokes →
restart-persistence smoke → `cf:build` → `cf:leak-scan`. The Cloudflare target runs LAST so it
cannot disturb the smokes that prove the real learner loop. Build only — no deploy, no preview,
no Cloudflare credentials.

## Codex review round 3 — final hardening (all applied)

1. **Workers require an explicit deployed tier.** `resolveBffConfig(env, { onWorkers })` now
   demands `CBA_RUNTIME_ENV` on Workers and accepts only `dev|pilot` there; the `local` default is
   legal ONLY off-Workers (`next dev`, `next start`, tests). `getBffConfig()` and `/auth/config`
   pass `onWorkers: onCloudflareWorkers()`.
2. **Deployed auth must be exactly `cognito`.** `/auth/config` returns 500 `AUTH_MISCONFIGURED`
   when a `dev|pilot` runtime has `CBA_WEB_AUTH` absent, `dev`, or any unknown value — no silent
   downgrade to the deterministic local learner. Local still accepts `dev`/unset.
3. **Real apiFetch tests (8).** `createApiFetch({ getToken, getConfig, fetchImpl })` exposes the
   dependency seams while production keeps the same code path, so the tests exercise the ACTUAL
   url-building: local/null → `/api/...`; deployed → `https://bff.../api/...`; bearer preserved
   and merged with caller headers; query string preserved on both paths; a session-layer failure
   surfaces with zero network calls. A new contract-path allowlist refuses absolute URLs,
   protocol-relative `//host`, `/auth/config`, `/apiary/x`, traversal, relative and empty paths —
   nothing reaches the network.
4. **Critical artifacts are mandatory.** `--cloudflare` exits 1 unless `assets`, `worker.js` AND
   `server-functions` all exist (previously a partial artifact could pass by silently skipping
   missing targets).
5. **`cache` is in the scanned surface** (prerendered payloads), alongside `middleware`.
6. **Positive controls are automated**, not just documented: `test/leak-scan.test.mjs` builds
   SYNTHETIC `.open-next` trees (new `--root` flag) and asserts exit codes for a clean artifact
   (PASS), each missing critical artifact (FAIL), a verbatim bank question in an asset, a
   serialized answer field, an AWS SDK import in the Worker bundle, the in-process BFF store, a
   leak in the prerendered cache, an AWS key, an account-bearing ARN, and a `NEXT_PUBLIC_*` BFF
   URL. Wired into the Web Quality lane right after `cf:leak-scan` as
   `npm run leak-scan:selftest`.

Also found and documented while revalidating: both targets write `.next`, so `cf:build` leaves it
holding the fail-closed stub — `npm run build` must run again before `next start`/the smokes. This
is exactly why CI runs the smokes on the local build first and the Cloudflare target last. It also
proved the alias works end to end: after `cf:build` the stub IS in `.next/server`, and after the
local build it is gone.

## Codex review round 4 — final hardening (all applied)

1. **URL-normalizer validation replaces the standalone regex** in `apiFetch`. The decision is now
   made on the path that will actually be requested: `new URL()` collapses `.`/`..`, then the
   pathname is percent-decoded **to a fixed point** (bounded, so double-encoding cannot hide) and
   re-normalized. The literal path, the decoded path AND the decoded-then-normalized path must all
   resolve to exactly `/api` or a path beneath `/api/`; a surviving `..` segment is refused as a
   second belt. Absolute URLs, protocol-relative authorities and malformed encodings are refused
   before parsing.
2. **The traversal cases are tested with zero-call proof.** Refused: `/api/%2e%2e/etc`,
   `/api/%2E%2E/etc`, `/api/%2e%2E/etc` (case variations), `/api/attempts/%2e%2e/%2e%2e/admin`,
   `/api/%2e%2e%2fadmin` and `/api/x%2f..%2f..%2fadmin` (encoded separators), `/api%2f..%2fadmin`,
   `/api/%252e%252e/etc` (double-encoded), `/api/%` (malformed), plus the literal forms and
   `/apiary/x`, `/api../x`, `/auth/config`, `/`, relative and empty. A dedicated test proves a
   refused path triggers **zero** `fetchImpl` calls AND zero session/config lookups (validation
   runs first). Harmless normalizable paths (`/api/./dashboard`,
   `/api/practice/../dashboard`) are accepted and sent in normalized form.
3. **No complete secret literals in source.** The positive control assembles its synthetic values
   at runtime from fragments (`['AKIA','IOSFODNN','7EXAMPLE']`, `['1234','5678','9012']`), asserts
   their shapes (20 and 12 chars) so the control cannot silently stop matching, and keeps failing
   the scan.
4. **Direct tests added** for the deployed-runtime rules: `resolveBffConfig({}, {onWorkers:true})`
   throws (also with a valid base URL present); Workers + `CBA_RUNTIME_ENV=local` throws; Workers +
   dev/pilot + valid base resolves; Workers + deployed tier without a base still fails fast; off
   Workers the `local` default remains legal. For `/auth/config`: deployed + valid base with auth
   absent, `dev`, or unknown (`'cognito '`, `'Cognito'`, `'oidc'`, `'none'`) returns
   `AUTH_MISCONFIGURED` with no `mode` leaking out; local dev keeps working for unset, `dev`, and
   explicit `local`+`dev`.
5. **Grep evidence:** no complete `AKIA`+16 literal and no 12-digit sequence exists in any tracked
   or untracked source file (build artifacts and lockfiles excluded — the lockfile diff has zero
   12-digit runs either). Only the fragments remain.

## Codex review round 5 — fail closed on non-convergent decoding

`decodeToFixedPoint` returned the PARTIALLY decoded value after exhausting `MAX_DECODE_PASSES`,
so the allow decision could be made on a string no decoder actually converges to. Demonstrated
concretely: for `/api/` + `%2e%2e` re-encoded six times, the old code returned
`/api/%25252e%25252e/etc`, which SATISFIES the "under /api" check — the traversal payload would
have been forwarded. It now returns `null`, i.e. refuses.

Regression is generated programmatically rather than hand-written: `encodePercentTimes()` re-encodes
every `%` N times (N+1 decode passes needed to reach the literal form). The suite asserts, for the
six-times case, that `apiFetch` rejects AND that `fetchImpl`, the session lookup and the config
lookup are ALL untouched (validation runs before any of them) — plus a sweep proving depths 1
through 8 are every one refused with zero `fetchImpl` calls.

## Stage A validation (this commit)

- `npm run agent-refresh` ok · web tests **62/62** · local `npm run build` OK · `npm run leak-scan`
  PASS · `npm run leak-scan:selftest` **11/11** · **4 local smokes OK** on the local build ·
  **`npm run cf:build` OK → `.open-next/worker.js`** · `npm run cf:leak-scan` PASS over **1201**
  artifact files (assets + worker.js + server-functions + cache + middleware) · an incomplete
  artifact is REFUSED (exit 1) · root **77/77** · `validate` **60/0** · bff **125 pass + 1 skip** ·
  infra **57/57** · `git diff --check` clean · no secrets/account ids (grep-verified) · `npm ci`
  reproduces the pinned versions.
- NO push · NO Cloudflare deploy/preview · NO Cloudflare login or account mutation · NO AWS or
  Bedrock call · #82/#10 documents and `.vscode/` untouched · `EVENTS.md` kept OUT of this commit.

## Final state — Stage A PUBLISHED

- Published as `f451dfe` (`02efac4..f451dfe`), CI green: Quality (30188809394), Web Quality
  (30188809371 — the lane ran the new `cf:build`, the Cloudflare leak scan and the scanner's
  positive controls), CodeQL (30188809184).
- Delivered: pinned toolchain (next 16.2.12 via lockfile only, `@opennextjs/cloudflare` 1.20.2,
  wrangler 4.114.0), hand-written `wrangler.jsonc` + `open-next.config.ts` (no `migrate`, no
  R2/KV/D1/DO — nothing that can provision a Cloudflare resource), runtime `CBA_BFF_BASE_URL`
  served by `/auth/config` and consumed by the single `apiFetch` door with URL-normalizer path
  validation, explicit `CBA_BUILD_TARGET` targets with a fail-closed BFF stub for the Worker
  build, and a Cloudflare leak scan with automated positive controls.
- Five Codex review rounds folded in (URL-normalizer validation, fail-closed Workers config,
  deeply-encoded traversal, no complete secret literals in source, automated scanner self-test).
- **#67 REMAINS OPEN**: Stage A is build/config/test only. Stage B (deploy lanes, preview,
  runtime variables in a real Cloudflare account) is queued in
  `inbox/67-cloudflare-opennext-stage-b.md` and lands with #70.
- NO Cloudflare deploy/preview, NO Cloudflare login or account mutation, NO AWS/Bedrock call.
