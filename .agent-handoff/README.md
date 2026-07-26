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

## Publication protocol (#91)

Stage A is **local advisory pre-flight validation only**. It never publishes, never opens a pull
request, never consumes a gate and never authenticates identity — the declared role and executor
come from the caller. Authoritative separation is Stage B (executor bot credential, live remote
checks, idempotent gate consumption, branch protection). **Until Stage B ships, publication and
merge are human actions.** The 2026-07-26 incident — a generic
human approval read by the architect agent as permission to `git push origin main`, followed by two
agents racing on `git commit --amend` in a shared worktree — is the reason.

| Role | May | May never |
| --- | --- | --- |
| Human product/security owner | Approve a gate naming themselves; merge the PR | Delegate merge authority to an agent |
| Implementation executor | Commit on `task/<issue>-<slug>`; run `agent-publish` with a valid gate | Push `main`, merge, deploy, spend, or publish without a gate |
| Architect/security reviewer | Review by full SHA, create roadmap issues, recommend a gate | Publish any source branch, merge, or act as executor |

Mechanics:

1. Each task gets its own branch AND worktree: `git worktree add ../cba-issue-<n> -b task/<n>-<slug> main`.
2. The human owner writes a publish gate under `.agent-handoff/publish-gates/` (schema in that
   folder's README) naming themselves, the executor, the base SHA and the exact ordered commits.
3. The executor runs `node bin/cli.js agent-publish --role executor --executor <id> --gate <file>`.
   It **validates locally and prints the plan** — it refuses architect/reviewer roles before `.env`
   loads, before the gate is read and before git runs, refuses `main` as a source, and fails closed
   on executor mismatch, base drift, extra/reordered commits, a dirty worktree, an expired gate, a
   `reviewedShas` set that does not equal the commits, a shared worktree or a drifted `origin/main`.
4. **Validation is not publication.** Stage A stops there. Once Stage B exists, the executor bot
   credential pushes the task branch and opens/updates the PR; today that step is a human action.
5. Merging is always a human action.
6. `git config core.hooksPath .githooks` enables a local pre-push refusal for direct `main` pushes.
   That hook is defense in depth — absent from fresh clones and skippable. Remote branch protection
   (#91 Stage B) is authoritative.

## Push gate

`agent-refresh` and `agent-refresh --record` check technical state only. They do **not** authorize a push. Push permission is a human decision.

Before any push:

1. The human must explicitly approve push in chat.
2. The agent must append a `Human gate` event to `EVENTS.md` listing the approved commits or scope.
3. The agent must run `npm run agent-refresh -- --record` immediately before publication.
4. **Agents never push `main`.** The executor validates the gate with `agent-publish` and, once
   Stage B ships, publishes only `task/<issue>-<slug>` and opens/updates a PR. Merging is a human
   action. Until Stage B, publication to `main` is performed by the human owner alone.
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
