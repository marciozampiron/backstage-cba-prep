# Publish Gates (#91)

A publish gate is the machine-readable form of a human publication decision.

In **Stage A** the gate is only ever *validated*: `agent-publish` refuses to VALIDATE without one
and refuses anything the gate does not name exactly. It does not publish, does not open a pull
request and does not consume the gate. The `executor` field is compared against a **caller-declared**
identity — nothing authenticates it, so the field expresses intent, not proof.

In **Stage B** the same gate becomes the input to real publication under the executor bot
credential, with live remote checks and authoritative, idempotent consumption.

A gate is **evidence of a decision**, not a credential: it contains no token, no account id and no
administrative endpoint.

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
3. The **human owner** writes the gate, naming themselves as `approver`.
4. The executor runs `agent-publish` — it **validates locally and stops**. Validation fails closed
   on any drift.

**Stage B (not built; separate human gate):**

5. The executor bot credential pushes the task branch and opens/updates the PR, after a live remote
   base check and authoritative gate consumption.
6. The **human owner** merges. Merge is never an agent action.

Until Stage B exists, steps 5 and 6 are both performed by the human owner.

A gate is bound to a specific commit sequence. A new commit — including a fix-forward after
review — needs a new gate.

## What a gate does NOT do (Stage A)

A gate is validated, never **consumed**: the same file passes twice. Authoritative, idempotent
consumption belongs to Stage B, together with the live-remote base check and the executor bot
credential. Stage A validation is advisory — see
`docs/architecture/agent-publication-runbook.md` §3 for the full list of deferred properties.
