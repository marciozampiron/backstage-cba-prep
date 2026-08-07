# Spec-Anchored Development

> **Status: DESIGN — under independent review.** This document defines the contract. The
> traceability linter, the conformance checks, the machine-readable registry file and any CI or
> runtime change are a LATER phase and do not exist yet; nothing in this document creates
> authority or executes anything. Approval flows are unchanged: `HUMAN_GATE_GRANTED` (Zamp)
> remains the publication instrument, and cloud effects have their own Zamp-issued
> authorization, per §8 and
> [`.agent-handoff/MESSAGE-PROTOCOL.md`](../.agent-handoff/MESSAGE-PROTOCOL.md).

## 1. The problem this solves

Sixteen review rounds of #70 Slice B1 hardened one deploy lane into a dense set of invariants —
closed stack sets, gate schemas, plan digests, structural validation, constant redaction. Every
one of those invariants lives **in code and in tests**, and the code is its own specification:
to know what the system promises, a reviewer must read the implementation. That worked, at
cost — each round rediscovered the contract by reading the code — and it does not scale past one
lane. The contract must live OUTSIDE the code it governs, and conformance must be checked
mechanically where mechanical checking is honest, with the residue named and assigned.

## 2. Model

```text
SPEC  ──anchors──▶  CODE
   \                /
    ▼              ▼
   TRACEABILITY LINTER + CONFORMANCE CHECKS (CI)   — exit 1 on any divergence of an ACTIVE id
            │
            ▼
   GEMINI SPEC AUDITOR              — semantic interpretation, report only
            │
            ▼
   CODEX (independent review)  ──▶  ZAMP (decision)
```

- The **spec** states every reviewed invariant, each under a stable `SPEC-ID` with a lifecycle
  status (§4).
- The **code** conforms to every ACTIVE invariant and carries traceability back to it.
- CI runs two mechanical layers (§6) and **fails the build with exit 1** when any ACTIVE
  invariant diverges.
- The **Gemini Spec Auditor** ([`spec/agents/gemini-spec-auditor.md`](agents/gemini-spec-auditor.md))
  covers what a mechanical pass cannot see. It reports; it decides nothing.
- **Codex** reviews independently, as always. **Zamp** decides, as always.

## 3. Authority of the spec

1. **The spec is the contract.** Where an ACTIVE invariant and code disagree, the CODE is wrong —
   or a successor invariant must be PROPOSED and travel the lifecycle (§4). There is no third
   state.
2. **The spec is never updated automatically.** No tool, script, agent or CI job may edit a spec
   file to make a failing conformance check pass. A divergence is a finding, never an update.
   The mechanical layers are read-only over `spec/` by construction, and the future
   implementation must prove that property with tests.
3. **Divergence of an ACTIVE invariant closes CI.** Exit 1, treated exactly like a failing test
   suite: nothing merges, nothing publishes, nothing deploys on top of it.
4. **Spec evolution is fix-forward review, like code** — through the lifecycle below, never by
   editing an ACTIVE invariant's normative text in place.

## 4. Lifecycle — how "spec first" and "fail-closed CI" coexist

A naive rule — "spec lands first" plus "any divergence fails CI" — deadlocks: the changed spec
cannot merge while the old code stands. The lifecycle resolves it. Every SPEC-ID carries a
status, and **CI enforces conformance only for ACTIVE ids**:

```text
PROPOSED ──(activation commit: code+tests conform, flip in the same tree)──▶ ACTIVE
                                                                               │
                                              (successor activates, names it)  ▼
                                                                            RETIRED
```

- **PROPOSED** — the invariant's normative text is registered and independently reviewed as a
  spec-only commit. It merges freely: CI does not enforce it yet, so review happens FIRST
  without blocking the tree. A PROPOSED id authorizes nothing and demands nothing.
- **ACTIVE** — enforcement on. The flip PROPOSED→ACTIVE happens **in the implementation commit**
  whose tree already conforms (code, tests, annotations present); the linter refuses an
  activation whose conformance predicates do not hold in that same tree. From this point the
  normative text is immutable.
