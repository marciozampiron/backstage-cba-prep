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
- **RETIRED before activation.** A PROPOSED id may be retired without ever having been ACTIVE,
  when review absorbs its content into another PROPOSED id — the case round 5 produced, where a
  partial successor and a mode extension had to become one complete successor. The rules that
  keep this from becoming a quiet delete: the retirement names the absorbing id
  (`supersededBy`), the absorbing id's normative text must already contain the retired text's
  obligation, the id stays permanently reserved and never reused, and — because a PROPOSED id
  was never enforced — nothing in the tree changes. A PROPOSED id retired this way carries no
  conformance claim, which is exactly why it can be retired in a design-only commit.

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

**Every registry row states NORMATIVE TEXT, not a summary.** The row is the sentence the system
is held to — imperative, refusable, and quotable in a finding. A summary would leave the actual
obligation in the code the spec is supposed to govern (design round 3).

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
  "status": "PROPOSED",                  // PROPOSED | ACTIVE | RETIRED
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

### 6b. Digests are framed, and immutability is checked against history

Two rules the #70 rounds already paid for, applied to this system's own artifacts:

1. **Canonical framed serialization, typed — and one framing per KIND of thing.** Every digest
   in this system is computed over a JSON document of length-explicit TYPED records, never over
   a concatenation. Round 6 of #70 reproduced a collision where one file's content contained the
   delimiter sequence two files induced; "concatenated in a recorded order" carries exactly that
   defect. Round 4 of this design's review found the second half: a `{path, bytes, sha256}`
   record cannot tell a deletion from an absence, a mode change from none, or a symlink from a
   regular file — and every one of those changes execution while the content record stays
   identical.

   Round 5 found the third: one record shape was being applied to three different KINDS of
   input. A normative text is a string, an audit input bundle is a snapshot of files at one
   commit, and change evidence is a diff between two commits. Describing all three with the
   diff shape made two of them nonsense — a string has no `oldPath`, a snapshot has no
   `status` — and, worse, allowed one kind's digest to be presented as another's. Each kind
   therefore has its own framing, and every digest is taken over

   ```jsonc
   { "digestKind": "text" | "snapshot" | "diff" | "bundle", "version": 1, /* kind-specific
      binding fields, see below */ "records": [ … ] }
   ```

   so that the kind AND what it is taken over are *inside* the digested bytes: a snapshot digest
   and a diff digest over the same tree cannot collide, and a digest cannot be quoted as evidence
   of a kind — or of a commit range — it does not describe.

   | Kind | Digests | Binding fields | Record shape (sorted by) |
   | --- | --- | --- | --- |
   | `text` | a single normative string (`normativeSha256`) | — | exactly one `{ "specId": "<SPEC-ID>", "encoding": "utf-8", "bytes": <number>, "text": "<the exact normative sentence>" }` — the text is IN the digested document, so the digest cannot drift from what it claims to cover |
   | `snapshot` | a set of files **tracked in the repository at ONE commit** | `"commit": "<full 40-character SHA>"` | `{ "path": "<repo-relative>", "type": "regular"\|"executable"\|"symlink", "mode": "<git mode string>", "bytes": <number>, "sha256": "<hex>" }`, sorted by `path` |
   | `diff` | the change between two commits (`patchSha256`, §6c, and change evidence) | `"baseSha"`, `"headSha"` — both full 40-character SHAs | `{ "status": "added"\|"modified"\|"deleted"\|"typechanged", "path": "<path>", "oldType"/"newType": "regular"\|"executable"\|"symlink"\|"absent", "oldMode"/"newMode": "<git mode string>"\|null, "oldBytes"/"newBytes": <number>\|null, "oldSha256"/"newSha256": "<hex>"\|null }`, sorted by `path` |
   | `bundle` | **generated** byte streams that are not repository files — tool reports, the prompt as invoked, the input bundle actually handed to a model | `"producer": "<tool identity + version, or the invoking runbook id>"` | `{ "name": "<stable name within the bundle>", "mediaType": "<IANA type>", "bytes": <number>, "sha256": "<hex>" }`, sorted by `name` |

   The digest is the SHA-256 of the document's `JSON.stringify` with keys in the order above.

   **`bundle` exists because round 6 found `snapshot` doing two jobs.** A snapshot is defined by a
   commit — that is what makes it independently recomputable by anyone with the repository — and a
   linter report or a prompt as invoked has no commit. Digesting them under a kind whose binding
   field is a commit either forces a false commit or leaves the field meaningless, and in both
   cases one artifact's digest could be presented as another's. Generated streams get their own
   kind, bound to what actually determines them: who produced them.

   **Every digest a document in this system names must state its kind.** A digest with no kind is
   not evidence of anything; §5a of the auditor persona maps each of its digests to one of these
   four, §6c fixes `patchSha256` as a `diff`, and §8a fixes `manifestDigest` as a `bundle` — the
   release manifest is PRODUCED BY the binding run, so it is a generated stream and not a set of
   tracked files at a commit, which round 7 caught as a contradiction with `snapshot`'s own
   definition. A future digest that fits none of the four kinds is a finding, not a fifth
   improvisation.

   **`renamed` is gone from the diff status enum, deliberately.** Git does not record renames;
   rename detection is a *similarity heuristic* whose output depends on a threshold and on what
   else changed in the same commit. A digest whose value depends on a heuristic is not
   reproducible by an independent verifier running slightly different tooling — the whole point
   of framing it. A rename is therefore recorded as a `deleted` plus an `added`, which is what
   the object model actually contains. Nothing is lost: both records carry type, mode, size and
   content digest, so the reviewer sees the same facts, and the semantic stage is free to
   OBSERVE that a delete and an add look like a rename — as a finding for a human to read, never
   as an input to a digest.

   A symlink's `sha256` is taken over its target string, never over the file it points at — the
   #70 assembly digest refuses symlinks outright for the same reason, and here they must be
   distinguishable rather than silently followed.
