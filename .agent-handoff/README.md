# Agent Handoff Protocol

This folder is the local coordination layer for agents working in this repository. It does not
replace GitHub Issues or the Project board. Issues and the board remain the source of truth for
scope, priority, and completion state.

Use this folder to make agent work discoverable without relying on a human to re-route every
context packet.

## Required boot sequence

Every agent must read, in order:

1. `AGENTS.md`;
2. `.agent-handoff/README.md`;
3. `.agent-handoff/CURRENT.md`;
4. `.agent-handoff/COMMANDS.md`;
5. any relevant task file under `.agent-handoff/inbox/` or `.agent-handoff/active/`.

If those files disagree with local git state or the GitHub issue, stop and report the mismatch
before editing.

## Directory model

| Path | Purpose |
| --- | --- |
| `CURRENT.md` | Short repo coordination state for agents entering cold. |
| `EVENTS.md` | Append-only log of meaningful state changes. |
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

## Publication protocol (#91 Stage A, #93 human-operated bridge)

Three layers exist and they must not be confused:

| Layer | What it is | Who acts |
| --- | --- | --- |
| #91 Stage A — `agent-publish` | Validates a gate against local state, prints the plan, stops. | executor runs it |
| #93 bridge — `agent-human-publish-script` | The executor **prepares** a bounded script under `/tmp`; the reviewer **reads** it; the **human** runs it with `bash <path>`. | executor prepares, reviewer reads, human runs |
| #91 Stage B — remote enforcement | Authenticated bot identity, gate consumption, required PR, `enforce_admins`. | not built yet |

Stage A is **local advisory pre-flight validation only**. It never publishes, never opens a pull
request, never consumes a gate and never authenticates identity — the declared role and executor
come from the caller, and any caller can declare `executor`. The #93 bridge does not change that:
it adds a reviewable artifact, not an authenticated identity. Both are process guardrails, and only
Stage B makes the separation unforgeable. **Until Stage B ships, publication and merge are human
actions.** The 2026-07-26 incident is the reason all of this exists: a generic human approval was
read by the architect agent as permission to `git push origin main`, and two agents then raced on
`git commit --amend` in a shared worktree.

| Role | May | May never |
| --- | --- | --- |
| Human product/security owner | Approve a gate naming themselves; run the prepared script; merge the PR | Delegate merge or script execution to an agent |
| Implementation executor | Commit on `task/<issue>-<slug>`; run `agent-publish`; **prepare** a publication script | Push, merge, deploy, spend, **run the prepared script**, or publish without a gate |
| Architect/security reviewer | Review by full SHA, **read** a prepared script, create roadmap issues, recommend a gate | Publish, merge, act as executor, **prepare or run a script** |

Mechanics:

1. Each task gets its own branch AND worktree: `git worktree add ../cba-issue-<n> -b task/<n>-<slug> main`.
2. The human owner writes a publish gate under `.agent-handoff/publish-gates/` (schema in that
   folder's README) naming themselves, the executor, the base SHA and the exact ordered commits.
3. The executor runs `node bin/cli.js agent-publish --role executor --executor <id> --gate <file>`.
   It **validates locally and prints the plan** — it refuses architect/reviewer roles before `.env`
   loads, before the gate is read and before git runs, refuses `main` as a source, and fails closed
   on executor mismatch, base drift, extra/reordered commits, a dirty worktree, an expired gate, a
   `reviewedShas` set that does not equal the commits, a shared worktree or a drifted `origin/main`.
4. **Validation is not publication.** To publish, the executor prepares a script:
   `node bin/cli.js agent-human-publish-script --role executor --executor <id> --gate <file>`.
   It re-runs the Stage A validation, writes one bash file to `/tmp` with mode `0600` and **no**
   executable bit, and prints the path and its SHA-256. It makes no network call and no Git or
   GitHub mutation.
5. The architect/security reviewer **reads** that file and confirms the SHA-256. Reviewing is not
   implementing and not executing.
6. The **human operator** runs it explicitly: `bash /tmp/cba-publish-<issue>-<head>.sh`. It requires
   an interactive terminal and a typed confirmation, re-verifies local and live remote state, then
   does exactly one mutation — a non-force push of the task branch — and creates or reuses exactly
   one pull request. It can never merge, deploy, push `main`, force-push, rewrite history, change
   repository settings or read secrets.
7. Merging is always a separate human action, after checks and review.
8. `git config core.hooksPath .githooks` enables a local pre-push refusal for direct `main` pushes.
   That hook is defense in depth — absent from fresh clones and skippable. Remote branch protection
   (#91 Stage B) is authoritative.

## Push gate

`agent-refresh` and `agent-refresh --record` check technical state only. They do **not** authorize a push. Push permission is a human decision.

Before any push:

1. The human must explicitly approve push in chat.
2. The agent must append a `Human gate` event to `EVENTS.md` listing the approved commits or scope.
3. The agent must run `npm run agent-refresh -- --record` immediately before publication.
4. **Agents never push, and never run the prepared script.** The executor validates the gate with
   `agent-publish`, then prepares a script with `agent-human-publish-script`. Only the human runs
   it, and it can only publish `task/<issue>-<slug>` and open or reuse one PR. Merging is a human
   action. Publication to `main` happens solely through a human-merged pull request.
5. After push, the agent must record push and CI status in `EVENTS.md`.

If any step is missing, do not push.

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
