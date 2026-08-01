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

## BLOCKED EXTERNAL PREREQUISITE — the human gate does not exist yet

**As of 2026-07-31 this repository has ZERO configured GitHub Environments.** Read-only inspection
of `/repos/:owner/:repo/environments` returned `total_count: 0`.

Naming `environment: dev` or `environment: pilot` in a workflow does not create protection. An
Environment referenced but never configured is created on first use WITHOUT required reviewers and
WITHOUT a deployment-branch restriction. Slice A's first draft described those keys as the human
gate; that was wrong, and Codex refused the slice for it.

What the `environment:` keys are today: the BINDING that will carry the gate once the Environments
exist. They are necessary and not sufficient.

Required before any deploy slice or deployment gate may be approved, under a separate
Zamp-authorized repository-settings change:

- configure `dev` and `pilot`;
- **BOTH must restrict deployment branches to `main` only** — dev too, not just pilot. An
  Environment without a branch policy hands its variables and secrets to a workflow definition from
  ANY branch, and `workflow_dispatch` runs the definition from the branch the operator selects;
- `pilot` must additionally require the designated reviewer;
- read-only evidence of both settings must be presented and reviewed.

Until that evidence exists, **this lane is ungated** and must be described that way.

## Slice A — Codex review round 1, and what it changed

Four findings, all upheld. The code deployed nothing then and deploys nothing now; what was wrong
was the FOUNDATION — it left room for a future deploy to bypass release identity, the preflight and
the approval.

**Release identity (HIGH).** The lane took `environment` and the callback/logout URLs as operator
inputs and never pinned `checkout`, so a manual run could select any branch and deploy a tree that
was never the reviewed one. Replaced per `deployed-environment-smoke-workflow-design.md` §1/§4:
`release_sha` is required, must be 40 lowercase hex AND an ancestor of live `main`; every checkout
pins it; `mode` (`dev_only` | `dev_then_pilot`) replaces the environment input; `target_environment`
is internal; there are no URL inputs at all — targets resolve only from Environment configuration.
There is no dispatch path that reaches pilot without a green dev stage in the same run.

**Binding the deploy to what was validated (HIGH).** A passing preflight proved that SOME
configuration was valid, not that the deployed one is it: a later `cdk deploy --all` could omit the
`-c` values and still satisfy the gate. The preflight now emits a manifest with a canonical digest
over `{releaseSha, environment, boundContext}`, written only on a pass — a manifest for a refused
configuration is a token that should not exist. A deploying job must carry that digest, and the
invariant test refuses the workflow if one does not.

The same finding caught the gating itself: `needs:` plus a permissive `if:` gates nothing. GitHub's
default "skip when a dependency failed" is REPLACED by any `if:`, so `always()` and the quieter
`!cancelled()` both let a failed preflight through. Every job now requires
`needs.<job>.result == 'success'`, and the invariant rejects both holes.

`expected_user_pool_id` was a caller input — whoever can name "our" pool can redefine which existing
domain a deploy is willing to adopt, turning PREFLIGHT-2's redeploy allowance into a bypass. It now
comes only from `CBA_EXPECTED_USER_POOL_ID` in the environment.

**The absent Environments (HIGH).** Recorded above as a blocked prerequisite rather than as a
control, and the workflow header says so in the file a future reader will actually open.

**Leakage (MEDIUM).** Codex reproduced role-ARN and credential-shaped material in this command's
output. The role ARN moved from a variable to a secret and `mask-aws-account-id: true` is set. Every
failure is now a CODE plus a FIELD NAME from a closed vocabulary; AWS stderr, the owning user pool
id, supplied URLs and the prefix never reach the output. A poison-value suite asserts non-leakage for
an account id, an IAM ARN, a pool id, an internal endpoint URL, an access-key-shaped string and a
token-shaped string, across the human output, the JSON output, probe errors and usage errors.

## Slice A — Codex review round 2, and what it changed

Both remaining findings upheld. Both were, again, foundation: the code still deployed nothing, but
what existed would not have constrained what comes next.

**The release identity was still a name, not an object.** The shell check `[0-9a-f]*` validates one
character — "a" followed by 39 uppercase Zs passed it, reproduced before fixing. Worse, the checkout
ran BEFORE validation, so a 40-character branch name could be checked out, blessed as an ancestor,
emitted as the release, and then MOVED before a later job resolved the same name again. Now: shape
(`length == 40` and whole-string charset) is checked in pure shell before any git invocation; the
identity job checks out `main`, never the candidate; the object must BE a commit (`cat-file -t`);
it must resolve to itself; ancestry from live `main` is proven; and the job emits the RESOLVED OID,
which is the only thing later checkouts may pin. The script is now EXECUTED in tests against a
stubbed git — the exact "a"+39Z value, ref-shaped names, a tag OID, a foreign resolution and a
non-ancestor are each observed refusing, before git where shape decides it.

