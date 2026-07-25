# Task: consolidate the AWS pilot environment foundation (#47)

## Owner

- Agent: unassigned executor
- Architect/reviewer: Codex
- Human gate: required before push

## Source of truth

- GitHub issue: #47
- Project: Phase 1 / In Progress
- Parent architecture: ADR-0002, #33
- Unblocks: #66, #67, #68, #69, #70

## Context

An architecture audit found that the accepted ADR, IaC foundation, security/OIDC baseline, diagrams,
and BFF contracts already cover most of #47. Do not write another broad architecture document.
Produce a concise canonical environment contract that resolves the remaining implementation choices
and links to the existing sources.

## Decisions already made

- Environment progression: `local -> dev -> pilot`.
- Cloudflare preview is an ephemeral frontend target and points only to an approved dev BFF.
- Learner frontend: Next.js on Cloudflare Workers through OpenNext.
- Browser backend entry: API Gateway HTTP API.
- Web BFF compute: AWS Lambda using the repository's JavaScript/Node conventions.
- Managed learner persistence: DynamoDB on-demand behind the existing repository port.
- Identity: Cognito behind `resolveLearner(request)`.
- Runtime configuration/secrets: SSM Parameter Store or Secrets Manager according to sensitivity.
- Logs, metrics, alarms, and cost signals: CloudWatch.
- Deploy identity: GitHub OIDC roles only; no long-lived AWS keys.
- AI remains internal and separately gated; default environment/readiness paths are no-spend.

## Available local MCP tooling

- `github`: read repository, Issues, Project state, checks, and delivery evidence. GitHub remains the
  roadmap source of truth; MCP access never grants push permission.
- `aws-mcp`: read-only infrastructure/configuration diagnostics through the dedicated one-hour role.
  Model invocation, secrets, application-data reads, and deploy mutations are denied. Never use it
  to validate CBA exam facts.
- `cloudflare-docs`: implementation research for Workers/OpenNext and Cloudflare configuration.
- `cloudflare-api`: authenticated IDE OAuth access. #47 is docs-only, so do not mutate resources.
- `stitch`: inspect the accepted UI prototype when product context is needed; do not regenerate it.
- `next-devtools` (`0.4.0`): runtime diagnostics when `web/` is running; optional for this docs task.
- All MCP configuration is local/gitignored. Never copy tokens, headers, account IDs, ARNs, or MCP
  configuration into tracked files or reports.

MCP availability does not change issue scope, DDD boundaries, spend gates, or the human push gate.

## Do

- Add one concise canonical document under `docs/architecture/` for the pilot environment contract.
- Define `local`, `dev`, and `pilot`, including ownership, persistence, auth, deploy gate, data
  durability, observability, and spend posture.
- Reconcile the older `dev/staging/prod` wording: staging is deferred; `pilot` is the protected
  production-like MVP environment.
- Map the runtime path: Cloudflare/OpenNext -> API Gateway HTTP API -> Lambda BFF -> Cognito/DynamoDB;
  AI Orchestration remains internal.
- Define a configuration registry by owner: browser-public, Cloudflare runtime/deploy, AWS BFF
  runtime, GitHub deploy, and AI-only. Reuse existing environment variable names from code/docs where
  they exist; introduce the smallest explicit set needed by #67-#69.
- State local fallbacks (`CBA_WEB_AUTH=dev`, memory/file repository, no cloud dependency) and dev/pilot
  readiness checks.
- Add short pointers from the architecture wiki/index and relevant existing foundation docs.
- Update the #47 handoff with files, validation, residual risks, and close recommendation.

## Do not

- Do not change ADR-0002's Cloudflare/AWS split or the DDD boundaries.
- Do not deploy or mutate AWS/Cloudflare/GitHub configuration.
- Do not call Bedrock or any paid service.
- Do not add credentials, account IDs, ARNs, endpoints containing identifiers, or secret values.
- Do not implement CDK, Lambda, DynamoDB, Cognito, OpenNext, or workflows in this issue.
- Do not modify CBA question facts, the question bank, or learner contract semantics.
- Do not push without explicit human approval.

## Acceptance focus

- #67 can identify its public BFF configuration and preview/dev mapping.
- #68 has a fixed API Gateway HTTP API + Lambda + DynamoDB target.
- #69 has a fixed Cognito/session/config boundary and exact-origin CORS ownership.
- #66 has an explicit relationship to the dev/pilot bootstrap sequence.
- No-spend readiness and local fallback are executable, not aspirational.
- Existing docs are linked and reconciled rather than duplicated.

## Validation

- `npm run agent-refresh`
- `git diff --check`
- `npm test`
- `node bin/cli.js validate`
- link/reference review for every changed Markdown file
- confirm no account ID, ARN, credential, token, or secret value entered the diff

## Delivery

- Commit locally with a `docs:` message referencing #47.
- Do not push.
- Report the commit, changed files, decisions, validation, and whether #47 can close after CI.

