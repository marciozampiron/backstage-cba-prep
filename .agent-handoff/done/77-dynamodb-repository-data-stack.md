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
- Commit 1 (Stage A) delivered: async port + composition seam (runtime.js/config.js), 31 awaited
  port calls, clock injectable, CBA_RUNTIME_ENV fail-fast, behavioral suite (memory+file) +
  config suite; two custom-status dispatcher handlers fixed to await their use cases; docs row in
  the environment contract. bff 37/37, root 77/77, build + smokes green at commit time.
- Commit 2 (Stages B+C):
  - Port gained the ATOMIC per-learner active-mock claim (claim/get/release) + logical
    readiness(); file adapter rebuilds claims from legacy files on load. Store now claims BEFORE
    creating a mock (never list-then-create), releases on submit/expiry, self-heals stale claims,
    and currentMockResume rides the claim.
  - DynamoDB adapter (src/dynamodb-repository.js), mock-first: minimal document-client facade
    (get/put/update/query/delete) — SDK only inside `createDynamoDbClient` via dynamic import,
    declared as OPTIONAL PEER deps (#78 bundles them). Access patterns documented in-file:
    record items pk='<TYPE>#<id>'/sk='REC' (GetItem by id), GSI1 gsi1pk='LEARNER#<id>' +
    begins_with(gsi1sk,'TYPE#') for learner-scoped listing (NO Scan anywhere), atomic counter via
    UpdateItem ADD, claim via conditional Put(attribute_not_exists), release via conditional
    Delete(own mockExamId only). Optimistic writes: create requires absence, update requires the
    last-read rev; violations raise RepositoryConflictError -> dispatcher maps to 409 CONFLICT.
    App-level idempotency rules unchanged (identical practice retry OK / different selection 409 /
    mock replace pre-submit only).
  - GET /readiness (unauthenticated by design) returns EXACTLY { adapter, ready, runtimeEnv } —
    never table/ARN/account/record ids; Next route /api/readiness delegates.
  - Tests: the SAME behavioral suite now runs against memory, file, AND dynamodb (fake client that
    honors only the allowed expressions and THROWS on Scan/unknown ops); adapter-specific tests:
    restart durability over the same fake table, stale-rev lost-update prevention, create
    collision, concurrent claim race (exactly one winner), atomic counter ids, readiness
    logical-shape + failure case, static no-Scan/no-wildcard guard (comment-stripped).
  - DataStack promoted from placeholder: single env-scoped table
    `cba-study-coach-<env>-simulation`, PAY_PER_REQUEST, AWS_MANAGED encryption, GSI1; pilot =
    PITR + deletionProtection + RETAIN, dev = explicitly disposable (no PITR, no protection,
    DESTROY); foundation tags; CfnOutput of the logical table name only; ZERO IAM resources
    (grants belong to #78). 7 new credential-free CDK tests incl. zero-IAM/no-wildcard/no-account
    assertions. infra README updated.
- Validation (post commit 2): bff 72/72; root 77/77; infra 29/29; bank 60/0; web build OK; ALL
  four smokes PASS (claims-based mock flow behaviorally identical); /api/readiness returns the
  logical shape end-to-end through Next; diff --check clean; grep evidence: zero Scan in
  services/bff/src + infra/aws/lib, zero wildcard in the DataStack, zero literal account id.
- Risks/notes: (1) rev tokens ride a WeakMap keyed by each READ OBJECT — same-instance and
  cross-instance stale saves both surface as 409 CONFLICT by design (no unbounded growth: tokens
  die with their records); (2) local adapters' claim is single-process
  check-and-set (atomic enough locally; the conditional-write contract is what DynamoDB
  implements); (3) SDK optional-peer choice keeps web/CI installs SDK-free — #78 must bundle the
  two @aws-sdk modules; (4) counter ids differ in format from local ids (no date suffix) —
  contract treats ids as opaque.

## Codex review (4 blockers + 1 architectural) — fixed, amended into commit 2

- (1 CRITICAL) Same-instance lost update: rev tokens now live in a **WeakMap keyed by the READ
  OBJECT**, not by id — two reads through the same adapter instance carry independent tokens and
  the second stale save raises RepositoryConflictError. New regression test reproduces exactly
  the reviewer's scenario (double read, A then D) and asserts A is preserved.
- (2 CRITICAL) Stuck claim after partial failure: `sweepActiveMock` now releases ANY claim whose
  attempt is not in_progress (submitted-but-unreleased, and ghost claims with missing records).
  New `store-claims.test.js` reproduces the torn state through the real dispatcher and proves the
  next start returns 201; the healthy 409 path is also re-asserted.
- (3 HIGH) Dev stacks were pilot-named: stack assembly extracted to `infra/aws/lib/app.js` where
  the base derives from the `environment` context; `bin/cba-pilot.js` delegates. New
  `test/app.test.js` exercises the REAL app: default pilot names, `environment=dev` renames every
  stack with zero 'pilot' leakage, and the dev data table is dev-named + disposable. Verified
  `cdk ls -c environment=dev` now prints `cba-study-coach-dev-*` (the reviewer's repro).
- (4 HIGH) Query pagination: `#listRecords` follows `LastEvaluatedKey` with `ExclusiveStartKey`
  in a loop; the fake client now paginates (configurable page size) and a multipage test (5
  records, 2/page => 3 pages) proves complete listings.
- (arch) `RepositoryConflictError` moved to the NEUTRAL port (`repository.js`); `app.js` no
  longer imports from the DynamoDB adapter. The SDK dynamic imports carry
  webpackIgnore/turbopackIgnore, and the web build is now CLEAN (zero missing-SDK warnings).
- Revalidated: bff 77/77; infra 32/32; root 77/77; synth OK; web build clean; ALL four smokes
  PASS; bank 60/0; diff-check clean.

## Codex review round 2 (environment validation) — fixed, amended into commit 2

- Deployment tiers are now a CLOSED SET at synth: `resolveEnvironment` in `infra/aws/lib/context.js`
  accepts ONLY dev|pilot and throws for anything else — applied in BOTH the real app assembly
  (`lib/app.js`) and directly inside the DataStack (defense in depth for out-of-app construction).
  The reviewer's repro (`environment=production` minting a non-durable stack family) now fails
  synth with an explicit message. Tests cover production, a typo, and the empty value on BOTH
  paths (infra suite 34/34).
- Stale texts corrected: handoff risk note now describes the WeakMap-per-read-object tokens;
  bff `app.js` no longer claims synchronous use cases; infra README no longer calls the data
  stack a placeholder/"only the security stack exists"; bff README + package description now
  state precisely that the ONLY AWS SDK reference is the dynamic optional-peer import inside the
  DynamoDB infrastructure adapter.
- Revalidated: bff 77/77; infra 34/34; root 77/77; synth OK; web build clean; diff-check clean.

## Final report

- Status: **DONE** — pushed as `d430722` + `626b715` (exactly two commits in scope); CI green on
  ALL FOUR lanes: Quality (30173071870), Web Quality (30173071878 — bff harness 77/77 in the
  lane), Infra Synth (30173071913 — 34/34 incl. DataStack + environment validation), CodeQL
  (30173071645). #77 CLOSED with delivery evidence; board Done (GraphQL-confirmed).
- Architecture decision recorded on the issue: the DataStack creates ZERO IAM resources — the
  least-privilege table grants for the BFF runtime role belong to #78, which owns the Lambda role
  and consumes the exported table construct.
- Follow-ups owned elsewhere: #78 (Lambda/API GW + role/grants + SDK bundling of the optional
  peers), #69 (Cognito + /api/me), #79 (preferences), #75 (cleanup contract), #70 (deploy lanes
  consuming the /readiness signal).
- Push/CI recorded in EVENTS.md; residue stays for the next governance cleanup.
