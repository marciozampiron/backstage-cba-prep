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
- `bin/cli.js` — `agent-publish` wired with `--role`, `--executor`, `--gate` (the `--dry-run` flag
  from this first commit was removed by the fix-forward: validation is the whole behaviour).
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

## Codex review round 1 — eight blockers, fixed forward

`8a71865a19b9a677db22d04c47f72eecaec3fd92` is reviewed and IMMUTABLE. Everything below is a NEW
commit on the same branch; no amend, rebase or squash was performed.

The unifying finding: **Stage A was overclaimed.** It is local advisory validation, not mechanical
identity separation. The fix is as much about honest contracts as about code.

1. **Self-asserted role/identity** — `--role`/`--executor` are caller-supplied and nothing
   authenticates them. Code, output, evidence (`declaredRole`/`declaredExecutor`), docs and the
   runbook now say "declared, not authenticated" and name Stage B (bot credential + branch
   protection) as the authoritative separation. A test asserts the honesty language is present.
2. **Contradictory docs** — the legacy `git push origin main` block in `COMMANDS.md` was replaced
   by the `agent-publish` flow, and `README.md` §Push gate no longer says the agent may push. A
   test scans `COMMANDS.md`, `README.md` and `AGENTS.md` and fails on any permitted push
   instruction; only the incident narrative may mention it.
3. **`reviewedShas` mandatory** — now required, non-empty, full SHAs, and must equal `commits`
   exactly and in order (`REVIEW_SET_MISMATCH`), so an unreviewed fix-forward cannot ride along and
   nothing reviewed can be silently dropped.
4. **Replay and remote base** — no protection is claimed that does not exist. `origin/main` is
   validated when a local ref exists (`REMOTE_BASE_DRIFT`) and explicitly labelled as local
   knowledge that may be stale; replay is stated as NOT prevented, with authoritative idempotent
   consumption deferred to Stage B. A test asserts the same gate validates twice, so a future
   Stage B change must update it deliberately.
5. **Phantom publisher** — removed entirely. Stage A is validation only: there is no publisher
   seam, no `--dry-run` flag (validation is the whole behaviour), and a test asserts the command
   contains no git write verb, no GitHub API surface and no network primitive. No environment or
   administrative credential is wired.
6. **Gate metadata** — `gateId` is 3-64 chars of `[a-z0-9._-]` and is scanned for credential
   material, refused **without echoing the offending value**; timestamps must be strict RFC3339
   with an offset; TTL is capped at 12 hours; evidence copies only validated fields.
7. **CLI guarantee** — `bin/cli.js` now refuses a forbidden declared role **before `loadEnv()`**,
   and a test drives the REAL entrypoint as a subprocess asserting exit code 2 and the message.
8. **Worktree/ownership** — the command observes `git worktree list` and fails when the gated
   branch is checked out twice (`WORKTREE_SHARED`), and reports handoff presence. Both are
   reported as local convention, not enforcement.

### Tests: 19 -> 27 (all offline)

Added: declared-not-authenticated honesty; `reviewedShas` missing/empty/extra/short/out-of-order;
`origin/main` drift; replay and remote-base deferral documented as behaviour; `gateId` credential
tripwire with no echo plus shape/length; non-RFC3339 timestamps and excessive TTL; shared worktree;
unobservable worktree/handoff reported as convention; the real CLI refusal ordering; and the
no-publisher contract.

### Risks explicitly DEFERRED to Stage B

- Authenticated role/identity — the declaration is caller-supplied and forgeable.
- Replay — a gate is validated, never consumed.
- Remote base truth — `origin/main` is a local ref, only as fresh as the last fetch.
- Exclusive worktree and handoff ownership — observed, not enforced.
- **Preventing a direct `main` push** — the hook is absent from fresh clones and skippable, and the
  command can simply not be run. `enforce_admins` is still `false`; the incident condition is open.

## Codex review round 2 — three findings, fixed forward