2. **ACTIVE immutability is proven against history, not against a self-declared field.** A
   commit can change `normativeText` and `normativeSha256` together and satisfy any check that
   compares them to each other. The linter therefore compares an ACTIVE id's normative text to
   the text at its **activation commit**, read from the reviewed history of the integration
   branch — an edit is detected because the past is not editable, not because a hash agrees with
   the string beside it.

### 6c. Mutation evidence is a closed record

"Reviewed in round N" is prose. The registry field is structured, and the linter requires all of
it before an activation:

```jsonc
"mutationEvidence": {
  "commit": "<full 40-character SHA where the proof was performed>",
  // a §6b `diff` document: baseSha = the commit, headSha = the reverted tree's commit,
  // both inside the digested bytes
  "patchSha256": "<hex>",
  "command": "<the exact command run to observe the failure>",
  "expectedFailure": "<the exact test name(s) that must fail, and how many>"
}
```

Round 7: `patchSha256` states its KIND, not merely that it is "framed". A patch is a change
between two trees, so it is a `diff` document whose `baseSha`/`headSha` are inside the digested
bytes — which is what lets a verifier recompute it instead of trusting the label.

A reversion proof nobody can re-run is not evidence. Staleness — the named tests no longer
existing, or the patch no longer applying — is a finding for the semantic stage, not a silent
pass.

## 7. Seed registry

**Every id below is PROPOSED, including the ones whose code and tests already exist.** Round 4 of
this design's review caught the contradiction: ACTIVE means *CI enforces this id*, and no id can
be enforced before the linter and the conformance checks exist. A design-only commit is also not
an activation commit — §4 requires an activation to contain the conformance it claims.

The registry therefore records two different things, and keeps them apart: the invariant's text
and anchors, and — where it is already true — the evidence that the current tree conforms. The
first activation commit is the one that turns evidence into enforcement, id by id.

### 7a. Self-governance — the spec system under its own rules

All PROPOSED: their enforcement tooling does not exist, and activating an id before its check
runs would claim a guarantee nobody performs.

| SPEC-ID | Status | Normative text | Anchor |
| --- | --- | --- | --- |
| SPEC-GOV-001 | PROPOSED | No tool, script, agent or CI job may write to `spec/`. A conformance divergence is reported as a finding and never resolved by editing the spec. | this file §3 |
| SPEC-GOV-002 | PROPOSED | Every SPEC-ID carries exactly one of PROPOSED, ACTIVE, RETIRED. CI enforces conformance for ACTIVE ids only. | this file §4 |
| SPEC-GOV-003 | PROPOSED | A PROPOSED id becomes ACTIVE only in a commit whose tree already satisfies its conformance predicates; the linter refuses an activation whose predicates do not hold in that same tree. | this file §4 |
| SPEC-GOV-004 | PROPOSED | An ACTIVE id's normative text is immutable: the linter compares it to the text at its activation commit in the integration branch's history and fails on any difference. | this file §4, §6b |
| SPEC-GOV-005 | PROPOSED | An ACTIVE id is retired only by an activation commit that names its successor, and the successor names it back. A SPEC-ID is never reused and never deleted. | this file §4 |
| SPEC-GOV-006 | PROPOSED | Every ACTIVE id names at least one code anchor, at least one test that fails when the invariant breaks, and every `[SPEC-…]` annotation in the tree resolves to a registered id. | this file §5 |
| SPEC-GOV-007 | PROPOSED | One SPEC-ID binds exactly one refusable behavior: if two distinct mutations require two different sentences to explain the break, they are two ids. | this file §5 |
| SPEC-GOV-008 | PROPOSED | Every digest this system publishes is computed over the canonical framed serialization of §6b, never over a concatenation. | this file §6b |
| SPEC-GOV-009 | PROPOSED | Mutation evidence is a closed record of commit, patch digest, command and expected failure; an activation without it is refused. | this file §6c |
| SPEC-AUDIT-001 | PROPOSED | The audit stages run in order — traceability linter, conformance checks, semantic interpretation, independent review, human decision — and no stage substitutes another. | `docs/runbooks/spec-conformance-audit.md` |
| SPEC-AUDIT-002 | PROPOSED | The auditor persona approves nothing, accepts no risk, performs no effect, edits nothing, and holds no protocol seat before a reviewed protocol amendment. | `spec/agents/gemini-spec-auditor.md` §2 |
| SPEC-AUDIT-003 | PROPOSED | Every audit report names its audited commit, its reviewed base, and the digests of the diff, the spec set, the mechanical reports, the input bundle and the persona. | `spec/agents/gemini-spec-auditor.md` §3 |
| SPEC-AUDIT-004 | PROPOSED | Every audit run pins its model, profile, timeout, token ceiling and cost ceiling; a run that hits a ceiling reports INCOMPLETE, which is never read as PASS. | `spec/agents/gemini-spec-auditor.md` §4 |
| SPEC-AUDIT-005 | PROPOSED | Each paid audit run happens under its own spend authorization, issued by Zamp and covering that run only. | `spec/agents/gemini-spec-auditor.md` §4 |
| SPEC-RUN-001 | PROPOSED | A runbook confers no authority: it documents how an operation is performed and never whether it may be. | `docs/runbooks/README.md` |
| SPEC-RUN-002 | PROPOSED | A document that mutates cloud state declares `cloudMutation: true` and depends on a cloud authorization; preparing a CloudFormation change set is cloud mutation. | `docs/runbooks/README.md` |
| SPEC-RUN-003 | PROPOSED | Runbook frontmatter carries exactly the closed key set, `humanApprover` is always Zamp, and `cloudMutation: true` implies `gateRequired: true`. | `docs/runbooks/README.md` |
| SPEC-RUN-004 | PROPOSED | A `kind: runbook` document covers exactly one operation with one decision; a `kind: index` document links runbooks and holds no commands. | `docs/runbooks/README.md` |
| SPEC-RUN-005 | PROPOSED | Every command in a runbook names the actor that performs it, and that actor is permitted to perform it by `spec/authority-policy.json`. | `docs/runbooks/README.md` |
| SPEC-RUN-006 | PROPOSED | A cloud authorization is authored only after a read-only binding operation has produced the exact manifest and assembly digest it must name. | `docs/runbooks/aws-dev-release-bind.md` |
| SPEC-RUN-007 | PROPOSED | The evidence of a cloud effect is a complete artifact bound to run id, decisionId, release SHA, stack group and plan digest; a truncated excerpt is not evidence. | `docs/runbooks/aws-dev-release-plan.md`, `-deploy.md` |
| SPEC-RUN-008 | PROPOSED | Change sets prepared for a plan that will not execute are deleted under their own authorization; they are never left to expire. | `docs/runbooks/aws-dev-release-abandon.md` |

