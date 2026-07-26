# Publish Gates (#91, #93)

A publish gate is the machine-readable form of a human publication decision.

## Two documents, not one

A single manifest could not be both the scope of a review and the authorization to operate. It has
to exist **before** the artifact is generated — the artifact is built from it — so it can never name
the artifact's digest, and when it is written nothing has been reviewed yet. That made the
authorization circular.

| | Review scope manifest | **Execution gate** |
| --- | --- | --- |
| Written | before preparation | after review |
| Answers | which commits may be prepared? | may THIS artifact run, now? |
| Filename convention | `/tmp/cba-scope-<n>.json` | `/tmp/cba-gate-<n>.json` |
| Supplied as | `--gate` | `CBA_EXECUTION_GATE` |
| Schema | the one documented below | a **separate, closed nine-key schema** |
| Read by | `agent-publish` and `agent-human-publish-script` | the artifact itself, at run time |

Stage A does not consume a gate, and neither does the artifact: both documents are validated, and the
same file would validate twice. Bounded expiry and the digest binding narrow the window instead.
Idempotent consumption belongs to #91 Stage B.

**The two are different documents, not one document with optional extras.** The execution gate is a
closed set of exactly nine keys — `type`, `gateId`, `issue`, `sourceBranch`, `targetBranch`,
`approver`, `commits`, `artifactDigest`, `expiresAt` — and the artifact refuses any key outside that
set, so a review-scope manifest is not a valid execution gate and neither is a gate carrying extra
fields. Its exact shape is in [`../templates/message.md`](../templates/message.md); the runbook §4.4
explains why there are two. Because it names a digest, an execution gate cannot be recycled for a
regenerated artifact, and it is validated by the artifact immediately before any effect.

The schema documented below is the **review scope**.

**This folder holds the schema and its example only — never a real gate.** A gate is authored by
Zamp **outside the task worktree** — the review scope as `/tmp/cba-scope-<issue>.json`, and the
execution gate as `/tmp/cba-gate-<issue>.json`, which is reserved for `CBA_EXECUTION_GATE` and is
never passed to `--gate`. This directory is
tracked and not ignored, so a gate written here would be an untracked file, which makes the worktree
dirty, which validation then refuses. `agent-human-publish-script` refuses an in-repository gate
path outright (`GATE_PATH_IN_REPO`) so the protocol cannot drift back into being unexecutable.

In **Stage A** the gate is only ever *validated*: `agent-publish` refuses to VALIDATE without one
and refuses anything the gate does not name exactly. It does not publish, does not open a pull
request and does not consume the gate. The `executor` field is compared against a **caller-declared**
identity — nothing authenticates it, so the field expresses intent, not proof.

In **Stage B** the same gate becomes the input to real publication under the executor bot
credential, with live remote checks and authoritative, idempotent consumption.

A gate is **evidence of a decision**, not a credential: it contains no token, no account id and no
administrative endpoint. It is the machine-readable form of a `HUMAN_GATE_GRANTED` message — see
[`../MESSAGE-PROTOCOL.md`](../MESSAGE-PROTOCOL.md), the canonical role and message contract.

The `approver` must be a named human who is **not** the operator: `agent-human-publish-script`
refuses a gate whose approver equals the invoking executor (`APPROVER_IS_OPERATOR`) or looks like an
agent identity (`APPROVER_NOT_HUMAN`). Approval and operation are different actors.

## Schema

| Field | Meaning |
| --- | --- |
| `gateId` | 3-64 chars of `[a-z0-9._-]`, echoed in evidence, refused if it looks like credential material (and never echoed when refused) |
| `issue` | integer issue number; must match the branch |
| `executor` | the agent identity authorized to publish — a gate is not transferable |
| `baseSha` | full 40-char SHA the branch was cut from; drift fails closed |
| `commits` | full 40-char SHAs, **ordered**, exactly what may be published |
| `sourceBranch` | `task/<issue>-<slug>`; never `main` |
| `targetBranch` | always `main` — the PR target, never a push destination |
| `approver` | the **named** human; generic words like `approved` are refused |
| `approvedAt` / `expiresAt` | strict RFC3339 with an offset; the window is capped at **12 hours** so a decision cannot authorize the next cycle |
| `reviewedShas` | **required**, non-empty, full SHAs, and must equal `commits` exactly and in order. An unreviewed fix-forward cannot ride along, and nothing reviewed can be silently dropped |

## Why each field exists

Every field maps to a way the 2026-07-26 incident could repeat:

- `executor` + role → the architect agent pushed when only the executor should have;
- `sourceBranch` + `targetBranch` → the push went to `main` instead of an issue branch;
- `commits` + `baseSha` → two agents amended shared history, so "the approved commits" became
  ambiguous;
- `approver` → a generic approval was read as a publication command;
- `expiresAt` → an approval for one cycle must not authorize the next;
- `reviewedShas` → a fix-forward commit added after review must not ride along silently.

## Lifecycle

**Stage A (today, local and advisory):**

1. The executor finishes work on `task/<issue>-<slug>` in its own worktree.
2. An independent reviewer reads the branch and reports findings, identifying commits by full SHA.
3. The **human owner** writes the gate outside the worktree, naming themselves as `approver`.
4. The executor runs `agent-publish` — it **validates locally and stops**. Validation fails closed
   on any drift.

**The #93 bridge (today, how publication actually happens):**

5. **Opus** runs `agent-human-publish-script` and *prepares* a script under `/tmp`, mode `0600`
   and non-executable, then reports its path and SHA-256 in a `REVIEW_REQUEST`. Preparing is not
   publishing.
6. **Codex** *reads* the script and confirms the digest, then sends `FINDINGS` or
   `REVIEW_APPROVED`. A `REVIEW_APPROVED` never authorizes publication.
7. **Zamp** sends `HUMAN_GATE_GRANTED` with the exact branch, ordered full SHAs, digest, expiry and
   allowed effects. **Opus** then operates it with the verify-and-run command printed at
   preparation, which reads the file once, checks its digest and executes those same bytes. There
   is no supported bare-path invocation. **Zamp** decides and performs the merge.

**Stage B (not built; separate human gate):**

8. An executor bot credential performs the push and PR under an authenticated identity, with
   authoritative, idempotent gate consumption and remote branch protection.

Until Stage B exists, Opus performs the push under Zamp's execution gate, and Zamp performs the
merge. Neither is authorized by the review scope alone.

A gate is bound to a specific commit sequence. A new commit — including a fix-forward after
review — needs a new gate.

## What a gate does NOT do (Stage A)

A gate is validated, never **consumed**: the same file passes twice. Authoritative, idempotent
consumption belongs to Stage B, together with the live-remote base check and the executor bot
credential. Stage A validation is advisory — see
`docs/architecture/agent-publication-runbook.md` §3 for the full list of deferred properties.
