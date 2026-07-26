# Inbox: Implement AWS operational observability baseline (#82)

## Status

- Architecture package complete and independently reviewed; the two blocking findings are resolved
  in the canonical contracts (request correlation and positive-traffic O2 evidence).
- Implementation owner: unassigned.
- #82 remains OPEN/Todo and is a prerequisite of #70.

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
