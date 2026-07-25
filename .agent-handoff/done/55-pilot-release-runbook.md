# Task: define pilot release runbook, smoke gates, and rollback policy (#55)

## Owner

- Agent: Claude (executor)
- Architect/reviewer: Codex
- Human gate: required before push

## Source of truth

- GitHub issue: #55 (part of #50; feeds the #56 workflow design and the #70 implementation)
- Environment model: `docs/architecture/pilot-environment-contract.md` (#47) — `local -> dev ->
  pilot`, staging deferred (the issue's "staging/production" wording maps to dev/pilot)
- CI/security posture: `ci-cd-security-foundation.md`, `github-security-and-oidc-baseline.md`

## Scope

Docs-only: one concise runbook under `docs/architecture/` covering manual release gate flow,
promotion rules, pre/post-deploy checks, the `BASE_URL` smoke plan, rollback for Cloudflare
frontend / AWS BFF / data, release notes/tag expectations, incident notes, and the owner
checklist. Acceptance: a human can decide go/no-go from the runbook alone; post-deploy smoke
spends no model tokens by default.

## Work log

- (in progress)
- Authored `docs/architecture/pilot-release-runbook.md` (145 lines): manual release-gate flow
  (EVENTS.md release entry, dev deploy, pilot promotion via the `pilot` Environment reviewer
  reusing dev-proven artifacts); go/no-go checklist decidable by a human alone; promotion table;
  deterministic `BASE_URL` smoke plan mapping the four real `web/scripts/` smokes as ordered
  release gates (zero model tokens by default; AI smokes never a release gate); rollback policy —
  Cloudflare (previous deployment re-activation), AWS BFF (redeploy previous good SHA through the
  gated lane), data (DynamoDB additive-only schema policy; PITR restore as its own human-gated
  last resort); `pilot-vN` tag + release-note expectations (logical names only, no identifiers);
  incident notes + single human release owner. Staging-deferred wording reconciled to the #47
  contract (issue's "staging/production" == dev/pilot).
- Pointer added to `docs/wiki/Delivery-Process.md` (Pilot CI/CD Posture).
- Validated: all relative links resolve; MD018/invisible chars 0; root 77/77; validate 60/0;
  `git diff --check` clean; zero ids/secrets. Local commit created (`docs:` message referencing
  #55) — NOT pushed; SHA via `git log --oneline origin/main..HEAD`. Awaiting Codex review.
- Codex review (3 blocking findings) fixed, amended into the same commit:
  (1) §3 split honestly — 3.1 = the four existing `web/scripts/` smokes documented as LOCAL-ONLY
  pre-release regression gates (restart-persistence hardcodes localhost/file store; identity is
  dev-mode, incompatible with Cognito), 3.2 = the deployed gates as a #56/#70 requirements
  contract with `BASE_URL` (BFF) vs `FRONTEND_URL` (health/UI only) separation, a dedicated
  Cognito test learner + cleanup, and a DynamoDB persistence smoke;
  (2) the mock exam-mode leak scan (pre-submit payloads free of correctOption/explanation/
  isCorrect/sources) is registered as a NEW #56 requirement — explicitly NOT existing evidence
  (smoke-review-coach only checks drill missed-review);
  (3) §4.3 PITR rewritten as a full cutover procedure: restore to a NEW named table -> wait
  ACTIVE -> re-apply PITR/TTL/tags/streams/alarms (not restored) -> validate data -> switch
  `CBA_WEB_TABLE` via gated deploy -> run §3.2 gates -> preserve the old table until an explicit
  human decision. §4.1/§4.2 verify lines now target FRONTEND_URL/BASE_URL respectively.
  Revalidated: 77/77, 60/0, diff-check clean, MD018 0, secrets 0. New SHA via git log.
- Final Codex finding fixed (PITR cutover completeness), amended into the same commit: step 2 now
  includes deletion protection and every IAM permission naming the table ARN among the
  not-restored settings (the least-privilege BFF role is scoped to the ORIGINAL table ARN); step 4
  makes the gated cutover deploy update BOTH `CBA_WEB_TABLE` AND the BFF role's IAM policy
  together (variable-only change => AccessDenied); new step 5 requires a reviewed `cdk diff` with
  no wildcard before the cutover; steps renumbered (preserve-old-table is now step 7).
  Revalidated: 77/77, 60/0, diff-check clean, MD018 0, secrets 0.

## Final report

- Status: **DONE** — pushed as `cde0c8c` (only commit in scope); CI green (Quality 30168534145,
  CodeQL 30168533986; Web Quality/Infra Synth correctly not triggered — docs-only). #55 CLOSED
  with delivery evidence; board: Done (GraphQL-confirmed).
- Files: `docs/architecture/pilot-release-runbook.md` (new, 192 lines) +
  `docs/wiki/Delivery-Process.md` pointer.
- All four Codex review cycles folded in (local-vs-deployed smoke split, BASE_URL/FRONTEND_URL,
  #56 leak-scan requirement, complete PITR cutover with joint table+IAM update).
- Follow-ups owned elsewhere: #56 (workflow design implementing these policies — NEXT), #70
  (implementation), key rotation + SSO-first migration (human), `.vscode/settings.json` inclusion
  in a future gated commit (classified portable).
- Push/CI recorded in EVENTS.md; residue stays for the next governance cleanup.
