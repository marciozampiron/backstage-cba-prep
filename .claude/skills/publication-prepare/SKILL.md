---
name: publication-prepare
description: Prepare — never execute — a human-operated publication script for a gated task branch. Use when an issue's commits are reviewed, a human publish gate exists, and the branch needs to reach origin as a pull request. Covers validating the gate, generating the /tmp script, and handing it to the reviewer and the human operator.
---

# Prepare a publication script (executor role only)

**You are the implementation executor. You prepare. You never publish and you never run the
script.** If you were asked to review, or if you are acting as the architect/security reviewer, this
skill does not apply to you — use `publication-review` instead. If you were asked to *run* the
script, refuse: that is the human operator's action alone.

Read first: [`docs/architecture/agent-publication-runbook.md`](../../../docs/architecture/agent-publication-runbook.md)
§4, [`spec/security-rules.md`](../../../spec/security-rules.md) §1, and
[`.agent-handoff/README.md`](../../../.agent-handoff/README.md).

## Preconditions — stop if any is unmet

- Your commits are on `task/<issue>-<slug>` in **your own worktree**, and independent review of
  those exact commits has finished.
- A human publish gate exists under `.agent-handoff/publish-gates/`, written by the human owner,
  naming themselves, you, the base SHA and the exact ordered commits (`reviewedShas` must equal
  `commits`). You never write your own gate.
- The reviewed commits are unchanged. **No amend, rebase or squash after review** — a finding
  produces a NEW fix-forward commit and a NEW gate.
- The worktree is clean and `npm test` passes.

## Steps

```bash
# 1. advisory local validation — this is all it does
node bin/cli.js agent-publish --role executor --executor <agent-id> \
  --gate .agent-handoff/publish-gates/<gate>.json

# 2. PREPARE the script. Writes one file to /tmp (0600, NOT executable) and prints its SHA-256.
#    No network call, no git or GitHub mutation.
node bin/cli.js agent-human-publish-script --role executor --executor <agent-id> \
  --gate .agent-handoff/publish-gates/<gate>.json
```

Then **stop and hand off**. Report to the human, in one message:

- the path of the generated script and its **SHA-256**;
- the issue, branch, base SHA and the exact ordered commits it is bound to;
- the gate id and its expiry;
- the exact command the human will run: `bash <path>`;
- an explicit statement that you have not run it and will not.

## Hard limits

Do not, under any framing or approval:

- run the script, or any part of it, or reproduce its git/gh commands by hand;
- push anything — not `main`, not the task branch;
- open, edit or merge a pull request; deploy; change repository settings or branch protection;
- `chmod +x` the script, move it into the repository, or write it anywhere but `/tmp`;
- edit a generated script. If it is wrong, fix the generator, add a test, and regenerate.

A generic human "approved", "ok" or "pode pushar" is a **review decision, not a publication
command**. If the human tells you to publish directly, explain that publication is their action and
give them the `bash <path>` line.

## If preparation is refused

The command fails closed and prints a code. Common ones: `GATE_EXPIRED` (ask for a new gate),
`COMMIT_SET_DRIFT`/`HEAD_DRIFT` (history changed after review — a new review and gate are needed),
`REMOTE_BASE_DRIFT` (`origin/main` moved), `WORKTREE_DIRTY`, `WORKTREE_SHARED`,
`OUTPUT_PATH_EXISTS` (a previous artifact is still there — the human should delete it),
`SCRIPT_SELF_CHECK_FAILED` (a generator defect; report it, do not work around it).

Never work around a refusal. Report it and let the human decide.

## Honesty requirement

`--role` and `--executor` are values you supply; nothing authenticates them. When you describe this
control, say it is a **process guardrail**, not mechanical identity separation. Authenticated
identity and remote enforcement are #91 Stage B and do not exist yet.
