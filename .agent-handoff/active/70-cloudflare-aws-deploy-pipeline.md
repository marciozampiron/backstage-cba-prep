# Active: Cloudflare/AWS deploy pipeline and post-deploy smoke gates (#70)

Roles and messages are canonical in [`../MESSAGE-PROTOCOL.md`](../MESSAGE-PROTOCOL.md); the
publication mechanism is canonical in
[`../../docs/architecture/agent-publication-runbook.md`](../../docs/architecture/agent-publication-runbook.md).
This file does not restate either.

## Status

**SLICE A DELIVERED AND MERGED.** The code cleared eight Codex review rounds, read-only, with zero
remaining findings. Opus operated the reviewed publication artifact, producing PR #104. Zamp merged
it at `da0ed88ea01957401fe81ed8caf6d35dcb568311` on 2026-08-01, with 6/6 CI checks green including
`synth`. The remote branch
`task/70-deploy-pipeline-slice-a` is preserved at the reviewed head; the local worktree, branch and
`/tmp` artifacts were cleaned up under Zamp's authorization.

Issue #70 stays OPEN — the later slices belong to it. Issues #46 and #68 close behind it.

Slice A delivered the ordering, the binding and the refusals — the #69 preflight conditions, the
release identity, the manifest and assembly digests, the `deploy-release` entrypoint and the
YAML-semantic lane invariants. **Nothing is deployed and no later slice is started.** No AWS
mutation, no Cloudflare call, no preview, no secret access and no paid call was made producing or
publishing it.

**The external prerequisites are ALL RESOLVED as of 2026-08-02**, each at the stage boundary it
guarded:

1. GitHub Environments `dev` and `pilot` — **CONFIGURED by Zamp**, read-only evidence collected via
   `/repos/:owner/:repo/environments` on 2026-08-02: both environments exist; BOTH carry a custom
   deployment-branch policy whose only entry is `main`; `pilot` additionally carries
   `required_reviewers: [marciozampiron]`. This evidence enters review with the commit that records
   it. Deploy slices and deployment gates may now be approved through the normal protocol.
   **Observed residual limitations, part of the same evidence:** `can_admins_bypass: true` on BOTH
   Environments, and `prevent_self_review: false` on the pilot's required-reviewers rule. The
   configuration satisfies every approved requirement, but it is NOT non-bypassable
   independent-human enforcement: a repository admin can bypass the protection, and the designated
   reviewer may approve a run they initiated. Same honest framing as `enforce_admins=false` on the
   publication side; hardening either is a separate Zamp settings decision, not assumed here.
2. The #67 domain decision — **DECIDED by Zamp: the pilot uses the `workers.dev` origin.** The
   exact callback/logout URLs and domain prefix become knowable, so a pilot deploy preflight can be
   satisfied once the Environment variables carry the real values at deploy time.
3. The 6 high Dependabot alerts — **REMEDIATED by upgrade in #106** (PR #107, merged `3583aeda`),
   zero risk acceptance, 0 high open. See `done/106-dependabot-high-remediation.md`.

**Slice B1 is IN IMPLEMENTATION** (assigned 2026-08-02): the dev-stage placeholder becomes the
sanctioned AWS deploy of the dev tier, exclusively through `infra/aws/bin/deploy-release.js`, with
OIDC granted only to the consuming job and pilot promotion MECHANICALLY blocked — `mode` offers
only `dev_only` until O1/O2, the deployed smokes and the live SNS/KMS proof land. No Cloudflare, no
pilot deploy, no smoke in this parcel. Two moderate root alerts remain documented in the #106
handoff for a future SDK bump, outside any GO criterion.

The Codex round-2 review of Slice B1 required, and the correction delivered: the deploy effect is a
CLOSED stack set the manifest names (v5 `target.stacks` — Api/Data/Identity/Observability, with
`--exclusively`, never `--all`; SecurityStack and AiOrchestrationStack classified excluded and a
discovery test refusing unclassified stacks); releases serialize on the literal `release-dev`
concurrency group; the deployment authority is delivered in code (SecurityStack `GithubDeployRole`,
Environment-subject trust, boundary-pinned via the extended #66 exec policy, only the three CDK
bootstrap roles assumable) under the canonical secret name `AWS_DEPLOY_ROLE_ARN`; every job carries
`timeout-minutes` (preflights 5, deploy 15); CDK child output is captured and sanitized by shape;
and the entrypoint requires Zamp's per-release cloud gate (`CBA_CLOUD_GATE`: exact release +
assembly digest + `diff_only`/`deploy` mode + expiry) and puts the `cdk diff` plan on the record
before any effect.

The Codex round-3 review moved the remaining blockers out of the authority/execution chain, and
the correction delivered: project code and credentials never share a window (synth runs
credential-free before the OIDC consumer in every job; after the consumer only the reviewed
entrypoints execute, enforced by a named invariant); the four deployable stacks execute through
their tier's OWN CDK bootstrap (round 4: qualifier PER ENVIRONMENT — `cbardev`/`cbarpil`,
reviewed constants — with its own toolkit stack, so dev authority reaches only dev) whose
versioned execution policy (`cfn-exec-release.template.json`, rendered per tier) enumerates the
templates' real resource types with tier-scoped resource names, demands the Project/Environment
TAGS wherever AWS offers no ARN to scope to (Cognito and KMS: RequestTag on create, ResourceTag
on lifecycle — "generated id" establishes no ownership), names its one residual (API Gateway
sub-resources are untaggable; recorded for Zamp's risk decision with account isolation as the
alternative), pins release-created roles to the per-tier runtime boundary, and explicitly denies
touching the GitHub/foundation roles; the cloud gate is v2
(strict RFC3339 UTC with calendar round-trip, `approvedAt` + TTL ≤ 1h, `decisionId`, and — for
deploy mode — the `planDigest` of the reviewed plan), and — after the round-4 review — the plan
IS the CloudFormation change sets: `plan_only` prepares one named change set per stack and
digests the canonical UNREDACTED describes (change-set ids, full details, principals); `deploy`
re-describes exactly those change sets, requires the digest the gate names, and executes them in
the reviewed dependency order, resolving the account FIRST and re-checking the window as the
LAST operation before EACH mutation. A recreated or drifted plan refuses as `PLAN_CHANGED`;
CloudFormation itself refuses a change set whose stack moved after preparation.

The round-5 review closed the last gaps in that chain: the gate now NAMES the reviewed plan
group it covers — first deployments run in dependency WAVES (Identity+Data → Api →
Observability, each wave planned/reviewed/executed under its own gate, because a change set
whose `Fn::ImportValue` producers are unexecuted cannot even be created; a discovery test walks
the real CDK assembly graph and refuses wave-order violations); the API Gateway ROOT lifecycle
is tag-confined (`aws:ResourceTag`) so a foreign API's root is unreachable whatever its id; the
plan describes retrieve `--include-property-values` and a change set that is not
`ExecutionStatus: AVAILABLE` never receives a reviewable digest.

