# Agent Publication Runbook (#91)

How agents publish source, why the control exists, and what Stage B still has to enforce remotely.

Controls: `SEC-GOV-01`, `SEC-SUP-01`, `SEC-IAM-01`, `SEC-REL-01`.

## 1. The incident this exists for

On 2026-07-26 a generic human approval intended to release a coordinated #82/#85 gate was read by
the **architect/reviewer** agent as permission to run `git push origin main`. The push was in scope
and the content was correct — but the wrong role performed it. In the same cycle two agents sharing
a writable `main` raced around `git commit --amend`, which needed reflog recovery and byte-identical
commit reconstruction.

Nothing in `AGENTS.md` was ambiguous. Prose was simply not a control. Stage A binds publication
authority, role, branch, exact commits and the human decision to machine-checked state; Stage B
moves the authoritative enforcement to the remote, where a local bypass cannot reach it.

## 2. Roles

| Role | May | May never |
| --- | --- | --- |
| Human product/security owner | Write a gate naming themselves; merge the PR | Delegate merge authority to an agent |
| Implementation executor | Commit on `task/<issue>-<slug>`; run `agent-publish` with a valid gate | Push `main`, merge, deploy, spend, publish without a gate |
| Architect/security reviewer | Review by full SHA, create roadmap issues, recommend a gate | Publish any source branch, merge, act as executor |
| Independent reviewer | Reproduce evidence, report findings by severity | Repair findings silently; publish |

One human may hold several human roles; the workflow keeps the records separate.

## 3. Stage A — LOCAL PRE-FLIGHT VALIDATION ONLY

Stage A is **advisory**. `agent-publish` validates a gate against local state and prints the plan.
It does not push, open a pull request, merge, change protection, create a credential or deploy, and
it contains no code path that could — a test asserts the absence of every git write verb, GitHub
API surface and network primitive in the command.

**The declared role and executor identity are supplied by the caller** (`--role`, `--executor`,
`CBA_AGENT_ROLE`, `CBA_AGENT_ID`). Nothing authenticates them. Any caller can declare `executor`.
This is a guard rail against acting in the wrong role by habit or misreading — it is **not**
mechanical identity separation, and it must never be described as one.

What Stage A does check:

- the declared role, refused for `architect`/`reviewer`/unknown/missing **before `.env` loads,
  before the gate is read and before git runs** — proven by a test against the real CLI entrypoint,
  with a dedicated exit code `2`;
- `main`/`master` can never be a source branch; the target is always `main`;
- the source branch is `task/<issue>-<slug>` and its issue matches the gate;
- the approver is a **named human** — `approved`, `ok`, `lgtm`, `aprovado`, `pode pushar` are refused;
- timestamps are strict RFC3339 with an offset, and the gate TTL is capped at 12 hours;
- `gateId` is charset- and length-bounded and scanned for credential material, which is refused
  **without echoing the offending value**;
- `reviewedShas` is **mandatory** and must equal `commits` exactly and in order, so an unreviewed
  fix-forward cannot ride along and nothing reviewed can be silently dropped;
- base drift, extra/missing/reordered/amend-replaced commits, a dirty worktree, an expired or
  not-yet-valid gate, and an executor mismatch all fail closed;
- `origin/main`, when a local ref exists, must match the gate base;
- the gated branch must not be checked out in more than one worktree.

### What Stage A explicitly does NOT do

| Not provided | Why | Owner |
| --- | --- | --- |
| Authenticated role/identity | The claim is caller-supplied | Stage B bot credential |
| Replay protection | A gate is never consumed; the same file validates twice | Stage B idempotent consumption |
| Remote base truth | `origin/main` is a local ref, only as fresh as the last fetch | Stage B live-remote check |
| Exclusive worktree / handoff ownership | Observed and reported; a convention, not enforcement | Stage B + human process |
| Preventing a direct `main` push | A hook is absent from fresh clones and skippable; the command can simply not be run | Stage B branch protection |

`enforce_admins` is still `false` today. **A direct `git push origin main` remains possible.** That
is the exact condition behind the incident, and only Stage B closes it.

## 4. Stage B — remote enforcement (separate human gate, NOT performed)

Each item below is an outward-facing mutation and needs its own explicit human approval. None has
been executed.

1. Require a pull request to `main`, with the existing required checks (`quality (20)`,
   `quality (22)`, `Analyze (javascript-typescript)`, `Analyze (actions)`).
2. Apply protection to administrators (`enforce_admins=true`, or an equivalent ruleset bypass
   policy). Today `enforce_admins:false` is exactly what let a direct push succeed.
3. Keep force-push and branch deletion disabled.
4. Require the source branch to be current with `main` before merge **only where it does not
   deadlock the path-filtered lanes** — Web Quality and Infra Synth do not run on every change, so
   making them required or making strict-up-to-date mandatory can block a PR forever. Verify before
   enabling.
5. Create the executor GitHub App/bot with least privilege: create branches, open/update PRs, read
   checks. **No** administration, ruleset bypass, environment approval, deployment or merge.
6. Keep human merge as an explicit action after green checks.
7. Prove both directions with a non-production self-test: a direct `main` push is rejected, and the
   executor branch/PR happy path works.

### Rollout order that avoids locking the repository out

Create and verify the bot credential first, then require PRs, then enable `enforce_admins`. Doing
the last step first, with no working PR path, leaves the human owner unable to publish.

## 5. Recovery — never force-push published history

- **A finding after review**: make a NEW fix-forward commit and request a new gate. Never amend or
  rebase a reviewed commit.
- **Wrong commits published on the branch**: push an additional revert/fix commit. The PR is the
  unit of review; its history may grow but must not be rewritten.
- **A branch published by accident**: close the PR without merging and delete the *task* branch.
  `main` is untouched because agents never push it.
- **A direct `main` push happened anyway** (the 2026-07-26 case): do not force-push. Recover
  forward, record the event in `EVENTS.md` with the SHAs, and treat it as a security event under
  `SEC-GOV-01`.
- **Shared-worktree amend race**: recover the lost commit from reflog, verify byte-identical
  content, and split the agents into separate worktrees before continuing.

## 6. Verification

Stage A is covered by `test/agent-publish.test.js` on the Node 20/22 matrix: a positive control
plus abuse cases for role spoofing, pre-network refusal, generic approval, expiry and replay,
executor mismatch, branch shape/issue mismatch, `main`-as-source, extra/missing/reordered/amended
commits, base drift, dirty worktree, stale review, malformed manifest, and the hook's own content
and executable bit.

Stage B is verified by the non-production self-test in §4.7 and is not claimed until that test
passes.
