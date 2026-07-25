# Deployed-Environment Smoke Workflow Design (#56)

Implementation-ready blueprint that turns the [pilot release runbook](pilot-release-runbook.md)
(#55) into deterministic deployed-environment gates for `dev -> pilot`. **Design only**: #70
implements it; this document creates no workflow, deploys nothing, and mutates no GitHub/AWS/
Cloudflare state. #70 must be able to implement without inventing environment, security, smoke,
cleanup, promotion, evidence, or rollback behavior.

| Question | Source of truth |
| --- | --- |
| Environments, targets, config registry | [pilot-environment-contract.md](pilot-environment-contract.md) (#47) |
| Release policy, go/no-go, rollback | [pilot-release-runbook.md](pilot-release-runbook.md) (#55) |
| Permissions, Environments, OIDC roles | [github-security-and-oidc-baseline.md](github-security-and-oidc-baseline.md) |
| CI/no-spend posture | [ci-cd-security-foundation.md](ci-cd-security-foundation.md) |
| Learner API the gates exercise | [web-bff-contracts.md](../product/web-bff-contracts.md) |

## 1. Topology, entry points, and run semantics

- **One reusable workflow** (`workflow_call`) with an internal **`target_environment`** input
  (exactly `dev` or `pilot`), invoked ONLY by a **manual orchestrator** (`workflow_dispatch`)
  that composes the full release. The reusable file has NO dispatch trigger of its own —
  `target_environment` is never operator-facing. Suggested files (#70 owns final names):
  `deployed-smoke.yml` (reusable) and `release-pilot.yml` (orchestrator).
- **Inputs** (orchestrator): `release_sha` — required, must match `^[0-9a-f]{40}$` AND be an
  ancestor of `main` (preflight-verified); `mode` — choice, exactly `dev_only` or
  `dev_then_pilot`. **There is NO environment input and NO dispatch path that reaches pilot
  without a green dev stage in the same run** (§4): pilot jobs exist only downstream of the dev
  gates in the single flow, and their Environment binding means their secrets/vars are only
  issued after the reviewer approval. **No URL inputs exist** — targets resolve only from
  Environment configuration (§3).
- **Immutable SHA/artifacts**: checkout pins `release_sha`; frontend and BFF artifacts are built
  ONCE (dev stage), uploaded as run artifacts with recorded digests; the pilot stage deploys the
  **same artifacts by digest** — it never rebuilds. Digest mismatch = hard failure.
  **Runtime public config is a precondition** for same-artifact promotion: the browser's BFF
  base URL is served by the Cloudflare Worker at request time (a Worker runtime variable,
  `CBA_BFF_BASE_URL` — see pilot-environment-contract §3), NEVER a `NEXT_PUBLIC_*` build-time
  constant, which Next.js freezes into the bundle and would force per-environment rebuilds.
- **Release manifest**: every successful stage writes a validated manifest (release SHA,
  artifact digests, environment, run identity, gate results) as a retained run artifact. Pilot
  releases additionally get the `pilot-vN` tag (#55 §5); **dev rollback targets are prior
  validated dev manifests**, not pilot tags (§9).
- **Concurrency**: the reusable workflow derives its group from the internal
  `target_environment` — exactly `release-dev` or `release-pilot`, with
  `cancel-in-progress: false` — so releases queue per environment and a live release is never
  cancelled by a newer one. (Two literal groups; nothing dynamic beyond the input.)
- **Rerun/idempotency**: deploy jobs are idempotent by SHA (same artifacts converge); smoke jobs
  are idempotent by design (§6 run identity + cleanup); re-running a failed run is safe and uses
  a fresh `run_attempt` identity.
- **Cancellation**: a NORMAL cancellation leaves the environment at whatever was last deployed
  (recorded in the summary) and still runs the `if: always()` cleanup/summary jobs. A
  **force-cancel** (cancelling a run that is already cancelling) kills `always()` jobs too —
  in that case **cleanup is manual**: treat it as a cleanup failure (§6) and run/verify manual
  cleanup before any promotion.
- **Timeouts** (`timeout-minutes`): each preflight (global and per-environment) 5; each deploy
  15; frontend health 5; BFF gates 10; cleanup 5; summary 5. A timeout is a failure, never a
  silent pass.
- **Evidence retention**: the §8 summary is written to `$GITHUB_STEP_SUMMARY` and uploaded as a
  sanitized run artifact (90-day retention); the human records the release outcome in
  `.agent-handoff/EVENTS.md` per #55 §1.

## 2. Environment model

Canonical `local -> dev -> pilot` (#47). **`staging` is deferred and must not appear as a live
tier** in any workflow, Environment name, or config. GitHub Environments used: `dev` (no required
reviewer) and `pilot` (**required reviewer** — the #55 promotion gate).

## 3. Targets and configuration resolution

| Name | Kind | Scope | Meaning |
| --- | --- | --- | --- |
| `BASE_URL` | Environment **variable** | `dev` / `pilot` | the AWS BFF origin (API Gateway). ALL API gates point here |
| `FRONTEND_URL` | Environment **variable** | `dev` / `pilot` | the Cloudflare origin. Health/UI checks ONLY — never API assertions |
| `AWS_DEPLOY_ROLE_ARN` | Environment **secret** | `dev` / `pilot` | OIDC deploy role, trust `environment:<env>` (#52 §4) |
| Cloudflare API token | Environment **secret** | `dev` / `pilot` | Workers deploy only |
| `SMOKE_LEARNER_A` / `SMOKE_LEARNER_B` credentials | Environment **secrets** | `dev` / `pilot` | the two dedicated Cognito smoke learners (§6) |

Additional Environment **variables** (per environment) for host validation, with exact names:
`CBA_ALLOWED_BFF_HOST_SUFFIX` (must suffix-match the `BASE_URL` host) and
`CBA_ALLOWED_FRONTEND_HOST_SUFFIX` (must suffix-match the `FRONTEND_URL` host).

Environment config is validated by the **environment-scoped preflights** (§4) — never by a
global job: Environment vars/secrets only exist inside jobs that reference that Environment
(and, for `pilot`, only after the reviewer approval), so a global preflight structurally cannot
read them. Each env-preflight asserts both URLs parse as `https://` origins and satisfy their
suffix variables. **Arbitrary caller-supplied URLs are impossible** because no URL input exists
and Environment variables change only through repo admin.

## 4. Job DAG

Single flow — pilot is only reachable THROUGH dev in the same run. Environment config is read
only by environment-scoped jobs (never globally):

```text
global-preflight         validate release_sha (shape + ancestry) and mode; emit run identity (§6)
  |                      — reads NO environment config (structurally cannot: no Environment ref)
build                    build frontend + BFF artifacts once; record digests; write manifest draft
  |
dev-env-preflight        environment: dev — resolve + validate BASE_URL/FRONTEND_URL against
  |                      CBA_ALLOWED_*_HOST_SUFFIX (§3)
  +--> dev: deploy-frontend (Cloudflare)  --> dev: frontend-health F1 (FRONTEND_URL)
  +--> dev: deploy-bff      (AWS OIDC)    --> dev: bff-gates 1-5      (BASE_URL, §5)
                                               --> dev: frontend-dynamic F2 (real ids, §5)
                                                     |
                                          dev: cleanup (always(), §6)
                                                     |
                                          [mode == dev_then_pilot]
                                                     |
                            pilot approval (GitHub `pilot` Environment reviewer)
                                                     |
pilot-env-preflight      environment: pilot — same validation; runs ONLY after dev green +
  |                      approval (its Environment binding withholds vars/secrets until then)
  +--> pilot: deploy-frontend (same digests) --> pilot: frontend-health F1
  +--> pilot: deploy-bff      (same digests) --> pilot: bff-gates 1-5 --> pilot: F2
                                                     |
                                          pilot: cleanup (always())
                                                     |
                                          summary (always(), §8)
```

- Frontend and BFF deploy **independently** (parallel) within each stage; each gate job `needs`
  its deploy.
- **There is no direct-to-pilot path**: the pilot jobs `needs` the dev gates + dev cleanup, and
  they are bound to the `pilot` Environment — GitHub only issues their secrets/vars after the
  reviewer approves. `mode: dev_only` simply ends after dev cleanup.
- **Any failure blocks promotion** — gate failure, deploy failure, timeout, or cleanup failure.

## 5. Gate map (#55 §3.2, one job/step each)

All gates run inside `bff-gates` (except frontend health), sequentially fail-fast, against
`BASE_URL`, authenticated as the dedicated smoke learners (§6). Exit code is the outcome; each
step prints pass/fail + counts only (§7 masking).

| # | Gate | Learner | What it must prove | Cleanup |
| --- | --- | --- | --- | --- |
| F1 | frontend-health (`FRONTEND_URL`, right after the frontend deploy) | none | static/landing learner routes respond 200 with expected HTML markers; the **runtime config the Worker serves** targets the environment's configured BFF base (`CBA_BFF_BASE_URL`). NO API assertions | none (read-only) |
| F2 | frontend dynamic routes (`FRONTEND_URL`, after gates 1-5) | A | an **authenticated browser-level smoke** (headless; #70 picks the tool) resolves the dynamic routes with **real ids created by gates 1-3** — `/results/:id` and `/review/:id` render the actual attempt, not just any 200 | uses gate-created data; no new records |
| 1 | blank-mock | A | mock start/submit on a blank attempt; dashboard survives unanswered slots | attempt registered for §6 cleanup |
| 2 | missed-review + deterministic coach | A | missed-question review works; coach responds with `mode: "deterministic"` and NOTHING else | attempt registered |
| 3 | **mock leak scan** (new requirement from #55) | B | start a mock; BEFORE submit, validate every mock-facing payload against an **allowlist JSON Schema with `additionalProperties: false`** — pre-submit mock/question objects may carry ONLY the contracted presentation fields (ids, stem/prompt, option ids+text, ordering, timing, status). ANY extra property fails the gate, so future aliases (`correctAnswer`, `solution`, …) cannot slip past a denylist. The schema derives from [web-bff-contracts.md](../product/web-bff-contracts.md) and is versioned with the smoke suite. Then submit and assert the correction fields ARE present post-submit (positive control) | attempt registered |
| 4 | Cognito session + ownership | A + B | real sign-in (Cognito session/token) resolves the learner; learner A calling a learner-B attempt id gets the contracted ownership error; a request carrying the dev-mode `x-cba-learner` header is REJECTED (deployed fail-fast rule, #47 §3) | sessions signed out |
| 5 | managed persistence via BFF | A | a second HTTP client alone does NOT prove another runtime (it can hit the same warm Lambda). The gate combines: (a) the readiness/config surface attests `CBA_WEB_STORE=dynamodb` and the gate **fails fast on any local adapter value**; (b) write + read back through the API; (c) a **verifiable managed-persistence evidence defined by #68** (e.g. the readiness payload exposing the persistence adapter identity/logical table). **No direct table access** | attempt registered |

## 6. Test-data isolation and cleanup

- **Run identity**: `run_id = <github.run_id>-<github.run_attempt>`, emitted by preflight and
  stamped into every artifact/summary line. Smoke attempts carry it where the contract allows
  (e.g. in attempt metadata), and the cleanup window is bounded by the run's start time.
- **Learners**: two **pre-provisioned** dedicated Cognito smoke learners per environment
  (`SMOKE_LEARNER_A/B` Environment secrets). Pre-provisioning avoids granting the workflow any
  Cognito admin permission. These learners exist ONLY for smokes and never hold real data.
- **Parallel runs**: impossible per environment by the §1 concurrency group — so smoke-learner
  data races cannot occur; the run identity still disambiguates history for audits.
- **Cleanup ownership**: the `cleanup` job (`always()`) deletes every attempt/record the run
  created, authenticated **as the smoke learners themselves through the BFF**. The learner
  contract's self-service attempt-deletion operation is owned by **#75** (sub-issue of #70,
  Phase 1) — **#70 depends on #75** for this gate and must neither invent the contract nor touch
  DynamoDB with the deploy role. **Direct table mutation is forbidden** unless a separately
  reviewed least-privilege contract proves it necessary (and then only via its own scoped role,
  never the deploy role).
- **Cleanup failure**: the run outcome becomes FAILURE even if all gates passed; the summary
  flags `cleanup: FAILED — manual cleanup required` and lists leftover records by logical name
  (learner label + attempt ordinal — never raw ids/tokens); promotion is blocked.

## 7. Permissions, secrets, and masking

- Workflow-level `permissions: { contents: read }`; ONLY deploy jobs add `id-token: write`
  (job-level), per the #52 model. No `pull-requests`, no `contents: write` anywhere.
- AWS access is exclusively the Environment-scoped OIDC deploy role; Cloudflare exclusively the
  Environment-scoped token. No long-lived keys, ever.
- **Log/masking rules**: secrets are masked by GitHub; additionally, gate scripts must never
  print URLs, ARNs, account ids, tokens, session cookies, learner emails, or response bodies —
  outputs are pass/fail, counts, and logical names only (`dev-bff`, `pilot-frontend`). The
  summary refers to endpoints **by logical name** (#55 §5). Learner data never enters logs.

## 8. Go/no-go summary (`always()`)

The `summary` job always renders, even on failure/cancellation:

| Field | Content |
| --- | --- |
| target | `dev` or `pilot` (logical name only) |
| identity | `release_sha`, artifact digests, `run_id` |
| gates | one row per §5 gate: pass / fail / skipped (with the failing step name) |
| cleanup | ok / FAILED (with leftover count by logical name) |
| promotion eligibility | `eligible` only when every gate AND cleanup passed on dev |
| rollback target | pilot: previous good release **tag** (`pilot-vN-1`); dev: previous **validated dev manifest** (run identity) — logical names only |

The human copies this into the #55 release entry in EVENTS.md and makes the go/no-go decision;
the workflow never promotes on its own.

## 9. Rollback hooks (human-gated, never automatic)

- A separate **manual** `rollback` dispatch (designed here, implemented by #70): inputs =
  `environment` + a rollback target validated per environment — **pilot**: an existing
  `pilot-vN` tag; **dev**: a prior **validated dev release manifest** (§1; dev has no pilot
  tags, so tags alone cannot be dev's rollback source). It redeploys the target's recorded
  artifacts (by digest) through the same deploy jobs and re-runs the gates.
- **Auto-rollback is forbidden**: a failed gate blocks promotion and stops; a human decides
  rollback vs fix-forward (#55 §6).
- **Data cutover is never automated**: the DynamoDB PITR procedure stays exactly #55 §4.3 —
  restore to a new table, re-apply non-restored settings (incl. deletion protection and IAM),
  then ONE gated deploy updating `CBA_WEB_TABLE` **and** the BFF role's IAM policy together,
  after a reviewed `cdk diff` with **no wildcard** actions/resources.

## 10. No-spend guarantee

- The deterministic gates call only the learner BFF surface; the coach gate asserts
  `mode: "deterministic"`. The workflow defines **no** AI inputs, sets no `confirm_ai_spend`,
  holds no Bedrock permissions (the deploy role must not carry `bedrock:*`), and never calls
  the AI Orchestration surface.
- Paid/live AI verification remains a **separate manual workflow** (today `blueprint-refresh`)
  and is never a release gate nor an optional branch inside these smokes.
- #70 must add static invariant tests for the new workflows (pattern proven by #73's
  `test/blueprint-refresh-workflow.test.js`): pinned action majors, no `bedrock` grants, no URL
  inputs, `pilot` behind the Environment, cleanup `always()`, summary `always()`.

## 11. Failure-state matrix

| State | Behavior | Who acts |
| --- | --- | --- |
| gate fails (dev) | run fails; promotion unreachable; summary shows the failing gate | human: fix forward on `main` |
| gate fails (pilot) | run fails; pilot already carries the new SHA — summary flags rollback target | human: §9 rollback or fix-forward |
| deploy fails | CloudFormation auto-rollback (BFF) / previous deployment intact (frontend); gates skipped | human: retry or abandon release |
| run cancelled (normal) | environment stays at last deployed state; cleanup + summary still run (`always()`) | human: decide re-run |
| run force-cancelled | `always()` jobs are killed too — NO automated cleanup/summary; treat as cleanup failure | human: manual cleanup + verification before any promotion |
| re-run | new `run_attempt` identity; safe by idempotency | operator |
| cleanup fails | run outcome FAILURE even with green gates; leftovers listed by logical name; promotion blocked | human: manual cleanup, then re-run |
| rollback requested | manual dispatch with a prior tag; gates re-run on the rolled-back state | human (gate) |

## 12. Acceptance mapping (what #70 consumes)

- §1/§4 fix entry points, SHA/artifact immutability, concurrency, rerun, cancellation, timeouts,
  evidence — nothing left to invent.
- §5 maps every #55 §3.2 gate to a job/step + target + credential source + cleanup + outcome;
  gate 3 IS the exam-mode leak proof (pre-submit absence + post-submit positive control).
- §2/§4 enforce `dev -> pilot` with the same SHA/artifacts behind the `pilot` reviewer.
- §10 makes deterministic smokes structurally unable to spend model tokens.
- §11 defines failure/cancel/rerun/concurrency/cleanup-failure/rollback-request states.
- Contract dependency (tracked, not invented): learner-scoped self-service attempt deletion for
  cleanup (§6) is **#75** — #70 depends on #75 and must not reach DynamoDB with the deploy role.
- Persistence-evidence dependency: gate 5's verifiable managed-persistence evidence is defined
  by **#68** (readiness surface attesting the adapter), not invented by #70.
