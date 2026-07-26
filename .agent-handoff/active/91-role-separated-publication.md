# Task: Role-separated PR-only agent publication (#91) — Stage A

## Ownership

- Implementation executor: Claude Opus 5
- Architect/security reviewer: Codex
- Human gate: required before ANY publication. Stage B is a separate outward-facing gate.

## Source of truth

- GitHub issue #91 (sub-issue of #84), read in full.
- `spec/security-rules.md` §1 decision rights; `docs/architecture/security-assurance-baseline.md`
  §9 roles and `SEC-GOV-01`/`SEC-SUP-01`/`SEC-IAM-01`/`SEC-REL-01`.
- `docs/architecture/github-security-and-oidc-baseline.md` (#52).

## Incident being controlled

On 2026-07-26 a generic human approval for the coordinated #82/#85 gate was interpreted by the
architect/reviewer agent as permission to run `git push origin main`. The push was in scope but the
wrong ROLE performed it; separately, two agents sharing a writable `main` raced on
`git commit --amend`, requiring reflog recovery. Prose was not a control.

## Stage A delivered (this branch/worktree)

- `src/lib/publish-gate.js` — PURE validation: role separation, branch rules, named approver,
  expiry/replay, executor binding, base drift, exact ordered commits, dirty worktree, stale review.
- `src/commands/agent-publish.js` — the only sanctioned publication path. Role is refused BEFORE
  the gate is read and before any network dependency is constructed (dedicated exit code `2`).
  No merge path, no branch-protection path, no credential path, no deploy path.
- `bin/cli.js` — `agent-publish` wired with `--role`, `--executor`, `--gate`, `--dry-run`.
- `.agent-handoff/publish-gates/` — manifest schema, rationale mapping each field to a way the
  incident could repeat, and a deliberately unusable example fixture.
- `.githooks/pre-push` — local refusal of direct `main`/`master` pushes, explicitly documented as
  defense in depth rather than the authoritative control.
- `AGENTS.md`, `.agent-handoff/README.md`, `.agent-handoff/COMMANDS.md`, both review skills —
  role rules, worktree-per-task, immutability of reviewed commits.
- `docs/architecture/agent-publication-runbook.md` — incident, roles, Stage A limits, the Stage B
  remote plan with a rollout order that cannot lock the repo out, and recovery paths that never
  force-push published history.

## Tests

`test/agent-publish.test.js` — 19 tests, fully offline (fs/git/publish seams injected):
positive control; role refusal for architect/reviewer/unknown/missing; **proof that no fs, git or
network seam is touched for a forbidden role**; `main`/`master` rejected as source; branch
shape/issue mismatch; checked-out-branch mismatch; generic approvals; expiry and not-yet-valid;
executor mismatch; extra/missing/reordered/amended/empty commit sets; base drift; dirty worktree;
stale review SHA; malformed/incomplete manifest; the example fixture proven unusable; end-to-end
reaching the publisher exactly once with `merged:false` and no credential in evidence; `--dry-run`
never reaching the publisher; hook content and executable bit.

## NOT executed (each needs its own human gate)

No push, no PR creation, no branch-protection change, no GitHub App/token creation, no merge, no
deploy, no cloud mutation. Stage B is entirely unimplemented.

## Residual risk

- Stage A is local: the hook is absent from a fresh clone and skippable, and `agent-publish` can
  simply not be run. **Direct `main` pushes remain possible until Stage B**, and `enforce_admins`
  is currently `false` — the exact condition that allowed the incident.
- `--strict`/up-to-date-before-merge can deadlock the path-filtered lanes (Web Quality, Infra
  Synth do not run on every change); the runbook flags this as verify-before-enabling.
- The gate is evidence, not a credential: it prevents the wrong ACTION, not a compromised actor.
- No self-test proves remote rejection yet; that claim is deliberately not made.
