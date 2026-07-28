# Pilot Release Runbook, Smoke Gates, and Rollback Policy (#55)

Release process for the CBA Web MVP pilot, defined BEFORE real deploys are enabled. A human must
be able to decide **go/no-go from this document alone**. It follows the canonical environment
model of [pilot-environment-contract.md](pilot-environment-contract.md) (#47): `local -> dev ->
pilot`, **staging deferred** — where older docs (and the parent issue) say "staging/production",
read "dev/pilot". The #56 workflow design and the #70 deploy lanes implement these policies; this
doc does not create automation.

| Question | Source of truth |
| --- | --- |
| Environments, config registry, fail-fast rules | [pilot-environment-contract.md](pilot-environment-contract.md) |
| CI lanes, no-spend policy, branch protection | [ci-cd-security-foundation.md](ci-cd-security-foundation.md) |
| GitHub Environments, OIDC roles, secrets | [github-security-and-oidc-baseline.md](github-security-and-oidc-baseline.md) |
| AWS logs, alarms, dashboard, notifications | [aws-observability-baseline.md](aws-observability-baseline.md) (#82) |
| Learner API surface the smokes exercise | [web-bff-contracts.md](../product/web-bff-contracts.md) |
| Delivery flow and handoff protocol | [Delivery-Process](../wiki/Delivery-Process.md) |

## 1. Release gate flow (manual)

Every deploy is **human-gated**; agents never deploy on their own. The gate order mirrors the
push-gate protocol in `.agent-handoff/README.md`:

1. Change is reviewed (Codex) and pushed to `main` with **all CI green** (Quality, CodeQL, and the
   path-triggered lanes: Web Quality and/or Infra Synth).
2. The operator opens the release by recording a **Release gate** entry in
   `.agent-handoff/EVENTS.md`: the SHA to deploy, target environment, and rollback target
   (previous good SHA + previous deployment id).
3. **Deploy to dev** (frontend and/or BFF, independently). Post-deploy smokes run against dev.
4. **Promotion to pilot** only through the GitHub `pilot` Environment (required reviewer) and only
   after the dev smokes pass. Pilot deploys reuse the exact artifacts/SHA proven in dev — never a
   new build.
5. Post-deploy smokes run against pilot; the result is recorded in EVENTS.md (deployed SHA,
   deployment ids, smoke outcome, rollback target).

### Go/no-go checklist (the human decides)

GO only if ALL are true:

- [ ] CI green on the exact SHA being released (no "will fix after deploy").
- [ ] `cdk diff` reviewed for any infra change in the release (only expected resources; no
      IAM/policy surprises; account id never printed).
- [ ] Dev smokes green (§3) — for a pilot promotion.
- [ ] Observability gates O1 and O2 from #82 are green: expected resources/configuration exist,
      pilot notification is confirmed, API Gateway and Lambda both report positive traffic in the
      bounded smoke window, and all required individual/composite alarms are `OK`.
      Run them read-only. O1 first:
      `node bin/cli.js observability-gate --gate o1 --environment pilot`.
      Then set the **release barrier** before any smoke runs — CloudWatch rounds a metric
      `StartTime` down to the whole minute, so an unaligned window silently includes traffic that
      reached the PREVIOUS deployment, and O2 would promote a release the smokes never touched:

      ```bash
      BARRIER=$(date -u -d "$(date -u +%H:%M) +1 minute" +%Y-%m-%dT%H:%M:00Z)
      while [ "$(date -u +%Y-%m-%dT%H:%M:00Z)" \< "$BARRIER" ]; do sleep 1; done
      # ...run the deployed smokes now...
      node bin/cli.js observability-gate --gate o2 --environment pilot \
        --api-id <deploy output> --since "$BARRIER"
      ```

      O2 refuses an unaligned start, and refuses a window carried over from an earlier release,
      before making any metric call.
      **A green O2 is not functional coverage.** It proves telemetry ingestion — that requests
      reached the deployed API and Lambda and metrics are flowing — not that any particular contract
      route works. Functional coverage is the deployed learner smokes in §3, and O2 must never be
      recorded as evidence that the learner loop is correct.
- [ ] **Notification-path live evidence is valid for this environment** (#82) — a SEPARATE item from
      "notification is confirmed" above. A confirmed subscription proves an endpoint was registered;
      it does **not** prove CloudWatch can actually deliver through the customer-managed KMS key,
      because a broken key policy loses notifications without changing any alarm state. The evidence
      is mandatory before the first `pilot` promotion, re-proven after any KMS key-policy or SNS
      topic-policy change before the next promotion, names the policy version it attests to (so
      staleness is detectable), and is produced human-gated outside O1/O2 under operator
      credentials — the read-only gate role never gains publish or alarm-state permissions.
      NO-GO if it is absent, negative, or stale relative to the current policy version.
- [ ] Rollback target identified (SHA + deployment id) and the rollback steps in §4 are usable
      for this specific change (data-shape changes: §4.3 checked).
- [ ] No open Sev-1 incident on the pilot.
- [ ] The release does not bundle secrets/account ids (spot-check the diff).

NO-GO on any failure — fix forward on `main` through the normal review flow, or abandon the
release. No hotfixing on deployed artifacts.

## 2. Promotion rules

| From -> to | Trigger | Gate |
| --- | --- | --- |
| `main` (CI green) -> dev | operator-initiated (workflow dispatch, #70) | GitHub `dev` Environment; OIDC deploy role |
| dev -> pilot | operator-initiated after dev smokes pass | GitHub `pilot` Environment **required reviewer**; same SHA/artifacts as dev |
| pilot -> (rollback) | incident or failed smoke | §4; still human-gated, but pre-authorized by the release gate entry |

Frontend (Cloudflare) and BFF (AWS) deploy **independently**; the integrated smoke (§3) is what
proves them together. Ephemeral Cloudflare previews are UI-only and never part of a release
(pilot-environment-contract §1).

## 3. Post-deploy smoke plan (no-spend by default)

All release smokes spend **zero model tokens**: the learner loop is deterministic and the coach
runs in `mode: "deterministic"` only. Any AI smoke is a separate, manual, `confirm_ai_spend`-gated
action and is NEVER part of a release gate.

Two distinct targets, never conflated:

- **`BASE_URL`** — the deployed **BFF origin** (API Gateway). All API smokes point here
  (pilot-environment-contract §3: the BFF is the only browser-reachable backend).
- **`FRONTEND_URL`** — the Cloudflare origin. Only health/UI checks point here; API assertions
  are never run against the frontend.

### 3.1 Existing local regression smokes (pre-release gates, NOT deployed-target gates)

The current `web/scripts/` smokes are **local-only by construction** and stay exactly that: they
gate the SHA in CI (Web Quality lane) before any release, but none of them can run against a
deployed environment as-is:

| Script | What it actually proves (local) | Why it is local-only |
| --- | --- | --- |
| `smoke-blank-mock.mjs` | mock start/submit on a blank attempt; dashboard survives unanswered slots | drives a locally started server |
| `smoke-review-coach.mjs` | missed-question review **during a drill** + deterministic coach output | does NOT inspect mock payloads for leaks (see 3.2) |
| `smoke-identity.mjs` | header/cookie learner resolution and `403 NOT_RESOURCE_OWNER` isolation in `CBA_WEB_AUTH=dev` | dev identity is rejected by deployed runtimes (fail-fast rule) — incompatible with Cognito |
| `smoke-restart-persistence.mjs` | attempts survive a restart of a **locally spawned `next start`** with the **file store** | hardcodes localhost + process control + `CBA_WEB_STORE=file` |

### 3.2 Deployed smoke gates — to be DELIVERED by #56 (design) / #70 (implementation)

These do not exist yet; this section is their requirements contract, and a release can only use
them once #70 ships them:

- **BFF gates (`BASE_URL`):**
  1. blank-mock flow (start/submit/dashboard) against the deployed BFF;
  2. missed-review + deterministic-coach flow;
  3. **mock exam-mode leak scan — NEW requirement (#56):** before mock submit, fetch every
     mock-facing payload and assert the absence of `correctOption`, `explanation`, `isCorrect`,
     and source-grounding fields. No existing script proves this; it must NOT be treated as
     already-covered evidence;
  4. **Cognito session smoke:** sign-in with a **dedicated test learner**, call the BFF with the
     real session, verify cross-learner access returns the contracted ownership error, and
     **clean up every attempt/record the smoke created**;
  5. **DynamoDB persistence smoke:** write through the BFF, read back independently of any single
     runtime instance, then clean up — proving managed persistence without touching local files.
- **Frontend gates (`FRONTEND_URL`):** health/UI only — the learner routes (dashboard, practice,
  mock, results, review) render, and the bundle points at the environment's configured BFF base.

Pass = every applicable gate exits 0 against its target. Any failure: NO-GO (promotion) or
trigger §4 (already-promoted). Until #70 ships 3.2, a release's post-deploy verification is
manual against these same criteria — recorded in the release's EVENTS.md entry.

## 4. Rollback policy

Record every rollback in EVENTS.md with cause, actions, and resulting state. Rollback restores
the **previous good SHA's artifacts** — never an untested state.

### 4.1 Cloudflare frontend (Workers/OpenNext)

- Primary: re-activate the previous Workers deployment/version (Cloudflare keeps prior
  deployments; `wrangler` rollback or dashboard "rollback to this deployment").
- If config drifted (e.g. the Worker runtime variable `CBA_BFF_BASE_URL`), redeploy the previous
  SHA through the #70 lane instead of hand-editing live config.
- Verify with the **`FRONTEND_URL` health/UI gates** (§3.2) — API smokes are never pointed at the
  frontend.

### 4.2 AWS BFF (API Gateway + Lambda via CDK)

- Primary: redeploy the previous good SHA through the same gated lane (`cdk deploy` of the prior
  published commit) — CloudFormation converges the stack back; the scoped execution role already
  constrains the blast radius.
- CloudFormation auto-rollback covers failed deploys; a completed-but-bad deploy is rolled back
  by redeploying the previous SHA, not by manual console edits.
- Verify with the **`BASE_URL` BFF gates** (§3.2).

### 4.3 Data (DynamoDB)

- Pilot schema policy is **additive-only**: new attributes/records may appear; renames/removals
  or semantic changes of existing attributes require their own human-gated migration plan BEFORE
  the release (and make the release NO-GO without one).
- Because changes are additive, application rollback (4.1/4.2) is safe against newer data; new
  attributes are simply ignored by older code.
- Corruption/loss: restore via DynamoDB point-in-time recovery (PITR must be enabled with the
  #68 table). **PITR always restores into a NEW table** — it is a cutover procedure, not an
  in-place revert, and it is a data-loss decision needing its own explicit human gate recorded in
  EVENTS.md. Steps:
  1. Restore to a pre-incident timestamp into a **new table name**
     (`cba-study-coach-<env>-simulation-restore-<date>`), and wait for it to reach `ACTIVE`.
  2. **Re-apply everything PITR does NOT restore**: re-enable PITR itself, TTL settings, tags,
     streams, auto-scaling/alarms, **deletion protection**, and every **IAM permission that names
     the table ARN** — restored tables come back without any of them, and the least-privilege BFF
     role is scoped to the ORIGINAL table's ARN, so the restored table is unreachable until its
     ARN is granted.
  3. **Validate the restored data** (spot-check learner records/attempt counts against the
     incident timeline) before any traffic touches it.
  4. Cut the application over **through a single gated deploy** (the #70 lane — never a live
     console edit) that updates BOTH, together: `CBA_WEB_TABLE` to the new table name AND the
     BFF Lambda role's IAM policy to the restored table's ARN. Changing only the variable leaves
     the role authorized for the old ARN and the BFF fails with `AccessDenied`.
  5. Before executing the cutover deploy, review its `cdk diff`: only the expected
     table-name/IAM changes, **no wildcard** actions or resources.
  6. Run the `BASE_URL` BFF gates (§3.2) against the cutover.
  7. **Preserve the previous table** (do not delete/rename) until a human explicitly decides its
     fate in a recorded follow-up.

## 5. Versioning and release notes

- Every pilot release is an **annotated git tag** `pilot-vN` (monotonic) on the released SHA,
  plus a GitHub Release whose notes record: changes since the last tag, CI runs, smoke results,
  deployment ids (Cloudflare + CloudFormation), and the **rollback target** (previous tag).
- The #70 deployment summary must expose versions and endpoints **by logical name only** — no
  account ids, ARNs, tokens, or secret values (github-security-and-oidc-baseline §6).

## 6. Incident notes and owner checklist

**Owner:** the human operator who opened the release gate owns the release end-to-end (deploy,
smokes, promotion/rollback decision, records). Agents assist but never decide.

On any incident (failed smoke after promotion, runtime outage, data problem):

1. Freeze further promotions (no new releases until resolved).
2. Decide rollback vs fix-forward using §4 — default to **rollback** when learner-facing.
3. Record an incident note in EVENTS.md: timeline, impact, environment, deployed SHA, actions
   taken, rollback target used, follow-up issue created.
4. Open a GitHub issue for the root cause; link the incident note.
5. Only after smokes are green again, close the incident note with the resulting state.

## Non-goals

- No automation is created here (that is #56 design + #70 implementation).
- No staging tier (deferred; see pilot-environment-contract §1).
- No paid AI smoke as a release gate — ever; AI verification stays separately gated.
