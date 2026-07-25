# Task: fix blueprint-refresh PR finalizer (no-diff success + credential collision) (#73)

## Owner

- Agent: Claude (executor)
- Architect/reviewer: Codex
- Human gate: required before push; no paid Bedrock call in this task

## Source of truth

- GitHub issue: #73 (Phase 0 / Todo -> In Progress; related #66/#72 — Stage C evidence is COMPLETE)
- File owned: `.github/workflows/blueprint-refresh.yml` only

## Scope (from the issue)

- No-diff path = explicit success; PR action must not run when nothing changed.
- Remove the checkout/PR-action credential collision (`persist-credentials: false`).
- Upgrade `peter-evans/create-pull-request` v6 (Node20 major) -> current supported major
  (verified upstream: **v8**, latest v8.1.1, 2026-04).
- Preserve the manual AI-spend gate, OIDC-only AWS auth, least privilege, secret masking.
- Validate the PR path with a no-spend synthetic change — never spend Bedrock tokens on plumbing.

## Do not

- No model config, IAM, CDK stacks, AWS vars/secrets, or CBA content changes.
- No paid Bedrock smoke; no push without human gate.

## Work log

- (in progress)
- Verified upstream: latest supported major is v8 (v8.1.1, 2026-04-10) via the GitHub API.
- Rewrote `.github/workflows/blueprint-refresh.yml`:
  - `actions/checkout@v7` now uses `persist-credentials: false` (removes the duplicate
    Authorization header collision with the PR action's own token).
  - New `Detect a tracked change` step: `changed=true/false` output; no-diff prints an explicit
    "✓ No domain change — refresh completed successfully; no PR needed." and the job SUCCEEDS.
  - PR step (`peter-evans/create-pull-request@v6` -> `@v8`) now runs ONLY when `changed == 'true'`.
  - New `pr_plumbing_test` input: skips ALL AWS/Bedrock steps, writes a synthetic
    `.github/blueprint-refresh-selftest.txt`, and exercises the real PR finalizer on a separate
    `chore/blueprint-refresh-selftest` branch (self-labeled "close me") — zero spend, zero AWS.
  - Spend gate, OIDC-only auth, least-privilege permissions, and secret masking unchanged.
- Scenario matrix: paid+diff -> PR; paid+no-diff -> explicit success, no PR; no-spend -> everything
  skipped (unchanged); plumbing test -> synthetic diff + PR path only.
- Validated: YAML parses; root 70/70; validate 60/0; `git diff --check` clean; zero secret/id in
  the diff. YAML nested-mapping lint errors on the conditional title/commit-message fixed by
  double-quoting the expressions.
- Local commit created; NOT pushed (human gate). The live plumbing-test run (creates a real
  self-test PR) is a workflow execution — left for after review/push, human-gated.
- Codex review (blocking): static assertions were missing. Added
  `test/blueprint-refresh-workflow.test.js` (7 dependency-free tests over the raw YAML, runs on
  both Node majors in the root Quality lane): persist-credentials false; plumbing sets skip=true
  (+plumbing=true); AWS/install/generation/bank-check all gated on skip != 'true' with NO plumbing
  escape; PR requires diff.changed == 'true'; no-diff is an explicit success; the plumbing test's
  only redirect target is the synthetic self-test file; action pinned to create-pull-request@v8
  with the v6 pin gone. Amended into the same commit — root suite now 77/77; validate 60/0;
  diff --check clean; YAML OK; zero secrets. New SHA via `git log --oneline origin/main..HEAD`.
- Pushed (human gate) as `9194039`; CI green (Quality 30151978004 with 77/77 on both Node majors,
  CodeQL 30151977811).
- Live self-test (human gate, single run 30152082269, `confirm_ai_spend=false` +
  `pr_plumbing_test=true`) — STOPPED on a NEW, different blocker; no retry:
  - Everything the #73 patch owns WORKED: gate ✓ (all AWS/Bedrock steps skipped — zero AWS calls);
    synthetic ✓; detect ✓ (changed=true); the action committed and pushed the branch cleanly —
    NO duplicate Authorization header (original bug PROVEN FIXED at the git layer).
  - Branch content verified via compare API: exactly 1 commit, 1 file —
    `.github/blueprint-refresh-selftest.txt` only (synthetic isolation proven).
  - FAILED at PR creation: "GitHub Actions is not permitted to create or approve pull requests".
    Root cause CONFIRMED read-only: repo setting `can_approve_pull_request_reviews: false`
    (Settings -> Actions -> General). A pre-existing repo-governance gap — even the original v6
    workflow would have hit it after the header fix. Not a workflow bug; no code change needed.
  - State: self-test branch exists on the remote with only the synthetic commit; NO PR was created
    (nothing to close yet). Branch left in place for the gated retry (force-with-lease reuses it).
  - REQUIRED (human/gated): enable the setting (console, or gated
    `gh api -X PUT .../actions/permissions/workflow` with can_approve_pull_request_reviews=true),
    then ONE gated re-run of the self-test; on PR creation: validate -> close without merge ->
    delete branch -> close #73.
- GitHub config gate EXECUTED (human-gated, API mutation only): repo Actions workflow permissions —
  before: default read + can_approve_pull_request_reviews=false; PUT applied changing ONLY
  can_approve_pull_request_reviews -> true (default stays read); after-GET confirmed
  {read, true}. No workflow run, no AWS/Bedrock, no push/commit/merge, no branch-protection or
  other setting touched. Awaiting the next gate: ONE pr_plumbing_test re-run.

## Final report

- Status: **DONE** — #73 CLOSED with evidence; board: Done (automation confirmed via GraphQL).
- Final live proof (single gated run 30167253172, `confirm_ai_spend=false` + `pr_plumbing_test=true`):
  workflow SUCCESS; Configure-AWS-credentials/npm-ci/generation/bank-validation all SKIPPED (the
  credentials step never ran, so zero AWS/Bedrock calls were possible); synthetic + detect green;
  **PR #74 created with NO Authorization error**, containing exactly
  `.github/blueprint-refresh-selftest.txt`; PR closed WITHOUT merge; branch
  `chore/blueprint-refresh-selftest` deleted (404-confirmed).
- Published commit: `9194039` (workflow fix + 7-test static invariant suite), CI green.
- Repo-config prerequisite handled in its own gate: `can_approve_pull_request_reviews=true`
  (default workflow permissions stayed `read`).
- Guardrails: exactly one execution; no merge; no code push/commit in this stage; no
  workflow/branch-protection/other-setting change; no retry needed.
- Residue: EVENTS.md/CURRENT.md + this handoff move — next governance cleanup.
