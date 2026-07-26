# Task: operator-run publication artifact and versioned message protocol (#93)

Roles and messages are canonical in [`../MESSAGE-PROTOCOL.md`](../MESSAGE-PROTOCOL.md); the
mechanism is canonical in
[`../../docs/architecture/agent-publication-runbook.md`](../../docs/architecture/agent-publication-runbook.md).
This file does not restate either.

## Ownership

- Implementation executor and publication operator: **Opus** (worktree `../cba-issue-93`, branch
  `task/93-human-publication-script`, cut from `origin/main`)
- Architect / independent technical and security reviewer, read-only: **Codex**
- Approval, risk acceptance and merge authority: **Zamp**
- Next owner: **Codex** (read-only review)

Do not touch `active/82-*`, `active/85-*` or `active/91-*`, or the main working tree — #82 has an
active owner with local changes.

## CANONICAL CURRENT STATE (read this first)

`Opus prepares -> Codex reviews -> Zamp approves -> Opus executes -> Zamp decides/performs merge`

This issue delivers the bridge between #91 Stage A (advisory local validation) and #91 Stage B
(authenticated operator identity and remote enforcement, which does not exist), plus the versioned
`AGENT-HANDOFF v1` message contract.

`agent-publish` is unchanged and remains advisory local validation only.

| Property | Today | Owner when it exists |
| --- | --- | --- |
| Role / operator identity | **Declared by the caller**, never authenticated | #91 Stage B |
| Authorization to operate | `HUMAN_GATE_GRANTED` from Zamp, naming exact ordered full SHAs | unchanged |
| Approval separated from operation | Enforced: a gate approved by the operator, or by an agent-shaped identity, is refused | unchanged |
| Generator network access | **None** — no network call, no Git/GitHub mutation | — |
| Artifact credentials | **None** — uses the operator's existing `git`/`gh` session | — |
| Integrity of the executed bytes | Guaranteed by the verify-and-run command, which hashes what it executes; a bare-path invocation is never supported | — |
| Replay protection | **Not provided** — the gate is validated, never consumed | #91 Stage B |
| Live remote base check | Performed by the artifact, at run time | #91 Stage B enforces it remotely |
| Preventing a direct `main` push | **Not prevented** — `enforce_admins` is still `false` | #91 Stage B |
| Merge | Never performed here; Zamp decides and performs it | unchanged |

## HISTORICAL — the ten decisions that opened this issue (superseded)

> **Historical record, not an instruction.** Decisions 5, 8 and 9 described the human as the script
> operator and Opus as never executing. The binding comments of 2026-07-26 replaced that model with
> `Opus prepares -> Codex reviews -> Zamp approves -> Opus executes -> Zamp decides/performs merge`.
> Kept because the early commits on this branch were written against it. The canonical contract is
> [`../MESSAGE-PROTOCOL.md`](../MESSAGE-PROTOCOL.md).

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

## HISTORICAL — review round 1, five findings, all fixed forward

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

## HISTORICAL — review round 2, five findings, all fixed forward

The four reviewed commits are untouched; every fix is a NEW commit.

| # | Finding | Fix |
| --- | --- | --- |
| HIGH | The digest proved nothing about the executed bytes: the reviewer hashed the file and the human then reopened it with `bash <path>`, so a same-user process could substitute it | The tool prints a verify-and-run command that reads the file once, hashes those captured bytes and executes them with `bash -c`; a mismatch exits 1 from a subshell. A substitution test proves the swapped script neither runs nor leaves a side effect |
| MEDIUM | Expiry, origin, remote base/head and the PR set were checked only before the prompt, so a terminal left open could push against stale state | Volatile checks are bash functions defined once and called twice; the second pass runs after the confirmation with nothing between it and the push, and also re-checks HEAD and worktree cleanliness |
| MEDIUM | `GATE_PATH_IN_REPO` was lexical, so `/tmp/gate.json -> <repo>/gate.json` bypassed it | Canonical comparison via `realpathSync`, plus an outright `GATE_PATH_SYMLINK` refusal, with unit and end-to-end coverage |
| MEDIUM | The NUL guard claimed full coverage but allowlisted extensions, missing HTML, CSS, TypeScript and Python | The scan is inverted: every tracked file except formats that are binary by nature, with an assertion that those extensions are in scope, and `.gitattributes` extended and pinned by its own test |
| LOW | "Everything else is a read" was inaccurate — `git fetch` writes local objects and `FETCH_HEAD` | Reworded to "no other REMOTE mutation", with the local write stated explicitly |