- **RETIRED** — enforcement off, record kept. An ACTIVE invariant is never edited: a change
  mints a successor id as PROPOSED; the successor's activation commit retires the predecessor
  and names it (`supersededBy`/`supersedes`), atomically. Ids are never reused and never
  deleted.

Consequences, stated so nobody rediscovers them: a spec-only commit can always merge; an
activation is always atomic with the conformance it claims; and at every commit on the reviewed
branch, every ACTIVE id holds — there is no window where CI is red "because the spec moved".

## 5. SPEC-ID, atomicity and traceability

Format: `SPEC-<AREA>-<NNN>` — `AREA` uppercase (`GOV`, `AUDIT`, `RUN`, `DEPLOY`, `LANE`, `IAM`),
`NNN` zero-padded. **One invariant, one id**: an id binds exactly one refusable behavior — if
two distinct mutations of the system would each need a different sentence to explain what broke,
those are two ids. (Round 2 of this design's review found compound seeds; §7 splits them.)

Traceability is three-way, and all three directions are mandatory **for ACTIVE ids**:

| Direction | Meaning | Verified by |
| --- | --- | --- |
| SPEC → code | the id names its implementing anchors: file + exported symbol | linter: anchor exists |
| SPEC → test | the id names the exact tests that fail when the invariant breaks | linter: test exists; conformance: test passes; mutation evidence per §6 |
| code/test → SPEC | every `[SPEC-…]` annotation resolves to a registered id | linter: no orphans, no unregistered ids |

The annotation token is `[SPEC-<AREA>-<NNN>]`, greppable and language-independent, applied in
the implementation phase. Until then, the registry's anchor columns ARE the mapping.

## 6. The mechanical layers — what each one honestly proves

Round 2 of this design's review was right: annotation and anchor checking proves REFERENCES,
not conformance. The design therefore names two layers and the residue:

**Layer 1 — traceability LINTER.** Verifies §5's three directions plus lifecycle legality
(activation only with conformance, retirement only with a successor, normative text of ACTIVE
ids unchanged since activation). It proves the map is complete and current — nothing more.

**Layer 2 — CONFORMANCE CHECKS.** The registry (§6a) gives every ACTIVE id executable
predicates, and CI runs them:

- the id's named tests exist AND pass in this tree;
- the id's named executable checks (small scripts or assertions: "`--all` is absent from the
  entrypoint's child arguments", "the parsed workflow deep-equals the reviewed object", "the
  policy grants no unconditioned apigateway mutation") pass in this tree;
- a change under the id's governed paths without a change to its tests or checks is flagged for
  review (it may be fine; it is never silent);
- **mutation evidence** is recorded per id: the reviewed reversion proofs ("removing X fails
  N tests") from the #70 rounds are registered as review artifacts, and the linter requires the
  record to exist for activation. Re-running mutations continuously is not claimed; keeping the
  evidence current when tests change is review's job, and the auditor flags staleness.

**The residue — named, not hidden.** No mechanical layer proves that prose and code MEAN the
same thing, that a test could ever fail, or that an unannotated behavior matters. That residue
is exactly the Gemini Spec Auditor's charter, followed by Codex's independent review. Calling
layer 1+2 a "conformance auditor" without this paragraph would overclaim, so this paragraph is
part of the contract.

### 6a. The machine-readable registry (planned format)

The implementation phase delivers `spec/registry.json` — canonical, closed schema, one entry per
id:

```jsonc
{
  "id": "SPEC-DEPLOY-001",
  "status": "ACTIVE",                    // PROPOSED | ACTIVE | RETIRED
  "title": "closed deployable stack set",
  "normativeText": "…the exact sentence(s)…",
  "normativeSha256": "<digest of normativeText — immutability check for ACTIVE>",
  "anchors": [{ "file": "infra/aws/lib/context.js", "symbol": "DEPLOYABLE_STACK_IDS" }],
  "tests": [{ "file": "infra/aws/test/app.test.js", "title": "every stack the app constructs is CLASSIFIED…" }],
  "checks": [{ "kind": "script", "ref": "spec/checks/deploy-001-no-all.sh" }],
  "governedPaths": ["infra/aws/lib/context.js", "infra/aws/bin/deploy-release.js"],
  "mutationEvidence": "reviewed in #70 round N — reversion fails K tests",
  "supersedes": null,
  "supersededBy": null
}
```

The human-readable tables in this file and the registry must agree; the linter checks that too.
Until `spec/registry.json` exists, this document is the registry of record.

## 7. Seed registry

Statuses are real: ids whose anchors and failing tests already exist are **ACTIVE** (their
conformance is the current reviewed tree at `346fe2dcd79654f3e4c3a145899b2e52a34034a9` and, for
this document's own commit, its descendants); the governance/audit/runbook ids are **PROPOSED**
— their enforcement tooling does not exist yet, and activating them before it does would claim
a check nobody runs.

### 7a. Self-governance — the spec system under its own rules

| SPEC-ID | Status | Invariant (summary) | Anchors today | Tests today |
| --- | --- | --- | --- | --- |
| SPEC-GOV-001 | PROPOSED | The spec is never updated automatically; a divergence is a finding, and the mechanical layers are read-only over `spec/` | this file §3 | none yet — activation requires the linter proving its own read-only property |
| SPEC-GOV-002 | PROPOSED | Lifecycle PROPOSED→ACTIVE→RETIRED; CI enforces ACTIVE only; activation atomic with conformance; ACTIVE text immutable; retirement names a successor | this file §4 | none yet |
| SPEC-GOV-003 | PROPOSED | Three-way traceability for every ACTIVE id | this file §5 | none yet |
| SPEC-GOV-004 | PROPOSED | One invariant, one id; ids never reused or deleted | this file §5 | none yet |
| SPEC-AUDIT-001 | PROPOSED | Audit order is fixed: mechanical, then semantic interpretation, then independent review, then human decision — no stage substitutes another | `docs/runbooks/spec-conformance-audit.md` | none yet |
| SPEC-AUDIT-002 | PROPOSED | The auditor persona holds no authority: no approval, no risk acceptance, no effects, no edits, no protocol seat before a reviewed protocol amendment | `spec/agents/gemini-spec-auditor.md` §2 | none yet |
| SPEC-AUDIT-003 | PROPOSED | Every audit is reproducibly bound: commit, base, diffs and inputs by digest; model and limits pinned; spend separately authorized by Zamp | `spec/agents/gemini-spec-auditor.md` §§3–6 | none yet |
| SPEC-RUN-001 | PROPOSED | Runbooks confer no authority and follow the closed standard (frontmatter, required sections, one operation per runbook; `kind: index` documents link and hold no commands) | `docs/runbooks/README.md` | none yet |
| SPEC-RUN-002 | PROPOSED | `cloudMutation: true` implies an authorization requirement, `humanApprover` is always Zamp, and preparing change sets IS cloud mutation | `docs/runbooks/README.md`, `docs/runbooks/aws-dev-release-plan.md` | none yet |

### 7b. Release-lane invariants (already reviewed; ACTIVE)

Anchors current as of `346fe2dcd79654f3e4c3a145899b2e52a34034a9`. Compound seeds from design
round 1 are split here to satisfy SPEC-GOV-004; the split ids supersede nothing (they are the
first registration of each invariant).

| SPEC-ID | Status | Invariant (summary) | Code anchor | Test anchor |
| --- | --- | --- | --- | --- |
| SPEC-DEPLOY-001 | ACTIVE | The deploy effect is the closed DEPLOYABLE stack set, executed with `--exclusively`; `--all` never reaches a child; every app stack is classified deployable or excluded | `infra/aws/lib/context.js` (`DEPLOYABLE_STACK_IDS`), `infra/aws/bin/deploy-release.js` | `infra/aws/test/app.test.js`, `infra/aws/test/deploy-preflight.test.js` |
| SPEC-DEPLOY-002 | ACTIVE | The cloud authorization value is a closed schema — exactly its ten keys, issue pinned, modes `plan_only`/`deploy`, `decisionId` shape — validated against the verified manifest | `infra/aws/bin/deploy-release.js` (`checkCloudGate`, `CLOUD_GATE_KEYS`) | `infra/aws/test/deploy-preflight.test.js` (gate-closed suite) |
| SPEC-DEPLOY-003 | ACTIVE | The plan is named, immutable CloudFormation change sets; `plan_only` prepares, `deploy` re-describes and executes exactly the digest-bound sets; drift refuses as `PLAN_CHANGED` | `infra/aws/bin/deploy-release.js` (`canonicalChangeSet`, `planDigestOf`) | `infra/aws/test/deploy-preflight.test.js` |
| SPEC-DEPLOY-004 | ACTIVE | First deployments run in reviewed dependency waves; the synthesized import graph must respect wave order | `infra/aws/lib/context.js` (`DEPLOYMENT_PLAN_GROUPS`) | `infra/aws/test/release-bootstrap.test.js` |
| SPEC-DEPLOY-005 | ACTIVE | Every DescribeChangeSet response is validated against the documented schema — names, types, enums, documented nullability — and an unreviewed field refuses the plan | `infra/aws/bin/deploy-release.js` (`CHANGE_SET_SCHEMA`, `validateChangeSet`) | `infra/aws/test/deploy-preflight.test.js` (rounds 13–14 suites) |
| SPEC-DEPLOY-006 | ACTIVE | Review material uses constant redaction: no derivation of an observed value is published; deltas are computed in memory as `changed`/`unchanged` | `infra/aws/bin/deploy-release.js` (`REDACT`, `renderPlan`) | `infra/aws/test/deploy-preflight.test.js` (round 13 redaction suite) |
| SPEC-DEPLOY-007 | ACTIVE | Unstructured child output is never echoed; failures record exit code, per-stream byte counts and a stream-framed digest | `infra/aws/bin/deploy-release.js` (`childEvidence`) | `infra/aws/test/deploy-preflight.test.js` |
| SPEC-DEPLOY-008 | ACTIVE | Window and account revalidate at the mutation boundary — account first, clock last before EACH execution; partial progress reported honestly | `infra/aws/bin/deploy-release.js` (step 5e) | `infra/aws/test/deploy-preflight.test.js` |
| SPEC-DEPLOY-009 | ACTIVE | Authorization instants are strict RFC3339 UTC with calendar round-trip — `2026-02-30` and non-UTC offsets are malformed | `infra/aws/bin/deploy-release.js` (`strictUtcInstant`) | `infra/aws/test/deploy-preflight.test.js` (calendar suite) |
| SPEC-DEPLOY-010 | ACTIVE | The authorization window is bounded: `approvedAt` ≤ now < `expiresAt`, TTL ≤ 1 hour — a standing authorization cannot be expressed | `infra/aws/bin/deploy-release.js` (`CLOUD_GATE_MAX_TTL_MS`) | `infra/aws/test/deploy-preflight.test.js` (TTL suite) |
| SPEC-DEPLOY-011 | ACTIVE | The authorized stack group must be one of the reviewed plan groups — a lone subset, a foundation smuggle or a reordered set refuses | `infra/aws/bin/deploy-release.js` (group check), `infra/aws/lib/context.js` | `infra/aws/test/deploy-preflight.test.js` (plan-group suite) |
| SPEC-DEPLOY-012 | ACTIVE | Every service page is validated immediately after parse, before storage, spread or token read; pagination is consumed or the plan refuses | `infra/aws/bin/deploy-release.js` (`describePlannedChangeSet`) | `infra/aws/test/deploy-preflight.test.js` (rounds 11/15 suites) |
| SPEC-DEPLOY-013 | ACTIVE | ARN-typed fields carry positional contracts (change set, stack, SNS topic, CloudWatch alarm) with mandatory components; the permissive reference exists only at `CausingEntity` | `infra/aws/bin/deploy-release.js` (`arnRef` contracts) | `infra/aws/test/deploy-preflight.test.js` (round 15 suite) |
| SPEC-DEPLOY-014 | ACTIVE | Decision-bearing identities render verbatim (reviewed host families, IAM principal paths, project-chosen names); generated identifiers never render | `infra/aws/bin/deploy-release.js` (`renderHost`, `renderArnResource`, `renderUrl`) | `infra/aws/test/deploy-preflight.test.js` (classifiability suites) |
| SPEC-LANE-001 | ACTIVE | Credentials and project code never share a window: synth precedes the pinned OIDC consumer; after it, only the reviewed entrypoints execute | `.github/workflows/release-pilot.yml` | `test/release-pilot-workflow.test.js` |
| SPEC-LANE-002 | ACTIVE | Releases serialize on the literal per-environment concurrency group, never derived from inputs | `.github/workflows/release-pilot.yml` | `test/release-pilot-workflow.test.js` |
| SPEC-LANE-003 | ACTIVE | Every job carries its reviewed `timeout-minutes` bound | `.github/workflows/release-pilot.yml` | `test/release-pilot-workflow.test.js` |
| SPEC-LANE-004 | ACTIVE | Pilot promotion is mechanically blocked until its prerequisites land | `.github/workflows/release-pilot.yml` | `test/release-pilot-workflow.test.js` |
| SPEC-IAM-001 | ACTIVE | Each tier has its own release bootstrap; dev authority cannot reach pilot or the foundation | `infra/aws/lib/context.js`, `infra/aws/lib/security-stack.js`, `infra/aws/bootstrap/policies/` | `infra/aws/test/release-bootstrap.test.js`, `bootstrap-policies.test.js`, `security-stack.test.js` |
| SPEC-IAM-002 | ACTIVE | Ownership is proven by Project/Environment tags where AWS generates ids; governance tags can be neither removed nor replaced; every wildcard is a named exception | `infra/aws/bootstrap/policies/cfn-exec-release.template.json` | `infra/aws/test/release-bootstrap.test.js` |

## 8. Two authorizations, both Zamp's, never interchangeable

Design round 2 found the conflation, and this section closes it:

- **Publication authorization** — the protocol's `HUMAN_GATE_GRANTED` with its closed nine-key
  schema. It authorizes exactly branch publication and pull-request creation. Nothing else.
- **Cloud authorization** — its own closed, effect-bound schema: today, the `CBA_CLOUD_GATE`
  value (SPEC-DEPLOY-002/009/010/011), set per decision by Zamp, bounded in time, bound to the
  exact release, assembly, plan and stack group. **Preparing change sets is already cloud
  mutation** — `plan_only` creates change sets and publishes assets — so `plan_only` requires
  cloud authorization exactly as `deploy` does.

Neither instrument substitutes the other, neither is issued by anyone but Zamp, and a runbook
mentioning either grants nothing (SPEC-RUN-001).

## 9. Relationship to existing mechanisms

The reviewed-object pattern (`EXPECTED_WORKFLOW`) and the closed `CHANGE_SET_SCHEMA` are early
spec-anchors living inside test/code files. They remain valid; the registry points AT them.
Migrating their content into standalone spec files is implementation-phase work and must not
weaken them — the linter must prove the migrated spec and the in-code object agree before the
in-code copy is demoted to a mirror.

## 10. What the next phase must deliver (and this phase must not)

Only after this design passes independent review and Zamp's decision: `spec/registry.json` and
its closed schema, the traceability linter and conformance checks wired into CI with exit 1
semantics, the `[SPEC-ID]` annotations, activation of the PROPOSED ids as their tooling lands,
and the protocol/authority-policy amendments that formally seat the auditor persona. None of
that exists in this commit, and this document grants no authority to build it without that
review.
