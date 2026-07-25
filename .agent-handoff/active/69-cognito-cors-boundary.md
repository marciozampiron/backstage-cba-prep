# Task: Cognito Identity + CORS Security Boundary (#69)

## Owner

- Agent: Claude (executor)
- Architect/reviewer: Codex
- Human gate: required before every push; NO AWS/Cloudflare mutation, NO User Pool deploy, NO
  real user creation — synth/test only. Deploy belongs to #70.

## Source of truth

- GitHub issue #69 (sub-issue of #46); kickoff + binding decisions: issue comment 5080592123.
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

- Slice A (CURRENT): IdentityStack (User Pool + public PKCE client) + HTTP API JWT authorizer
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
- Next: Slice B (neutral principal + `token_use=access` + Cognito identity adapter + /api/me
  §16); Slice C additionally owes the PKCE S256 proof.
