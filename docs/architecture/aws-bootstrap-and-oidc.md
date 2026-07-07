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

`BEDROCK_MODEL_STANDARD` is a **cross-region inference profile** (default
`us.anthropic.claude-sonnet-5`). A `us.*` profile routes the actual invocation to the underlying
foundation model in one of several US regions, so the policy must allow **both** the profile ARN and
each routed foundation-model ARN — granting only the profile ARN fails at invoke time.

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
        // the inference profile (account-scoped, in the call region):
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
| `BEDROCK_MODEL_STANDARD` | variable | e.g. `us.anthropic.claude-sonnet-5` | `gh variable set BEDROCK_MODEL_STANDARD --body us.anthropic.claude-sonnet-5` |
| `AWS_BEDROCK_REFRESH_ROLE_ARN` | secret | the created role ARN | `gh secret set AWS_BEDROCK_REFRESH_ROLE_ARN --body arn:aws:iam::<ACCOUNT_ID>:role/cba-study-coach-gha-bedrock-refresh` |

Model ids are configuration (variables), not secrets. The role ARN is stored as a secret only to
avoid disclosing the account id; a variable would also be functionally fine.

## 4. Bootstrap runbook

Run once, by an operator with AWS admin in the pilot account. No CI runs this; it is manual.

1. **Enable Bedrock model access** for the Claude models in the target region(s) via the Bedrock
   console (or `PutModelInvocationLoggingConfiguration`/access request), and confirm the standard
   inference-profile id with `aws bedrock list-inference-profiles`.
2. **Create the OIDC provider** (§1) if it does not already exist in the account.
3. **Enumerate routed model ARNs** with `aws bedrock get-inference-profile` (§2).
4. **Create the role** `cba-study-coach-gha-bedrock-refresh` with the trust policy (§2, branch-scoped
   to start) and attach the permission policy (§2) as an inline or customer-managed policy.
5. **Set the GitHub var/secret** (`AWS_BEDROCK_REFRESH_ROLE_ARN`, plus `AWS_REGION` and
   `BEDROCK_MODEL_STANDARD` if not already present) (§3).
6. **Prove the gate without spending**: run the `Refresh blueprint` workflow with
   `confirm_ai_spend=false` — it must skip (no role assumption, no tokens).
7. **First gated live run** (optional, spends tokens): run with `confirm_ai_spend=true`; verify the
   OIDC role is assumed, Converse succeeds, and a blueprint PR opens if the domain changed. This is
   the only step that spends and is human-initiated.
8. **Harden (recommended)**: create the `ai-batch` Environment with a required reviewer, add
   `environment: ai-batch` to the workflow's `refresh` job, and switch the trust policy subject to
   the environment-scoped form (§2).

## 5. CDK target (for #49/#53)

When the CDK app is scaffolded (#53), the security-stack encodes exactly the artifacts above:

- `iam.OpenIdConnectProvider` for `token.actions.githubusercontent.com` (audience
  `sts.amazonaws.com`), or import the existing provider by ARN;
- `iam.Role` with `WebIdentityPrincipal` conditioned on the `aud`/`sub` claims (§2);
- an inline policy granting `bedrock:InvokeModel` on the inference-profile + routed model ARNs (§2),
  region-locked;
- outputs the role ARN so it can be published to the GitHub secret.

Keep model ids and the account/region as CDK context/config, not hardcoded (mirrors
`model-config.js`). This doc's JSON is the source of truth the constructs must reproduce.

## 6. No-spend verification

- Offline config checks (no tokens, safe in CI): `node bin/cli.js agent-check --json`,
  `node bin/cli.js bedrock-check --json` validate the config shape (backend, region, model ids)
  without calling Bedrock.
- The workflow's `confirm_ai_spend=false` path proves the gate skips before any role assumption.
- A live Converse call necessarily spends; the first real end-to-end proof is the human-initiated
  gated run (runbook step 7). Default CI never reaches it.

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