## Round 3 — definitive role model and versioned message protocol

Implemented on top of the five preserved commits, as new fix-forward work:

| Requirement | Where |
| --- | --- |
| Canonical `AGENT-HANDOFF v1` contract | `../MESSAGE-PROTOCOL.md` (new), in the mandatory boot sequence |
| Copyable message template | `../templates/message.md` (new); `../templates/task.md` aligned |
| Push the reviewed commit by SHA | refspec is `$EXPECTED_HEAD:refs/heads/$SOURCE_BRANCH` |
| Refuse a landed ref that is not `EXPECTED_HEAD` | read back with `git ls-remote` after the push |
| No bare-path operational instruction | removed everywhere; guard 7 fails if one reappears |
| Gate read through one `O_NOFOLLOW` FD | `readGateThroughOneFd` — open, `fstat`, read on the same descriptor |
| Operator acknowledgement instead of a terminal check | the TTY requirement is gone; the exact phrase remains |
| Verify-and-run same-bytes guarantee preserved | unchanged, with its substitution test |
| Opus cannot self-approve | `assertApproverIsNotOperator` — `APPROVER_IS_OPERATOR`, `APPROVER_NOT_HUMAN` |
| Codex cannot implement, prepare or execute | declared-role refusal in both commands, plus guard 3 |
| Gemini has no workflow role | stated in the contract; guard 2. Model-provider support untouched |
| Repository-wide consistency guards | `test/governance-model.test.js` (new), 20 tests |

## Work log — Codex FINDINGS on 5cead9d (round 3), all confirmed

Received as `FINDINGS`, verdict "changes required". Every one reproduced before fixing. The six
earlier commits stay byte-for-byte; corrections are a NEW commit.

| # | Sev | Finding | Verified how |
| --- | --- | --- | --- |
| 1 | HIGH | The final gate is circular and never validated mechanically: the manifest must exist *before* generation, so it cannot carry the artifact digest produced afterwards, and the artifact never reads the `HUMAN_GATE_GRANTED` sent after review. Code review and artifact review also shared one `REVIEW_REQUEST`. | Read the flow: `--gate` is read at preparation only; nothing at run time read a post-review gate |
| 2 | HIGH | Documents, skills and the generated artifact still taught the superseded model: they denied that any agent could publish or operate the artifact, and required a human at a terminal. | `grep` found six live sites, including both skill `description:` frontmatters |
| 3 | HIGH | The pull request is never bound to the reviewed SHA: `pr_query` omits `headRefOid`, and nothing re-verifies after create/reuse. | Inspected the `--json` field list |
| 4 | MEDIUM | The governance guards have proven false negatives — any negation anywhere in a sentence exempts the whole sentence, which is why 20/20 passed while finding 2's contradictions survived. | The contradictions in finding 2 were live and green |
| 5 | MEDIUM | The approver is not bound to Zamp: only equality-with-executor and an agent-name regex are refused, so `OpenAI Codex` or any synthetic person passes. | Read `AGENT_IDENTITY` and `assertApproverIsNotOperator` |
| 6 | MEDIUM | The artifact write reopens the path: `writeFileSync(...,'wx')` closes the fd, then `chmodSync`/`statSync` resolve the name again. | Read the write sequence |
| 7 | LOW | The handoff report claimed 18 files, +1332/-259; the real `621682d..5cead9d` diff is 21 files, +1255/-307. | `git diff --shortstat 621682d..5cead9d` |

