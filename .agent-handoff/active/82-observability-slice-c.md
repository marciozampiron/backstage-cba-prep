# Task: AWS operational observability — Slice C, release gates O1/O2 (#82)

## Status

- Slices A and B are merged (`2d8ab13`). Slice C is IMPLEMENTED locally and awaiting independent
  review and the human publication gate.
- #82 remains a prerequisite of #70; this slice ships the gate #70 will call, not the workflow.

## Owner

- Architecture owner: Codex
- Slice C executor: Claude Opus 5
- Human gate: required before push. No deploy, no AWS/Cloudflare call, no live CloudWatch read.

## What this slice ships

`observability-gate`, a read-only command with two gates, split into a pure decision layer and a
thin collection layer.

- `src/lib/observability-gate.js` — total functions over observations. No AWS call, no clock, no
  process exit. This is what makes the negative controls real: "no traffic was observed" and "an
  alarm is in ALARM" are ordinary inputs, so every blocking path is a unit test rather than
  something that would need a deployed environment to exercise.
- `src/commands/observability-gate.js` — collection only, through an injectable AWS CLI invoker
  (the `bedrock-check` pattern: the root package stays dependency-free and no test reaches a
  remote).
- `bin/cli.js` — registration and help.
- `test/observability-gate.test.js` — 33 tests, mostly negative.

### O1 — structural

Log groups exist with the retention §5 pins; dashboard, five saved queries, topic, six native
alarms and the composite exist; every native alarm treats missing data as `notBreaching`; pilot has
a confirmed subscription. Dev is exempt from the subscription requirement — requiring a confirmed
endpoint on a throwaway stack pushes operators toward subscribing a personal address to it.

### O2 — deployed telemetry

Bounded smoke window, API Gateway `Count` >= 1 and Lambda `Invocations` >= 1, and only then alarm
state. All six plus the composite must be `OK`.

## Three decisions worth reviewing

**The read-only role cannot verify structured logging or the access-log allowlist.** The baseline
listed it under O1, but checking it live needs `lambda:GetFunctionConfiguration` and
`apigateway:GET`. Standing permission on the deployed workload is a much larger permanent cost than
the check is worth, for properties already pinned at synth time by the ApiStack tests against the
same template the deploy is built from. O1 verifies the log GROUPS instead, and §15 now records the
delegation rather than implying a check that does not happen.

**The HTTP API id is supplied, not discovered.** `Count` is dimensioned by `ApiId`, generated at
deploy time and not derivable from the environment name. Reading it live would need
`apigateway:GET`. #70 passes it from its own deploy output; it builds the metric dimension and never
appears in the verdict.

**`sts:GetCallerIdentity` is called and does not widen the role.** It is not permission-gated by IAM
and cannot be denied to any principal. Account and partition are used to build one topic ARN in
memory and are never written anywhere.

## Controls that exist because the failure is silent

- **Ordering.** With `TreatMissingData=notBreaching`, an environment no request ever reached reports
  every alarm `OK`. Checking alarms before traffic would pass exactly the deployment nothing
  reached. The gate reads no alarm state until traffic evidence exists, and a test asserts through
  the call spy that `describe-alarms` is never invoked in that case — not merely that the result
  was right.
- **Window staleness.** A `--since` carried from a previous release would let yesterday's traffic
  satisfy today's gate: datapoints return, alarms read `OK`, green. O2 refuses a window older than
  the poll budget plus a short margin, before any metric call.
- **`ALARM` vs `INSUFFICIENT_DATA`.** `ALARM` is decided and blocks immediately; further polling
  cannot make it acceptable. `INSUFFICIENT_DATA` may settle and blocks only at the deadline. A
  missing or unrecognised state blocks immediately — that is the gate failing to see, which is not
  a condition that improves by waiting.
- **Fail closed everywhere.** A call that errors, output that will not parse, an unset region, a
  missing argument: all blocks. A usage mistake is refused before any AWS call at all.
