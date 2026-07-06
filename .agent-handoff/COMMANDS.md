# Agent Command Reference

This file is the operational command checklist for agents working in this repository. It is a
companion to `README.md`, `CURRENT.md`, and `EVENTS.md`.

GitHub Issues and the Project board remain the source of truth for scope and priority.

## Required boot sequence

Run these commands before taking any task:

```bash
git pull
npm run agent-refresh
npm run agent-refresh -- --record
git status --short --branch
git log --oneline origin/main..HEAD
```

Read these files before editing:

```bash
cat AGENTS.md
cat .agent-handoff/README.md
cat .agent-handoff/CURRENT.md
cat .agent-handoff/EVENTS.md
cat .agent-handoff/COMMANDS.md
ls .agent-handoff/active
```

If `npm run agent-refresh` returns `blocked`, stop immediately, do not edit, do not commit, and
report the divergence.

## Before editing

```bash
npm run agent-refresh
git status --short --branch
git log --oneline origin/main..HEAD
```

Check ownership before editing:

```bash
ls .agent-handoff/active
```

## Before commit

```bash
npm run agent-refresh
npm test
git diff --check
npm run validate
npm run stats
```

Use targeted checks when relevant:

```bash
node --check <changed-js-file>
npm run agent-check -- --json
npm run bedrock-check -- --json
npm run generate -- --domain catalog --count 1 --dry-run
```

## Record a handoff checkpoint

Use `--record` only when an explicit audit checkpoint is useful:

```bash
npm run agent-refresh -- --record
```

This records technical state only. It does not authorize push.

## Commit flow

```bash
git status --short
git add <files>
git commit -m "docs: clear message"
git status --short --branch
git log --oneline origin/main..HEAD
```

Keep commits scoped to the approved task. Do not mix unrelated work.

## Push gate

Push is allowed only after explicit human approval for the exact commit or scope.

```bash
npm run agent-refresh
npm run agent-refresh -- --record
git status --short --branch
git log --oneline origin/main..HEAD
git push origin main
```

After push, validate GitHub Actions:

```bash
gh run list --repo marciozampiron/backstage-cba-prep --branch main --limit 5
gh run watch <RUN_ID> --repo marciozampiron/backstage-cba-prep --exit-status
```

Record push and CI status in `EVENTS.md` only when doing so is part of the approved scope, or in
the next governance/docs commit. Do not create an infinite commit/push loop only for bookkeeping.

## Project commands

```bash
npm test
npm run validate
npm run stats
npm run sync
npm run audit
npm run review
npm run history
npm run blueprint
npm run bedrock-check
npm run agent-check
npm run agent-refresh
```

## CLI examples

```bash
npm run exam
npm run exam -- --domain catalog --count 13
npm run generate -- --provider anthropic --domain catalog --count 5
npm run generate -- --domain catalog --count 1 --dry-run
npm run blueprint -- --provider anthropic --from <URL>
npm run blueprint -- --provider anthropic --from <URL> --write
npm run review -- --json
npm run review -- next --domain catalog
npm run bedrock-check -- --json
npm run bedrock-check -- --smoke --tier fast --yes
npm run agent-check -- --json
npm run agent-check -- --smoke --yes
```

## AWS Bedrock checks

Use the configured AWS profile when validating Bedrock access:

```bash
aws sts get-caller-identity --profile 468601213657_AdministratorAccess
aws bedrock list-foundation-models --region us-east-1 --profile 468601213657_AdministratorAccess
```

Live Bedrock runtime calls may spend tokens. Prefer the repo dry-run checks unless a live smoke is
explicitly approved.

## Role split

- Executor agent: implements, validates, and commits.
- Codex: architect/reviewer/gate.
- Human: authorizes push.

Push only after explicit human approval for the current commit or scope.