### 7b. Release-lane invariants — PROPOSED, with conformance evidence that already exists

One row is a SUCCESSOR rather than a description of today: SPEC-DEPLOY-019 supersedes -002 when
it activates. Registering a successor as PROPOSED beside the invariant it will replace is
exactly the mechanism §4 describes, exercised here for the first time.

**Round 5 made that successor complete, and retired the second one.** The earlier -019 named
only the manifest digest while claiming to supersede -002, so activating it would have silently
dropped -002's closed key set, its `issue` pin, its `mode` enum and its `decisionId` shape — a
supersession that removes obligations is a weakening disguised as an upgrade. -019 now restates
every obligation it inherits and adds what it introduces; -002 remains registered, unchanged and
still describing exactly what today's reviewed code enforces, until -019's activation commit
retires it. SPEC-DEPLOY-020 (the `abandon` mode) was absorbed into -019 and is RETIRED under the
before-activation rule in §4 — it was never ACTIVE, so nothing was enforcing it and nothing in
the tree changes.

**Round 4 corrected these to PROPOSED.** They were marked ACTIVE, which contradicted this
document's own lifecycle in the same commit: ACTIVE means *CI enforces this id*, and the linter,
the conformance checks, the registry file and the annotations do not exist. An id cannot be
enforced by tooling nobody built, and a design-only commit cannot be an activation commit — an
activation must contain the conformance it claims (§4).

Nothing is lost by saying so. The **Conformance today** column records what is already true at
`346fe2dcd79654f3e4c3a145899b2e52a34034a9`: reviewed code, reviewed tests, and reversion proofs
performed during #70's fifteen rounds. That is the evidence a future activation commit will
carry — recorded now, claimed as enforcement never.