- **Output hygiene.** `assertLogicalOnly` runs over the final verdict and refuses an ARN, a
  twelve-digit account id or a URL. It is enforced on the way out rather than per call site because
  the failure it prevents is accumulation — some future check interpolating a topic ARN into a
  detail string. The verdict reports whether traffic was observed, never how much: a request count
  is learner activity and release evidence outlives the run.
- **The ingestion-not-coverage note rides on every verdict, including the passing one.** A green O2
  is exactly the result later quoted as "the release was verified". It is not.

## Governed-surface change requiring explicit human confirmation

`spec/authority-policy.json` changed in two ways, both of them the closed policy doing its job.

**One line added to the `bin/cli.js` allowlist entry.** The policy pins the whole command block as a
single permitted authority statement, so adding any command invalidates the entry:

    + observability-gate Run release gate O1 (structural) or O2 (deployed telemetry) — read-only

**This file registered as a governed surface.** A new handoff document is an unclassified
operational source until it is declared, and the policy is closed on three axes at once — it must
appear in `governedSurfaces`, be classified in `surfaceClassification`, and hold a key in
`allowedAuthorityStatements`. It is classified `canonical-authority` alongside the Slice A handoff,
with an empty statement list: this document describes work, it does not grant authority.

Nothing else in the policy changed. **Both entries need a human to confirm they are correct**, per
the policy's own rule. An executor extending the allowlist that constrains the executor is exactly
the shape the closed policy exists to make visible, and it is why these are called out here rather
than left to be noticed in a diff.

## Exclusions honoured

No AWS or Cloudflare deploy, no live CloudWatch call, no SNS subscription, no notification-path
proof, no OTEL/Application Signals, no Bedrock or paid call, no push. #70's workflow is untouched.

## Residual risks

- The gate is proven against a stubbed AWS CLI. Response SHAPES are assumed from the API contract;
  a field named differently in practice would surface only on the first live run, and it would
  fail closed rather than pass.
- O2's poll budget is wall-clock. A CloudWatch ingestion delay longer than ten minutes blocks a
  healthy release; the fix is to raise the budget deliberately, not to weaken the traffic check.
- Nothing here proves the notification path. That remains the separately gated live proof.
- #70 still has to call these gates and honour the exit codes; this slice cannot enforce that.

## Validation

root **344/344** · infra/aws **99/99** (unchanged by this slice) · services/bff **164 / 163 pass /
1 skip** · bank **60 valid / 0 errors** · `git diff --check` clean · `npm run agent-refresh` ok ·
credential-free `cdk synth` OK for `dev` and `pilot` · no account id or secret in the diff.

## Codex review round 1 — findings and fix-forward

`d730d75` is preserved; every correction is in a second commit. Each finding was reproduced against
the implementation before being fixed, and the two reproductions Codex supplied were re-run after.

**HIGH — the smoke window could include traffic from before its declared start.** `GetMetricData`
rounds `StartTime` DOWN to the whole minute, so a window captured at `12:32:34` is queried from
`12:32:00`: a request that reached the PREVIOUS deployment at `12:32:10` satisfies both traffic
checks while every alarm reads `OK`, and O2 promotes a release the smokes never reached. Nothing
downstream can catch it — after the fact that datapoint is indistinguishable from a legitimate one.
Passing the unrounded timestamp does not help; the alignment has to happen before the smokes run.
`assertSmokeWindow` now refuses a start that is not minute-aligned, before any metric call, and
names the barrier to use. `nextMinuteBarrier()` always advances, because a barrier equal to "right
now" shares a timestamp bucket with the previous deployment's in-flight requests. The baseline and
the runbook now carry the four-step procedure — deploy, O1, wait for the barrier, then smoke — with
a copy-pasteable barrier command. Regression uses Codex's exact `12:32:34Z`.

