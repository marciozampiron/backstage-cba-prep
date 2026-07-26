# Agent Handoff Protocol

This folder is the local coordination layer for agents working in this repository. It does not
replace GitHub Issues or the Project board. Issues and the board remain the source of truth for
scope, priority, and completion state.

Use this folder to make agent work discoverable without relying on a human to re-route every
context packet.

## Required boot sequence

Every agent must read, in order:

1. `AGENTS.md`;
2. `.agent-handoff/MESSAGE-PROTOCOL.md` — **canonical** roles and message contract;
3. `.agent-handoff/README.md`;
4. `.agent-handoff/CURRENT.md`;
5. `.agent-handoff/COMMANDS.md`;
6. any relevant task file under `.agent-handoff/inbox/` or `.agent-handoff/active/`.

If those files disagree with local git state or the GitHub issue, stop and report the mismatch
before editing.

## Directory model

| Path | Purpose |
| --- | --- |
| `CURRENT.md` | Short repo coordination state for agents entering cold. |
| `EVENTS.md` | Append-only log of meaningful state changes. |
| `MESSAGE-PROTOCOL.md` | **Canonical** actors, authority and the `AGENT-HANDOFF v1` message contract. |
| `COMMANDS.md` | Operational command checklist for boot, validation, commit, and push gate. |
| `inbox/` | Tasks prepared for an agent to pick up. |
| `active/` | Tasks currently owned by an agent. Do not duplicate ownership. |
| `done/` | Completed handoffs with final validation, commit SHA, and follow-ups. |
| `decisions/` | Lightweight decisions that are useful for agents but do not require an ADR. |
| `templates/` | Copyable task/decision templates. |

## State refresh cadence

Agents must refresh coordination state:

- at startup;
- before editing files;
- before switching from one task/issue to another;
- before commit;
- before push;
- after any command that changes git state;
- every 5 minutes during long-running work.

Preferred refresh command:

```bash
npm run agent-refresh
# or, for machine-readable output:
node bin/cli.js agent-refresh --json
# to intentionally write an audit event even when nothing changed:
npm run agent-refresh -- --record
```

Manual refresh means:

1. re-read `.agent-handoff/CURRENT.md`;
2. check `.agent-handoff/active/`;
3. run `git status --short --branch`;
4. run `git log --oneline origin/main..HEAD`;
5. stop if state conflicts with local work.

After any meaningful state change, update `CURRENT.md` and append an entry to `EVENTS.md`. Use `--record` sparingly when a human wants an explicit refresh audit entry even if state did not change.

Do not hardcode published (`origin/main`) **or** unpublished/amendable local commit SHAs in `CURRENT.md` — a pinned SHA goes stale on the next push. Use `git rev-parse --short origin/main` for the current published baseline and `git log --oneline origin/main..HEAD` for exact local commits.

## Publication protocol (#91 Stage A, #93 operator bridge)

Roles and messages are canonical in [`MESSAGE-PROTOCOL.md`](MESSAGE-PROTOCOL.md). The mechanism is
canonical in
[`../docs/architecture/agent-publication-runbook.md`](../docs/architecture/agent-publication-runbook.md).
This section is the short operational summary; it does not restate either.

`Opus prepares -> Codex reviews -> Zamp approves -> Opus executes -> Zamp decides/performs merge`

Three layers exist and they must not be confused:

| Layer | What it is |
| --- | --- |
| #91 Stage A — `agent-publish` | Validates a gate against local state, prints the plan, stops. |
| #93 bridge — `agent-human-publish-script` | Opus prepares a bounded artifact under `/tmp`; Codex reads it; Zamp gates it; Opus then operates it with the printed verify-and-run command. |
| #91 Stage B — remote enforcement | Authenticated operator identity, gate consumption, required PR, `enforce_admins`. Not built yet. |

Stage A is **local advisory pre-flight validation only**. It never publishes, never opens a pull
request, never consumes a gate and never authenticates identity — the declared role and executor
come from the caller, and any caller can declare `executor`. The #93 bridge does not change that:
it adds a reviewable artifact and a gate, not an authenticated identity. Both are process
guardrails, and only Stage B makes the separation unforgeable. **Until Stage B ships, no operation
is authorized without an explicit `HUMAN_GATE_GRANTED` naming the exact ordered full SHAs, and
merge is always Zamp's.** The 2026-07-26 incident is the reason all of this exists: a generic
approval was read by the architect agent as permission to `git push origin main`, and two agents
then raced on `git commit --amend` in a shared worktree.

Mechanics:

1. Each task gets its own branch AND worktree: `git worktree add ../cba-issue-<n> -b task/<n>-<slug> main`.
2. Zamp writes the **review scope** manifest **outside the task worktree** — for example
   `/tmp/cba-scope-<issue>.json` — naming themselves, the executor, the base SHA and the exact
   ordered commits. **This bounds what may be prepared; it authorizes nothing.** The schema lives in `publish-gates/README.md`, but that folder holds the schema
   and its example only. A gate written inside the repository would be an untracked file, which
   makes the worktree dirty, which validation then refuses; an in-repository or symlinked gate path
   is refused outright so the protocol cannot drift back into being unexecutable.
3. Opus runs `node bin/cli.js agent-publish --role executor --executor <id> --gate <file>`.
   It **validates locally and prints the plan** — it refuses architect/reviewer roles before `.env`
   loads, before the gate is read and before git runs, refuses `main` as a source, and fails closed
   on executor mismatch, base drift, extra/reordered commits, a dirty worktree, an expired gate, a
   `reviewedShas` set that does not equal the commits, a shared worktree or a drifted `origin/main`.
