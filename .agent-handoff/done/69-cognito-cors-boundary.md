# Task: Cognito Identity + CORS Security Boundary (#69)

## Owner

- Agent: Claude (executor)
- Architect/reviewer: Codex
- Human gate: required before every push; NO AWS/Cloudflare mutation, NO User Pool deploy, NO
  real user creation — synth/test only. Deploy belongs to #70.

## Source of truth

- GitHub issue #69 — part of #46 as a `[Task]`, not a native sub-issue (so closing it does NOT
  move the board automatically); kickoff + binding decisions: issue comment 5080592123.
- Environment contract: `docs/architecture/pilot-environment-contract.md` (#47).
- `/api/me` contract: §16 of `docs/product/web-bff-contracts.md` — implement EXACTLY, no
  invented fields.

## Binding rules (from kickoff)

1. IdentityStack: Cognito User Pool + public SPA client, Authorization Code + PKCE, NO client
   secret; exact callback/logout origins from configuration; zero account ids/ARNs/secrets in
   tracked files; proven OIDC/Cognito client library — never hand-rolled OAuth/JWT crypto.
2. API Gateway JWT authorizer on EVERY authenticated route; `/api/readiness` stays public.
   Lambda transport maps only authorizer-validated claims into a neutral principal;
   `resolveLearner` namespaces the learner id from `sub`, requires `token_use=access`, rejects
   `x-cba-learner` in deployed mode.
3. DDD: Cognito/CDK/client-library details live in infrastructure/interface adapters only; the
   application boundary receives a neutral principal and never imports AWS SDK/CDK/Cognito.
   Local `CBA_WEB_AUTH=dev` stays deterministic and separate.
4. CORS: exact Cloudflare dev/pilot origins only, credentials/headers explicit, wildcard
   forbidden, never treated as authentication; config names aligned with #47 (#67 owns the
   frontend runtime origin).
5. Tests first/offline: claim mapping, fail-closed missing/invalid principal, wrong token type,
   dev-header rejection in deployed mode, `/api/me`, cross-learner 403, exact-origin CORS synth
   assertions, local-dev regression, static guard against provider imports in application code.

## Plan (reviewable slices)

- Slice A: IdentityStack (User Pool + public PKCE client) + HTTP API JWT authorizer
  wiring — synth + CDK tests only.
- Slice B: neutral principal + Cognito identity adapter + `/api/me`.
- Slice C: learner sign-in/session/sign-out UI + exact CORS + full regression evidence.

## Out of scope

- #70 deploys/live smokes, #67 Cloudflare runtime files (ownership stays with #67), Bedrock/AI,
  #75 cleanup contract, any live AWS/Cloudflare call.

## Work log