**The binding was nominal, and the guard checked substrings.** `test -n "$CONTEXT_DIGEST"` bound
nothing; `echo "$CONTEXT_DIGEST"; cdk deploy --all`, `if: ... || true`, an OR branch accepting
`failure`, and an extra pilot job that merely contained the words `context_digest` all returned zero
errors from the old invariants — Codex reproduced each. Now:

- The digest covers `{releaseOID, environment, REGION, TARGET ACCOUNT, boundContext}`. us-east-1
  and us-west-2 no longer share a digest, nor do two accounts; both drifts are proven by test, and
  removing either field from the payload is proven to fail.
- The account is resolved by the collector (`sts get-caller-identity`, read-only, not
  IAM-gated) and lives only inside the digest — never in clear text in output or manifest.
- A purpose-built `verify-manifest` command replaces textual digest presence: closed manifest
  schema, environment/release/digest identity, and `--recompute` — which re-resolves the account,
  re-reads the effective context and recompares. Stage jobs verify the travelled manifest today;
  the invariants require any DEPLOYING job to run the recomputed verification in the same
  invocation, BEFORE its deploy command.
- The invariants now validate the DAG, not substrings: pinned exact success expressions per job and
  a closed grammar for any new one (no `||`, no `!`, no function call — `|| true`, `always()` and
  `!cancelled()` are all structurally impossible); every pilot-bound job must descend from the
  green dev stage and the pilot preflight; every deploying job from its environment's preflight.
  Each of Codex's reproductions is a named regression, and the mutation harness asserts every
  mutation actually applied before asserting it is rejected.

## Slice A — Codex review round 3, and what it changed

Six reproductions, all confirmed mechanically before fixing (five in memory; the sixth is the
branch-policy prerequisite above, tightened to cover dev as well). The common lesson: workflow
choreography cannot bind. Verify-then-deploy as two commands admits a different context, different
credentials or a different target between them, and no textual ordering rule can see any of it.

**Deployment is now bound BY CONSTRUCTION.** `infra/aws/bin/deploy-release.js` is the one sanctioned
deployment entrypoint: it verifies the manifest (closed schema), recomputes the digest from the
effective context and the resolved account, re-resolves the account immediately before the effect,
and then derives the deploy arguments FROM the very context object it verified — there is no
interface through which the deploy can receive different values, and no code path in the file that
invokes anything but `cdk`. The residual is the in-process window between the second account
resolution and the spawn, disclosed in the file header. Raw `cdk deploy` / `wrangler deploy` /
`opennextjs-cloudflare deploy` are forbidden EVERYWHERE in the lane by the invariants — the
verify-order heuristic they replace was fooled by all three round-3 reproductions, each now a named
regression. Slice A never calls the entrypoint: it exists so the binding is established and attacked
before the first deploying slice, not retrofitted around one.

**The nested manifest schema is closed.** `boundContextKeys: []` and a `preflight` block CLAIMING a
failure both verified cleanly before — the old shape check stopped at `Array.isArray` and never read
`preflight` at all. A manifest exists only because both conditions passed, so a nested claim saying
otherwise is a forgery, not a variant: the bound keys must equal the canonical set exactly, every
preflight claim must be `pass`, and the manifest names its `target.service` (`aws-cdk`), which the
entrypoint enforces — an AWS manifest is not spendable against any other target.

## Slice A — Codex review round 4, and what it changed

Four findings, all upheld. The pattern across rounds 3 and 4 finally named in full: NOTHING that
matters may rest on workflow text — not ordering, not verb detection, not a SHA compared to an
argument.

**The release now binds reality, not an argument (HIGH).** `deploy-release` compared the manifest's
SHA with a CLI flag and deployed whatever files were on disk — Codex reproduced a verified deploy
whose HEAD was a different commit entirely. The entrypoint now requires `git rev-parse HEAD` to
EQUAL the manifest's release, the worktree to be clean, and the ASSEMBLY digest to match: the
preflight synthesizes the cloud assembly from the bound context and digests its templates into the
manifest, and the entrypoint deploys THAT assembly via `--app` — never a re-synth from mutable
source.

**The region is imposed, not inherited (HIGH).** The manifest's region was compared and then never
applied; a child with ambient `AWS_REGION=us-west-2` deployed to the wrong region in the same
account, invisible to the account check. The entrypoint now overrides `AWS_REGION`,
`AWS_DEFAULT_REGION` and `CDK_DEFAULT_REGION` with the verified value on the child's environment.

**The step surface is a whitelist (HIGH).** `verb=deploy; npx cdk "$verb"` sailed past the raw-deploy
verb regex — a blacklist cannot establish exclusive use of the entrypoint. The invariants now allow
ONLY a closed set of step shapes: three exact actions (with their required properties) and six
byte-identical run templates. Any new command, however spelled, and any template with one line
added, fails until it is added under review. The verb-indirection bypass, an action-based deploy and
a single-line smuggle are each named regressions.

