# Task: #54 Define AWS environment bootstrap and IAM/OIDC model

## Owner

- Agent: Claude (executor)
- Human gate: required before push

## Source of truth

- GitHub issue: #54 (part of #49/#47; implements the #52 GitHub-side OIDC contract)
- Design context: `docs/architecture/github-security-and-oidc-baseline.md` (#52),
  `docs/architecture/aws-iac-foundation.md` (#49), `docs/architecture/ci-cd-security-foundation.md`
- Live consumer: `.github/workflows/blueprint-refresh.yml` (assumes `AWS_BEDROCK_REFRESH_ROLE_ARN`)
- Code that determines the IAM scope: `src/infrastructure/bedrock/model-provider.js` (Converse API),
  `src/lib/model-config.js` (`BEDROCK_MODEL_STANDARD` = cross-region inference profile)

## Context

`infra/` does not exist yet and #53 (CDK scaffold) is still open, so #54 is a DEFINE task: the AWS
bootstrap + IAM/OIDC model + runbook that satisfies #52's contract, with copy-pasteable trust and
permission policy JSON. No CDK tree is started here (that is #53); no AWS resources are created; no
long-lived keys; no live Bedrock call by default.

Key technical facts pinned from the code:

- The Bedrock adapter calls **Converse** (`ConverseCommand`); AWS authorizes Converse with the
  `bedrock:InvokeModel` IAM action (non-streaming), so the role needs `bedrock:InvokeModel` only.
- `BEDROCK_MODEL_STANDARD` defaults to `us.anthropic.claude-sonnet-5`, a cross-region inference
  profile — the permission policy must grant the profile ARN **and** the routed foundation-model
  ARNs (enumerate with `aws bedrock get-inference-profile`), region-locked.

## Do

- `docs/architecture/aws-bootstrap-and-oidc.md` (new): OIDC provider definition; the blueprint
  refresh role (trust policy JSON scoped to repo + `main`, with the `environment:ai-batch` target;
  permission policy JSON for Converse→InvokeModel over the inference profile + routed models,
  region-locked); the GitHub vars/secrets to set (`AWS_REGION`, `BEDROCK_MODEL_STANDARD`,
  `AWS_BEDROCK_REFRESH_ROLE_ARN`); a bootstrap runbook; the CDK target for #49/#53 to lift; no-spend
  verification; non-goals + follow-ups.
- Cross-link from `aws-iac-foundation.md` (IAM/OIDC role model deliverable).

## Do not

- No CDK tree/app (that is #53); no AWS resource creation; no `aws`/`cdk` execution.
- No app deploy; no long-lived AWS keys; no live/paid Bedrock call by default.
- No editing the live `blueprint-refresh.yml` (the `environment: ai-batch` hardening is a documented
  follow-up); root `.gitignore` and the EVENTS.md audit untouched.
- No push without explicit human approval.

## Validation

- `npm run agent-refresh`; `npm test`; `npm run validate`; `git diff --check`
- JSON policy blocks parse; internal doc links resolve

## Work log

- Assumed by Claude (executor). Boot ok; main synced at `ae586ba`; no active handoffs. Read the #52
  baseline, the AWS IaC + CI/CD foundation docs, and the Bedrock adapter/model-config to pin the
  Converse→InvokeModel action and the cross-region inference-profile IAM requirement. Confirmed
  `infra/` absent and #53 open → this is a define/runbook task, not a CDK scaffold.

- Architect blocker fix (amended into the same commit): the OIDC provider creation command carried a
  placeholder `--thumbprint-list ffffffffffffffffffffffffffffffffffffffff` — fragile for a
  copy-paste runbook. Per the official AWS CLI/IAM docs, the flag is optional (IAM retrieves the
  thumbprint automatically; AWS validates the GitHub IdP against its trusted CA store, thumbprint is
  fallback). Removed the flag and replaced the note with "do not pass a thumbprint manually unless
  deliberately pinning real thumbprints for an operational requirement".

## Final report

- Status: **DONE**; awaiting human gate for push.
- Local commit: `docs: define AWS bootstrap and IAM/OIDC model for #54` (unpushed — resolve the
  current SHA with `git log --oneline origin/main..HEAD`).
- Deliverable: `docs/architecture/aws-bootstrap-and-oidc.md` — GitHub OIDC provider definition; the
  blueprint-refresh Bedrock role with copy-pasteable trust policy JSON (branch-scoped to `main` now;
  `environment:ai-batch` as the hardening target) and least-privilege permission policy JSON
  (`bedrock:InvokeModel` for Converse, over the inference profile + routed foundation-model ARNs,
  region-locked); the exact `get-inference-profile` enumeration step for the cross-region gotcha;
  the GitHub vars/secrets to set with `gh` commands; an 8-step bootstrap runbook; the CDK target for
  #49/#53; no-spend verification; non-goals + follow-ups. Cross-linked from `aws-iac-foundation.md`.
- Validation result: `agent-refresh` ok; `git diff --check` clean; `npm test` 69/69;
  `npm run validate` 60/0; policy JSON blocks structurally valid (one intentional jsonc fragment);
  internal links resolve.
- Push/CI status: **not pushed** — pending human gate.
- Remaining risks/follow-ups:
  - Define/runbook only — no AWS resources created, no CDK tree started (that is #53), no keys, no
    live Bedrock call. An operator runs the runbook to create the role and set
    `AWS_BEDROCK_REFRESH_ROLE_ARN`.
  - Cross-region inference-profile IAM: the routed foundation-model ARNs must be enumerated with
    `aws bedrock get-inference-profile` at bootstrap time (the repo's model ids are forward-looking
    defaults; confirm/pin them first). Granting only the profile ARN fails at invoke.
  - Corrects the #52 role-catalog wording: the adapter uses Converse (→ `bedrock:InvokeModel`,
    non-streaming), not raw InvokeModel with a stream action.
  - Hardening (trust → `environment:ai-batch`) needs the human to create the env + a one-line
    `blueprint-refresh.yml` change — deliberately not done here (no live-workflow edit in a define
    task).
  - Working-tree residue unrelated to #54 (kept out of this commit): the `EVENTS.md` audit and the
    one-line `done/52` nit fix — both fold into the next governance cleanup.
