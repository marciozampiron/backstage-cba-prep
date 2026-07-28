# Inbox: Cloudflare Workers / OpenNext frontend (#67) — Stage B

## Status

- Stage A is DONE and published (`done/67-cloudflare-opennext-stage-a.md`): the frontend builds
  for Cloudflare Workers through the supported OpenNext path, with runtime `CBA_BFF_BASE_URL`,
  a single `apiFetch` door, and a Cloudflare artifact leak scan in CI.
- **#67 stays OPEN** — Stage B is the remaining half.
- Implementation owner: unassigned. Stage B lands **with #70** (integrated deploy + post-deploy
  gates); it is not startable on its own.

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
