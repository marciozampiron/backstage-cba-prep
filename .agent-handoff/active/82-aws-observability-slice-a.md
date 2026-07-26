# Task: AWS operational observability — Slice A, workload-owned telemetry (#82)

## Status

- Architecture package published (`d46d5be`, CI green) and independently reviewed.
- **Slice A: IMPLEMENTED locally + HARDENED after the Codex security review; awaiting re-review
  and the human push gate.**
- Slices B (ObservabilityStack) and C (release evidence) remain unassigned.
- #82 remains OPEN/Todo and is a prerequisite of #70.

## Owner

- Architecture owner: Codex
- Slice A executor: Claude Opus 5
- Human gate: required before push; NO deploy or AWS/Cloudflare mutation in this slice.

## Slice A — delivered

- `services/bff/src/telemetry.js` (NEW): allowlist-built completion event, `console.log` sink, no
  CloudWatch/OTEL/X-Ray/ADOT dependency. Non-scalar and oversized values are dropped, so a leak
  cannot ride an allowlisted key.
- `services/bff/src/app.js`: ONE `resolveRequestId` fallback (the only place an id is ever minted),
  `errorBody(requestId, …)` reuses the canonical value, routes carry a bounded `routeKey`
  (`METHOD /pattern`), and a `finally` block emits EXACTLY ONE sanitized completion event per
  request on every path — success, contract error, 404 and 500.
- `services/bff/src/lambda.js`: copies `event.requestContext.requestId` into the neutral request.
  `context.awsRequestId` is never read and never becomes the correlation key.
- `web/lib/api.js`: the local/in-process transport generates an opaque id BEFORE dispatch
  (`localRequestId`), injectable via `bffRoute(pathFor, { newRequestId })` for deterministic tests.
- `infra/aws/lib/api-stack.js`: explicit Lambda log group + explicit API Gateway access-log group,
  environment retention (dev 7 days / pilot 30 days), pilot RETAIN / dev DESTROY, and an
  allowlisted access-log format (`requestId`, `routeKey`, `status`, `responseLatency`,
  `integrationStatus`) wired onto the default stage. No alarms, dashboard, SNS or KMS — those are
  Slice B.

## Log-group adoption decision (required before any deploy)

**Decision: plain create, no migration needed today.** Neither `dev` nor `pilot` has ever deployed
the ApiStack — the SecurityStack is the only deployed application stack in the authorized account —
so `/aws/lambda/cba-study-coach-<env>-bff` does not exist yet and CloudFormation simply creates it.

If any environment is deployed BEFORE this ships, the implicit group created by the Lambda runtime
would already own that exact name and the stack update would fail with "resource already exists".
In that case the operator must first import/adopt the existing group into the stack (or delete it
while unused). The rule is recorded in the `api-stack.js` header so the next executor cannot miss
it, and #70 must re-check it at deploy time.

## Read first

1. `docs/architecture/aws-observability-baseline.md` (canonical contract)
2. `docs/architecture/diagrams/out/operational_observability.png`
3. `docs/architecture/aws-iac-foundation.md`
4. `docs/architecture/pilot-release-runbook.md`
5. `docs/architecture/deployed-environment-smoke-workflow-design.md`
6. `.agent-handoff/done/82-aws-observability-architecture.md`

## Implementation slices

### Slice A - workload-owned telemetry

- `ApiStack`: explicit Lambda/API access log groups and environment retention.
- **Log-group adoption/migration plan, decided and recorded BEFORE any deploy.** Today the Lambda
  log group is created implicitly by the runtime with never-expiring retention, so making it an
  explicit resource is a migration, not just an addition. Choose and write down one path per
  environment: (a) the environment is still undeployed -> create the explicit group outright;
  (b) the group already exists -> import/adopt `/aws/lambda/<function>` so CloudFormation cannot
  fail on an already-existing resource. Record the removal policy per environment. This decision
  must exist before the first deploy attempt, not be discovered during one.
- Lambda transport maps `event.requestContext.requestId` into the neutral request; local adapters
  create an opaque id before dispatch.
- **One `requestId` per request, provable end to end:** the value the transport put on the neutral
  request must appear UNCHANGED in the sanitized completion event AND in the error envelope. Tests
  assert all three carry the same value in a single request, with a negative control proving that a
  second generated deployed-runtime id fails.