| SPEC-ID | Status | Normative text | Code anchor | Test anchor | Conformance today |
| --- | --- | --- | --- | --- | --- |
| SPEC-DEPLOY-001 | PROPOSED | The deploy child receives exactly the stack ids the manifest names, passed with `--exclusively`; `--all` never appears in a child's arguments. | `infra/aws/bin/deploy-release.js` | `infra/aws/test/deploy-preflight.test.js` | code + tests reviewed, reversion proven |
| SPEC-DEPLOY-002 | PROPOSED | The cloud authorization value satisfies a closed ten-key schema with `issue` pinned to 70, `mode` in {plan_only, deploy} and a `decisionId` matching its documented shape; any other shape refuses. | `infra/aws/bin/deploy-release.js` (`checkCloudGate`, `CLOUD_GATE_KEYS`) | `infra/aws/test/deploy-preflight.test.js` | code + tests reviewed, reversion proven |
| SPEC-DEPLOY-003 | PROPOSED | The plan is a set of named CloudFormation change sets: `plan_only` prepares them and `deploy` executes exactly those, addressed by their immutable change-set ids. | `infra/aws/bin/deploy-release.js` (`canonicalChangeSet`) | `infra/aws/test/deploy-preflight.test.js` | code + tests reviewed, reversion proven |
| SPEC-DEPLOY-004 | PROPOSED | A deploy executes only a stack group the reviewed plan-group list contains, and every cross-stack import in the synthesized templates resolves to a producer in an earlier group. | `infra/aws/lib/context.js` (`DEPLOYMENT_PLAN_GROUPS`) | `infra/aws/test/release-bootstrap.test.js` | code + tests reviewed, reversion proven |
| SPEC-DEPLOY-005 | PROPOSED | Every DescribeChangeSet response is validated against the reviewed schema — key names, types, documented enums and documented nullability — and any violation refuses the plan before a digest exists. | `infra/aws/bin/deploy-release.js` (`validateChangeSet`) | `infra/aws/test/deploy-preflight.test.js` | code + tests reviewed, reversion proven |
| SPEC-DEPLOY-006 | PROPOSED | In the plan rendering, no value observed in a change set is published either verbatim or as any derivation of itself; each is replaced by a constant class label. | `infra/aws/bin/deploy-release.js` (`REDACT`, `renderPlan`) | `infra/aws/test/deploy-preflight.test.js` | code + tests reviewed, reversion proven |
| SPEC-DEPLOY-007 | PROPOSED | Child stdout and stderr are never reproduced; a failure records the exit code, per-stream byte counts and one digest over the framed streams. This digest is the named exception to SPEC-DEPLOY-006: it covers whole streams that are never published, not a value in the rendering, so it offers no per-value oracle. | `infra/aws/bin/deploy-release.js` (`childEvidence`) | `infra/aws/test/deploy-preflight.test.js` | code + tests reviewed, reversion proven |
| SPEC-DEPLOY-008 | PROPOSED | The target account is resolved again immediately before the effect and, if it differs from the account the verification bound, the run refuses. | `infra/aws/bin/deploy-release.js` | `infra/aws/test/deploy-preflight.test.js` | code + tests reviewed, reversion proven |
| SPEC-DEPLOY-009 | PROPOSED | An authorization instant is accepted only as strict RFC3339 UTC that round-trips through the calendar; a normalized or offset instant refuses. | `infra/aws/bin/deploy-release.js` (`strictUtcInstant`) | `infra/aws/test/deploy-preflight.test.js` | code + tests reviewed, reversion proven |
| SPEC-DEPLOY-010 | PROPOSED | An authorization is valid only while `approvedAt` ≤ now < `expiresAt`, with `expiresAt − approvedAt` at most one hour. | `infra/aws/bin/deploy-release.js` (`CLOUD_GATE_MAX_TTL_MS`) | `infra/aws/test/deploy-preflight.test.js` | code + tests reviewed, reversion proven |
| SPEC-DEPLOY-011 | PROPOSED | The authorized stack group must equal one of the reviewed plan groups exactly, in content and order. | `infra/aws/bin/deploy-release.js` | `infra/aws/test/deploy-preflight.test.js` | code + tests reviewed, reversion proven |
| SPEC-DEPLOY-012 | PROPOSED | Each service response page is validated immediately after parsing and before it is stored, merged or read for a cursor; pagination is fully consumed or the plan refuses. | `infra/aws/bin/deploy-release.js` (`describePlannedChangeSet`) | `infra/aws/test/deploy-preflight.test.js` | code + tests reviewed, reversion proven |
| SPEC-DEPLOY-013 | PROPOSED | Each ARN-typed field is validated against its position's service and resource shape with all mandatory components present; only `CausingEntity` accepts a non-ARN reference. | `infra/aws/bin/deploy-release.js` | `infra/aws/test/deploy-preflight.test.js` | code + tests reviewed, reversion proven |
| SPEC-DEPLOY-014 | PROPOSED | Identities a reviewed decision produced — the approved host families, IAM principal paths and project-chosen resource names — render verbatim; AWS-generated identifiers never do. | `infra/aws/bin/deploy-release.js` (`renderHost`, `renderArnResource`) | `infra/aws/test/deploy-preflight.test.js` | code + tests reviewed, reversion proven |
| SPEC-DEPLOY-015 | PROPOSED | Every stack the app constructs appears in exactly one of the deployable or excluded lists, and an unclassified stack fails synthesis-time discovery. | `infra/aws/lib/context.js` (`DEPLOYABLE_STACK_IDS`, `EXCLUDED_STACK_IDS`) | `infra/aws/test/app.test.js` | code + tests reviewed, reversion proven |
| SPEC-DEPLOY-016 | PROPOSED | A plan recomputed at execution time that differs from the digest the authorization names refuses as `PLAN_CHANGED`, and no change set executes. | `infra/aws/bin/deploy-release.js` | `infra/aws/test/deploy-preflight.test.js` | code + tests reviewed, reversion proven |
| SPEC-DEPLOY-017 | PROPOSED | The authorization window is re-checked as the last operation before EACH change-set execution; a window that lapses mid-sequence stops the remaining executions. | `infra/aws/bin/deploy-release.js` | `infra/aws/test/deploy-preflight.test.js` | code + tests reviewed, reversion proven |
| SPEC-DEPLOY-019 | PROPOSED (supersedes -002 on activation; absorbs -020) | The cloud authorization value has EXACTLY these ten keys — `issue`, `mode`, `decisionId`, `releaseSha`, `environment`, `manifestDigest`, `stacks`, `planDigest`, `approvedAt`, `expiresAt` — no key absent and none unknown, with the per-key and per-mode constraints of §8a. Any other shape, and any effect outside the value's `mode`, refuses. | not yet implemented | not yet implemented | none — successor, awaiting its activation commit |
| SPEC-DEPLOY-020 | RETIRED (never ACTIVE; `supersededBy` SPEC-DEPLOY-019) | The cloud authorization schema carries an `abandon` mode, and an abandon run executes no change set and prepares none. | — | — | none — absorbed into SPEC-DEPLOY-019 before activation (§4) |
| SPEC-DEPLOY-022 | PROPOSED | The stack-record cleanup decision is a closed nine-key value (§8b): each key holds its exact grammar, `stackId` is a positionally validated CloudFormation stack ARN whose embedded region, account and name EQUAL the record's `region`, `account` and `stackName`, and the decision is valid only while `observedAt <= now < observedAt + 15 minutes`, a future instant refusing. The performer re-observes the same identity, status and window immediately before deleting. The activation commit must contain the instance parser and its adversarial tests. The residual TOCTOU that no re-observation can close leaves the effect without an executable procedure until Zamp records acceptance as the closed `riskAcceptance` record — a boolean is not a decision. | `spec/authority-policy.json` (`stack-record-authorization`) | `test/governance-model.test.js` | policy data + tests reviewed in this commit; instance parser awaits activation; no procedure exists |
| SPEC-DEPLOY-021 | PROPOSED | Deleting the empty stack record a CREATE change set leaves behind is an effect distinct from deleting a change set, authorized by its own out-of-band instrument (§8b) that no lane can read, and no automated lane performs it: `DeleteStack` accepts no expected-status precondition, so an observed `REVIEW_IN_PROGRESS` cannot constrain the delete that follows it, and the release concurrency lock binds only this repository's lanes. A lane that would delete a stack record refuses; the condition is reported and resolved by a separate human decision. | `spec/authority-policy.json` (`delete-review-in-progress-stack-record`) | `test/governance-model.test.js` | policy data + test reviewed in this commit; no lane may perform it |
| SPEC-LANE-005 | PROPOSED | A `bind_only` dispatch terminates after the preflight and is structurally unable to enter a stage that prepares or executes change sets, whatever the Environment holds at any moment of the run. | not yet implemented | not yet implemented | none — awaiting the workflow path |
| SPEC-LANE-006 | PROPOSED | Every dispatch carries a caller-generated correlation id matching exactly `^cba-70-[0-9a-f]{32}$`; a dispatch whose id does not match is refused in the preflight, before any credentialed stage. The run's NAME is exactly `cba-release <mode> <correlationId>` and nothing else, so a run is selected by EQUALITY on its complete name — never by substring — and is identifiable from run metadata alone, before any artifact exists. The same id appears inside the structured uploaded artifact, together with the release SHA the run acted on, which is what a reviewer compares against the request; a run's `headSha` is the dispatch ref's tip and is never that comparison. | not yet implemented | not yet implemented | none — awaiting the workflow input, run name and artifact |
| SPEC-LANE-007 | PROPOSED | Run resolution is bounded and unambiguous: the query pins workflow, `--branch main` and `--event workflow_dispatch`, matches the complete run name by EQUALITY, polls at most ten times with thirty seconds between attempts and no wait after the last, and stops on zero matches after the bound or more than one at ANY query. After the run reaches a terminal conclusion, the SAME query must re-observe exactly the same single run id immediately before the artifact is accepted — a late duplicate, a vanished run or a different id at that point stops the operation, because uniqueness observed once is not uniqueness still true when evidence is read. | `bin/resolve-run.mjs` | `test/resolve-run.test.js` | helper + simulated-`gh` tests reviewed in this commit; the run name itself awaits the workflow |
| SPEC-RUN-009 | PROPOSED | Evidence is accepted only from a run that reached a terminal conclusion, identified by the correlation id it published in run metadata, whose artifact repeats that correlation id and names the release SHA the request dispatched, and whose provenance (run id, conclusion) is verified. The run's `headSha` is never used to identify the release. | `docs/runbooks/aws-dev-release-bind.md`, `-plan.md`, `-deploy.md` | not yet implemented | none — awaiting SPEC-LANE-006 |
| SPEC-DEPLOY-018 | PROPOSED | When a sequence halts, the output names exactly which change sets executed and states that the remaining ones did not. | `infra/aws/bin/deploy-release.js` | `infra/aws/test/deploy-preflight.test.js` | code + tests reviewed, reversion proven |
| SPEC-LANE-001 | PROPOSED | In every credentialed job, synthesis completes before the pinned OIDC consumer step, and after that step only the reviewed entrypoints execute — no action step and no package-manager command. | `.github/workflows/release-pilot.yml` | `test/release-pilot-workflow.test.js` | code + tests reviewed, reversion proven |
| SPEC-LANE-002 | PROPOSED | The lane's concurrency group is the literal per-environment string with `cancel-in-progress: false`; a group derived from an input refuses. | `.github/workflows/release-pilot.yml` | `test/release-pilot-workflow.test.js` | code + tests reviewed, reversion proven |
| SPEC-LANE-003 | PROPOSED | Every job declares `timeout-minutes` equal to its reviewed bound. | `.github/workflows/release-pilot.yml` | `test/release-pilot-workflow.test.js` | code + tests reviewed, reversion proven |
| SPEC-LANE-004 | PROPOSED | The dispatch input `mode` offers only `dev_only`, so the pilot jobs' success expressions are unreachable. | `.github/workflows/release-pilot.yml` | `test/release-pilot-workflow.test.js` | code + tests reviewed, reversion proven |
| SPEC-IAM-001 | PROPOSED | Each tier's deploy role may assume only its own release bootstrap's roles; no tier's role can reach another tier's bootstrap or the foundation bootstrap. | `infra/aws/lib/security-stack.js`, `infra/aws/bootstrap/policies/` | `infra/aws/test/security-stack.test.js`, `release-bootstrap.test.js` | code + tests reviewed, reversion proven |
| SPEC-IAM-002 | PROPOSED | Where AWS generates the resource identifier, the release execution policy conditions the action on the project and environment tags — request tags on creation, resource tags on lifecycle. | `infra/aws/bootstrap/policies/cfn-exec-release.template.json` | `infra/aws/test/release-bootstrap.test.js` | code + tests reviewed, reversion proven |
| SPEC-IAM-003 | PROPOSED | Removing or replacing the `Project` or `Environment` tag is explicitly denied on every tag-scoped family. | `infra/aws/bootstrap/policies/cfn-exec-release.template.json` | `infra/aws/test/release-bootstrap.test.js` | code + tests reviewed, reversion proven |
| SPEC-IAM-004 | PROPOSED | Every `Resource: "*"` in the release execution policy is its own named statement whose action set is pinned, and no wildcard action appears outside an explicit Deny. | `infra/aws/bootstrap/policies/cfn-exec-release.template.json` | `infra/aws/test/release-bootstrap.test.js` | code + tests reviewed, reversion proven |

