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

---

## Slice B — ObservabilityStack (implemented locally, awaiting independent review)

Two preserved commits on `task/82-observability-stack`, branched from `origin/main`. Slice A's
reviewed commits are untouched; no amend, rebase or squash.

### Commit 1 — remove the #82 NUL debt

`services/bff/test/telemetry.test.js` carried a literal NUL byte, which made Git classify the file
as binary: the diff collapsed to `Bin 0 -> N bytes`, so a security test could not be reviewed on
GitHub — the exact file where reviewability matters most. The byte is now built at runtime with
`String.fromCharCode(0)`; the assertion is unchanged and still covers the control character.

With the debt gone, `KNOWN_PRE_EXISTING` in `test/human-publish-script.test.js` is empty. That set
is self-policing: the guard asserts every listed exception still contains a NUL, so leaving a stale
name behind would have failed. The file now has a normal textual diff.

### Commit 2 — implement the stack

`infra/aws/lib/observability-stack.js` replaces the placeholder. Wiring is by construct reference,
never by reconstructed name: `ApiStack` now exposes `bffFunction`, and `app.js` passes the HTTP API,
the BFF function, both log groups and the DynamoDB table explicitly. A missing reference throws at
synth with the property named, because an alarm silently pointed at a renamed function is a monitor
that reports healthy forever.

- **KMS**: one customer-managed key per environment, rotation on, `RETAIN` in pilot / `DESTROY` in
  dev. CloudWatch gets exactly `kms:Decrypt` + `kms:GenerateDataKey` under `aws:SourceAccount` —
  not `kms:GenerateDataKey*`, which would also grant `WithoutPlaintext` and `Pair`.
- **SNS**: one encrypted operational topic per environment. `sns:Publish` is restricted to the
  CloudWatch service principal, this account, and an `ArnLike` on this environment's alarm ARN
  prefix. No subscription in code — the endpoint is operator configuration.
- **Alarms**: exactly six, all `TreatMissingData=NOT_BREACHING`, all action-free. The
  `OperationalHealth` composite references exactly those six and is the only resource carrying the
  SNS action.
- **Dashboard**: the five baseline rows. **Queries**: five versioned, bounded Logs Insights
  definitions projecting only allowlisted fields; `@message` is rejected because it returns the
  whole event and would defeat the Slice A allowlist at query time.
- **Gate role**: environment-scoped, read-only, trusting the imported account-global provider on an
  exact subject (repo + GitHub Environment + `aud=sts.amazonaws.com`), `environment:` not `ref:`.
  Two statements only. No role ARN output, no deploy, write, or log-content-read permission.
- **Outputs**: four logical names. No ARN, account id, endpoint, subscription or secret.
- **No budget**: blocked until the `Project` cost-allocation tag is proven to isolate this project.

### Ownership decision recorded in the canonical docs

Per Zamp's binding decision, `SecurityStack` keeps the account-global OIDC **provider** (one per
issuer per account, so it needs one owner) and `ObservabilityStack` instantiates the
environment-specific gate **role**, importing that provider without creating a second one. The
reasoning is now in `aws-iac-foundation.md` (Observability Stack + Security Stack sections) and
`aws-observability-baseline.md` §4, §4.1 and §15: a role maintained away from the alarms, dashboard
and topic it reads drifts silently when one of them is renamed, because a stale ARN inside an Allow
denies without any signal.

### Negative controls (each mutation is asserted to actually take effect first)

Every invariant is a named function run twice — against the real template, where it must pass, and
against a mutated copy, where it must throw. A control that has never been observed to fail proves
nothing.

| Required control | How it fails |
| --- | --- |
| Removing any one of the six alarms | Each of the six is dropped from the composite rule individually, and separately deleted outright |
| An SNS action on any second alarm | Each alarm × each of `AlarmActions`/`OKActions`/`InsufficientDataActions` |
| Expanding the read-only OIDC action set | Seven additions incl. `logs:StartQuery`, `logs:GetLogEvents`, `cloudwatch:SetAlarmState`, `cloudwatch:*`; plus a second `Resource:"*"` statement |
| Wildcard IAM actions | Wildcards injected into the role trust, key policy and topic policy |
| Unrelated publishers | Another service, `Principal:"*"`, a foreign account, and a CloudWatch statement missing `aws:SourceAccount` |
| Missing stack references | All five props, each omitted in turn |
| Unsupported environment | `staging`, `production`, `prod`, `""` |

