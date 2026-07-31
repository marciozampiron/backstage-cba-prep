# Active: Cloudflare/AWS deploy pipeline and post-deploy smoke gates (#70)

Roles and messages are canonical in [`../MESSAGE-PROTOCOL.md`](../MESSAGE-PROTOCOL.md); the
publication mechanism is canonical in
[`../../docs/architecture/agent-publication-runbook.md`](../../docs/architecture/agent-publication-runbook.md).
This file does not restate either.

## Status

**SLICE A IN REVIEW.** Taken into active ownership 2026-07-31 on Zamp's assignment, moved from
`inbox/` with the policy references moved alongside.

Issue #70 is OPEN. Issues #46 and #68 close behind it.

Slice A delivers the ordering and the refusals — the preflight, the lane skeleton and the human
gates. **Nothing is deployed and no later slice is started.** No AWS call, no Cloudflare call, no
preview, no secret access and no paid call was made producing it.

## Ownership

- Implementation executor: **Claude Opus 5** (worktree `../cba-issue-70`, branch
  `task/70-deploy-pipeline-slice-a`, cut from `origin/main`).
- Architect / independent technical and security reviewer, read-only: **Codex**.
- Assignment, approval, risk acceptance, gate and merge authority: **Zamp**.
- One owner at a time: while this is in `active/`, no other agent takes #70 files.

## Slice A — what was delivered

**One definition of the deployed values.** `DEFAULT_AUTH_URLS` and the `authDomainPrefix` fallback
moved out of `identity-stack.js` into `context.js`, and the stack now reads them from there. This is
load-bearing rather than tidy: a preflight with its own copy of the defaults can pass while the
stack synthesizes something else, and the check would be measuring itself.

**`infra/aws/lib/deploy-preflight.js`** — PURE evaluation of PREFLIGHT-1 and PREFLIGHT-2. No I/O, so
every adversarial control is an offline unit test. Both conditions are always evaluated, so one run
reports every reason it refused instead of making an operator discover them one deploy at a time.

- PREFLIGHT-1 reads the EFFECTIVE URLs after context resolution, never the committed default. An
  override that silently failed to apply — a misspelled key, a `-c` that never reached the CLI, a
  workflow input that expanded to empty — is indistinguishable from one that was never attempted
  unless the resolved value is what gets read. It decides on the parsed HOSTNAME: a path containing
  `.invalid` is legitimate, and `https://pilot.invalid.attacker.example` is a real resolvable origin
  that a substring rule would wave through as "obviously the placeholder".
- PREFLIGHT-2 requires the context KEY, not a value — the stack's fallback means a value always
  exists at synth time. It also requires confirmed regional uniqueness, refuses prefixes Cognito
  itself would reject before a deploy discovers them mid-stack, and treats a redeploy onto our own
  domain as a pass only when the expected pool id was supplied.

**`infra/aws/bin/deploy-preflight.js`** — the collector. One read-only AWS call
(`cognito-idp describe-user-pool-domain`), injectable so no test reaches a remote, time-bounded, and
it echoes no other tenant's user pool id. Exit 1 on refusal is what stops the lane; exit 2 is a usage
error, kept distinguishable. `--skip-probe` exists for offline dry runs and FAILS PREFLIGHT-2 by
design: skipping the question is not answering it.

**`.github/workflows/deploy-pilot.yml`** — the no-spend skeleton. `workflow_dispatch` only, so a
merge to `main` can never spend money unattended. The preflight is a separate JOB rather than a step,
because a step can be reordered, made `continue-on-error` or skipped by an `if:` without anything
noticing, while a failed job in `needs:` stops the dependent job outright. Environment separation is
by input, with the GitHub Environment named on both jobs — that is what turns "a human should
approve" into "the job does not start until a human approves". Reviewers and branch policy are
repository settings, deliberately not in this file: a workflow cannot grant itself an approver.

**Fail-closed everywhere.** An observation that could not be taken is a FAILURE, never a pass. A
denied probe, an absent region and an unparsed response are all refusals.

## Slice A — what was NOT done

- No `cdk deploy`, no Cloudflare deploy, no preview, no account mutation, no secret access, no paid
  call. A test asserts the lane contains no deploying command at all, so a later slice adding one has
  to update that assertion deliberately.
- The deploy job is a placeholder. It exists now only so the ordering and the gate are established
  and asserted BEFORE any deploying step is written.
- The AWS stack deploys, the Cloudflare half, the F1/F2 gates, the live SNS/KMS notification proof
  and the smoke lane all remain later slices.

## Slice A — validation

Root and infra suites, `cdk synth` for both tiers, and adversarial controls proven to bite by
mutation rather than merely to pass. Recorded in the review request for this slice.

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
  the reserved `.invalid` placeholder. Decide it before writing any route, and see the binding
  preflight below — deciding is not the same as having supplied the value.
- Cloudflare account/project setup and the Environment-scoped API token — never committed.
- Per-environment Worker routes and the runtime variable VALUES the Worker serves:
  `CBA_BFF_BASE_URL` first, plus the `COGNITO_*` values `/auth/config` reads.
- Deploy lane wiring: build once, promote the same artifact. `opennextjs-cloudflare deploy` is
  invoked ONLY from the #70 workflow behind the Environment approval, never from a repo script.
- Preview/ephemeral URLs stay out of the BFF CORS allow-list (`pilot-environment-contract` §1).
- Frontend gates F1/F2 against `FRONTEND_URL`, and the rollback path in runbook §4.1.
- Cache/incremental-cache backend: Stage A deliberately ships none (no R2/KV/D1/DO). Adding one is a
  #70 decision with its own cost and human gate.

### Deploy preflight (BINDING, registered by #69 — applies to EVERY deploy lane)

Two conditions were registered against #70 by `done/69-cognito-cors-boundary.md` and they are
carried here unchanged. They are not advice, and not a checklist item for the pilot lane only: every
deploy lane — dev, pilot, any future environment, and any manual invocation — must evaluate both and
**fail before `cdk deploy` runs**, not after. A deploy that has already created a User Pool domain
is not a state you back out of cheaply.

- **PREFLIGHT-1** — refuse to run `cdk deploy` if `.invalid` still appears anywhere in the effective
  `authCallbackUrls` or `authLogoutUrls` for the target environment. The committed pilot defaults
  are `https://pilot.invalid/auth/callback` and `https://pilot.invalid/`; `.invalid` is the RFC 2606
  reserved TLD precisely so that a forgotten override cannot resolve by accident. Check the
  EFFECTIVE value after context resolution, not the committed default — an override that silently
  failed to apply looks identical to one that was never attempted.
- **PREFLIGHT-2** — refuse to run `cdk deploy` unless the pilot `authDomainPrefix` was **explicitly
  supplied** and **confirmed unique in the target region**. A value existing is not the condition:
  `identity-stack.js` falls back to `cba-study-coach-<env>`, so an unsupplied prefix is
  indistinguishable from a deliberate one. Cognito hosted-UI domain prefixes are globally unique per
  region, so an unverified prefix fails at deploy time, mid-stack, after other resources exist.

Neither condition is satisfied by the domain decision alone. Deciding the origin is what makes the
values knowable; supplying and verifying them is what clears the preflight.

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
- PREFLIGHT-1 and PREFLIGHT-2 above, implemented and failing closed on every deploy lane. GO is not
  a judgement call about them: the lane must refuse on its own.

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
