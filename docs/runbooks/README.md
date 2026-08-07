# Runbooks — mandatory standard

> **A runbook grants no authority.** It documents HOW an operation is performed, never WHETHER
> it may be. A runbook that appears to permit something permits nothing (SPEC-RUN-001).

## Three authorizations, never interchangeable

Design rounds 2–3 found these conflated. They are policy DATA in
[`spec/authority-policy.json`](../../spec/authority-policy.json), summarized here (see
`spec/spec-anchored-development.md` §8):

| Instrument | Authorizes | Performed by |
| --- | --- | --- |
| publication (`CBA_EXECUTION_GATE`) | branch publication, pull-request creation | Opus |
| cloud (`CBA_CLOUD_GATE`) | `deploy`, `prepare-change-sets`, `execute-change-sets` | Zamp |
| spend (out-of-band record) | `invoke-paid-model-audit` | Zamp |

**Preparing change sets is already cloud mutation** — `plan_only` creates CloudFormation change
sets and publishes assets — so it depends on a cloud authorization exactly as `deploy` does
(SPEC-RUN-002).

All three are Zamp's alone. A step states WHICH instrument it depends on; depending on one never
implies another.

## Every command names its performer

**Each command line states the actor that runs it** (SPEC-RUN-005), and that actor must be
permitted to perform the effect by `spec/authority-policy.json`. This is not bookkeeping: the
policy denies Opus `administer-repository` and `perform-cloud-effect`, so "the operator sets the
Environment variable" or "the operator dispatches the deploy" would contradict the policy while
reading like an instruction. Where the performer is Zamp, the runbook says Zamp.

## Frontmatter — required, closed

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
- `cloudMutation: true` implies `gateRequired: true` — there is no such thing as an unauthorized
  mutation runbook — and the Commands section must say WHICH authorization instrument each
  mutating step depends on.
- `specs` must name registered SPEC-IDs only; an empty list is valid solely for documents that
  touch no spec-anchored behavior (and should be rare).
- `inputs`/`outputs` name artifacts and identifiers, **never** secret values, account ids or
  live ARNs.

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
