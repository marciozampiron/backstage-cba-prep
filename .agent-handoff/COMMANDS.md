# Agent Command Reference

This file is the operational command checklist for agents working in this repository. It is a
companion to `README.md`, `CURRENT.md`, and `EVENTS.md`.

GitHub Issues and the Project board remain the source of truth for scope and priority.

## Required boot sequence

Run these commands before taking any task:

```bash
cat .agent-handoff/MESSAGE-PROTOCOL.md   # canonical roles and message contract
git pull
npm run agent-refresh
npm run agent-refresh -- --record
git status --short --branch
git log --oneline origin/main..HEAD
```

Read these files before editing:

```bash
cat AGENTS.md
cat .agent-handoff/MESSAGE-PROTOCOL.md
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

## Publishing (#91 Stage A + #93 operator bridge)

Roles and messages: [`MESSAGE-PROTOCOL.md`](MESSAGE-PROTOCOL.md). Mechanism:
[`../docs/architecture/agent-publication-runbook.md`](../docs/architecture/agent-publication-runbook.md).

`Opus prepares -> Codex reviews -> Zamp approves -> Opus executes -> Zamp decides/performs merge`

```bash
# 1. own branch AND worktree — never share a writable main
git worktree add ../cba-issue-<n> -b task/<n>-<slug> main

# 2. local defense in depth (once per clone; not the authoritative control)
git config core.hooksPath .githooks

# 3. OPUS: advisory local validation — this is all it does
node bin/cli.js agent-publish --role executor --executor <agent-id> \
  --gate /tmp/cba-scope-<n>.json   # REVIEW SCOPE, authored by Zamp OUTSIDE the worktree

# 4. OPUS: prepare the reviewed artifact. No network, no git mutation.
#    Writes one file to /tmp, mode 0600, NOT executable, and prints its path, SHA-256
#    and the verify-and-run command.
node bin/cli.js agent-human-publish-script --role executor --executor <agent-id> \
  --gate /tmp/cba-scope-<n>.json
```

Then, in order and by different actors:

- **Step 5 — Codex (`FINDINGS` or `REVIEW_APPROVED`).** Reads the file and confirms the printed
  SHA-256. Read-only: Codex never implements, prepares, executes, pushes, merges or deploys, and
  `REVIEW_APPROVED` never authorizes publication.
- **Step 6 — Zamp (`HUMAN_GATE_GRANTED`).** Writes the **execution gate**: a second manifest,
  outside the worktree, naming the branch, ordered full SHAs, the **artifact digest**, a bounded
  expiry and the allowed effects. A generic "approved" is not a gate, and the review scope from
  step 3 authorizes nothing.
- **Step 7 — Opus (`OPERATION_RESULT`).** Supplies that gate and runs the verify-and-run command
  printed in step 4:

  ```bash
  export CBA_EXECUTION_GATE=/tmp/cba-gate-<n>.json   # Zamp's HUMAN_GATE_GRANTED
  # then the verify-and-run command, verbatim — it exports CBA_ARTIFACT_DIGEST
  ```

  The artifact reads that gate once into a snapshot and validates it against the digest before the
  confirmation and again immediately before the push. There is no supported bare-path invocation. It
  pushes the reviewed commit by SHA and creates or reuses exactly one pull request.
- **Step 8 — Zamp (`MERGE_DECISION`).** Decides and performs the merge, after required checks.

`architect` and `reviewer` are refused by **both** commands before `.env` loads, the gate is read,
git runs or any file is written. `main` is never a source branch. A gate whose approver is the
operator, or looks like an agent identity, is refused. The prepared script can never merge, deploy,
push `main`, force-push, rewrite history, change repository settings or read secrets.

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
# Publication requires a HUMAN_GATE_GRANTED from Zamp naming the exact ordered full SHAs.
# Opus operates it; Codex never does; merge is always Zamp's. See "Publishing" above.
node bin/cli.js agent-publish --role executor --executor <agent-id> \
  --gate /tmp/cba-gate-<n>.json   # authored by the human OUTSIDE the worktree

node bin/cli.js agent-human-publish-script --role executor --executor <agent-id> \
  --gate /tmp/cba-gate-<n>.json   # authored by the human OUTSIDE the worktree
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

Canonical: [`MESSAGE-PROTOCOL.md`](MESSAGE-PROTOCOL.md).

- **Opus**: implements, validates, commits, prepares the artifact, and operates publication after an
  exact gate. Never self-approves, merges, deploys, pushes `main` or force-pushes.
- **Codex**: architect and independent technical/security reviewer, read-only. Never implements,
  prepares, executes, pushes, merges or deploys.
- **Zamp**: grants the exact gate, accepts risk, and decides and performs the merge.
- **Gemini**: no workflow or governance role (model-provider support is unaffected).

Operate only after a `HUMAN_GATE_GRANTED` naming the exact ordered full SHAs.
