# Task: bootstrap authorized AWS pilot account + Bedrock OIDC smoke (#66)

## Owner

- Agent: Claude (executor)
- Architect/reviewer: Codex
- Human gate: required before every mutation stage (bootstrap/deploy, secret rewiring, paid smoke)

## Source of truth

- GitHub issue: #66 (Phase 1 / In Progress; unblocks #46; evidence closes/reconciles #65)
- Runbook: `docs/architecture/aws-bootstrap-and-oidc.md` (#54)
- Environment contract: `docs/architecture/pilot-environment-contract.md` (#47) §5
- Stack: `infra/aws/` SecurityStack only

## Guardrails (from the issue + session brief)

- Local operator profile + `us-east-1`; profile name/account id/ARNs never written to tracked files.
- No Bedrock invocation; `confirm_ai_spend=true` only after a separate explicit human approval.
- Only CDKToolkit + SecurityStack; the five placeholder stacks are untouched.
- Policy action is `bedrock:InvokeModel`; `bedrock:Converse` must not reappear.
- No commit/push without human gate.

## Stage plan

1. **Preflight (read-only, no mutation)** — STS + model availability (no identifiers printed),
   CDK tests + synth, `cdk diff SecurityStack` with real routed ARNs, InvokeModel assertion,
   exact list of resources bootstrap/deploy would create. STOP for human gate.
2. Bootstrap + SecurityStack deploy (human-gated).
3. GitHub secret rewiring + no-spend workflow proof (human-gated).
4. Paid smoke (separate explicit human approval) → evidence → reconcile #65.

## Work log

- Stage 1 (read-only preflight) DONE, all green, no mutation:
  - STS ok on the operator profile; account verified to match the authorized account from the
    earlier preflight (comparison done in-shell; no identifier printed). Identity type: IAM user.
  - Model availability `anthropic.claude-sonnet-5`: authorization AUTHORIZED, entitlement/region
    AVAILABLE (agreement field reports NOT_AVAILABLE — see risks). Inference profile
    `us.anthropic.claude-sonnet-5` ACTIVE; routed ARNs = us-east-1/us-east-2/us-west-2
    (account-less, public).
  - Collision checks: 0 OIDC providers; bedrock-refresh role absent; CDKToolkit absent (bootstrap
    required); SecurityStack absent — everything is a clean create.
  - CDK: unit tests 6/6; credential-free synth OK; template action set = `bedrock:InvokeModel`
    only (plus sts:AssumeRole*); zero `bedrock:Converse` in any template; zero literal account id
    (pseudo-params).
  - `cdk diff SecurityStack` (real routed ARNs, output masked for account ids): all-create diff —
    OIDC provider (custom resource + plumbing Lambda/role), BedrockRefreshRole with branch-scoped
    WebIdentity trust (aud sts.amazonaws.com / sub repo:...:ref:refs/heads/main), InvokeModel
    policy over profile + 3 routed ARNs, outputs BedrockRefreshRoleArn/GithubOidcProviderArn.
  - STOPPED before `cdk bootstrap`/`cdk deploy` — awaiting human gate for stage 2.
- Risk noted: `agreementAvailability.status=NOT_AVAILABLE` while authorization is AUTHORIZED —
  expected to be benign (no pending agreement flow), but the paid smoke (stage 4) is the real
  proof; if Converse fails there, revisit the model agreement in the console (human).
- Stage 1b (architect steer): scoped CloudFormation execution policy PREPARED (not created):
  - Customer-managed policy draft `cba-study-coach-pilot-cfn-exec-security` (JSON in scratchpad
    only; sanitized copy in the chat report — placeholder account id, none in tracked files).
  - Grants only what the SecurityStack template needs the CFN exec role to do: IAM role lifecycle
    scoped to `role/cba-study-coach-gha-bedrock-refresh` + `role/cba-study-coach-pilot-*`;
    AttachRolePolicy/DetachRolePolicy restricted by condition to the
    `AWSLambdaBasicExecutionRole` managed policy; PassRole conditioned to
    `lambda.amazonaws.com`; Lambda custom-resource lifecycle + InvokeFunction scoped to
    `function:cba-study-coach-pilot-*`; logs lifecycle scoped to
    `/aws/lambda/cba-study-coach-pilot-*`; S3 read-only on the bootstrap staging bucket.
    Deliberately absent: `iam:*OpenIDConnectProvider` (those belong to the in-template plumbing
    role, not the exec role), Bedrock, data-plane, and every other service.
  - IAM Access Analyzer `validate-policy`: ZERO findings.
  - `simulate-custom-policy` (read-only): 9/9 in-scope actions allowed (CreateRole/PutRolePolicy/
    TagRole on the refresh role; AttachRolePolicy+PassRole with the allowed condition context;
    lambda Create/Invoke; s3:GetObject on assets; logs:CreateLogGroup); 13/13 out-of-scope denials
    (bedrock/ec2/dynamodb/secretsmanager/cognito/cloudformation/iam:CreateUser/sts:AssumeRole;
    role and Lambda outside the name patterns; S3 writes; AttachRolePolicy of
    AdministratorAccess; PassRole to ec2).
  - Simulator gotcha recorded: `--policy-input-list file://...` is NOT expanded per-item by the
    CLI — pass the JSON as a string; docs ≤2000 chars each (minified fits at 1907).
  - Prepared (NOT executed) bootstrap command: create the policy first (human-gated), then
    `cdk bootstrap` with `--cloudformation-execution-policies "$SCOPED_POLICY_ARN"` and
    `--termination-protection`; NO `--trust` (single-account trust only).
  - Follow-on note: this scoped exec policy covers the SecurityStack only — future stacks
    (#68/#69 data/identity etc.) will require a deliberate policy extension per stack, which is
    intended (each extension is a reviewed change, not a wildcard).
  - STILL STOPPED before any mutation (no policy created, no bootstrap, no deploy, no Bedrock).
- Stage 1c (Codex gate BLOCKED the v1 exec policy — indirect escalation chain CreateRole ->
  arbitrary PutRolePolicy -> PassRole -> Lambda Create/Invoke). Redesign implemented, NO AWS
  mutation:
  - `lib/security-stack.js`: `iam.OpenIdConnectProvider` (custom resource) replaced by **native
    `iam.CfnOIDCProvider`** (`AWS::IAM::OIDCProvider`), `ThumbprintList` omitted (IAM auto-retrieves).
    Template now contains ONLY: 1 OIDCProvider + 1 Role + 1 Policy (+metadata) — zero Lambda, zero
    Custom::*, zero plumbing role, zero S3 assets.
  - **Operator-managed permissions boundary** (`cba-study-coach-pilot-boundary-bedrock-refresh`,
    created outside CFN): allows only `bedrock:InvokeModel` on the us-east-1 standard inference
    profile + the 3 routed model ARNs. Attached to `BedrockRefreshRole` via
    `permissionsBoundary` (context `bedrockRefreshBoundaryArn`, pseudo-param default — no id).
  - **Exec policy v2** (sanitized JSON in chat report): OIDC-provider lifecycle on the exact
    provider ARN; `iam:CreateRole` ONLY on the exact refresh-role ARN AND ONLY with
    `iam:PermissionsBoundary` == the boundary ARN; role lifecycle/PutRolePolicy only on that exact
    role; **explicit Deny** on `iam:{Put,Delete}RolePermissionsBoundary` (role) and
    `iam:CreatePolicyVersion/DeletePolicy/DeletePolicyVersion/SetDefaultPolicyVersion` (boundary).
    Contains NO `iam:PassRole`, NO `lambda:*`, NO `logs:*`, NO `s3:*`, NO `role/cba-study-coach-pilot-*`
    wildcard.
  - New synth tests `test/security-stack.test.js` (7 tests): exactly 1 native OIDCProvider w/o
    ThumbprintList; boundary present on the role; 0 Lambda / 0 Custom::* / exactly 1 IAM Role;
    InvokeModel only on profile+3 routed ARNs and the only bedrock action; trust aud/sub; no
    literal account id; import-by-context path creates no provider. Infra suite now 13/13.
  - Re-validated: `node --check` OK; infra 13/13; synth OK; root `npm test` 69/69; `cdk diff`
    (masked) shows only the 3 native resources; `git diff --check` clean.
  - Access Analyzer: ZERO findings on BOTH policies. Simulations: exec-policy allowed 7/7 in-scope
    (incl. CreateRole WITH pinned boundary), denied 16/16 out-of-scope (CreateRole without/wrong
    boundary; other role names; PassRole/lambda/logs/s3/bedrock/ec2; boundary tampering and
    boundary-policy mutation both **explicitDeny**). Boundary containment proved: identity
    allow-* + boundary => InvokeModel-on-profile allowed, everything else implicitDeny
    (incl. InvokeModelWithResponseStream).
  - Docs kept consistent (same #66 track): #54 doc §5 CDK-target bullets (native provider +
    boundary + pinned CreateRole) and infra README context row `bedrockRefreshBoundaryArn`.
  - Stage-2 mutation order (all still awaiting the new Codex gate): create boundary policy ->
    create exec policy v2 -> `cdk bootstrap --cloudformation-execution-policies --termination-protection`
    (no --trust) -> `cdk deploy SecurityStack`.
- Stage 1d (design approved; pre-mutation hardening per Codex):
  - Versioned the sanitized templates in Git: `infra/aws/bootstrap/policies/
    {bedrock-refresh-boundary,cfn-exec-security}.template.json` — `ACCOUNT_ID_PLACEHOLDER` only,
    guarded by tests against any real 12-digit id.
  - New `test/bootstrap-policies.test.js` (7 tests): boundary = only `bedrock:InvokeModel`;
    resources = profile + exactly the 3 routed ARNs; CreateRole requires the exact
    `iam:PermissionsBoundary`; tampering actions stay explicitDeny on the exact role/policy ARNs;
    exec Allow statements carry no PassRole/lambda/logs/s3/bedrock; no `*` action/resource
    anywhere; no real account id + placeholder present. Fixed the account-id regex in
    `security-stack.test.js` (`/"\d{12}"/` -> `/\b\d{12}\b/`) and replaced the import-test dummy id
    with a non-numeric placeholder so repo-wide 12-digit greps stay clean.
  - Runbook (§4 of aws-bootstrap-and-oidc.md) now renders the versioned templates to
    `/tmp/cba-bootstrap/` substituting the STS account id (rendered files never enter Git), then:
    create boundary -> create scoped exec policy -> `cdk bootstrap` with
    `--cloudformation-execution-policies` + `--termination-protection` (no `--trust`) -> deploy
    SecurityStack only -> GitHub wiring -> no-spend proof -> gated paid run -> hardening.
  - Re-ran everything green: infra tests 20/20; synth OK; root 69/69; validate 60/0;
    `git diff --check` clean; no real id in any touched file; Access Analyzer ZERO findings on both
    rendered policies; simulations re-confirmed (CreateRole only with pinned boundary; banned
    services implicitDeny; tampering explicitDeny; boundary contains an allow-* identity to
    InvokeModel-on-profile only).
  - NO AWS mutation (no boundary/exec policy/CDKToolkit/SecurityStack created). Awaiting FINAL gate.
- Stage 1e (runbook/test corrections + local commit):
  - Fixed 4 runbook defects found by audit: (1) §4 step 2 no longer instructs manual OIDC-provider
    creation (the stack creates the native provider; existing one is imported via
    `-c githubOidcProviderArn`); (2) §6 stale cross-reference fixed (`runbook step 7` -> `step 10`);
    (3) §4 steps 6-7 gained `cd infra/aws` context and the explicit SecurityStack deploy command
    (outputs file under /tmp, never in Git); (4) §4 step 5 no longer prints policy ARNs — both are
    captured silently into shell variables. Also pinned `Version: 2012-10-17` in the
    bootstrap-policies tests and fixed an MD031 fence spacing.
  - Re-validated: infra tests 21/21; synth OK; root 69/69; validate 60/0; `git diff --check` clean;
    no 12-digit id in any touched file; all fences MD031-clean; single `runbook step 10` ref.
  - LOCAL COMMIT created for Codex review (resolve the SHA with `git log --oneline origin/main..HEAD`):
    `feat: scope CDK bootstrap with permissions boundary and native OIDC provider for #66` —
    7 files: security-stack.js, 2 test suites, 2 versioned policy templates, infra README,
    runbook/doc. NOT pushed. Handoff files stay uncommitted (protocol residue).
  - Pipeline ahead: Codex review -> human push gate -> CI green (Quality/CodeQL/Infra Synth) ->
    NEW explicit human gate before ANY AWS resource creation (boundary, exec policy, CDKToolkit,
    SecurityStack).
- Stage 1f (Codex review of the local commit — 4 findings fixed, amended into the same commit):
  - [Blocking] runbook step 1: `PutModelInvocationLoggingConfiguration` (a logging API) removed;
    model-access verification now uses `aws bedrock get-foundation-model-availability`
    (expects `authorizationStatus: AUTHORIZED`).
  - [Medium] runbook steps 6-7: `npx cdk` -> `npx --no-install cdk` (pin to the repo-locked CDK
    version; never auto-download another).
  - [Minor] wildcard guard tightened: `action.includes('*')` / `resource.includes('*')` — now
    fails for `iam:*` and any `*` inside an ARN.
  - [Minor] §5 source-of-truth updated: the versioned templates under
    `infra/aws/bootstrap/policies/` are canonical for the operator-managed policies; §2 JSON
    remains the contract for the role trust/permission the stack encodes.
  - Revalidated: infra 21/21; root 69/69; validate 60/0; `git diff --check` clean; zero 12-digit
    ids in the commit. Same 7-file scope. New SHA via `git log --oneline origin/main..HEAD`.
    Awaiting push gate; Etapa 2 stays conditioned on CI green of the published SHA.
- Stage 1 pushed as `8ed1449`; CI green on Quality + CodeQL + Infra Synth (first real run of the
  native-provider stack in the lane).
- Stage 2 EXECUTED (human gate, using only published `8ed1449`) — PARTIAL, stopped on error
  without widening permissions:
  - Collision check clean (note: first pass had a JMESPath key bug — `policies` vs `Policies` —
    that produced a false collision flag; redone correctly: zero target policies existed).
  - Templates rendered from `git show 8ed1449:...` (not the working tree) into /tmp (700).
  - CREATED: `cba-study-coach-pilot-boundary-bedrock-refresh` + `cba-study-coach-pilot-cfn-exec-security`
    (tagged; ARNs kept in /tmp env file, 600, never printed).
  - CREATED: CDKToolkit via `npx --no-install cdk bootstrap` with
    `--cloudformation-execution-policies` (scoped policy) + `--termination-protection`, no
    `--trust`. CREATE_COMPLETE 12/12.
  - **FAILED (expected-class error, STOPPED):** SecurityStack deploy — changeset creation died:
    the scoped CFN exec role is not authorized for `ssm:GetParameters` on
    `parameter/cdk-bootstrap/hnb659fds/version`. Root cause: every CDK v2 template carries the
    `BootstrapVersion` SSM parameter, and CloudFormation resolves it USING THE EXECUTION ROLE —
    a baseline CDK requirement the scoped policy (deliberately minimal) does not include. The
    default bootstrap never surfaces this because its exec role is AdministratorAccess.
  - Post-failure state verified read-only: SecurityStack does NOT exist (no partial resources);
    refresh role absent; 0 OIDC providers. Account state = 2 policies + CDKToolkit only.
  - RECOMMENDED FIX (awaits architect decision; not applied): add to the versioned exec template a
    single read-only statement — `ssm:GetParameters` on
    `arn:aws:ssm:us-east-1:<ACCOUNT_ID>:parameter/cdk-bootstrap/hnb659fds/version` (exact ARN, no
    wildcard, no escalation surface) + matching test assertion; then commit -> review -> push ->
    operator `create-policy-version --set-as-default` on the exec policy (allowed: the exec
    policy's Deny binds the CFN role, not the operator) -> retry deploy under gate. Alternative
    (NOT recommended): suppress the bootstrap-version rule in the synthesizer — removes a safety
    rail.
  - NOT done (per gate): GitHub secret/vars; workflows; any Bedrock call; paid smoke.
- Stage 2b (ssm fix, approved conceptually — code/docs only, live policy NOT updated, deploy NOT
  retried):
  - `cfn-exec-security.template.json`: added `ReadCdkBootstrapVersionParameter` — Allow
    `ssm:GetParameters` on exactly `arn:aws:ssm:us-east-1:<placeholder>:parameter/cdk-bootstrap/hnb659fds/version`.
  - `bootstrap-policies.test.js`: new test — exactly one SSM statement; Action exactly
    `ssm:GetParameters`; Resource exactly the hnb659fds/version parameter; no other SSM reference
    in either policy (boundary stays SSM-free).
  - Runbook step 5 documents the read as a baseline requirement of the CDK
    `DefaultStackSynthesizer` (BootstrapVersion parameter resolved by CFN with the execution
    role) and forbids suppressing the bootstrap-version rule as an alternative.
  - Boundary untouched; synthesizer untouched; no other stacks/GitHub wiring/Bedrock.
  - NEW commit (no amend — `8ed1449` is published); SHA via `git log --oneline origin/main..HEAD`.
  - Pipeline: Codex review -> human push gate -> CI green -> NEW gate for
    `create-policy-version --set-as-default` on the exec policy + live-policy confirmation +
    SecurityStack-only deploy retry.
- ssm fix pushed as `be45b95`; CI green (Quality 30149030504, CodeQL 30149030323, Infra Synth
  30149030521, 22/22).
- Stage 2c EXECUTED (human mutation gate) — COMPLETE:
  - Template rendered exclusively from `git show be45b95:...`; exec policy version **v2** created
    and set default; live default normalized (jq -S) is **byte-identical** to the rendered
    template; delta v1->v2 is exactly the approved `ReadCdkBootstrapVersionParameter` statement.
    Boundary untouched (still v1 default).
  - SecurityStack deploy retried from be45b95 under the scoped exec role: **CREATE_COMPLETE 5/5**
    in ~49s — the ssm read was the only missing baseline permission.
  - Validated read-only (masked): stack CREATE_COMPLETE; exactly ONE OIDC provider
    (token.actions.githubusercontent.com); refresh role exists with trust
    `sts:AssumeRoleWithWebIdentity` + aud `sts.amazonaws.com` + sub
    `repo:marciozampiron/backstage-cba-prep:ref:refs/heads/main`; PermissionsBoundary attached
    (`cba-study-coach-pilot-boundary-bedrock-refresh`); inline policy = `bedrock:InvokeModel` on
    profile + 3 routed ARNs; **simulate-principal-policy on the real role**: InvokeModel-on-profile
    allowed, InvokeModelWithResponseStream/s3/dynamodb/iam/sts all implicitDeny.
  - Account inventory now: 2 operator policies (+v2 on exec), CDKToolkit, SecurityStack (native
    provider + role + policy). Nothing else.
  - NOT done (each needs its own gate): GitHub secret/vars rewiring; no-spend workflow proof; paid
    smoke; other stacks. STOPPED per the gate.
- Stage 3 EXECUTED (human gate) — GitHub wiring + no-spend proof, COMPLETE:
  - Read `BedrockRefreshRoleArn` from the /tmp outputs-file and verified IN-SHELL (never printed)
    that it equals the live role ARN (`iam get-role`) — MATCH.
  - Overwrote ONLY the GitHub secret `AWS_BEDROCK_REFRESH_ROLE_ARN` (now points at the authorized
    account's role). `AWS_REGION=us-east-1` and `BEDROCK_MODEL_STANDARD=us.anthropic.claude-sonnet-5`
    confirmed unchanged.
  - `blueprint-refresh` dispatched with `confirm_ai_spend=false` — run 30149327574, success:
    `Check Bedrock refresh gate` ran and set skip=true; `Configure AWS credentials`,
    `Install dependencies`, `Regenerate the domain`, `Check the bank`, `Open a PR` ALL SKIPPED;
    no PR created; zero role assumption; zero Bedrock; zero spend.
  - Runbook steps 1-9 of #54 are now proven end-to-end on the authorized account. REMAINING
    (separate explicit gates): step 10 paid smoke (`confirm_ai_spend=true`) -> evidence -> #65/#66
    reconciliation; step 11 ai-batch hardening; other stacks.
- Stage 4 EXECUTED (single authorized paid attempt) — run 30149508015, **failure at the Converse
  step; OIDC path fully proven; ZERO spend**:
  - Gate passed with `confirm_ai_spend=true`; **`Configure AWS credentials` SUCCEEDED — GitHub
    Actions assumed the refresh role via OIDC** ("Assuming role with OIDC / Authenticated as
    assumedRoleId ...:GitHubActions") — the #66 acceptance item "GitHub Actions assumes the new
    role through OIDC" is now proven live.
  - `Regenerate the domain` FAILED: "Bedrock access denied for us.anthropic.claude-sonnet-5".
    No retry performed (per gate). Downstream steps (bank check, PR) skipped; no PR created.
  - Read-only root-cause diagnosis (no mutation): IAM is NOT the cause —
    `simulate-principal-policy` on the real role allows InvokeModel on both the profile and the
    routed model. `get-foundation-model-availability`: authorization AUTHORIZED,
    entitlement/region AVAILABLE, but **agreement.status = NOT_AVAILABLE**, and
    `list-foundation-model-agreement-offers` returns an **available agreement offer** for
    `anthropic.claude-sonnet-5` (usage-based pricing rate card; the API returns the offer itself —
    there is no offerStatus field). The account never accepted the model's marketplace agreement —
    invoke is denied at the subscription layer, exactly the risk logged in stage 1. AWS docs
    confirm Anthropic models require the FTU (first-time-use) form before activation and the
    agreement can be created after obtaining the offer.
  - REQUIRED HUMAN ACTION (never automated per guardrails): accept the model agreement / subscribe
    (console "Model access" for Anthropic Claude Sonnet 5, or
    `create-foundation-model-agreement` with the listed offer) — a paid-terms acceptance, owner
    decision.
  - Cost/usage of this attempt: the Converse call was denied BEFORE inference — zero input/output
    tokens, zero spend. The only cost is the ~9s GitHub Actions runner time.
  - Infra/secrets/vars/policies untouched. STOPPED for Codex review; #65/#66 stay open; no push.
- Stage A of #72 (sub-issue of #66) EXECUTED — versioned local patch only, NO AWS/GitHub mutation:
  - Pivot: Claude Sonnet 5 is commercially unavailable for this account (AWS Sales path); the
    pilot's **configured standard-tier model** becomes **Amazon Nova Pro**
    (`us.amazon.nova-pro-v1:0`, AUTHORIZED + agreement AVAILABLE, profile ACTIVE). Sonnet 5 stays
    a **non-blocking follow-up via AWS Sales** — swap back is config-only.
  - Patched: `security-stack.js` defaults (profile + 3 routed `amazon.nova-pro-v1:0` ARNs);
    `bedrock-refresh-boundary.template.json` (profile + routed ARNs); tests updated
    (`security-stack`, `bootstrap-policies`, `context` fixtures); infra README context row;
    runbook §2 JSON/§3 example/step 1 wording -> "configured standard-tier model" framing.
  - Unchanged by design: exec policy template; `ModelProvider`/Bedrock Converse adapter;
    domain/application; frontend/BFF/Strands/questions; `src/lib/model-config.js` CLI default
    (runtime uses the `BEDROCK_MODEL_STANDARD` var, updated only in Stage B — recorded as a
    non-blocking follow-up to reconcile the CLI default later).
  - #66 acceptance wording now reads "configured standard-tier Bedrock model" (per #72).
  - Stage B (publish + boundary v2 + SecurityStack redeploy + var update + no-spend re-proof) and
    Stage C (single paid smoke) each require their own explicit human gates.
- Stage A review (Codex) — 4 findings fixed, amended into the same commit:
  - [Blocking] `model-config.js` BEDROCK_DEFAULTS.standard -> `us.amazon.nova-pro-v1:0` (direct
    Anthropic default stays Sonnet 5, per review) + `.env.example` BEDROCK_MODEL_STANDARD. Local
    `agent-check` now resolves bedrock standard to Nova Pro — no divergence between Actions and
    local no-spend checks. Root tests unaffected (69/69 — they assert overrides/anthropic only).
  - [Incorrect] "swap back by config only" wording fixed in the stack comment and runbook §2:
    boundary + inline policy are model-specific — a model switch needs config PLUS a new boundary
    default version PLUS a SecurityStack redeploy, each human-gated.
  - [Runbook] step 1 now requires the FULL availability tuple (AUTHORIZED + entitlement + region +
    agreement AVAILABLE), noting AUTHORIZED-only was exactly how Sonnet 5 passed preflight and
    failed the paid smoke.
  - [Governance] issue #66 body updated (GitHub as source of truth): scope bullet + acceptance
    criterion now say "configured standard-tier Bedrock model (currently Amazon Nova Pro, per
    #72)" instead of naming Sonnet 5.
  - Revalidated: root 69/69; infra 22/22; synth OK; validate 60/0; diff --check clean (worktree +
    commit); zero account id. New SHA via `git log --oneline origin/main..HEAD`.
- Final Stage A cycle: no-override default assertion added (root 70/70); commit message corrected
  (model switch = config + boundary version + SecurityStack rollout, not config-only). Pushed as
  `9a377ef`; CI green (Quality 30151230888, CodeQL 30151230679, Infra Synth 30151230876).
- Stage B of #72 EXECUTED (human gate) — COMPLETE, masked evidence:
  - Boundary rendered exclusively from `git show 9a377ef:...`; **boundary v2 created and set
    default**; live default normalized == rendered template (byte-identical). Resources = Nova Pro
    profile + 3 routed `amazon.nova-pro-v1:0` ARNs.
  - `cdk diff SecurityStack` (change-set based) showed ONLY the Sonnet->Nova Pro swap inside
    `BedrockRefreshRole/DefaultPolicy` — no other resource/trust/provider change -> proceeded.
  - SecurityStack redeployed: **UPDATE_COMPLETE** (~26s) under the scoped exec role.
  - Effective policy validated (`simulate-principal-policy` on the real role): Nova Pro
    profile/routed **allowed**; Sonnet 5 profile/routed **implicitDeny**;
    InvokeModelWithResponseStream/s3/dynamodb/iam/sts **implicitDeny**.
  - ONLY `BEDROCK_MODEL_STANDARD` updated -> `us.amazon.nova-pro-v1:0` (AWS_REGION untouched).
  - No-spend re-proof: run 30151437076 success — gate skip=true; Configure-AWS-credentials,
    npm ci, generation, bank-check, PR ALL SKIPPED; no PR; zero spend.
  - Prohibitions respected: no `confirm_ai_spend=true`; no other stack/secret/role/policy; no
    retry/rollback; no account id/ARN in versioned files; no push.
  - REMAINING: Stage C — ONE paid Nova Pro smoke behind its own explicit gate; on success,
    reconcile #65 and close #66.
- Stage C EXECUTED (single authorized paid run 30151538275) — **core runtime evidence COMPLETE;
  run marked failure ONLY at the PR-tooling step**, no retry/fix per gate:
  - OIDC ✓: "Assuming role with OIDC / Authenticated as assumedRoleId ...:GitHubActions".
  - **Bedrock Converse with Nova Pro ✓ — the PAID invocation SUCCEEDED**: blueprint regenerated
    from the LF source page; **usage captured: ~1613 input / 322 output tokens
    (bedrock/us.amazon.nova-pro-v1:0)**.
  - No-diff outcome ✓: "Local blueprint already matches the source page" — the domain did not
    change, so no PR was needed.
  - Bank validation ✓: 60 questions valid — 0 errors.
  - FAILURE (workflow plumbing, not Bedrock/IAM/spend): the `Open a PR` step's git call died with
    `remote: Duplicate header: "Authorization"` -> HTTP 400 (the checkout-persisted AUTHORIZATION
    extraheader collides with the PR action's own credential). Ironically no PR was even required
    (no-diff), but the action does git housekeeping before detecting that. Residual finding for a
    reviewed workflow fix (e.g. `persist-credentials: false` on checkout in blueprint-refresh.yml)
    — NOT applied in this stage.
  - All #66 Stage C evidence items captured: OIDC, model invocation, usage, validation, no-diff.
    Issues NOT closed (await Codex final validation). No AWS/IAM/stack/secret/var change; masked.

## Final report

- Status: **DONE** — #66 closed by the human after Codex's independent validation of the Stage C
  evidence (option (a): the isolated create-pull-request failure does not justify another paid
  smoke). #65 and #72 closed alongside; all three are Done on the board.
- Delivered across the task: authorized-account preflight; operator policies (permissions boundary
  + scoped CFN exec policy, v2 with the SSM bootstrap-version read); scoped CDKToolkit bootstrap
  (termination-protected, no --trust); SecurityStack (native AWS::IAM::OIDCProvider, refresh role
  with boundary, InvokeModel-only policy) deployed and later updated to Nova Pro (#72); GitHub
  secret/var wiring; no-spend gate proven twice; single paid smoke with runtime evidence
  (OIDC ok; Converse ok on bedrock/us.amazon.nova-pro-v1:0; usage 1613 in / 322 out; blueprint
  no-diff; bank 60/0).
- Published commits on this track: `8ed1449`, `be45b95`, `9a377ef` — all CI green
  (Quality/CodeQL/Infra Synth).
- Follow-ups: #73 (blueprint-refresh PR-step hardening: explicit no-diff success, skip PR on
  no-diff, credential-collision fix, supported create-pull-request version, no-spend validation);
  `ai-batch` environment hardening (own follow-up, outside #66 acceptance); Sonnet 5 via AWS
  Sales (non-blocking).
- Push/CI status: all pushes for this track were human-gated and green; EVENTS.md/CURRENT.md
  remain uncommitted audit residue for the next governance cleanup.
