# Current Agent Coordination State

Last updated: 2026-08-02 (#106 delivered; all three #70 external prerequisites resolved with evidence)
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
  **DEPLOYED** to the authorized pilot account (#66); the DataStack (#77) and ApiStack (#78) are
  IMPLEMENTED but synth-only (not deployed — deploy belongs to #70);
  IdentityStack Slices A/B/C (#69) are IMPLEMENTED and PUBLISHED through `961af51`, with #69
  CLOSED/Done and Quality, Web Quality, Infra Synth, and CodeQL green. Path-bound session
  readiness, honest auth errors, session-scoped OIDC stores, and the single `apiFetch` door are
  protected by 14 web tests. Identity/Data/Api remain synth-only; no AWS/Cloudflare deploy was
  performed. AI-orchestration/observability remain placeholders. CI stays credential-free synth
  (Infra Synth lane); every deploy is human-gated.
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
- **#82 is CLOSED (Done)** — the operational-observability baseline is delivered in three slices,
  all on `main`. Slice A: sanitized completion events plus explicit Lambda/API access log groups
  with per-environment retention. Slice B (PR #98, merge `2d8ab134c9c2f1f0a5944a1c756bdf200e4e01c0`):
  the `ObservabilityStack` — customer-managed rotating KMS key, encrypted SNS topic, six native
  alarms all `TreatMissingData=notBreaching`, an `OperationalHealth` composite that references
  exactly those six and is the sole SNS publisher, a five-row dashboard, five saved Logs Insights
  queries, and the environment-scoped read-only GitHub OIDC gate role (the account-global provider
  stays owned by `SecurityStack` and is imported, never re-created). Slice C (PR #99, merge
  `2f9ee8efb97c9e1612eea31c16ab6b18e146fea1`): the `observability-gate` command implementing O1
  (structural) and O2 (deployed telemetry evidence, bounded minute-aligned smoke window, traffic
  before alarms, real wall-clock budget). Everything remains synth-only — nothing was deployed.
- **Still open under #70, and NOT closed by #82: the live CloudWatch -> SNS -> KMS -> confirmed
  subscription proof.** O1 proves the resources exist; O2 proves telemetry flows and alarms are
  `OK`; neither proves a notification can actually be delivered, which is the one failure mode that
  is silent because a broken key policy loses notifications without changing any alarm state. It is
  also the only check that can falsify the deliberate narrowing of the key policy to exactly
  `kms:Decrypt` + `kms:GenerateDataKey`. It runs outside O1/O2 under operator credentials, is
  required before the first `pilot` promotion, and must be re-proven after any key/topic policy
  change. #70 also owns wiring the gates into the workflow and enforcing the bounded execution
  window on the saved queries.
- Phase 5 / #10 is the post-POC evolution from the CBA pilot to a multi-certification portal.
  Before the first non-CBA certification, a mandatory DDD hardening gate must make certification
  partitioning explicit, keep principals data-only, separate application ports/errors from adapters,
  replace ambient composition where needed, and prove cross-certification isolation with at least
  two fixtures. Canonical checklist: `spec/domain-driven-design.md`; roadmap gate:
  `spec/product-roadmap.md`. This does not authorize a broad POC refactor unless security, isolation,
  deterministic scoring, provenance, or publish approval is at risk.
- **#55 and #56 are CLOSED (Done)** — the #50 design track is complete: the pilot release
  runbook (`pilot-release-runbook.md`, published `cde0c8c`) and the deployed-environment smoke
  workflow blueprint (`deployed-environment-smoke-workflow-design.md`, published `30d8eee`),
  both CI green. Key downstream decisions: browser BFF base is Worker RUNTIME config
  (`CBA_BFF_BASE_URL`, never `NEXT_PUBLIC_*` — recorded on #67); gate 5 persistence evidence is
  defined by #68; the smoke-cleanup deletion contract is #75. Execution logs:
  `done/55-pilot-release-runbook.md`, `done/56-deployed-environment-smoke-workflow-design.md`.
- Next platform sequence: #68 implementation slices #76/#77/#78 are ALL DELIVERED (published
  through `a31294c`, CI green): `services/bff` provider-neutral core + DynamoDB adapter +
  DataStack + Lambda/API Gateway ApiStack (13 explicit routes, minimal DynamoDB IAM, fail-closed
  auth until #69, canonical BASE_URL contract runner for #70). **#69 is CLOSED (Done)**: Cognito
  User Pool + PKCE-ready public client, API Gateway JWT authorizer on every route except public
  readiness, access-token-only neutral principal (ID tokens and `x-cba-learner` refused, missing
  bearer fails closed), /api/me §16 with a cached profile, and the learner sign-in/session UI
  with a proven PKCE S256 flow — published through `961af51`, CI green, synth/test only. **#82 and
  #75 are CLOSED (Done)**; #75 delivered the smoke-cleanup contract in PR #101. **#67's in-repo
  delivery is merged** (PR #100), but #67 stays OPEN pending an actual deploy; its architecture
  decision is CLOSED — **the pilot uses the `workers.dev` origin** (Zamp, 2026-08-02).
  Current work: **#70** (Cloudflare/AWS deploy pipeline and post-deploy smoke gates), then #79 ->
  close #46/#68. Everything is
  still synth-only: NO stack beyond SecurityStack is deployed.
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
- Housekeeping: the 6 HIGH Dependabot alerts are **RESOLVED** — #106 delivered upgrades for all six
  (PR #107, merged `3583aeda`), zero risk acceptance, GitHub closed the alerts automatically. Two
  MODERATE root alerts remain (`@hono/node-server`, `@modelcontextprotocol/sdk`), both only in the
  optional AI-orchestration path, documented in `done/106-dependabot-high-remediation.md` for a
  future SDK bump; they are not a GO criterion. (Duplicate issue #45 is closed as a duplicate of
  #42.)
- Tooling lesson (2026-07-08): verify CI-matrix (Node 20+22) compatibility for tooling changes —
  `node --test` glob-pattern paths need Node >=21; root test uses a shell-expanded `test/*.test.js`.

## Active handoff

Audited 2026-07-30 against GitHub issues and the board; #70 taken into active ownership 2026-07-31.

- `active/70-cloudflare-aws-deploy-pipeline.md` — **#70 OPEN**, owner Claude Opus 5; no
  implementation worktree exists until the next slice is assigned. **Slice A is MERGED** (PR #104,
  `da0ed88e`, 6/6 checks green): the #69 deploy preflight, the release identity, the
  manifest/assembly binding, the `deploy-release` entrypoint and the YAML-semantic lane invariants.
  Nothing is deployed. **All three external prerequisites are RESOLVED (2026-08-02)**: the
  Environments `dev`/`pilot` exist with main-only deployment-branch policies and the pilot
  reviewer, evidenced read-only via the API; Zamp decided the pilot uses the **`workers.dev`**
  origin, closing the decision #67 carried; and the 6 high Dependabot alerts were remediated in
  #106. The next #70 slice may be assigned; deploy approvals follow the normal protocol.
  #70 owns the account-level half of #67 (Cloudflare project and Environment token, Worker routes
  and runtime VALUES, deploy lane, F1/F2), the AWS deploys of the synth-only stacks, the live
  SNS/KMS notification proof, and the deployed smoke lane. **It must not re-open the
  in-repo scope merged in PR #100 or the cleanup contract merged in PR #101.**
- `active/91-role-separated-publication.md` — **#91 OPEN**, Stage B not built. Preserved with its
  own worktree. Stage B is what makes operator identity unforgeable and adds replay protection and
  authoritative remote enforcement; until it ships, every publication guardrail is process rather
  than enforcement.

The two active owners touch disjoint files: #70 lives in `infra/aws/`, `.github/workflows/` and its
own handoff; #91 is the publication toolchain. Neither may edit the other's surface.

**The deploy preflight is binding on every lane** (`infra/aws/bin/deploy-preflight.js`). It refuses
before `cdk deploy` while `.invalid` survives into the effective Cognito callback/logout URLs, and
unless `authDomainPrefix` was explicitly supplied and confirmed unique in the target region. With
`workers.dev` decided, those values are knowable — they still enter ONLY as Environment
configuration at deploy time, never as tracked files.

**DEPLOYMENT BINDING EVIDENCED (2026-08-02).** The GitHub Environments `dev` and `pilot` are
configured: both carry a custom deployment-branch policy whose only entry is `main`, and `pilot`
requires `marciozampiron` as reviewer (read-only API evidence, recorded in the #70 handoff and
EVENTS). The next #70 slice may be assigned; deploy approvals follow the normal protocol. **No AWS
or Cloudflare deployment has happened yet** — everything beyond SecurityStack remains synth-only.
Observed residual limitations, stated so the mechanism is not read as stronger than it is:
`can_admins_bypass: true` on BOTH Environments, and `prevent_self_review: false` on pilot — the
protection satisfies the approved requirements but is not non-bypassable independent-human
enforcement, the same honest framing used for `enforce_admins=false` on publication.

Moved to `done/` in this audit, each with the policy references moved alongside:

- `67-cloudflare-opennext-stage-b.md` — the in-repo delivery is merged (PR #100). **Issue #67 stays
  OPEN**, but nothing implementable remains in the repository, so the handoff no longer holds
  ownership; the rest was transferred to `inbox/70-*`. Leaving it active would have blocked #70 on
  the same files — that is the collision this audit existed to prevent.
- `75-smoke-cleanup-contract.md` — **#75 CLOSED**, delivered in PR #101.
- `85-security-assurance-architecture.md` — **#85 CLOSED**; its three canonical documents are on
  `main` and no agent or worktree held ownership.
- `93-human-publication-script.md` — **#93 CLOSED**. Held back one commit because
  `src/lib/authority-policy.js`, `test/governance-model.test.js` and `spec/authority-policy.json`
  hard-code its path; that inverted the responsibility, so all three moved with the file and a
  control now asserts the `done/` path and refuses the `active/` one.

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