The round-6 review closed the remaining seams: EVERY API Gateway child operation (routes,
integrations, authorizers, stages, deployments, cors) now demands the owning API's
Project/Environment tags (the service authorization reference lists `aws:ResourceTag` for these
resource families — children authorize against the parent's tags), the V2 tags API is shaped as
POST/DELETE/GET with ownership required, and the GOVERNANCE TAGS themselves are fenced: removal
of Project/Environment is explicitly denied and replacement with foreign values is explicitly
denied — on API Gateway, Cognito and KMS alike, so an owned resource cannot be untagged out of
its confinement. Review material now uses TYPE-AWARE structured pseudonymization
(rounds 6-7 — the round-6 claim that every resource path is public was FALSE, and the generic
first-label rule reproduced the round-5 defect for endpoints): DECISION-BEARING identities
render VERBATIM — IAM role paths, the full `workers.dev` and `amazoncognito.com` hostnames Zamp
actually reviews for origins/callbacks/CORS, project-chosen stack and alias names — while
GENERATED material renders as 128-bit pseudonyms (KMS key UUIDs, API Gateway ids, pool ids,
stack UUIDs, execute-api labels, accounts), URL query values are stripped, a hostname no
reviewed decision produced is marked `[unexpected-host#…]`, and an unknown service's resource is
pseudonymized whole — unknown is not proven public. The round-8 review tightened the same rule
against the renderer's own exceptions: there is NO `*.amazonaws.com` blanket and NO per-service
allowlist — a FORMAT either matches a reviewed project-name family (`cba-study-coach-`,
`cdk-cbardev-`, `cdk-cbarpil-`, the exact bootstrap-version parameters) or it pseudonymizes;
S3 object keys never render (whoever owns the bucket), SSM parameter paths and foreign bucket
names never render, STS keeps the principal's role path but pseudonymizes the caller-chosen
session; and URLs go through the STRUCTURED WHATWG parser — embedded credentials never render
(the whole URL becomes a `[credentialed-url#…]` marker), IPv6 literals and every unrecognized
form are markers, unparseable spans are never emitted raw, query and fragment always strip.

The round-9 review removed the renderer's last structural weakness: there is no outer text
scanner deciding what the parsers see — presentation is composed FROM SANITIZED VALUES (every
string in the canonical entries is classified token by token; the CFN Before/After context
blobs parse as JSON and are walked, failing closed to a pseudonym when unparseable); the URL
classifier admits ANY scheme (a `postgres://user:secret@…` value is a credentialed marker, not
prose), URL PATHS render only when a reviewed decision produces that exact shape (a path
segment carries secrets as easily as a query value — an approved host does not bless an
unreviewed path); and the per-service ARN grammars are ANCHORED: only the exact project-owned
identity segment renders — lambda aliases, log streams, Cognito groups, STS sessions and every
unrecognized or v1-shaped resource pseudonymize, and every known-service branch fails CLOSED to
a whole-resource pseudonym when the complete shape does not match.

Round 10 inverted the last default and completed the material: an unknown scalar is no longer
preserved because nothing recognized it as dangerous — a string renders VERBATIM only when it
matches an explicitly reviewed public form (the closed CloudFormation vocabulary, an
`AWS::Service::Type`, a number, a region, a project-owned name, or a URL/ARN through its own
grammar), and every other scalar becomes a deterministic `[value#…]` marker (equal values render
equal markers, so before/after comparison survives what must not be shown). Map KEYS are
sanitized like values; URL and ARN spans are recognized ANYWHERE in a string, including behind
punctuation and inside serialized JSON; `BeforeValue`/`AfterValue`/context blobs are parsed and
walked, which is also what keeps a decision-bearing origin readable through JSON's `\/` escapes;
and the CloudFormation ARN grammar is complete, so a suffix trailing the stack id fails closed.
The review material now carries the WHOLE sanitized `ResourceChange` as canonical JSON beside
the concise summary — `PolicyAction`, `Scope`, `PhysicalResourceId`, `ChangeSetId`, `ModuleInfo`
and any field CloudFormation adds later reach Zamp without a hand-picked field list to fall
behind, so a plan that retains and a plan that DELETES a table can never render alike.

Round 11 closed the last two gaps. The digest and the material now bind the COMPLETE
`DescribeChangeSet` response, not only `Changes`: `Capabilities` (what IAM the execution may
create), `OnStackFailure` (`DELETE` destroys the stack after a failed create),
`RollbackConfiguration`, `NotificationARNs`, `Tags`, `Parameters`, nested-stack and import flags
are each bound and NAMED in the rendering — and pagination is consumed page by page or the plan
refuses as `CHANGE_SET_PAGINATION_UNCONSUMED`, because a partial description describes an effect
nobody reviewed. And the sanitizer's last format allowances are gone: text survives only where a
KNOWN SCHEMA FIELD holds a value its own validator accepts — numeric STRINGS, free map keys,
identifier-shaped values and our own name prefix each proved nothing about content, so
`111122223333`, `supersecret` and `cba-study-coach-supersecret` are markers now; only real JSON
numbers stay numbers; `PhysicalResourceId` and parameter/tag VALUES pseudonymize whole; stack
names are validated against the names THIS release computed, never against a name shape. The two
outputs were unified into one policy: unstructured child text is never echoed at all — the
refusal records a stable exit code, per-stream byte counts and a framed digest, so credentials in
a failing prepare child can no longer reach a persistent CI log.

Round 12 replaced key-name trust with POSITION: a reviewed schema tree describes the whole
`DescribeChangeSet` response, and a field is authorized by where it sits, so parsed content can
no longer recover trust by naming itself `Key`, `Name`, `ParameterKey`, `LogicalResourceId` or
`Arn`. `BeforeValue`, `AfterValue` and the context blobs are OPAQUE — one deterministic marker
each, never parsed. That deliberately gives up reading callback URLs out of a property value, and
the control does not move: PREFLIGHT-1 validates the exact auth URLs and the manifest's
contextDigest binds them to the release BEFORE any change set exists. `DeploymentMode` and
`StackDriftStatus` are named vocabularies now (`REVERT_DRIFT` is distinguishable at sight), and a
field the schema does not describe REFUSES the plan as `CHANGE_SET_SCHEMA_UNKNOWN` — brittle on
purpose, because an unreviewed field can change what an approval means.

Round 13 closed the last two. Validation is STRUCTURAL: unknown key, wrong type AND
out-of-contract enum each refuse before a digest exists (`Changes: "not-an-array"` and
`Action: "SOMETHING_NEW"` used to pass the name-only walk and arrive as opaque text), and
`renderPlan` runs the same validator itself rather than trusting its caller. The schema was
transcribed from the CloudFormation API reference including every drift-aware member —
`SyncWithActual`, `PreviousDeploymentContext`, `ResourceDriftStatus`,
`ResourceDriftIgnoredAttributes`, `ChangeSource: NoModification`, `BeforeValueFrom`/
`AfterValueFrom`, `Target.Drift` — and `DeploymentMode`'s only documented value is `REVERT_DRIFT`
(the invented `STANDARD` is gone); a full documented response is a permanent fixture. And every
redaction is now a CONSTANT class label: the old `[value#sha256(prefix+value)]` markers were a
published derivation of the very values they hid — the review reproduced `supersecret` offline —
so nothing derived from an observed value is published at all. Where the human needs to know
whether a value moved, `renderPlan` compares the raw values IN MEMORY and prints
`changed`/`unchanged`.

Round 14 removed the validator's own generic escapes: an explicit `null` is a STATE, accepted
only where the contract documents it (`HookInvocationCount`), never read as absence; `OPAQUE`
positions are opaque STRINGS (an object smuggled where the contract says string is a malformed
response, not deeper content); integers carry their documented integrality and bounds
(`MonitoringTimeInMinutes` 0–180, `HookInvocationCount` 1–100); every RAW page is validated
BEFORE the pagination merge, so `Changes: null` can no longer be normalized into an empty list
and digested as if the service had sent it; and the ARN-typed fields (`ChangeSetId`, `StackId`,
lineage, `NotificationARNs`, trigger and nested-change-set ARNs) demand a strict ARN parse —
`ENTITY_REFERENCE`, with its documented latitude for parameter and logical names, survives only
at `CausingEntity`.

Round 15 finished both edges: every page is validated IMMEDIATELY after `JSON.parse` — before it
is stored, before its `Changes` are spread, before its token is read — so `Changes: {}` (or a
number, or a boolean) produces the structured `CHANGE_SET_SCHEMA_UNKNOWN` refusal instead of an
uncaught TypeError that killed the lane outside the fail-closed contract; and the ARN contracts
are POSITIONAL — a change-set ARN (`cloudformation`, `changeSet/<name>/<uuid>`), a stack ARN, an
SNS topic ARN and a CloudWatch alarm ARN are distinct types with mandatory non-empty components,
so `arn:::::x` and an IAM-role ARN sitting where a topic belongs each refuse before any digest. The expected origin and an attacker origin
read in clear, visibly different; stated limit: a 12-digit account space is enumerable offline
against any unkeyed derivation — the pseudonym prevents log disclosure, same posture as
`mask-aws-account-id`. And the fresh-tier wave guard walks the synthesized TEMPLATES for
literal `Fn::ImportValue` (recursively, with a positive control the CDK metadata never sees),
resolving each export to its producer, which must sit in an earlier wave — or in the
SecurityStack foundation, which pre-exists every wave.

### Spec-Anchored Design — decision recorded, design under independent review (2026-08-07)

The Codex confirmation of round 15 closed the technical findings; publication stays blocked
because the contract the sixteen rounds hardened still lives only inside code and tests. Zamp
directed the adoption of **Spec-Anchored Development**: the spec is the authority, code conforms
to it, and a future mechanical conformance auditor in CI fails the build (exit 1) on any
divergence — the spec is never updated automatically to accommodate code. The semantic layer is
the **Gemini Spec Auditor** persona, which reads and reports only: it holds no authority of any
kind, never approves anything, never accepts risk, never touches code or spec, and never runs
any effect. Its report is one more input to the unchanged flow — Codex reviews independently,
and the decision belongs to Zamp alone through `HUMAN_GATE_GRANTED`, exactly as the protocol
states today. The persona takes effect only after the protocol and the authority policy are
amended through their own reviewed commits; nothing is seated by this design.

This phase delivered DESIGN DOCUMENTS ONLY, in one fix-forward commit on top of
`346fe2dcd79654f3e4c3a145899b2e52a34034a9`, with the release entrypoint, the lane and the
infrastructure untouched:

- `spec/spec-anchored-development.md` — principles, spec authority and evolution rule,
  SPEC-ID → code → test traceability, divergence semantics, and a seed registry binding
  fourteen SPEC-IDs to invariants that already survived the #70 rounds;
- `spec/agents/gemini-spec-auditor.md` — the persona: inputs, procedure, the SPEC_AUDIT_REPORT
  document format with PASS/FINDINGS and evidence, and its closed list of non-powers;
- `docs/runbooks/README.md` — the mandatory runbook standard (closed frontmatter, required
  sections, the rule that a runbook confers nothing);
- `docs/runbooks/spec-conformance-audit.md` — the audit flow: mechanical first, semantic
  interpretation second, independent review third, human decision last; every command marked
  `PLANNED — not executable`;
- `docs/runbooks/aws-dev-release.md` — the planned #70 dev release flow only (waves, plan_only,
  digest study, the second dispatch, evidence, stop conditions, rollback), with nothing to be
  run in this phase.

The next phase — JSON Schema tooling, the conformance checker, `[SPEC-ID]` annotations and the
protocol amendments — starts only after this design passes the independent review and Zamp's
decision.

Design round 2 (Codex, six findings) reshaped the contract before any tooling exists, which is
what a design review is for. The lifecycle now has three states — PROPOSED, ACTIVE, RETIRED —
with CI enforcing ACTIVE ids only, activation atomic with conformance in the same tree, ACTIVE
text immutable, and successors retiring predecessors by name: the "spec first" rule and the
fail-closed CI no longer deadlock. The mechanical layer was renamed to what it honestly proves —
a traceability LINTER plus registry-driven CONFORMANCE CHECKS with executable predicates — and
the unprovable residue is named and assigned to the semantic stage. The spec system now governs
itself: nine SPEC-GOV/AUDIT/RUN ids (PROPOSED — their tooling does not exist yet), the compound
seed ids split into atomic ones (SPEC-DEPLOY-001…014), and the eight new documents were added to
the fail-closed discovery and the closed surface policy, so their sentences are scanned like
every other canonical surface. Publication authorization and cloud authorization are now two
named instruments, both Zamp's, never interchangeable — and preparing change sets is classified
as cloud mutation. The audit became reproducibly bound (report v1: commit, base, diff, spec,
bundle and persona digests; pinned model and ceilings; INCOMPLETE is never a weaker PASS) and
honestly priced: the semantic stage is a paid call and each run needs Zamp's separate spend
authorization. The release flow was split to obey its own standard — an index plus three
one-operation runbooks (plan, deploy, recovery) with copyable planned templates — and the audit
runbook moved its recording into a separately owned reconciliation step so "read-only" stays
true. Everything remains design: `PLANNED — not executable` throughout, the lane untouched, the
entrypoint untouched.

Design round 3 (Codex, eight findings) closed the last gaps that would have made the flow
unrunnable or the policy decorative. The plan authorization could not be authored at all — it
must name an assembly digest that only a run produces — so a read-only BINDING operation now
precedes it. Evidence stopped being a `grep` window: every cloud effect produces a complete
artifact bound to run id, decision, release SHA, stack group and plan digest, with the run id
resolved deterministically and exactly one match required. A declined plan no longer "expires":
AWS retains change sets until deleted, so an authorized ABANDON operation deletes them by id,
resolves any `REVIEW_IN_PROGRESS` stack record and states what bootstrap material is retained.
Performers are named on every command, and the three authorization kinds — publication, cloud,
spend — are now POLICY DATA validated by the closed-schema validator, with `prepare-change-sets`
and `invoke-paid-model-audit` as first-class effects and Opus explicitly denied both
`author-cloud-authorization` and `perform-cloud-effect`. The registry became atomic (thirty-one
ids, exact normative text instead of summaries) and the redaction contradiction was scoped: the
child-evidence digest is the named exception to the no-derivation rule, because it covers whole
streams that are never published rather than a value in the rendering. Audit digests gained a
reviewed base with an ancestor check and the framed canonical serialization the #70 collision
lesson demands; ACTIVE immutability is checked against activation history rather than a
self-declared hash; mutation evidence became a closed record. The recovery assessment is
read-only again — `gateRequired:false`, `cloudMutation:false` — with identity, account, region
and pager pinned on every AWS call. And the governed vocabulary now collects cloud, spend,
approver and persona claims, so the previously empty allowlists hold explicitly permitted
sentences instead of nothing.