- BFF transport emits one sanitized JSON request-completion event and reuses the same canonical
  `requestId` in every error envelope.
- Privacy guards with positive controls for forbidden fields.
- No CloudWatch/OTEL SDK in domain/application.

### Slice B - ObservabilityStack

- dashboard and versioned Logs Insights queries;
- native API Gateway/Lambda/DynamoDB alarms;
- aggregate `OperationalHealth` composite alarm that references **exactly the six alarms** of the
  minimum set — no fewer, no extras — and is the **only** resource in the environment carrying an
  SNS alarm action. Assert BOTH directions: a dropped alarm (silent gap) and a second publisher
  (duplicate notification) must each fail synth, because notification depends entirely on the
  composite;
- environment-scoped SNS topic encrypted by a customer-managed rotating KMS key: topic publish
  policy restricted by CloudWatch principal + source account + alarm ARN prefix; KMS use restricted
  by CloudWatch principal + source account and exact decrypt/data-key actions;
- dedicated environment-scoped GitHub OIDC observability-gate role with the exact read-only action
  allowlist from the baseline and no deploy permission;
- offline CDK assertions: no wildcard action, no unrelated publisher, and `Resource: "*"` permitted
  ONLY inside one isolated read-only statement that contains **nothing but the exact read-only
  actions enumerated in the baseline** — the test must fail if any action is ever added to that
  statement.

### Slice C - release evidence

- expose logical outputs needed by #70 without physical ids/secrets;
- implement O1 structural checks;
- implement O2 with a bounded smoke window, `cloudwatch:GetMetricData`, API Gateway `Count` >= 1,
  Lambda `Invocations` >= 1, and only then individual/composite alarm-state checks;
- fail when traffic evidence is absent or any alarm is non-`OK` at the deadline;
- **O2 proves telemetry INGESTION, not functional route coverage:** `Count >= 1` and
  `Invocations >= 1` show that requests reached the deployed API/Lambda and that metrics flow; they
  do not show that every contract route was exercised. Functional coverage stays with the #70
  deployed learner smokes, and neither the gate output nor the release summary may imply otherwise;
- update release evidence docs only where the canonical contract requires it.

### Out-of-band - notification-path proof (separately human-gated)

- Live end-to-end proof that CloudWatch can publish through the customer-managed KMS key to a
  confirmed subscription. This is the one silent failure mode: a broken key policy loses
  notifications without changing any alarm state, so neither O1 (existence) nor O2 (alarm state)
  can detect it.
- It runs OUTSIDE O1/O2 under **operator credentials**, and grants the read-only OIDC gate role no
  additional permission.
- It is nevertheless a **mandatory promotion prerequisite**: required before the first promotion to
  `pilot`, and re-proven after any KMS key-policy or SNS topic-policy change before the next
  promotion. Promotion is blocked while the evidence is missing, stale relative to the last policy
  change, or negative.
- Evidence is logical only: environment, date, confirmed yes/no, and the policy version attested.

## Explicit exclusions

- No Application Signals, X-Ray, ADOT layer, manual OTEL, Synthetics, anomaly detection, or RUM.
- No product/learner analytics.
- No AWS or Cloudflare deploy without a separate human gate.
- No SNS subscription mutation without operator approval.
- No account ids, ARNs, endpoints, emails, tokens, exam content, or learner data in tracked files.

## Required report to Codex

- exact files and slices implemented;
- synthesized resources and exact IAM/KMS/SNS policy surface;
- request-correlation, privacy, and positive-traffic tests with positive controls;
- root/infra/BFF test counts, synth result, and `git diff --check`;
- explicit confirmation of no deploy and no OTEL enablement;
- local commit SHA, without push until the human gate.

## Codex independent security review — findings and fix-forward

