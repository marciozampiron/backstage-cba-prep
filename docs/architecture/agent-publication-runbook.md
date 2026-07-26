# Agent Publication Runbook (#91, #93)

How source reaches `origin`, why the control exists, and what Stage B still has to enforce remotely.

Controls: `SEC-GOV-01`, `SEC-SUP-01`, `SEC-IAM-01`, `SEC-REL-01`.

**The one-line answer: nothing is published without an exact human gate.** Opus prepares and, after
Codex reviews and Zamp grants a `HUMAN_GATE_GRANTED` naming this artifact's digest, Opus operates it.
Zamp decides and performs the merge. The rest of this document explains that sentence and, more
importantly, its limits.

Roles and messages are canonical in
[`../../.agent-handoff/MESSAGE-PROTOCOL.md`](../../.agent-handoff/MESSAGE-PROTOCOL.md).

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

## 2. Roles — the definitive model

**Zamp approves. Opus operates. Codex reviews. Nobody holds two of those at once.**

| Actor | May | May never |
| --- | --- | --- |
| **Zamp** — human product/security owner | Author a gate naming themselves; approve; accept residual risk; **decide and perform the merge** | Delegate approval, risk acceptance or merge to any agent |
| **Opus** — implementation executor and publication operator | Commit on `task/<issue>-<slug>`; validate; prepare the publication script; **run it after an exact human gate** | Approve its own work, author its own gate, merge, deploy, push an integration branch, force-push, administer the repository |
| **Codex** — architect and security reviewer | Read-only architecture and security review; identify commits by full SHA; recommend a gate | Implement, prepare a script, execute anything, push, merge, deploy |
| **Gemini** | Nothing in this workflow | Hold any workflow or governance role |

The sequence is fixed: **Opus prepares → Codex reviews → Zamp approves → Opus executes → Zamp
decides and performs the merge.**

Three separations carry the weight, and each is worth stating plainly:

- **Approval is separate from operation.** Opus runs the publication, so the gate must come from
  someone else. `agent-human-publish-script` refuses a gate whose approver is the invoking executor
  (`APPROVER_IS_OPERATOR`) or whose approver looks like an agent identity (`APPROVER_NOT_HUMAN`),
  on top of #91's refusal of generic approvals like "approved" or "lgtm". An agent agreeing with
  itself is not a decision.
- **Review is separate from implementation.** Codex reads; it never writes, prepares or runs. Both
  publication commands refuse its declared role before reading a gate, running git, or writing a
  file.
- **Publication is separate from merge.** The script can push the reviewed commit and open one pull
  request. Merge is Zamp's, always, and no code path here can perform it.

**Gemini has no role in this workflow or in governance.** It remains a supported model provider for
question authoring (`src/lib/llm.js`, `src/commands/generate.js`) and a supported CLI for tutoring
— those are product features and are unaffected. It simply never appears as an actor in
preparation, review, approval, publication or merge.

One human may hold several human roles; the workflow keeps the records separate. What no one may do
is hold both an approving role and an operating role for the same publication.

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

## 4. The gated publication bridge (#93)

Stage A validates and stops, and Stage B does not exist yet. The gap in between was being filled by
a human typing publication commands from memory against a chat approval — which is precisely the
shape of the 2026-07-26 incident. The bridge replaces that with a **bounded, reviewable artifact**.

### 4.1 Five steps, four actors, one direction

| # | Step | Actor | Action |
| --- | --- | --- | --- |
| 1 | **Prepare** | Opus | `node bin/cli.js agent-human-publish-script --role executor --executor <id> --gate /tmp/cba-gate-<n>.json` — writes the artifact, publishes nothing |
| 2 | **Review** | Codex | reads the file, confirms the printed SHA-256, reports findings — read-only |
| 3 | **Approve** | Zamp | authors or confirms the gate naming themselves and the exact ordered commits |
| 4 | **Execute** | Opus | runs the verify-and-run command printed in step 1, which hashes the bytes it executes |
| 5 | **Merge** | Zamp | decides and performs the merge, after required checks |

Steps 1 and 4 are both Opus, and that is deliberate — but step 3 sits between them and cannot be
supplied by Opus. A finding in step 2 sends the work back to step 1 as a **new** commit; reviewed
commits are never amended.

