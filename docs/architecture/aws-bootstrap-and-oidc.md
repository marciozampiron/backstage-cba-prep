# AWS Bootstrap and IAM/OIDC Model

This document defines the one-time AWS bootstrap and the IAM/OIDC model for #54. It implements the
GitHub-side contract from
[`github-security-and-oidc-baseline.md`](github-security-and-oidc-baseline.md) (#52): a GitHub OIDC
identity provider in AWS and the dedicated **blueprint-refresh Bedrock role** that
`.github/workflows/blueprint-refresh.yml` already references as `AWS_BEDROCK_REFRESH_ROLE_ARN`.

Scope boundary:

- **#52** defined *what* GitHub needs (roles, trust conditions, vars/secrets).
- **This doc (#54)** defines the *AWS bootstrap that satisfies it* — the OIDC provider and the one
  role that exists today — with copy-pasteable policy JSON and a runbook.
- **#49/#53** lift these policies into the CDK app (`infra/aws/`, security-stack) when it is
  scaffolded; the JSON here is the authoritative source they encode.

This is a **define/bootstrap** task. It creates no AWS resources by itself, uses no long-lived AWS
keys, and triggers no live Bedrock call. `infra/` is intentionally not started here (that is #53).

## What gets bootstrapped

Only two things, and nothing else yet:

1. a GitHub Actions **OIDC identity provider** in the AWS account;
2. the **blueprint-refresh Bedrock role**, assumable only by this repo via OIDC, permitted only to
   invoke the configured standard-tier model.

No deploy roles, no data plane, no app infrastructure — those arrive with #46/#49 once the CDK app
and environments exist.

## 1. GitHub OIDC identity provider

Create one OIDC provider per account for GitHub Actions:

- Provider URL: `https://token.actions.githubusercontent.com`
- Audience (client id): `sts.amazonaws.com`

CLI:

```bash
aws iam create-open-id-connect-provider \
  --url https://token.actions.githubusercontent.com \
  --client-id-list sts.amazonaws.com
```

Note: `--thumbprint-list` is optional — when omitted, IAM retrieves the IdP's thumbprint
automatically, and AWS validates the GitHub IdP's TLS certificate against its own trusted CA store
(the thumbprint is a fallback). Do not pass a thumbprint manually unless you are deliberately
pinning real thumbprints for an operational requirement. The provider is account-global — create it
once; every repo role federates the same provider.

Resulting provider ARN (used in every role's trust policy):

```text
arn:aws:iam::<ACCOUNT_ID>:oidc-provider/token.actions.githubusercontent.com
```

## 2. Blueprint-refresh Bedrock role

### Naming and tags

Per the `aws-iac-foundation.md` convention:

- Role name: `cba-study-coach-gha-bedrock-refresh`
- Tags: `Project=CBAStudyCoach`, `ManagedBy=bootstrap` (later `ManagedBy=CDK`), `Owner=<owner>`,
  `CostCenter=pilot`.

### Trust policy

Federate the OIDC provider and constrain the token subject to this repository. Two options:

**Bootstrap (works with the current workflow as-is)** — branch-scoped to `main`:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "Federated": "arn:aws:iam::<ACCOUNT_ID>:oidc-provider/token.actions.githubusercontent.com"
      },
      "Action": "sts:AssumeRoleWithWebIdentity",
      "Condition": {
        "StringEquals": {
          "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
          "token.actions.githubusercontent.com:sub": "repo:marciozampiron/backstage-cba-prep:ref:refs/heads/main"
        }
      }
    }
  ]
}
```

**Target (stronger; requires a one-line workflow change)** — environment-scoped to `ai-batch`:

```jsonc
// ...same as above, but the sub condition becomes:
"token.actions.githubusercontent.com:sub": "repo:marciozampiron/backstage-cba-prep:environment:ai-batch"
```

The environment-scoped form only authorizes runs that passed the `ai-batch` environment gate
(required reviewer + the workflow's `confirm_ai_spend` input). To use it, the human must (a) create
the `ai-batch` GitHub Environment with a required reviewer, and (b) add `environment: ai-batch` to
the `refresh` job in `blueprint-refresh.yml`. Until then, use the branch-scoped trust — it already
works with today's manual `confirm_ai_spend` gate. Do **not** widen the subject to the whole repo
(`repo:.../*`); that would let any branch/PR assume the role.

### Permission policy (least privilege)

The Bedrock adapter calls the **Converse API**. AWS authorizes `Converse` with the
`bedrock:InvokeModel` action (and `ConverseStream` with `bedrock:InvokeModelWithResponseStream`).
Blueprint refresh is **non-streaming**, so the role needs `bedrock:InvokeModel` only.

`BEDROCK_MODEL_STANDARD` is the **configured standard-tier cross-region inference profile**
(#117 target, decided by Zamp 2026-08-15: `us.anthropic.claude-sonnet-5`. Playground succeeded
under the human console identity; the agreement-availability API diverges for the Opus pair —
recorded, neither signal definitive. Application-path validation only after the programmatic
smokes under their own spend authorization.
policy are **model-specific**, switching the standard-tier model is NOT config-only: it requires
the new configuration PLUS a new default version of the operator-managed boundary AND a
SecurityStack redeploy, each behind its own human gate. A `us.*` profile routes the actual
invocation to the underlying foundation model in one of several US regions, so the policy must
allow **both** the profile ARN and each routed foundation-model ARN — granting only the profile
ARN fails at invoke time.

Enumerate the exact routed model ARNs (do not guess them):

```bash
aws bedrock get-inference-profile \
  --region "$AWS_REGION" \
  --inference-profile-identifier "$BEDROCK_MODEL_STANDARD" \
  --query 'models[].modelArn' --output text
```

Then scope the policy to the profile + those model ARNs, region-locked:

```jsonc
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "InvokeStandardTierViaInferenceProfile",
      "Effect": "Allow",
      "Action": "bedrock:InvokeModel",
      "Resource": [
        // the configured standard-tier inference profile (account-scoped, in the call region):
        "arn:aws:bedrock:<REGION>:<ACCOUNT_ID>:inference-profile/us.anthropic.claude-sonnet-5",
        // each routed foundation model (account-less "::"), from get-inference-profile above:
        "arn:aws:bedrock:us-east-1::foundation-model/<routed-model-id>",
        "arn:aws:bedrock:us-east-2::foundation-model/<routed-model-id>",
        "arn:aws:bedrock:us-west-2::foundation-model/<routed-model-id>"
      ]
    }
  ]
}
```

Notes:

- `<REGION>` must be a US region for a `us.*` profile and must match the `AWS_REGION` GitHub var.
- Foundation-model ARNs are **account-less** (`:::` → `::`); inference-profile ARNs carry the
  account id.
- If the model ids are not yet pinned (the repo defaults are forward-looking — see
  `model-config.js`), enable model access in the Bedrock console first and confirm the ids with
  `aws bedrock list-inference-profiles` before writing the policy.
- The role carries **no** other permissions — no data plane, no deploy, no `iam:*`, no wildcards on
  actions. Bedrock invoke is isolated from the Web BFF (ADR-0002).

## 3. GitHub variables and secrets to set

The human sets these after the role exists (the ARN and account id are only known post-creation):

| Name | Kind | Value | How |
| --- | --- | --- | --- |
| `AWS_REGION` | variable | e.g. `us-east-1` | `gh variable set AWS_REGION --body us-east-1` |
| `BEDROCK_MODEL_STANDARD` | variable | the configured standard-tier profile (currently `us.anthropic.claude-sonnet-5`) | `gh variable set BEDROCK_MODEL_STANDARD --body us.anthropic.claude-sonnet-5` |
| `AWS_BEDROCK_REFRESH_ROLE_ARN` | secret | the created role ARN | `gh secret set AWS_BEDROCK_REFRESH_ROLE_ARN --body arn:aws:iam::<ACCOUNT_ID>:role/cba-study-coach-gha-bedrock-refresh` |

Model ids are configuration (variables), not secrets. The role ARN is stored as a secret only to
avoid disclosing the account id; a variable would also be functionally fine.

## 4. Bootstrap runbook

Run once, by an operator with AWS admin in the pilot account. No CI runs this; it is manual.

1. **Enable Bedrock model access** for the configured standard-tier model in the target region(s)
   via the Bedrock console, then verify the FULL availability tuple with
   `aws bedrock get-foundation-model-availability --model-id <model-id>` — it must report
   `authorizationStatus: AUTHORIZED` **and** `entitlementAvailability: AVAILABLE` **and**
   `regionAvailability: AVAILABLE` **and** `agreementAvailability.status: AVAILABLE`.
   `AUTHORIZED` alone is NOT sufficient: a model can be authorized while its marketplace agreement
   is missing, and the invoke then fails at runtime (this is exactly how the Sonnet 5 preflight
   passed and the paid smoke failed). Confirm the standard inference-profile id with
   `aws bedrock list-inference-profiles`.
2. **Check for an existing GitHub OIDC provider** (`aws iam list-open-id-connect-providers`).
   Do **not** create one manually — the foundation SecurityStack **creates and owns** the native
   provider (step 7), unconditionally. The import path was removed (#111 F1 round 2): a supplied
   provider ARN used to take `GithubOidc` out of the template, and a REDEPLOY of the deployed
   foundation with that context would make CloudFormation delete the live provider it owns —
   severing every OIDC trust in the account. Distinguish the two situations this step can find:
   - **Initial creation** (the foundation has never deployed): the provider must not pre-exist
     under another owner — IAM allows one provider per URL, so a `CREATE_FAILED
     (EntityAlreadyExists)` means the operator first deletes the foreign provider or brings it
     under the stack with a CloudFormation **resource import** — both human-gated operator
     actions, never context.
   - **Redeploy** (the deployed foundation): the stack already owns `GithubOidc`; pass nothing.
   There is no `githubOidcProviderArn` context at all anymore (#111 round 3): the
   ObservabilityStack gate role consumes the foundation's exported reference as a REQUIRED
   property, so neither foundation ownership nor the gate role's trust anchor can be re-aimed
   from ambient context.
3. **Enumerate routed model ARNs** with `aws bedrock get-inference-profile` (§2).
3b. **Provision the release-preflight role** (#111) with the operator-managed script — it
   renders `preflight-role-trust.template.json` + `preflight-role-policy.template.json`
   (the SIXTH template family), creates `cba-study-coach-gha-release-preflight-<env>`,
   attaches exactly the single-action `cognito-idp:DescribeUserPoolDomain` policy and
   READS BACK fail-closed (trust, one inline policy, zero managed policies) before
   printing the masked ARN:

   ```bash
   bash scripts/provision-preflight-role.sh dev
   gh secret set AWS_DEPLOY_PREFLIGHT_ROLE_ARN --env dev --repo marciozampiron/backstage-cba-prep --body "<the unmasked ARN>"
   ```

   The dev Environment then needs the variables `AWS_REGION`, `CBA_AUTH_CALLBACK_URLS`,
   `CBA_AUTH_LOGOUT_URLS`, `CBA_AUTH_DOMAIN_PREFIX`, `CBA_CORS_ALLOWED_ORIGINS` and
   `CBA_EXPECTED_USER_POOL_ID` (may stay absent only while the domain prefix is provably
   free; record it after the pool exists) — the
   URL values derive from the account's `workers.dev` subdomain (worker
   `cba-study-coach-dev-web`), read from the Cloudflare dashboard and NEVER committed.
4. **Render the versioned policy templates** (they live in Git with `ACCOUNT_ID_PLACEHOLDER`
   only — `infra/aws/bootstrap/policies/`). Substitute the account id from STS at render time; the
   rendered files stay under `/tmp` and never enter Git:

   ```bash
   ACCT=$(aws sts get-caller-identity --query Account --output text)
   mkdir -p /tmp/cba-bootstrap
   for t in bedrock-refresh-boundary cfn-exec-security; do
     sed "s/ACCOUNT_ID_PLACEHOLDER/$ACCT/g" \
       infra/aws/bootstrap/policies/$t.template.json > /tmp/cba-bootstrap/$t.json
   done
   # The #70 release trio renders PER ENVIRONMENT (dev -> qualifier cbardev, pilot -> cbarpil):
   for e in dev pilot; do
     case "$e" in dev) q=cbardev;; pilot) q=cbarpil;; esac
     for t in gha-deploy-boundary runtime-boundary cfn-exec-release; do
       sed -e "s/ACCOUNT_ID_PLACEHOLDER/$ACCT/g" \
           -e "s/ENVIRONMENT_PLACEHOLDER/$e/g" \
           -e "s/QUALIFIER_PLACEHOLDER/$q/g" \
         infra/aws/bootstrap/policies/$t.template.json > /tmp/cba-bootstrap/$t-$e.json
     done
   done
   ```

   Eight templates, three rendering families (#111 added the preflight trio — trust, policy
   and boundary — provisioned by scripts/provision-preflight-role.sh): the #66 pair (bedrock-refresh boundary + scoped
   SecurityStack execution policy, account substitution only) and the #70 release trio (the
   GitHub deploy-role boundary, the runtime boundary every release-created role carries, and the
   release CloudFormation execution policy — account + ENVIRONMENT + QUALIFIER substitution, one
   rendering per tier so dev authority names not one pilot resource) — see step 12.

5. **Create the operator-managed policies** (outside CloudFormation): the permissions boundary
   `cba-study-coach-pilot-boundary-bedrock-refresh` (caps the refresh role at
   `bedrock:InvokeModel` on the standard profile + routed models) and the scoped CloudFormation
   execution policy `cba-study-coach-pilot-cfn-exec-security` (OIDC-provider lifecycle, CreateRole
   pinned to the boundary via `iam:PermissionsBoundary`, lifecycle on the exact role only, explicit
   denies on boundary tampering; no PassRole/lambda/logs/s3). The policy also grants
   `ssm:GetParameters` on exactly `parameter/cdk-bootstrap/hnb659fds/version`: this read is a
   **baseline requirement of the CDK `DefaultStackSynthesizer`** — every synthesized template
   carries the `BootstrapVersion` SSM parameter and CloudFormation resolves it **using the
   execution role**; without it, changeset creation fails before any resource is touched. Do not
   suppress the bootstrap-version rule in the synthesizer instead — it is a safety rail:

   ```bash
   BOUNDARY_POLICY_ARN=$(aws iam create-policy \
     --policy-name cba-study-coach-pilot-boundary-bedrock-refresh \
     --policy-document file:///tmp/cba-bootstrap/bedrock-refresh-boundary.json \
     --query 'Policy.Arn' --output text)
   SCOPED_POLICY_ARN=$(aws iam create-policy \
     --policy-name cba-study-coach-pilot-cfn-exec-security \
     --policy-document file:///tmp/cba-bootstrap/cfn-exec-security.json \
     --query 'Policy.Arn' --output text)
   # both ARNs embed the account id — keep them in shell variables, do not echo them
   ```

6. **Bootstrap CDK with the scoped execution policy** (no `--trust`, single-account; CDK commands
   run from the repo's `infra/aws/` directory, where `cdk.json` lives):

   ```bash
   cd infra/aws
   npx --no-install cdk bootstrap "aws://$ACCT/us-east-1" \
     --cloudformation-execution-policies "$SCOPED_POLICY_ARN" \
     --termination-protection
   ```

7. **Deploy the SecurityStack only** (creates the native OIDC provider and the role with the
   boundary attached — see §5), passing the routed model ARNs from step 3:

   ```bash
   npx --no-install cdk deploy SecurityStack \
     -c bedrockRoutedModelArns='["<routed-model-arn-1>","<routed-model-arn-2>","<routed-model-arn-3>"]' \
     --require-approval never \
     --outputs-file /tmp/cba-bootstrap/security-outputs.json
   # the outputs file carries the role ARN (account id) — it stays under /tmp, never in Git
   ```

8. **Set the GitHub var/secret** (`AWS_BEDROCK_REFRESH_ROLE_ARN`, plus `AWS_REGION` and
   `BEDROCK_MODEL_STANDARD` if not already present) (§3).
9. **Prove the gate without spending**: run the `Refresh blueprint` workflow with
   `confirm_ai_spend=false` — it must skip (no role assumption, no tokens).
10. **First gated live run** (optional, spends tokens): run with `confirm_ai_spend=true`; verify the
    OIDC role is assumed, Converse succeeds, and a blueprint PR opens if the domain changed. This is
    the only step that spends and is human-initiated.
11. **Harden (recommended)**: create the `ai-batch` Environment with a required reviewer, add
    `environment: ai-batch` to the workflow's `refresh` job, and switch the trust policy subject to
    the environment-scoped form (§2).
12. **Release bootstraps (#70 Slice B1; #111 operator machine)** — a SEPARATE CDK bootstrap PER
    ENVIRONMENT (dev: qualifier `cbardev`, pilot: `cbarpil` — reviewed constants in
    `lib/context.js`), each with its OWN toolkit stack, execution role and policy, so dev
    authority reaches only dev and neither tier touches the #66 foundation bootstrap.
    `--toolkit-stack-name` is REQUIRED: without it the CDK would update the existing `CDKToolkit`
    stack instead of creating the separate bootstrap this design names.

    Both steps run through the operator-managed launcher `scripts/provision.sh` — TWO MUTUALLY
    EXCLUSIVE PHASES, one human gate each, never a combined mode. The launcher binds the reviewed
    commit FIRST (`CBA_AUTHORIZED_SHA` must equal HEAD of a clean worktree; every git probe's exit
    status is validated before its output is read, so a failed probe is never a clean answer),
    then MATERIALIZES that commit's `scripts/` and `infra/aws/bootstrap/` into a private,
    write-stripped directory with `git archive` and execs the provisioning script FROM THERE. The
    worktree copies never run: self-verification from inside a running script is circular and
    racy, and the provisioning script refuses outright unless it is the materialized copy. (The
    launcher's own bytes are not self-verified — nothing can do that from inside; it is kept tiny
    and single-purpose so it can be read whole, and #91 Stage B is where signing closes it.) The
    provisioning script then binds the account (`CBA_EXPECTED_ACCOUNT_ID`, re-checked immediately
    before the first mutation), reads the step-4
    trio fresh per phase from that SHA into a private 0700 tempdir, creates only what is provably
    absent (`NoSuchEntity` / "does not exist"), refuses any pre-existing divergence with zero
    mutation, and read-backs the full surface before reporting OK. The toolkit template is the
    COMMITTED, reviewed snapshot `infra/aws/bootstrap/cdk-bootstrap-template.yaml` (digest pinned
    by test) and it deploys DIRECTLY through CloudFormation via the AWS CLI — no `cdk`/`npx`, no
    node_modules code ever runs under the operator's credentials; the pinned-CDK ↔ snapshot
    agreement is a credential-free CI proof (`infra/aws/test/bootstrap-template-snapshot.test.js`).
    The read-back validates the live stack — full resource set, the COMPLETE parameter map, the
    five `cdk-<qualifier>-*` roles' trust/tags/managed/inline/session-duration, execution-policy
    exclusivity, SSM version, bucket (policy, lifecycle, ACL), ECR (lifecycle + policy), KMS
    (policy + alias) — against expectations RESOLVED from that snapshot
    (`scripts/lib/bootstrap-expected-state.py`, closed by resource type AND property), with every
    external call in its own bounded, group-killed process. Evidence carries names and digests:

    The launcher itself is run from the COMMIT, not from the worktree — that is what keeps a
    tampered checkout from executing anything:

    ```bash
    # Once per gate. SHA is the commit the gate authorizes; REPO is the local clone.
    # Strict subshell + trap: an extraction failure or a refusal from the provisioner must reach
    # you as a nonzero status, never be masked by the cleanup. `bash -p` keeps $BASH_ENV and
    # inherited shell functions from running before the reviewed bytes.
    (
      set -euo pipefail
      L=$(mktemp /tmp/cba-launch.XXXXXX)
      trap 'rm -f "$L"' EXIT
      git -C "$REPO" show "$SHA:scripts/provision.sh" > "$L"
      CBA_REPO_ROOT="$REPO" CBA_AUTHORIZED_SHA="$SHA" CBA_EXPECTED_ACCOUNT_ID=<account> \
        bash -p "$L" dev policies
    )
    # Gate 1 = `dev policies` (the three operator policies; no CDK, no CloudFormation).
    # Gate 2 = the same block with `dev bootstrap` (re-observes the policies read-only; never
    # creates or alters one). Check the exit status before treating a phase as done.
    ```

    The chain a release then rides, per tier: the GitHub deploy role (SecurityStack, boundary
    `cba-study-coach-boundary-gha-deploy-<env>`) may ONLY assume that tier's
    `cdk-<qualifier>-{deploy,file-publishing,lookup}-role-*`; deployment ends in that tier's
    execution role, whose policy enumerates the four templates' real resource types with
    tier-scoped resource names and demands the `Project`/`Environment` tags wherever AWS offers
    no ARN to scope to — Cognito pools, KMS keys AND every API Gateway operation (`aws:RequestTag`
    on create, `aws:ResourceTag` on root and child lifecycle; the governance tags themselves are
    fenced by explicit denies against removal or foreign replacement, so an owned resource cannot
    be untagged out of its confinement). Every role a release creates is pinned to
    `cba-study-coach-boundary-runtime-<env>` by the `iam:PermissionsBoundary` condition; touching
    the `cba-study-coach-gha-*` roles or the `cdk-hnb659fds-*` foundation is explicitly denied.
    Redeploying the SecurityStack after this step (it now carries the per-tier GitHub deploy
    roles) is a separate human-gated `cdk deploy SecurityStack` under the #66 bootstrap, step 7
    form.

    **First deployment of a tier runs in dependency waves.** A CloudFormation change set whose
    `Fn::ImportValue` producers are unexecuted cannot be created, so the cloud gate names the
    reviewed plan group it covers and a fresh tier deploys as three plan/review/execute cycles —
    Identity+Data, then Api, then Observability — each wave under its own `CBA_CLOUD_GATE`
    (`plan_only` emits `PLAN_DIGEST`; `deploy` names it). Steady state, where every export
    already exists, uses the full group in a single cycle. The groups are reviewed constants
    (`DEPLOYMENT_PLAN_GROUPS`, `infra/aws/lib/context.js`); a discovery test walks the real CDK
    assembly graph and refuses any cross-stack edge that violates the wave order.

## 5. CDK target (for #49/#53)

When the CDK app is scaffolded (#53), the security-stack encodes exactly the artifacts above:

- a **native `AWS::IAM::OIDCProvider`** (`iam.CfnOIDCProvider`, no `ThumbprintList` — IAM retrieves
  it automatically) for `token.actions.githubusercontent.com` (audience `sts.amazonaws.com`), or
  import the existing provider by ARN. Deliberately **not** `iam.OpenIdConnectProvider`: its custom
  resource drags a plumbing Lambda + role into the template and forces the CloudFormation execution
  role to hold `iam:PassRole` + `lambda:*` — an indirect-escalation chain (#66 review);
- `iam.Role` with `WebIdentityPrincipal` conditioned on the `aud`/`sub` claims (§2), carrying an
  **operator-managed permissions boundary** (`cba-study-coach-pilot-boundary-bedrock-refresh`,
  created outside CloudFormation) that caps the role at `bedrock:InvokeModel` on the standard-tier
  profile + routed models. The scoped CloudFormation execution policy pins `iam:CreateRole` to this
  boundary ARN (`iam:PermissionsBoundary` condition) and explicitly denies boundary tampering;
- an inline policy granting `bedrock:InvokeModel` on the inference-profile + routed model ARNs (§2),
  region-locked;
- outputs the role ARN so it can be published to the GitHub secret.

Keep model ids and the account/region as CDK context/config, not hardcoded (mirrors
`model-config.js`). Sources of truth: the **versioned templates** under
`infra/aws/bootstrap/policies/` are canonical for the operator-managed policies (the permissions
boundary and the scoped CloudFormation execution policy — rendered per §4, never edited by hand in
`/tmp`); this doc's §2 JSON remains the contract for the role's trust and permission policy that
the stack constructs must reproduce. Change the templates/doc first, then the stack.

## 6. No-spend verification

- Offline config checks (no tokens, safe in CI): `node bin/cli.js agent-check --json`,
  `node bin/cli.js bedrock-check --json` validate the config shape (backend, region, model ids)
  without calling Bedrock.
- The workflow's `confirm_ai_spend=false` path proves the gate skips before any role assumption.
- A live Converse call necessarily spends; the first real end-to-end proof is the human-initiated
  gated run (runbook step 10). Default CI never reaches it.

## Non-goals

- No CDK app/tree (that is #53); no AWS resources created by this change; no `aws`/`cdk` execution.
- No deploy roles, data stores, or app infrastructure (#46/#49).
- No long-lived AWS keys anywhere; no live/paid Bedrock call by default.
- No edit to the live `blueprint-refresh.yml` (the `environment: ai-batch` addition is a documented
  follow-up).

## Follow-ups

- Operator runs the bootstrap runbook and sets `AWS_BEDROCK_REFRESH_ROLE_ARN` (+ vars).
- #53/#49 encode the OIDC provider + role in the CDK security-stack from §2/§5.
- Harden the blueprint-refresh trust to `environment:ai-batch` (create the env + one-line workflow
  change), per #52.
- Extend the role catalog with deploy roles when #46 deploy lanes land (separate roles, per-env,
  environment-scoped trust).
