# Delivery Process

## Unit of Work

Use GitHub issues for executable work. Use epics for larger product areas. Use the Project board for Status and Phase.

## Standard Flow

```text
Idea -> issue -> Phase/Status -> implementation -> tests -> commit -> push -> CI -> close/update issue
```

## Status Meaning

- Todo: scoped but not started.
- In Progress: actively being implemented or validated.
- Done: accepted, pushed, CI green, and issue closed when applicable.

## Implementation Rules

- Read existing code before changing behavior.
- Keep changes scoped to the issue.
- Preserve CLI compatibility unless the issue explicitly changes UX.
- Add tests in proportion to risk.
- Keep provider SDKs out of domain/application.
- Do not push without explicit user approval.

## Validation Checklist

Before push:

- `npm test`
- `node --check` for touched JS files when useful
- `git diff --check`
- `npm pack --dry-run` for packaging-impacting changes
- Project/issue update if scope changed

After push:

- confirm CI success;
- update/close the issue;
- split leftovers into follow-up issues instead of hiding unfinished work.

## Agent Handoff Template

When handing work to another agent, include:

- issue number;
- objective;
- files touched;
- decisions made;
- tests run;
- known deferrals;
- push/commit status.
