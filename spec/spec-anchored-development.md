# Spec-Anchored Development

> **Status: DESIGN — under independent review.** This document defines the contract. The
> mechanical conformance auditor, the JSON Schema tooling and any CI or runtime change are a
> LATER phase and do not exist yet; nothing in this document creates authority or executes
> anything. Approval flows are unchanged: `HUMAN_GATE_GRANTED` (Zamp) remains the only
> authorization there is, per [`.agent-handoff/MESSAGE-PROTOCOL.md`](../.agent-handoff/MESSAGE-PROTOCOL.md).

## 1. The problem this solves

Sixteen review rounds of #70 Slice B1 hardened one deploy lane into a dense set of invariants —
closed stack sets, gate schemas, plan digests, structural validation, constant redaction. Every
one of those invariants lives **in code and in tests**, and the code is its own specification:
to know what the system promises, a reviewer must read the implementation. That worked, at
cost — each round rediscovered the contract by reading the code — and it does not scale past one
lane. The contract must live OUTSIDE the code it governs, and conformance must be checked
mechanically, or the next slice re-pays the same review price.

## 2. Model

```
SPEC  ──anchors──▶  CODE
   \                /
    ▼              ▼
   MECHANICAL AUDITOR (CI)          — exit 1 on any divergence
            │
            ▼
   GEMINI SPEC AUDITOR              — semantic interpretation, report only
            │
            ▼
   CODEX (independent review)  ──▶  ZAMP (decision, HUMAN_GATE_GRANTED)
```

- The **spec** states every reviewed invariant, each under a stable `SPEC-ID`.
- The **code** conforms to the spec and carries traceability back to it.
- The **mechanical auditor** (future phase) verifies traceability and conformance in CI and
  **fails the build with exit 1** on any divergence — missing anchor, orphaned SPEC-ID,
  contradicted invariant, unmapped test.
- The **Gemini Spec Auditor** ([`spec/agents/gemini-spec-auditor.md`](agents/gemini-spec-auditor.md))
  reads the mechanical results and hunts the gaps a mechanical pass cannot see. It reports; it
  decides nothing.
- **Codex** reviews independently, as always. **Zamp** decides, as always.

## 3. Authority of the spec

1. **The spec is the contract.** Where spec and code disagree, the CODE is wrong — or the spec
   must be changed FIRST, through its own review, before the code may follow. There is no third
   state.
2. **The spec is never updated automatically.** No tool, script, agent or CI job may edit a spec
   file to make a failing conformance check pass. A divergence is a finding, never an update.
   The mechanical auditor is read-only over `spec/` by construction, and the future
   implementation must prove that property with tests.
3. **Divergence closes CI.** The mechanical auditor exits non-zero (exit 1) on any divergence,
   and the lane treats that exactly like a failing test suite: nothing merges, nothing publishes,
   nothing deploys on top of it.
4. **Spec evolution is fix-forward review, like code.** A spec change is a commit, reviewed by
   Codex with `SCOPE: code` evidence rules (file/line, control IDs), and lands only through the
   normal flow. Retiring a SPEC-ID requires stating, in the same commit, what supersedes it —
   IDs are never silently deleted, and a retired ID stays in the registry marked `RETIRED` with
   its successor named.
5. **One invariant, one ID, forever.** A `SPEC-ID` is never reused for a different meaning.

## 4. SPEC-ID and traceability

Format: `SPEC-<AREA>-<NNN>` — `AREA` is a short uppercase token (`DEPLOY`, `LANE`, `IAM`, …),
`NNN` a zero-padded ordinal. The registry below is the single index; an area file may elaborate,
but the ID is minted here.

Traceability is three-way, and all three directions are mandatory:

| Direction | Meaning | Verified by (future mechanical auditor) |
| --- | --- | --- |
| SPEC → code | every SPEC-ID names at least one implementing anchor (file, symbol) | anchor exists and matches |
| SPEC → test | every SPEC-ID names at least one test that fails when the invariant is broken | test exists; mutation evidence recorded in review |
| code/test → SPEC | every anchor annotation refers to a registered SPEC-ID | no orphan annotations, no unregistered IDs |

The annotation syntax for code and tests (to be applied in the implementation phase) is a plain
comment token, `[SPEC-<AREA>-<NNN>]`, greppable and language-independent. Until that phase, the
registry's anchor columns below ARE the mapping.

## 5. Seed registry

These IDs bind invariants that already exist and already survived independent review (#70 Slice
B1, rounds 1–15). They are recorded now so the first mechanical audit has a real target, not a
promise. Anchors are current as of commit `346fe2dcd79654f3e4c3a145899b2e52a34034a9`.

