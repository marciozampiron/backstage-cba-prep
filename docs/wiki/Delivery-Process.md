# Delivery Process

## Unit of Work

Use GitHub issues for executable work. Use epics for larger product areas. Use the Project board for Status and Phase.

## Standard Flow

```text
Idea -> issue -> Phase/Status -> implementation -> tests -> commit -> push -> CI -> close/update issue
```

## Pilot CI/CD Posture

The pilot uses a monorepo with separate GitHub Actions lanes by delivery boundary:

- `web/**` for Next.js build and deterministic web smokes;
- `src/**` and `bin/**` for CLI/core tests and no-spend AI readiness checks;
- `services/**` for future BFF/core/AI service tests and contract checks;
- `infra/aws/**` for AWS CDK synth/diff and IaC security checks;
- `docs/**` for ADR/product/contract consistency checks where useful.

AWS deploys use GitHub OIDC and environment gates. Default CI must not make paid model calls. See `docs/architecture/ci-cd-security-foundation.md`.

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
- When an AI agent materially contributed to the work, add a `Co-authored-by:` trailer to the commit message.

## Commit Attribution

Use commit trailers to keep the GitHub history honest about human and agent collaboration.

Standard Codex trailer:

```text
Co-authored-by: OpenAI Codex <codex@openai.com>
```

Known Claude trailer already used in this repository:

```text
Co-authored-by: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
```

GitHub only shows a contributor avatar when the email is associated with a GitHub account. Even when that mapping is unavailable, the trailer remains useful provenance in the commit history.

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