**MEDIUM — O2 accepted qualified metric results.** `sumOf` ignored `StatusCode` and `Messages`.
Because a `PartialData` or `InternalError` result arrives with its values populated, summing them
turned a response that reported incomplete data into a report of healthy traffic. Reproduced exactly as reported: exit 0
with `PartialData` + `InternalError`, both positive. `readMetricSum` now requires exactly one result
per id, `StatusCode === 'Complete'`, no messages at either level, no residual `NextToken`, matching
timestamps, and finite non-negative values; anything else is a refusal, not a smaller number.
Fifteen unit refusals plus four end-to-end cases, all carrying positive values, each asserted to
block BEFORE any alarm is read.

**MEDIUM — O1 checked the composite's name but not its type.** Reproduced: a green O1 with the
aggregate reported as a `MetricAlarm`. The composite is what carries the SNS action, so the
aggregation and sole-notification topology could be absent with the gate still green. Native alarms
must now be `MetricAlarm` and the aggregate exactly `CompositeAlarm`, with five negative controls
including the swapped-types case, where every name is present and the counts are right.

**LOW — the ten-minute maximum was not a real wall-clock bound.** `spawnSync` had no timeout,
`deadlineReached` was computed before the remote calls, and a full interval was slept regardless of
remaining budget. Calls now carry a process timeout plus `--cli-connect-timeout`/`--cli-read-timeout`
(both configurable to zero, meaning block forever) and `--no-cli-pager`, with the pager and
auto-prompt disabled in the environment; a killed or un-spawnable process is reported as a failure,
which every caller already treats as fail-closed. The deadline is judged AFTER the calls, and each
sleep is trimmed to the remaining budget. Covered by fake-clock tests — a slow call that burns most
of the budget, a budget shorter than one interval, and a hanging or un-spawnable invoker.

### Validation after the fix

root **354/354** · observability-gate **43/43** · infra/aws **99/99** (untouched) · bank **60/0** ·
`git diff --check` clean. Both Codex reproductions now block: F2 exits 1, F3 returns `ok: false`.

## Codex review round 2 — findings and fix-forward

`d730d75` and `fa46eba` are preserved; corrections are in a third commit.

**MEDIUM — the documented release-barrier command computed the wrong time.** Reproduced exactly as
reported: GNU `date -d "12:32 +1 minute"` reads `+1` as a timezone component, giving `11:33`;
`23:59` gives `23:00`; `00:00` gives the previous day. A stale barrier skips the wait loop and O2
then blocks on `WINDOW_STALE`, so the canonical procedure could not be followed as written. Rather
than fix the shell arithmetic, the runbook now asks the code: `observability-gate --barrier` prints
the barrier through `nextMinuteBarrier()` and does nothing else — no AWS call, no environment, no
gate — so the documented procedure and the check that later enforces it cannot diverge. The wait
loop compares epoch seconds, which is safe across every boundary. Coverage: ordinary time,
already-aligned time (it must still advance), 23:59 UTC, the year boundary, and midnight; plus a
test that reads the runbook, refuses a `+1 minute` form, and EXECUTES the documented command,
asserting the result is minute-aligned and in the future.

**LOW — the ten-minute maximum was still not enforced.** The per-call ceiling was passed
unconditionally, so a call starting a second before the deadline still got a full minute, and
another could follow it. The remaining budget is now recomputed before every call and passed as the
subprocess timeout capped by the ceiling, recomputed again between `GetMetricData` and
`DescribeAlarms`, and no call is started with nothing left. The permissive assertion — which
accepted the budget plus nine minutes — is replaced by one that requires elapsed wall-clock time not
to exceed the declared budget at all.

**The new budget tests were checked for being decorative, and the first attempt was.** With a hang
longer than the per-call ceiling, every call was killed on the first round and the run ended after
60 simulated seconds, so the elapsed assertion passed against the OLD implementation too. The test
now uses a 55-second call — just under the ceiling, so calls succeed and the loop keeps going —
which is what puts a round's start near the deadline. Reverting the budget arithmetic now fails both
budget tests; before the rewrite it failed only one.

### Validation after the fix

root **359/359** · observability-gate **48/48** · infra/aws **99/99** (untouched) · bank **60/0** ·
`git diff --check` clean · the documented barrier command executed for real and printed an aligned
future instant.
