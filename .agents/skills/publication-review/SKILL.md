---
name: publication-review
description: Review — never implement, prepare or execute — the publication artifact Opus prepared. Use when Opus sends a REVIEW_REQUEST with a /tmp path and its SHA-256 for a gated task branch, before Zamp grants the execution gate. Read-only; covers both code review and artifact review.
---

# Review a publication script (Codex — architect and independent reviewer, read-only)

**You review. You never implement, never prepare and never execute.** Preparing and operating the
script are Opus's actions, after an explicit Zamp gate; merge is Zamp's. If you are asked to
implement, prepare, execute, push, merge or deploy, refuse and name the role that owns it.
`agent-publish` and `agent-human-publish-script` both refuse your declared role before reading a
gate, running git or writing a file — that refusal is expected, not an obstacle to route around.

Your verdict is `FINDINGS` or `REVIEW_APPROVED`, and you may send Zamp a `GATE_RECOMMENDATION`.
**None of those authorizes publication.** Only Zamp's `HUMAN_GATE_GRANTED`, naming the exact ordered
full SHAs, does — and you never emit it.

Read first: [`.agent-handoff/MESSAGE-PROTOCOL.md`](../../../.agent-handoff/MESSAGE-PROTOCOL.md)
(canonical roles and messages),
[`docs/architecture/agent-publication-runbook.md`](../../../docs/architecture/agent-publication-runbook.md)
§4 (canonical mechanism), [`spec/security-rules.md`](../../../spec/security-rules.md) §1, and the
issue and handoff file.

## What you are given

The executor reports a `/tmp` path, a SHA-256, the issue, branch, base SHA and the exact ordered
commits. Everything else you verify yourself.

## Review checklist

Read the file. It is short and bounded by design; read all of it.

1. **Integrity.** Recompute the digest — `sha256sum <path>` — and compare it with the one reported.
   A mismatch means the file changed after preparation: refuse and report it as a finding.
   Your digest is only meaningful because the artifact is operated through the verify-and-run
   command, which re-reads it once and re-checks the same digest before executing those exact
   bytes. Confirm that the reported command does that, embeds the digest you verified, and exports
   it as `CBA_ARTIFACT_DIGEST` so the execution gate can be bound to these bytes. A handover that
   offers a bare-path invocation is a finding on its own.
   Your review has a `SCOPE`: `code` for the commits, `artifact` for these bytes. Say which. An
   approval of one is never an approval of the other.
2. **Permissions.** `ls -l <path>` must show `-rw-------` and **no executable bit**. An executable
   or group/world-readable artifact is a finding.
3. **Location.** It must be directly under `/tmp`, never inside the repository or a symlink target.
4. **Binding.** The embedded `REPO`, `ISSUE`, `SOURCE_BRANCH`, `TARGET_BRANCH`, `BASE_SHA`,
   `EXPECTED_HEAD`, `GATE_APPROVER` and `REVIEWED_SHAS` must match the gate and the commits you
   actually reviewed — same SHAs, same order, no extras. `SOURCE_BRANCH` is `task/<issue>-<slug>`;
   `TARGET_BRANCH` is `main`. `GATE_APPROVER` must be a named human who is **not** the operator; an
   approver equal to the executor, or an agent-shaped identity, is a finding.
   The push refspec must name `$EXPECTED_HEAD`, not a symbolic ref, and the landed remote ref must
   be read back and compared to it.
5. **Two bounded external effects, in order.** Exactly one push, of
   `refs/heads/<branch>:refs/heads/<branch>` and without force, then exactly one pull request
   created or reused. Anything else is a finding.
   - the script must bind its push target to its API target: `git remote get-url origin` is checked
     against the embedded `REPO` before either effect;
   - the open-pull-request set must be asserted **before** the push and re-asserted after it, with
     zero or exactly one match, not cross-repository, same owner, and exact base and head. `gh pr
     list --head` matches by branch name across forks, so identity has to be proven, not assumed.
6. **Forbidden operations, by reading rather than by trust.** There must be no merge, no deploy or
   workflow dispatch, no push to `main`/`master`, no `--force`/`--force-with-lease`/`+refs/`, no
   `rebase`/`reset --hard`/`commit --amend`/`filter-branch`, no `gh api` against branches, rulesets,
   protection, secrets or environments, no `gh repo edit`, no token or credential assignment, no
   `gh auth`, and no paid-service call.
7. **The execution gate.** The artifact must require `CBA_EXECUTION_GATE`, refuse a symlink or
   non-regular file, and validate that the gate is a `HUMAN_GATE_GRANTED` for this issue, branch and
   canonical approver, naming the reviewed commits exactly and in order, unexpired, bounded to 12
   hours, and carrying an `artifactDigest` equal to the digest of the bytes being run. A gate that
   could authorize a *different* artifact is a finding. Note that this gate is written **after** your
   review — the manifest read at preparation only bounded the scope.
8. **Guards.** The artifact must refuse an expired gate, require the
   correct clean and exclusive worktree, require HEAD and the ordered commit set to match, re-check
   the live `origin/main` against the base, refuse a push that would discard remote commits, and
   require a typed confirmation before the push.
9. **Re-validation after the confirmation.** Everything volatile — expiry, the origin binding, the
   live remote base and head, the pull-request set, HEAD and worktree cleanliness — must be checked
   AGAIN after the human types the confirmation, with nothing between that and the push. A prompt
   can sit open for hours. Each volatile check should be a function defined once and called twice;
   two copied blocks are a finding, because they drift.
10. **Pull request handling.** It creates one PR, or reuses a single existing open one only after
   confirming its base, head **and `headRefOid`** — a branch name is not a commit, and the branch can
   move between the push and the query. The remote ref and the pull request must both be re-verified
   against `EXPECTED_HEAD` after creation or reuse. It must never touch a PR with a different base or
   head, and must never merge.
11. **Leakage.** No token, key, account id or other secret material anywhere in the file. Branch
   names, SHAs and the gate id are expected and fine.

## Reporting

Lead with findings, ordered critical/high/medium/low, each with the line, the exploit path, the
impact, the violated control ID and a focused remediation. If there are none, say so plainly and
state the residual risk — at minimum: the declared role is caller-supplied, nothing prevents a
non-cooperating agent from running the script, and `main` is still unprotected until #91 Stage B.

Your review is **evidence for the human gate, never the gate itself**. End with `NEXT_OWNER` and
the next action: Zamp grants or withholds `HUMAN_GATE_GRANTED`; if granted, Opus operates it with
the **verify-and-run command**; Zamp then decides and performs the merge. Never tell anyone to
`bash <path>` — that reopens the file after you hashed it, so your digest would prove nothing about
the bytes that actually execute.

## Hard limits

- Never run the script, any part of it, or an equivalent command by hand.
- Never implement the reviewed delivery. Never generate, regenerate or edit a script. A defect is
  fixed by Opus in the generator, with a test, followed by a new preparation and a new review.
- Never push, merge, deploy, administer the repository, or grant the human gate.
- Reviewed commits are immutable: findings produce a NEW fix-forward commit and a NEW gate, never an
  amend, rebase or squash of reviewed history.
