# Runbooks — mandatory standard

> **A runbook grants no authority.** It documents HOW an operation is performed, never WHETHER
> it may be. A runbook that appears to permit something permits nothing (SPEC-RUN-001).

## Four authorizations, never interchangeable

Design rounds 2–3 found these conflated. They are policy DATA in
[`spec/authority-policy.json`](../../spec/authority-policy.json), summarized here (see
`spec/spec-anchored-development.md` §8):

| Instrument | Authorizes | Performed by |
| --- | --- | --- |
| publication (`CBA_EXECUTION_GATE`) | branch publication, pull-request creation | Opus |
| cloud (`CBA_CLOUD_GATE`) | `deploy`, `prepare-change-sets`, `execute-change-sets`, `abandon-change-sets` | Zamp |
| spend (out-of-band record) | `invoke-paid-model-audit` | Zamp |
| stack-record cleanup (out-of-band record) | `delete-review-in-progress-stack-record` | Zamp, by hand |

**Preparing change sets is already cloud mutation** — `plan_only` creates CloudFormation change
sets and publishes assets — so it depends on a cloud authorization exactly as `deploy` does
(SPEC-RUN-002).

The fourth instrument exists because round 6 found the cleanup effect naming the cloud one,
which did not authorize it and gave it no mode. It is supplied out of band — never an Environment
variable — precisely so that no lane can read a value permitting it.

**A cloud authorization also names its MODE**, and the mode fixes the effects exactly — round 5
of the design review found that one instrument covering four effects could not distinguish a
plan from an execution:

| Mode | Authorizes exactly |
| --- | --- |
| `plan_only` | `prepare-change-sets` |
| `deploy` | `deploy`, `execute-change-sets` |
| `abandon` | `abandon-change-sets` |

A step therefore names the instrument AND the mode it depends on. The policy also carries
`delete-review-in-progress-stack-record` as a distinct effect that **no lane performs** — it is
human-only by policy, and no runbook here automates it.

All four are Zamp's alone. A step states WHICH instrument it depends on; depending on one never
implies another.

## Every command names its performer

**Each command line states the actor that runs it** (SPEC-RUN-005), and that actor must be
permitted to perform the effect by `spec/authority-policy.json`. This is not bookkeeping: the
policy denies Opus `administer-repository` and `perform-cloud-effect`, so "the operator sets the
Environment variable" or "the operator dispatches the deploy" would contradict the policy while
reading like an instruction. Where the performer is Zamp, the runbook says Zamp.

## Frontmatter — required, closed

[SPEC-RUN-003, SPEC-RUN-004]
YAML frontmatter with EXACTLY these keys, in this order:

```yaml
---
id: <kebab-case, unique, matches the filename without .md>
kind: <runbook | index>
version: <semver — bump on every change>
owner: <the actor that maintains this document>
humanApprover: Zamp
specs: [<SPEC-IDs this document operationalizes, per spec/spec-anchored-development.md>]
inputs: [<what the operator must have before starting — names, never values>]
outputs: [<what a completed run produces — evidence, records>]
gateRequired: <true|false — whether any step depends on a Zamp authorization, of either kind>
cloudMutation: <true|false — whether any step can change cloud state, change-set creation included>
---
```

Rules:

- `humanApprover` is always `Zamp`. A runbook cannot delegate that, and a value naming anyone
  else is invalid.
- `version` is bumped in the SAME commit that changes any other part of the document. Round 4 of
  the design review caught three runbooks edited without a bump: a version that does not move is
  a version nobody can cite.
- `cloudMutation: true` implies `gateRequired: true` — there is no such thing as an unauthorized
  mutation runbook — and the Commands section must say WHICH authorization instrument each
  mutating step depends on.
- `specs` must name registered SPEC-IDs only; an empty list is valid solely for documents that
  touch no spec-anchored behavior (and should be rare).
- `inputs`/`outputs` name artifacts and identifiers, **never** secret values, account ids or
  live ARNs.

## Resolving a run — the canonical procedure

Every dispatching runbook uses THIS procedure and does not restate it. Round 7 found prose
describing a loop beside a command that had none; round 8 found the pasted loop itself defective
in a way prose review missed twice: it stopped watching for duplicates the moment it found one
run, so a second run bearing the same correlation id that appeared DURING `gh run watch` was
never seen — although the rule says duplicates always stop — and nothing executed the procedure,
so nothing could prove it. The procedure is therefore a REVIEWED HELPER,
[`bin/resolve-run.mjs`](../../bin/resolve-run.mjs), and its tests
([`test/resolve-run.test.js`](../../test/resolve-run.test.js)) drive it with a simulated `gh`
through zero-then-found, immediate duplication, LATE duplication, a vanished run, an identity
change, `gh` failure and unparseable output.

**The correlation id is generated with a CSPRNG.** "Caller-generated" allowed
`cba-70-000…000`; 128 bits from `openssl rand` do not.