Design round 4 (Codex, seven findings) corrected what the previous round had claimed too
confidently. The registry's release ids are **PROPOSED again**: ACTIVE means CI enforces an id,
the linter and conformance checks do not exist, and a design-only commit cannot be an activation
commit — the evidence that today's tree conforms is recorded in its own column instead of being
dressed as enforcement. The cloud instrument now binds a digest of the COMPLETE closed manifest
rather than a release SHA plus an assembly digest, and `abandon-change-sets` joined the closed
effect matrix; both arrived as policy data with successors registered PROPOSED, which is the
lifecycle exercising itself for the first time. The binding and evidence operations were found
unrunnable and unsafe as written — the manifest never reaches the log, a pre-dispatch check
cannot constrain a variable another actor changes mid-run, and a timestamp window does not prove
which request produced a run — so the runbooks now declare themselves BLOCKED on four
implementation-phase prerequisites (a `bind_only` path that cannot enter a preparing stage, a
correlation-id input, structured uploaded artifacts, and the abandon lane with its authorization
mode), each registered as a SPEC id and tabulated in the spec's §10. The abandon operation was
rewritten around a reviewed lane under the release lock with mutation-boundary revalidation, and
its residual race is stated rather than papered over: CloudFormation offers no atomic
compare-and-delete, so the entrypoint refuses on surprise instead of retrying. Digest framing
became typed — status, paths, modes, object types, sizes and hashes — because a content record
cannot tell a deletion from an absence or a mode change from none. And the runbooks stopped
violating their own standard: versions bumped, the false "a later plan replaces them by name"
claim removed from deploy, and the spend rule attributed to the id that actually carries it.

Design round 5 (Codex, six findings) removed the last places where a document promised more
control than the mechanism provides. **Two operations were found unsafe as specified.** Run
correlation could not work: with `--ref main`, a run's `headSha` is main's tip, so comparing it
to the release SHA rejects every release older than the tip, and a correlation id living only
inside an artifact cannot identify the run you must find in order to download that artifact. The
id is now published in the run's own NAME — run metadata, readable before any download — and the
release SHA is verified separately, from the artifact, never from `headSha`. And the abandon
operation no longer deletes stack records at all: `DeleteStack` accepts no expected-status
precondition and the release lock binds only this repository's lanes, so "delete only what was
re-observed in the expected state" was the race restated as care. A leftover
`REVIEW_IN_PROGRESS` record is REPORTED; resolving it is a distinct effect
(`delete-review-in-progress-stack-record`) that policy marks human-performed and no lane may
perform.

**The cloud instrument now binds its mode, as data.** One document holding four effects could not
distinguish a plan from an execution, so `spec/authority-policy.json` carries a `modes` map
validated as a PARTITION — `plan_only` prepares only, `deploy` executes only, `abandon` deletes
prepared change sets only — and `boundTo` became
`mode+decisionId+manifestDigest+stacks+planDigest+window`. The reversion proof for this control
came back GREEN on the first attempt, because the validator carried a literal identical to the
data: the partition law could be deleted with the suite still passing. The two layers are now
separate and each is provable — the library enforces the LAW, the governance test pins the
reviewed VALUE — and all ten reversions are red.

SPEC-DEPLOY-019 became a COMPLETE successor (closed key set, `issue` pin, `decisionId`, the
three-mode enum, window, stack group and the complete-manifest digest) rather than a partial one
that would have silently dropped -002's obligations on activation; -002 stays registered until
that activation retires it, and SPEC-DEPLOY-020 was absorbed and RETIRED under a new §4 rule for
retiring a PROPOSED id that was never enforced. Digest framing split into three KINDS — `text`,
`snapshot`, `diff`, with `digestKind` inside the digested bytes — because one shape was being
applied to a string, a snapshot and a range alike; `renamed` left the diff enum because rename
detection is a similarity heuristic and a digest that depends on a threshold is not reproducible
by an independent verifier. SPEC-DEPLOY-021 records the unautomatable effect. Terminology was
reconciled: the plan operation downloads one named artifact (not a "run log"), and evidence
records change-set NAMES, because a change-set id is an ARN and evidence carries no live ARNs.

Design round 6 (Codex, four findings) closed the gap between what the policy said and what it
could express. **The stack-record cleanup effect had no authorization anyone could issue**: it
named the cloud instrument, which neither listed it nor gave it a mode, so it read as authorized
and no value could authorize it. Three things had to be true at once for that to survive — the
forward check only walked documents' effect lists, so an effect in no list was never visited; the
reverse direction was unchecked; and the pinned literals agreed with the defect. The relation is
now ONE law taking both matrices as arguments, applied to the loaded policy inside `validate` and
to this file's own literals at import, so a self-contradicting pin cannot load. Because correct
pins mean no data mutation can reach it first, the law is proven by calling it directly with a
deliberately dangling pair — the same call the module makes on itself. The effect got its own
instrument, `stack-record-authorization`: out-of-band like the spend one, never an Environment
variable, because the hazard being managed is acting on a stale observation.

Run selection became identification rather than a guess: the correlation id has a closed format
(`^cba-70-[0-9a-f]{32}$`, refused in the preflight when malformed), the run NAME is exactly
`cba-release <mode> <correlationId>`, and the runbooks match the COMPLETE name by equality —
`contains()` over a title is not identification — with the query pinned to workflow, branch and
dispatch event, bounded at ten attempts. Zero matches after the bound is a stop; two or more is a
stop in every case (SPEC-LANE-007).

SPEC-DEPLOY-019 now enumerates its schema instead of claiming one: §8a lists all ten keys with
per-key and per-mode constraints, including the `planDigest` the instrument's own binding
required — `null` under `plan_only`, non-null under `deploy` and `abandon`. And the digest
taxonomy gained a fourth kind: `snapshot` is defined by a commit, which a linter report or a
prompt-as-invoked does not have, so generated streams are `bundle`, bound to their producer;
`snapshot` binds its commit and `diff` binds `baseSha`/`headSha` inside the digested bytes; and
every digest the auditor persona names — `PERSONA_SHA256` included, which previously had no kind
at all — is mapped to exactly one.

Design round 7 (Codex, five findings) drew the line between an expressible decision and a
performable one. **The cleanup instrument recorded a stale observation without constraining it**:
`observedAt` said when someone looked while nothing bounded the age of that look, which stack it
identified, or what had to be true at the moment of the delete. Its value is now a closed
nine-key decision (spec §8b, SPEC-DEPLOY-022) naming environment, account, region, stack NAME and
the immutable stack ARN — a name can be deleted and recreated, and the recreation is a different
stack the same name addresses — plus the exact status `REVIEW_IN_PROGRESS` and the instant, valid
fifteen minutes, re-verified immediately before acting.

**And that is still not enough, which is the finding's real content.** `DeleteStack` has no
compare-and-delete; every field narrows the window and none closes it. The design therefore
leaves the effect with **no executable procedure**: no runbook carries the command, and the
validator refuses the one combination that would paper over it — an executable procedure over an
unaccepted residual. Making it performable is **Zamp's risk-acceptance decision**, on its own
record; Opus cannot take it and this design does not simulate it. (Round 8 replaced the boolean
this paragraph originally named with the closed `riskAcceptance` record.)

The bounded run resolution became a command instead of a description: the standard now carries the
canonical procedure — `openssl rand -hex 16` for the correlation id (a regex alone admitted
`cba-70-000…000`), the title passed through the environment so it is never interpolated into the
jq program, exactly ten attempts thirty seconds apart, cardinality 1 required, two-or-more an
immediate stop — and the four runbooks invoke it with their mode rather than restating a loop
none of them implemented. SPEC-DEPLOY-019 gained types, regexes, cardinality and nullability for
all ten keys, inherited from what the reviewed runtime already enforces. The generated release
manifest is a `bundle`, not a `snapshot` — it is produced by the binding run and exists at no
commit — and `patchSha256` states its kind (`diff`). The governed vocabulary now collects
sentences about the cleanup instrument and about risk acceptance, closing the same "governed in
name only" gap round 3 found.

Design round 8 (Codex, three findings) turned the three remaining descriptions into contracts.
**Risk acceptance became a record, not a boolean**: `riskAccepted: false` could be flipped
together with `executableProcedure` in one edit, and nothing in the data said what an acceptance
must contain. The policy now carries `riskAcceptance: null`, and the validator refuses any
non-null value that is not a closed record — `acceptedBy` (must be `zamp`, the only holder of
`accept-risk`), `decisionId`, `finding`, `justification`, `compensatingControls`, `acceptedAt`,
`reviewBy`, `expiresAt` (strict UTC, ordered; an acceptance with no expiry is not an acceptance)
and `boundToEffect` (an effect the instrument authorizes). An executor-signed acceptance is
refused by name. A complete well-formed record still cannot slip in silently: the pinned literal
is `null`, so accepting is a reviewed policy change of Zamp's own decision.

**The cleanup value became a real schema** (SPEC-DEPLOY-022): `stackName` carries CloudFormation's
name grammar; `stackId` is validated positionally (`arn:aws:cloudformation:<region>:<account>:
stack/<name>/<uuid>`) and its embedded region, account and name must EQUAL the record's fields —
cross-field equality is what stops a record naming one stack while its ARN addresses another; and
the window is stated as `observedAt <= now < observedAt + 15 minutes`, a future instant refusing.
The spec also states that a table is not an enforcer: the activation commit must contain the
instance parser plus adversarial tests, mutation-proven; until then the schema binds review.

**Run resolution became an executable** — `bin/resolve-run.mjs`, driven in `test/resolve-run.test.js`
by a simulated `gh`. Round 8 caught what two rounds of prose review missed: the pasted loop
stopped watching for duplicates the moment it found one run, so a duplicate appearing DURING
`gh run watch` was never seen. The helper re-runs the same query after the terminal conclusion and
requires exactly the same single id immediately before printing anything; late duplication, a
vanished run, an identity change, `gh` failure, unparseable output, substring titles and the
no-sleep-after-last-attempt bound are each proven by a scripted sequence. The runbooks now invoke
the helper; the loop nobody could test is gone.

