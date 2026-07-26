# Task: Human-operated publication scripts and role-specific skills (#93)

## Ownership

- Implementation executor: Claude Opus 5 (worktree `../cba-issue-93`, branch
  `task/93-human-publication-script`, cut from `origin/main`)
- Architect/security reviewer: Codex — **read-only review**
- Human gate: required before ANY publication. The human is the only actor who runs the generated
  script and the only actor who merges.

Do not touch `active/82-*`, `active/85-*` or `active/91-*`, or the main working tree — #82 has an
active owner with local changes.

## CANONICAL CURRENT STATE (read this first)

This issue adds the **bridge** between #91 Stage A (advisory local validation) and #91 Stage B
(authenticated identity and remote enforcement, which does not exist).

**No agent publishes.** Three verbs, three actors, three moments:

| Verb | Actor | How |
| --- | --- | --- |
| Prepare | implementation executor | `node bin/cli.js agent-human-publish-script --role executor --executor <id> --gate <file>` |
| Read | architect/security reviewer | opens the file, confirms the printed SHA-256 |
| Run | human operator | `bash /tmp/cba-publish-<issue>-<head>.sh` |

`agent-publish` is unchanged and remains advisory local validation only (#93 decision 1).

| Property | Today | Owner when it exists |
| --- | --- | --- |
| Role / executor identity | **Declared by the caller**, never authenticated | #91 Stage B |
| Who publishes | The **human**, by running the prepared script | unchanged |
| Generator network access | **None** — no network call, no Git/GitHub mutation | — |
| Script credentials | **None** — uses the human's existing `git`/`gh` session | — |
| Replay protection | **Not provided** — the gate is validated, never consumed | #91 Stage B |
| Live remote base check | Performed **by the script**, at run time | #91 Stage B enforces it remotely |
| Preventing a direct `main` push | **Not prevented** — `enforce_admins` is still `false` | #91 Stage B |
| Preventing an agent from running the script | **Not prevented** — mode 0600, no exec bit and a TTY check raise the cost only | #91 Stage B |

## The ten binding decisions (from the human, verbatim in intent)

1. `agent-publish` stays advisory local validation only.
2. A separate command generates the human script.
3. The generator makes no network call and no Git/GitHub mutation.
4. The script lives in `/tmp`, mode `0600`, with no executable bit.
5. The human runs it explicitly: `bash /tmp/<script>`.
6. The script may only validate remote/local state and publish `task/<issue>-<slug>` without force,
   creating or reusing the exact PR.
7. The script never merges, deploys, pushes `main`, force-pushes, administers the repository,
   accesses secrets or calls a paid service.
8. The executor generates the script but never runs it.
9. The reviewer reviews but never implements and never runs.
10. Once independent review begins, every correction is fix-forward — no amend, rebase or squash of
    reviewed commits.

## Source of truth

- GitHub issue #93, read in full.
- `docs/architecture/agent-publication-runbook.md` §4 (this bridge), §3 (Stage A), §5 (Stage B).
- `spec/security-rules.md` §1 decision rights 6–8.
- `.agent-handoff/publish-gates/README.md` for the gate schema.

## Files

| File | Change |
| --- | --- |
| `src/lib/human-publish-script.js` | NEW — pure generator: output-path validation, forbidden-operation list, script template. No I/O, no network, no git. |
| `src/lib/repo-state.js` | NEW — the Stage A local observation set, extracted so validator and generator cannot drift. Adds `deriveRepoSlug` (strict; a remote URL carrying userinfo fails the pattern instead of being parsed). |
| `src/commands/agent-human-publish-script.js` | NEW — validates the gate via Stage A, self-checks the generated text, writes one file `0600` non-executable without overwriting, prints path + SHA-256. |
| `src/commands/agent-publish.js` | Consumes `repo-state.js`; drops a dead `safeLabel` import. **Behaviour unchanged — still validation only.** |
| `bin/cli.js` | Wires the new command and extends the pre-`loadEnv` declared-role refusal to it. |
| `AGENTS.md` | Publication rule rewritten around prepare / read / run. |
| `.agent-handoff/README.md` | Three-layer table, role table, mechanics 1–8. |
| `.agent-handoff/COMMANDS.md` | Publishing and push-gate sections. |
| `spec/security-rules.md` | Decision rights 6, 7, 8. |
| `docs/architecture/agent-publication-runbook.md` | New §4; role table; verification section; sections renumbered. |
| `.claude/skills/publication-prepare/SKILL.md` | NEW — Claude/executor: preparation only. |
| `.agents/skills/publication-review/SKILL.md` | NEW — Codex/reviewer: read-only review. |
| `.claude/skills/security-review/SKILL.md`, `.agents/skills/review-security/SKILL.md` | Aligned with the bridge. |
| `test/human-publish-script.test.js` | NEW — offline suite. |

## Validation

- `npm test` (offline; Node 20/22 matrix in CI)
- `node bin/cli.js validate`
- `git diff --check origin/main..HEAD`
- `npm run agent-refresh`

## Explicitly NOT done

No push, no PR creation or mutation, no merge, no deploy, no branch-protection change, no credential
creation, no cloud mutation, no paid call. #91 Stage B remains a separate human gate.

## Status

Implementation complete, local commits only. **Awaiting Codex read-only review.** Any finding is
fix-forward: a NEW commit, never an amend, rebase or squash of reviewed history.
