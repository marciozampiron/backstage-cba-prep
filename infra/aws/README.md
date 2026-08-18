# CBA Study Coach — AWS CDK App (#53/#49)

AWS CDK v2 app for the pilot. Plain JavaScript (CommonJS, the CDK JS template style) — no build
step. **Synth-only in CI**; any deploy is human-gated and out of scope here.

## Layout

```text
bin/cba-pilot.js          app entry (env-agnostic — synth needs no AWS credentials)
lib/security-stack.js     #54 model + #111 F1: the ONE account-global foundation — GitHub OIDC
                          provider, blueprint-refresh Bedrock role, and BOTH tiers' GitHub deploy
                          roles (cba-study-coach-gha-deploy-dev|pilot); deployed once as
                          cba-study-coach-pilot-security, referenced by every assembly (real)
lib/data-stack.js         #77: environment-scoped DynamoDB simulation table (on-demand, encrypted;
                          pilot durable with PITR+deletion protection+RETAIN, dev disposable);
                          grants/roles belong to #78
lib/api-stack.js          #78: provider-neutral BFF as Lambda (Node.js 22, bundled from
                          services/bff via its OWN lockfile) + HTTP API with EXPLICIT routes only;
                          minimal DynamoDB IAM (item CRUD on the exact table ARN, Query on the
                          exact gsi1 index ARN); fail-closed auth env until #69; CORS only as a
                          #69 seam (exact origins, never "*")
lib/identity-stack.js     #69: environment-scoped Cognito User Pool (invite-only, durable in
                          pilot) + PUBLIC PKCE-ready SPA client (authorization code grant ONLY —
                          no secret, no implicit, all direct auth flows explicitly off) + usable
                          classic hosted UI (pinned version + branding attachment); callback/
                          logout URLs are exact validated configuration (PKCE itself is executed
                          by the SPA — proven in #69 Slice C)
lib/{ai-orchestration,observability}-stack.js
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
| `bedrockRefreshBoundaryArn` | pseudo-account `policy/cba-study-coach-pilot-boundary-bedrock-refresh` | operator-managed permissions boundary attached to the refresh role (#66); created outside CloudFormation |
| `bedrockStandardInferenceProfileId` | `us.anthropic.claude-sonnet-5` | configured standard-tier cross-region inference profile (config, not secret; the #117 target — application-path validation only after the programmatic smokes) |
| `bedrockRoutedModelArns` | 3-region placeholders | **JSON array**, e.g. `-c 'bedrockRoutedModelArns=["arn:aws:bedrock:us-east-1::foundation-model/..."]'` — replace at deploy time with the ARNs from `aws bedrock get-inference-profile` (see #54 doc §2). A non-array/bad value fails synth loudly (`parseArnList`). |
| `environment` | `pilot` | environment (closed set `dev\|pilot`) — stack names, table/function names, runtime env |
| `corsAllowedOrigins` | *(empty → no CORS)* | **JSON array** of exact origins for the HTTP API CORS seam (#69); `"*"` is rejected |
| `authCallbackUrls` / `authLogoutUrls` | dev: localhost; pilot: `https://pilot.invalid/...` placeholders | **JSON array** of EXACT URLs for the Cognito SPA client (#69); https-only except localhost, wildcards rejected; #70 overrides at deploy with the real Cloudflare origin (#67) |
| `authDomainPrefix` | `cba-study-coach-<env>` | Cognito hosted-UI domain prefix (globally unique per region) |
| `runtimeBoundaryArn` | pseudo-account `policy/cba-study-coach-boundary-runtime-<env>` | operator-managed runtime permissions boundary applied to every role a RELEASE creates (#70 round 4; per tier) |

There is deliberately **no** `githubOidcProviderArn` context (#111 round 3): the foundation
creates and owns the provider unconditionally, and the ObservabilityStack gate role consumes the
foundation's exported reference as a REQUIRED property — neither ownership nor the trust anchor
can be re-aimed from ambient context. A test (`test/context.test.js`) keeps this table in exact
agreement with `DEPLOY_CONTEXT_KEYS`.

## Outputs

- `BedrockRefreshRoleArn` — publish as the GitHub secret `AWS_BEDROCK_REFRESH_ROLE_ARN`.
- `GithubOidcProviderArn` — cross-stack reference ONLY (consumed by the ObservabilityStack gate
  role through the foundation's export); it is not an input anywhere and cannot be passed back in.
- `GithubDeployRoleArn` — publish as the **pilot** Environment secret `AWS_DEPLOY_ROLE_ARN`.
- `GithubDeployRoleDevArn` — publish as the **dev** Environment secret `AWS_DEPLOY_ROLE_ARN`.

## Deliberate non-goals (this scaffold)

- No `cdk deploy`/`cdk diff` in CI (synth lane runs with zero AWS permissions per the #52 catalog).
- Real resources: the security stack (#54), the data stack (#77 DynamoDB simulation table), the
  api stack (#78 Lambda + HTTP API BFF, JWT-protected per #69) and the identity stack (#69
  Cognito pool + PKCE client); ai-orchestration/observability remain placeholders until their
  tracks (see `docs/architecture/aws-iac-foundation.md`).
- Deploy roles, environments, and bootstrap execution are #54-runbook/human actions.