## 8. Four authorizations, all Zamp's, never interchangeable

Design rounds 2–3 found the conflation; round 6 added the fourth (§8b). All of them are POLICY
DATA in
[`spec/authority-policy.json`](authority-policy.json), validated by the closed-schema validator —
not prose that a document could reinterpret:

| Instrument | Authorizes (policy effects) | Performed by |
| --- | --- | --- |
| **publication** (`execution-gate`, `CBA_EXECUTION_GATE`) | `push-reviewed-commit-to-task-branch`, `create-or-reuse-one-pull-request` | Opus |
| **cloud** (`cloud-authorization`, `CBA_CLOUD_GATE`) | `deploy`, `prepare-change-sets`, `execute-change-sets`, `abandon-change-sets` | Zamp |
| **spend** (`spend-authorization`, out-of-band record) | `invoke-paid-model-audit` | Zamp |
| **stack-record cleanup** (`stack-record-authorization`, out-of-band record) | `delete-review-in-progress-stack-record` | Zamp, by hand (§8b) |

**One instrument, one mode, one set of effects.** Round 5 of this design's review found that a
single document listing four effects proved nothing about what any particular value permits: a
`plan_only` authorization and a `deploy` authorization were indistinguishable in policy. The
policy therefore carries a `modes` map, validated as a PARTITION — every mode's effects are
authorized effects, every authorized effect belongs to **exactly one** mode, and no mode outside
the closed vocabulary exists:

| Mode | Authorizes exactly | Cannot |
| --- | --- | --- |
| `plan_only` | `prepare-change-sets` | execute anything, delete anything |
| `deploy` | `deploy`, `execute-change-sets` | prepare a new plan, delete anything |
| `abandon` | `abandon-change-sets` | prepare or execute anything |

The instrument's `boundTo` is correspondingly complete —
`mode+decisionId+manifestDigest+stacks+planDigest+window` — so an authorization names WHICH
effect, under WHICH decision, over WHICH manifest and stacks, against WHICH reviewed plan, and
for HOW LONG. A value missing any of those binds nothing.

**One effect is deliberately unautomatable, under an instrument no lane can read.**
`delete-review-in-progress-stack-record` — removing the empty stack record a CREATE change set
leaves behind — is a separate effect from deleting a change set, authorized by its own out-of-band
instrument (§8b), and the policy marks it
`human-performed only; no automated lane may perform it`. The reason is stated in §7b under
SPEC-DEPLOY-021: `DeleteStack` accepts no expected-status precondition, and the release
concurrency lock constrains only this repository's lanes, not an external CloudFormation actor.
A lane that reads `REVIEW_IN_PROGRESS` and then deletes is racing; naming the effect without
automating it is the honest resolution.

- **Preparing change sets is cloud mutation.** `plan_only` creates CloudFormation resources and
  publishes assets, so it is its own named effect under the cloud instrument — not a side
  effect of planning and never covered by the publication gate.
- **The performer is policy, not convention.** `perform-cloud-effect` and
  `author-cloud-authorization` are capabilities Zamp holds and Opus and Codex are explicitly
  denied. A runbook step that would have Opus set an Environment variable or dispatch a
  mutating run contradicts the policy, and SPEC-RUN-005 requires every command to name its
  performer so the contradiction is visible rather than implied.
- **The paid model call is Zamp's too.** Gemini is the model being invoked, not an actor that
  spends: `invoke-paid-service` remains in Opus's and Codex's `mayNever`.

No instrument substitutes another, none is issued by anyone but Zamp, and a runbook mentioning
any of them grants nothing (SPEC-RUN-001).

### 8a. The cloud authorization value, key by key (SPEC-DEPLOY-019)

Round 6 found -019 claiming a "closed key set" without saying what it closes over, and requiring
no `planDigest` even though the instrument's `boundTo` names one. Round 7 found the remainder: a
key list is not a schema while `decisionId` points at a "documented shape" that exists nowhere and
two digests have no format at all. The types below are not invented — they are what the reviewed
runtime already enforces (`infra/aws/bin/deploy-release.js`), which is what a successor must
inherit rather than loosen.

The value is a JSON object with EXACTLY these ten keys — none absent, none unknown, compared as a
sorted key set:

