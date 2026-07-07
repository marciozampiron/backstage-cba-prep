# CBA Study Coach — AWS CDK App (#53/#49)

AWS CDK v2 app for the pilot. Plain JavaScript (CommonJS, the CDK JS template style) — no build
step. **Synth-only in CI**; any deploy is human-gated and out of scope here.

## Layout

```text
bin/cba-pilot.js          app entry (env-agnostic — synth needs no AWS credentials)
lib/security-stack.js     #54 model: GitHub OIDC provider + blueprint-refresh Bedrock role (real)
lib/{identity,data,api,ai-orchestration,observability}-stack.js
                          placeholder stacks (foundation tags + one SSM scaffold marker), filled by
                          their owning tracks — see docs/architecture/aws-iac-foundation.md
lib/placeholder-stack.js  shared base for the placeholders
lib/context.js            context helpers incl. parseArnList (array or JSON-array string, validated)
lib/tags.js               foundation tags
test/context.test.js      offline unit tests (node --test)
cdk.json                  app command + safety context flags
```

Source of truth for the policies: `docs/architecture/aws-bootstrap-and-oidc.md` (#54). The stack
must reproduce that doc's trust/permission JSON; change the doc first, then the stack.

## Usage

```bash
cd infra/aws
npm ci
npm test               # offline unit tests for the context helpers
npm run synth          # credential-free; a template per stack lands in cdk.out/
```

No real account id is committed or synthesized: account/region resolve to CloudFormation pseudo
parameters (`AWS::AccountId` / `AWS::Region`).

## Context parameters

Override at synth/deploy time with `-c key=value`:

| Context key | Default | Purpose |
| --- | --- | --- |
| `githubRepo` | `marciozampiron/backstage-cba-prep` | repo baked into the OIDC trust subject |
| `githubTrustSub` | `repo:<githubRepo>:ref:refs/heads/main` | full trust subject; switch to `repo:<repo>:environment:ai-batch` for the hardening target |
| `githubOidcProviderArn` | *(empty → create)* | reuse the account-global GitHub OIDC provider instead of creating one |
| `bedrockStandardInferenceProfileId` | `us.anthropic.claude-sonnet-5` | standard-tier cross-region inference profile (config, not secret) |
| `bedrockRoutedModelArns` | 3-region placeholders | **JSON array**, e.g. `-c 'bedrockRoutedModelArns=["arn:aws:bedrock:us-east-1::foundation-model/..."]'` — replace at deploy time with the ARNs from `aws bedrock get-inference-profile` (see #54 doc §2). A non-array/bad value fails synth loudly (`parseArnList`). |
| `environment` | `pilot` | `Environment` tag |

## Outputs

- `BedrockRefreshRoleArn` — publish as the GitHub secret `AWS_BEDROCK_REFRESH_ROLE_ARN`.
- `GithubOidcProviderArn` — reuse for future roles via `-c githubOidcProviderArn=...`.

## Deliberate non-goals (this scaffold)

- No `cdk deploy`/`cdk diff` in CI (synth lane runs with zero AWS permissions per the #52 catalog).
- Only the security stack exists; identity/data/api/ai-orchestration/observability stacks arrive
  with their tracks (see `docs/architecture/aws-iac-foundation.md`).
- Deploy roles, environments, and bootstrap execution are #54-runbook/human actions.
