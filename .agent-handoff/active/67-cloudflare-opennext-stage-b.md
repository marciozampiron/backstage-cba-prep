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

**Ephemeral previews cannot enter the CORS allow-list.** `pilot-environment-contract` §1 says
previews validate UI only and are never allow-listed; authenticated integration goes through one
stable URL, the single origin the BFF allows. `parseCorsOrigins` now enforces at most ONE exact
`https` origin, rejects `.pages.dev` hosts, and rejects malformed entries. The COUNT rule is what
does the work: with a maximum of one, a per-change preview URL cannot be appended — only
substituted, which is a visible edit rather than an accumulation nobody notices.

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
- The CORS count rule assumes one stable origin per environment. If the pilot ever needs a second
  legitimate origin (an apex plus `www`, say), the rule has to be revisited deliberately rather
  than by relaxing the limit in passing.
- `.pages.dev` is the only preview shape rejected by host. Workers preview aliases are not pattern
  -matched, because inventing a URL grammar for them would be guesswork; the count rule is what
  actually keeps them out.
- The `.invalid` refusal only fires on a deployed tier. A misconfigured LOCAL runtime can still
  render a sign-in that cannot complete, which is the correct trade — local work has no real domain.

## Validation

root **359/359** · web **65/65** + `next build` OK + `leak-scan` PASS · infra/aws **100/100** ·
services/bff **164 / 163 pass / 1 skip** · bank **60 valid / 0 errors** · credential-free
`cdk synth` OK for `dev` and `pilot` · `git diff --check` clean · no `deploy`/`preview` script in
`web/package.json` · no token, account id, zone id or endpoint in any tracked file.