Reviewed against `spec/security-rules.md` and the #85 baseline. Both findings were reproduced
locally before any change. Fixed in a NEW commit on top of `HEAD`: `7fdc6a4` (Slice A) and
`ecd0f62` (#85, owned by Codex) were NOT amended, rebased or squashed.

### Finding 1 — sensitive values crossed allowlisted keys

`services/bff/src/telemetry.js` validated only type and size, so a key allowlist alone let these
serialize: `requestId: "Bearer-super-secret"`, `routeKey: "GET learner@example.test"`,
`errorCode: "TOKEN_secret"`, `durationMs: -42`. Reproduced verbatim.

Fix — a validator per field, so the VALUE is bounded and not just the key:

| Field | Rule |
| --- | --- |
| `level` | closed enum `info \| error` |
| `message` | only `request.completed` |
| `method` | closed HTTP method set |
| `runtimeEnv` | `local \| dev \| pilot` |
| `statusCode` | integer in 100–599 |
| `durationMs` | finite and non-negative |
| `errorCode` | `^[A-Z][A-Z0-9_]{1,63}$` contract-code shape |
| `requestId` | `^[A-Za-z0-9_=.:-]{1,128}$`, refusing control chars, whitespace, emails, URLs and credential words |
| `routeKey` | only the internal `METHOD /contract/pattern` shape — no email, query, URL, concrete id |

Credential tripwires are split by ambiguity: SHAPE markers (AWS key id, JWT, `sk-`, `gh*_`) are
refused in EVERY string field, while WORD markers (`bearer`, `token`, `secret`, …) are refused only
in `requestId`, so a legitimate future contract code such as `TOKEN_EXPIRED` is not silently lost.

The module header now states the honest model: safety comes from the COMBINATION of internal field
origin, key allowlist and per-field validators — the allowlist alone is not the control.

### Finding 2 — sink failure masked the response

`emit()` was called unguarded inside `finally`, so a throwing emitter turned a valid response into
a rejection. Reproduced verbatim.

Fix — emission is best effort: the call is wrapped, the original outcome is always returned, and
the catch is deliberately SILENT (no second logger, no raw request/body/error) to avoid a failure
loop and to avoid logging exactly the material the allowlist exists to keep out. The guarantee is
now documented as **one emission ATTEMPT per request**, because delivery cannot be promised.

While writing the regressions, the same rule exposed a second side-channel hazard: `startedAt` was
read from the injected clock OUTSIDE the try block, so a throwing clock also rejected the request.
The clock is telemetry too, so it is now read through `readClock()`; when either reading fails,
`durationMs` is simply omitted and the rest of the event still ships.

### Tests added (services/bff 143 -> 163)

- adversarial matrix: token, credential word, AWS key id, email, URL, object, array, oversized
  string, newline injection, control character, whitespace, negative, non-finite, null and boolean
  pushed into EACH of the nine allowed fields — each must be dropped while the other eight fields
  still emit;
- the exact Codex reproduction payload must reduce to `{}`;
- POSITIVE CONTROL: a fully legitimate event survives all nine validators intact, so the matrix
  cannot pass vacuously;
- closed-enum, HTTP-status, duration, errorCode, routeKey and requestId format tests with explicit
  accept/reject lists;
- every REAL dispatcher route key is fed through the validator (no false negatives);
- throwing sink on 200, 4xx and 500 returns the original status/body and never rejects;
- exactly ONE emission attempt on success, contract error and 404 even when the sink throws.

### Accepted risks, unchanged by this fix

- retention stays 7 days dev / 30 days pilot;
- `durationMs` remains dispatcher time; p95 alarms will use the native Lambda metric;
- one event per request stays, with cost reviewed in Slice B;
- #89 owns legal hold and sanitized incident evidence.

### Residual risks after the fix

- A dropped field is silent by design. If a transport regression started emitting a malformed
  `requestId`, correlation would degrade without an alarm; Slice B should consider a metric on
  events missing `requestId`.
- The credential tripwires are heuristics, not proof. They exist as defense in depth; the real
  boundary remains that these fields are internally generated.
- Emission is best effort, so event loss is possible and invisible in-process. It is detectable
  operationally as a gap between API Gateway access logs and application events.
- Telemetry volume/cost is still unbounded per request rate — Slice B owns quotas.

### Validation

services/bff **163 pass + 1 skip** · infra/aws **62/62** · `cdk synth` credential-free OK · web
**62/62** + build OK · root **77/77** · bank **60/0** · `git diff --check` clean ·
`npm run agent-refresh` ok.

**Zero deploy and zero cloud mutation:** no AWS or Cloudflare call, no OTEL/Application Signals
enablement, no Bedrock invocation, no push. `7fdc6a4` and `ecd0f62` are untouched; #10, `EVENTS.md`,
`.vscode/` and all governance residue are preserved.
