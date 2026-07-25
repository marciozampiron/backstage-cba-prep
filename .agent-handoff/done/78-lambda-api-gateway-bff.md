# Task: Lambda + API Gateway HTTP API Web BFF (#78)

## Owner

- Agent: Claude (executor)
- Architect/reviewer: Codex
- Human gate: required before push; NO deploy / NO live AWS call in this issue

## Source of truth

- GitHub issue: #78 (sub-issue of #68; depends on #76 + #77)
- Boundary: `services/bff` `handleApiRequest` + DynamoDB adapter (#77) — reused EXCLUSIVELY
- Environment contract: `pilot-environment-contract.md` (#47); smoke blueprint: #56

## Plan

- Commit 1 — Lambda transport: API GW payload v2 -> neutral request (method, rawPath, query,
  headers, cookies, base64 body); JSON response with no-store/security headers; zero business
  rules; offline tests (mapping, ownership, errors, exam-mode with RECURSIVE ALLOWLIST, not just
  blacklist); BASE_URL-parameterized deterministic suite that never touches the network in CI.
- Commit 2 — ApiStack: Lambda Node.js + HTTP API with EXPLICIT routes; env
  CBA_RUNTIME_ENV/CBA_WEB_STORE=dynamodb/CBA_WEB_TABLE (+ fail-closed auth: CBA_WEB_AUTH=cognito,
  no dev auth in deployable runtime); reproducible bundling of the two @aws-sdk packages; MINIMAL
  DynamoDB IAM (Get/Put/Update/DeleteItem on the exact table ARN; Query only on the exact gsi1
  index ARN; no Scan/Batch/wildcards); DataStack -> ApiStack by explicit reference; public
  readiness = {adapter, ready, runtimeEnv} only; CORS as a #69 seam (never "*" with credentials);
  CDK tests for dev/pilot, invalid env, routes, env vars, bundling, exact IAM.

## Out of scope

- #69 Cognito/CORS produção, #70 deploy, #75 cleanup, #67 Cloudflare, Bedrock/Strands, live AWS.

## Work log

- Commit 1: Lambda transport adapter (`services/bff/src/lambda.js`) + deterministic
  deployed-contract suite (recursive allowlist + transport parameterization) + in-process Lambda
  tests + HTTP runner (`deployed-http.test.js`, gated on the canonical `BASE_URL`; skips in CI).
- Commit 2: ApiStack promoted from placeholder — NodejsFunction (node22, bundled with esbuild
  0.28.1 pinned in BOTH infra/aws — where CDK detects it — and services/bff — the depsLockFilePath
  project where it executes); SDK pkgs installed into the asset from the bff lockfile; exam
  content copied into `/var/task/content` (paths quoted: repo path contains spaces); HTTP API with
  13 explicit routes; minimal DynamoDB IAM; fail-closed `CBA_WEB_AUTH=cognito`; CORS seam.
  infra tests 40/40 (7 new), synth OK; infra-synth lane now installs the bff toolchain and watches
  `services/bff/**`.
- Codex review round 1 — three blockers fixed via commit rewrite (no push had happened):
  (1) runtime SDKs bumped 3.844.0 → 3.1095.0, `npm audit` 0 vulnerabilities, fast-xml-parser no
  longer in the lock or the bundled asset; (2) allowlist leaves now accept ONLY primitives (an
  object under an allowed key is a violation) with negative tests top-level/nested/in-array, and
  the drill CREATION response is covered by its own allowlist; (3) real BASE_URL HTTP runner
  added and proven against a live local server (4/4), and the unknown-route 404-envelope
  assertion moved out of the shared suite (API Gateway answers unmatched routes itself under
  explicit-routes-only) into the in-process transport tests. Plus: `spec/blueprint.json` and
  `questions/**` added to the infra-synth path filters (real bundle inputs).
- Validation (round 2): bff 93 (92 pass + 1 CI-skip do runner) · infra 40/40 + synth de cdk.out
  limpo · root 77/77 · validate 60/0 · web build limpo · 4 smokes locais OK (store `.data`
  zerado — smokes usam learners fixos e exigem store fresco; característica pré-existente) ·
  diff --check limpo · sem secrets/account ids · asset real verificado (SDK 3.1095.0, conteúdo,
  readiness 200 in-process).
- Codex review round 2 — two blockers fixed via commit rewrite: (1) runner variable renamed to
  the canonical `BASE_URL` (#55 runbook §3; `CBA_BFF_BASE_URL` stays Cloudflare-runtime-only);
  (2) readiness is now a HEALTH GATE — `assertReadiness` requires ready:true, adapter equal to
  the target's expectation and runtimeEnv in the allowed set; the HTTP runner pins the strict
  DEPLOYED expectations (dynamodb + dev|pilot), the in-process suite passes its local shape, and
  negative tests prove ready:false / wrong adapter / wrong runtimeEnv all fail. Live negative
  proof: pointing BASE_URL at a local (file-store) server fails the gate with
  "adapter must be dynamodb". bff suite: 95 (94 pass + 1 CI-skip).
- Follow-up (non-blocking, flagged by Codex): local smokes use fixed learner names against the
  persistent `.data` file store — state should be isolated per run (fresh store or unique
  learner suffixes). Candidate for #75 (cleanup contract) or a small chore issue.
- PUBLISHED (2026-07-25): human gate approved; pushed `bf9bd35` (Lambda transport) +
  `a31294c` (ApiStack) as `626b715..a31294c` — `origin/main` at `a31294c`.
- CI green on ALL FOUR lanes: Quality (30174652258), Web Quality (30174652262), Infra Synth
  (30174652330 — the new bff bundling-toolchain step ran, real esbuild bundling in the lane,
  40/40), CodeQL (30174651870).
- #78 CLOSED with delivery evidence; board Done (confirmed via GraphQL).
- NO AWS deploy: everything remains synth-only (only the SecurityStack exists in the account);
  deploy belongs to #70, auth to #69.
