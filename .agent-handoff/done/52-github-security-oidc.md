# Task: #52 Define GitHub security baseline and AWS OIDC roles

## Owner

- Agent: Claude (executor)
- Human gate: required before push

## Source of truth

- GitHub issue: #52 (part of #48; related to #49/#54)
- Design context: `docs/architecture/ci-cd-security-foundation.md` (#48),
  `docs/architecture/aws-iac-foundation.md` (#49), ADR-0002, ADR-0003
- Implemented lanes: `.github/workflows/quality.yml`, `web-quality.yml`, CodeQL default setup,
  `blueprint-refresh.yml` (already Bedrock/OIDC via `AWS_BEDROCK_REFRESH_ROLE_ARN`)

## Context

Documentation/design task: define the repo's GitHub security baseline + the AWS OIDC role catalog
(trust boundaries, per-workflow roles, vars/secrets registry) that #54 implements on the AWS side
and #49 materializes in CDK. No deploy, no AWS resources, no live AI. Branch protection is
DOCUMENTED here, not applied (applying it mutates repo governance — human/follow-up owns that).

## Do

- `docs/architecture/github-security-and-oidc-baseline.md` (new): branch protection checklist for
  `main` (concrete required-check names from #51 + the Web Quality path-filter strategy), Actions
  permissions model, GitHub Environments, AWS OIDC role catalog + trust-boundary anatomy (incl. the
  live `AWS_BEDROCK_REFRESH_ROLE_ARN` role), vars/secrets registry (`AWS_REGION`,
  `BEDROCK_MODEL_STANDARD`, role-ARN secrets), no-long-lived-keys policy, secret hygiene, Dependabot/
  scanning posture, and how it unblocks #48/#49/#54.
- Cross-link the new doc from `ci-cd-security-foundation.md`.
- Fix `SECURITY.md` (currently the broken GitHub default template) into a real reporting policy that
  points at the baseline — judgment call, flagged in the report.

## Do not

- Do not apply branch protection, create OIDC providers/roles, or touch AWS.
- Do not implement deploy; no live AI/model calls; no secrets committed.
- No product code changes; root `.gitignore` and the EVENTS.md local audit untouched.
- No push without explicit human approval.

## Validation

- `npm run agent-refresh`; `npm test`; `npm run validate`; `git diff --check`
- markdown link sanity on the new doc (internal refs resolve)

## Work log

- Assumed by Claude (executor). Boot ok; main synced at `962218c`; no active handoffs. Read #52 +
  the CI/CD and AWS IaC foundation docs; confirmed the #52 (GitHub contract) vs #54 (AWS impl)
  boundary.
- Wrote `docs/architecture/github-security-and-oidc-baseline.md` (8 sections): branch-protection
  checklist for `main` with the exact required-check names from #51 and a Web Quality path-filter
  strategy (Option A require-root+CodeQL / Option B always-run-with-internal-gate; explicit "do not
  mark the current path-filtered lane required"); least-privilege Actions permissions model +
  exceptions catalog; GitHub Environments (dev/staging/prod/ai-batch); AWS OIDC role model
  (no-long-lived-keys, trust-boundary anatomy with `aud`/`sub` scoping, a role catalog incl. the
  live `AWS_BEDROCK_REFRESH_ROLE_ARN` Bedrock role + planned deploy/synth roles, Bedrock isolation);
  vars/secrets registry (`AWS_REGION`, `BEDROCK_MODEL_STANDARD` as vars; role ARNs as secrets;
  `ANTHROPIC_API_KEY` now unused); secret hygiene + frontend-public rule; Dependabot/CodeQL/secret-
  scanning posture (incl. the known postcss follow-up; no `npm audit` CI gate); and the
  #48/#49/#54 unblock mapping + non-goals + follow-ups.
- Cross-linked the new doc from `ci-cd-security-foundation.md` (Security Baseline section).
- Replaced `SECURITY.md` (was the broken GitHub default template — nonexistent "5.1.x/4.0.x"
  version table) with a real private-vuln-reporting policy + pointers to the baseline docs. Judgment
  call (SECURITY.md not named in the #52 scope, but #48 flagged it and it was actively wrong).
- Moved this handoff `active/` → `done/`.

## Final report

- Status: **DONE**; awaiting human gate for push.
- Local commit: `docs: define GitHub security baseline and AWS OIDC roles for #52` (unpushed —
  resolve the current SHA with `git log --oneline origin/main..HEAD`).
- Validation result: `agent-refresh` ok; `git diff --check` clean; `npm test` 69/69;
  `npm run validate` 60/0; internal doc/SECURITY.md links resolve.
- Push/CI status: **not pushed** — pending human gate.
- Remaining risks/follow-ups:
  - Design only — branch protection, Environments, the OIDC provider, and the roles are NOT applied
    (documented for a human/follow-up; #54 owns the AWS-side implementation).
  - Do not mark the current path-filtered `Web Quality` as a required check without the Option B
    refactor, or non-web PRs deadlock.
  - `SECURITY.md` replacement is a judgment call outside the literal #52 scope — architect may veto.
  - Follow-ups listed in the doc: apply the ruleset, create the roles (#54), refactor Web Quality
    if it must be required, merge the Dependabot postcss fix, drop `ANTHROPIC_API_KEY` if unused.
