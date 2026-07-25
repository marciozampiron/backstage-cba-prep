# Pilot Environment Contract (#47)

Canonical contract for the CBA Web MVP environments. It consolidates decisions already accepted in
ADR-0002 and the #48/#49 foundation docs, and fixes the remaining implementation choices that
Issues #66/#67/#68/#69/#70 build against. It **links** to existing sources instead of duplicating
them.

| Question | Source of truth |
| --- | --- |
| Cloudflare/AWS runtime split, BFF-only browser surface | [ADR-0002](../adr/0002-cloudflare-nextjs-aws-bff.md) |
| IaC conventions, stack layout, tags | [aws-iac-foundation.md](aws-iac-foundation.md) |
| GitHub security, OIDC role catalog, Environments | [github-security-and-oidc-baseline.md](github-security-and-oidc-baseline.md) |
| AWS bootstrap + Bedrock role runbook | [aws-bootstrap-and-oidc.md](aws-bootstrap-and-oidc.md) |
| CI lanes, no-spend policy, branch protection | [ci-cd-security-foundation.md](ci-cd-security-foundation.md) |
| Learner API surface the BFF must serve | [web-bff-contracts.md](../product/web-bff-contracts.md) |
| Accepted topology diagrams (#34) | [diagrams/](diagrams/) |

Region: **`us-east-1`** is the default for every AWS environment (matches the `AWS_REGION` repo
variable, the Bedrock inference-profile region lock, and all foundation docs). Override only with a
recorded reason.

## 1. Environments: `local -> dev -> pilot`

| | `local` | `dev` | `pilot` |
| --- | --- | --- | --- |
| Purpose | development + deterministic smokes | first deployed integration | protected, production-like MVP |
| Frontend | `next dev` / local build | Cloudflare Workers: ephemeral **previews** (UI-only) + one **stable dev URL** for authenticated integration | Cloudflare Workers pilot deployment |
| BFF | Next.js `app/api/**` routes in-process | API Gateway HTTP API + Lambda BFF (dev stage) | API Gateway HTTP API + Lambda BFF (pilot stage) |
| Persistence | `CBA_WEB_STORE=memory` or `file` | DynamoDB on-demand (dev table) | DynamoDB on-demand (pilot table) |
| Identity | `CBA_WEB_AUTH=dev` (header/cookie/deterministic learner) — **local only** | Cognito (dev user pool) — `dev` mode must not exist in a deployed runtime | Cognito only — `x-cba-learner` and browser-supplied ids are never trusted |
| Deploy gate | none (no deploy) | GitHub `dev` Environment; OIDC deploy role | GitHub `pilot` Environment; required reviewer; explicit human gate |
| Data durability | disposable | disposable — may be wiped between iterations | durable; wipes require a human decision |
| Observability | console/dev output | CloudWatch logs + basic metrics | CloudWatch logs, metrics, alarms, and cost signals |
| Spend posture | zero cloud, zero AI spend | no-spend by default; AI only via the gated internal path | no-spend by default; AI only via the gated internal path |

**Reconciliation with older `dev/staging/prod` wording** (`github-security-and-oidc-baseline.md` §3,
`aws-iac-foundation.md`, `ci-cd-security-foundation.md`): **staging is deferred** — the MVP
progression is `local -> dev -> pilot`, where `pilot` takes the "protected, production-like" slot
that those docs call `staging`/`prod`. The `ai-batch` environment (manual token-spending jobs) is
unchanged. Environment-scoped roles/secrets described for `staging|prod` apply to `pilot` until a
real staging tier is justified.

**Preview policy (ephemeral vs. stable dev):** ephemeral Cloudflare previews validate **UI only**
and are never added to any BFF CORS allow-list — their per-change URLs would make an exact-origin
list unmanageable. Authenticated integration against the dev BFF happens through **one stable dev
URL**, which is the **single origin** allowed by the dev BFF. Previews must never point at pilot.

### Account and profile convention

- **One authorized AWS account** hosts the pilot — both the `dev` and `pilot` environments — for
  the MVP (single-account posture).
- Separation inside the account is by environment-suffixed resources per the
  [aws-iac-foundation.md](aws-iac-foundation.md) naming convention (`cba-study-coach-<env>-*`):
  **separate stacks, DynamoDB tables, Cognito user pools, and IAM roles per environment**.
- The **dev deploy/runtime roles must carry no permission over pilot resources** (resource scoping
  by environment-suffixed names/patterns).
- Local operator profiles are **machine-local** (`~/.aws/`), never versioned; no account id, ARN,
  or profile name belongs in tracked files.
- Multi-account separation (dev/pilot in different accounts under an Organization) is a
  **post-pilot evolution**, not an MVP requirement.

## 2. Runtime path (pilot topology)

```text
Browser
  └─> Cloudflare Workers (Next.js via OpenNext)          # learner surface only
        └─> API Gateway HTTP API                         # single browser-reachable backend origin
              └─> Lambda Web BFF (Node.js, repo JS conventions)
                    ├─> Cognito        (resolveLearner port — identity)
                    └─> DynamoDB       (SimulationRepository port — attempts/progress, on-demand)

AI Orchestration Service: internal only (ADR-0002). Reached through server-side use cases,
never from the browser or the BFF's public surface. Bedrock permissions stay isolated
(blueprint-refresh role + future AI service role only).
```

Decisions this contract fixes (previously left open by ADR-0002/#47):

- **BFF compute is API Gateway HTTP API + Lambda** (not App Runner): scale-to-zero fits the pilot
  cost posture, and the BFF is stateless request/response over the existing port boundaries.
- **Deployment shape is Option A** of #47: Cloudflare learner frontend + AWS BFF. The temporary
  "full-stack Next.js" Option B is rejected — it would put exam data and correction logic on the
  edge host, against ADR-0002's boundary.
- **Managed persistence is DynamoDB on-demand** behind the existing `SimulationRepository` port
  (`web/lib/repository.js`); the adapter arrives with #68 and must not change record semantics.
- The current Next.js app is **not** a pure static export (dynamic drill/mock/review routes);
  Cloudflare hosting goes through **OpenNext on Workers** (#67).

## 3. Configuration registry (by owner)

Names reuse what already exists in code/docs; only the minimum new names for #67–#69 are added.
Anything browser-visible is public by definition; nothing that can spend, read data, or mutate
state may live there (`github-security-and-oidc-baseline.md` §6).

### Browser-public (baked into the Cloudflare bundle — treat as disclosed)

| Name | Purpose | Introduced by |
| --- | --- | --- |
| `NEXT_PUBLIC_CBA_BFF_BASE_URL` | absolute base URL of the environment's BFF (API Gateway origin); locally unset → same-origin `/api` | #67 |

### Cloudflare runtime/deploy (GitHub Environment secrets — never AWS values)

| Name | Kind | Purpose |
| --- | --- | --- |
| Cloudflare API token | secret (GitHub `dev`/`pilot` Environment) | Workers deploy (#70); no AWS credential ever lives on Cloudflare |

### AWS BFF runtime (Lambda env / SSM by sensitivity)

| Name | Values | Purpose |
| --- | --- | --- |
| `CBA_WEB_AUTH` | `dev` \| `cognito` | existing identity port switch (`web/lib/identity.js`); `dev` is a **local-only** value |
| `CBA_WEB_STORE` | `memory` \| `file` \| `dynamodb` | existing repository switch; `memory`/`file` are **local-only** values; `dynamodb` arrives with #68 |
| `CBA_WEB_DATA_DIR` | path | file-store location (local only) |
| `CBA_WEB_TABLE` | table name | DynamoDB table for the environment (#68) |
| `CBA_WEB_ALLOWED_ORIGINS` | comma-separated exact origins | CORS allow-list (#69): in dev, exactly the **stable dev frontend URL**; in pilot, exactly the pilot origin. Ephemeral preview URLs are never listed. CORS is not auth — ownership checks remain in the BFF |
| `COGNITO_USER_POOL_ID`, `COGNITO_CLIENT_ID` | ids | Cognito adapter config (#69) — configuration, not secrets |

**Deployed-runtime rule (fail fast, no fallback):** in any deployed BFF (`dev` and `pilot`),
`CBA_WEB_AUTH` must be **explicitly** `cognito` and `CBA_WEB_STORE` **explicitly** `dynamodb`.
Missing configuration or a local-only value (`dev`, `memory`, `file`) must **fail startup/request
loudly — never fall back to a default**. Rationale: `CBA_WEB_AUTH=dev` trusts a client-supplied
header/cookie (`web/lib/identity.js`) and must not exist in a deployed Lambda. Enforcement lands
with #68/#69.

Sensitivity rule (`aws-iac-foundation.md`): plain config in SSM Parameter Store; anything secret
(e.g. a confidential Cognito client secret, if one is ever used) in Secrets Manager. No secret
values in tracked files, Lambda code, or workflow logs.

### GitHub deploy (Actions vars/secrets — registry in `github-security-and-oidc-baseline.md` §5)

| Name | Kind | Status |
| --- | --- | --- |
| `AWS_REGION` | var | exists (`us-east-1`) |
| `BEDROCK_MODEL_STANDARD` | var | exists (AI-only consumption) |
| `AWS_BEDROCK_REFRESH_ROLE_ARN` | secret | exists (blueprint refresh only) |
| `AWS_DEPLOY_ROLE_ARN` | secret, Environment-scoped (`dev`/`pilot`) | planned (#70) — OIDC deploy roles only, never long-lived keys |

### AI-only (internal; never reachable from BFF/browser config)

`LLM_BACKEND`, `BEDROCK_MODEL_STANDARD`, legacy `ANTHROPIC_API_KEY` — consumed by the internal
AI/blueprint tooling behind its own gates (`confirm_ai_spend`, `ai-batch`). The learner loop is
deterministic and requires none of them.

## 4. Local fallback and readiness checks (executable, no-spend)

**Local fallback (no cloud dependency):** `CBA_WEB_AUTH=dev` + `CBA_WEB_STORE=memory|file` runs the
full learner loop offline. These are **local-only** values — a deployed BFF must reject them
(deployed-runtime rule, §3). Deterministic smokes live in `web/scripts/` (blank-mock, review-coach,
identity, restart-persistence) against a local server (the scripts read `BASE`/`PORT`). This mode
must keep working after #67–#69 land — it is the contract-test target for the BFF extraction.

**Dev/pilot readiness (all read-only / no-spend):**

1. `npm run agent-check -- --json` and `npm run bedrock-check -- --json` — config-shape checks,
   no model call.
2. `cd infra/aws && npm test && npm run synth:quiet` — credential-free synth (Infra Synth lane).
3. Operator identity/entitlement checks per `aws-bootstrap-and-oidc.md` §6 (STS, model
   availability) — read-only CLI/MCP, no identifiers written to the repo.
4. `blueprint-refresh` with `confirm_ai_spend=false` — proves the spend gate skips before any role
   assumption.
5. After deploys exist (#70): deterministic `BASE_URL` smokes against the deployed BFF; paid AI
   smokes stay separate, manual, and human-gated.

## 5. Bootstrap sequence (#66 relationship)

Issue #66 executes, in the **authorized** pilot account, the runbook this contract assumes: CDK
bootstrap → SecurityStack only (`bedrock:InvokeModel` policy) → GitHub OIDC secret rewiring →
no-spend gate proof → separately-gated paid smoke. That evidence is the precondition for any dev
deploy: **#66 → dev stacks/adapters (#68, #69) + frontend (#67) → integrated gates (#70) → pilot
promotion.** Identity/Data/Api/AiOrchestration/Observability stacks stay placeholders until their
owning tasks; deploy roles arrive with #70 per the §5 registry.

## 6. What consuming tasks take from this contract

- **#67**: `NEXT_PUBLIC_CBA_BFF_BASE_URL`, preview→dev-BFF-only rule, OpenNext-on-Workers path,
  bundle guardrails (no bank data, no credentials).
- **#68**: API Gateway HTTP API + Lambda target, `CBA_WEB_STORE=dynamodb` + `CBA_WEB_TABLE`,
  contract-preserving extraction with local adapters still green.
- **#69**: Cognito behind `resolveLearner`, `COGNITO_*` config names, `CBA_WEB_ALLOWED_ORIGINS`
  exact-origin CORS ownership, dev-mode fallback separation.
- **#70**: environment/gate model (§1), deploy-role registry (§3), readiness/smoke ladder (§4).
