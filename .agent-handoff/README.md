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
4. any relevant task file under `.agent-handoff/inbox/` or `.agent-handoff/active/`.

If those files disagree with local git state or the GitHub issue, stop and report the mismatch
before editing.

## Directory model

| Path | Purpose |
| --- | --- |
| `CURRENT.md` | Short repo coordination state for agents entering cold. |
| `EVENTS.md` | Append-only log of meaningful state changes. |
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

Refresh means:

1. re-read `.agent-handoff/CURRENT.md`;
2. check `.agent-handoff/active/`;
3. run `git status --short --branch`;
4. stop if state conflicts with local work.

After any meaningful state change, update `CURRENT.md` and append an entry to `EVENTS.md`.

Do not hardcode unpublished or amendable commit SHAs in `CURRENT.md`; use `git status` / `git log --oneline origin/main..HEAD` for the exact local SHA.

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
