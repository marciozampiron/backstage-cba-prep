# Inbox: Cloudflare Workers / OpenNext frontend (#67) — Stage B

## Status

- Stage A is DONE and published (`done/67-cloudflare-opennext-stage-a.md`): the frontend builds
  for Cloudflare Workers through the supported OpenNext path, with runtime `CBA_BFF_BASE_URL`,
  a single `apiFetch` door, and a Cloudflare artifact leak scan in CI.
- **#67 stays OPEN** — Stage B is the remaining half.
- Implementation owner: Claude Opus 5 (assigned 2026-07-28). Architect/reviewer: Codex.
  Human gate required before any push or Cloudflare mutation.
- Stage B's account-level half still lands **with #70**: the Cloudflare project, the Environment
  API token, the routes, the runtime variable VALUES and the deploy invocation are all human-gated
  and none has been performed. What is deliverable now is the in-repo half — the per-environment
  Worker declarations, the runtime-variable contract, and the structural CORS guard.

## Read first

1. `.agent-handoff/done/67-cloudflare-opennext-stage-a.md`
2. `web/README.md` (build targets, configuration responsibilities)
3. `docs/architecture/pilot-environment-contract.md` §3 (`CBA_BFF_BASE_URL` as Worker runtime var)
4. `docs/architecture/deployed-environment-smoke-workflow-design.md` (frontend gates F1/F2)
5. `docs/architecture/pilot-release-runbook.md` (GO/NO-GO, rollback §4.1)

## Scope (all human-gated, none performed yet)

- Cloudflare account/project setup and the Environment-scoped API token (never committed).
- Per-environment Worker names/routes and the runtime variables the Worker serves —
  `CBA_BFF_BASE_URL` first, plus the `COGNITO_*` values `/auth/config` reads.
- Deploy lane wiring: build once, promote the same artifact; `opennextjs-cloudflare deploy` is
  invoked ONLY from the #70 workflow behind the Environment approval, never from a repo script.
- Preview/ephemeral URLs stay out of the BFF CORS allow-list (pilot-environment-contract §1).
- Frontend gates F1/F2 against `FRONTEND_URL` and the rollback path in runbook §4.1.

## Explicit exclusions

- No `deploy`/`preview` npm script may be added to `web/package.json` — deployment belongs to the
  #70 workflow, so a local `npm run` can never mutate an account.
- No Cloudflare token, account id, zone id, or endpoint in tracked files, logs or fixtures.
- No `opennextjs-cloudflare migrate` (it can provision an R2 bucket).
- No change to the learner API contract, exam-mode rules, or the `apiFetch` single-door seam.

## Open decisions for Stage B

- Whether the pilot uses a custom domain or the `workers.dev` origin (affects the #69 exact-origin
  CORS list and the Cognito callback/logout URLs, which still default to the reserved `.invalid`
  placeholder).
- Cache/incremental-cache backend: Stage A deliberately ships none (no R2/KV/D1/DO). Adding one is
  a #70 decision with its own cost and human gate.


## Delivered in this pass (in-repo only; no Cloudflare mutation)

**Per-environment Workers.** `web/wrangler.jsonc` declares `cba-study-coach-dev-web` and
`cba-study-coach-pilot-web`, mirroring the `cba-study-coach-<env>-*` separation the AWS side
already has. Separate Workers are what stop a dev deploy from overwriting pilot.

Routes and vars are deliberately absent and stay absent. Whether the pilot serves from a custom
domain or the `workers.dev` origin is an OPEN DECISION on this issue, and not a cosmetic one — it
determines the exact origin in the #69 CORS list and the Cognito callback/logout URLs. Writing a
route would decide it silently. Values would be endpoints in a tracked file and a build-time freeze
of something the contract requires to be resolved per request.

**The runtime-variable contract now covers the `COGNITO_*` values.** `/auth/config` validated them
inline with a presence check; they are now resolved by `resolveCognitoConfig` in `lib/bff-config.js`
with the same fail-fast discipline `CBA_BFF_BASE_URL` already had. Two rules are worth naming:

- `COGNITO_DOMAIN` must be an absolute `https` origin, not a bare host. `auth-settings.js` uses it
  as a URL BASE (`new URL('/logout', domain)`), so a bare host would resolve relative to the
  frontend and send the learner to a logout URL on the wrong site. The first version of this
  validator required a bare host and an existing test caught it — the fixture was right and I was
  wrong about the contract.
- On a DEPLOYED tier the reserved `.invalid` placeholder is refused. The callback/logout URLs still
  default to it while the domain decision is open, and a placeholder reaching a deployed tier
  renders a sign-in button that cannot complete its redirect: the page looks healthy and the flow
  is dead, which is exactly what a health check passes straight over. Local development may still
  use it.

**Ephemeral previews cannot enter the CORS allow-list.** `parseCorsOrigins` enforces at most ONE
exact `https` origin AND binds it to the environment: on `workers.dev` the leftmost hostname label
must be exactly `cba-study-coach-<env>-web`. Both rules are needed and neither is sufficient — the
count stops an origin being appended, and the Worker binding stops a preview URL REPLACING the
stable one, which is the likelier mistake. Hosts that embed a Cloudflare domain without being on it
are rejected as lookalikes; custom domains stay unconstrained so the open origin decision is not
pre-empted.

## Not delivered, and why

**Frontend gates F1/F2 are not implemented here.** They are listed in the Stage B scope, but they
are gates in the #70 workflow: F1 runs immediately after the frontend deploy against `FRONTEND_URL`,
and F2 runs after BFF gates 1-3 using the real ids those gates create. Neither has an input to bind
to until the deploy lane exists, and F2's contract depends on data produced by a job this repo does
not yet have. Building them now would mean guessing both interfaces. They belong in the #70 slice
that also wires the deploy — recorded here so the omission is a decision, not an oversight.

**Nothing account-level was touched:** no Cloudflare project, token, route, deploy, preview,
`opennextjs-cloudflare migrate`, AWS mutation, secret operation or paid call.

## Residual risks

- The per-environment Worker names are declared but unproven — the first `--env dev` deploy under
  #70 is what confirms wrangler resolves them as expected.
- The CORS one-origin rule assumes one stable origin per environment. If the pilot ever needs a
  second legitimate origin (an apex plus `www`, say), it has to be revisited deliberately rather
  than by relaxing the limit in passing.
- **What the local check does and does not cover.** Preview prefixes and the other environment's
  Worker name ARE rejected here — a `workers.dev` origin must carry exactly
  `cba-study-coach-<env>-web` as its leftmost hostname label — and hosts that merely embed a
  Cloudflare domain are rejected as lookalikes. What this repo cannot verify is the rest of the
  hostname: the Cloudflare account SUBDOMAIN is not known here, so
  `cba-study-coach-pilot-web.someone-elses-account.workers.dev` passes the local rule. #70 must
  validate the full `FRONTEND_URL` against the actual account subdomain before deploying. The local
  rule narrows the shape; it does not prove ownership.
- The `.invalid` refusal only fires on a deployed tier. A misconfigured LOCAL runtime can still
  render a sign-in that cannot complete, which is the correct trade — local work has no real domain.

## Validation

root **359/359** · web **65/65** + `next build` OK + `leak-scan` PASS · infra/aws **100/100** ·
services/bff **164 / 163 pass / 1 skip** · bank **60 valid / 0 errors** · credential-free
`cdk synth` OK for `dev` and `pilot` · `git diff --check` clean · no `deploy`/`preview` script in
`web/package.json` · no token, account id, zone id or endpoint in any tracked file.

## Codex review round 1 — findings and fix-forward

`81eee44` is preserved; corrections are in a third commit. All three findings were reproduced first.

**HIGH — pilot preview URLs were implicitly public.** Both `workers_dev` and `preview_urls` default
to `true`, so declaring the environments without them meant deploying pilot would publish versioned
and aliased preview URLs — public origins pointing at pilot, which the contract forbids. Both are
now explicit on every environment. Pilot gets `preview_urls: false` permanently, and
`workers_dev: false` as the fail-closed side of the open origin decision: nothing is published
while it is pending, and flipping it is part of that decision. Dev keeps both `true`, which is what
the contract gives it — ephemeral UI-only previews alongside one stable URL. A new
`web/test/wrangler-config.test.mjs` asserts the EFFECTIVE configuration, because an absent setting
is invisible in a diff and still publishes.

