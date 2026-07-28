# CBA Web — Slices 1–4b of the CBA Web MVP (#39, #40, #41, #42, #43 / #11)

Minimal Next.js app implementing the CBA Web MVP learner loop end to end, deterministically:

1. **Drill loop** (#39) — dashboard → practice setup → one question at a time → immediate grounded
   feedback (explanation + official source) → mini-results.
2. **Mock exam** (#40) — 60 questions / 90 minutes, blueprint-weighted, navigator + flagging,
   silent answer saves, idempotent submit with expiry auto-submit.
3. **Review missed + deterministic coach** (#41) — grounded review of every missed item, coach
   with action-scoped deterministic answers, onlyMissed drills.
4. **Persistence boundary** (#42) — repository port with a restart-safe local JSON-file adapter;
   attempts survive restarts.
5. **Learner identity + auth boundary** (#43) — request-derived learner through the
   `CBA_WEB_AUTH=dev|cognito` port, per-learner state isolation, ownership enforcement
   (`403 NOT_RESOURCE_OWNER`).

## Run

```bash
cd web
npm install
npm run dev     # http://localhost:3000
```

Self-contained on purpose: not a root npm workspace; the root CLI, tests, and CI are untouched.

```bash
npm test            # offline unit tests (PKCE S256 proof, session gate, BFF runtime config)
npm run build       # Next.js production build
npm run leak-scan   # deny-by-default scan of browser-reachable build output
```

## Cloudflare Workers build (#67, Stage A)

The learner frontend targets Cloudflare Workers through the **OpenNext** adapter — no static
export (dynamic routes and the session UI need a runtime), and no second door to the BFF.

| Tool | Version | Why |
| --- | --- | --- |
| `next` | 16.2.12 (range stays `^16.2.10`) | the adapter supports `>=16.2.11`; the bump is lockfile-only |
| `@opennextjs/cloudflare` | 1.20.2 | current adapter release |
| `wrangler` | 4.114.0 | satisfies the adapter's `^4.86.0` peer |

```bash
npm run cf:build      # CBA_BUILD_TARGET=cloudflare opennextjs-cloudflare build -> .open-next/
npm run cf:leak-scan  # scans .open-next assets AND the Worker bundle
```

`wrangler.jsonc` and `open-next.config.ts` are written **by hand**: `opennextjs-cloudflare migrate`
is never run here because it can provision an R2 bucket, and no Cloudflare account mutation is
authorized. For the same reason the OpenNext config sets **no** cache override (no R2/KV/D1/Durable
Objects) and `wrangler.jsonc` declares only the platform-provided `ASSETS` binding. There is no
`deploy`/`preview` script — deployment belongs to #70 behind a human gate.

### Two explicit build targets

`CBA_BUILD_TARGET` selects the target; nothing is inferred.

| | local (default) | `CBA_BUILD_TARGET=cloudflare` |
| --- | --- | --- |
| `/api/**` route handlers | run the REAL in-process BFF (`backstage-cba-prep-bff`) | aliased to `lib/bff-unavailable.js`, a fail-closed 503 stub |
| tracing root | repo root (the linked BFF lives outside `web/`) | `web/` — required by the OpenNext adapter, which anchors on `web/`'s own lockfile |
| used by | `npm run dev`, `npm run build`, all four smokes | `npm run cf:build` |

Both targets write `.next`, so **`cf:build` leaves `.next` holding the fail-closed stub**: run
`npm run build` again before `next start` or the smokes. CI already orders it that way — the
smokes run on the local build, and the Cloudflare target goes last.

The learner API belongs to AWS (ADR-0002), so the Worker bundle must not contain the BFF, the
question bank, or the AWS SDK. `npm run cf:leak-scan` proves that on the built artifact: it
refuses to run unless the critical pieces (`assets`, `worker.js`, `server-functions`) are all
present, and it scans the prerendered `cache` and `middleware` too.
`npm run leak-scan:selftest` is the automated counter-proof — it plants real bank content, an AWS
SDK import and credentials into synthetic artifacts and asserts the scanner FAILS on each.

## Configuration responsibilities

| Variable | Owner | Notes |
| --- | --- | --- |
| `CBA_BFF_BASE_URL` | Cloudflare Worker **runtime** variable, supplied per environment by #70 | the environment's Web BFF (API Gateway) origin. **Never** `NEXT_PUBLIC_*` — Next inlines those at build time, which would break the build-once/promote-the-same-artifact rule of the #56 smoke design. Resolved server-side by `lib/bff-config.js`; unset locally means same-origin `/api`. |
| `CBA_RUNTIME_ENV` | environment | `local` \| `dev` \| `pilot`. `dev`/`pilot` **require** `CBA_BFF_BASE_URL` — the resolver fails fast instead of silently falling back to same-origin. **On Cloudflare Workers it is mandatory and only `dev`/`pilot` are legal**: a deployed runtime never inherits the `local` default. |
| `CBA_WEB_AUTH` | environment (#69) | `dev` only locally. In a `dev`/`pilot` runtime it must be exactly `cognito`; absent, `dev` or unknown makes `/auth/config` answer `AUTH_MISCONFIGURED` instead of downgrading to the deterministic local learner. |
| `COGNITO_USER_POOL_ID` | Worker **runtime** variable, per environment (#69/#70) | served to the browser at request time by `/auth/config`; an id, not a secret. Required, non-empty, untrimmed values rejected. |
| `COGNITO_CLIENT_ID` | Worker **runtime** variable, per environment (#69/#70) | same. |
| `COGNITO_DOMAIN` | Worker **runtime** variable, per environment (#69/#70) | an absolute `https://` **origin**, not a bare host: `auth-settings.js` uses it as a URL base (`new URL('/logout', domain)`), so a bare host would resolve against the frontend and send the learner to a logout URL on the wrong site. On a **deployed** tier the reserved `.invalid` placeholder is refused — see below. |

All of these are Worker **runtime** variables for the same reason `CBA_BFF_BASE_URL` is:
`/auth/config` is served per request from the Worker binding env, so one built artifact promotes
across tiers unchanged. They are supplied per environment at deploy time by #70, never committed,
and never `NEXT_PUBLIC_*`.

**Why a deployed tier refuses `COGNITO_DOMAIN` on `.invalid`.** The Cognito callback and logout
URLs still default to the reserved `.invalid` placeholder while the custom-domain-versus-
`workers.dev` decision on #67 is open. A placeholder that reaches a deployed tier renders a sign-in
button that cannot complete its redirect: the page looks healthy and the flow is dead, which is the
kind of failure a health check passes straight over. `/auth/config` therefore answers
`AUTH_MISCONFIGURED` at config time, where it is visible, rather than in the browser after the
redirect. Local development may still use the placeholder.

No Cloudflare API token, AWS credential, account id or ARN belongs in this repo, in logs, or in
fixtures. `npm run leak-scan` enforces the browser-facing half of that rule.

## Per-environment Workers (#67 Stage B)

`wrangler.jsonc` declares one Worker per tier — `cba-study-coach-dev-web` and
`cba-study-coach-pilot-web` — mirroring the `cba-study-coach-<env>-*` separation the AWS side
already uses. Separate Workers are what stop a dev deploy from overwriting pilot.

Two things are **deliberately absent** from that file and stay absent:

- **Routes.** Whether the pilot serves from a custom domain or the `workers.dev` origin is an open
  decision on #67, and not a cosmetic one: it determines the exact origin in the BFF CORS list
  (#69) and the Cognito callback/logout URLs. Writing a route would decide it silently. #70
  supplies the route with the deploy.
- **Vars.** Every runtime variable above is supplied at deploy time. A committed value would be
  both an endpoint in a tracked file and a build-time freeze of something the contract requires to
  be resolved per request.

Deploy stays out of this package: there is no `deploy` or `preview` script in `package.json`, so a
local `npm run` cannot mutate a Cloudflare account. `opennextjs-cloudflare deploy` is invoked only
from the #70 workflow behind the GitHub Environment approval.

**Ephemeral previews are never CORS-allow-listed** (pilot-environment-contract §1). Authenticated
integration goes through one stable URL per environment, and `ApiStack` now enforces that
structurally: `corsAllowedOrigins` accepts at most one exact `https` origin and rejects
`.pages.dev` preview hosts. The count rule is what does the work — with a maximum of one, a
per-change preview URL cannot be appended, only substituted, which is a visible edit rather than an
accumulation nobody notices.

## Identity / auth

Routes resolve the learner through the identity boundary in `lib/identity.js`
(`CBA_WEB_AUTH=dev|cognito`, default `dev`) and pass the `learnerId` into the store — nothing
hardcodes a learner, and cross-learner access returns `403 NOT_RESOURCE_OWNER`.

Dev-mode resolution order:

1. `x-cba-learner: <token>` header — tools/smokes and multi-learner testing;
2. `cba_learner=<token>` cookie — per-browser identity when you want it;
3. deterministic `dev-learner` — the simple local default (no auth configured).

`CBA_WEB_AUTH=cognito` is a deliberate seam: the Cognito adapter (ADR-0002) implements
`resolveLearner` against the API-Gateway-validated session without touching routes, store, records,
or the frontend. Note: data written before this slice used the old stub learner id and will not
appear under the dev learner — wipe `web/.data/` if that matters.

## Persistence

State lives behind the repository port in `lib/repository.js`:

- `CBA_WEB_STORE=file` (default) — JSON file at `CBA_WEB_DATA_DIR`/`simulation.json`
  (default `web/.data/`, gitignored). Atomic write-through; attempts survive restarts.
- `CBA_WEB_STORE=memory` — ephemeral per process. The deterministic smokes assume a fresh state,
  so run their server this way (or point `CBA_WEB_DATA_DIR` at a throwaway dir).

Records are plain JSON, learner-scoped (`learnerId`) — swapping in DynamoDB (ADR-0002) or adding
Cognito identity is an adapter/caller change, not a rewrite. Regression:
`node scripts/smoke-restart-persistence.mjs` boots the server twice on a temp data dir and asserts
attempts survive.

## What is real vs stubbed

| Real (slices 1–4b) | Stubbed / next |
| --- | --- |
| Contract shapes from `docs/product/web-bff-contracts.md` (§1–§4, §7–§14), incl. error envelope, `INSUFFICIENT_QUESTIONS` / `VERSION_MISMATCH` / `ALREADY_ANSWERED` / `MOCK_EXAM_IN_PROGRESS` / `ATTEMPT_NOT_IN_PROGRESS` / `ATTEMPT_NOT_COMPLETED` / `NOT_RESOURCE_OWNER` semantics | Real Cognito adapter — next: implements `resolveLearner` against the API-Gateway-validated session (ADR-0002); the `dev\|cognito` boundary already exists, so it lands without touching routes, store, records, or frontend |
| Content — `questions/*.json` + `spec/blueprint.json` through the #16 JSON-bank migration mapping (published `QuestionVersion`s, `legacyExternalId`, source registry) | Managed persistence — DynamoDB (ADR-0002) replaces the local JSON-file adapter behind the same repository port |
| Drill loop with deterministic scoring, per-domain rollups, grounded feedback from the published item (never AI) | Coach grounded AI mode (Phase 3, #12) — swaps in behind the §4 `mode` field, no frontend change |
| Mock exam: blueprint-weighted assembly, exam-mode rule (zero correctness pre-submit), flagging/navigator, idempotent submit, expiry auto-submit | Admin/authoring surfaces (Phase 4) and the advanced progress screen (§15 trends/ProgressSnapshot) |
| Review missed (§14, grounded, paged) + deterministic coach (§4, action-scoped) + onlyMissed drills | Learner-facing `/api/me` (§16) + sign-in surface — arrive with the Cognito slice |
| Persistence: repository port + restart-safe JSON-file adapter (atomic write-through) | — |
| Identity/auth boundary: request-derived learner (header → cookie → deterministic dev default), per-learner state, ownership `403`s, per-learner mock rule | — |
| Design tokens from the versioned Stitch design system (Academic Precision) | — |

The browser talks **only** to the BFF-shaped routes under `app/api/**` (ADR-0002 boundary). The
stub implements the contracts in-process; pointing the frontend at the real AWS Web BFF later is a
base-URL change, not a rewrite.

## Layout

- `lib/bank.js` — Exam Content adapter: blueprint + bank → domains/competencies/published versions.
- `lib/repository.js` — persistence boundary (port + adapters): in-memory (ephemeral) and JSON-file
  (restart-safe, atomic write-through). Only `lib/store.js` imports it — never routes or pages.
- `lib/store.js` — Simulation application layer: drills, mock exams, missed review, deterministic
  coach; all state behind the repository port, written through on every mutation.
- `lib/api.js` — contract error envelope.
- `app/api/**` — BFF stub routes (§1 dashboard, §2 mock start, §3 results, §7 options, §8 start,
  §9 next, §10 answers, §11 mock get, §12 mock answers, §13 mock submit).
- `app/**` — screens: dashboard, practice setup, drill session, mock exam (navigator + timer),
  results (kind-aware).
