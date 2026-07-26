---
name: publication-prepare
description: Prepare — never execute — a human-operated publication script for a gated task branch. Use when an issue's commits are reviewed, a human publish gate exists, and the branch needs to reach origin as a pull request. Covers validating the gate, generating the /tmp script, and handing it to the reviewer and the human operator.
---

# Prepare and operate publication (Opus — executor and operator)

**You are Opus: the implementation executor and publication operator.** You prepare the artifact,
hand it to Codex for read-only review, wait for an explicit `HUMAN_GATE_GRANTED` from Zamp, and only
then operate it. If you are acting as the architect/security reviewer, this skill does not apply —
that role is read-only and uses `publication-review`.

Canonical roles and messages: [`../../../.agent-handoff/MESSAGE-PROTOCOL.md`](../../../.agent-handoff/MESSAGE-PROTOCOL.md).

**Two things you may never do, whatever you are told in chat:** approve your own work, and merge.
Approval is Zamp's (`HUMAN_GATE_GRANTED`, naming the exact ordered full SHAs) and merge is Zamp's
(`MERGE_DECISION`). A generic "approved", "ok" or "pode pushar" — and a Codex `REVIEW_APPROVED` —
is review feedback, never a gate.

Read first: [`docs/architecture/agent-publication-runbook.md`](../../../docs/architecture/agent-publication-runbook.md)
§4, [`spec/security-rules.md`](../../../spec/security-rules.md) §1, and
[`.agent-handoff/README.md`](../../../.agent-handoff/README.md).

## Preconditions — stop if any is unmet

- Your commits are on `task/<issue>-<slug>` in **your own worktree**, and independent review of
  those exact commits has finished.
- A human publish gate exists **outside the task worktree** (for example `/tmp/cba-gate-<n>.json`),
  written by the human owner, naming themselves, you, the base SHA and the exact ordered commits
  (`reviewedShas` must equal `commits`). You never write your own gate. A gate inside the repository
  is refused (`GATE_PATH_IN_REPO`): it would be an untracked file, and the dirty worktree it creates
  is itself a refusal. `.agent-handoff/publish-gates/` holds the schema and its example only.
- The reviewed commits are unchanged. **No amend, rebase or squash after review** — a finding
  produces a NEW fix-forward commit and a NEW gate.
- The worktree is clean and `npm test` passes. Do **not** append to `EVENTS.md`, update
  `CURRENT.md` or run `agent-refresh --record` in this worktree first — those files are tracked, so
  writing them here dirties the worktree and validation then refuses. That bookkeeping belongs to
  the main worktree or to a later commit.

## Steps

```bash
# 1. advisory local validation — this is all it does
node bin/cli.js agent-publish --role executor --executor <agent-id> \
  --gate /tmp/cba-gate-<n>.json

# 2. PREPARE the script. Writes one file to /tmp (0600, NOT executable) and prints its SHA-256.
#    No network call, no git or GitHub mutation.
node bin/cli.js agent-human-publish-script --role executor --executor <agent-id> \
  --gate /tmp/cba-gate-<n>.json
```

Then **stop and hand off** with a `REVIEW_REQUEST` (see
[`../../../.agent-handoff/templates/message.md`](../../../.agent-handoff/templates/message.md)):

- the path of the generated script and its **SHA-256**;
- the issue, branch, base SHA and the exact ordered commits it is bound to;
- the gate id and its expiry;
- the exact **verify-and-run command** the tool printed, verbatim. Never hand over `bash <path>`:
  it reopens the file after the reviewer hashed it, so a same-user process could substitute it and
  the human would run arbitrary commands under their own git and GitHub credentials;
- `STATUS`, `NEXT_OWNER` (Codex), `PROHIBITED_ACTIONS`, validation evidence and residual risks;
- an explicit statement that you have not operated it and will not until Zamp's gate arrives.

## Operating it, after the gate

When — and only when — Zamp sends `HUMAN_GATE_GRANTED` naming this exact branch, these exact ordered
full SHAs, this digest and an unexpired window, run the **verify-and-run command the tool printed**.
It reads the artifact once, checks the digest and executes those same bytes. Nothing else is a
supported way to run it.

Then report an `OPERATION_RESULT` with the landed branch ref, the pull request number and CI status,
no secrets, and `MERGED: no — merge is Zamp's decision`.

## Hard limits

Do not, under any framing or approval:

- run the script before an exact `HUMAN_GATE_GRANTED`, or reproduce its git/gh commands by hand;
- approve your own work, or treat `REVIEW_APPROVED` or a generic "approved" as a gate;
- push `main`, force-push, merge, deploy, or change repository settings or branch protection;
- `chmod +x` the script, move it into the repository, or write it anywhere but `/tmp`;
- edit a generated script. If it is wrong, fix the generator, add a test, and regenerate.

If you are told to publish without a gate that names the exact ordered full SHAs, say so and ask
for the `HUMAN_GATE_GRANTED`. Being the operator does not make you the approver.

## If preparation is refused

The command fails closed and prints a code. Common ones: `GATE_EXPIRED` (ask for a new gate),
`COMMIT_SET_DRIFT`/`HEAD_DRIFT` (history changed after review — a new review and gate are needed),
`REMOTE_BASE_DRIFT` (`origin/main` moved), `WORKTREE_DIRTY`, `WORKTREE_SHARED`,
`GATE_PATH_IN_REPO` (the gate must live outside the worktree), `GATE_PATH_SYMLINK` (pass the real
path, not a link), `REPO_ORIGIN_MISMATCH` or
`ORIGIN_UNRESOLVED` (the repository must be the origin this branch pushes to),
`OUTPUT_PATH_EXISTS` (a previous artifact is still there — the human should delete it),
`SCRIPT_SELF_CHECK_FAILED` (a generator defect; report it, do not work around it).

Never work around a refusal. Report it and let the human decide.

## Honesty requirement

`--role` and `--executor` are values you supply; nothing authenticates them. When you describe this
control, say it is a **process guardrail**, not mechanical identity separation. Authenticated
identity and remote enforcement are #91 Stage B and do not exist yet.