| Key | Type and exact form | Cardinality / nullability | `plan_only` | `deploy` | `abandon` |
| --- | --- | --- | --- | --- | --- |
| `issue` | number, the integer `70` | required, never null | `70` | `70` | `70` |
| `mode` | string, one of `plan_only`, `deploy`, `abandon` | required, never null | `plan_only` | `deploy` | `abandon` |
| `decisionId` | string matching `/^[A-Za-z0-9._-]{8,64}$/` | required, never null | fresh | fresh | fresh |
| `releaseSha` | string matching `/^[0-9a-f]{40}$/`, equal to the manifest's | required, never null | required | equal to the plan decision's | equal to the plan decision's |
| `environment` | string, the tier id (`dev`), equal to the manifest's | required, never null | required | equal | equal |
| `manifestDigest` | string matching `/^[0-9a-f]{64}$/` — a `bundle` digest per §6b over the manifest the binding run produced | required, never null | required | equal to the plan decision's | equal to the plan decision's |
| `stacks` | array of strings, length ≥ 1, equal in content AND order to one reviewed plan group (SPEC-DEPLOY-011) | required, never null, never empty | required | equal to the plan decision's | equal to the plan decision's |
| `planDigest` | `null`, or a string matching `/^[0-9a-f]{64}$/` (SPEC-DEPLOY-016) | see per-mode | **exactly `null`** — no plan exists yet, and a non-null value authorizes a plan nobody reviewed | **string, non-null** — the plan being executed | **string, non-null** — the DECLINED plan whose change sets are deleted |
| `approvedAt` | string, strict RFC3339 UTC to whole seconds, calendar round-trip (SPEC-DEPLOY-009) | required, never null | required | required | required |
| `expiresAt` | same form; `approvedAt < expiresAt` and `expiresAt − approvedAt` ≤ 1h, re-checked before EACH effect (SPEC-DEPLOY-010/017) | required, never null | required | required | required |

Anything else refuses: an absent key, an unknown key, a value of the wrong type, a string that
fails its regex, an empty `stacks`, a `stacks` outside the reviewed groups, or a `planDigest`
whose nullability contradicts the mode.

Per-mode effects are not restated here as prose: they are the partition in the policy file, and a
value whose mode does not cover the effect being attempted refuses. There is **no cleanup mode**.
Removing a stack record is authorized by a different instrument entirely (§8b), which is why the
mode enum stops at three.

### 8b. The stack-record cleanup instrument

Round 6 found `delete-review-in-progress-stack-record` naming the cloud instrument while that
instrument neither authorized it nor gave it a mode — an effect that read as authorized and could
be authorized by no value. Folding it into `CBA_CLOUD_GATE` would have been worse: that variable
is read by a LANE, and the one property this effect must keep is that no automation can consume a
value permitting it.

It therefore has its own closed instrument, `stack-record-authorization`: written by Zamp, per
stack record, AFTER observing that record's status; supplied the way the spend instrument is — an
**out-of-band record with nothing to read it**. It authorizes exactly one effect, performed by a
human (SPEC-DEPLOY-021).

**Round 7: recording an observation is not constraining one.** The earlier binding named
`observedAt` and stopped there — a field that says WHEN someone looked, while nothing bounded how
old that look may be, which stack it identified, or what had to be true at the moment of the
delete. The value is a JSON object with EXACTLY these nine keys (SPEC-DEPLOY-022):