```bash
CORRELATION_ID="cba-70-$(openssl rand -hex 16)"   # matches ^cba-70-[0-9a-f]{32}$
printf '%s\n' "$CORRELATION_ID"                   # record it BEFORE dispatching
# …dispatch per the runbook…
RUN_ID=$(node bin/resolve-run.mjs --title "cba-release <mode> ${CORRELATION_ID}")
```

What the helper enforces — each rule proven by mutation in its tests, none of them optional:

- **The repository is pinned inside the helper** (`marciozampiron/backstage-cba-prep`), passed as
  `--repo` on every `gh` call. Round 10: without it, `gh` resolves the AMBIENT clone — run from a
  fork carrying the same workflow file and title, every other rule would be faithfully enforced
  against foreign runs and hand back a foreign artifact id. The same pin appears in every
  runbook's `gh workflow run` (by workflow FILE, not display name) and `gh run download`.
- **The workflow is pinned by FILE identity inside the helper** (`release-pilot.yml`). Round 9
  found the helper forwarding any caller-supplied workflow name to `gh`; there is no workflow
  argument anymore — a display name is not an identity, and a caller cannot aim the contract at
  another workflow.
- **Equality on the COMPLETE run name.** A title that merely contains the id never matches; the
  comparison is `===` in code, so nothing is ever interpolated into a query language.
- **The window is exhaustive or the run stops.** The query asks for up to 1000 rows and a page
  that comes back full refuses as `RESOLVE_WINDOW_TRUNCATED` — round 9 caught `--limit 50`
  quietly assuming the newest fifty prove uniqueness while an older duplicate sits at row 51.
- **Every external call has a reviewed wall-clock deadline.** Each query is bounded at 60s and
  the watch at 45 minutes — the lane's own jobs are bounded by `timeout-minutes` summing to 35,
  so a watch that outlives 45 minutes is a hung run, not a slow one. Both deadlines stop with
  named codes; ten attempts alone bound nothing when a single call can stall forever.
- **At most ten queries, thirty seconds between them, and no wait after the last.**
- **More than one match at ANY query stops immediately.** A correlation id is used once; a second
  run bearing it means reuse, an unrecorded re-dispatch, or forgery — none of which is resolved
  by picking one.
- **Zero matches after the tenth query stops.** Waiting longer is not a remedy for a run that
  never started.
- **After `gh run watch` reaches a terminal conclusion, the helper REPEATS the query** and
  requires exactly the same single run id immediately before it prints anything — a late
  duplicate, a vanished run and an identity change all stop (SPEC-LANE-007). Uniqueness observed
  once is not uniqueness still true when evidence is read.
- **Its only stdout is the run id**; every stop goes to stderr with a named code. The runbook's
  next step downloads the artifact with that id and nothing else.
- **`headSha` is never a selector.** The dispatch targets `--ref main`, so `headSha` is main's
  tip; for any release that is not the tip it is not the release SHA. The release SHA is verified
  afterwards, from the run's artifact.

The helper is read-only over GitHub — `gh run list` and `gh run watch` observe; it dispatches
nothing, mutates nothing and spends nothing.

## One operation per runbook

A `kind: runbook` document covers exactly ONE operation with its own decision. A flow whose
steps carry independent decisions is SEVERAL runbooks, linked from a `kind: index` document.
An index holds context, ordering and links — and **no commands**: its required sections reduce
to Preflight (shared), the linked runbooks in order, and Stop conditions that span the flow.

## Sections — required for `kind: runbook`, in this order

| Section | Contents |
| --- | --- |
| **Preflight** | Every condition verified BEFORE the first command: reviewed commits, authorizations present, environment state, prior evidence. Each item is checkable; "be careful" is not a preflight. |
| **Commands** | The exact commands, in order, each prefixed by its PERFORMER and followed by its expected outcome, as copyable templates with `<angle-bracket>` placeholders. AWS invocations pin `--region`, `--profile` and `--no-cli-pager`, and verify the caller identity before acting. A command whose tooling does not exist yet is marked `PLANNED — not executable` and the runbook says so at the top. |
| **Evidence** | What is captured, where it is recorded (run summary, `EVENTS.md`, issue), and what it must contain. Evidence follows the redaction discipline: no secrets, no account ids, no value-derived markers. |
| **Stop conditions** | The exact states that HALT the run. Each names its signal (refusal code, exit status, missing evidence) and the required next action. Continuing past a stop condition is never an operator judgment call. |
| **Rollback** | How to return to the last known-good state, and what "known-good" means for this operation. If rollback itself mutates cloud state, it depends on its own cloud authorization and says so. |
| **Cleanup** | What is removed or reset after success AND after failure — temporary files, per-decision values — and what is deliberately retained as record. |

## Style

- English, wrapped at ~100 columns, matching the rest of the repository's documentation.
- Full 40-character SHAs where commits are referenced; never branch names as identity.
- Placeholders in `<angle-brackets>`; the AWS documentation example account `111122223333` where
  an account-shaped value is unavoidable.
