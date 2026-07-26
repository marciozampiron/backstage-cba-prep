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
| Run | human operator | the printed verify-and-run command, which hashes the bytes it executes |

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
| Integrity of the executed bytes | Guaranteed **only** when the verify-and-run command is used; a bare `bash <path>` reopens the file | — |

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
| `test/human-publish-script.test.js` | NEW — offline suite, including two end-to-end tests that walk the documented protocol in a real temporary repository. |
| `.gitattributes` | NEW — forces textual diffs for source files so a stray NUL byte cannot hide a file from review. |
| `.agent-handoff/publish-gates/README.md` | Gate authored outside the worktree; the folder holds the schema and example only. |

## Validation

- `npm test` (offline; Node 20/22 matrix in CI)
- `node bin/cli.js validate`
- `git diff --check origin/main..HEAD`
- `npm run agent-refresh`

## Explicitly NOT done

No push, no PR creation or mutation, no merge, no deploy, no branch-protection change, no credential
creation, no cloud mutation, no paid call. #91 Stage B remains a separate human gate.

## Review round 1 — five findings, all fixed forward

Codex reviewed the first three commits and reported five findings. The three reviewed commits are
untouched; every fix is a NEW commit.

| # | Finding | Fix |
| --- | --- | --- |
| HIGH | `--repo` could diverge from `origin`, and the PR was identified by `.[0]` on branch name only, after the push | The repository is derived from `origin` and a supplied `--repo` is only a confirmation (`REPO_ORIGIN_MISMATCH`, `ORIGIN_UNRESOLVED`); the script binds `git remote get-url origin` to `REPO` at run time; the open-PR set is asserted **before** the push and re-asserted after, requiring zero or exactly one match, not cross-repository, same owner, exact base and head |
| HIGH | The documented protocol made the worktree dirty before generation, so it could never complete | The gate is authored outside the worktree, `GATE_PATH_IN_REPO` makes it mechanical, bookkeeping moves to the main worktree, and two end-to-end tests walk the real protocol in a temporary repository |
| MEDIUM | A failed gate read printed the raw error, leaking the caller-supplied path | Generic refusal; neither the path nor the raw error is echoed |
| MEDIUM | A literal NUL byte made the security test file binary and invisible in diffs | The NUL is built at runtime; a guard test scans **all** tracked sources; `.gitattributes` forces textual diffs |
| LOW | "one mutation" was inaccurate — the PR creation is a second effect | Reworded to two bounded external effects throughout code, docs and skills |

### Reported, not fixed — belongs to another track

`services/bff/test/telemetry.test.js` (merged to `main` under #82) contains the same literal NUL
byte and is therefore binary and unreviewable in diffs. #82 has an active owner, so it was not
touched. The guard test lists it explicitly in `KNOWN_PRE_EXISTING` and **fails once it is fixed**,
so the exception cannot outlive the problem. It needs a one-line fix on the #82 track.

## Review round 2 — five findings, all fixed forward

The four reviewed commits are untouched; every fix is a NEW commit.

| # | Finding | Fix |
| --- | --- | --- |
| HIGH | The digest proved nothing about the executed bytes: the reviewer hashed the file and the human then reopened it with `bash <path>`, so a same-user process could substitute it | The tool prints a verify-and-run command that reads the file once, hashes those captured bytes and executes them with `bash -c`; a mismatch exits 1 from a subshell. A substitution test proves the swapped script neither runs nor leaves a side effect |
| MEDIUM | Expiry, origin, remote base/head and the PR set were checked only before the prompt, so a terminal left open could push against stale state | Volatile checks are bash functions defined once and called twice; the second pass runs after the confirmation with nothing between it and the push, and also re-checks HEAD and worktree cleanliness |
| MEDIUM | `GATE_PATH_IN_REPO` was lexical, so `/tmp/gate.json -> <repo>/gate.json` bypassed it | Canonical comparison via `realpathSync`, plus an outright `GATE_PATH_SYMLINK` refusal, with unit and end-to-end coverage |
| MEDIUM | The NUL guard claimed full coverage but allowlisted extensions, missing HTML, CSS, TypeScript and Python | The scan is inverted: every tracked file except formats that are binary by nature, with an assertion that those extensions are in scope, and `.gitattributes` extended and pinned by its own test |
| LOW | "Everything else is a read" was inaccurate — `git fetch` writes local objects and `FETCH_HEAD` | Reworded to "no other REMOTE mutation", with the local write stated explicitly |

## Status

Implementation complete, local commits only, no push. **Awaiting Codex re-review.** Any further
finding is fix-forward: a NEW commit, never an amend, rebase or squash of reviewed history.