Finding 7 is mine to own plainly: I reported numbers I had not computed. The final report now derives
them from git.

## Round 4 — the seven findings on 5cead9d

| # | Fix | Where |
| --- | --- | --- |
| 1 | Two gates. The review-scope manifest bounds preparation; a separate `HUMAN_GATE_GRANTED` — written after review, naming `artifactDigest` — is read and validated by the artifact at run time via `CBA_EXECUTION_GATE`, immediately before any effect. The verify-and-run command exports `CBA_ARTIFACT_DIGEST` so the gate is bound to the exact bytes. `REVIEW_REQUEST`/`FINDINGS`/`REVIEW_APPROVED` now carry `SCOPE: code \| artifact`. | artifact §0; runbook §4.4; `MESSAGE-PROTOCOL.md` §3; `publish-gates/README.md`; `templates/message.md` |
| 2 | Every superseded phrase removed from active sources, including both skill `description:` frontmatters, the runbook §4 heading and one-line answer, the artifact header, and the TTY step that contradicted the same document two paragraphs later. | 8 files |
| 3 | `headRefOid` added to `pr_query`; required to equal `EXPECTED_HEAD` after the push; the remote ref and the pull request are both re-verified after create/reuse. | artifact §7, §9 |
| 4 | The clause heuristic is demoted to a backstap. The real control is explicit: a forbidden-phrase scan over active sources, required statements per canonical surface, and positive controls proving both can fail. | `test/governance-model.test.js` |
| 5 | `CANONICAL_APPROVER` with exact match (`APPROVER_NOT_CANONICAL`), on top of the operator-equality and agent-shape refusals. `OpenAI Codex` and any synthetic person are now refused. | `human-publish-script.js` |
| 6 | The write is one descriptor: `O_CREAT\|O_EXCL\|O_WRONLY\|O_NOFOLLOW`, then `writeFileSync(fd)`, `fchmodSync(fd)`, `fstatSync(fd)`. The pathname is never re-resolved after the create. | `agent-human-publish-script.js` |
| 7 | The final report derives file and line counts from `git diff --shortstat`. | this report |

## Work log — Codex FINDINGS on 6074d3b (round 4), all confirmed

| # | Sev | Finding | Verified how | Fix |
| --- | --- | --- | --- | --- |
| 1 | HIGH | The execution gate was read four times through the pathname, and the post-confirmation revalidation called `check_gate_expiry` — the **review scope** window — so an execution gate expiring or replaced during the prompt still reached `git push`. The tests hid it: the harness truncated the script before the volatile checks, and the revalidation assertion only looked for the scope check. | Read the revalidation block; counted 4 reads of `"$CBA_EXECUTION_GATE"` | Read once through one descriptor into an immutable snapshot (`exec 9<`, `stat -L /proc/self/fd/9`, `cat <&9`); all fields parsed from that snapshot; one `check_execution_gate` called before the confirmation and again immediately before the push, owning its own expiry and TTL. The harness now runs the REAL script with refusing `git`/`gh` stubs, plus a dynamic regression where `date` jumps forward once the confirmation is read — and a positive control proving the same run reaches the push with a steady clock |
| 2 | HIGH | Live docs still contradicted the model: the gate document said push and merge are both the human owner's; comments framed operating it as a human-only act and referenced a terminal requirement already removed; `README.md`/`COMMANDS.md` never showed the second manifest or `CBA_EXECUTION_GATE`. | `grep`, and the guard's phrase list did not cover these variants | All surfaces updated with the concrete two-gate sequence and the exported env var; five new forbidden phrases; a new guard requiring `HUMAN_GATE_GRANTED` + execution gate + artifact digest on all nine cold-start surfaces; another forbidding the review scope from being described as authorizing anything |
| 3 | MEDIUM | The execution-gate schema was open, `gateId` was echoed before validation, `date` accepted arbitrary expressions instead of strict RFC3339, and the gate could live inside the repository. | Read the shell validation | Closed nine-key schema compared exactly; `gateId` `^[a-z0-9][a-z0-9._-]{2,63}$`; digest `^[0-9a-f]{64}$`; commits full lowercase 40-hex; strict RFC3339 with `Z` or offset; TTL ≤ 12h; canonical out-of-repository check via `pwd -P`; refusals state the field and never echo the rejected value |

