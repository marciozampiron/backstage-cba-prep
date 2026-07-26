# Task: AWS operational observability architecture (#82) - design package

## Owner

- Architecture owner: Codex
- Documentation executor/reviewer: Claude Opus 5
- Implementation executor: unassigned; implementation follows the completed independent
  architecture review
- Human gate: required before push and before any AWS/Cloudflare mutation

## Source of truth

- GitHub issue #82, native sub-issue of #46 and prerequisite of #70
- `docs/architecture/aws-observability-baseline.md`
- `docs/architecture/aws-iac-foundation.md`
- `docs/architecture/pilot-release-runbook.md`
- `docs/architecture/deployed-environment-smoke-workflow-design.md`

## Objective

Create a versioned observability view and canonical architecture contract for the pilot:

- native API Gateway, Lambda, and DynamoDB metrics;
- privacy-safe structured application/access logs;
- CloudWatch dashboard, Logs Insights, alarms, SNS, and release gates;
- a separate Cloudflare observability boundary;
- a clearly deferred OTEL/Application Signals evolution path.

## Scope

- `docs/architecture/diagrams/operational_observability.py`
- `docs/architecture/diagrams/out/operational_observability.png`
- `docs/architecture/diagrams/README.md`
- `docs/architecture/aws-observability-baseline.md`
- architecture/wiki pointers owned by the #82 track
- coordination records for this task

## Guardrails

- Documentation and diagram only; no runtime, CDK, workflow, deploy, preview, or account mutation.
- Do not add OpenTelemetry dependencies to domain/application code.
- Do not imply that CloudWatch observes Cloudflare edge failures automatically.
- No learner identity, exam content, request/response bodies, credentials, physical resource ids,
  account ids, ARNs, or environment URLs in telemetry.
- Application Signals/ADOT is a later opt-in decision with explicit cost, privacy, sampling, and
  IAM review.
- Product analytics remains #18; this task owns operational telemetry only.

## Validation plan

- Render the diagram from Python using the installed `diagrams` package and Graphviz.
- Inspect the PNG at original resolution.
- Validate links, markdown, ASCII, secret/account-id patterns, and `git diff --check`.
- Run root tests because the package is documentation-only but shares the repository gate.

## Work log

- Boot/coordination refresh completed: #67 owns frontend files only; no active #82 handoff exists.
- Existing local #82 baseline and architecture pointers were read and adopted rather than replaced
  with a competing document.
- Python `diagrams`, Python Graphviz bindings, and the `dot` binary are installed.
- AWS Knowledge MCP research confirmed the phase split: Application Signals can auto-instrument
  Lambda through an enhanced ADOT layer, while the pilot baseline can use native metrics and
  structured logs without manual OTEL code.
- No push, deploy, preview, Cloudflare mutation, AWS mutation, or model invocation.

## Delivered architecture package

- Canonical document: `docs/architecture/aws-observability-baseline.md`.
- Reproducible diagram: `docs/architecture/diagrams/operational_observability.py`.
- Rendered artifact: `docs/architecture/diagrams/out/operational_observability.png`
  (`3923x1711`, visually inspected at original resolution and by crop after the final review
  fixes, nonblank pixel check passed).
- Diagram index and wiki pointers updated.
- Pilot decision: native metrics + sanitized structured logs; no manual OTEL.
- Phase 2 decision: Application Signals/ADOT auto-instrumentation first, behind a separate
  cost/privacy/sampling/IAM gate.

## Validation

- `npm test`: 77/77.
- `node bin/cli.js validate`: 60/0.
- Python render and `py_compile`: pass.
- `git diff --check`: clean.
- Local links, ASCII, secret/account-id/ARN scans: pass.
- PNG pixel check: 3923x1711 RGB, 11,125 colors, 33.23% non-white.
- No runtime, CDK, workflow, deploy, preview, AWS/Cloudflare mutation, or model call.

## Independent review closure