### Residual risks

- **The `kms:*` root-administration statement remains.** `kms.Key` always emits it, and AWS
  documents that removing it produces an unmanageable, unrecoverable key. It grants an account
  administrator nothing they do not already have, so it is allowed as a single narrow exception:
  the test requires it to be on a KMS key, principal this account's root, action exactly `kms:*`,
  and at most one such statement in the template. A `kms:*` to a service principal, or a second
  root statement, fails. Flagged for the reviewer as the one wildcard action that survives.
- **Everything here is a synth-time guarantee.** The template can be provably correct and the
  notification path still be dead — a broken key policy loses notifications without changing any
  alarm state. Only the live notification-path proof (§14 of the baseline) closes this, and it is
  out of scope for this slice.
- **The alarm thresholds are estimates, not measurements.** p95 ≥ 12s is derived from the 15s
  Lambda timeout, and the error alarms fire on the first occurrence. Both will need retuning
  against real pilot traffic; too-sensitive alarms get ignored, which is the same as no alarms.
- **`DynamoThrottling` uses a table-level math expression** over `ReadThrottleEvents +
  WriteThrottleEvents`. It will not attribute throttling to a specific index.
- Slice A's residual risks are unchanged; no metric on events missing `requestId` yet.

### Validation

root **311 tests / 310 pass / 1 skip / 0 fail** · infra/aws **91/91** (62 pre-existing + 29 new) ·
services/bff **164 / 163 pass / 1 skip / 0 fail** · web **62/62** + `next build` OK · bank **60
valid / 0 errors** · `git diff --check` clean · `npm run agent-refresh` ok · credential-free
`cdk synth` OK for `dev` and `pilot`, refused for `staging`.

**Zero mutation:** no deploy, no AWS or Cloudflare call, no subscription, no alarm-state change, no
OTEL/Application Signals enablement, no Bedrock invocation, no secret operation, no push, no PR and
no merge. #67, #10, #91/#93, `.vscode/`, `CURRENT.md` and `EVENTS.md` are preserved; the stale
primary worktree was never touched.

### Codex independent review — findings and fix-forward (Slice B)

Both reviewed commits are preserved; every correction lands in a third commit. Each finding was
reproduced against the synthesized template before being fixed.

**MEDIUM — `cloudwatch:GetDashboard` was account-wide.** It supports resource-level authorization,
so it did not belong in the wildcard statement, where it let the gate read every dashboard in the
account. Moved to a `ReadOnlyEnvironmentDashboard` statement scoped to this environment's dashboard
ARN. `GATE_WILDCARD_ACTIONS` is now four actions and the test asserts `GetDashboard` is absent from
it — reintroducing it fails two tests.

**MEDIUM — provider ordering was not encoded.** The role reconstructed the provider ARN from pseudo
parameters, which synthesises cleanly and creates no dependency, so in a clean account the role
could be created before the provider existed. `SecurityStack` now publishes
`githubOidcProviderArn`, `app.js` passes it, and `observability.addDependency(security)` covers the
case where an operator supplies an existing ARN by context (no CloudFormation reference, therefore
no implicit ordering). The synthesized trust is now `Fn::ImportValue` and the assembly lists
`SecurityStack` as a dependency; both are asserted.

**MEDIUM — `DeleteItem` was missing from the SystemErrors alarm.** The adapter's
`releaseActiveMock` deletes the `ACTIVE_MOCK` claim and IAM grants it, so a server-side error there
would have left learners unable to release a mock exam with nothing alarming. The operation list is
now one shared constant used by both the alarm and the dashboard panel, and the test asserts it
equals the set the ApiStack IAM policy actually grants — read from the real ApiStack template, so
adapter, IAM and alarm cannot drift apart.