`agent-publish` is unchanged and remains advisory local validation (decision 1 of #93). The
generator is a separate command precisely so that "validate" can never quietly grow into "publish".

### 4.2 What the generator can and cannot do

The generator makes **no network call** and issues **no Git or GitHub mutation**. Its git usage is
the Stage A read set (`rev-parse`, `status`, `rev-list`, `merge-base`, `worktree list`,
`remote get-url`). Its only side effect is creating one file.

The repository is **derived** from the `origin` remote, never merely accepted from `--repo`. A
supplied `--repo` is only ever a confirmation: if it disagrees with origin the command refuses
(`REPO_ORIGIN_MISMATCH`), and if origin is missing or not a canonical GitHub URL it refuses rather
than falling back (`ORIGIN_UNRESOLVED`). A remote URL carrying userinfo fails the pattern instead of
being parsed and stripped, so a credential in a remote can never reach the script or a message.

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
  defect, and it must fail at preparation rather than at operation.

The command prints the SHA-256 of the exact bytes written, **and the verify-and-run command the
human must use**. That command reads the file once into a shell variable, hashes those captured
bytes, and executes those same bytes with `bash -c`; the path is never reopened.

This matters more than it looks. A bare `bash <path>` would open the file *again*, after the
reviewer hashed it. Anything running as the same user could replace it in between, and the human
would then execute arbitrary commands under their own git and GitHub credentials — precisely the
authority this design exists to constrain. Verifying and executing must act on one read, and a
mismatch exits non-zero from a subshell rather than only printing a warning. A test performs the
substitution and asserts that the swapped script neither runs nor leaves a side effect.

### 4.3 What the artifact does when the operator runs it

Everything the artifact may touch is bound at generation time from the review scope — repository,
issue, source branch, target branch, the ordered reviewed SHAs, the expected HEAD. It then requires
Zamp's execution gate and re-verifies everything against live state:

1. **the execution gate is required, and it is a different artifact from the review scope.** See
   §4.4 — nothing is authorized by preparation alone. The gate is read from
   `CBA_EXECUTION_GATE`, refused if it is a symlink or not a regular file, and must be a
   `HUMAN_GATE_GRANTED` naming this issue, this branch, the canonical approver, the reviewed
   commits exactly and in order, a bounded unexpired window, and — critically — the **digest of the
   exact bytes being run**, supplied by the verify-and-run command as `CBA_ARTIFACT_DIGEST`;
2. the review-scope window must not have expired either;
3. the source branch may never be `main`/`master`; the target must be `main`;
4. the correct branch must be checked out, the worktree clean, and the branch must not be checked
   out in a second worktree;
5. HEAD must be exactly the reviewed commit, and the commit list must match the reviewed set
   exactly and in order — an amend, rebase or reorder fails closed;
6. **the push target and the API target must be the same repository.** The push goes to `origin`
   while every `gh` query goes to the embedded `REPO`; if those named different repositories the
   branch would land in one place while the pull request was inspected in another. `git remote
   get-url origin` is checked against `REPO` at run time;
7. it reads the **live** remote with `git ls-remote` — never a local remote-tracking ref, which is
   only as fresh as the last fetch — and requires `origin/main` to still equal the gate base. If a
   remote branch already exists, the push must be a fast-forward, never discarding remote commits;
8. **the pull-request set is asserted before anything is published.** `gh pr list --head` matches by
   branch *name* and spans forks, so a pull request opened from a fork with the same branch name
   would otherwise look like the right one. The artifact requires zero or exactly one open match, not
   cross-repository, owned by the same owner, with exactly the reviewed base and head. Doing this
   *before* the push means a mismatch costs nothing — the branch is not published yet;
9. **the operator confirms.** The exact phrase `publish <issue> <head12>` is bound to this issue
   and this reviewed head, so it cannot be produced by habit, reused from another run, or satisfied
   by a generic "approved". This is an acknowledgement by the operator, **not** a second approval —
   the decision is the gate, and the approver's name is displayed at this prompt so the two cannot
   be confused. There is deliberately **no terminal check**: demanding a TTY would block Opus, which
   is the actor meant to run this, and an earlier draft of this document required both a TTY and an
   agent operator, which was a contradiction;
10. **everything volatile is re-checked.** Expiry, the origin binding, the live remote base and
    head, the pull-request set, HEAD and worktree cleanliness are all state that can change while a
    human reads a prompt — a terminal left open overnight would otherwise push against an expired
    gate or a moved base. The volatile checks are bash functions defined once and called twice, so
    the two passes cannot drift apart, and the second pass runs with nothing between it and the push;
11. **first external effect**: `git push origin <EXPECTED_HEAD>:refs/heads/<branch>` — the refspec
    names the reviewed **SHA**, not a symbolic ref. Pushing `refs/heads/<branch>` would publish
    whatever the branch points at when the push executes; naming the commit means only the approved
    commit can reach the remote. There is no force. The landed ref is then read back and must equal
    `EXPECTED_HEAD` exactly, or the script stops before opening a pull request that would describe
    something else;
12. **second external effect**: the pull-request set is re-asserted against the state that now
    exists, and exactly one pull request is created or reused. It never touches a fork's pull
    request, an ambiguous set, or one with a different base or head, and it never opens a second
    one if the pre-push match disappeared;
13. **the pull request is bound to the reviewed commit, not to a branch name.** A branch name is not
    a commit: between the push and the pull request another operation could move the branch, and the
    pull request would then describe unreviewed work. So `headRefOid` is queried and must equal
    `EXPECTED_HEAD`, the remote ref is read back once more, and the pull request is re-verified
    after it is created or reused;
14. it prints redacted evidence and states that merge remains Zamp's decision.

Two of those are **remote** effects; nothing else the script does mutates the remote. It is not
purely read-only locally, though: when the branch already exists on the remote it fetches those
objects so ancestry can be proven, which writes to the local object store and `FETCH_HEAD`.

Step 7 is the first *live* remote check in this system — Stage A can only read local refs. It is
still not Stage B: a live check performed by a script the human chose to run is not the same as a
constraint the remote enforces.

### 4.3.1 Where the gate lives, and why the worktree stays clean

The gate is authored by the human **outside the task worktree** — for example
`/tmp/cba-gate-<issue>.json`. This is not a preference. `.agent-handoff/publish-gates/` is tracked
and not ignored, so a gate written there is an untracked file; that makes the worktree dirty; and a
dirty worktree is exactly what step 4 refuses. The protocol as originally documented could not be
followed to completion. `agent-human-publish-script` now refuses an in-repository gate path
(`GATE_PATH_IN_REPO`) so prose cannot drift back into an impossible sequence, and an end-to-end test
walks the documented steps in a real temporary repository to prove they produce a script.

The check compares **canonical** paths and refuses a symlinked gate outright (`GATE_PATH_SYMLINK`).
A lexical comparison alone is defeated by `/tmp/gate.json -> <repo>/gate.json`: the path looks
external while the bytes read come from inside the worktree.

The same reasoning governs bookkeeping: `EVENTS.md`, `CURRENT.md` and `agent-refresh --record` all
write tracked files. They belong to the main worktree or to a later commit — never to the task
worktree before generation.

### 4.4 Two gates, because one was circular

The first version of this bridge had a single manifest, and that was a real defect rather than a
simplification. The manifest had to exist **before** the artifact was generated — the artifact is
built from it — so it could not possibly name the artifact's digest, and when it was written the
reviewer had not read anything yet. Calling it "the machine-readable form of `HUMAN_GATE_GRANTED`"
made the authorization circular: it authorized an artifact that did not exist.

There are now two distinct documents:

| | Review scope manifest | Execution gate |
| --- | --- | --- |
| Written by | Zamp, before preparation | Zamp, after review |
| Answers | "which commits may be prepared?" | "may THIS artifact run, now?" |
| Contains | base, branch, ordered commits, approver | issue, branch, ordered commits, approver, **artifact digest**, bounded expiry |
| Read by | `agent-human-publish-script` at preparation | the artifact itself, at run time, via `CBA_EXECUTION_GATE` |
| Message type | — (scope input) | `HUMAN_GATE_GRANTED` |

Because the execution gate names the digest, it cannot be recycled for a different artifact: a
regenerated script has a different digest and needs a new gate. And because the artifact validates
it immediately before any effect, an expired or mismatched gate stops the operation rather than
being noticed afterwards.

Review is likewise two things, and the `REVIEW_REQUEST`/`FINDINGS`/`REVIEW_APPROVED` messages carry
a `SCOPE` field saying which: **code review** of the commits, and **artifact review** of the
generated bytes and their digest. They are different reads with different evidence, and one
`REVIEW_APPROVED` for the code says nothing about the artifact.

### 4.5 What the bridge does NOT provide

| Not provided | Why |
| --- | --- |
| Authenticated role separation | `--role` is caller-supplied. An agent that ignores this document is not stopped by it. |
| A guarantee that only Opus operates the artifact | Non-executable mode, the required execution gate and the digest binding raise the cost and make operation deliberate and traceable; they do not authenticate who ran it. |
| Protection if the operator ignores the verify-and-run command | A bare-path invocation is never supported, but nothing prevents one; it would reopen the file. The integrity guarantee is only as good as the command actually used. |
| Replay protection | The gate is validated, never consumed. Expiry and the exact-HEAD check bound the window instead. |
| Protection of `main` | Unchanged: `enforce_admins` is still `false`. Only Stage B closes it. |
| A single external effect | There are **two** — the push and the pull request. Both are bounded and checked before and after, but "one mutation" would be inaccurate. |

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
generated script and against the generator source, with each pattern proven to match its own sample
so a "no match" assertion cannot pass vacuously; that the generator source contains no network
primitive and no Git or GitHub write verb; that the written file is mode `0600` with no executable
bit; that no secret-shaped material reaches the script; that the repository is bound to the origin
remote and a diverging or unresolvable one refuses; that the pull-request set is asserted before the
push and re-asserted after it; that a gate inside the worktree refuses; that a failed gate read
echoes neither the caller-supplied path nor a raw error; that no source file in the repository
contains a NUL byte, which would make it binary and therefore unreviewable in a diff; and that the
documents, `spec/security-rules.md` and both skills agree on who may prepare, read and run.

Two end-to-end tests build a real temporary git repository and walk the documented protocol: one
proves that following it literally produces a script and leaves the worktree clean, and one proves
that a gate written into `.agent-handoff/publish-gates/` dirties the worktree and is refused. They
exist because the protocol was, at one point, impossible to follow to completion, and prose alone
had not revealed it.

What the suite cannot prove is that a non-cooperating agent will not run the script anyway. Nothing
local can. Stage B is verified by the non-production self-test in §5.7 and is not claimed until that
test passes.
