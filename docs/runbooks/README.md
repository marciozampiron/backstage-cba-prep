# Runbooks — mandatory standard

> **A runbook grants no authority.** It documents HOW an operation is performed, never WHETHER
> it may be. A runbook that appears to permit something permits nothing (SPEC-RUN-001).

## Two authorizations, never interchangeable

Design review round 2 found these conflated, and this standard keeps them apart permanently
(see `spec/spec-anchored-development.md` §8):

- **Publication authorization** — `HUMAN_GATE_GRANTED` per
  [`.agent-handoff/MESSAGE-PROTOCOL.md`](../../.agent-handoff/MESSAGE-PROTOCOL.md), with its
  closed nine-key schema. It authorizes exactly branch publication and pull-request creation,
  and nothing else. It is never reused for cloud effects.
- **Cloud authorization** — its own closed, effect-bound schema: the per-decision
  `CBA_CLOUD_GATE` value (SPEC-DEPLOY-002/009/010/011), issued only by Zamp, bounded to at most
  one hour, bound to the exact release, assembly, plan digest and stack group.
  **Preparing change sets is already cloud mutation** — `plan_only` creates CloudFormation
  change sets and publishes assets — so it requires cloud authorization exactly as `deploy`
  does (SPEC-RUN-002).

Both instruments are Zamp's alone. A runbook step states WHICH instrument it depends on;
depending on one never implies the other.

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
| **Commands** | The exact commands, in order, each with its expected outcome, as copyable templates with `<angle-bracket>` placeholders. A command whose tooling does not exist yet is marked `PLANNED — not executable` and the runbook says so at the top. |
| **Evidence** | What is captured, where it is recorded (run summary, `EVENTS.md`, issue), and what it must contain. Evidence follows the redaction discipline: no secrets, no account ids, no value-derived markers. |
| **Stop conditions** | The exact states that HALT the run. Each names its signal (refusal code, exit status, missing evidence) and the required next action. Continuing past a stop condition is never an operator judgment call. |
| **Rollback** | How to return to the last known-good state, and what "known-good" means for this operation. If rollback itself mutates cloud state, it depends on its own cloud authorization and says so. |
| **Cleanup** | What is removed or reset after success AND after failure — temporary files, per-decision values — and what is deliberately retained as record. |

## Style

- English, wrapped at ~100 columns, matching the rest of the repository's documentation.
- Full 40-character SHAs where commits are referenced; never branch names as identity.
- Placeholders in `<angle-brackets>`; the AWS documentation example account `111122223333` where
  an account-shaped value is unavoidable.