- Slice A implemented (synth/test only): IdentityStack promoted from placeholder — Cognito User
  Pool (invite-only, email sign-in, 12+ password policy, pilot durable RETAIN+deletion
  protection / dev disposable) + public SPA client (code+PKCE, generateSecret:false, NO implicit
  flow, preventUserExistenceErrors) + hosted-UI domain prefix; callback/logout URLs are exact
  validated context config (`parseExactUrlList`: https-only except localhost, wildcards
  rejected; pilot default is a `.invalid` placeholder for #70 to override). ApiStack wires ONE
  HTTP API JWT authorizer (issuer = pool provider URL, audience = SPA client id) on EVERY route
  except public `GET /api/readiness`; missing identity refs fail construction. Explicit
  Identity->Api references in app.js.
- Validation: infra 53/53 (8 identity + 3 authorizer/api + 2 context URL tests new) + synth
  clean (12 routes JWT / readiness NONE, client code-only no-secret, pool postures verified in
  the template) · root 77/77 · validate 60/0 · bff 94+1 skip (regression) · diff --check limpo ·
  zero secrets/account ids.
- Codex review round 1 (Slice A) — four findings fixed via amend: (1) every DIRECT auth flow
  explicitly disabled (`authFlows` all false) so the template synthesizes exactly
  `ExplicitAuthFlows=[ALLOW_REFRESH_TOKEN_AUTH]` — omitting it would default to SRP+custom;
  (2) hosted UI made actually usable: `ManagedLoginVersion` pinned to CLASSIC_HOSTED_UI (1) and
  one `CfnUserPoolUICustomizationAttachment` (default CSS) bound to the SPA client, depending on
  the domain; (3) `parseExactUrlList` also rejects fragments (Cognito forbids them in callback
  URLs), embedded credentials (user:pass@) and outer whitespace, with tests; (4) naming
  corrected everywhere to "PKCE-READY" — PKCE is executed by the SPA; Slice C must PROVE
  `code_challenge_method=S256` + `code_verifier`.
- Preflight registered on #70: deploy must be blocked while `pilot.invalid` remains in
  authCallbackUrls/authLogoutUrls or the definitive Cognito domain prefix is not provided.
- Codex review round 2 (Slice A) — APPROVED at `6d588d4`. One blocker fixed via amend:
  `@aws-cdk/core:defaultCrossStackReferences` pinned to `"strong"` in cdk.json (explicit,
  producer-protecting cross-stack refs) with an offline guard test. Evidence: infra 57/57 ·
  synth clean with ZERO cross-stack warnings · root 77/77 · bank 60/0 · diff --check limpo ·
  zero ids/secrets · #82 local docs kept out of the commit.

## Slice B binding rules (identity/UserInfo — approved direction, MUST hold)

- The API accepts ONLY access tokens: `token_use=access` is required; an ID token is REJECTED.
- `/api/me` needs `email` and `displayName`; initial enrichment comes from the Cognito OIDC
  `/oauth2/userInfo` endpoint.
- The bearer token and the Cognito endpoint stay in the infrastructure/transport adapter —
  NEVER in application/domain code (no AWS SDK, no Cognito, no bearer token across that line).
- The application receives only a neutral, sanitized principal/profile.
- The profile is persisted/cached so UserInfo is NOT called on every request.
- The `aws.cognito.signin.user.admin` scope is never added.
- Cognito domain/issuer configuration is exposed via environment configuration — no physical
  values in Git.

## Work log (continued)

- Slice B implemented (separate commit): neutral principal + Cognito identity adapter +
  /api/me (§16). Transport (lambda.js) builds the principal ONLY from authorizer-validated JWT
  claims via `cognito-identity.js` (infrastructure): token_use=access enforced (ID tokens
  rejected even though they pass the authorizer), learner id namespaced `cognito-<sub>`,
  `x-cba-learner` rejected with 401 in cognito mode. Profile enrichment via Cognito OIDC
  /oauth2/userInfo happens inside an opaque `loadProfile()` closure — the bearer token is
  captured by the closure and never readable by application code. Profile persisted as a
  repository record (memory/file/dynamodb `PROFILE#<learnerId>`): normal later requests hit the
  cache (call-count tests); concurrent FIRST requests may each call userInfo, but exactly one
  canonical profile is persisted (conditional create + loser re-read). /api/me GET/PUT exactly per §16 (email never
  changes via PUT; pilot single exam). ApiStack: GET+PUT /api/me JWT-protected (15 routes),
  COGNITO_DOMAIN composed from stack references (no literals), CORS seam gains PUT. Static
  boundary guard: application files carry no @aws-sdk/amazoncognito/oauth2/Bearer material.
- Slice B validation: bff 124 (123 pass + 1 CI-skip) · infra 57/57 + synth (15 rotas, /me JWT,
  COGNITO_DOMAIN por referência) · root 77/77 · validate 60/0 · web build OK · 4 smokes OK ·
  /api/me provado vivo em dev local (GET bootstrap + PUT parcial) · diff --check limpo.
- Codex review round 1 (Slice B) — two blockers fixed via amend: (1) FAIL CLOSED on a missing
  bearer: valid authorizer claims without an Authorization bearer now yield NO principal → 401
  and nothing persisted (a fail-open path was minting @local.invalid profiles); the test proves
  the 401 and that the first authorized call still bootstraps from userInfo. (2) First-profile bootstrap
  race: when two instances both read "no profile" and the conditional create fails for the
  loser, the bootstrap re-reads and returns the WINNER instead of surfacing 409 — reproduced
  with two real DynamoDB adapters over a shared fake store. Non-blocking DDD debts (loadProfile
  riding the principal; ApiError imported from store.js) are registered on the #10 post-POC
  gate by Codex.
- Slice B textual amend (Codex): cache guarantee wording corrected everywhere — normal later
  requests hit the cache; concurrent FIRST requests may each call UserInfo, but exactly one
  canonical profile is persisted. Slice C authorized without new code review.
- Slice C implemented (separate commit): learner sign-in/session/sign-out UI + PKCE S256 proof.
  `oidc-client-ts` (proven library — zero hand-rolled OAuth/JWT crypto) drives the hosted-UI
  code+PKCE flow. Runtime auth config served by `/auth/config` from process.env at request time
  (never NEXT_PUBLIC_*, #47 rule; dev mode -> {mode:'dev'} and the sign-in UI hides). Session
  layer (`web/lib/auth.js`): sign-in redirect, `/auth/callback` completion (matches the
  IdentityStack callback path), page-refresh resume via sessionStorage, silent refresh-token
  renewal, Cognito hosted logout with exact client/return origin. `apiFetch` wrapper attaches
  the bearer (all 17 page/component call sites migrated) — #67 swaps the base URL in that ONE
  place. AccountControl widget in the Shell greets via /api/me displayName (never provider
  claims). PKCE PROOF (offline, 4 tests, no network): authorization request carries
  code_challenge_method=S256 + real code_challenge, stored code_verifier != challenge, scopes
  exactly openid/email/profile (never aws.cognito.signin.user.admin), logout URL shape. Web
  Quality lane gains the `npm test` step (glob-safe for Node 20). CORS stays the exact-origin
  ApiStack seam (GET/POST/PUT + authorization header, '*' rejected — Slice A/B tests).
- Slice C validation: web PKCE 4/4 · web build OK · /auth/config dev-mode probe OK · dashboard
  renders with the widget · 4 smokes OK · bff 125+1 skip · infra 57/57 · root 77/77 · validate
  60/0 · diff --check limpo.
- Codex review round 1 (Slice C) — four findings fixed via amend: (P1) the two remaining
  MULTILINE fetch call sites (mock view, missed review) migrated to apiFetch — zero direct
  /api fetches remain (verified by grep); (P1) auth failures are honest now: AccountControl
  shows an explicit "account unavailable" state (never a fake dev/signed-in state) and apiFetch
  no longer swallows auth-layer errors (dev mode's null token stays legitimate; failures surface
  through the caller's error path); (P1) central session gate: AuthGate wraps the app in the
  root layout — in cognito mode NO protected page mounts and no API call fires without a
  session (explicit sign-in screen, no redirect loops; /auth/* bypasses the gate so the
  callback can create the session; dev mode passes through untouched); (P2) BOTH oidc stores
  (userStore AND stateStore — OIDC state + code_verifier) are explicitly session-scoped in
  sessionStorage — nothing auth-related rests in localStorage.
- Codex review round 2 (Slice C) — two findings fixed via amend: (P1) `ready` is now BOUND to
  the validated pathname — gate logic extracted to pure `lib/session-gate.js`
  (resolveGateStatus): during a route transition the answer is 'checking', a previous route's
  'ready'/'signed-out' is never reused, and no protected page mounts ahead of its own
  validation (dev short-circuits only after the config is known; cognito re-validates every
  route). (P1) The requested regressions exist now — web suite went 4 -> 14: validateSession
  outcomes (dev without user lookup, cognito signed-in/signed-out, config failure = ERROR not
  dev), route-transition no-ready-reuse (incl. stale signed-out), gate short-circuits,
  buildSessionStores proving BOTH oidc stores share the same session-scoped storage, and a
  static guard forbidding direct fetch() outside lib/client-api.js + the /auth/config bootstrap
  (source-wide scan, multiline-proof, comments stripped).
- PUBLISHED (2026-07-25): human gate approved; pushed `6d588d4` (Slice A), `b91d2ca` (Slice B)
  and `961af51` (Slice C) as `97df6c1..961af51` — `origin/main` at `961af51`.
- CI green on ALL FOUR lanes: Quality (30183327735), Web Quality (30183327721 — the new offline
  web unit tests ran in the lane), Infra Synth (30183327736), CodeQL (30183327600).
- #69 CLOSED with delivery evidence; board moved to Done EXPLICITLY — a `[Task]` issue is not a
  native sub-issue, so closing it does not move the board automatically (applies to future
  `[Task]` closes too).
- Test evidence at the published SHA: web 14/14 · bff 125 pass + 1 gated skip · infra 57/57 +
  clean synth · root 77/77 · bank 60/0 · 4 local smokes.
- NO AWS or Cloudflare deploy, no User Pool creation, no real user: everything stays
  synth/test-only. Deploy lanes and the `pilot.invalid` + Cognito-domain preflight belong to
  #70 (preflight registered there).
- Follow-ups carried forward: post-POC DDD debts on the #10 gate (loadProfile riding the
  principal; `ApiError` imported from `store.js`); Slice-C UI polish and per-run smoke state
  isolation remain candidates for #75 or a chore issue.
