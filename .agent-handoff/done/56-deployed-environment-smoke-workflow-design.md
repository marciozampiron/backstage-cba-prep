# Task: design deployed-environment smoke workflow (#56)

## Ownership

- Status: done; executed by Claude.
- Intended executor: Claude.
- Architect/reviewer: Codex.
- Human gate: required before push.

## Source of truth

- GitHub issue: #56 (part of #50; supports #48).
- Environment contract: `docs/architecture/pilot-environment-contract.md` (#47).
- Release policy: `docs/architecture/pilot-release-runbook.md` (#55).
- Security baseline: `docs/architecture/github-security-and-oidc-baseline.md`.
- CI/CD foundation: `docs/architecture/ci-cd-security-foundation.md`.
- Learner API contracts: `docs/product/web-bff-contracts.md`.
- Implementation consumer: #70.

## Objective

Produce the canonical, implementation-ready workflow blueprint that turns #55 into deterministic
deployed-environment gates for `dev -> pilot`. This task designs the automation; it must not create
an executable workflow, deploy resources, mutate GitHub Environments, call AWS/Cloudflare, or invoke
a paid model.

## Required design decisions

1. Define manual/reusable workflow entry points, immutable release-SHA handling, target environment,
   concurrency, rerun/idempotency, cancellation, timeouts, and evidence retention.
2. Use the canonical `local -> dev -> pilot` model. `staging` is deferred and must not appear as a
   live tier.
3. Keep targets distinct: `BASE_URL` is the AWS BFF/API Gateway origin and receives API smokes;
   `FRONTEND_URL` is the Cloudflare origin and receives health/UI checks only. Resolve both from
   GitHub Environment configuration; do not accept arbitrary caller-supplied URLs without validation.
4. Specify the job DAG: preflight on the exact SHA/artifacts; independent frontend/BFF deploy
   evidence; frontend health; deterministic BFF gates; dev success before pilot approval; same
   SHA/artifacts promoted to pilot; any failure blocks promotion.
5. Map every #55 deployed BFF gate: blank mock; missed review + deterministic coach; recursive
   pre-submit mock leak scan; Cognito sign-in + cross-learner ownership; DynamoDB persistence through
   the BFF; deterministic cleanup for every created learner/attempt/record, including failures.
6. Define test-data isolation: unique run identity, dedicated learners, parallel-run behavior,
   cleanup ownership, and cleanup-failure handling. No direct table mutation unless a separately
   reviewed least-privilege contract proves it necessary.
7. Define least-privilege GitHub permissions, Environment-scoped vars/secrets, masking, OIDC use,
   and the rule that identifiers, credentials, endpoints secrets, or learner data never enter logs.
8. Define an `always()` go/no-go summary: target, immutable SHA/artifact identity, each gate result,
   cleanup result, promotion eligibility, and rollback target by logical name only.
9. Define rollback hooks as explicit human-gated actions. Never auto-rollback or auto-cut over data.
   Preserve #55's atomic table-config + BFF-IAM update after reviewed `cdk diff`, with no wildcard.
10. Keep release smokes no-spend. Paid/live AI verification is a separate manual workflow and is
    never a release gate or an optional branch inside deterministic release smoke.

## Expected repository changes

- Add `docs/architecture/deployed-environment-smoke-workflow-design.md`.
- Add only the minimum pointer from `docs/wiki/Delivery-Process.md`.
- Update this handoff while executing, then move it to `done/`.
- Do not edit `.github/workflows/**`, `infra/aws/**`, `web/**`, question content, or product
  contracts in #56.

## Acceptance criteria

- #70 can implement the design without inventing environment, security, smoke, cleanup, promotion,
  evidence, or rollback behavior.
- Every #55 section 3.2 gate maps to a job/step, target, credential source, cleanup, and outcome.
- Exam-mode protection proves no correctness or source grounding leaks before mock submission.
- `dev -> pilot` uses the same SHA/artifacts and a `pilot` Environment reviewer.
- Deterministic smokes cannot invoke Bedrock/Strands or spend model tokens.
- Failure, cancellation, rerun, concurrency, cleanup failure, and rollback-request states are clear.
- No workflow or cloud mutation is included in this task.

## Validation and report

- Run `npm run agent-refresh` before edits, commit, and any push gate.
- Run `git diff --check`, `npm test`, and `node bin/cli.js validate`.
- Check links, stale `staging` wording, secret/account-id patterns, and #47/#55 consistency.
- Commit locally without push; report files, decisions, validation, risks, and SHA to Codex.
- Push only after explicit human approval for that exact commit.

## Work log (Claude, executor)

- Boot: agent-refresh ok; main == origin/main; this handoff is the only active one; sources (#47
  contract and #55 runbook) are canonical and already consistent.
- Authored `docs/architecture/deployed-environment-smoke-workflow-design.md` (~200 lines), all 10
  required design decisions closed:
  reusable `workflow_call` smoke + manual orchestrator; `release_sha` validated (40-hex +
  main-ancestry) with build-once/promote-by-digest artifact immutability; per-environment
  concurrency queue (no cancel-in-progress); rerun idempotency via run_attempt identity;
  always() cleanup+summary incl. cancellation; per-job timeouts; 90-day sanitized evidence.
  Canonical local->dev->pilot (staging only mentioned as deferred/forbidden). BASE_URL (BFF API
  gates) vs FRONTEND_URL (health/UI only) resolved exclusively from Environment variables —
  no URL inputs exist, plus https+suffix preflight validation. Full job DAG with independent
  frontend/BFF deploys, dev-green precondition, pilot behind the Environment reviewer with same
  SHA/digests. All five #55 §3.2 BFF gates + frontend health mapped to steps with
  learner/credential/cleanup/outcome (leak scan initially drafted as a denylist scan —
  SUPERSEDED in review by the allowlist schema, see the review section; Cognito gate also proves
  dev-header rejection). Test-data
  isolation: run identity, two PRE-PROVISIONED smoke learners per env (no Cognito admin perms in
  the workflow), no parallel runs by concurrency, cleanup-as-learner via BFF, cleanup failure =>
  run failure + promotion block; flagged open contract item for #70: learner-scoped self-service
  attempt deletion (reviewed #36/#38-track addition) — direct table mutation forbidden.
  contents:read + job-level id-token:write only; env-scoped OIDC role/token/learner secrets;
  logical-names-only logging. always() go/no-go summary (target, identity, gates, cleanup,
  eligibility, rollback target). Rollback = separate manual dispatch (initially drafted as
  tags-only — SUPERSEDED in review: pilot uses `pilot-vN` tags, dev uses validated dev
  manifests); no auto-rollback; PITR cutover stays #55 §4.3 verbatim (atomic table+IAM, reviewed
  cdk diff, no wildcards). No-spend structural guarantee + static invariant tests requirement
  (pattern #73). Failure-state matrix. Acceptance mapping for #70.
- Minimum pointer added to `docs/wiki/Delivery-Process.md`.
- No workflow/web/infra file and no product contract under `docs/product/` touched; the review
  amend DID update two architecture docs for consistency (`pilot-environment-contract.md`,
  `pilot-release-runbook.md` — runtime-config decision). No AWS/Cloudflare/deploy/model call.
- Validated: links resolve; staging only in deferred context; MD018/invisible/ids: 0; root 77/77;
  validate 60/0; git diff --check clean.
- Local commit (docs + this handoff moved to done/) — NOT pushed; SHA via
  `git log --oneline origin/main..HEAD`. Excluded per instruction: `.vscode/`,
  `done/55-pilot-release-runbook.md`, EVENTS.md/CURRENT.md residues.

## Codex review (6 findings) — fixed, amended into the same commit

- (1) Same-artifact vs NEXT_PUBLIC_*: the design now REQUIRES runtime public config — the
  browser's BFF base is a Cloudflare Worker runtime variable (`CBA_BFF_BASE_URL`) served at
  request time; `NEXT_PUBLIC_*` is banned as build-frozen. #47 contract §3/§6 and #55 runbook
  §4.1 updated; decision recorded on issue #67.
- (2) No direct-pilot path: orchestrator inputs are now `release_sha` + `mode: dev_only |
  dev_then_pilot` (no environment input); single flow build -> dev deploy -> dev gates -> pilot
  approval -> pilot deploy with pilot jobs `needs`-chained to dev and Environment-bound (secrets
  only after approval); the reusable workflow has no dispatch trigger.
- (3) Leak scan is now an allowlist JSON Schema with `additionalProperties: false` (derived from
  the BFF contracts, versioned with the smoke suite) — future aliases cannot escape a denylist;
  post-submit positive control kept.
- (4) Persistence gate no longer claims "fresh client" proves another runtime: it combines
  readiness attestation of `CBA_WEB_STORE=dynamodb` (fail-fast on local adapters), API
  write/read, and a verifiable managed-persistence evidence DEFINED BY #68.
- (5) Cleanup contract is #75 (sub-issue of #70): the doc now says "#70 depends on #75" — no
  invented contract, no DynamoDB access with the deploy role.
- (6) F2 authenticated browser smoke resolves /results/:id and /review/:id with REAL ids from
  gates 1-3 (plain 200s insufficient); dev rollback targets prior validated dev manifests (new
  release-manifest concept in §1; pilot keeps pilot-vN tags); this handoff's status corrected to
  done.

## Codex review cycle 2 (operational consistency) — fixed, amended into the same commit

- Preflight split: `global-preflight` (SHA/mode/artifacts — structurally CANNOT read env config:
  no Environment reference) -> `dev-env-preflight` (environment: dev) -> `pilot-env-preflight`
  (environment: pilot, only after dev green + reviewer approval). The reusable workflow's
  internal `target_environment` input is orchestrator-only; no workflow_dispatch on the reusable.
- Host-validation variables named exactly: `CBA_ALLOWED_BFF_HOST_SUFFIX` and
  `CBA_ALLOWED_FRONTEND_HOST_SUFFIX` (per-environment vars).
- Concurrency made implementable: two literal groups `release-dev`/`release-pilot` derived from
  `target_environment`, cancel-in-progress false.
- Cancellation semantics: normal cancel keeps `always()` cleanup/summary; FORCE-cancel kills
  `always()` too -> documented as manual-cleanup-required (new failure-matrix row).
- Commit message corrected (cleanup contract is the #75 dependency, not something #70 invents).
- Stale historical work-log claims annotated as superseded (denylist -> allowlist; tags-only
  rollback -> tags+dev-manifests; "no contract file touched" -> architecture-doc consistency
  edits listed). #68 now tracks the DynamoDB adapter readiness contract (registered by Codex).
