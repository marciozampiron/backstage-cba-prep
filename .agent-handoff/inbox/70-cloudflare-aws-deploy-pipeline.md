# Inbox: Cloudflare/AWS deploy pipeline and post-deploy smoke gates (#70)

Roles and messages are canonical in [`../MESSAGE-PROTOCOL.md`](../MESSAGE-PROTOCOL.md); the
publication mechanism is canonical in
[`../../docs/architecture/agent-publication-runbook.md`](../../docs/architecture/agent-publication-runbook.md).
This file does not restate either.

## Status

NOT STARTED. Prepared 2026-07-30 during the #75 closeout audit, so that #70 has a handoff of its own
instead of inheriting one that belonged to a delivered scope.

Issue #70 is OPEN. Issues #46 and #68 close behind it.

## Ownership

- Implementation executor: **unassigned**.
- Architect / independent technical and security reviewer, read-only: **Codex**.
- Assignment, approval, risk acceptance, gate and merge authority: **Zamp**.
- No agent may take this into `active/` without that assignment — that is what stops two owners from
  landing on the same files.

## What #70 owns, and what it must not touch

This is the first issue in the sequence whose acceptance requires a real deploy. Everything below is
account-level or workflow-level. **No part of it re-opens code already merged and reviewed.**

Explicitly OUT of scope, because it is delivered:

- #67 Stage B's in-repo half — per-environment Worker declarations, the runtime-variable contract,
  the structural CORS guard. Merged in PR #100; see `done/67-cloudflare-opennext-stage-b.md`.
- The smoke-test data cleanup contract. Merged in PR #101; see `done/75-smoke-cleanup-contract.md`.
- The O1/O2 release gates and the `ObservabilityStack`. See the three `done/82-*` handoffs.

Reopening any of those is a scope error, not an improvement.

## Scope

### Inherited from #67 (transferred here on 2026-07-30)

- **The open decision: custom domain or the `workers.dev` origin.** This is not cosmetic. It fixes
  the exact origin in the #69 CORS list and the Cognito callback/logout URLs, which still default to
  the reserved `.invalid` placeholder. Decide it before writing any route.
- Cloudflare account/project setup and the Environment-scoped API token — never committed.
- Per-environment Worker routes and the runtime variable VALUES the Worker serves:
  `CBA_BFF_BASE_URL` first, plus the `COGNITO_*` values `/auth/config` reads.
- Deploy lane wiring: build once, promote the same artifact. `opennextjs-cloudflare deploy` is
  invoked ONLY from the #70 workflow behind the Environment approval, never from a repo script.
- Preview/ephemeral URLs stay out of the BFF CORS allow-list (`pilot-environment-contract` §1).
- Frontend gates F1/F2 against `FRONTEND_URL`, and the rollback path in runbook §4.1.
- Cache/incremental-cache backend: Stage A deliberately ships none (no R2/KV/D1/DO). Adding one is a
  #70 decision with its own cost and human gate.

### AWS side

- Deploy the stacks that are implemented but synth-only: `DataStack` (#77), `ApiStack` (#78),
  `IdentityStack` (#69), `ObservabilityStack` (#82 Slice B). Only `SecurityStack` is deployed today.
- **The live CloudWatch -> SNS -> KMS -> confirmed-subscription proof.** #82 did NOT close this. O1
  proves the resources exist and O2 proves telemetry flows and alarms are `OK`; neither proves a
  notification can actually be delivered. That is the one failure mode that stays silent, because a
  broken key policy loses notifications without changing any alarm state. It is also the only check
  that can falsify the deliberate narrowing of the key policy to exactly `kms:Decrypt` +
  `kms:GenerateDataKey`. Runs under operator credentials, required before the first `pilot`
  promotion, and must be re-proven after any key or topic policy change.
- Wire O1/O2 into the workflow and enforce the bounded execution window on the saved queries.

### Smoke gates

- The deployed smokes call the #75 cleanup contract through the BFF as the smoke learner. They must
  never reach DynamoDB directly.
- **Membership in the `cba-smoke` Cognito group is a human action, once per environment.** The group
  is declared in `IdentityStack` but has no members, and CI is deliberately not permitted to assign
  them — that would give the deploy role Cognito admin permission. Until a human assigns them, the
  cleanup endpoint answers 403 in a deployed environment, and the smoke lane cannot pass.

## Prerequisites before GO

- The 6 high Dependabot alerts on the default branch must be fixed or formally risk-accepted.
- The live SNS/KMS notification-path proof above.
- The custom-domain decision, since the CORS list and Cognito URLs depend on it.

## Explicit exclusions

- No `deploy` or `preview` npm script in `web/package.json` — deployment belongs to the workflow, so
  a local `npm run` can never mutate an account.
- No Cloudflare token, account id, zone id or endpoint in tracked files, logs or fixtures.
- No AWS account id or ARN in tracked files.
- No `opennextjs-cloudflare migrate` — it can provision an R2 bucket.
- No long-lived AWS access keys; OIDC assume-role only.
- No change to the learner API contract, exam-mode rules, or the `apiFetch` single-door seam.

## Read first

1. `done/67-cloudflare-opennext-stage-a.md` and `done/67-cloudflare-opennext-stage-b.md`
2. `done/75-smoke-cleanup-contract.md` (the cleanup contract the smokes call)
3. `done/82-observability-slice-c.md` (O1/O2)
4. `docs/architecture/pilot-environment-contract.md` §1 and §3
5. `docs/architecture/deployed-environment-smoke-workflow-design.md` (F1/F2)
6. `docs/architecture/pilot-release-runbook.md` (GO/NO-GO, rollback §4.1)