| Key | Type and exact form | Why it is in the binding |
| --- | --- | --- |
| `issue` | number, the integer `70` | the decision belongs to a tracked piece of work |
| `decisionId` | string matching `/^[A-Za-z0-9._-]{8,64}$/` | one decision, never reused |
| `environment` | string, the tier id (`dev`) | a value for one tier can never resolve in another |
| `account` | string matching `/^[0-9]{12}$/` | the account is named, not inferred from ambient credentials |
| `region` | string matching `/^[a-z]{2}(-[a-z]+)+-[0-9]$/` | a stack name is unique per account AND region |
| `stackName` | string matching `/^[A-Za-z][A-Za-z0-9-]{0,127}$/` — CloudFormation's stack-name grammar — never null | what a human reads |
| `stackId` | string, the full CloudFormation stack ARN, validated POSITIONALLY: `arn:aws:cloudformation:<region>:<account>:stack/<stackName>/<uuid>` with partition literally `aws`, service literally `cloudformation`, `<region>` matching the `region` grammar above, `<account>` matching `/^[0-9]{12}$/`, `<stackName>` matching the stack-name grammar, and `<uuid>` matching `/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/`. The embedded region, account and name MUST EQUAL the value's `region`, `account` and `stackName` fields — cross-field equality is what stops a record naming one stack while its ARN addresses another | the IMMUTABLE identity: a name can be deleted and recreated, and the recreation is a different stack that the same name would happily address |
| `observedStatus` | string, exactly `REVIEW_IN_PROGRESS` — no other value is legal in this instrument | the only status under which this effect exists |
| `observedAt` | string, strict RFC3339 UTC (§8a's form). The decision is valid ONLY while `observedAt <= now < observedAt + 15 minutes`: a FUTURE `observedAt` refuses — an observation from the future is malformed, not pending — and at or past the boundary the decision is void | an observation has an age, and an old one authorizes nothing |

Before deleting, the performer RE-OBSERVES: same `stackId`, same `REVIEW_IN_PROGRESS`, still
inside the window. Anything else — different id, different status, window lapsed — and the
decision is void; a new observation means a new decision.

**A schema is enforced by a parser, not by a table.** `maxObservationAgeMinutes` in the policy is
instrument METADATA — it bounds what the instrument may promise, and the validator holds it to at
most 15; it does not validate an INSTANCE of this value, and nothing in this design does.
SPEC-DEPLOY-022's activation commit MUST therefore contain the instance parser implementing every
row above, plus its adversarial tests — absent key, unknown key, wrong type, each regex refused,
each cross-field mismatch between `stackId` and `account`/`region`/`stackName` refused, a future
`observedAt` refused, and the boundary at exactly +15 minutes refused — each proven by mutation
like every other activation (§6c). Until that commit, this schema binds review, not runtime,
which is one more reason the effect has no executable procedure.

**Round 8: a boolean is not a decision.** `riskAccepted: false` could be flipped alongside
`executableProcedure` in a single edit, and nothing in the data said what an acceptance must
contain. The policy now carries `riskAcceptance: null`, and the validator refuses any non-null
value that is not a CLOSED record with exactly these keys: `acceptedBy` (must be `zamp`, the only
actor holding `accept-risk`), `decisionId`, `finding`, `justification`, `compensatingControls`
(non-empty), `acceptedAt`, `reviewBy`, `expiresAt` (strict UTC instants, ordered
`acceptedAt < reviewBy <= expiresAt` — an acceptance with no expiry is not an acceptance), and
`boundToEffect` (an effect this instrument authorizes). `executableProcedure: true` over
`riskAcceptance: null` refuses. Past `expiresAt` the record authorizes nothing and the procedure
reverts to non-executable. The acceptance reaches the policy only through a reviewed commit of
Zamp's own decision; Opus may transcribe it, never originate it.

**And that is still not enough, which is the point.** CloudFormation offers no compare-and-delete:
between the final re-observation and `DeleteStack`, the stack can acquire resources. Every field
above narrows the window and none of them closes it. **This design therefore leaves the effect
with NO executable procedure.** No runbook here carries a command that performs it; the abandon
operation reports the condition and stops. Making it executable requires something this design
cannot supply and must not simulate: **Zamp's explicit, written acceptance of the residual TOCTOU
risk**, recorded as the closed `riskAcceptance` record described below. Until that record exists,
`riskAcceptance` is `null` in [`authority-policy.json`](authority-policy.json), the effect is
expressible and unperformable, and a runbook that acquired a command for it would be a finding
against this section (SEC-GOV-01, SEC-IAM-01).

## 9. Relationship to existing mechanisms

The reviewed-object pattern (`EXPECTED_WORKFLOW`) and the closed `CHANGE_SET_SCHEMA` are early
spec-anchors living inside test/code files. They remain valid; the registry points AT them.
Migrating their content into standalone spec files is implementation-phase work and must not
weaken them — the linter must prove the migrated spec and the in-code object agree before the
in-code copy is demoted to a mirror.

## 10. What the next phase must deliver (and this phase must not)

Only after this design passes independent review and Zamp's decision:

**The spec system itself** — `spec/registry.json` and its closed schema, the traceability linter
and the conformance checks wired into CI with exit 1 semantics, the `[SPEC-ID]` annotations, and
the protocol/authority-policy amendments that formally seat the auditor persona.

**The lane changes design rounds 3–4 specified but this phase must not build** — each is why a
runbook above is marked blocked rather than runnable:

| Prerequisite | Why | SPEC-ID |
| --- | --- | --- |
| A `bind_only` dispatch path that terminates after the preflight and cannot enter a preparing or executing stage | A pre-dispatch check on a mutable Environment variable constrains nothing; the guarantee must be the DAG | SPEC-LANE-005 |
| A `correlation_id` dispatch input of closed format, refused in the preflight when malformed, published BOTH in a canonical run NAME and inside structured uploaded artifacts | Evidence must bind to the request, not to a timestamp window; an id that exists only inside an artifact cannot identify the run you must find in order to download it; and a run selected by substring is not identified at all | SPEC-LANE-006, SPEC-LANE-007, SPEC-RUN-009 |
| A complete successor authorization schema: closed key set, `issue` pin, `decisionId`, the `plan_only`/`deploy`/`abandon` mode enum, the window, the stack group, and a digest of the complete closed manifest | Release SHA plus assembly digest leaves environment, region, account, context and stack set unauthorized; and an instrument that does not name its mode cannot distinguish a plan from an execution | SPEC-DEPLOY-019 |
| An abandon lane under the release lock that deletes CHANGE SETS only | Declined plans leave executable change sets, and cleanup cannot be raw CLI calls outside the lock without gate or window revalidation | SPEC-DEPLOY-019, SPEC-RUN-008 |
| An out-of-band `stack-record-authorization` record, never an Environment variable, plus no lane capable of deleting a stack record and an execution policy that does not grant `cloudformation:DeleteStack` to a lane | `DeleteStack` takes no expected-status precondition and the release lock binds only this repository's lanes, so an observed `REVIEW_IN_PROGRESS` cannot constrain the delete that follows it | SPEC-DEPLOY-021 |
| The cleanup-value INSTANCE parser implementing every row of §8b, with adversarial tests proven by mutation | A schema enforced only by a table binds review, not runtime; `maxObservationAgeMinutes` in the policy bounds the instrument, not an instance | SPEC-DEPLOY-022 |
| A Zamp-authored `riskAcceptance` record (closed keys, expiry) before any executable cleanup procedure | A boolean flip is not a risk decision; the record carries finding, justification, compensating controls, owner, review date and expiry | SPEC-DEPLOY-022 |

**Activation, once each tool exists.** The PROPOSED ids in §7 become ACTIVE one at a time, each
in an implementation commit whose tree already satisfies its predicates and carries its mutation
evidence (§4, §6c). None of that exists in this commit, and this document grants no authority to
build it without that review.