**MEDIUM — the KMS guards failed open.** The old exemption accepted any `kms:*` statement merely
*containing* the root principal, and the CloudWatch check accepted mixed or additional
service-principal statements. Both now match exact whole shapes: the root statement must be
`Allow`/`kms:*`/`Resource:"*"` with no condition and exactly the account-root principal, and the key
policy must hold exactly one non-root grant with exactly the CloudWatch principal, the two actions
and the `aws:SourceAccount` condition. Seven new negative controls cover a foreign account mixed
into the grant, a second service in the same statement, an extra principal in its own statement, a
dropped condition, `GenerateDataKey*`, a root statement carrying a condition, and a root-shaped
statement for a foreign account. The comment is corrected: the root statement is what lets IAM
policies delegate key use at all, so it does more than restate existing administrator access.

**MEDIUM — "bounded" was a false claim about the saved queries.** `| limit N` caps rows returned,
not what is scanned. Only `startTime`/`endTime` on `StartQuery` define the execution scan range, so
a saved query text cannot carry its own scan bound. The code comment, the test name and baseline §10
now say exactly that, execution-time enforcement is assigned to #70, and a new test asserts the gate
role holds no `logs:StartQuery`/`GetQueryResults`/`StopQuery`, so it cannot execute a query and
bypass the window at all.

**MEDIUM — the notification invariant ignored the target.** It proved only that one composite had a
non-empty action, so retargeting it at another account's topic passed. It now requires
`AlarmActions` to equal exactly `[{Ref: <this stack's topic>}]`, with negative controls for a
foreign ARN, a literal ARN string, this topic plus an extra target, and no target.

**LOW — dashboard content did not match the baseline.** The panel titled "throttling and system
errors" plotted only throttles; `SystemErrors` is now on its right axis, sharing the alarm's
operation list. Row 5 gained the slow-routes query the baseline names. Tests assert the actual
metric and query sets rather than row titles. Baseline §8 is reconciled with what HTTP APIs
actually expose: there is no native "integration errors" metric — integration failures surface as
route `5xx` — so row 2 lists `IntegrationLatency`.

**Guards proven non-decorative.** Four mutations were applied to the implementation and each was
observed to fail the suite before being reverted: SystemErrors removed from the panel (1 failure),
`DELETE_ITEM` removed (1), the slow-routes widget removed (1), and `GetDashboard` returned to the
wildcard set (2).

### Validation after the fix

root **311/311** · infra/aws **99/99** (62 pre-existing + 37 new) · services/bff **164 / 163 pass /
1 skip** · web **62/62** · bank **60 valid / 0 errors** · `git diff --check` clean · credential-free
`cdk synth` OK for `dev` and `pilot`, refused for `staging`.

Residual risks are unchanged except that the surviving `kms:*` is now pinned to one exact shape;
the synth-time-only caveat and the untuned thresholds still stand.

### Codex review round 2 — documentation corrections

Behavior was accepted; these are documentation and comment fixes only, in a fourth commit. No code
path, policy, alarm, query or test assertion changed.

- **Baseline §9 contradicted the implementation.** It required `kms:GenerateDataKey*` while also
  claiming no policy grants a wildcard action. It now states the exact pair, records that the
  narrowing is an **assumption** (AWS guidance commonly shows the wildcard for service event
  sources) which the live notification-path proof must settle before pilot promotion, and documents
  the one unavoidable `kms:*` account-root administration statement with the exact shape the tests
  pin. §15's proof section now cross-references the assumption it exists to falsify. Widening back
  to the wildcard remains a legitimate outcome of that proof — widening without it is not.
- **The saved-query explanation overstated the limitation.** Logs Insights QL does support
  `@timestamp` filtering with `now()` and the datetime functions; what query text cannot replace is
  the execution scan range set by `StartQuery` `startTime`/`endTime`. Baseline §10, the code comment
  and the test comment/name now say filters narrow *returned results* while only StartQuery defines
  the scan range and therefore the cost/exposure boundary. #70 still owns enforcement.
- **Two comments still said "five" wildcard actions** after `GetDashboard` was scoped out. Both now
  say four.
- **Same drift found in §15 and fixed with it:** the section still described one wildcard statement
  holding every listed action, which stopped being true when `GetDashboard` was scoped. It now shows
  the three statements and their resources in a table.

### Validation after the documentation fix

root **311/311** · infra/aws **99/99** · services/bff **164 / 163 pass / 1 skip** · web **62/62** ·
bank **60 valid / 0 errors** · `git diff --check` clean · credential-free `cdk synth` OK for `dev`
and `pilot`, refused for `staging`.