- B1 resolved: API Gateway `requestContext.requestId` is the canonical deployed correlation id; the
  Lambda transport passes it into the neutral request, and the dispatcher reuses it in completion
  logs and error envelopes. Local transports inject their id before dispatch.
- B2 resolved: O2 requires positive API Gateway `Count` and Lambda `Invocations` in the bounded
  smoke window before alarm `OK` states can pass promotion.
- N1-N4 resolved in the diagram: API metrics edge, visible gate/boundary nodes, separate diagnostic
  and composite alarms, and correct alarm/traffic-to-gate edges.
- N5 resolved with a dedicated environment OIDC read-only gate role and exact action allowlist.
- N6 resolved with a rotating customer-managed KMS key plus CloudWatch-restricted SNS/KMS policies.
- N7 is an explicit omission: the conditional project budget is governance, not part of the
  operational event/incident flow.
- Independent review made no edits and found no DDD, privacy, Cloudflare-boundary, or OTEL deferral
  defects beyond these items.

## Independent architectural review (Claude, executor role)

Two rounds. Round 1 raised two blockers and seven non-blocking findings; round 2 confirmed all nine
resolved and left two LOW items. Round 3 applied exactly those two plus the requested contract
hardening — documentation and diagram only, no runtime/CDK/workflow.

- LOW-1 (diagram legibility): `nodesep` 0.65 -> 0.85; `Native metrics` second line shortened to
  `API + Lambda + DDB`; `Diagnostic alarms` differentiated as `six minimum signals`; and cluster 2
  given internal padding (`graph_attr={"margin": "26"}`) so the leftmost node's label no longer
  overflows the cluster border. The two identical second lines that previously read as one run-on
  string are gone and no label crosses a boundary. Padding only — no node, edge, or architectural
  boundary changed.
- LOW-2 (ownership drift): `aws-iac-foundation.md` now names the customer-managed KMS key with
  rotation and the encrypted SNS topic as ObservabilityStack property, matching the canonical
  baseline.
- Contract hardening (baseline + inbox): O2 proves telemetry INGESTION, not functional route
  coverage; the composite must reference exactly the six alarms and be the sole SNS alarm action
  (asserted both directions); the implicit Lambda log-group adoption path must be decided before
  the first deploy; ONE `requestId` must be provable across neutral request, completion event and
  error envelope with a negative control; the isolated `Resource: "*"` statement may contain only
  the documented read-only actions; and the live CloudWatch -> SNS/KMS -> subscription proof was
  added as a MANDATORY promotion prerequisite executed OUTSIDE O1/O2 under operator credentials —
  required before the first `pilot` promotion and re-proven after any key/topic policy change —
  granting the read-only gate role no new permission.

- Final finding closed (docs-only): the notification-path live evidence now has its OWN GO/NO-GO
  item in `pilot-release-runbook.md` §1, explicitly separated from "notification is confirmed"
  because a registered subscription does not prove delivery through the customer-managed key; and
  `deployed-environment-smoke-workflow-design.md` records that the workflow does NOT execute the
  proof and receives no write permission for it (no `sns:Publish`, no `cloudwatch:SetAlarmState`),
  that the reviewer must confirm the evidence is current before approving the `pilot` GitHub
  Environment, that promotion is blocked when it is absent/negative/stale, and that O1/O2 remain
  read-only and unchanged.

Review evidence: diagram render + `py_compile` pass, PNG inspected at original resolution and by
crop, `npm test` 77/77, `node bin/cli.js validate` 60/0, `git diff --check` clean, sensitive scan
found no account ids/ARNs/keys/endpoints, and `services/bff/src` + `web/lib` + `web/app` carry no
OTEL/CloudWatch imports.

## Final state

- Local architecture commit created; push pending human gate.
- Resolve the current unpublished SHA with `git log --oneline origin/main..HEAD` — it is not
  recorded here because an amend changes it.
- No push, deploy or cloud mutation performed.

## Remaining work

- #82 remains OPEN/Todo: implementation is queued separately in
  `.agent-handoff/inbox/82-aws-observability-implementation.md`.
