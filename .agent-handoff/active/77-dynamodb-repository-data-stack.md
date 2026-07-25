# Task: DynamoDB simulation repository + DataStack (#77)

## Owner

- Agent: Claude (executor)
- Architect/reviewer: Codex
- Human gate: required before push; NO deploy in this issue

## Source of truth

- GitHub issue: #77 (sub-issue of #68; depends on #76) + the Architecture kickoff comment
  (Stages A/B/C; two reviewable local commits)
- Environment contract: `pilot-environment-contract.md` (#47); release/PITR policy: #55
- Boundary: `services/bff` (#76 — public dispatcher already Promise-based)

## Plan (from the kickoff)

- Commit 1 (Stage A): async repository/use-case contract; `handleApiRequest` stable; behavioral
  repository suite over memory+file; composition seam injecting repository/clock (+id via the
  repository port); `CBA_RUNTIME_ENV=local|dev|pilot` with loud fail-fast (dev/pilot require
  `CBA_WEB_STORE=dynamodb` + `CBA_WEB_TABLE`); never infer from NODE_ENV; docs.
- Commit 2 (Stages B+C): mock-first DynamoDB adapter (SDK only in infrastructure, injectable
  client); get-by-id + learner-scoped listing WITHOUT Scan (GSI); optimistic/conditional writes;
  practice retry idempotency + selection conflict preserved; mock replace pre-submit only;
  atomic per-learner active-mock claim (port method, not list-then-create); logical readiness
  (adapter kind + ready only); DataStack real (on-demand, encrypted; pilot: PITR + deletion
  protection + RETAIN; dev: disposable explicit); credential-free CDK tests/synth.

## Out of scope

- #78 Lambda/API GW (runtime role/grants), #69 Cognito/CORS, #79 preferences, #75 cleanup,
  deploy, Bedrock/AI.

## Work log

- (in progress)