## Work log — Codex FINDINGS on 56149bb (round 5), all confirmed

| # | Sev | Finding | Fix |
| --- | --- | --- | --- |
| 1 | HIGH | The post-confirmation gate check ran *before* the origin binding, the live remote reads and the pull-request query — all of which contact the network and can block. A gate expiring in that span still reached `git push`. | `check_execution_gate "immediately before push"` is now the last statement before the mutation, after every local and remote revalidation. A dynamic regression counts `ls-remote` calls so the stub clock advances on the second pass only — strictly between the two gate checks — and asserts the push is never reached. A guard also fails if anything network-bound is inserted between that check and the push |
| 2 | MEDIUM | Evidence recorded the review-scope id as the authorization: the prompt, PR body and final output all printed `GATE_ID`, which came from the manifest that authorized nothing. | `GATE_ID` is gone. `REVIEW_SCOPE_ID` and `EXECUTION_GATE_ID` are separate and both reported with explicit labels; the PR body reads "Authorized by execution gate X (review scope Y)"; the evidence block leads with "authorized by: execution gate" |
| 3 | MEDIUM | My reported `npm test` was not reproducible — 226/0 against Codex's 225/1. I edited this handoff after the last suite run and committed without re-running, and the new work-log text contained two forbidden phrases. | The narrative describes the old phrasing instead of quoting it; the guard was **not** weakened, and the claim that Stage A consumes a manifest at preparation was **added** to the forbidden list. The suite is re-run after this edit and the result below is the actual one |
| 4 | MEDIUM | Conflicting gate instructions: the duplicate push-gate block passed the execution-gate filename to `--gate`; the gate doc said the execution gate "adds" fields to the review scope; the protocol described the review scope as being consumed rather than read and validated. | Distinct filename conventions and channels documented everywhere (`--gate` takes `cba-scope-*`; the execution gate arrives only as `CBA_EXECUTION_GATE`); the execution gate is described as a separate closed nine-key schema; "consumed" replaced by "read and validated". Four semantic documentation tests added, not word-presence checks |
| 5 | MEDIUM | Symlink TOCTOU at the open: `[ ! -L ]` then `exec 9<` left a window, and bash follows a symlink. | The open is delegated to a small node helper using `O_RDONLY \| O_NOFOLLOW`, with `fstat`, size and content read from that same descriptor. The kernel refuses the symlink at open time, so there is no window — and the `/proc/self/fd` dependency is gone |

## Work log — Codex required corrections on 3d0a91d (round 6), all confirmed

| # | Correction | Fix |
| --- | --- | --- |
| 1 | The `note "Pushing..."` line sat between the final gate check and `git push`, so they were not consecutive statements. My own guard only forbade network-bound calls in that window, which was too weak a rule. | The progress line moved **above** the check; the guard now requires **zero** executable statements between the check and the push |
| 2 | A credential-shaped `gateId` passed the charset check and would be echoed three times — prompt, PR body, evidence. `ghp_…` and `api_key…` are perfectly lowercase. | The Stage A secret-marker policy is applied to the gate id before anything is printed; refusals name the field and never the value |
| 3 | The gate open lacked `O_NONBLOCK`, so a FIFO planted at the path would block forever — a hang rather than a refusal. | `O_RDONLY \| O_NOFOLLOW \| O_NONBLOCK`, with `fstat` rejecting anything that is not a regular file. A real `mkfifo` regression asserts a fast refusal under a bounded timeout, so losing the flag fails the test instead of hanging CI |
| 4 | `publish-gates/README.md` still pointed the review scope at the execution-gate filename. | `/tmp/cba-scope-<issue>.json` for the review scope; `/tmp/cba-gate-<issue>.json` reserved for `CBA_EXECUTION_GATE` and never passed to `--gate`, asserted by a test |