Design round 9 (Codex, three findings) made the acceptance enforceable and the helper honest
about its own bounds. **The risk-acceptance record gained the bindings that make it a decision
about THIS risk**: `residualRiskSha256` digests the instrument's exact residual text and the
validator recomputes it, so editing the finding detaches every prior acceptance structurally;
`coversStackId` and `coversCleanupDecisionId` scope the acceptance to one stack record under one
cleanup decision — never a class-wide waiver; and `zampStatementSha256` digests Zamp's verbatim
written statement, because `acceptedBy: "zamp"` typed by an executor proves nothing — the
statement is the decision channel, the policy entry its reviewed transcript. The validator now
also evaluates the CLOCK: a tree holding an expired acceptance, or one dated in the future, fails
closed; and the runtime consumer (the SPEC-DEPLOY-022 activation parser) must re-check expiry and
coverage immediately before the effect — the validator proves the tree, the consumer proves the
moment.

**The helper stopped trusting its caller and its window.** The workflow is pinned by FILE
identity inside `bin/resolve-run.mjs` (`release-pilot.yml`); the workflow argument is gone, and a
test passes an attacker-named workflow to prove the query stays pinned. The window became
exhaustive-or-stop: the query asks for 1000 rows and a full page refuses as truncated — round 9
demonstrated a duplicate at row 51 was invisible under `--limit 50` — and a scripted test plants
the duplicate beyond row 60. Every external call now carries a reviewed wall-clock deadline (60s
per query, 45 minutes for the watch — the lane's jobs sum to 35), surfacing as named timeout
stops, because ten attempts bound nothing when one call can stall forever.

Design round 10 (Codex, two findings) held the new machinery to the project's own laws. **The
acceptance's digests now obey §6b**: `residualRiskSha256` is the `text`-framed digest — kind,
version and subject inside the digested bytes, recomputed by the validator, with adversarials for
the raw-text digest (the round-9 shape itself), a kind swap, a foreign subject and a stray
newline; the statement pointer became a closed object (`source: zamp-verbatim-message`, `sentAt`,
`encoding: utf-8`, `bytes`, §6b bundle `sha256`) because a bare 64-hex fixed neither where the
statement lives nor which bytes it digests. And the live stack ARN LEFT the tracked policy:
`coversStackId` was itself a violation of the no-ARN rule, so the stack is now bound by
`coversCleanupAuthorizationSha256` — the §6b bundle digest of the out-of-band cleanup value that
contains `stackId` and `decisionId` — and a new governance scan asserts no governance surface
carries a CloudFormation stack ARN, with its probes assembled at runtime so the test file passes
its own scan.

**The helper and the runbooks now name their repository.** `CANONICAL_REPO
(marciozampiron/backstage-cba-prep)` is pinned in `bin/resolve-run.mjs` and passed as `--repo` on
every `gh` call — without it, `gh` resolves the ambient clone, and a fork carrying the same
workflow file and title would satisfy every other rule while handing back a foreign artifact id.
The runbooks dispatch by workflow FILE with the same `--repo`, and every `gh run download`
carries it too. A test passes `repo: 'attacker/fork'` and proves the queries stay pinned.

Design round 11 (Codex, two findings) removed the last discretion from the evidence. **The two
bundle digests got ONE canonical serialization**: `framedBundleDigest` in the policy library is
the single shared implementation, and the two envelopes are pinned functions —
`zampStatementDigest` (producer `zamp`, record name = the locator's path, `text/markdown`) and
`cleanupAuthorizationDigest` (the nine keys in the exported `CLEANUP_VALUE_KEY_ORDER`,
`application/json`; a permuted input digests identically, a changed key differently). Two
reviewers can no longer frame the same bytes two "compatible" ways. The statement gained an
immutable LOCATOR — the decision file under `.agent-handoff/decisions/` plus the commit that
introduced it — because a source class and a timestamp find nothing univocally. The positive
fixtures are now REAL: actual statement bytes and an actual nine-key value digested through the
shared functions, with adversarials over producer, record name, media type, newline, a foreign
path, and single-key changes to the authorization.

**The first mutation now names its repository.** Round 10 pinned reads and dispatch; the `gh api
PATCH` that installs `CBA_CLOUD_GATE` still said `repos/<owner>/<repo>`, and a hasty fill-in
mutates a foreign Environment before the canonical dispatch would fail. The three mutating
runbooks carry the literal canonical path, and a governance scan walks every fenced `gh` command
in every runbook: no `<owner>/<repo>` placeholder anywhere, every `gh api … repos/…` on the
canonical repository, every dispatch and download carrying `--repo` — with positive controls and
the pin imported from the helper, so there is exactly one place the repository's identity lives.

Design round 12 (Codex, three findings) closed the daylight between looking right and being
right. **The statement digest now binds the complete locator**: the record name is
`<path>@<introducedIn>`, so the same path at a different introducing commit — the exact pair the
round-11 envelope could not tell apart — is a different digest; and a SHA that merely looks like
a SHA proves nothing, so `verifyStatementLocator` runs the four history checks (commit exists,
ancestor of the reviewed HEAD, ADDED that file, blob bytes match the recorded length and digest)
with `git` injected — proven against a scripted history covering every named refusal, including
same-length-different-bytes content and a foreign introducing commit.

**The cleanup digest refuses what it is not given.** An extra key was silently dropped and a
missing key silently serialized away — a digest of a projection, not of the value presented. Both
of Codex's reproductions are now inverted into refusals, along with present-but-undefined values,
wrong types and non-objects; the full per-key grammar parser remains SPEC-DEPLOY-022's activation
obligation, stated as shape-now/content-at-activation.

**The gh scanner became a closed structural allowlist over reconstructed commands.** Continuation
lines are joined, and every fenced `gh` command must satisfy exactly one sanctioned form — the
literal gate PATCH endpoint (a `"$ENDPOINT"` indirection is an offense because the endpoint token
itself is inspected), the file-named dispatch with EXACTLY ONE canonical `--repo` (a second
`--repo` on the same or the next physical line is an offense), the download with the same rule —
and any other gh subcommand is an offense by default. The three demonstrated bypasses are pinned
as adversarial tests, and the canonical forms are asserted to pass, so the allowlist is exact
rather than merely strict.

Design round 13 (Codex, two findings) replaced analysis with identity. **The gh allowlist became
exact anchored templates**: flag-level analysis was fail-open four ways — commands not STARTING
with gh were ignored (`env X=1 gh …`, `true; gh …`), tokenization slid past shell operators
(`… && gh secret set`), only the `--repo VALUE` spelling was recognized (`--repo=fork` passed),
and any method under the canonical prefix was accepted (`-X DELETE repos/<canon>/actions/
secrets/…`). A finite command set needs no analysis: any gh-BEARING command — wherever the word
sits in the line — either matches one of the three reviewed templates character for character, or
it is an offense. All five demonstrated bypasses plus round 12's three are pinned as regressions,
and the canonical forms are asserted to pass.

**The reviewed head obeys the identity rule.** `verifyStatementLocator` refused to take `HEAD` or
a branch name at face value: the anchor of the proof is now a full lowercase 40-character SHA,
confirmed to EXIST, before any ancestry test — a statement introduced after the actually reviewed
commit would become "an ancestor of HEAD" the moment anything advances. Eight moving-target
shapes refuse as `REVIEWED_HEAD_NOT_A_FULL_SHA`, a well-formed SHA naming no commit refuses as
`REVIEWED_HEAD_MISSING`, and the scripted history now tells the two cat-file probes apart.

Design round 14 (Codex, one finding) ended the arms race by removing the contest. Rounds 11-13
tried to ANALYZE commands — flags, then anchored templates keyed on the word `gh` — and each
round the analysis proved fail-open: the executable can be spelled without the sequence
(`g'h'`, `g\h`, `$(printf '\147\150')`, `${G}${H}`), and template alternations accepted
cartesian combinations no runbook contains (a download whose artifact and directory name
different operations; a plan gate carrying the deploy value's wording). **Identity needs no
analysis**: the governance test now holds a reviewed inventory of EVERY reconstructed fenced
command line of EVERY runbook — gh or not — and requires equality, in order; a runbook absent
from the inventory is itself a deviation, and a stale inventory entry whose file is gone fails
too. Changing any fenced command anywhere is a red build until the same reviewed commit updates
the inventory. The regression suite mutates the REAL runbook texts: the four obfuscated
spellings, the three cartesian swaps, a silent command removal, and all eight prior bypasses,
each proven to deviate; a meta-check keeps the inventory itself canonical (one repository in
every dispatch/download/API path, no administrative subcommand ever inventoried).

Implementation round I4-2 (Codex: 1 MEDIUM, 1 LOW) closed the refusal's last mile and precised a
guarantee. **Refusals route by EXCLUSION**: the refusal uploader's `mode == ''` condition let an
abandon-mode refusal materialize evidence.json and publish nothing — the condition is now
`mode != 'plan_only' && mode != 'deploy'`, and a truth-table regression proves EXACTLY ONE
uploader matches every mode the record can carry (plan_only, deploy, abandon, empty), plus an
executed materializer run proving an abandon REFUSED record lands as evidence.json byte for
byte. **The wording now matches the order of operations**: the abandon refusal happens after full
validation and before any CHANGE-SET API call or mutation — the STS identity reads that precede
the gate check are verification, not effect — stated identically in code comment, test, spec
evidence column and here.

Implementation Slice I4 delivered the successor gate schema — SPEC-DEPLOY-019 is now the code.
`CLOUD_GATE_KEYS` carries the ten §8a keys: `manifestDigest` replaced `assemblyDigest`, binding
the COMPLETE closed manifest through one §6b bundle digest RECOMPUTED at the gate from the
verified manifest (never trusted from the caller); the envelope is pinned once in
`manifestBundleDigest` (producer `cba-release-binding`, record `binding-manifest`,
application/json, canonical deep-key-sorted serialization) — a CommonJS twin of the governance
framing, with `test/digest-agreement.test.js` proving the ESM/CJS implementations digest
identically over shared fixtures, multibyte included, so a fork between them is a red build. The
mode enum carries all three modes: an abandon-mode gate is schema-valid (planDigest non-null per
§8a — it names the DECLINED plan) but refuses as ABANDON_NOT_IMPLEMENTED after full validation
and provably before any AWS call, until the abandon lane lands. A gate written to the retired
-002 shape (assemblyDigest) is now an UNKNOWN key — malformed, not half-working. dev-preflight
computes `manifest_digest` as a job output and the binding artifact embeds it, refusing to exist
without a well-formed digest (the binding is the digest's birthplace — SPEC-RUN-006 made whole).
Lifecycle: SPEC-DEPLOY-002 was RETIRED by before-activation absorption (§4) — the tree now
implements the complete successor, and an id describing code that no longer exists cannot stay
PROPOSED honestly; -019 holds real anchors; 54 PROPOSED / 2 RETIRED under spec:lint's history
laws.

Implementation round I3-4 (Codex, 1 MEDIUM) corrected the bound to the channel's NARROWEST hop
and the arithmetic that mislabeled it. The 450k-UNIT cap fit the job-output store but not the
single Linux envp entry (MAX_ARG_STRLEN, 128 KiB) that injects the record into the
materializer — the shell dies with E2BIG before any in-script guard, reproduced at ~140 KB — and
450k UTF-16 units is up to ~900 KB, not "half of 1 MB". The cap is now EVIDENCE_MAX_BYTES =
100_000, measured with Buffer.byteLength in UTF-8 (what envp counts); a multi-byte regression
proves the unit measure would have undercounted 3:1. And the materializer is now proven by
EXECUTION, as required: the real script runs with a record sized near the cap (~98 KB) and the
produced plan.json equals the record byte for byte; the foreign-correlation and vanished-evidence
paths fail for real; and a companion test demonstrates the reason the byte cap exists — a 400 KB
env entry (legal under the retired cap) cannot even start the shell (E2BIG).

Implementation round I3-3 (Codex, 1 HIGH) proved the transport instead of assuming it. The
evidence record crosses jobs as a GitHub output — a channel with a documented ~1MB per-job bound
(UTF-16) that can also suppress values — so three laws landed. (1) The record is BOUNDED to the
channel: EVIDENCE_MAX_UTF16 = 450k units (half the platform bound), and `boundedEvidence`
reshapes by NAMED code — rendering removed with EVIDENCE_RENDERING_OMITTED, variable lists
dropped with EVIDENCE_CHANNEL_OVERFLOW — never a truncation; the fixed core always fits. (2) The
run-level law: a plan whose full record cannot cross the channel REFUSES as
PLAN_RENDERING_TOO_LARGE after preparation — the prepared change sets REMAIN (a refused plan is a
declined plan, removable only under the abandon operation), the bounded refusal evidence still
travels, and no gate can be issued over a rendering nobody could download complete; the plan
runbook gained the stop condition (split the wave, plan again). Deploy records carry no rendering
and cross even a test-narrowed 2k channel untouched. (3) Transport loss is a RED RUN: the
materializer fails loudly when a mode arrived with empty evidence (the dropped/suppressed-output
case, after a possible effect), and validates arrival — schema plus THIS dispatch's correlation —
before writing the file. Tests drive a plan through a channel it cannot fit, force the
pathological reshape branch, and pin the vanish guard; the normal four-stack record measures
under a quarter of the real cap.

Implementation round I3-2 (Codex: 1 HIGH, 2 MEDIUM) replaced the scrub with the boundary it was
pretending to be. **`id-token: write` is job-scoped**: emptying AWS_* variables cannot remove the
ability to mint a fresh OIDC token, and `!cancelled()` would have let the uploaders run even
after a failed scrub — so no post-effect ACTION ever runs in the credentialed job again. The
evidence record leaves dev-stage as job OUTPUTS (the channel the manifest already travels) and a
new `dev-evidence` job — no id-token, no Environment, no AWS consumer, a fresh runner that can
never mint a token, DAG-terminal — materializes the file under the NAME the runbooks digest
(plan.json / deploy.json / evidence.json, closing the F3 mismatch) and runs the three pinned
uploaders. The window rule was re-narrowed: after the consumer, the ONLY steps are the closed
named set (preflight evaluator, entrypoint, evidence reader) with their full content pinned; a
job holding id-token may never contain an uploader; both proven by mutation (uploader in
dev-stage trips two named rules; a foreign run step after the consumer trips the closed set;
dev-evidence acquiring id-token refused). The entrypoint records a mutation at ACCEPTANCE
(F2): `executed` is pushed when execute-change-set returns success, before the stability wait, so
a STACK_EXECUTION_FAILED artifact carries the started stack and log and artifact can no longer
disagree — regression proves the printed set equals the recorded set. SPEC-LANE-001's PROPOSED
text now states the job-boundary law, with the short-lived scrub clause recorded as replaced.

Implementation Slice I3 delivered the evidence artifacts for the two mutating operations
(SPEC-RUN-007 made real; SPEC-LANE-001 widened while PROPOSED). The entrypoint gained
`--artifact-out`: with it, `CORRELATION_ID` must match the closed grammar BEFORE anything runs
(unattributable evidence is not evidence — CORRELATION_MALFORMED refuses and writes nothing), and
every exit after that proof writes the CLOSED record — schema, correlationId, releaseSha,
environment, mode, decisionId, stacks, planDigest, change sets by NAME (an id is an ARN and never
enters evidence), the SHARED `executed` array so every halt carries the honest partial, refusal
codes verbatim, and the sanitized rendering on plan_only. Tests prove: the closed key set, the
artifact digest IS the printed digest, no account-bearing ARN anywhere and no ARN at all outside
the rendering, the mid-wave halt recording exactly the executed prefix, and byte-for-byte
unchanged behavior without the flag. The lane uploads it with the credential window CLOSED first:
a reviewed scrub step empties every AWS_* variable via GITHUB_ENV, and only AFTER it do the three
pinned uploaders run (plan / deploy / refusal-evidence, upload-artifact v7.0.1 by SHA,
if-no-files-found error/error/ignore) — the window rule was widened to a still-closed grammar
(consumer → entrypoint only → scrub → pinned uploaders + evidence read only), with mutation
proofs: an uploader BEFORE the scrub trips the action rule, a foreign action AFTER the scrub
trips the post-scrub vocabulary, npm after the scrub refused. Steps run on refusals too
(`!cancelled()`): evidence of a refused run is still evidence.

Implementation Slice I2 (first commit) delivered the lane's bind foundations — SPEC-LANE-005/006
made real. `release-pilot.yml` gained: a canonical `run-name` (`cba-release <mode>
<correlation_id>` — the exact closed string bin/resolve-run.mjs matches by equality); a REQUIRED
`correlation_id` dispatch input whose closed grammar (`^cba-70-[0-9a-f]{32}$`) is refused in the
global preflight BEFORE any git invocation or credentialed stage (executed tests drive the real
script: seven malformed shapes refused with zero git calls and nothing emitted); a `bind_only`
mode option; and a `bind-stage` job that terminates the DAG — gated on the IMMUTABLE dispatch
input (an Environment value changed mid-run changes nothing), holding no id-token, containing no
OIDC consumer, needed by no job — which assembles `binding.json` (correlationId, releaseSha,
manifest) and uploads it via SHA-pinned upload-artifact v7.0.1. `dev-stage` is now reachable
ONLY on `mode == 'dev_only'`, so a bind run cannot deploy. EXPECTED_WORKFLOW regenerated
deliberately; the mode rule names the reviewed non-pilot set {bind_only, dev_only} with
dev_then_pilot still refused by name; IF grammar extended to the closed mode literals; six jobs;
new semantic rules and mutation proofs (mode gate stripped, id-token acquired, foreign run name,
optional correlation). SPEC-LANE-004's PROPOSED text widened accordingly (§4 permits editing
PROPOSED); LANE-005/006 rows and registry entries now carry their real anchors. All ids remain
PROPOSED.

Implementation round I1-5 (Codex, two HIGH) removed the last places where breakage read as
absence. **A git failure is never "no history"**: the shallow probe must run and answer
(`HISTORY_UNPROVABLE` otherwise), parents are ENUMERATED (`rev-list --parents` — a proven root
commit is the only legitimate "no baseline"), file absence is proven by `ls-tree` (and a `show`
that fails for a file ls-tree just listed refuses), and a broken diff refuses instead of
returning "no changes" — in the worktree resolver, the commit-mode loader and both diff modes,
with adversarials for each breakage in a non-shallow repository. **Every child runs inside its
own boundary**: two run-level guards left a window where a check or concurrent process could
swap a later child's file for a symlink and restore it before the final guard —
`assertChildBoundary` now verifies, immediately before AND after each test and each check, that
the audited object is a regular blob, that the PHYSICAL path is a regular file (lstat), that its
bytes equal the audited commit's bytes exactly, and that the tree is clean. Codex's
discriminating reproduction is a regression: a check that swaps the probe file for a symlink to
/tmp mid-run is caught at that child's boundary (`EXEC_PATH_NOT_REGULAR`), same-length byte
drift is caught (`EXEC_BYTES_DRIFTED`), and the honest end-to-end run over an ACTIVE fixture
conforms.

Implementation round I1-4 (Codex, three HIGH + one MEDIUM) took the laws to where CI actually
runs. **The reviewed commit itself was not green** — the round-I1-3 provenance assertion demanded
baseline bytes differ from current bytes, which is false for any commit that does not touch the
registry; the test now asserts PROVENANCE (the baseline equals what the right source holds —
HEAD when diverged, HEAD's parent when clean — whatever those bytes are), and this round's
battery was re-run at the final commit. **Shallow clones refuse instead of degrading**: CI's
default single-commit checkout made HEAD~1 unreadable and every historical law silently became
"registry birth" — `HISTORY_TRUNCATED` now fails closed in both the baseline resolver and the
diff, quality.yml checks out with fetch-depth: 0, and CI runs the FULL SHA-bound paths
(`spec:lint --commit $(git rev-parse HEAD)` and `spec:conform --commit …`) beside npm test.
**Executed bytes must be regular tracked files**: a tracked symlink "exists", keeps the worktree
clean, and runs bytes from outside the audited commit — `isRegularTrackedFile` now checks BOTH
views (the git object's mode 100644/100755 and lstat on the path the child would actually
execute), applied to test files and check refs, proven with a real symlink built and refused in
the test. **Renames carry both sides**: `--name-status -M` replaced `--name-only`, so a governed
file renamed AWAY still counts as touched, with Codex's exact reproduction as a regression.

Implementation round I1-3 (Codex, four HIGH findings) closed the gap between the laws and what
CI actually exercises. **The history baseline is never the bytes under validation**: on a clean
checkout the worktree file IS HEAD's file, so "compare with HEAD" compared the registry with
itself and every historical law was vacuously green — the baseline is now HEAD when the worktree
diverged, HEAD's parent when it is exactly HEAD, proven against the real loader; and retiring an
ACTIVE id no longer licenses a rewrite — the text stays byte-identical through retirement. **The
annotation scan fails closed and is commit-bound**: a git error refuses (exit 1 with empty output
is the only "no matches"), broad candidates are parsed so a malformed token offends instead of
vanishing, frontmatter reference lists resolve piece by piece, documentation placeholders are a
closed set, and `--commit` greps the named tree-ish rather than the ambient worktree. **The
governed-path predicate exists**: `governedPathOffenses` flags an ACTIVE id whose governed files
changed without its tests or checks moving, fed by `diffChangedFiles` with the honest baseline
per mode (commit vs parent; dirty worktree vs HEAD, untracked included; clean checkout HEAD vs
parent), wired into spec:lint. **Checks are contained**: refs obey the same repo-relative law as
anchors, every child (tests included) runs with a minimal environment — proven by a probe check
that fails if the invoking shell's variable leaks — and bounded wall-clock; and the commit-bound
conformance run re-guards the worktree AFTER the children ran, so a check that edited code or
tests mid-run invalidates the verdict instead of decorating it.

Implementation round I1-2 (Codex, six findings on Slice I1) hardened the spec system before any
id can activate. `--commit` now requires the worktree to BE the audited commit (HEAD equal, tree
clean) — the tests run from the worktree, and a broken target must not borrow a fixed tree's
green. Conformance executes CHECKS as obligations (bash, 60s bound, named refusals), not just
tests. The historical laws exist: judged against the last committed registry — inductively, every
reviewed commit — nothing is ever deleted, an ACTIVE text cannot change even when digest and
table are edited consistently with it, ACTIVE never quietly reverts to PROPOSED, and RETIRED is
permanent in status, successor and text. Supersession became RECIPROCAL data (`supersedes` is a
list; -019 names both -002 and the absorbed -020), so a supersededBy aimed at an unrelated id
refuses. Paths must be normalized repo-relative (an anchor can no longer escape to a sibling
checkout), an ACTIVE anchor symbol must actually appear in its file, and the third traceability
direction runs from day one: every `[SPEC-…]` annotation in tracked content must resolve. The
decision record now attributes each received line to its actual channel — what Opus received
verbatim, what Codex reports as Zamp's own words, and Codex's normalization, separately. The
spec header states the honest phase: implementation in progress, zero ACTIVE, no completeness
claimed.

**DESIGN PHASE CLOSED — APPROVED.** Codex `REVIEW_APPROVED` with zero findings at
`648748aadf5a9a5101524337f9a09379d6807ca7` (2026-08-07); Zamp accepted the design and authorized
the implementation phase, LOCAL ONLY (`decisions/70-spec-anchored-design-accepted.md`). The
implementation follows §10's order — spec system first, then annotations, protocol amendments and
lane changes — with every activation atomic with its conformance. Publication, cloud effects,
secrets, paid calls and the TOCTOU acceptance remain exactly as gated before.

Design round 15 (Codex, two findings) made the reconstruction itself fail-closed. **A dangling
continuation can no longer vanish**: the reconstructor used to reset its buffer silently at a
fence boundary, and skipped blank/comment lines even mid-continuation — so a trailing backslash
followed by a comment reconstructed IDENTICALLY to the original document while bash would join
and execute the hidden command. Now the blank/comment skip applies only BETWEEN commands (while a
continuation is open, whatever follows is payload, per shell semantics); a continuation left open
at a fence boundary or at EOF, and an unbalanced fence, are refusals — and a refusal counts as a
deviation, never as a clean document. Codex's exact reproduction, plus continuation+blank,
continuation-at-closer, continuation-at-EOF and unbalanced-fence, are pinned regressions against
the real runbook text, with the untouched document asserted clean beside them.

**The inventory's own bound became a closed operation-class list.** The prefix meta-checks let
`gh api -X DELETE repos/<canon>/actions/secrets/…` and `gh issue close` through; every
inventoried gh command must now match one of the three sanctioned operation classes, anchored
both ends, with both reproductions pinned as refusals. The claim is stated at its honest size:
the rule bounds gh-spelled operations by CLASS — exact cross-field pairing and non-gh spellings
inside the inventory are what independent review of any inventory diff exists for, the inventory
being a reviewed artifact and this rule its belt, not its judge.

**THE LANE IS NOT YET OPERABLE — activation prerequisites, each Zamp-gated, recorded in the
workflow header:** (1) the per-tier release bootstraps (`aws-bootstrap-and-oidc.md` step 12):
three operator-managed policies per tier + `cdk bootstrap --qualifier cbardev|cbarpil
--toolkit-stack-name cba-release-toolkit-<env>`; (2) provision
`cba-study-coach-gha-deploy-dev` + its boundary (Zamp creates the policy outside CloudFormation)
via a human-gated SecurityStack redeploy under the extended exec policy, then publish its ARN as
the dev Environment secret `AWS_DEPLOY_ROLE_ARN`; (3) populate the dev Environment secrets and variables (read-only
inspection on 2026-08-02 found ZERO of each); (4) per release, set `CBA_CLOUD_GATE` — naming the
reviewed plan group (a wave on a fresh tier; the full set in steady state): first `plan_only`,
which prepares that group's change sets and emits `PLAN_DIGEST`; then `deploy` naming that
digest inside a ≤1h window — wave by wave until the tier exists.

## Ownership

- Issue owner / implementation executor: **Claude Opus 5** — Slice B1 in implementation on worktree
  `../cba-issue-70b`, branch `task/70-aws-dev-deploy-slice-b`, cut from `origin/main` at
  `95583e94` on Zamp's assignment (2026-08-02).
- Architect / independent technical and security reviewer, read-only: **Codex**.
- Assignment, approval, risk acceptance, gate and merge authority: **Zamp**.
- One owner at a time: while this is in `active/`, no other agent takes #70 files.

## Slice A — what was delivered

**One definition of the deployed values.** `DEFAULT_AUTH_URLS` and the `authDomainPrefix` fallback
moved out of `identity-stack.js` into `context.js`, and the stack now reads them from there. This is
load-bearing rather than tidy: a preflight with its own copy of the defaults can pass while the
stack synthesizes something else, and the check would be measuring itself.

**`infra/aws/lib/deploy-preflight.js`** — PURE evaluation of PREFLIGHT-1 and PREFLIGHT-2. No I/O, so
every adversarial control is an offline unit test. Both conditions are always evaluated, so one run
reports every reason it refused instead of making an operator discover them one deploy at a time.

- PREFLIGHT-1 reads the EFFECTIVE URLs after context resolution, never the committed default. An
  override that silently failed to apply — a misspelled key, a `-c` that never reached the CLI, a
  workflow input that expanded to empty — is indistinguishable from one that was never attempted
  unless the resolved value is what gets read. It decides on the parsed HOSTNAME: a path containing
  `.invalid` is legitimate, and `https://pilot.invalid.attacker.example` is a real resolvable origin
  that a substring rule would wave through as "obviously the placeholder".
- PREFLIGHT-2 requires the context KEY, not a value — the stack's fallback means a value always
  exists at synth time. It also requires confirmed regional uniqueness, refuses prefixes Cognito
  itself would reject before a deploy discovers them mid-stack, and treats a redeploy onto our own
  domain as a pass only when the expected pool id was supplied.

**`infra/aws/bin/deploy-preflight.js`** — the collector. One read-only AWS call
(`cognito-idp describe-user-pool-domain`), injectable so no test reaches a remote, time-bounded, and
it echoes no other tenant's user pool id. Exit 1 on refusal is what stops the lane; exit 2 is a usage
error, kept distinguishable. `--skip-probe` exists for offline dry runs and FAILS PREFLIGHT-2 by
design: skipping the question is not answering it.

**`.github/workflows/deploy-pilot.yml`** — the no-spend skeleton. `workflow_dispatch` only, so a
merge to `main` can never spend money unattended. The preflight is a separate JOB rather than a step,
because a step can be reordered, made `continue-on-error` or skipped by an `if:` without anything
noticing, while a failed job in `needs:` stops the dependent job outright. Environment separation is
by input, with the GitHub Environment named on both jobs — that is what turns "a human should
approve" into "the job does not start until a human approves". Reviewers and branch policy are
repository settings, deliberately not in this file: a workflow cannot grant itself an approver.

**Fail-closed everywhere.** An observation that could not be taken is a FAILURE, never a pass. A
denied probe, an absent region and an unparsed response are all refusals.

## Slice A — what was NOT done

- No `cdk deploy`, no Cloudflare deploy, no preview, no account mutation, no secret access, no paid
  call. A test asserts the lane contains no deploying command at all, so a later slice adding one has
  to update that assertion deliberately.
- The deploy job is a placeholder. It exists now only so the ordering and the gate are established
  and asserted BEFORE any deploying step is written.
- The AWS stack deploys, the Cloudflare half, the F1/F2 gates, the live SNS/KMS notification proof
  and the smoke lane all remain later slices.

## EXTERNAL PREREQUISITE RESOLVED — the human deployment binding now exists (2026-08-02)

This section recorded, from 2026-07-31, that the repository had ZERO configured GitHub Environments
and that the `environment:` keys in the lane were a binding with nothing to bind to. **That is no
longer the state.** Zamp configured both Environments, and read-only inspection of
`/repos/:owner/:repo/environments` on 2026-08-02 returned:

- `total_count: 2` — `dev` and `pilot` both exist;
- `dev`: `deployment_branch_policy.custom_branch_policies: true`, branch-policy list exactly
  `["main"]`, no required reviewer (as designed for the dev tier);
- `pilot`: the same main-only branch policy, PLUS `required_reviewers: [marciozampiron]`.

Every condition this section demanded is met: both tiers restrict deployment branches to `main`
only — so a workflow definition from any other branch cannot receive their variables or secrets —
and `pilot` requires the designated reviewer. The evidence enters independent review with the
commit that records it, which was the final demanded step.

What remains true and load-bearing: the `environment:` keys in `release-pilot.yml` are the BINDING;
the protection lives in repository settings, which no workflow can grant itself. Any future change
to those settings invalidates this record and must be re-evidenced.

## Slice A — Codex review round 1, and what it changed

Four findings, all upheld. The code deployed nothing then and deploys nothing now; what was wrong
was the FOUNDATION — it left room for a future deploy to bypass release identity, the preflight and
the approval.

**Release identity (HIGH).** The lane took `environment` and the callback/logout URLs as operator
inputs and never pinned `checkout`, so a manual run could select any branch and deploy a tree that
was never the reviewed one. Replaced per `deployed-environment-smoke-workflow-design.md` §1/§4:
`release_sha` is required, must be 40 lowercase hex AND an ancestor of live `main`; every checkout
pins it; `mode` (`dev_only` | `dev_then_pilot`) replaces the environment input; `target_environment`
is internal; there are no URL inputs at all — targets resolve only from Environment configuration.
There is no dispatch path that reaches pilot without a green dev stage in the same run.

**Binding the deploy to what was validated (HIGH).** A passing preflight proved that SOME
configuration was valid, not that the deployed one is it: a later `cdk deploy --all` could omit the
`-c` values and still satisfy the gate. The preflight now emits a manifest with a canonical digest
over `{releaseSha, environment, boundContext}`, written only on a pass — a manifest for a refused
configuration is a token that should not exist. A deploying job must carry that digest, and the
invariant test refuses the workflow if one does not.

The same finding caught the gating itself: `needs:` plus a permissive `if:` gates nothing. GitHub's
default "skip when a dependency failed" is REPLACED by any `if:`, so `always()` and the quieter
`!cancelled()` both let a failed preflight through. Every job now requires
`needs.<job>.result == 'success'`, and the invariant rejects both holes.

`expected_user_pool_id` was a caller input — whoever can name "our" pool can redefine which existing
domain a deploy is willing to adopt, turning PREFLIGHT-2's redeploy allowance into a bypass. It now
comes only from `CBA_EXPECTED_USER_POOL_ID` in the environment.

**The absent Environments (HIGH).** Recorded above as a blocked prerequisite rather than as a
control, and the workflow header says so in the file a future reader will actually open.

**Leakage (MEDIUM).** Codex reproduced role-ARN and credential-shaped material in this command's
output. The role ARN moved from a variable to a secret and `mask-aws-account-id: true` is set. Every
failure is now a CODE plus a FIELD NAME from a closed vocabulary; AWS stderr, the owning user pool
id, supplied URLs and the prefix never reach the output. A poison-value suite asserts non-leakage for
an account id, an IAM ARN, a pool id, an internal endpoint URL, an access-key-shaped string and a
token-shaped string, across the human output, the JSON output, probe errors and usage errors.

## Slice A — Codex review round 2, and what it changed

Both remaining findings upheld. Both were, again, foundation: the code still deployed nothing, but
what existed would not have constrained what comes next.

**The release identity was still a name, not an object.** The shell check `[0-9a-f]*` validates one
character — "a" followed by 39 uppercase Zs passed it, reproduced before fixing. Worse, the checkout
ran BEFORE validation, so a 40-character branch name could be checked out, blessed as an ancestor,
emitted as the release, and then MOVED before a later job resolved the same name again. Now: shape
(`length == 40` and whole-string charset) is checked in pure shell before any git invocation; the
identity job checks out `main`, never the candidate; the object must BE a commit (`cat-file -t`);
it must resolve to itself; ancestry from live `main` is proven; and the job emits the RESOLVED OID,
which is the only thing later checkouts may pin. The script is now EXECUTED in tests against a
stubbed git — the exact "a"+39Z value, ref-shaped names, a tag OID, a foreign resolution and a
non-ancestor are each observed refusing, before git where shape decides it.

**The binding was nominal, and the guard checked substrings.** `test -n "$CONTEXT_DIGEST"` bound
nothing; `echo "$CONTEXT_DIGEST"; cdk deploy --all`, `if: ... || true`, an OR branch accepting
`failure`, and an extra pilot job that merely contained the words `context_digest` all returned zero
errors from the old invariants — Codex reproduced each. Now:

- The digest covers `{releaseOID, environment, REGION, TARGET ACCOUNT, boundContext}`. us-east-1
  and us-west-2 no longer share a digest, nor do two accounts; both drifts are proven by test, and
  removing either field from the payload is proven to fail.
- The account is resolved by the collector (`sts get-caller-identity`, read-only, not
  IAM-gated) and lives only inside the digest — never in clear text in output or manifest.
- A purpose-built `verify-manifest` command replaces textual digest presence: closed manifest
  schema, environment/release/digest identity, and `--recompute` — which re-resolves the account,
  re-reads the effective context and recompares. Stage jobs verify the travelled manifest today;
  the invariants require any DEPLOYING job to run the recomputed verification in the same
  invocation, BEFORE its deploy command.
- The invariants now validate the DAG, not substrings: pinned exact success expressions per job and
  a closed grammar for any new one (no `||`, no `!`, no function call — `|| true`, `always()` and
  `!cancelled()` are all structurally impossible); every pilot-bound job must descend from the
  green dev stage and the pilot preflight; every deploying job from its environment's preflight.
  Each of Codex's reproductions is a named regression, and the mutation harness asserts every
  mutation actually applied before asserting it is rejected.

## Slice A — Codex review round 3, and what it changed

Six reproductions, all confirmed mechanically before fixing (five in memory; the sixth is the
branch-policy prerequisite above, tightened to cover dev as well). The common lesson: workflow
choreography cannot bind. Verify-then-deploy as two commands admits a different context, different
credentials or a different target between them, and no textual ordering rule can see any of it.

**Deployment is now bound BY CONSTRUCTION.** `infra/aws/bin/deploy-release.js` is the one sanctioned
deployment entrypoint: it verifies the manifest (closed schema), recomputes the digest from the
effective context and the resolved account, re-resolves the account immediately before the effect,
and then derives the deploy arguments FROM the very context object it verified — there is no
interface through which the deploy can receive different values, and no code path in the file that
invokes anything but `cdk`. The residual is the in-process window between the second account
resolution and the spawn, disclosed in the file header. Raw `cdk deploy` / `wrangler deploy` /
`opennextjs-cloudflare deploy` are forbidden EVERYWHERE in the lane by the invariants — the
verify-order heuristic they replace was fooled by all three round-3 reproductions, each now a named
regression. Slice A never calls the entrypoint: it exists so the binding is established and attacked
before the first deploying slice, not retrofitted around one.

**The nested manifest schema is closed.** `boundContextKeys: []` and a `preflight` block CLAIMING a
failure both verified cleanly before — the old shape check stopped at `Array.isArray` and never read
`preflight` at all. A manifest exists only because both conditions passed, so a nested claim saying
otherwise is a forgery, not a variant: the bound keys must equal the canonical set exactly, every
preflight claim must be `pass`, and the manifest names its `target.service` (`aws-cdk`), which the
entrypoint enforces — an AWS manifest is not spendable against any other target.

## Slice A — Codex review round 4, and what it changed

Four findings, all upheld. The pattern across rounds 3 and 4 finally named in full: NOTHING that
matters may rest on workflow text — not ordering, not verb detection, not a SHA compared to an
argument.

**The release now binds reality, not an argument (HIGH).** `deploy-release` compared the manifest's
SHA with a CLI flag and deployed whatever files were on disk — Codex reproduced a verified deploy
whose HEAD was a different commit entirely. The entrypoint now requires `git rev-parse HEAD` to
EQUAL the manifest's release, the worktree to be clean, and the ASSEMBLY digest to match: the
preflight synthesizes the cloud assembly from the bound context and digests its templates into the
manifest, and the entrypoint deploys THAT assembly via `--app` — never a re-synth from mutable
source.

**The region is imposed, not inherited (HIGH).** The manifest's region was compared and then never
applied; a child with ambient `AWS_REGION=us-west-2` deployed to the wrong region in the same
account, invisible to the account check. The entrypoint now overrides `AWS_REGION`,
`AWS_DEFAULT_REGION` and `CDK_DEFAULT_REGION` with the verified value on the child's environment.

**The step surface is a whitelist (HIGH).** `verb=deploy; npx cdk "$verb"` sailed past the raw-deploy
verb regex — a blacklist cannot establish exclusive use of the entrypoint. The invariants now allow
ONLY a closed set of step shapes: three exact actions (with their required properties) and six
byte-identical run templates. Any new command, however spelled, and any template with one line
added, fails until it is added under review. The verb-indirection bypass, an action-based deploy and
a single-line smuggle are each named regressions.

**The context contract is complete (MEDIUM).** Only the three auth keys were bound; changing
`githubTrustSub` or `corsAllowedOrigins` produced the same digest — IAM trust and CORS could drift
under a manifest that still verified. `DEPLOY_CONTEXT_KEYS` in `lib/context.js` is now the closed
inventory (nine keys), the digest binds all of them, and a discovery test scans the stack sources so
a NEW context key cannot be consumed without joining the contract.

## Slice A — Codex review round 5, and what it changed

Three findings, all upheld; the two mechanical ones reproduced before fixing.

**The assembly digest now binds everything CDK consumes, from a private snapshot (HIGH).** The old
digest hashed only the root `*.template.json` — mutating a Lambda bundle under `asset.<hash>/` or
the `*.assets.json` manifest left it unchanged, so arbitrary code could reach the privileged BFF
Lambda under a reviewed assembly identity. And the entrypoint handed the ORIGINAL path to CDK after
verification, leaving a check/use window. Now: the walk is recursive over every regular file
(relative path, type marker, bytes), symlinks and non-regular entries are refused outright
(`ASSEMBLY_UNSAFE_ENTRY`), and `deploy-release` COPIES the assembly into a fresh private directory,
digests THE COPY, compares, and points `--app` at the snapshot — the original path is never reopened
after verification. The regressions cover asset bytes, the asset manifest, the cloud manifest, an
added file, a removed file, a planted symlink, and mutation of the original DURING the child run
(the snapshot provably still carries the verified digest).

**Action authority is schema-closed, not name-closed (MEDIUM).** The allowlist checked names plus
presence-regexes — a swapped secret (`ADMIN_ROLE`), a deleted `aws-region` and arbitrary extra
inputs all passed, because presence-of-required is not absence-of-everything-else. Each action's
`with:` block must now EQUAL one of the reviewed variants — exact keys, exact values — and a
uses-step may carry nothing beyond name/uses/with, so an `env:` smuggled onto an action dies too.
All three reproductions plus the env-block variant are named regressions.

**The context contract cannot be read around (LOW).** Three fences replace the single scanner:
direct `tryGetContext` is forbidden outside `lib/context.js`; the scanner also sees the native-API
shape and refuses non-literal keys (proven on planted sources, with the forwarding wrapper as the
one sanctioned non-literal form); and `getContext` itself now REFUSES unlisted keys at runtime, so
an unbound read fails synth loudly. The discovery is bidirectional — declared-but-dead keys fail
too. Tightening the scanner immediately caught a key my manual inventory had missed:
`bedrockRefreshBoundaryArn`, an IAM boundary ARN — exactly the class round 4 was about. It joined
the contract, which now holds ten keys.

## Slice A — Codex review round 6, and what it changed

Five findings, all upheld; the two digest ones reproduced before fixing.

**The digest is injective now (HIGH).** Concatenating path, delimiters and raw bytes without length
framing is not injective — Codex built two different trees with the same digest, because a file's
CONTENT can contain the delimiter sequence. The canonical form is a JSON array of per-file records:
every field length-framed by the encoding itself, the content replaced by its fixed-length sha256
plus an explicit size. The exact reproduced collision pair is a named regression. **And the mode is
bound (MEDIUM)**: 0644→0755 changes the digest, normalized git-style on the owner-executable bit so
umask noise cannot refuse an honest assembly; the snapshot copy preserves the bit explicitly.

**Run steps are closed OBJECTS, not approved command text (HIGH).** `NODE_OPTIONS: --require
./evil.js` added to a reviewed step's `env:` kept the approved command and executed arbitrary Node.
Each reviewed block now carries the exact set of step-level keys and the exact env mapping —
`shell:`, `working-directory:`, `continue-on-error:` and any smuggled env variable die as unreviewed
step properties. Fixing this exposed a hole of my own: the step-shape loop lived inside the per-job
gating loop, which SKIPS `global-preflight` — the identity job's steps were never shape-checked at
all. The loop is standalone now, over every job, with the lesson recorded in the invariant comment.

**Actions are pinned to immutable commit SHAs (HIGH).** `@v7`/`@v6` tags can move after review,
including in jobs with `id-token: write`. All eleven `uses:` are pinned to full SHAs (the
`configure-aws-credentials` tag is annotated, so the PEELED commit is used, not the tag object).
The invariant refuses any non-SHA ref by its own rule, and the regression demands THAT rule's error
specifically — the schema-key closure would refuse the unknown name anyway, and a control satisfied
by the redundancy would go green when the pin rule was deleted.

**Snapshots never outlive the run (LOW).** One owner: everything after the snapshot creation runs
inside a single try/finally; partial copies clean themselves up. Regressions assert an empty
snapshot base after success, digest mismatch, account-resolution failure, context drift, account
swap and a failing child.

## Slice A — Codex review round 7, and what it changed

One finding, upheld, and it names the pattern behind rounds 2–6: the workflow validator PARSED A
DIFFERENT LANGUAGE than the consumer. Four payloads were semantically active under a real YAML
parser while the regex validator returned zero errors — a quoted env key, a quoted action input, a
job-level `env`/`container`, and a QUOTED SIXTH JOB carrying `id-token: write` and a remote
reusable workflow, which the regex `jobsOf()` did not even count. I reproduced the sixth-job case
before fixing: five jobs to the old parser, zero errors.

The regex parser is GONE, not extended. `yaml@2.9.0` — already in the lockfile transitively — is
now a direct, exact-pinned devDependency. The validator parses the workflow ONCE with duplicate-key
and warning rejection, and the authoritative check is deep equality against the REVIEWED OBJECT: a
frozen literal of the entire parsed workflow, so any semantic change — a key, a value, a step, a
job — fails until the literal is updated deliberately under review. Semantic guards (trigger,
forbidden job-level keys incl. `uses`/`container`/`services`/`env`, SHA pins, closed if-grammar,
DAG descent) run on the same parsed object, both for named diagnostics and to police future edits
of the reviewed object itself. The identity-script EXECUTED tests now take the script from the
parsed object — the same string GitHub would execute.

Each round-7 payload is a named regression that FIRST proves the payload is active under YAML
(`wf.jobs.rogue.uses` really is the attacker's reusable workflow) and THEN proves the validator
refuses it — plus a duplicate-key document refused at parse time. Discrimination: disabling the
reviewed-object equality fails 4 tests; disabling duplicate-key rejection fails; dropping
`uses` from the forbidden job keys fails.

## Slice A — Codex review round 8, and what it changed

One finding (MEDIUM), upheld: the placeholder stage jobs held `id-token: write` while doing nothing
that needs a token — checkout, Node setup, manifest verification. With the permission present,
every action, command and dependency lifecycle script in those jobs could mint an Environment-bound
OIDC token, against the smoke-workflow design (which assigns `id-token: write` only to deploy and
observability-gate jobs) and `SEC-IAM-01`.

The permission is removed from both stages — reviewed object included — and OIDC authority is now a
SEMANTIC rule, not just a snapshot fact: a job may hold `id-token: write` only when it contains the
exact pinned `configure-aws-credentials` action. The regression grants the permission back to a
placeholder and demands THE RULE'S OWN error — the reviewed-object diff also fires today, but the
day the reviewed object is edited to include the permission, the diff goes silent, and the named
rule is what keeps the regression discriminating across that edit. The preflight jobs, which carry
the pinned consumer, are asserted NOT to trip the rule. A later deploying slice restores the
permission together with its reviewed credentials action and the sanctioned entrypoint.

## Slice A — validation

Root and infra suites, `cdk synth` for both tiers, and adversarial controls proven to bite by
mutation rather than merely to pass. Recorded in the review request for this slice.

## What #70 owns, and what it must not touch

This is the first issue in the sequence whose acceptance requires a real deploy. Everything below is
account-level or workflow-level. **No part of it re-opens code already merged and reviewed.**

Explicitly OUT of scope, because it is delivered:

- #67 Stage B's in-repo half — per-environment Worker declarations, the runtime-variable contract,
  the structural CORS guard. Merged in PR #100; see `done/67-cloudflare-opennext-stage-b.md`.
- The smoke-test data cleanup contract. Merged in PR #101; see `done/75-smoke-cleanup-contract.md`.
- The O1/O2 release gates and the `ObservabilityStack`. See the three `done/82-*` handoffs.

Reopening any of those is a scope error, not an improvement.

## Scope

### Inherited from #67 (transferred here on 2026-07-30)

- **The origin decision is CLOSED: the pilot uses `workers.dev`** (Zamp, 2026-08-02). What the
  decision fixes — the exact origin in the #69 CORS list and the Cognito callback/logout URLs — is
  now knowable. Deciding is still not the same as having supplied the value: the committed defaults
  remain the reserved `.invalid` placeholder, and the REAL values enter only as Environment
  configuration at deploy time, where PREFLIGHT-1/2 verify them.
- Cloudflare account/project setup and the Environment-scoped API token — never committed.
- Per-environment Worker routes and the runtime variable VALUES the Worker serves:
  `CBA_BFF_BASE_URL` first, plus the `COGNITO_*` values `/auth/config` reads.
- Deploy lane wiring: build once, promote the same artifact. `opennextjs-cloudflare deploy` is
  invoked ONLY from the #70 workflow behind the Environment approval, never from a repo script.
- Preview/ephemeral URLs stay out of the BFF CORS allow-list (`pilot-environment-contract` §1).
- Frontend gates F1/F2 against `FRONTEND_URL`, and the rollback path in runbook §4.1.
- Cache/incremental-cache backend: Stage A deliberately ships none (no R2/KV/D1/DO). Adding one is a
  #70 decision with its own cost and human gate.

### Deploy preflight (BINDING, registered by #69 — applies to EVERY deploy lane)

Two conditions were registered against #70 by `done/69-cognito-cors-boundary.md` and they are
carried here unchanged. They are not advice, and not a checklist item for the pilot lane only: every
deploy lane — dev, pilot, any future environment, and any manual invocation — must evaluate both and
**fail before `cdk deploy` runs**, not after. A deploy that has already created a User Pool domain
is not a state you back out of cheaply.

- **PREFLIGHT-1** — refuse to run `cdk deploy` if `.invalid` still appears anywhere in the effective
  `authCallbackUrls` or `authLogoutUrls` for the target environment. The committed pilot defaults
  are `https://pilot.invalid/auth/callback` and `https://pilot.invalid/`; `.invalid` is the RFC 2606
  reserved TLD precisely so that a forgotten override cannot resolve by accident. Check the
  EFFECTIVE value after context resolution, not the committed default — an override that silently
  failed to apply looks identical to one that was never attempted.
- **PREFLIGHT-2** — refuse to run `cdk deploy` unless the pilot `authDomainPrefix` was **explicitly
  supplied** and **confirmed unique in the target region**. A value existing is not the condition:
  `identity-stack.js` falls back to `cba-study-coach-<env>`, so an unsupplied prefix is
  indistinguishable from a deliberate one. Cognito hosted-UI domain prefixes are globally unique per
  region, so an unverified prefix fails at deploy time, mid-stack, after other resources exist.

Neither condition is satisfied by the domain decision alone. Deciding the origin is what makes the
values knowable; supplying and verifying them is what clears the preflight.

### AWS side

- Deploy the stacks that are implemented but synth-only: `DataStack` (#77), `ApiStack` (#78),
  `IdentityStack` (#69), `ObservabilityStack` (#82 Slice B). Only `SecurityStack` is deployed today.
- **The live CloudWatch -> SNS -> KMS -> confirmed-subscription proof.** #82 did NOT close this. O1
  proves the resources exist and O2 proves telemetry flows and alarms are `OK`; neither proves a
  notification can actually be delivered. That is the one failure mode that stays silent, because a
  broken key policy loses notifications without changing any alarm state. It is also the only check
  that can falsify the deliberate narrowing of the key policy to exactly `kms:Decrypt` +
  `kms:GenerateDataKey`. Runs under operator credentials, required before the first `pilot`
  promotion, and must be re-proven after any key or topic policy change.
- Wire O1/O2 into the workflow and enforce the bounded execution window on the saved queries.

### Smoke gates

- The deployed smokes call the #75 cleanup contract through the BFF as the smoke learner. They must
  never reach DynamoDB directly.
- **Membership in the `cba-smoke` Cognito group is a human action, once per environment.** The group
  is declared in `IdentityStack` but has no members, and CI is deliberately not permitted to assign
  them — that would give the deploy role Cognito admin permission. Until a human assigns them, the
  cleanup endpoint answers 403 in a deployed environment, and the smoke lane cannot pass.

## Prerequisites before GO

- ~~The 6 high Dependabot alerts~~ — **COMPLETED** (#106, PR #107, zero risk acceptance; 0 high
  open). Two moderate root alerts remain documented in `done/106-dependabot-high-remediation.md`,
  outside any GO criterion.
- ~~The custom-domain decision~~ — **COMPLETED**: `workers.dev` (Zamp, 2026-08-02).
- The live SNS/KMS notification-path proof above — **still required**.
- PREFLIGHT-1 and PREFLIGHT-2, implemented in Slice A, must hold failing closed on every deploy
  lane at deploy time — **still enforced at every deploy**. GO is not a judgement call about them:
  the lane must refuse on its own.

## Explicit exclusions

- No `deploy` or `preview` npm script in `web/package.json` — deployment belongs to the workflow, so
  a local `npm run` can never mutate an account.
- No Cloudflare token, account id, zone id or endpoint in tracked files, logs or fixtures.
- No AWS account id or ARN in tracked files.
- No `opennextjs-cloudflare migrate` — it can provision an R2 bucket.
- No long-lived AWS access keys; OIDC assume-role only.
- No change to the learner API contract, exam-mode rules, or the `apiFetch` single-door seam.

## Read first

1. `done/67-cloudflare-opennext-stage-a.md` and `done/67-cloudflare-opennext-stage-b.md`
2. `done/75-smoke-cleanup-contract.md` (the cleanup contract the smokes call)
3. `done/82-observability-slice-c.md` (O1/O2)
4. `docs/architecture/pilot-environment-contract.md` §1 and §3
5. `docs/architecture/deployed-environment-smoke-workflow-design.md` (F1/F2)
6. `docs/architecture/pilot-release-runbook.md` (GO/NO-GO, rollback §4.1)