4. **Validation is not publication.** Opus prepares the artifact:
   `node bin/cli.js agent-human-publish-script --role executor --executor <id> --gate <file>`.
   It re-runs the Stage A validation, refuses a gate whose approver is the operator, writes one bash
   file to `/tmp` with mode `0600` and **no** executable bit, and prints the path, its SHA-256 and
   the verify-and-run command. It makes no network call and no Git or GitHub mutation.
5. Codex **reads** that file, confirms the SHA-256, and sends `FINDINGS` or `REVIEW_APPROVED`.
   Reviewing is not implementing and not executing, and `REVIEW_APPROVED` is never a gate.
6. Zamp writes the **execution gate** — a second manifest, outside the worktree, written *after*
   review because it names the artifact's digest:

   ```json
   { "type": "HUMAN_GATE_GRANTED", "gateId": "gate-93-001", "issue": 93,
     "sourceBranch": "task/93-slug", "targetBranch": "main", "approver": "<canonical approver>",
     "commits": ["<full sha>"], "artifactDigest": "<sha256 of the artifact>",
     "expiresAt": "2026-07-27T02:00:00Z" }
   ```

   The schema is closed: exactly those nine keys, a `[a-z0-9._-]` gate id, 64 lowercase hex for the
   digest, full 40-character lowercase SHAs, strict RFC3339 with `Z` or an offset, and at most 12
   hours.
7. Opus operates it, supplying that gate:

   ```bash
   export CBA_EXECUTION_GATE=/tmp/cba-gate-<issue>.json
   # then the verify-and-run command printed in step 4, verbatim
   ```

   That command reads the artifact once, checks its digest, exports it as `CBA_ARTIFACT_DIGEST`, and
   executes those same bytes. The artifact reads the execution gate **once** into a snapshot and
   validates it — including its own expiry — both before the confirmation and again immediately
   before the push. There is no supported bare-path invocation. The artifact re-verifies local and live remote state before *and* after the operator
   confirmation, then has exactly **two** bounded remote effects: pushing the reviewed commit by
   SHA, and creating or reusing exactly one pull request. It can never merge, deploy, push `main`,
   force-push, rewrite history, change repository settings or read secrets.
8. The task worktree stays clean throughout. Bookkeeping that changes tracked files —
   `EVENTS.md`, `CURRENT.md`, `agent-refresh --record` — belongs to the main worktree or to a
   later commit, never to the task worktree before generation.
9. **Zamp decides and performs the merge**, after required checks.
10. `git config core.hooksPath .githooks` enables a local pre-push refusal for direct `main` pushes.
    That hook is defense in depth — absent from fresh clones and skippable. Remote branch protection
    (#91 Stage B) is authoritative.

## Push gate

`agent-refresh` and `agent-refresh --record` check technical state only. They do **not** authorize
an operation. Authorization is a `HUMAN_GATE_GRANTED` from Zamp naming the exact ordered full SHAs;
see [`MESSAGE-PROTOCOL.md`](MESSAGE-PROTOCOL.md).

Before any operation:

1. Zamp must send `HUMAN_GATE_GRANTED` and author the gate manifest outside the task worktree. A
   generic "approved", or a Codex `REVIEW_APPROVED`, is review feedback and never a gate.
2. No agent operates without that gate, and no agent merges. Opus validates with `agent-publish`,
   prepares with `agent-human-publish-script`, and operates only the prepared artifact — which can
   publish only `task/<issue>-<slug>` and open or reuse one PR.
3. `EVENTS.md` bookkeeping — the gate entry and `npm run agent-refresh -- --record` — is recorded in
   the **main worktree**, or in a later commit on the task branch. It must not happen in the task
   worktree before generation: those files are tracked, so writing them there makes the worktree
   dirty and validation then refuses. Recording the gate does not authorize anything; Zamp's
   `HUMAN_GATE_GRANTED` does.
4. After operating, Opus reports an `OPERATION_RESULT` with branch/PR/CI evidence and no secrets,
   and records it in `EVENTS.md` from the main worktree.
5. Zamp decides and performs the merge (`MERGE_DECISION`).

If any step is missing, do not operate.

## Task lifecycle

1. Create a handoff file in `inbox/` when work needs to be delegated.
2. The executor moves or copies it to `active/` when taking ownership.
3. The executor updates the file while working: files touched, commands run, validation, risks.
4. When complete, move it to `done/` and include the final commit SHA or state.
5. Update the GitHub issue/board after the human gate approves push/merge.

## Non-negotiable rules

- Never push without explicit human approval.
- Never edit around another active handoff that owns the same issue, files, or architectural area.
- Do not change CBA exam facts without official Backstage docs / LF blueprint evidence.
- Keep DDD boundaries intact: `domain/` and `application/` stay provider/runtime neutral.
- For AI/provider/AWS work, keep SDKs and runtime adapters in infrastructure boundaries.
- For SaaS UX work, learner-facing screens must feel like a study platform, not an agent console.

## Final report requirements

Every completed handoff should record:

- issue/task number;
- owner/agent;
- files changed;
- validation commands and result;
- commit SHA, if any;
- push/CI status, if applicable;
- unresolved risks or follow-ups.
