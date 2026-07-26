# AGENT-HANDOFF v1 — canonical message protocol

This file is the **single source of truth** for who may say what to whom. Other files carry a short
role summary and link here; they must not restate this contract in full, because two copies drift.

Read this during the mandatory cold-start boot sequence, before taking any task.

Architecture and the publication mechanism itself live in
[`docs/architecture/agent-publication-runbook.md`](../docs/architecture/agent-publication-runbook.md).

## 1. Actors

| Actor | Role | Authority |
| --- | --- | --- |
| **Opus** (Claude Opus 5) | Implementation executor and publication operator | Implements, tests, commits fix-forward, prepares the reviewed script, and executes the exact verified bytes **only** after Codex review and an explicit Zamp gate |
| **Codex** (OpenAI Codex) | Architect, technical PM, independent technical/security reviewer | Owns architecture, roadmap/board consistency, and **read-only** review; reports findings or recommends a gate |
| **Zamp** | LT/CEO/CTO | Accepts residual risk, grants the exact publication gate, authorizes cloud/spend separately, and **decides and performs the merge** |
| **Gemini** | — | **No role** in implementation, review, approval, publication, merge, deploy or governance |

**Opus may never** self-review, self-approve, amend/rebase/squash reviewed commits, push `main`,
force-push, merge, deploy, administer the repository, access secrets, or invoke a paid service
through the publication script.

**Codex may never** implement the reviewed delivery, prepare or execute the publication script,
push, merge, deploy, or grant the human gate.

**Zamp** does not need to execute the publication script; Zamp approves and merges.

**Gemini** remains a supported **model provider** for question authoring (`src/lib/llm.js`,
`src/commands/generate.js`) and a supported CLI for tutoring. That is product functionality and is
untouched by this contract. Gemini simply never appears as a workflow actor.

## 2. Canonical flow

```
Opus prepares -> Codex reviews -> Zamp approves -> Opus executes -> Zamp decides/performs merge
```

## 3. Message types

| Type | Sender | Receiver | Purpose |
| --- | --- | --- | --- |
| `REVIEW_REQUEST` | Opus | Codex | Exact immutable SHAs and validation evidence |
| `FINDINGS` | Codex | Opus | Severity-ordered, file/line-grounded corrections |
| `REVIEW_APPROVED` | Codex | Zamp + Opus | Technical review passed; **never** grants publication |
| `GATE_RECOMMENDATION` | Codex | Zamp | Recommendation only; **never** a gate |
| `HUMAN_GATE_GRANTED` | Zamp | Opus | Exact branch, ordered full SHAs, digest, expiry and allowed effects |
| `OPERATION_RESULT` | Opus | Zamp + Codex | Actual branch/PR/CI evidence; merge remains untouched |
| `MERGE_DECISION` | Zamp | GitHub/human record | Final merge or no-merge decision |

**No actor may emit another actor's authoritative message.** `REVIEW_APPROVED` is a technical
verdict, not permission to publish. Generic text — "approved", "ok", "lgtm", "aprovado", "pode
pushar" — is review feedback and is **never** equivalent to `HUMAN_GATE_GRANTED`. Only a
`HUMAN_GATE_GRANTED` message with exact ordered full SHAs authorizes an operation.

**Review happens twice, and the two are not interchangeable.** `REVIEW_REQUEST`, `FINDINGS` and
`REVIEW_APPROVED` therefore carry a `SCOPE` field:

| `SCOPE` | What is read | Evidence |
| --- | --- | --- |
| `code` | the commits themselves | files, tests, control IDs |
| `artifact` | the generated publication bytes | the `/tmp` path, its SHA-256, permissions, the embedded bindings |

A `REVIEW_APPROVED` with `SCOPE: code` says nothing about the artifact, and vice versa.

**Two gates, not one.** The *review scope* manifest bounds what may be prepared and is consumed at
preparation. The *execution gate* is the `HUMAN_GATE_GRANTED` itself: written after review, it names
the **digest of the artifact** plus the exact ordered SHAs and a bounded expiry, and the artifact
reads and validates it at run time via `CBA_EXECUTION_GATE`. A single manifest could not do both —
it must exist before the artifact, so it cannot name the artifact's digest. See
[`publish-gates/README.md`](publish-gates/README.md) and the runbook §4.4.

## 4. Required envelope

Every operational handoff begins with `[AGENT-HANDOFF v1]` and includes at least:

| Field | Meaning |
| --- | --- |
| `TO` | receiving actor |
| `FROM` | sending actor |
| `ROLE` | the sender's role in this workflow |
| `TYPE` | one of the message types in §3 |
| `ISSUE` | GitHub issue number |
| `BRANCH` | `task/<issue>-<slug>` |
| `COMMITS` | exact full 40-character SHAs, in order, when applicable |
| `STATUS` | current state of the work |
| `NEXT_OWNER` | who acts next |
| `PROHIBITED_ACTIONS` | what this message does **not** authorize |

Review and operation messages additionally carry validation evidence and residual risks.

**Never include** secrets, tokens, account IDs, raw credentials, or mutable local SHA aliases. Use
full 40-character SHAs — a short alias can become ambiguous, and `HEAD` or a branch name means
something different tomorrow.

A copyable skeleton lives in [`templates/message.md`](templates/message.md).

## 5. Mechanical guards

`test/governance-model.test.js` reads every active operational source and fails if any of these
becomes true. Each is a prohibition, and the test exists because prose alone has already drifted
twice:

- a message type, sender, receiver or next owner must never diverge from §3;
- Gemini must never hold a collaboration, publication or governance role;
- Codex must never be instructed to implement, prepare, publish, push, merge or deploy;
- Opus must never be permitted to self-review, self-approve, merge, deploy, push `main`,
  force-push or administer the repository;
- Zamp must never be described as implementation executor or script operator;
- `REVIEW_APPROVED`, or a generic approval, must never be treated as a publication gate;
- a bare-path publication instruction must never be offered as supported;
- a template must never omit exact SHAs, status, next owner, prohibited actions, evidence or
  residual risks where required.

Append-only history — `EVENTS.md` and `done/` — may retain former workflows when clearly marked
historical. The guards read those as records, not as instructions.

This whole contract is a **process guardrail**. It is not authenticated: declared roles are
caller-supplied. #91 Stage B is what makes operator identity and remote enforcement unforgeable,
and it does not exist yet.