## Work log (Claude, executor)

- Boot: AGENTS.md, handoff README/CURRENT/COMMANDS, this brief, issue #47 (+ #66-#70 bodies for
  acceptance alignment). `agent-refresh` ok; main == origin/main; no competing active handoff.
- Surveyed the sources to reconcile: ADR-0002 (split accepted; Lambda-vs-App-Runner deferred),
  `aws-iac-foundation.md` + `github-security-and-oidc-baseline.md` + `ci-cd-security-foundation.md`
  (older `dev/staging/prod` wording), `web-bff-contracts.md`, and the real env var names in code
  (`CBA_WEB_AUTH/STORE/DATA_DIR`, smoke `BASE`/`PORT`, AI-side `LLM_BACKEND` etc.).
- Authored `docs/architecture/pilot-environment-contract.md` — concise canonical contract:
  sources table (links, no duplication); region default; `local/dev/pilot` matrix (ownership,
  persistence, auth, deploy gate, durability, observability, spend); staging-deferred
  reconciliation; runtime path fixing API GW HTTP API + Lambda (records the ADR-0002 open point),
  Option A shape, DynamoDB behind the existing repository port, OpenNext-on-Workers;
  configuration registry by owner reusing existing names + smallest new set
  (`NEXT_PUBLIC_CBA_BFF_BASE_URL`, `CBA_WEB_TABLE`, `CBA_WEB_ALLOWED_ORIGINS`, `COGNITO_*`,
  `CBA_WEB_STORE=dynamodb` value); executable local fallback + no-spend readiness ladder;
  #66 bootstrap sequencing; per-issue consumption map (#67-#70).
- Pointers added (one short block each): `docs/wiki/Architecture.md` (Runtime Split),
  `docs/architecture/aws-iac-foundation.md` (Environment Model), and
  `docs/architecture/github-security-and-oidc-baseline.md` (§3) — allowed here because #47 is an
  assigned foundation-track task.
- MCPs: not needed for this docs-only consolidation (all inputs local); no AWS/Cloudflare/GitHub
  mutation, no model call, no paid operation.
- No account id, ARN, credential, token, or secret value entered the diff (verified by grep).

## Final report

- Issue: #47 — docs-only consolidation. Owner: Claude (executor); reviewer: Codex.
- Files changed: `docs/architecture/pilot-environment-contract.md` (new),
  `docs/architecture/aws-iac-foundation.md`, `docs/architecture/github-security-and-oidc-baseline.md`,
  `docs/wiki/Architecture.md` (pointers), this handoff moved inbox -> active -> done.
- Validation: `agent-refresh` ok; `git diff --check` clean; root `npm test` green;
  `node bin/cli.js validate` green; every relative link target verified to exist; secret/identifier
  grep clean. (Exact outputs in the chat report.)
- Commit: local `docs:` commit referencing #47 — SHA reported in chat; NOT pushed (human gate).
- Residual risks / follow-ups: (1) `staging` wording in the three older foundation docs is
  reconciled by pointer, not rewritten — full rewording only if a staging tier is ever introduced;
  (2) `CBA_WEB_STORE=dynamodb`, `CBA_WEB_TABLE`, `CBA_WEB_ALLOWED_ORIGINS`, `COGNITO_*` are
  contract names — implementation lands with #68/#69 and must not drift from this doc;
  (3) smoke scripts read `BASE` today; #70 may standardize `BASE_URL` — cosmetic, tracked there;
  (4) EVENTS.md/CURRENT.md remain uncommitted local residue for the next governance cleanup.
- Close recommendation: #47 can close after Codex review + human-gated push + CI green
  (docs-only: Quality/CodeQL; Web Quality and Infra Synth will not trigger).

## Codex review fixes (amended into the same commit)

- **High — dev mode in deployed runtimes:** the matrix allowed `CBA_WEB_AUTH=dev` for smokes in
  deployed dev, but that mode trusts a client-supplied header/cookie. Fixed: `dev` is local-only;
  added the **deployed-runtime rule** — deployed BFFs must set `CBA_WEB_AUTH=cognito` and
  `CBA_WEB_STORE=dynamodb` **explicitly**, and missing/local-only values fail loudly (no default
  fallback). Enforcement lands with #68/#69.
- **Medium — account/profile convention:** added to §1 — one authorized AWS account for the MVP;
  dev/pilot separated by environment-suffixed stacks/tables/user pools/roles; dev roles carry no
  permission over pilot resources; operator profiles are machine-local and never versioned;
  multi-account is a post-pilot evolution.
- **Medium — ephemeral preview vs exact-origin CORS:** added the preview policy — ephemeral
  previews validate UI only and are never allow-listed; authenticated integration uses one stable
  dev URL, the single origin in the dev BFF allow-list; previews never point at pilot.
- **Low — MD018:** lines starting with `#66...` reworded to `Issues #66...` / `Issue #66...`;
  also removed a stray soft-hyphen introduced during the fix.