| SPEC-ID | Invariant (summary) | Code anchor | Test anchor |
| --- | --- | --- | --- |
| SPEC-DEPLOY-001 | The deploy effect is the closed DEPLOYABLE stack set, executed with `--exclusively`; `--all` never reaches a child; every app stack is classified deployable or excluded | `infra/aws/lib/context.js` (`DEPLOYABLE_STACK_IDS`, `EXCLUDED_STACK_IDS`), `infra/aws/bin/deploy-release.js` | `infra/aws/test/app.test.js` (classification discovery), `infra/aws/test/deploy-preflight.test.js` |
| SPEC-DEPLOY-002 | The cloud gate is a closed schema (issue, environment, releaseSha, assemblyDigest, decisionId, mode, planDigest, stacks, approvedAt, expiresAt): strict RFC3339 UTC with calendar round-trip, TTL ≤ 1h, plan groups from the closed list only | `infra/aws/bin/deploy-release.js` (`checkCloudGate`, `strictUtcInstant`, `CLOUD_GATE_KEYS`) | `infra/aws/test/deploy-preflight.test.js` (gate suite) |
| SPEC-DEPLOY-003 | The plan is named, immutable CloudFormation change sets; `plan_only` prepares, `deploy` re-describes and executes exactly the digest-bound sets; drift refuses as `PLAN_CHANGED` | `infra/aws/bin/deploy-release.js` (`canonicalChangeSet`, `planDigestOf`, step 5) | `infra/aws/test/deploy-preflight.test.js` (PLAN_CHANGED, execution suites) |
| SPEC-DEPLOY-004 | First deployments run in reviewed dependency waves; the real synthesized import graph must respect wave order | `infra/aws/lib/context.js` (`DEPLOYMENT_PLAN_GROUPS`) | `infra/aws/test/release-bootstrap.test.js` (wave + literal-import walker) |
| SPEC-DEPLOY-005 | Every DescribeChangeSet page is validated against the documented schema — names, types, enums, nullability, positional ARN contracts — immediately after parse, before any transformation; violations refuse before any digest | `infra/aws/bin/deploy-release.js` (`CHANGE_SET_SCHEMA`, `validateChangeSet`, `describePlannedChangeSet`) | `infra/aws/test/deploy-preflight.test.js` (rounds 13–15 suites) |
| SPEC-DEPLOY-006 | Review material uses constant redaction: no derivation of an observed value is ever published; deltas are computed in memory (`changed`/`unchanged`); decision-bearing identities render verbatim, generated ids never | `infra/aws/bin/deploy-release.js` (`REDACT`, `renderPlan`, `renderArnResource`, `renderUrl`) | `infra/aws/test/deploy-preflight.test.js` (redaction/classifiability suites) |
| SPEC-DEPLOY-007 | Unstructured child output is never echoed; failures record exit code, per-stream byte counts and a stream-framed digest | `infra/aws/bin/deploy-release.js` (`childEvidence`) | `infra/aws/test/deploy-preflight.test.js` (round 11/12 evidence suite) |
| SPEC-DEPLOY-008 | The gate window and the account are revalidated at the mutation boundary — account first, clock as the last operation before EACH change-set execution; partial progress is reported honestly | `infra/aws/bin/deploy-release.js` (step 5e) | `infra/aws/test/deploy-preflight.test.js` (window-lapse suites) |
| SPEC-LANE-001 | Credentials and project code never share a window: synth is credential-free and precedes the pinned OIDC consumer; after the consumer only the reviewed entrypoints execute | `.github/workflows/release-pilot.yml` | `test/release-pilot-workflow.test.js` (credential-window rule + controls) |
| SPEC-LANE-002 | Releases serialize on the literal per-environment concurrency group, never derived from inputs | `.github/workflows/release-pilot.yml` | `test/release-pilot-workflow.test.js` (serialization rule + controls) |
| SPEC-LANE-003 | Every job carries its reviewed `timeout-minutes` bound (preflights 5, deploy 15) | `.github/workflows/release-pilot.yml` | `test/release-pilot-workflow.test.js` (time-bound rule + controls) |
| SPEC-LANE-004 | Pilot promotion is mechanically blocked: `mode` offers only `dev_only` until O1/O2, the deployed smokes and the live SNS/KMS proof land | `.github/workflows/release-pilot.yml` | `test/release-pilot-workflow.test.js` (promotion rule + controls) |
| SPEC-IAM-001 | Each tier has its own release bootstrap (qualifier, toolkit stack, deploy-role boundary, execution policy); dev authority cannot reach pilot or the foundation bootstrap | `infra/aws/lib/context.js` (`RELEASE_BOOTSTRAP_QUALIFIERS`), `infra/aws/lib/security-stack.js`, `infra/aws/bootstrap/policies/` | `infra/aws/test/release-bootstrap.test.js`, `infra/aws/test/bootstrap-policies.test.js`, `infra/aws/test/security-stack.test.js` |
| SPEC-IAM-002 | Ownership is proven by Project/Environment tags where AWS generates ids; governance tags can be neither removed nor replaced; every wildcard is a named exception | `infra/aws/bootstrap/policies/cfn-exec-release.template.json` | `infra/aws/test/release-bootstrap.test.js` (tag-confinement suites) |

## 6. Relationship to existing mechanisms

The reviewed-object pattern (`EXPECTED_WORKFLOW` in `test/release-pilot-workflow.test.js`) and
the closed `CHANGE_SET_SCHEMA` are early instances of spec-anchoring that live inside test/code
files. They remain valid; the registry above points AT them. Migrating their content into
standalone spec files is implementation-phase work and must not weaken them — the mechanical
auditor must prove the migrated spec and the in-code object agree before the in-code copy may be
demoted to a mirror.

## 7. What the next phase must deliver (and this phase must not)

The implementation phase — only after this design passes independent review and Zamp's
decision — delivers: the machine-readable spec format (JSON Schema or equivalent), the
mechanical conformance checker wired into CI with exit 1 semantics, the `[SPEC-ID]` annotations,
and the protocol/authority-policy amendments that formally seat the Gemini Spec Auditor persona.
None of that exists in this commit, and this document grants no authority to build it without
that review.