`8a71865…` and `77cf5bc…` are reviewed and IMMUTABLE. This is a THIRD commit on the same branch;
no amend, rebase, squash or replacement was performed.

### 1. Documentary contract still contradictory (HIGH)

Round 1 fixed the code contract but left publication claims in four documents. Reconciled:

- `.agent-handoff/README.md` — "Publication authority is bound mechanically" and "The command opens
  or updates a pull request" are gone. It now opens with Stage A being *local advisory pre-flight
  validation only* that never publishes, never opens a PR, never consumes a gate and never
  authenticates identity, and states that publication and merge are human actions until Stage B.
  The lifecycle separates Stage A validation from Stage B publication explicitly.
- `.agent-handoff/COMMANDS.md` — the `--dry-run` example is gone (validation is the whole
  behaviour) and the publish/PR step is replaced by a note that Stage A stops at validation.
- `.agent-handoff/publish-gates/README.md` — "refuses to publish" is now "refuses to VALIDATE";
  the `executor` field is described as compared against a **caller-declared** identity that nothing
  authenticates; the lifecycle is split into Stage A (steps 1-4, local) and Stage B (steps 5-6, not
  built), noting that today the human owner performs both.
- `docs/architecture/agent-publication-runbook.md` — "Stage A binds publication authority" is
  replaced by an accurate sentence that also concedes local code is not a control against a caller
  who declines to run it. The verification section no longer implies replay protection or
  authenticated role separation, and says plainly which properties the suite does NOT prove.

The documentation test now checks forbidden CONCEPTS across five documents — agent-may-push-main,
the command opening a PR, "publication authority is bound mechanically", the removed `--dry-run`
flag, and "agent-publish refuses to publish" — plus the positive assertion that the honest contract
is stated where an agent will read it. A line may MENTION a direct push when narrating the
incident, prohibiting it, or warning it is still possible; it may never instruct it.

### 2. Sensitive values echoed in refusals (MEDIUM)

Reproduced: `--role ghp_FAKESECRET123456` was echoed back as `Unknown declared role "ghp_…"`.

`safeLabel()` now gates every interpolation of caller-controlled input: a value is printed only if
it is ≤64 chars, matches a safe charset AND carries no credential marker; otherwise `<redacted>`.
`ROLE_UNKNOWN` no longer echoes the role at all. Sanitised: the caller's executor in
`EXECUTOR_MISMATCH`, `sourceBranch`, `targetBranch`, the observed branch, and
`evidence.declaredExecutor`. Already-validated values (gate `executor`, `approver`, `gateId`,
truncated SHAs) are still shown — redaction should not destroy the diagnostic.

### 3. `--role=<value>` bypassed the pre-loadEnv refusal (MEDIUM)

Reproduced exactly: the preflight scanned only for `--role x`, so `--role=architect` fell through
to `loadEnv()` and was refused later by the command. Both paths exit 2, which masked it.

Root cause was a second, partial parser. `bin/cli.js` now runs the REAL `parseArgs` once, before
`loadEnv()`, and the refusal uses its result — so both syntaxes behave identically by construction
rather than by duplicated logic. An explicit `--role` always wins over `CBA_AGENT_ROLE`.

### Tests: 27 -> 32

Added: documentation forbidden-concepts scan across five files; caller-supplied values redacted in
role, executor, sourceBranch, targetBranch and observed branch; `safeLabel` keeping validated
detail and dropping everything else; evidence never carrying an unsanitised identity; the real CLI
redacting a credential-shaped role on stderr; and both `--role=x` and `--role x` refused before
`.env`/gate/git with `CBA_AGENT_ROLE=executor` set, proving the argument wins and exit 2 is
preserved.

### Still deferred to Stage B (unchanged)

Authenticated role/identity, replay protection, live-remote base truth, exclusive worktree and
handoff ownership enforcement, and preventing a direct `main` push. `enforce_admins` remains
`false`: the incident condition is still open.
