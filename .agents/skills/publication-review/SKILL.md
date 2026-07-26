---
name: publication-review
description: Review — never generate and never run — a human-operated publication script prepared by the implementation executor. Use when the executor hands over a /tmp script and its SHA-256 for a gated task branch, before the human operator runs it. Read-only.
---

# Review a publication script (architect/security reviewer role only)

**You review. You never prepare and you never run.** Generating a script is the implementation
executor's action; running it is the human operator's. If you are asked to do either, refuse and say
which role owns it. `agent-publish` and `agent-human-publish-script` both refuse your declared role
before reading a gate, running git or writing a file — that refusal is expected, not an obstacle to
route around.

Read first: [`docs/architecture/agent-publication-runbook.md`](../../../docs/architecture/agent-publication-runbook.md)
§4, [`spec/security-rules.md`](../../../spec/security-rules.md) §1, and the issue and handoff file.

## What you are given

The executor reports a `/tmp` path, a SHA-256, the issue, branch, base SHA and the exact ordered
commits. Everything else you verify yourself.

## Review checklist

Read the file. It is short and bounded by design; read all of it.

1. **Integrity.** Recompute the digest — `sha256sum <path>` — and compare it with the one reported.
   A mismatch means the file changed after preparation: refuse and report it as a finding.
2. **Permissions.** `ls -l <path>` must show `-rw-------` and **no executable bit**. An executable
   or group/world-readable artifact is a finding.
3. **Location.** It must be directly under `/tmp`, never inside the repository or a symlink target.
4. **Binding.** The embedded `REPO`, `ISSUE`, `SOURCE_BRANCH`, `TARGET_BRANCH`, `BASE_SHA`,
   `EXPECTED_HEAD` and `REVIEWED_SHAS` must match the gate and the commits you actually reviewed —
   same SHAs, same order, no extras. `SOURCE_BRANCH` is `task/<issue>-<slug>`; `TARGET_BRANCH` is
   `main`.
5. **The single mutation.** Exactly one push, of `refs/heads/<branch>:refs/heads/<branch>`, without
   force. Anything else is a finding.
6. **Forbidden operations, by reading rather than by trust.** There must be no merge, no deploy or
   workflow dispatch, no push to `main`/`master`, no `--force`/`--force-with-lease`/`+refs/`, no
   `rebase`/`reset --hard`/`commit --amend`/`filter-branch`, no `gh api` against branches, rulesets,
   protection, secrets or environments, no `gh repo edit`, no token or credential assignment, no
   `gh auth`, and no paid-service call.
7. **Guards.** The script must refuse a non-interactive stdin, refuse an expired gate, require the
   correct clean and exclusive worktree, require HEAD and the ordered commit set to match, re-check
   the live `origin/main` against the base, refuse a push that would discard remote commits, and
   require a typed confirmation before the push.
8. **Pull request handling.** It creates one PR, or reuses a single existing open one only after
   confirming its base and head. It must never touch a PR with a different base or head, and must
   never merge.
9. **Leakage.** No token, key, account id or other secret material anywhere in the file. Branch
   names, SHAs and the gate id are expected and fine.

## Reporting

Lead with findings, ordered critical/high/medium/low, each with the line, the exploit path, the
impact, the violated control ID and a focused remediation. If there are none, say so plainly and
state the residual risk — at minimum: the declared role is caller-supplied, nothing prevents a
non-cooperating agent from running the script, and `main` is still unprotected until #91 Stage B.

Your review is **evidence for the human gate, never the gate itself**. End by naming the next
action and its owner: the human operator runs `bash <path>`, and merges separately afterwards.

## Hard limits

- Never run the script, any part of it, or an equivalent command by hand.
- Never generate or regenerate a script, and never edit one. A defect is fixed by the executor in
  the generator, with a test, followed by a new preparation and a new review.
- Never push, merge, deploy, or act as the human approval gate.
- Reviewed commits are immutable: findings produce a NEW fix-forward commit and a NEW gate, never an
  amend, rebase or squash of reviewed history.
