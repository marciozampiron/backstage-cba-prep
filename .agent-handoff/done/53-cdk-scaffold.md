# Task: #53 Scaffold AWS CDK app with synth-only validation

## Owner

- Agent: Claude (executor)
- Human gate: required before push

## Source of truth

- GitHub issue: #53 (part of #49; encodes the #54 IAM/OIDC model)
- Design: `docs/architecture/aws-bootstrap-and-oidc.md` (#54 — the policies to encode),
  `docs/architecture/aws-iac-foundation.md` (#49 — structure/conventions),
  `docs/architecture/github-security-and-oidc-baseline.md` (#52), ADR-0003

## Context

First IaC increment: the CDK v2 app under `infra/aws/` with the initial security stack that
represents the #54 model, validated by `cdk synth` only — no deploy, no AWS/Bedrock live calls, no
credentials needed (env-agnostic stack, pseudo-params for account/region, no real account id
committed).

Language decision: **plain JavaScript (CommonJS)**, matching the CDK official JS template style —
zero build step (no tsc/tsconfig), consistent with the repo's JS idiom and the architect's
"avoid unnecessary complexity" guidance. The one "TypeScript" line in `aws-iac-foundation.md` is
amended to record this.

## Do

- `infra/aws/`: `bin/cba-pilot.js` (app), `lib/security-stack.js` (OIDC provider create-or-import
  via context; role `cba-study-coach-gha-bedrock-refresh` with repo/main WebIdentity trust;
  `bedrock:InvokeModel` on the inference-profile ARN [pseudo account/region] + routed model ARNs,
  all parameterized via CDK context; role-ARN CfnOutput; foundation tags), `cdk.json`,
  `package.json` + lockfile, `.gitignore` (node_modules, cdk.out), `README.md`.
- Local `npm ci && npm run synth` proving credential-free synth + template assertions (role name,
  action, trust sub present in cdk.out).
- `.github/workflows/infra-synth.yml`: path-filtered `infra/aws/**` + itself, `contents: read`,
  Node 22, npm ci + synth + template sanity grep. No AWS creds (per the #52 catalog: synth lane
  needs none).
- Update the lanes table in `ci-cd-security-foundation.md` with the Infra Synth check name; amend
  the TS line in `aws-iac-foundation.md`.

## Do not

- No `cdk deploy`/`cdk diff` in CI; no AWS resource creation; no live Bedrock; no credentials.
- No real account id/secrets committed (pseudo-params + context placeholders only).
- Root `.gitignore` and the EVENTS.md/done-52 residues untouched; no push without human gate.

## Validation

- `npm run agent-refresh`; root `npm test`; root `npm run validate`; `git diff --check`
- `cd infra/aws && npm ci && npm run synth`; template assertions; workflow YAML parse

## Work log

- Assumed by Claude (executor). Boot ok; main synced at `3271c78`; no active handoffs. Node 22.
- Scaffolded `infra/aws/` in plain JavaScript/CommonJS (CDK JS template style — decision recorded
  in `aws-iac-foundation.md`, superseding its TypeScript line): `bin/cba-pilot.js` (env-agnostic
  app — synth needs no credentials), `lib/security-stack.js` (create-or-import GitHub OIDC provider
  via `githubOidcProviderArn` context, no manual thumbprints; role
  `cba-study-coach-gha-bedrock-refresh` with WebIdentity trust on `aud` + `sub`
  `repo:.../ref:refs/heads/main` [context-switchable to `environment:ai-batch`];
  `bedrock:InvokeModel` over the inference-profile ARN built from pseudo account/region + routed
  model ARNs from context with documented placeholders; foundation tags; CfnOutputs for the role
  and provider ARNs), `cdk.json` (+ `checkSecretUsage`/`minimizePolicies` flags), package.json +
  lockfile, `.gitignore` (node_modules/cdk.out), README with the context-parameter table.
- `.github/workflows/infra-synth.yml`: path-filtered `infra/aws/**` + itself, `contents: read`,
  Node 22, `npm ci` → `synth:quiet` → template assertions (role name, `bedrock:InvokeModel`, trust
  sub, OIDC host present; **fails if any literal 12-digit account id appears** — pseudo-param
  guard). Fixed during verification: the cdk.out template is named by artifact id
  (`SecurityStack.template.json`), not `stackName`.
- Docs: Infra Synth row added to the lanes table in `ci-cd-security-foundation.md`; JS-not-TS
  decision note in `aws-iac-foundation.md`.
- Verified locally: `npm ci` + `npm run synth:quiet` credential-free; the exact CI assertion step
  passes; no node_modules/cdk.out staged; workflow YAML parses.
- Architect review pass (amended into the same commit) — two findings:
  - **Blocking bug:** `bedrockRoutedModelArns` via `-c` arrives as a STRING; `...routedModelArns`
    spread it character-by-character into the IAM policy Resource (reproduced: 25 char entries).
    Fixed with `lib/context.js` `parseArnList` (array passthrough / JSON-string parse / validate a
    non-empty ARN-string array / throw a clear synth error). Added `test/context.test.js` (6 unit
    tests) and a CI regression step that synths with a JSON-array override and asserts the Resource
    is a proper 2-ARN list. README override example corrected to `-c 'bedrockRoutedModelArns=[...]'`.
  - **Scope:** #53 literally asks for TS + placeholder stacks for identity/data/api/ai-orchestration/
    observability. Added all five placeholder stacks (shared `PlaceholderStack` base: foundation
    tags + one SSM scaffold marker so templates are non-empty/deploy-valid/self-documenting;
    per-domain subclasses documenting the owning track); the app now synths 6 stacks. Kept
    **JavaScript** as an explicit, blessed owner decision (the session brief allows JS and says
    avoid unnecessary complexity — TS would force a tsc/ts-node build step in synth/CI; the
    `aws-iac-foundation.md` line is already amended to record this).
  - Decoupling: root `npm test` (`node --test` discovery) started absorbing the infra tests (69→75).
    Scoped root to `node --test 'test/**/*.test.js'` (all root CLI tests live in `test/`) so the
    root Quality lane stays CLI/core-only and infra tests run in the Infra Synth lane — also
    prevents a future infra CDK-importing test from breaking root (CDK is not a root dependency).
  - Re-verified: infra `npm test` 6/6; 6-stack synth; template + override assertions pass; root
    `npm test` back to 69/69; validate 60/0; diff --check clean; YAML valid.

## Final report

- Status: **DONE**; awaiting human gate for push.
- Local commit: `feat: scaffold AWS CDK app with synth-only validation for #53` (unpushed — resolve
  the current SHA with `git log --oneline origin/main..HEAD`).
- Validation result: `agent-refresh` ok; root `npm test` 69/69; `npm run validate` 60/0;
  `git diff --check` clean; local synth + template assertions pass; workflow YAML valid.
- Push/CI status: **not pushed** — pending human gate. The push of this commit is the first real
  run of the `Infra Synth` lane (the workflow file is in its own path filter).
- Remaining risks/follow-ups:
  - `bedrockRoutedModelArns` defaults are documented placeholders — enumerate the real ARNs with
    `aws bedrock get-inference-profile` and pass via context at deploy time (#54 runbook).
  - Synth prints an informational "feature flags not configured" notice (new-in-CLI flags) —
    harmless; pin flags later if the app grows.
  - Deploy lanes/roles, other stacks, and bootstrap execution remain with #46/#49/#54-runbook.
  - Working-tree residues kept out (EVENTS.md audit + done/52 nit) — next governance cleanup.