**The context contract is complete (MEDIUM).** Only the three auth keys were bound; changing
`githubTrustSub` or `corsAllowedOrigins` produced the same digest — IAM trust and CORS could drift
under a manifest that still verified. `DEPLOY_CONTEXT_KEYS` in `lib/context.js` is now the closed
inventory (nine keys), the digest binds all of them, and a discovery test scans the stack sources so
a NEW context key cannot be consumed without joining the contract.

## Slice A — Codex review round 5, and what it changed

Three findings, all upheld; the two mechanical ones reproduced before fixing.

**The assembly digest now binds everything CDK consumes, from a private snapshot (HIGH).** The old
digest hashed only the root `*.template.json` — mutating a Lambda bundle under `asset.<hash>/` or
the `*.assets.json` manifest left it unchanged, so arbitrary code could reach the privileged BFF
Lambda under a reviewed assembly identity. And the entrypoint handed the ORIGINAL path to CDK after
verification, leaving a check/use window. Now: the walk is recursive over every regular file
(relative path, type marker, bytes), symlinks and non-regular entries are refused outright
(`ASSEMBLY_UNSAFE_ENTRY`), and `deploy-release` COPIES the assembly into a fresh private directory,
digests THE COPY, compares, and points `--app` at the snapshot — the original path is never reopened
after verification. The regressions cover asset bytes, the asset manifest, the cloud manifest, an
added file, a removed file, a planted symlink, and mutation of the original DURING the child run
(the snapshot provably still carries the verified digest).

**Action authority is schema-closed, not name-closed (MEDIUM).** The allowlist checked names plus
presence-regexes — a swapped secret (`ADMIN_ROLE`), a deleted `aws-region` and arbitrary extra
inputs all passed, because presence-of-required is not absence-of-everything-else. Each action's
`with:` block must now EQUAL one of the reviewed variants — exact keys, exact values — and a
uses-step may carry nothing beyond name/uses/with, so an `env:` smuggled onto an action dies too.
All three reproductions plus the env-block variant are named regressions.

**The context contract cannot be read around (LOW).** Three fences replace the single scanner:
direct `tryGetContext` is forbidden outside `lib/context.js`; the scanner also sees the native-API
shape and refuses non-literal keys (proven on planted sources, with the forwarding wrapper as the
one sanctioned non-literal form); and `getContext` itself now REFUSES unlisted keys at runtime, so
an unbound read fails synth loudly. The discovery is bidirectional — declared-but-dead keys fail
too. Tightening the scanner immediately caught a key my manual inventory had missed:
`bedrockRefreshBoundaryArn`, an IAM boundary ARN — exactly the class round 4 was about. It joined
the contract, which now holds ten keys.

## Slice A — Codex review round 6, and what it changed

Five findings, all upheld; the two digest ones reproduced before fixing.

**The digest is injective now (HIGH).** Concatenating path, delimiters and raw bytes without length
framing is not injective — Codex built two different trees with the same digest, because a file's
CONTENT can contain the delimiter sequence. The canonical form is a JSON array of per-file records:
every field length-framed by the encoding itself, the content replaced by its fixed-length sha256
plus an explicit size. The exact reproduced collision pair is a named regression. **And the mode is
bound (MEDIUM)**: 0644→0755 changes the digest, normalized git-style on the owner-executable bit so
umask noise cannot refuse an honest assembly; the snapshot copy preserves the bit explicitly.

**Run steps are closed OBJECTS, not approved command text (HIGH).** `NODE_OPTIONS: --require
./evil.js` added to a reviewed step's `env:` kept the approved command and executed arbitrary Node.
Each reviewed block now carries the exact set of step-level keys and the exact env mapping —
`shell:`, `working-directory:`, `continue-on-error:` and any smuggled env variable die as unreviewed
step properties. Fixing this exposed a hole of my own: the step-shape loop lived inside the per-job
gating loop, which SKIPS `global-preflight` — the identity job's steps were never shape-checked at
all. The loop is standalone now, over every job, with the lesson recorded in the invariant comment.

**Actions are pinned to immutable commit SHAs (HIGH).** `@v7`/`@v6` tags can move after review,
including in jobs with `id-token: write`. All eleven `uses:` are pinned to full SHAs (the
`configure-aws-credentials` tag is annotated, so the PEELED commit is used, not the tag object).
The invariant refuses any non-SHA ref by its own rule, and the regression demands THAT rule's error
specifically — the schema-key closure would refuse the unknown name anyway, and a control satisfied
by the redundancy would go green when the pin rule was deleted.

**Snapshots never outlive the run (LOW).** One owner: everything after the snapshot creation runs
inside a single try/finally; partial copies clean themselves up. Regressions assert an empty
snapshot base after success, digest mismatch, account-resolution failure, context drift, account
swap and a failing child.

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
