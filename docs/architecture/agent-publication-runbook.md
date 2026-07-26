# Agent Publication Runbook (#91, #93)

How source reaches `origin`, why the control exists, and what Stage B still has to enforce remotely.

Controls: `SEC-GOV-01`, `SEC-SUP-01`, `SEC-IAM-01`, `SEC-REL-01`.

**The one-line answer: no agent publishes.** The executor validates and prepares, the reviewer
reads, the human runs. The rest of this document explains that sentence and, more importantly, its
limits.

## 1. The incident this exists for

On 2026-07-26 a generic human approval intended to release a coordinated #82/#85 gate was read by
the **architect/reviewer** agent as permission to run `git push origin main`. The push was in scope
and the content was correct — but the wrong role performed it. In the same cycle two agents sharing
a writable `main` raced around `git commit --amend`, which needed reflog recovery and byte-identical
commit reconstruction.

Nothing in `AGENTS.md` was ambiguous. Prose was simply not a control — but neither is local code a
control against a caller who declines to run it. Stage A checks role, branch, exact commits and the
human decision against machine-readable state as a **local advisory pre-flight**; Stage B places the
authoritative enforcement on the remote, where a local bypass cannot reach it.

## 2. Roles

| Role | May | May never |
| --- | --- | --- |
| Human product/security owner | Write a gate naming themselves; **run** the prepared script; merge the PR | Delegate script execution or merge authority to an agent |
| Implementation executor | Commit on `task/<issue>-<slug>`; run `agent-publish`; **prepare** a publication script | Push anything, merge, deploy, spend, **run the prepared script**, publish without a gate |
| Architect/security reviewer | Review by full SHA, **read** a prepared script, create roadmap issues, recommend a gate | Publish any source branch, merge, act as executor, **prepare or run a script** |
| Independent reviewer | Reproduce evidence, report findings by severity | Repair findings silently; publish |

The three verbs are the point: **prepare**, **read**, **run** are held by three different actors and
happen at three different times. That separation is by process and by artifact, not by credential —
see §3 and §4.

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

## 4. The human-operated publication bridge (#93)

Stage A validates and stops, and Stage B does not exist yet. The gap in between was being filled by
a human typing publication commands from memory against a chat approval — which is precisely the
shape of the 2026-07-26 incident. The bridge replaces that with a **bounded, reviewable artifact**.

### 4.1 The three verbs, three actors, three moments

| Verb | Actor | Command / action | What it is not |
| --- | --- | --- | --- |
| **Prepare** | implementation executor | `node bin/cli.js agent-human-publish-script --role executor --executor <id> --gate <file>` | not publishing; nothing leaves the machine |
| **Read** | architect/security reviewer | open the file, confirm the printed SHA-256 | not implementing, not executing |
| **Run** | human operator | `bash /tmp/cba-publish-<issue>-<head>.sh` | not merging |

