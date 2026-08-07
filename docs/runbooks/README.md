# Runbooks — mandatory standard

> **A runbook grants no authority.** It documents HOW an operation is performed, never WHETHER
> it may be. Authorization comes exclusively from the protocol in
> [`.agent-handoff/MESSAGE-PROTOCOL.md`](../../.agent-handoff/MESSAGE-PROTOCOL.md): effects
> happen only under `HUMAN_GATE_GRANTED` from Zamp, after independent review. A runbook that
> appears to permit something permits nothing.

Every file in `docs/runbooks/` (this README excepted) MUST follow this standard. The
spec-conformance audit ([`spec-conformance-audit.md`](spec-conformance-audit.md)) is expected to
police it once the mechanical auditor exists; until then, review does.

## Frontmatter — required, closed

YAML frontmatter with EXACTLY these keys, in this order:

```yaml
---
id: <kebab-case, unique, matches the filename without .md>
version: <semver — bump on every change>
owner: <the actor that maintains this document>
humanApprover: Zamp
specs: [<SPEC-IDs this runbook operationalizes, per spec/spec-anchored-development.md>]
inputs: [<what the operator must have before starting — names, never values>]
outputs: [<what a completed run produces — evidence, records>]
gateRequired: <true|false — whether any step needs HUMAN_GATE_GRANTED>
cloudMutation: <true|false — whether any step can change cloud state>
---
```

Rules:

- `humanApprover` is always `Zamp`. A runbook cannot delegate that, and a value naming anyone
  else is invalid.
- `cloudMutation: true` implies `gateRequired: true` — there is no such thing as an ungated
  mutation runbook.
- `specs` must name registered SPEC-IDs only; an empty list is valid solely for runbooks that
  touch no spec-anchored behavior (and should be rare).
- `inputs`/`outputs` name artifacts and identifiers, **never** secret values, account ids or
  live ARNs.

## Sections — required, in this order

| Section | Contents |
| --- | --- |
| **Preflight** | Every condition verified BEFORE the first command: reviewed commits, gates present, environment state, prior evidence. Each item is checkable; "be careful" is not a preflight. |
| **Commands** | The exact commands, in order, each with its expected outcome. A command whose tooling does not exist yet is marked `PLANNED — not executable` and the runbook says so at the top. |
| **Evidence** | What is captured, where it is recorded (run summary, `EVENTS.md`, issue), and what it must contain. Evidence follows the redaction discipline: no secrets, no account ids, no value-derived markers. |
| **Stop conditions** | The exact states that HALT the run. Each names its signal (refusal code, exit status, missing evidence) and the required next action. Continuing past a stop condition is never an operator judgment call. |
| **Rollback** | How to return to the last known-good state, and what "known-good" means for this operation. If rollback itself mutates cloud state, it needs its own gate and says so. |
| **Cleanup** | What is removed or reset after success AND after failure — temporary files, per-run variables, expired gates — and what is deliberately retained as record. |

## Style

- English, wrapped at ~100 columns, matching the rest of the repository's documentation.
- Full 40-character SHAs where commits are referenced; never branch names as identity.
- Placeholders in `<angle-brackets>`; the AWS documentation example account `111122223333` where
  an account-shaped value is unavoidable.
- One operation per runbook. A flow with independent decisions is multiple runbooks that link.