Two latent defects surfaced while fixing these, both mine:

- the "no secret-shaped material" test began failing on the credential **detector** I had just added.
  The detector is excluded from that scan and separately asserted to exist, so removing the control
  cannot pass quietly;
- every test that executes the artifact used a fixture with a hardcoded review-scope expiry. Wall
  clock passed it, and they started failing for a reason unrelated to what they test. Runtime tests
  now build their window against the real clock via `runnableScript()`.

## Work log — Codex FINDINGS on d6ea88d (round 7), confirmed

One MEDIUM, blocking because the file is normative security documentation.

`publish-gates/README.md` still carried three sentences written before the two-document model and
never revisited: it opened by calling "a publish gate" the machine-readable form of a publication
decision, said that "in **Stage B** the same gate becomes the input to real publication", and
described "A gate" generically as the machine-readable form of a `HUMAN_GATE_GRANTED`. Each had the
right vocabulary and the wrong meaning, which is why every presence-based check passed. No runtime
bypass — the implementation fails closed — but it would have trained a Stage B implementation to
authorize publication with the manifest that authorizes nothing.

Fixed: Stage A is attributed to the **review scope manifest** by name and stated to authorize
nothing, ever; Stage B is attributed to an **authenticated execution gate**, with an explicit note
that it does *not* promote the review scope and that doing so would be a security defect; only the
execution gate is called the machine-readable `HUMAN_GATE_GRANTED`, and the review scope is stated
not to be one. The lifecycle step and the opening paragraph were corrected the same way.

Three semantic regressions were added rather than more presence checks: a conflation scan over all
active sources, a per-stage attribution assertion, and a **positive control that feeds the guard the
two sentences that actually shipped**, so if the matchers ever stop flagging them the test fails
instead of going quiet. The four patterns the scan matches live in
`test/governance-model.test.js` (`CONFLATION_PATTERNS`) and are deliberately **not** restated here:
writing them out in an active document trips the guard they define, which is itself evidence that
the guard works on prose rather than on keywords.

The #91 contract sentence "A gate is bound to a specific commit sequence" is preserved verbatim; the
two-document precision is added around it rather than replacing it.

## Status

Implementation complete, **local commits only, nothing published**. Next owner: **Codex**, for
read-only `SCOPE: code` review; `SCOPE: artifact` follows once an artifact is prepared. After that, a Zamp `HUMAN_GATE_GRANTED`
naming the artifact digest is required before any operation. Further findings are fix-forward: a NEW
commit, never an amend, rebase or squash.

**Prohibited by this state:** push, PR creation or mutation, merge, deploy, branch-protection
change, credential creation, cloud mutation, paid call.

## Residual risks

- Declared roles remain caller-supplied; the canonical approver is a declared string, not an
  authenticated identity.
- Neither document is consumed in the replay sense — expiry and the digest binding bound the window
  instead. Idempotent consumption is #91 Stage B.
- The artifact requires `node` at operation time to open the execution gate with `O_NOFOLLOW`. That
  removed the symlink window entirely and the `/proc/self/fd` dependency with it, at the cost of one
  more runtime dependency — reasonable in a Node repository whose CLI produced the artifact, and it
  fails closed if `node` is absent.
- `enforce_admins` is still `false`, so a direct `main` push remains possible.
- The integrity guarantee holds only when the verify-and-run command is used; nothing prevents a
  bare-path invocation.
- The governance guards read documents, not behaviour: an agent that ignores them is not stopped.
- `services/bff/test/telemetry.test.js` (on `main` under #82) still contains a NUL byte and is
  therefore binary in diffs. Another track owns it; the guard lists it and fails once it is fixed.