`agent-publish` is unchanged and remains advisory local validation (decision 1 of #93). The
generator is a separate command precisely so that "validate" can never quietly grow into "publish".

### 4.2 What the generator can and cannot do

The generator makes **no network call** and issues **no Git or GitHub mutation**. Its git usage is
the Stage A read set (`rev-parse`, `status`, `rev-list`, `merge-base`, `worktree list`,
`remote get-url`). Its only side effect is creating one file.

That file:

- lives under `/tmp` only. The path is validated structurally *before* the filesystem is consulted:
  no whitespace, no control characters, no traversal segment, no repository path, and it must match
  `/tmp/<bounded-name>.sh`;
- is never written over a symlink (`lstat`, not `stat`) and never overwrites an existing file — the
  `wx` open flag closes the gap between the check and the write;
- is mode `0600` and carries **no executable bit for anyone**. The mode is set explicitly after the
  write, because the umask masks the mode passed to `open()`, and then verified. Non-executable is
  the design: running it must be a deliberate `bash <path>`, never an accident or a stray `./`;
- contains no credential. It uses whatever `git`/`gh` session the human already has;
- is scanned before it reaches disk against a forbidden-operation list — force push, pushing an
  integration branch, merge, deploy, repository administration, credential handling, history
  rewriting and paid-service invocation. A match aborts and writes nothing: it would be a generator
  defect, and it must fail in front of the executor rather than the human operator.

The command prints the SHA-256 of the exact bytes written, so the reviewer can prove that what they
read is what the human runs.

### 4.3 What the script does when the human runs it

Everything the script may touch is bound at generation time from the validated gate — repository,
issue, source branch, target branch, the ordered reviewed SHAs, the expected HEAD, the expiry. It
then re-verifies all of it against live state:

1. **an interactive terminal is required.** Without one, the typed confirmation could be fed from a
   pipe or here-string by an automated caller, so a non-interactive stdin is refused outright;
2. the gate must not have expired;
3. the source branch may never be `main`/`master`; the target must be `main`;
4. the correct branch must be checked out, the worktree clean, and the branch must not be checked
   out in a second worktree;
5. HEAD must be exactly the reviewed commit, and the commit list must match the reviewed set
   exactly and in order — an amend, rebase or reorder fails closed;
6. it fetches (read-only) and requires the **live** `origin/main` to still equal the gate base; if a
   remote branch already exists, the push must be a fast-forward, never discarding remote commits;
7. the human types `publish <issue> <head12>` exactly;
8. **the one mutation**: `git push origin refs/heads/<branch>:refs/heads/<branch>` — no force;
9. it creates a pull request, or reuses the single existing open one after confirming its base and
   head. It never touches a PR with a different base or head;
10. it prints redacted evidence and states that merge remains a separate human action.

Step 6 is the first *live* remote check in this system — Stage A can only read local refs. It is
still not Stage B: a live check performed by a script the human chose to run is not the same as a
constraint the remote enforces.

### 4.4 What the bridge does NOT provide

| Not provided | Why |
| --- | --- |
| Authenticated role separation | `--role` is caller-supplied. An agent that ignores this document is not stopped by it. |
| A guarantee no agent runs the script | Non-executable mode and the TTY check raise the cost and make it deliberate; they do not make it impossible. |
| Replay protection | The gate is validated, never consumed. Expiry and the exact-HEAD check bound the window instead. |
| Protection of `main` | Unchanged: `enforce_admins` is still `false`. Only Stage B closes it. |

The bridge narrows *what can go wrong when the right actor acts*. It does not prevent a
non-cooperating actor. That is Stage B's job, and until Stage B ships this remains a process
guardrail backed by an artifact — not a security boundary.

## 5. Stage B — remote enforcement (separate human gate, NOT performed)

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

## 6. Recovery — never force-push published history

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

## 7. Verification

Stage A is covered by `test/agent-publish.test.js` on the Node 20/22 matrix. The suite proves what
the LOCAL checks do: a positive control; refusal of a **declared** architect/reviewer role before
`.env`, the gate or git (both `--role x` and `--role=x`, and with `CBA_AGENT_ROLE=executor` set, to
prove the argument wins); generic approval; expiry and TTL bounds; executor mismatch against the
declared identity; branch shape/issue mismatch; `main`-as-source; extra/missing/reordered/amended
commits; base drift; `origin/main` drift from local refs; dirty worktree; shared worktree; a
`reviewedShas` set that does not equal the commits; malformed metadata including credential-shaped
`gateId`; redaction of caller-supplied values in refusals; the absence of any publish path; and the
hook's content and executable bit.

The suite does **not** prove authenticated role separation or replay protection, because Stage A
provides neither: the declared role is caller-supplied, and a gate is validated rather than
consumed. A test pins the replay behaviour so Stage B must change it deliberately.

The #93 bridge is covered by `test/human-publish-script.test.js`, offline on the same matrix. It
proves: output-path refusal for a repository path, a path outside `/tmp`, traversal, a symlink and
an existing file; drift refusal for commit set, base, branch, HEAD and a shared worktree; gate
expiry and the typed confirmation appearing in the generated text; the absence of every forbidden
operation — force push, pushing an integration branch, merge, deploy, repository administration,
credential handling, history rewriting and paid-service invocation — asserted against the real
generated script and against the generator source; that the generator source contains no network
primitive and no Git or GitHub write verb; that the written file is mode `0600` with no executable
bit; that no secret-shaped material reaches the script; and that the documents, `spec/security-rules.md`
and both skills agree on who may prepare, read and run.

What the suite cannot prove is that a non-cooperating agent will not run the script anyway. Nothing
local can. Stage B is verified by the non-production self-test in §5.7 and is not claimed until that
test passes.