**MEDIUM — the CORS count did not exclude Workers previews, and the code said it did.** The claim
was wrong: counting stops an origin being APPENDED and does nothing about a preview URL REPLACING
the stable one, which is the likelier mistake. `parseCorsOrigins` now takes the environment and
requires a `workers.dev` origin's leftmost hostname label to be exactly `cba-study-coach-<env>-web`.
A preview is the stable hostname with a prefix, so that one rule rejects both documented shapes and
the other environment's Worker. Writing the tests also surfaced a gap Codex did not name: a host
that EMBEDS the Cloudflare domain without being on it (`…workers.dev.evil.test`) fell through to the
unconstrained custom-domain path purely because the suffix check did not match; it is now rejected
as a lookalike. Custom domains stay otherwise unconstrained so the open decision is not pre-empted.
The false "count rule enforces previews" wording is gone from the code, the README and this file.

**MEDIUM — public auth config accepted credential-shaped values.** Reproduced exactly: an AKIA-shaped
pool id, a JWT-shaped client id and a domain carrying a path all returned 200. These values are
served publicly, so the consequence of being wrong is asymmetric — an id in the wrong place is a
broken sign-in, a secret in the wrong place is published to every browser. Both ids now have
explicit format checks, plus tripwires for JWTs, AWS access key ids, ARNs, URLs, PEM blocks,
provider tokens, control characters and implausible length. `COGNITO_DOMAIN` must have pathname `/`
with no credentials, query or fragment, and the resolver returns the NORMALISED origin — a path is
not cosmetic, because `new URL('/logout', base)` discards it and the logout URL would silently
differ from what was configured. No rejected value is ever echoed, and `/auth/config` still answers
the generic `AUTH_MISCONFIGURED`; a test asserts the message does not contain the input.

The `client-id` test fixture was replaced with a realistic Cognito app-client id, since the old one
was not a plausible value and the format check now rejects it.

### Validation after the fix

root **359/359** · web **71/71** + `next build` OK + `leak-scan` PASS · infra/aws **101/101** ·
services/bff **164 / 163 pass / 1 skip** · bank **60/0** · credential-free `cdk synth` OK for `dev`
and `pilot` · `git diff --check` clean.


## Codex review round 2 — documentation correction

**LOW — the active documentation still described the superseded implementation.** Two statements
contradicted the corrected code, and one of them contradicted my own report: I said the obsolete
"count rule keeps previews out" wording had been removed, having fixed it in the deliverables
section and left it standing in the residual risks. That is exactly the kind of half-correction
that misleads the next reader more than the original error did.

- The residual risk claiming Workers preview aliases are not pattern-matched is replaced with the
  real boundary: preview prefixes and cross-environment Worker names ARE rejected locally, while
  the Cloudflare account subdomain is not knowable here — so `#70` must still validate the full
  `FRONTEND_URL` against the real account subdomain before deploying. The local rule narrows the
  shape; it does not prove ownership.
- `wrangler.jsonc` said #70 owns the per-environment Worker names. #67 Stage B owns the names and
  the `workers_dev` / `preview_urls` posture, and the header now says so; #70 owns the routes, the
  runtime values and the deploy.

No code changed in this pass.


## Codex review round 3 — wording correction

**LOW — the corrected header contradicted itself.** It said #70 owns the deployment and then called
deployment "out of scope in this repo entirely". The second claim is false: #70 implements the
human-gated deployment workflow IN this repository. What is prohibited is narrower and more
specific — the package-level path. `web/package.json` has no `deploy` or `preview` script and must
never gain one, so no local `npm run` can mutate a Cloudflare account; `opennextjs-cloudflare
deploy` is reachable only from the #70 workflow, behind the GitHub Environment approval.

The "out of scope entirely" phrasing would have sent the #70 executor looking outside this
repository for something that is implemented inside it. No code changed in this pass.
