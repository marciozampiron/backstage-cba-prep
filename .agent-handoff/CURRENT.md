# Current Agent Coordination State

Last updated: 2026-07-25 (governance cleanup)
Updated by: Claude

This file is the fast boot context for agents entering the repository. GitHub Issues and the
Project board remain the source of truth; this file summarizes local coordination state.

## Current baseline

- `origin/main` is the published baseline. Use `git rev-parse --short origin/main` or `git log -1 --oneline origin/main` for the exact current SHA. Do not pin a specific origin/main SHA here — it goes stale on every push.
- Local `main` should match `origin/main` (no unpublished commits). Run `git log --oneline origin/main..HEAD` to confirm; do not rely on `CURRENT.md` for mutable unpublished commit SHAs.
- #34 architecture diagrams are the accepted AWS roadmap diagram version unless a new handoff explicitly reopens them.
- Do not rework architecture diagrams from older commits such as `06f1141`; that context is stale.

## Active priority

- Delivered and closed with CI green: architecture foundations #22/#33, Phase 1 design
  (#37/#34/#35/#36/#16/#15/#38), the #11 Web MVP slices 1–4b (#39/#40/#41/#42/#43), the adaptive AI
  study strategy spec, and the #48/#49 CI/security/IaC foundation (#51 quality lanes, #52
  GitHub/OIDC baseline, #54 AWS bootstrap+IAM/OIDC model, #53 CDK scaffold). `main` should be in sync
  with `origin/main` (ahead 0).
- Three CI lanes are live and proven: `Quality` (Node 20+22), `Web Quality` (path-filtered
  `web/**`/`questions/**`/`spec/blueprint.json`), `Infra Synth` (path-filtered `infra/aws/**`,
  credential-free `cdk synth`), all no-spend + least-privilege, plus CodeQL.
- `web/` = self-contained Next.js MVP (slices 1–4b) with smokes under `web/scripts/`.
  `infra/aws/` = CDK v2 app (JS/CommonJS) — the SecurityStack (#54 OIDC/Bedrock model) is
  **DEPLOYED** to the authorized pilot account (#66); the other five stacks
  (identity/data/api/ai-orchestration/observability) remain placeholders, synth-only, no deploy.
  CI stays credential-free synth (Infra Synth lane); every deploy is human-gated.
- `main` branch protection is APPLIED (2026-07-08, Option A): required checks `quality (20)`,
  `quality (22)`, `Analyze (javascript-typescript)`, `Analyze (actions)` (the CodeQL default-setup
  runs); `enforce_admins: false` so the owner keeps direct-push-after-human-gate; no PR requirement
  yet; `strict: false`; force-push/deletion disabled. Web Quality/Infra Synth stay non-required
  (path-filtered → would deadlock non-matching PRs).
- **#65/#66/#72/#73 are CLOSED (Done) — the AWS pilot runtime is proven end-to-end on the
  authorized account.** Live AWS state: operator policies (permissions boundary v2 = Nova Pro;
  scoped CFN exec policy v2 with the SSM bootstrap-version read), CDKToolkit
  (termination-protected, scoped exec role, no --trust), SecurityStack (native
  `AWS::IAM::OIDCProvider`, refresh role with attached boundary, `bedrock:InvokeModel`-only
  policy) — nothing else. The pilot's **configured standard-tier model is Amazon Nova Pro**
  (`us.amazon.nova-pro-v1:0`; code + boundary + stack + `BEDROCK_MODEL_STANDARD` var all
  aligned). Runtime evidence: paid smoke succeeded — OIDC assume ✓, Converse on Nova Pro ✓
  (usage 1613 in / 322 out), blueprint no-diff ✓, bank 60/0 ✓. Claude Sonnet 5 stays a
  non-blocking AWS Sales follow-up; switching models back requires config + a new boundary
  default version + a SecurityStack redeploy (model-specific policies), each human-gated.
  Published commits on the track: `8ed1449`, `be45b95`, `9a377ef`, `9194039` — all CI green.
  Execution logs: `done/66-aws-pilot-bootstrap.md`, `done/73-blueprint-refresh-pr-finalizer.md`.
- The `blueprint-refresh` workflow is fully hardened and proven (#73): no-diff is an explicit
  success; the PR finalizer runs only on a real diff, with `persist-credentials: false` and
  `create-pull-request@v8` (self-test PR #74 created cleanly, closed without merge, branch
  deleted); a `pr_plumbing_test` input exercises the finalizer with zero AWS/spend; 7 static
  invariant tests guard the workflow in root CI. Repo setting changed (gated):
  `can_approve_pull_request_reviews=true` (default workflow permissions stay `read`).
- No account IDs or ARNs belong in tracked files.
- Roadmap audit (2026-07-25): #22/#33/#48/#49 were closed as completed; #66 was added to Phase 1;
  roadmap/SaaS labels were normalized; native parent/sub-issue links now drive progress for the
  major epics. The GitHub API does not expose Project-view creation, so the `Roadmap by Phase` view
  still requires one manual UI action.
- #46 is decomposed into native Phase 1 / Todo sub-issues: #67 Cloudflare Workers/OpenNext frontend,
  #68 AWS Web BFF extraction, #69 Cognito/CORS security boundary, and #70 integrated deploy plus
  post-deploy smoke gates. The current Next.js app is not a pure static export; sensitive exam data
  and correction logic remain server-side behind the AWS BFF.
- **#55 and #56 are CLOSED (Done)** — the #50 design track is complete: the pilot release
  runbook (`pilot-release-runbook.md`, published `cde0c8c`) and the deployed-environment smoke
  workflow blueprint (`deployed-environment-smoke-workflow-design.md`, published `30d8eee`),
  both CI green. Key downstream decisions: browser BFF base is Worker RUNTIME config
  (`CBA_BFF_BASE_URL`, never `NEXT_PUBLIC_*` — recorded on #67); gate 5 persistence evidence is
  defined by #68; the smoke-cleanup deletion contract is #75. Execution logs:
  `done/55-pilot-release-runbook.md`, `done/56-deployed-environment-smoke-workflow-design.md`.
- Next platform sequence: #68 implementation slices — **#76 (services/bff scaffold + contract
  harness) -> #77 (DynamoDB + DataStack) -> #78 (Lambda/API Gateway)** — alongside #67 and #69,
  then #75 cleanup contract -> #70 -> close #46.
  Product work can continue independently: #44 -> #57 -> #62. Follow-ups: `ai-batch` environment
  hardening (own task, outside #66 acceptance); Claude Sonnet 5 via AWS Sales (non-blocking);
  reconcile §1's single `CodeQL` check name to the real `Analyze (...)` runs; weigh Option B
  before requiring Web Quality; redact the pre-existing account id in committed `COMMANDS.md`
  (low priority); decide whether `.vscode/settings.json` is shared or ignored (pending human
  decision — left untracked). Hygiene done (2026-07-25): the local AWS access-keys CSV was moved
  OUT of the repo directory to a 0600 file under `~/.aws/` without reading its contents; rotating/
  revoking those keys if still active is a pending HUMAN action.
- #71 is delivered and closed: local AWS MCP development access uses a one-hour assume-role profile
  with a validated least-privilege diagnostics policy plus permissions boundary. It can inspect
  infrastructure metadata, logs, metrics, quotas, and cost metadata, while model invocation,
  secrets, application-data reads, and deploy mutations are denied. The local VS Code MCP config is
  gitignored, allowlists only this role profile, and uses the user-wide `~/.local/bin/uvx` install.
- #47 is CLOSED (Done): `docs/architecture/pilot-environment-contract.md` (published `1b2e762`,
  CI green) is the canonical `local -> dev -> pilot` contract (API Gateway HTTP API + Lambda BFF,
  DynamoDB on-demand, Cognito, config registry by owner, deployed-runtime fail-fast rule,
  no-spend readiness) — #67/#68/#69/#70 build against it. Handoff:
  `done/47-aws-pilot-environment-foundation.md`.
- Local MCP inventory for agents: Stitch, Cloudflare Docs, Cloudflare API, AWS, GitHub, and Next.js
  DevTools. GitHub/Cloudflare use IDE OAuth, AWS exposes only the read-only diagnostics role, and
  Next.js DevTools is pinned locally to `0.4.0`. MCP configs remain local, mode `0600`, and ignored.
- Housekeeping open: the moderate Dependabot `postcss` advisory in `/web` awaits a dependency PR.
  (Duplicate issue #45 is closed as a duplicate of #42.)
- Tooling lesson (2026-07-08): verify CI-matrix (Node 20+22) compatibility for tooling changes —
  `node --test` glob-pattern paths need Node >=21; root test uses a shell-expanded `test/*.test.js`.

## Do not touch without explicit assignment

- CBA question facts or explanations without official Backstage/LF source evidence.
- Architecture diagrams already accepted for #34.
- Provider/runtime boundaries delivered by #23/#27/#29/#30/#31 unless the task explicitly targets them.
- `docs/product/` contracts/data-model/scope docs and the canonical Stitch prototype
  (`docs/product/prototypes/stitch-cba-study-coach/`) — amend only via an assigned task.
- `web/` BFF-shaped contracts and exam-mode rules (no correctness pre-submit; deterministic-only
  coach) delivered by #39–#43.
- CI/security foundation and the AWS IAM/OIDC model: `.github/workflows/*`, `infra/aws/**`, and the
  `docs/architecture/{ci-cd-security-foundation,github-security-and-oidc-baseline,aws-bootstrap-and-oidc,aws-iac-foundation}.md`
  docs — change only via an assigned #46-track (or successor platform-track) task. Never introduce
  long-lived AWS keys. AWS access model: **CI/deploy = GitHub OIDC role assumption only; local
  development = operator SSO / temporary assume-role profiles (#71 diagnostics role); static
  access keys are never acceptable in either path.**

## Required behavior

- Run `npm run agent-refresh` before editing, before commit, before push, after git-state changes, and every 5 minutes during long-running work.
- Check `.agent-handoff/active/` before starting work.
- Record any delegated task in `inbox/`, `active/`, or `done/`.
- Update `CURRENT.md` and append to `EVENTS.md` after meaningful state changes.
- Never push without explicit human approval.
