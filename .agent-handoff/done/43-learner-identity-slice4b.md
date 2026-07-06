# Task: #43 Implement #11 slice 4b — learner identity and auth boundary

## Owner

- Agent: Claude (executor)
- Human gate: required before push

## Source of truth

- GitHub issue: #43 (slice 4b of #11; part of #33; builds on #42)
- Runtime: `docs/adr/0002-cloudflare-nextjs-aws-bff.md` (Cognito-mediated sessions later)
- Code base: `web/lib/*`, `web/app/**` (slices 1–4a pushed; origin/main at `77989e3`)

## Context

Slice 4a scoped every record by `learnerId` but all callers still pass a hardcoded stub. Slice 4b
adds the identity boundary: routes resolve a request-derived learner through an identity provider
port (dev provider now, Cognito adapter later) and pass it into the store; ownership is enforced
(`403 NOT_RESOURCE_OWNER` from the contracts becomes real). Dev mode stays simple: a deterministic
dev learner when auth is not configured.

## Do

- `web/lib/identity.js` — identity port: `resolveLearner(request)`; provider selection via
  `CBA_WEB_AUTH=dev|cognito` (default `dev`). Dev provider: `x-cba-learner` header, `cba_learner`
  cookie, else deterministic `dev-learner`. Cognito provider: explicit not-configured seam.
- `web/lib/store.js` — every learner-scoped function takes `learnerId`; ownership checks return
  `403 NOT_RESOURCE_OWNER` on cross-learner access; remove the stub constant as product behavior.
- Route handlers resolve identity and pass it through (they never hardcode a learner).
- Committed regression `web/scripts/smoke-identity.mjs` (isolation between two learners, ownership
  403s, deterministic dev default, cookie path).
- README: identity/auth section (modes, env, Cognito seam, note about pre-#43 dev data).

## Do not

- No billing, AI coach upgrade, admin authoring, or enterprise account model.
- No browser access to AWS credentials/AI providers; no infra language in learner UX.
- No push without explicit human approval; root `.gitignore` and the EVENTS.md local audit untouched.

## Validation

- `npm run agent-refresh`; root `npm test`; `node bin/cli.js validate`; `git diff --check`
- `web`: `npm run build`; 4 existing smokes (memory server) + restart-persistence + new identity smoke

## Work log

- Assumed by Claude (executor). Boot ok; origin/main `77989e3`; no active handoffs. Read issue #43.
- `lib/identity.js` (new): identity port `resolveLearner(request)` with provider selection
  (`CBA_WEB_AUTH=dev|cognito`, default dev). Dev provider resolution: `x-cba-learner` header →
  `cba_learner` cookie → deterministic `dev-learner` (tokens validated, `dev-` prefixed). Cognito
  mode is an explicit not-configured seam per ADR-0002 — no fake JWT handling.
- `lib/store.js`: `STUB_LEARNER_ID` removed as product behavior; every learner-scoped function now
  takes `learnerId` (drills, mock, results, missed, coach, resume, stats); new `requireOwnership`
  makes the contracts' `403 NOT_RESOURCE_OWNER` real on sessions/attempts/mocks; the coach only
  reveals the caller's own answer history; the single-in-progress-mock rule is now per learner.
- All 12 BFF routes resolve identity via the port and pass it through — no route hardcodes a
  learner. Pages unchanged (browser identity flows via cookie/default).
- Committed regression `web/scripts/smoke-identity.mjs` (14 checks): two-learner isolation,
  ownership 403s on session/results/missed/mock, isolated dashboards, coach answer privacy,
  per-learner mock rule, deterministic anonymous default, cookie–header equivalence.
- README: Identity/auth section (modes, resolution order, Cognito seam, pre-#43 data note).
- Verified: build clean (zero warnings); 4 existing smokes ALL PASS unchanged (bare requests fall
  back to the deterministic dev learner — backward compatible); identity smoke 14/14 ALL PASS;
  restart-persistence ALL PASS.
- Moved this handoff `active/` → `done/`.
- Architect amend (same commit): `web/README.md` retitled to slices 1–4b (#39–#43) with the
  identity boundary added to the intro list and the Real column (incl. `NOT_RESOURCE_OWNER` in the
  contract-semantics row); the stale "Auth — fixed stub learner" stub removed — replaced by "Real
  Cognito adapter — next", making explicit the `dev|cognito` boundary already exists and Cognito
  lands as an adapter without touching routes/store/records/frontend; `/api/me` + sign-in noted as
  arriving with the Cognito slice. `web/package.json` description updated to the slices 1–4b
  learner loop. Revalidated per the architect's exact sequence (incl. identity smoke against
  `npm run start -- -p 3130` with the memory store).

## Final report

- Status: **DONE**; awaiting human gate for push.
- Local commit: `feat: implement #11 slice 4b learner identity and auth boundary` (unpushed —
  resolve the current SHA with `git log --oneline origin/main..HEAD`).
- Validation result: root `npm test` 68/68; `node bin/cli.js validate` 60/0; `git diff --check`
  clean; `agent-refresh` ok; web build clean; 6/6 smokes ALL PASS (drill, mock, review-coach,
  blank-mock, restart-persistence, identity).
- Push/CI status: **not pushed** — pending human gate.
- Remaining risks/follow-ups:
  - Dev identities are convenience-grade (header/cookie are client-asserted) — correct for the
    pilot; real authentication is the Cognito adapter behind `resolveLearner`.
  - Learner-facing `/api/me` (§16) and a sign-in surface arrive with the Cognito slice; the Shell
    greeting stays generic until then.
  - Data written before #43 sits under the old stub id (documented; wipe `web/.data/` if needed).
