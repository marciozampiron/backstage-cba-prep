# Agent Coordination Events

Append meaningful coordination changes here. Newest entries should go at the top.

## 2026-08-05 — Claude — #70 Slice B1 round 11: the whole change set bound, the last formats closed

- Codex's round-11 review of 4dc496b2: "complete change" still meant `Changes` — the change
  set's executable semantics (Capabilities, OnStackFailure, RollbackConfiguration,
  NotificationARNs, Tags, Parameters, nested/import) were outside both the digest and the
  material, so two plans differing only in `OnStackFailure: DELETE` versus `ROLLBACK` produced
  the same digest and the same rendering; and the sanitizer still preserved text by generic
  FORMAT — numeric strings (`111122223333`), free map keys (`supersecret`), identifier-shaped
  values and our own project prefix — while a SECOND scanner echoed the prepare child's
  stdout/stderr, leaving `postgres://user:supersecret@db.internal/cba` in a persistent CI log.
  Two HIGHs. Fix-forward, all eleven reviewed commits preserved.
- The canonical entry carries the complete DescribeChangeSet response, so the gate binds every
  executable semantic; the rendering NAMES them (on-failure, capabilities, notifications,
  rollback monitoring and triggers, tags, parameters, nested lineage) before the resource diff,
  and then dumps the whole sanitized response. Pagination is consumed page by page — proven with
  a three-page description whose last page must reach the material — and a description that
  never stops paginating refuses instead of authorizing a partial plan.
- Text survives only under a KNOWN SCHEMA FIELD with a VALIDATED value. Free positions have no
  allowance left; only real JSON numbers stay numbers; only schema keys render; PhysicalResourceId
  and parameter/tag values pseudonymize whole (including an ARN-shaped physical id, which the ARN
  grammar would otherwise have rendered); stack names are validated against the names THIS
  release computed. Parameter NAMES stay legible — a name is schema, a value is content.
- One output policy: the child-output scanner is gone. A failing prepare records
  `child not echoed — exit=… bytes=… sha256=…` and not one byte of the child's text, proven on
  the real PLAN_PREPARE_FAILED path with a credential-spewing child.
- Six protections, six reversions, six failures: the complete-response binding, the numeric-string
  allowance, the format-based keys, the PhysicalResourceId whole-pseudonym, the format-validated
  stack name and the pagination refusal each drop their own regression when removed.
- Nothing was deployed, published or mutated.

## 2026-08-04 — Claude — #70 Slice B1 round 10: the material completed, the last default inverted

- Codex's round-10 review of 23d77ea2: the presentation rebuilt `ResourceChange` from six
  hand-picked fields, so `PolicyAction`, `Scope`, `PhysicalResourceId`, `ChangeSetId` and
  `ModuleInfo` never reached the human — two plans differing only in `Retain` versus `Delete`
  rendered identically while the gate bound different bytes; and the sanitizer was still
  fail-OPEN for arbitrary strings and structured keys (secrets inside serialized JSON, a URL used
  as a map key, a URL wrapped in punctuation, and any suffix trailing a CloudFormation stack id).
  One HIGH, one MEDIUM. Fix-forward, all ten reviewed commits preserved.
- The review material carries the COMPLETE change now: each change renders as a concise summary
  line (action, type, logical id, replacement, policy, scope) FOLLOWED by the whole sanitized
  ResourceChange as canonical JSON. Nothing is selected away, and a field CloudFormation adds
  upstream appears without anyone remembering to add it — proven with an unenumerated field.
- Scalars fail CLOSED. A string renders verbatim only for an explicitly reviewed public form —
  the closed CFN vocabulary, an AWS::Service::Type, a number, a region, a project-owned name, or
  a URL/ARN through its own grammar; everything else is a deterministic [value#…] marker, so
  equal values stay comparable while unknown material stays unshown. Keys are sanitized like
  values. URL/ARN spans are recognized anywhere in a string, including behind punctuation and
  inside serialized JSON, and bracketed IPv6 authorities are parsed rather than shredded.
- BeforeValue/AfterValue and the context blobs are parsed and walked — which is also what keeps a
  decision-bearing origin READABLE through JSON's legal `\/` escapes: without the walk the
  approved workers.dev callback collapses into markers and the classifiability contract dies
  inside every serialized value. That is the regression the walk alone satisfies.
- The CloudFormation ARN grammar is complete and anchored: stack/<name>/<uuid> exactly, so a
  trailing `covert-suffix` fails closed to a whole-resource pseudonym.
- Five protections, five reversions, five failures: the full-JSON rendering, the fail-closed
  scalars, the key sanitization, the JSON walk and the anchored CFN grammar each drop their own
  regression when removed. Byte-identical restoration verified. Nothing was deployed, published
  or mutated.

## 2026-08-04 — Claude — #70 Slice B1 round 9: values classified as fields, grammars anchored

- Codex's round-9 review of 6f8c702f (the six round-8 reproductions confirmed closed): the
  structured parser only saw what an incomplete text scanner handed it — `postgres://` with
  credentials passed whole (the scanner knew only http/s), a backslash cut the candidate and
  stranded `?token=…` outside it, and pathnames rendered verbatim under any host including the
  approved one; and `projectNamed()` blessed a WHOLE resource after finding a project prefix in
  one segment — lambda aliases, log streams and Cognito groups rode through, an API Gateway v1
  path returned entirely, and known-service branches failed OPEN when their expected shape did
  not match. Two MEDIUMs. Fix-forward, all nine reviewed commits preserved.
- Presentation is composed FROM SANITIZED VALUES now: every string in the canonical entries is
  classified token by token (URL of any scheme, ARN, residual identifiers) and rendered by its
  own field-aware rule; the CFN Before/After context blobs parse as JSON and are walked, failing
  closed when unparseable; residual passes run over classifier output too, so an account inside
  a verbatim-blessed bucket name still pseudonymizes. There is no outer scanner.
- URL paths render only from the reviewed shape list (the committed auth callback/logout forms,
  the Cognito hosted-UI endpoints, the stage roots) — an approved workers.dev host does not
  bless an unreviewed path. Unknown schemes are markers; credentialed URLs are markers whatever
  the scheme.
- The per-service ARN grammars are ANCHORED: only the exact project-owned identity segment
  renders; aliases, streams, groups, sessions, qualifiers and generated ids pseudonymize; every
  known-service branch — and every unknown service — fails CLOSED to a whole-resource pseudonym.
- The eight review reproductions are direct regressions, and the round-8 implementation was
  proven to FAIL them: the http-only classifier, verbatim paths, substring blessing and the
  cognito fail-open each reverted and each caught. The round-7/8 classification controls hold
  under the tightened contract. Nothing was deployed, published or mutated.

## 2026-08-03 — Claude — #70 Slice B1 round 8: the renderer's own exceptions closed

- Codex's round-8 review of b507e587: the renderer's exceptions were broader than the reviewed
  types — any `*.amazonaws.com` host passed whole (bucket-style and ELB-style names are not
  public), and the per-service allowlist let S3 object keys, SSM parameter paths and STS
  resources through verbatim; and the ad hoc URL regex missed grammar — embedded credentials
  printed (`user:supersecret@…`) and IPv6 literals bypassed query stripping entirely. Two
  MEDIUMs. Fix-forward, all eight reviewed commits preserved.
- No suffix or service allowlist survives: a FORMAT either matches a reviewed project-name
  family (cba-study-coach-, cdk-cbardev-, cdk-cbarpil-, the exact bootstrap-version parameters)
  or it pseudonymizes. S3 object keys never render, whoever owns the bucket; foreign bucket
  names and SSM paths never render; STS keeps the principal's role path (classifiability, the
  round-6 contract) but pseudonymizes the caller-chosen session; outside the exact host families
  (workers.dev, amazoncognito.com, localhost, the execute-api pattern) every host — amazonaws or
  not — is an [unexpected-host#…] marker.
- URLs are parsed with the STRUCTURED WHATWG parser: credentials never render — the whole URL
  becomes a [credentialed-url#…] marker; IPv6 and every unrecognized host form are markers;
  an unparseable candidate is never emitted raw; ports survive as structure; query and fragment
  always strip.
- The six round-8 reproductions are direct regressions, and the VULNERABLE implementations were
  each proven to fail them: the amazonaws blanket, the S3 allowlist, the SSM allowlist, the
  credential pass-through and the round-7 ad hoc parser — five reversions, five failures,
  byte-identical restoration verified after each.
- Nothing was deployed, published or mutated.

## 2026-08-03 — Claude — #70 Slice B1 round 7: the renderer became type-aware

- Codex's round-7 review of 22eaf263 (API Gateway confinement and the import walker CONFIRMED
  CLOSED): the generic first-label rule reproduced the round-5 defect for ENDPOINTS — the
  approved `cba-study-coach-pilot.workers.dev` origin and `evil.workers.dev` both rendered as
  opaque hashes, when the first label IS the identity Zamp reviews for origins, callbacks and
  CORS; and the round-6 claim that every ARN path is repository-public was FALSE — KMS key
  UUIDs, API Gateway ids, stack UUIDs and URL query values rendered verbatim. One HIGH, one
  MEDIUM. Fix-forward, all seven reviewed commits preserved.
- The renderer decides BY TYPE now. Decision-bearing identities render VERBATIM: IAM role paths,
  full hostnames from the reviewed suffix list (`workers.dev` — the approved pilot origin
  family; `amazoncognito.com` — the project-chosen auth domain; localhost), project-chosen stack
  and alias names. Generated material pseudonymizes at 128 bits: KMS key UUIDs, API Gateway
  api/route ids, Cognito pool ids, CloudFormation stack/changeset UUIDs, execute-api labels,
  free-standing UUIDs, accounts. URL query strings strip to `[query-redacted]` — tokens live
  there. A hostname no reviewed decision produced renders `[unexpected-host#…]` — classifiable
  as unexpected, never verbatim (it may itself exfiltrate), never hash-blended into the crowd.
  An unknown service's ARN resource pseudonymizes whole — unknown is not proven public.
- Direct regressions: expected-versus-attacker workers.dev origins both read in clear and
  differ; raw KMS/API/stack identifiers and a query token never render; the Cognito auth domain
  stays legible; IAM stays the round-6 contract. And per the review's demand, the BROKEN
  implementations were each proven to FAIL: hosts collapsed to hashes, query returned verbatim,
  KMS UUIDs verbatim, unknown hosts verbatim, API ids verbatim — five reversions, five failures,
  byte-identical restoration verified.
- Nothing was deployed, published or mutated.

## 2026-08-03 — Claude — #70 Slice B1 round 6: children tag-confined, identities classifiable, imports walked

- Codex's round-6 review of f6942f55: the API Gateway child paths still allowed unconditioned
  mutation beneath every API id (and /tags/* allowed unconditioned tag deletion — a compromised
  role could strip a foreign API's governance tags); the 8-hex fingerprints made principals
  distinguishable but not CLASSIFIABLE (an approved role and an attacker's role were two opaque
  hashes, with a feasible 32-bit collision surface); and the wave guard walked CDK metadata
  edges, which a literal Fn::ImportValue pasted into a template never creates. Two HIGHs, one
  MEDIUM. Fix-forward, all five reviewed commits preserved.
- Every API Gateway operation now demands ownership: children (routes, integrations,
  authorizers, stages, deployments, cors) authorize against the owning API's Project/Environment
  tags per the service authorization reference; the V2 tags API is shaped POST/DELETE/GET with
  resource ownership required; and the governance tags themselves are FENCED — removal of
  Project/Environment explicitly denied, replacement with foreign values explicitly denied — on
  API Gateway, Cognito and KMS alike, so an owned resource cannot be untagged out of its
  confinement. A control asserts no unconditioned apigateway mutation exists anywhere, and the
  condition values are proven EQUAL to the tags the real synthesized templates carry.
- Review material uses STRUCTURED pseudonymization now: service, region, resource type and path
  render VERBATIM (the expected deploy role and role/evil-admin are each classifiable at sight);
  only account material renders as pseudonyms, at 128 bits — no feasible collision surface.
  Stated limit, on the record: a 12-digit account space is enumerable offline against any
  unkeyed derivation; the pseudonym prevents log disclosure (the mask-aws-account-id posture),
  it is not cryptographic secrecy.
- The fresh-tier guard walks the synthesized TEMPLATES recursively for literal Fn::ImportValue,
  resolves every export name to its producer, and requires the producer in an earlier wave — or
  in the SecurityStack foundation, which pre-exists every wave. Positive controls feed it
  doctored templates the CDK metadata never sees: later-wave, same-wave, orphaned, non-literal
  and deeply nested imports are each caught.
- Every new rule proven by deletion: the child tag condition (1 test), the governance-removal
  deny (1), the structured rendering collapsed to opaque hashes (1), the import collector
  blinded (1). Nothing was deployed, published or mutated.

## 2026-08-02 — Claude — #70 Slice B1 round 5: waves for the first deploy, the root API closed, semantics made reviewable

- Codex's round-5 review of f49481d7: a fresh tier could not prepare all four change sets (the
  consumers' Fn::ImportValue producers would be unexecuted — the tests had faked their way past
  it); the API Gateway policy still allowed unconditioned DELETE/PATCH on /apis/* — which
  includes every root API in the region, not just subresources; the digest bound plans whose
  security semantics the human could not SEE (no property values retrieved, principals rendered
  identically by design); and CREATE_COMPLETE was accepted without ExecutionStatus AVAILABLE, so
  an obsolete change set could be gated only to fail at execution. Three HIGHs, one MEDIUM.
  Fix-forward, all four reviewed commits preserved.
- The cloud gate (v3) now NAMES the reviewed plan group it authorizes, from a closed list:
  dependency WAVES for a fresh tier (Identity+Data → Api → Observability, each wave planned,
  reviewed and executed under its own gate) and the full set for steady state. A discovery test
  walks the REAL CDK assembly graph and refuses any cross-stack edge violating the wave order —
  a new import that would strand a fresh tier fails in the suite, not in the account.
- The API Gateway ROOT lifecycle is tag-confined: DELETE/GET/PATCH/PUT on /apis/* demand the
  Project/Environment resource tags, so a foreign API's root is unreachable whatever its id;
  subresource authority is now an ENUMERATED path list where every pattern carries a second path
  segment (a bare /apis/{id} is out of its reach), and a control asserts no unconditioned
  statement can address a root API. The residual shrank to foreign subresources under guessed
  ids — named, bounded, recorded.
- Review material carries SEMANTICS now: describes retrieve --include-property-values; the
  rendering names changed properties with before/after values and causing entities; and every
  identifier appears as a STABLE FINGERPRINT ([arn#a1b2c3d4]) — two principals are visibly
  different, a known principal is recognizable, and the log still never carries the identifier.
  The round-4 test that required identical renderings was inverted into the round-5 contract.
- An unexecutable change set (ExecutionStatus not AVAILABLE) never receives a digest, in either
  mode. Every new rule proven by deletion: group validation (1), AVAILABLE requirement (1),
  property-value retrieval (1), fingerprint rendering (1).
- Nothing was deployed, published or mutated. The lane stays inoperable pending the per-tier
  activation prerequisites in the workflow header; the runbook's step 12 now documents the
  wave-by-wave first deployment.

## 2026-08-02 — Claude — #70 Slice B1 round 4: the plan became change sets, the bootstrap split per tier

- Codex's round-4 review of 38f3adbf: the gate still did not authorize the executed plan (`cdk
  deploy` created a NEW change set over possibly different state, and the digest — computed after
  sanitization — collided for two plans differing only in an ARN principal, reproduced); the
  "second bootstrap" would have updated the existing CDKToolkit (no `--toolkit-stack-name`) and
  both tiers shared cdk-cbarel-* roles, so dev authority reached pilot; the execution policy
  allowed destructive operations on ALL apis/pools/keys in the region ("generated id" establishes
  no ownership); the gate could expire during the final STS call and still deploy; and the
  "strict" RFC3339 accepted calendar-invalid dates (2026-02-30 silently became March). Four
  HIGHs, one LOW. Fix-forward, all three reviewed commits preserved.
- THE PLAN IS THE CHANGE SETS NOW. `plan_only` prepares one NAMED CloudFormation change set per
  stack (the one moment change sets may be created) and digests the canonical UNREDACTED
  describes — immutable change-set ids, full change details, principals and all; sanitized output
  is presentation only, and the reproduced principal collision is a regression test. `deploy`
  spawns no cdk child at all: it re-describes exactly those change sets, requires the digest the
  gate names (a recreated set has a new id — PLAN_CHANGED), resolves the account FIRST and
  re-checks the window as the LAST operation before EACH execute-change-set, executes them in the
  reviewed dependency order under the tier's assumed bootstrap role, and reports partial progress
  honestly. CloudFormation itself refuses a change set whose stack moved after preparation.
- THE BOOTSTRAP SPLIT PER TIER: qualifiers `cbardev`/`cbarpil` (reviewed constants), separate
  toolkit stacks (`--toolkit-stack-name cba-release-toolkit-<env>` — without it the CDK would
  have updated the existing CDKToolkit), per-tier deploy-role boundaries, per-tier runtime
  boundaries, per-tier execution policies rendered from ONE parameterized template each — a dev
  rendering names not one pilot resource, and tests pin that both ways.
- OWNERSHIP IS TAGS, NOT ID SHAPE: Cognito and KMS statements demand Project/Environment tags —
  aws:RequestTag on create (the resource has no ARN yet), aws:ResourceTag on lifecycle — so
  PutKeyPolicy/ScheduleKeyDeletion/DeleteUserPool reach only this project's tier-tagged
  resources. The one residual is NAMED: API Gateway sub-resources are untaggable in the service
  model; below the tag-confined API creation, confinement is account+region+path only — recorded
  for Zamp's risk decision, account isolation documented as the alternative.
- The RFC3339 validation now round-trips through the calendar (2026-02-30, 2026-13-01, April 31
  and fractional seconds all refuse as malformed). Every new rule proven by deletion: plan-digest
  comparison (2 tests), per-mutation window re-check (2), unredacted-details digest (12),
  calendar round-trip (1), boundary account resolution (1).
- Nothing was deployed, published or mutated. The lane stays inoperable pending the four
  Zamp-gated activation prerequisites, now per tier, recorded in the workflow header.

## 2026-08-02 — Claude — #70 Slice B1 round 3: the authority chain closed end to end

- Codex's round-3 review found four HIGHs, all in the authority/execution chain of da550184:
  synth code received AWS credentials before the gate; the deployed CloudFormation execution role
  could not actually execute the four stacks (and would fail on the first real deploy); the deploy
  was not bound to the reviewed plan; the gate accepted loose date formats, had no TTL and was not
  revalidated at the mutation boundary. Fix-forward, both reviewed commits preserved.
- Credentials and project code never share a window now: synth runs credential-free BEFORE the
  OIDC consumer in all three credentialed jobs; after the consumer only `node
  bin/deploy-preflight.js` / `node bin/deploy-release.js` execute. A named lane invariant refuses
  npm/npx or any action step after credential acquisition — proven by mutation and by deletion.
- The execution authority exists and is enumerated: the four deployable stacks synthesize against
  their own bootstrap qualifier (`cbarel`, reviewed constant in lib/app.js), whose versioned
  execution policy covers every resource type the real templates create (a discovery test
  synthesizes both tiers and refuses unmapped types), scopes resources to the tier name prefixes,
  names each unavoidable wildcard as its own justified statement, pins `iam:CreateRole` to the new
  runtime boundary every release-created role carries, conditions PassRole to Lambda, and denies
  the GitHub/foundation roles outright. The SecurityStack keeps the #66 bootstrap; one execution
  role per blast radius. Runbook step 12 records the human-gated creation; the render loop now
  names all five templates.
- The deploy executes only the reviewed plan: `diff_only` emits PLAN_DIGEST (canonical, sanitized
  plan bytes); the deploy-mode gate NAMES that digest; a recomputed plan that differs — live state
  moved — refuses as PLAN_CHANGED and needs a fresh review. The plan is emitted before the effect.
  Gate v2 is strict RFC3339 UTC only (the reproduced `2099-01-01` and space-separated forms are
  malformed now), carries approvedAt + decisionId, caps the window at one hour, and is revalidated
  — expiry AND account — immediately before the deploy child spawns; a clock that crosses the
  expiry during the diff refuses one spawn from the effect, proven with an injected clock.
- Nothing was deployed, published or mutated. The lane stays inoperable pending the four
  Zamp-gated activation prerequisites now recorded in the workflow header.

## 2026-08-02 — Claude — #70 Slice B1 round 2: the effect closed, the authority delivered, the gate bound

- Codex's round-2 review found six issues in the first Slice B1 commit (74e3d889): `--all` scoped
  the effect to whatever the app contains; concurrency keyed on the SHA instead of the
  environment; the deploy authority neither designed nor canonical; raw CDK output leaking
  outputs/ARNs; no job time bounds; no binding between reviewed plan, release, assembly and Zamp's
  cloud authorization. Fix-forward, the reviewed commit preserved.
- The correction, architecture first: manifest v5 NAMES the effect (closed `target.stacks` =
  Api/Data/Identity/Observability, exact content and order; the entrypoint deploys it with
  `--exclusively`, `--all` is gone; SecurityStack and AiOrchestrationStack are classified excluded
  and a discovery test refuses any unclassified stack). The workflow lock is the literal
  `release-dev` group. The deploy authority exists in reviewed code: SecurityStack
  `GithubDeployRole`, trust pinned to `repo:...:environment:<env>`, boundary-pinned through the
  extended #66 exec policy, able ONLY to assume the three CDK bootstrap roles; published under the
  canonical `AWS_DEPLOY_ROLE_ARN`. Every job is time-bounded (5/15). Child output is captured and
  sanitized by shape (ARNs, URLs, pool ids, account digits). The entrypoint refuses without Zamp's
  per-release cloud gate — `CBA_CLOUD_GATE` naming the exact release and assembly digest with a
  `diff_only`/`deploy` mode and expiry — and puts the `cdk diff` plan on the record before any
  effect.
- Every new rule is proven to bite by deletion: the serialization, time-bound, canonical-secret
  and cloud-gate lane rules each fail their control when removed; the stack-set equality, the gate
  validation and the `--exclusively` construction each fail infra tests when reverted.
- The lane is NOT yet operable, on purpose: activation needs the human-gated SecurityStack
  redeploy, the dev Environment configuration (zero secrets/vars exist today, evidenced), and the
  per-release gate. Recorded in the workflow header and the #70 handoff. Nothing was deployed.

## 2026-08-02 — Claude — #70 Slice B1 assigned: the dev stage becomes the sanctioned AWS deploy

- Zamp assigned Slice B1 (code only): worktree `../cba-issue-70b`, branch
  `task/70-aws-dev-deploy-slice-b`, cut from `origin/main` at `95583e94`.
- The dev-stage placeholder is replaced by the sanctioned deploy: checkout pinned to the resolved
  release OID, npm ci, the pinned OIDC consumer with a NEW Environment-scoped secret
  (`AWS_DEV_DEPLOY_ROLE_ARN` — the deploy role never shares a name with the read-only preflight
  role), re-synth with the bound context, and `deploy-release.js` — which refuses unless HEAD is
  the release, the worktree is clean, the re-synthesized assembly reproduces the manifest digest,
  and the account matches at verify and immediately before the effect. `id-token: write` exists
  exactly where the consumer exists: the two preflights and dev-stage; the pilot placeholder stays
  token-free.
- Pilot promotion is MECHANICALLY blocked: `mode` offers only `dev_only`, so the pilot jobs (whose
  success expressions require `dev_then_pilot`) are unreachable. A named invariant refuses the
  option's return until O1/O2, the deployed smokes and the live SNS/KMS proof land — the
  reviewed-object diff alone would go silent on the promotion slice's legitimate edit.
- New named invariants: a job invoking the entrypoint must be Environment-bound, descend from its
  environment's preflight, and hold id-token plus the pinned consumer; raw deploy commands remain
  forbidden everywhere. Proven by mutation: deleting the promotion rule fails 1 test, deleting the
  entrypoint-obligations rule fails 2.
- No Cloudflare, no pilot deploy, no smoke in this parcel. Nothing was deployed producing it.

## 2026-08-02 — Claude — #106 delivered; all three #70 external prerequisites resolved

- #106 CLOSED (Done). All six high Dependabot alerts remediated by upgrade, zero risk acceptance:
  aws-cdk-lib 2.263.0 (bundles brace-expansion 5.0.8 — 2.262.2 was verified insufficient), postcss
  8.5.25 and sharp 0.35.3 via web `overrides` (next pins both), fast-uri 3.1.5 via npm update, plus
  a dev-only fix of the same advisory's 2.x line under `@node-minify/core`. Codex approved code and
  artifact with zero findings; Opus operated the artifact as PR #107; Zamp merged at
  `3583aedabcce88050137b27c0778631bd8752189` with all six CI lanes green including `quality (20)`,
  the Node 20 leg. GitHub closed the six alerts automatically; Dependabot PR #83 auto-closed as
  superseded; issue #106 closed by Opus under Zamp's instruction. Local cleanup done; remote branch
  preserved at the reviewed head.
- ENVIRONMENTS EVIDENCED: `/repos/:owner/:repo/environments` returns `dev` and `pilot`, BOTH with a
  custom deployment-branch policy whose only entry is `main`, and `pilot` with
  `required_reviewers: [marciozampiron]`. Every condition the #70 blocked-prerequisite section
  demanded is met; the evidence enters review with this reconciliation commit. The same API calls
  also returned the residual limitations, recorded rather than smoothed over:
  `can_admins_bypass: true` on both Environments and `prevent_self_review: false` on pilot — the
  binding satisfies the approved requirements but is not non-bypassable independent-human
  enforcement. The
  `release-pilot.yml` header disclosure was updated from "ungated" to the evidenced state — the
  invariant test pinning that disclosure was updated in the same commit, as designed.
- DOMAIN DECIDED: Zamp approved the pilot on the **`workers.dev`** origin, closing #67's open
  decision. Exact callback/logout URLs and the domain prefix become knowable; the values still
  enter only as Environment configuration at deploy time, never as tracked files.
- With all three prerequisites resolved, the next #70 slice may be assigned. Two moderate root
  alerts remain documented for a future SDK bump, outside any GO criterion.

## 2026-08-02 — Claude — #70 Slice A merged; local cleanup; Slice B blocked on external prerequisites

- Slice A approved by Codex across eight review rounds (findings summarized in the entries below),
  published as PR #104 under Zamp's execution authorization naming artifact digest `1cbe2f20…`, and
  merged by Zamp at `da0ed88ea01957401fe81ed8caf6d35dcb568311` with 6/6 CI checks green, `synth`
  included. Root gained its first declared direct dependency in this era: `yaml@2.9.0`, exact-pinned
  for the workflow validator.
- Local cleanup under Zamp's authorization: #70 worktree removed, local branch deleted with
  `git branch -d`, slice `/tmp` artifacts removed. The remote branch is PRESERVED at the reviewed
  head — a `gh` prompt claimed to delete it, but the live remote still carries it, verified by
  `ls-remote`. The #91 worktree was untouched. Local `main` fast-forwarded to the merge.
- Issue #70 stays OPEN; the handoff stays in `active/` because the later slices belong to it. The
  external prerequisites keep their stage-specific boundaries: the Environments block deploy-slice
  and deployment-gate approval, the #67 domain decision is what lets a pilot deploy preflight pass,
  and the 6 high Dependabot alerts block the pilot GO. Non-deploy implementation may proceed under
  normal assignment while they clear.
- No deploy, cloud mutation, secret operation or paid call.

## 2026-07-31 — Claude — #70 taken into active ownership; Slice A implemented for review

- #70 moved `inbox/` -> `active/` on Zamp's assignment, with its three `spec/authority-policy.json`
  references and the two `test/governance-model.test.js` path pins moved alongside. Worktree
  `../cba-issue-70`, branch `task/70-deploy-pipeline-slice-a`, cut from `origin/main` at `17b67c5`.
- Slice A implements the two binding conditions #69 registered against #70, plus the lane that
  enforces their ordering. **Nothing was deployed**: no AWS or Cloudflare call, no preview, no
  secret access, no paid call, and the lane contains no deploying command at all.
- `DEFAULT_AUTH_URLS` and the `authDomainPrefix` fallback moved from `identity-stack.js` into
  `context.js`, and the stack now reads them from there. A preflight with its own copy of the
  defaults can pass while the stack synthesizes something else — it would be measuring itself.
- PREFLIGHT-1 evaluates the EFFECTIVE URLs after context resolution and decides on the parsed
  hostname. Both choices are load-bearing: a misspelled context key leaves the default in place and
  looks exactly like an applied override, and `https://pilot.invalid.attacker.example` is a real
  resolvable origin that a substring rule would wave through as the placeholder.
- PREFLIGHT-2 requires the context KEY rather than a value, because the stack's fallback means a
  value always exists at synth time. It also requires confirmed regional uniqueness; a redeploy onto
  our own domain passes only when the expected pool id was supplied.
- The preflight is a separate JOB in `deploy-pilot.yml`, not a step: a step can be reordered, made
  `continue-on-error` or skipped by an `if:`, while a failed job in `needs:` stops the dependent job
  outright. Trigger is `workflow_dispatch` only, so a merge can never spend money unattended.
- Codex round 1 refused Slice A with four findings, all upheld. The code deployed nothing then and
  deploys nothing now; the FOUNDATION was what left room for a future deploy to bypass release
  identity, the preflight and the approval. Fixed in the second Slice A commit:
  - Release identity — the lane took `environment` and the auth URLs as operator inputs and never
    pinned `checkout`, so a manual run could deploy a tree that was never reviewed. Rebuilt to
    `deployed-environment-smoke-workflow-design.md` §1/§4: `release_sha` (40 hex, ancestor of live
    `main`), pinned checkouts, `mode` instead of an environment input, no URL inputs, and no dispatch
    path reaching pilot without a green dev stage.
  - Binding — a passing preflight proved SOME configuration was valid, not the deployed one. The
    preflight now emits a manifest digest over `{releaseSha, environment, boundContext}`, written
    only on a pass, and a deploying job must carry it. The same finding caught that `needs:` plus a
    permissive `if:` is not a gate: any `if:` replaces GitHub's default skip-on-failure, so
    `always()` AND `!cancelled()` let a failed preflight through. Every job now requires
    `result == 'success'`.
  - `expected_user_pool_id` was caller-supplied — whoever can name "our" pool redefines which
    existing domain a deploy adopts. It now comes only from environment state.
  - Leakage — role ARN moved to a secret, `mask-aws-account-id: true` set, and every failure is now
    a code plus a field name. AWS stderr, the owning pool id, supplied URLs and the prefix never
    reach the output; a poison-value suite proves it.
- BLOCKED PREREQUISITE recorded: the repository has **zero configured GitHub Environments**
  (`total_count: 0`, read-only check). An Environment named in a workflow but never configured is
  created on first use with no reviewer and no branch restriction, so Slice A's first draft described
  a gate that does not exist. The `environment:` keys are the binding, not the control. `dev` and
  `pilot` must be configured under a separate Zamp-authorized settings change, with read-only
  evidence, before any deploy slice or deployment gate is approved.
- Codex round 2 refused the fix with two findings, both upheld and both reproduced before fixing:
  - The release identity was still a name. `[0-9a-f]*` validates ONE character — "a"+39×"Z" passed
    the committed check — and checkout ran before validation, so a 40-char branch name could be
    blessed and then moved. Now shape is checked over all 40 characters before any git call, the
    identity job checks out `main` and never the candidate, the object must be a commit that
    resolves to itself and is an ancestor of live main, and only the RESOLVED OID is emitted. The
    script is executed in tests against a stubbed git; the refusals are observed, not inferred.
  - The binding was nominal and the guard checked substrings: `echo "$CONTEXT_DIGEST"; cdk deploy
    --all`, `|| true`, an OR accepting `failure` and a rogue pilot job all passed the old
    invariants. The digest now covers release, environment, REGION and TARGET ACCOUNT (us-east-1 vs
    us-west-2 proven distinct, accounts too); a purpose-built `verify-manifest --recompute` replaces
    textual presence; and the invariants validate the DAG with pinned exact success expressions and
    a closed grammar. Every reproduction is a named regression.
- Codex round 3 refused again with six reproductions, five confirmed in memory before fixing: with
  verification and deployment as separate commands, a job could verify a safe context and deploy a
  different one, swap credentials in between, or verify an AWS manifest and deploy a Cloudflare
  target — all invisible to any textual ordering rule; and a manifest with `boundContextKeys: []` or
  a `preflight` block claiming a FAILURE verified cleanly, because the nested schema was open. Fixed
  by construction, not by another heuristic: `bin/deploy-release.js` is the one sanctioned
  deployment entrypoint — verify and deploy in ONE process, deploy arguments derived from the very
  context object verified, account re-resolved immediately before the effect (swap -> refusal), no
  code path to any service but `cdk` — and raw deploy commands are forbidden everywhere in the lane.
  The nested manifest schema is closed all the way down, with each forgery a named regression. The
  branch-policy prerequisite now covers BOTH Environments: dev without a main-only policy hands its
  secrets to a workflow definition from any branch.
- Codex round 4 refused with four findings, all upheld: the manifest SHA was compared to an
  ARGUMENT while the deploy shipped whatever was on disk (reproduced with HEAD at a different
  commit); the verified region was never applied to the child, so ambient AWS_REGION could redirect
  the deploy within the account; `verb=deploy; npx cdk "$verb"` walked past the raw-deploy verb
  regex; and only three of nine deploy-sensitive context keys were bound — changing githubTrustSub
  or corsAllowedOrigins left the digest identical. Fixed: the entrypoint requires HEAD == release
  with a clean worktree and deploys the preflight-synthesized assembly by digest via `--app`; the
  region is imposed on the child env (all three variables); the workflow invariants became a closed
  WHITELIST of step shapes (exact actions + byte-identical run templates), replacing the blacklist;
  and `DEPLOY_CONTEXT_KEYS` is the closed nine-key contract with a discovery test that refuses any
  context read not on it. Every reproduction is a named regression, and each new binding was proven
  to bite by mutation.
- Codex round 5 refused with three findings, all upheld (two reproduced before fixing): the
  assembly digest covered only root templates — mutated Lambda bytes and asset manifests kept the
  digest identical — and the entrypoint reopened the original mutable path after verification; the
  action allowlist accepted a swapped secret, a deleted aws-region and arbitrary extra inputs; and
  `this.node.tryGetContext('x')` walked past the discovery scanner. Fixed: recursive digest over
  every regular file with symlinks refused, deploy from a private snapshot digested AFTER copying
  (`--app` never points at the original), exact per-action `with:` schemas with no extra step
  properties, `tryGetContext` confined to the central helper, literal-key enforcement, bidirectional
  discovery and runtime refusal of unlisted keys. The tightened scanner immediately caught a key the
  manual inventory missed — `bedrockRefreshBoundaryArn`, an IAM boundary ARN — which joined the
  contract (now ten keys). Every reproduction is a named regression; each binding proven by mutation.
- Codex round 6 refused with five findings, all upheld (the two digest ones reproduced first): the
  assembly digest framing was NOT injective — two different trees, one with the delimiter sequence
  inside a file's content, digested identically; run steps had no closed schema, so NODE_OPTIONS
  smuggled into a reviewed step's env executed arbitrary Node under the approved command text;
  third-party actions were pinned to mutable major tags; the digest ignored file modes; and
  snapshots leaked on refusal paths. Fixed: JSON-canonical injective digest (per-file record with
  path, type, git-normalized mode, size and content sha256), run steps validated as whole closed
  objects (step keys + exact env), all eleven uses: pinned to full commit SHAs (peeled where the tag
  is annotated) with the pin rule's error demanded specifically by its regression, and one
  try/finally owning the snapshot on every path. Fixing round 6 exposed a hole of my own: the
  step-shape loop sat inside the per-job loop that SKIPS global-preflight, so the identity job's
  steps were never shape-checked — a mutable checkout tag there returned zero errors. The loop is
  standalone now, over every job.
- Codex round 7 refused with one finding that names the pattern behind rounds 2-6: the workflow
  validator parsed a different language than the consumer. A quoted sixth job carrying id-token:
  write and a remote reusable workflow was real to YAML and invisible to the regex parser (five
  jobs, zero errors — reproduced); quoted env keys, quoted action inputs and job-level
  env/container were equally invisible. The regex parser was deleted, not extended: yaml@2.9.0 is
  now a direct exact-pinned devDependency, the workflow is parsed once with duplicate-key rejection,
  and the authoritative check is deep equality against a frozen reviewed object, with semantic
  guards running on the same parsed object. Every payload is a named regression that first proves
  the payload ACTIVE under YAML and then proves the refusal.
- Codex round 8 refused with one MEDIUM, upheld: the placeholder stages held id-token: write with
  no OIDC consumer — checkout, Node and manifest verification need no token, and the permission
  lets every action and lifecycle script in the job mint an Environment-bound one. Removed from
  both stages (reviewed object included); OIDC authority is now a semantic rule — id-token: write
  only where the exact pinned configure-aws-credentials action is present — with a regression that
  demands the rule's own error so it stays discriminating even after a deliberate reviewed-object
  edit. Round 7 was confirmed closed in the same review.
- Three of my own guards had to be corrected while writing them, each a variant of the same mistake
  — checking text instead of structure. A substring sweep flagged `--output` because it contains
  "put"; a comment describing `cdk deploy` read as a deploy; and the workflow job parser used `$`
  without the `m` flag, so it never split the file and every per-job rule was vacuously true. The
  last one is recorded because it passed while the property it guards was broken.

## 2026-07-30 — Claude — #75 closed, documents reconciled, #70 is next

- #75 CLOSED (Done). Codex reviewed the code and the artifact, Zamp sent a `HUMAN_GATE_GRANTED`
  naming artifact digest `c17b32bb…`, the work was published as PR #101, and Zamp merged it at
  `dcb868d2b9def97598c35500896d6abe50d3d0a1`. CI green on the pull request and after the merge
  across Quality, Web Quality, Infra Synth and CodeQL.
- Handoff moved `active/75-smoke-cleanup-contract.md` -> `done/75-smoke-cleanup-contract.md`, and
  its Status section rewritten from "awaiting review and publication" to the delivered outcome.
- `spec/authority-policy.json` moved with it. The policy is closed on exact paths, so the rename
  alone left the governance suite at 344/360 — 16 failures, all traceable to the three stale
  references in `governedSurfaces`, `surfaceClassification` and `allowedAuthorityStatements`. Same
  lesson as the #82 close on 2026-07-28: a handoff rename is never a rename of one file.
- PROCESS: the initial local attempt was made by Gemini, which holds no collaboration, publication
  or governance role in this repository. That attempt was NOT accepted: it was never committed, and
  it left the governance suite red. Opus performed the valid reconciliation on the isolated branch
  `task/75-governance-closeout`, and Codex reviews the result read-only. Worth recording because the
  closed policy is what caught it, not a human reading the diff.
- Local cleanup after the merge, authorized by Zamp: #75 worktree removed, local branch deleted with
  `git branch -d`, and the #75 scope, gate and both publication artifacts removed from `/tmp`. The
  remote branch `task/75-smoke-cleanup-contract` was preserved. The #91 worktree was not touched.
- ACTIVE-HANDOFF AUDIT against GitHub issues and the board, to stop an ownership collision before
  #70 opens. `active/` now holds exactly one owner, #91:
  - #91 OPEN, Stage B not built, own worktree — preserved untouched.
  - #67 -> `done/`. The in-repo delivery is merged (PR #100) and issue #67 stays OPEN, but nothing
    implementable remains in the repository. An active handoff that owns the same files would have
    blocked #70 from opening; the remaining scope moved to `inbox/70-*` instead.
  - #75 -> `done/`, CLOSED, delivered in PR #101.
  - #85 -> `done/`, CLOSED, its three canonical documents on `main`, no agent or worktree holding it.
  - #93 -> `done/`, CLOSED. Held back for one commit because `src/lib/authority-policy.js`,
    `test/governance-model.test.js` and `spec/authority-policy.json` hard-code its path. Codex named
    that inversion correctly — real state must drive the guard, not the reverse — so all three moved
    with the file, and a new control asserts the `done/` path and refuses the `active/` one.
- `inbox/70-cloudflare-aws-deploy-pipeline.md` created for the next work, owned by nobody until Zamp
  assigns an executor. It inherits #67's account-level half, the AWS deploys of the synth-only
  stacks, the live SNS/KMS notification proof and the deployed smoke lane — and states explicitly
  that it must not re-open PR #100's or PR #101's merged scope.
- Dependabot reported 8 alerts on the default branch (6 high, 2 moderate) during the #75 push. Not
  triaged, no upgrade attempted; the 6 high are a pilot-GO prerequisite.

## 2026-07-28 — Claude — #82 closed, #67 Stage B opened

- #82 CLOSED (completed) with all three slices on `main`; Roadmap board item confirmed Done.
  Slice B: PR #98, merge `2d8ab134c9c2f1f0a5944a1c756bdf200e4e01c0`. Slice C: PR #99, merge
  `2f9ee8efb97c9e1612eea31c16ab6b18e146fea1`. CI green on `main` at `2f9ee8e` for `quality (20)`,
  `quality (22)`, `Analyze (actions)` and `Analyze (javascript-typescript)`.
- `infra-synth` and `web-quality` are path-filtered and did not trigger on the Slice C merge, which
  touches no `infra/aws/**` or `web/**` path. Both were run locally on that commit: infra/aws
  99/99 and credential-free `cdk synth` OK for `dev` and `pilot`.
- Recorded on the issue that the live SNS/KMS notification-path proof is NOT closed by #82 and
  remains a separate pilot-promotion gate under #70.
- Handoffs reconciled: `active/82-*` moved to `done/`, `inbox/67-cloudflare-opennext-stage-b.md`
  moved to `active/`. `spec/authority-policy.json` updated so the governed-surface paths follow
  the files — the policy is closed on those paths, so a move without it fails the suite.
- Local cleanup: worktree `cba-issue-82c` removed, branch `task/82-observability-slice-c` deleted
  with `git branch -d` (no force), and the expired #82 scope/gate/publication artifacts removed
  from `/tmp`. The #91 worktree was not touched.
- No push, deploy, cloud mutation or paid call.


## 2026-07-25 — Codex post-push validation — #69 closed and Done

- Independently confirmed `HEAD == origin/main == 961af51`, no unpublished commits, and no active
  handoff. #69 is CLOSED and its Roadmap project item is explicitly Done.
- Confirmed all four required lanes green on the published SHA: Quality `30183327735`, Web Quality
  `30183327721`, Infra Synth `30183327736`, and CodeQL `30183327600`.
- Confirmed the handoff is in `done/69-cognito-cors-boundary.md` and no AWS/Cloudflare deployment
  occurred. SecurityStack remains the only deployed project stack.
- Corrected one local governance nit: the earlier CURRENT block still said “unpublished/push gate”;
  it now reflects the published, closed, CI-green, synth-only terminal state. No commit/push made.

## 2026-07-25 — Push + CI (Claude) — #69

- Pushed: `97df6c1..961af51` (three commits: `6d588d4` Slice A identity foundation + JWT
  authorizer, `b91d2ca` Slice B neutral principal + /api/me, `961af51` Slice C session UI +
  proven PKCE S256). `origin/main` is now at `961af51`.
- CI green on ALL FOUR lanes: Quality (30183327735), Web Quality (30183327721 — the new "Web
  unit tests (offline PKCE S256 proof)" step ran in the lane), Infra Synth (30183327736),
  CodeQL (30183327600).
- #69 CLOSED with delivery evidence; board moved to Done explicitly (the `[Task]` issue is not
  a native sub-issue, so the close did not move it automatically — future `[Task]` closes need
  the same manual board step).
- Security posture published: deployed runtime accepts ONLY Cognito access tokens
  (token_use=access; ID tokens rejected), `x-cba-learner` refused, missing bearer fails closed,
  every route JWT-protected except public readiness, CORS remains an exact-origin seam.
- NO AWS or Cloudflare deploy: everything stays synth/test-only. The `pilot.invalid` +
  Cognito-domain preflight is registered on #70.
- Remaining #46 sequence: #67 Cloudflare frontend, then #79, #75, #82 -> #70 -> close #46/#68.
- Local residue: this cycle's gate/record entries + handoff move + `.vscode/` + the #82 and
  #10 documents owned by other tracks (deliberately untouched).

## 2026-07-26T01:41:59Z — agent-refresh --record

- Status: ok
- Git: ## main...origin/main [ahead 3]
- Unpublished commits:
  - 961af51 feat: add learner sign-in session UI with proven PKCE S256 flow for #69
  - b91d2ca feat: map Cognito access tokens to neutral principals and add /api/me for #69
  - 6d588d4 feat: add Cognito identity foundation and JWT authorizer boundary for #69
- Active handoffs:
  - .agent-handoff/active/69-cognito-cors-boundary.md
- Warnings:
  - active handoff file(s) present: .agent-handoff/active/69-cognito-cors-boundary.md
- Errors: none

## 2026-07-25 — Human gate (push approved) — #69

- Human gate: approved push for EXACTLY three commits: `6d588d4` (Slice A — IdentityStack
  Cognito pool + PKCE-ready public client + API Gateway JWT authorizer), `b91d2ca` (Slice B —
  neutral principal from authorizer-validated claims, access-token-only, Cognito adapter,
  /api/me §16 with cached profile) and `961af51` (Slice C — learner sign-in/session/sign-out UI,
  central session gate bound to the validated pathname, proven PKCE S256, apiFetch bearer).
  All three Codex review rounds folded in (A: 1 blocker; B: 2 blockers + textual amend; C: 4 +
  2 findings).
- Agent will run `agent-refresh -- --record`, push only these commits, follow Quality, Web
  Quality (now runs the new web unit tests), Infra Synth and CodeQL; on green, close #69 and
  confirm board Done. NO AWS or Cloudflare deploy — synth/test only remains the rule.

## 2026-07-25 — Human gate — #69 three-commit stack push approved

- Human explicitly approved push of exactly: Slice A `6d588d4`, Slice B `b91d2ca`, and final
  Slice C `961af51`. Codex technical gate is approved with no remaining blockers.
- Executor must run `npm run agent-refresh -- --record` immediately before push, confirm these are
  the only unpublished commits, push them, and monitor Quality, Web Quality, Infra Synth, and CodeQL.
- With all four lanes green, close #69 with evidence and confirm Board Done. This gate authorizes
  no AWS/Cloudflare deploy, resource mutation, or real-user creation; deployment remains #70.

## 2026-07-25 — Codex final re-review — #69 technical gate approved

- Approved the complete unpublished stack: Slice A `6d588d4`, Slice B `b91d2ca`, and final
  Slice C `961af51`; no remaining technical blockers found.
- Confirmed pathname-bound readiness prevents stale route results from mounting protected pages;
  cleanup discards late async results. Auth failures remain explicit and both OIDC stores are
  session-scoped.
- Web suite is now 14/14 with dev/Cognito/error/route-transition/storage regressions and the
  static no-direct-fetch guard; production build clean. BFF 125/126 (+1 expected skip), direct
  fetch inventory and diff checks clean; infra/root unchanged from approved 57/57 and 77/77.
- Approval posted to #69. Stack is ready only for a separate human push gate; after push require
  Quality, Web Quality, Infra Synth, and CodeQL green. No deploy or AWS/Cloudflare mutation authorized.

## 2026-07-25 — Codex re-review — #69 Slice C still blocked

- Confirmed the amend closes three original findings: all learner API calls use `apiFetch`, auth
  errors no longer become fake dev state, and OIDC `stateStore` plus `userStore` are session-scoped.
- Found a route-transition race in `AuthGate`: stale `ready` survives the render preceding the
  pathname effect, so protected children can mount and call APIs before the current route/session
  is validated. Required pathname/generation-bound readiness.
- Confirmed `95fa3d7..b64facd` adds no web test changes. The web suite remains four PKCE tests;
  required dev/signed-out/signed-in/error/route-transition regressions, runtime-store assertion,
  and static no-direct-learner-fetch CI guard are absent.
- Independent baseline: web 4/4 + production build, BFF 125/126 (+1 expected skip), direct learner
  fetch grep zero, diff checks clean. Findings posted to #69; no push or deploy authorized.

## 2026-07-25 — Codex review — #69 Slice C blocked pending amend

- Independent validation passed: web unit 4/4, BFF 125/126 (+1 expected skip), infra 57/57,
  root 77/77, production web build, bank 60/0, and diff checks.
- Found two protected learner reads still using raw `fetch`, so mock resume and missed review
  fail with 401 in Cognito mode. Required `apiFetch` migration plus a static no-direct-API-fetch
  guard.
- Found auth failures downgraded to dev and no central signed-out session boundary; deployed
  misconfiguration can render “Hello, Learner” while learner pages issue unauthenticated calls.
  Required explicit unavailable/signed-out states and focused auth-mode regressions.
- Confirmed `oidc-client-ts` defaults an omitted PKCE `stateStore` to `localStorage`; runtime must
  explicitly use the session-scoped store for both OIDC state and user data.
- Findings posted to #69. Slices A/B remain approved; no push, deploy, or Cloudflare/AWS mutation
  authorized.

## 2026-07-25 — Codex re-review — #69 Slice B runtime gate approved

- Independently confirmed fail-closed 401 for valid claims without bearer and winner re-read for
  concurrent first-profile creation; BFF 125/126 (+1 expected skip), syntax and diff checks green.
- One required text-only amend remains before Slice C: replace the false “UserInfo at most once
  per learner” claim in the profile comment, handoff work log, and commit body. Concurrent first
  requests may both call UserInfo; the actual guarantee is one canonical stored profile and no 409.
- After that exact amend, Slice C is authorized without another code review. No push or deploy
  authorized. Review result posted to #69.

## 2026-07-25 — Codex review — #69 Slice B blocked before Slice C

- Independent validation passed: BFF 123/124 (+1 expected skip), infra 57/57 + clean synth,
  web build, syntax, and diff checks.
- Reproduced a fail-open profile bootstrap: Cognito access-token claims without an Authorization
  bearer returned 200 and persisted a local `.invalid` profile. Required result is 401 and no
  write.
- Reproduced concurrent first-profile creation over two DynamoDB adapter instances: one success
  plus one `RepositoryConflictError`. Bootstrap must re-read the winner instead of exposing 409.
- Findings and required regressions posted to #69. Broader principal/error/repository layering
  remains tracked by the post-POC #10 DDD gate; no push, deploy, or Slice C authorization.

## 2026-07-25 — Architecture decision (Codex) — post-POC multi-certification portal gate

- Confirmed #10 / Phase 5 as the existing roadmap owner; no duplicate epic created.
- Documented that the CBA POC remains pragmatic and CBA-first. Before the first non-CBA
  certification, the portal must pass a DDD hardening review covering explicit certification
  partitioning, data-only principals, neutral application ports/errors, adapter separation,
  explicit composition, and cross-certification isolation tests over at least two fixtures.
- The review may be pulled into the POC only for security, learner isolation, deterministic
  scoring, provenance, or publish-gate risk. No #69 implementation file, commit, deploy, or push
  was changed or authorized by this documentation task.

## 2026-07-25 — Architecture decision (Codex) — AWS observability baseline #82

- Created #82 as a native #46 sub-issue; added it to Roadmap / Phase 1 / Todo. Updated #70 so
  pilot deploy/promotion depends on the O1 structural and O2 post-smoke alarm-health gates.
- Added the canonical `docs/architecture/aws-observability-baseline.md` and pointers in the IaC
  foundation, Architecture wiki, #55 runbook, and #56 workflow design. Operational telemetry is
  explicitly separate from learner analytics (#18).
- Baseline: explicit 7d dev / 30d pilot log retention, strict field allowlists, no learner/exam/
  auth data in logs, native API/Lambda/DynamoDB alarms, dashboard, SNS notification path, and a
  project budget only after cost-allocation-tag activation. No AWS deploy or AI spend authorized.
- #69 Slice A independent review: infra 56/56 and synth succeeds, but the synth is not warning-free.
  Blocked Slice B pending an explicit `-cdk/core:defaultCrossStackReferences=strong` flag and
  test. Binding Slice B rule posted to #69: access-token-only API; Cognito UserInfo enrichment stays
  in the infrastructure adapter and only a sanitized neutral principal/profile crosses inward.
- Architecture docs are intentionally uncommitted while the executor-owned #69 commit remains
  unpublished/amendable; do not push them as part of #69 without a separate human gate.

## 2026-07-25 — Push + CI (Claude) — governance cleanup pós-#78

- Pushed: `a31294c..97df6c1` (docs-only governance reconciliation). `origin/main` is now at
  `97df6c1`.
- CI green: Quality (30175316497), CodeQL (30175316494). Web Quality/Infra Synth correctly did
  not trigger (path filters, docs-only change).
- Next: #69 active handoff opened; Slice A starts (IdentityStack + Cognito public client/PKCE +
  API Gateway JWT authorizer) — synth/test only, NO AWS or Cloudflare mutation.
- Local residue: this cycle's gate/record entries + the #69 active handoff + `.vscode/`
  (pending decision).

## 2026-07-25T21:16:31Z — agent-refresh --record

- Status: ok
- Git: ## main...origin/main [ahead 1]
- Unpublished commits:
  - 97df6c1 docs: reconcile handoff state after #78 publication
- Active handoffs: none
- Warnings: none
- Errors: none

## 2026-07-25 — Human gate (push approved) — governance cleanup pós-#78

- Human gate: approved push for EXACTLY one commit: `97df6c1 docs: reconcile handoff state
  after #78 publication` — EVENTS.md cycle records, CURRENT.md reconciliation (DataStack/
  ApiStack implemented but synth-only; identity/ai-orchestration/observability placeholders),
  handoff #78 moved to done/ with full terminal state (push SHAs, four CI ids, CLOSED/Done,
  NO AWS deploy, smoke-isolation follow-up). Codex technical gate passed with no findings.
- Agent will run `agent-refresh -- --record`, push only this commit, follow Quality + CodeQL
  (Web Quality/Infra Synth path filters don't match docs-only), record the result, then open
  the #69 active handoff and start Slice A (IdentityStack + Cognito public client/PKCE + JWT
  authorizer, synth/test only). NO AWS or Cloudflare mutation authorized.

## 2026-07-25 — Push + CI (Claude) — #78

- Pushed: `626b715..a31294c` (two commits: `bf9bd35` Lambda transport adapter + `a31294c`
  ApiStack Lambda/HTTP API). `origin/main` is now at `a31294c`.
- CI green on ALL FOUR lanes: Quality (30174652258), Web Quality (30174652262), Infra Synth
  (30174652330 — new "Install BFF bundling toolchain" step ran, real esbuild bundling in the
  lane, 40/40), CodeQL (30174651870).
- #78 CLOSED with delivery evidence; board Done (confirmed). The #77 architecture decision is
  closed out: the BFF runtime role now carries the least-privilege table grants (item CRUD on
  the exact table ARN; Query only on the exact gsi1 index ARN).
- Deployed-runtime posture published: fail-closed CBA_WEB_AUTH=cognito until #69; CORS only as
  an exact-origin seam; readiness health-gated (ready/adapter/runtimeEnv); canonical BASE_URL
  HTTP runner ready for #70. Handoff finalized in `done/78-lambda-api-gateway-bff.md`.
- Follow-up registered: per-run state isolation for local smokes (fixed learners vs persistent
  `.data` store) — candidate for #75 or a chore issue.
- Remaining #68 sequence: #67/#69 in parallel; then #79, #75 -> #70 -> close #46/#68.
- Local residue: this cycle's gate/record entries + handoff move + `.vscode/` (pending
  decision) — next governance cleanup.

## 2026-07-25T20:57:52Z — agent-refresh --record

- Status: ok
- Git: ## main...origin/main [ahead 2]
- Unpublished commits:
  - a31294c feat: publish BFF via Lambda + HTTP API with explicit routes and minimal IAM for #78
  - bf9bd35 feat: add the Lambda transport adapter for the Web BFF (#78)
- Active handoffs:
  - .agent-handoff/active/78-lambda-api-gateway-bff.md
- Warnings:
  - active handoff file(s) present: .agent-handoff/active/78-lambda-api-gateway-bff.md
- Errors: none

## 2026-07-25 — Human gate (push approved) — #78

- Human gate: approved push for EXACTLY two commits: `bf9bd35 feat: add the Lambda transport
  adapter for the Web BFF (#78)` and `a31294c feat: publish BFF via Lambda + HTTP API with
  explicit routes and minimal IAM for #78` — pure v2 transport + recursive-allowlist
  deployed-contract suite (primitive-only leaves) + readiness health gate + canonical BASE_URL
  HTTP runner (CI-skip, no network); ApiStack with 13 explicit routes, minimal DynamoDB IAM
  (item CRUD on the exact table ARN, Query on the exact gsi1 index ARN), fail-closed
  CBA_WEB_AUTH=cognito, CORS as an exact-origin #69 seam, reproducible bundling (SDK 3.1095.0,
  audit clean). Both Codex review rounds folded in (five blockers total, all verified fixed).
- Agent will run `agent-refresh -- --record`, push only these commits, follow Quality, Web
  Quality, Infra Synth (now installs the bff toolchain and watches services/bff + bundle
  inputs), and CodeQL; on green, close #78, confirm board Done, finalize the handoff. NO AWS
  deploy — synth-only stays the rule.

## 2026-07-25 — Push + CI (Claude) — #77

- Pushed: `f61f468..626b715` (two commits: `d430722` async port/composition + `626b715` DynamoDB
  adapter + DataStack). `origin/main` is now at `626b715`.
- CI green on ALL FOUR lanes: Quality (30173071870), Web Quality (30173071878 — bff harness
  77/77 in the lane), Infra Synth (30173071913 — 34/34), CodeQL (30173071645).
- #77 CLOSED with delivery evidence; board Done (confirmed). Architecture decision recorded on
  the issue: the DataStack creates zero IAM — least-privilege table grants for the BFF runtime
  role belong to #78. Handoff finalized in `done/77-dynamodb-repository-data-stack.md`.
- Remaining #68 sequence: #78 (Lambda/API Gateway adapter + runtime role/grants + SDK bundling)
  alongside #67/#69; then #79, #75 -> #70 -> close #46/#68.
- Local residue: this cycle's gate/record entries + `.vscode/settings.json` (pending decision) —
  next governance cleanup.

## 2026-07-25T20:11:02Z — agent-refresh --record

- Status: ok
- Git: ## main...origin/main [ahead 2]
- Unpublished commits:
  - 626b715 feat: add DynamoDB simulation repository adapter and real DataStack (#77)
  - d430722 feat: make the simulation repository port and use cases async (#77)
- Active handoffs:
  - .agent-handoff/active/77-dynamodb-repository-data-stack.md
- Warnings:
  - active handoff file(s) present: .agent-handoff/active/77-dynamodb-repository-data-stack.md
- Errors: none

## 2026-07-25 — Human gate (push approved) — #77

- Human gate: approved push for EXACTLY two commits: `d430722 feat: make the simulation
  repository port and use cases async (#77)` and `626b715 feat: add DynamoDB simulation
  repository adapter and real DataStack (#77)` — async port + composition seam +
  CBA_RUNTIME_ENV fail-fast; mock-first DynamoDB adapter (per-read-object optimistic tokens,
  paginated GSI listing, atomic claim, no Scan); logical readiness; real DataStack (closed
  dev|pilot environment set, pilot durable / dev disposable, zero IAM); both Codex review rounds
  folded in.
- Agent will run `agent-refresh -- --record`, push only these commits, follow Quality, Web
  Quality (bff harness now 77 tests in the lane), Infra Synth (34 tests + new DataStack), and
  CodeQL; on green, close #77 recording that IAM grants belong to #78 per the architecture
  decision, and confirm board Done.

## 2026-07-25 — Push + CI (Claude) — #80

- Pushed: `25db998..f61f468` (`f61f468 fix: own the Next server process group in the
  restart-persistence smoke (#80)`). `origin/main` is now at `f61f468`.
- CI green: Quality (30171615080), Web Quality (30171615081 — the corrected smoke itself ran
  green in the lane), CodeQL (30171614971).
- #80 CLOSED with delivery evidence; board Done (confirmed). Handoff in
  `done/80-restart-persistence-smoke.md`.
- Remaining #68 sequence: #77 (DynamoDB repository adapter + DataStack) -> #78 (Lambda/API
  Gateway), alongside #67/#69; then #79, #75 -> #70 -> close #46/#68.
- Local residue: this cycle's gate/record entries + `.vscode/settings.json` (pending decision) —
  next governance cleanup.

## 2026-07-25T19:26:50Z — agent-refresh --record

- Status: ok
- Git: ## main...origin/main [ahead 1]
- Unpublished commits:
  - f61f468 fix: own the Next server process group in the restart-persistence smoke (#80)
- Active handoffs: none
- Warnings: none
- Errors: none

## 2026-07-25 — Human gate (push approved) — #80

- Human gate: approved push for ONLY `f61f468 fix: own the Next server process group in the
  restart-persistence smoke (#80)` — direct process-group ownership (no npx), fail-fast on an
  occupied port, verified exit + port closure before boot 2, distinct-pid assertion, try/finally
  cleanup with ownership kept until exited && closed, host pinned to 127.0.0.1 everywhere; both
  Codex review findings folded in; architect approval recorded on #80.
- Agent will run `agent-refresh -- --record`, push only this commit, follow Quality/Web
  Quality/CodeQL, record the result, close #80 on green, and confirm board Done. EVENTS.md,
  `.vscode/`, and every other residue stay OUT of the push scope.

## 2026-07-25 — Push + CI (Claude) — governance + #76

- Pushed: `30d8eee..25db998` (two commits exactly: `615e9eb` governance docs-only + `25db998`
  #76 BFF service). `origin/main` is now at `25db998`.
- CI green: Quality (30171060326), **Web Quality (30171060318) — FIRST real CI run of the BFF
  contract harness (12/12) plus build and all four smokes** (restart-persistence green in CI,
  confirming the orphan-port issue is local-only, tracked by #80), CodeQL (30171060220).
- #76 CLOSED with delivery evidence; board Done (confirmed). Handoff in
  `done/76-bff-service-contract-harness.md`.
- Next (#68 slices): #77 DynamoDB repository adapter + DataStack -> #78 Lambda/API Gateway;
  alongside #67 (frontend) and #69 (Cognito, incl. /api/me); Preferences #79; smoke lifecycle
  #80; then #75 -> #70 -> close #46/#68.
- Local residue: this cycle's gate/record entries + `.vscode/settings.json` (pending decision) —
  next governance cleanup.

## 2026-07-25T19:09:39Z — agent-refresh --record

- Status: ok
- Git: ## main...origin/main [ahead 2]
- Unpublished commits:
  - 25db998 feat: extract provider-neutral Web BFF service with contract harness (#76)
  - 615e9eb docs: reconcile handoff state and audits after the #55/#56 design track
- Active handoffs: none
- Warnings: none
- Errors: none

## 2026-07-25 — Human gate (push approved) — governance + #76

- Human gate: approved push for EXACTLY two commits: `615e9eb docs: reconcile handoff state and
  audits after the #55/#56 design track` (governance, docs-only) and `25db998 feat: extract
  provider-neutral Web BFF service with contract harness (#76)` (services/bff boundary, async
  public contract, delegating Next routes, offline harness, Web Quality wiring; all Codex review
  cycles folded in; architect approval recorded on #76).
- Agent will run `agent-refresh -- --record`, push only these commits, follow Quality, Web
  Quality (first real CI run of the BFF harness — services/bff paths now trigger the lane), and
  CodeQL, record the result, close #76 on green, and confirm board Done.
- `.vscode/` and every other local residue stay OUT.

## 2026-07-25 — Governance cleanup (Claude) — pre-#76

- Dedicated docs-only commit folding the audit residue accumulated since `3f9f3b5`: the #55
  (release runbook) and #56 (smoke workflow blueprint) delivery cycles — gates, pushes, CI
  results, review rounds — plus their execution logs `done/55-pilot-release-runbook.md` and
  `done/56-deployed-environment-smoke-workflow-design.md`.
- `CURRENT.md` reconciled: #55/#56 recorded as CLOSED/Done with their published SHAs and the
  downstream decisions (#67 runtime config, #68 readiness evidence, #75 cleanup contract); next
  sequence now starts at the #68 implementation slices (#76 -> #77 -> #78, alongside #67/#69).
- `.vscode/settings.json` deliberately left OUT (pending human share-or-ignore decision).
- Local commit only; push follows the human gate. #76 execution starts after this cleanup.

## 2026-07-25 — Push + CI (Claude) — #56

- Pushed: `cde0c8c..30d8eee` (`30d8eee docs: design deployed-environment smoke workflow
  blueprint for #56`). `origin/main` is now at `30d8eee`.
- CI green: Quality (30169558834) and CodeQL/Push on main (30169558546). Web Quality + Infra
  Synth correctly did not trigger (docs-only).
- #56 CLOSED with delivery evidence; board Done (confirmed). Handoff finalized in
  `done/56-deployed-environment-smoke-workflow-design.md`.
- The #50 design track is complete (#55 runbook + #56 blueprint). Next per CURRENT.md:
  #67/#68/#69 (with the runtime-config decision on #67, #68 readiness evidence, #75 cleanup
  contract as flagged dependencies) -> #70 -> close #46. Product: #44 -> #57 -> #62.
- Kept as local audit residue for the next governance cleanup.

## 2026-07-25T18:24:20Z — agent-refresh --record

- Status: ok
- Git: ## main...origin/main [ahead 1]
- Unpublished commits:
  - 30d8eee docs: design deployed-environment smoke workflow blueprint for #56
- Active handoffs: none
- Warnings: none
- Errors: none

## 2026-07-25 — Human gate (push approved) — #56

- Human gate: approved push for ONLY `30d8eee docs: design deployed-environment smoke workflow
  blueprint for #56` (workflow blueprint + runtime-config consistency updates to the #47
  contract and #55 runbook; both Codex review cycles folded in — preflight split, single flow
  without direct-pilot, allowlist leak scan, #68 persistence evidence, #75 cleanup dependency,
  named host-suffix vars, literal concurrency groups, force-cancel semantics).
- Agent will run `agent-refresh -- --record`, push only this commit, follow Quality/CodeQL
  (docs-only), close #56 on green, confirm board Done, and record the result in the handoff.

## 2026-07-25 - #56 Codex review and cleanup dependency

- Independent checks on local commit `16bf72f`: root 77/77, bank 60/0, diff/check clean, no
  secret/account-id match. Push is NOT approved pending architecture corrections.
- Opened #75 as a native sub-issue of #70 and added it to Phase 1 / Todo: version and implement the
  authenticated, idempotent smoke-data cleanup contract instead of letting #70 invent an endpoint or
  use the deploy role for direct DynamoDB mutation.
- Remaining review concerns are reported in chat for amend; no commit or push performed by Codex.

## 2026-07-25 - #56 assigned to Claude (Codex)

- Confirmed #55 CLOSED/Done and #56 OPEN/Todo in Phase 1 on the canonical Roadmap.
- Reconciled #56 to #47/#55: `dev -> pilot`, distinct `BASE_URL`/`FRONTEND_URL`, the new
  pre-submit mock leak scan, Cognito/DynamoDB smokes with deterministic cleanup, same-artifact
  promotion, human-gated rollback hooks, and a fully no-spend release path.
- Activated `.agent-handoff/active/56-deployed-environment-smoke-workflow-design.md` under Claude
  ownership. No workflow, cloud mutation, paid model call, commit, or push was performed.

## 2026-07-25 — Push + CI (Claude) — #55

- Pushed: `3f9f3b5..cde0c8c` (`cde0c8c docs: define pilot release runbook, smoke gates, and
  rollback policy for #55`). `origin/main` is now at `cde0c8c`.
- CI green: Quality (30168534145) and CodeQL/Push on main (30168533986). Web Quality + Infra
  Synth correctly did not trigger (docs-only).
- #55 CLOSED with delivery evidence; board Done (confirmed). Handoff finalized in
  `done/55-pilot-release-runbook.md`.
- Next: #56 — workflow design that turns the runbook's policies (go/no-go, smoke gates incl. the
  new mock leak-scan requirement, rollback hooks) into the automation blueprint #70 implements.
  Open human actions: key rotation after SSO-first migration; `.vscode/settings.json` inclusion in
  a future gated commit.
- Kept as local audit residue for the next governance cleanup.

## 2026-07-25T17:53:23Z — agent-refresh --record

- Status: ok
- Git: ## main...origin/main [ahead 1]
- Unpublished commits:
  - cde0c8c docs: define pilot release runbook, smoke gates, and rollback policy for #55
- Active handoffs:
  - .agent-handoff/active/55-pilot-release-runbook.md
- Warnings:
  - active handoff file(s) present: .agent-handoff/active/55-pilot-release-runbook.md
- Errors: none

## 2026-07-25 — Human gate (push approved) — #55

- Human gate: approved push for ONLY `cde0c8c docs: define pilot release runbook, smoke gates,
  and rollback policy for #55` (release-gate flow + go/no-go, promotion rules, honest local-vs-
  deployed smoke split with the #56 mock leak-scan requirement, BASE_URL/FRONTEND_URL separation,
  Cloudflare/BFF rollback, and the complete DynamoDB PITR cutover incl. joint
  CBA_WEB_TABLE+IAM update, reviewed cdk diff, no wildcards; all Codex review cycles folded in).
- Agent will run `agent-refresh -- --record`, push only this commit, follow Quality/CodeQL
  (docs-only), record the result, close #55 with delivery evidence, confirm board Done, and
  finalize the handoff into done/.

## 2026-07-25 — Push + CI (Claude) — governance cleanup

- Pushed: `9194039..3f9f3b5` (`3f9f3b5 docs: reconcile handoff state and audits after the
  #66/#72/#73 delivery`). `origin/main` is now at `3f9f3b5`.
- CI green: Quality (30167895783) and CodeQL/Push on main (30167895791). Web Quality + Infra Synth
  correctly did not trigger (coordination-docs-only). No issue attached (governance task).
- The #47/#66/#72/#73 audit trail is published; CURRENT.md is current. Local residue: this cycle's
  own gate/record/result entries + the untracked `.vscode/settings.json` (pending share-or-ignore
  decision). Priority HUMAN security action still open: revoke/rotate the AWS access keys from the
  relocated CSV if they are active.
- Next (per CURRENT.md): #55/#56 -> #67/#68/#69 -> #70 -> close #46; product #44 -> #57 -> #62.
- Kept as local audit for the next governance cleanup.

## 2026-07-25T17:34:20Z — agent-refresh --record

- Status: ok
- Git: ## main...origin/main [ahead 1]
- Unpublished commits:
  - 3f9f3b5 docs: reconcile handoff state and audits after the #66/#72/#73 delivery
- Active handoffs: none
- Warnings: none
- Errors: none

## 2026-07-25 — Human gate (push approved) — governance cleanup

- Human gate: approved push for ONLY `3f9f3b5 docs: reconcile handoff state and audits after the
  #66/#72/#73 delivery` (EVENTS audit trail since `4561e87`, reconciled CURRENT.md incl. the two
  Codex-flagged wording fixes — SecurityStack deployed vs placeholder stacks; CI-OIDC vs local
  SSO/assume-role access model — plus done/66 and done/73 execution logs).
- CSV hygiene done pre-push (moved out of the repo, unread, 0600); key revocation/rotation stays a
  priority HUMAN security action but does not block this sanitized commit.
- Agent will run `agent-refresh -- --record`, push only this commit, follow Quality/CodeQL
  (coordination-docs-only — Web Quality/Infra Synth do not trigger), record the result, and STOP.

## 2026-07-25 — Governance cleanup (Claude)

- Dedicated governance commit collecting the local audit residue accumulated since `4561e87`:
  the branch-protection application, the whole #66 track (bootstrap, scoped exec policy cycles,
  SecurityStack deploys, GitHub wiring, no-spend proofs, both paid smokes), the #72 Nova Pro
  pivot (Stages A/B/C), the #73 PR-finalizer fix + live proof, the #47 delivery/push audit, and
  the two repo-config gates (branch protection 2026-07-08; Actions PR permission 2026-07-25).
- `CURRENT.md` reconciled: #47/#65/#66/#72/#73 recorded as CLOSED/Done with the live AWS state
  (Nova Pro end-to-end) and the proven blueprint-refresh pipeline; next sequence now starts at
  #55/#56; follow-ups list refreshed (ai-batch hardening, Sonnet 5 via AWS Sales, CodeQL doc
  naming, Web Quality Option B, COMMANDS.md redaction, `.vscode/settings.json` decision, local
  CSV hygiene). No SHAs pinned as mutable state; no account ids/ARNs.
- Adds `done/66-aws-pilot-bootstrap.md` and `done/73-blueprint-refresh-pr-finalizer.md`
  (execution logs with final reports). `.vscode/settings.json` deliberately left OUT — share-or-
  ignore is a separate pending human decision.
- Local commit only; push follows the human gate.

## 2026-07-25 — GitHub Actions PR-permission enabled (#73 config gate) (Claude)

- Human-gated repo-config mutation via API, single setting: Actions workflow permissions changed
  from {default: read, can_approve_pull_request_reviews: false} to {default: read,
  can_approve_pull_request_reviews: true} — enables the blueprint-refresh PR finalizer to create
  its pull requests. Verified by GET before and after.
- Context: the #73 live self-test (run 30152082269) proved the duplicate-Authorization fix at the
  git layer and the synthetic-file isolation, then failed only at PR creation because this setting
  was disabled (pre-existing governance gap).
- Nothing else executed: no workflow run, no AWS/Bedrock, no push/commit/merge, no
  branch-protection change. Next (separate gate): ONE `pr_plumbing_test=true` re-run -> validate
  PR -> close without merge -> delete branch -> close #73.
- Kept as local audit residue for the next governance cleanup.

## 2026-07-25 — Push + CI (Claude) — #73

- Pushed: `9a377ef..9194039` (`9194039 fix: make blueprint-refresh no-diff succeed and harden the
  PR finalizer (#73)`). `origin/main` is now at `9194039`.
- CI green on the published SHA: Quality (30151978004 — root 77/77 incl. the 7-test workflow
  invariant suite on both Node majors) and CodeQL/Push on main (30151977811). Web Quality + Infra
  Synth correctly did not trigger. (An unrelated Dependabot update run also fired on main.)
- REMAINING for #73 closure: the live `pr_plumbing_test=true` run — GitHub-integration proof of
  the PR finalizer (creates a real self-test PR on `chore/blueprint-refresh-selftest`, to be
  closed without merging); NO AWS/Bedrock, NO spend; behind its own separate human gate.
- Kept as local audit residue for the next governance cleanup.

## 2026-07-25T08:56:36Z — agent-refresh --record

- Status: ok
- Git: ## main...origin/main [ahead 1]
- Unpublished commits:
  - 9194039 fix: make blueprint-refresh no-diff succeed and harden the PR finalizer (#73)
- Active handoffs:
  - .agent-handoff/active/73-blueprint-refresh-pr-finalizer.md
- Warnings:
  - active handoff file(s) present: .agent-handoff/active/73-blueprint-refresh-pr-finalizer.md
- Errors: none

## 2026-07-25 — Human gate (push approved) — #73

- Human gate: approved push for ONLY `9194039 fix: make blueprint-refresh no-diff succeed and
  harden the PR finalizer (#73)` — persist-credentials:false, explicit no-diff success + PR
  conditioned on diff, create-pull-request v6->v8, pr_plumbing_test input (no-AWS synthetic path),
  plus the 7-test static invariant suite required by Codex review.
- Agent will run `agent-refresh -- --record`, push only this commit, follow Quality/CodeQL
  (workflow+test change — Web Quality/Infra Synth do not trigger), record the result, and STOP.
- After CI green, `pr_plumbing_test=true` (live GitHub-integration proof; no AWS/Bedrock, no
  spend) stays behind its own separate human gate.

## 2026-07-25 — #72 Stage B COMPLETE: Nova Pro live rollout (Claude)

- Human-gated, from published `9a377ef` only. Boundary v2 (Nova Pro) created and set default —
  live default byte-identical (normalized) to the rendered template. `cdk diff` showed ONLY the
  Sonnet->Nova Pro swap in the role's inline policy; SecurityStack redeploy UPDATE_COMPLETE under
  the scoped exec role.
- Effective policy proven on the real role: Nova Pro profile/routed allowed; Sonnet 5 denied;
  streaming and all other services denied.
- Only `BEDROCK_MODEL_STANDARD` updated to `us.amazon.nova-pro-v1:0`. No-spend gate re-proven on
  the new wiring (run 30151437076): all AWS/model/PR steps skipped, no PR, zero spend.
- The live pilot runtime is now fully Nova Pro end-to-end (code, boundary, stack, var). REMAINING:
  Stage C — a single paid Nova Pro smoke behind its own explicit human gate; on success, reconcile
  #65 and close #66. Masked report; no identifiers in tracked files.

## 2026-07-25 — Push + CI (Claude) — #72 Stage A

- Pushed: `be45b95..9a377ef` (`9a377ef feat: switch pilot standard tier to Nova Pro fallback
  (#72)`). `origin/main` is now at `9a377ef`.
- CI green on the published SHA: Quality (30151230888), CodeQL/Push on main (30151230679), Infra
  Synth (30151230876 — 22/22 incl. Nova Pro assertions + template checks). Web Quality correctly
  did not trigger.
- Stage A of #72 is fully published. LIVE state unchanged: boundary default is still the Sonnet 5
  v1 version and the deployed SecurityStack still carries the Sonnet 5 policy — Stage B (render
  boundary from the published SHA -> boundary v2 default -> SecurityStack redeploy ->
  `BEDROCK_MODEL_STANDARD` var -> no-spend re-proof) requires a NEW explicit human gate; Stage C
  (single paid Nova Pro smoke) another.
- Kept as local audit residue for the next governance cleanup.

## 2026-07-25T08:30:36Z — agent-refresh --record

- Status: ok
- Git: ## main...origin/main [ahead 1]
- Unpublished commits:
  - 9a377ef feat: switch pilot standard tier to Nova Pro fallback (#72)
- Active handoffs:
  - .agent-handoff/active/66-aws-pilot-bootstrap.md
- Warnings:
  - active handoff file(s) present: .agent-handoff/active/66-aws-pilot-bootstrap.md
- Errors: none

## 2026-07-25 — Human gate (push approved) — #72 Stage A

- Human gate: approved push for ONLY `9a377ef feat: switch pilot standard tier to Nova Pro
  fallback (#72)` — configured standard-tier pivot to Amazon Nova Pro (stack defaults, boundary
  template, CLI BEDROCK_DEFAULTS.standard + .env.example, tests incl. the no-override default
  assertion, README/runbook full-availability-tuple check; both Codex review cycles' fixes).
- Codex independent validation: no findings left; root 70/70, infra 22/22, synth OK, bank 60/0,
  clean diff, no real account id, IAM = InvokeModel only on the Nova Pro profile + 3 routed ARNs;
  #66 acceptance wording reconciled on GitHub.
- Agent will run `agent-refresh -- --record`, push only this commit, follow Quality/CodeQL/Infra
  Synth, record the result, and STOP. Stage B (live boundary v2, SecurityStack redeploy,
  BEDROCK_MODEL_STANDARD var) stays behind a separate explicit gate.

## 2026-07-25 — #66 Etapa 3 COMPLETE: GitHub wiring + no-spend proof (Claude)

- Outputs-file role ARN verified in-shell (never printed) against the live role: MATCH. Only the
  GitHub secret `AWS_BEDROCK_REFRESH_ROLE_ARN` was overwritten (now the authorized account's
  role); `AWS_REGION` and `BEDROCK_MODEL_STANDARD` confirmed unchanged.
- No-spend gate proven on the new wiring: `blueprint-refresh` run 30149327574 with
  `confirm_ai_spend=false` — gate step succeeded with skip=true; Configure-AWS-credentials,
  npm ci, blueprint generation, and PR steps all SKIPPED; no PR created; zero role assumption,
  zero Bedrock, zero spend.
- #54 runbook steps 1-9 now proven end-to-end on the authorized account. Remaining, each behind
  its own explicit human gate: step 10 paid smoke (`confirm_ai_spend=true`) -> runtime evidence ->
  #65/#66 reconciliation; step 11 `ai-batch` hardening; further stacks.
- Masked report only; no account id/ARN in tracked files. Kept as local audit residue.

## 2026-07-25 — #66 Etapa 2 COMPLETE: scoped bootstrap + SecurityStack deployed (Claude)

- Human-gated AWS mutation executed from published `be45b95` only. Exec policy version v2
  (`create-policy-version --set-as-default`) — live default verified byte-identical (normalized)
  to the rendered template; delta v1->v2 is exactly the approved SSM statement. Boundary untouched.
- SecurityStack redeployed under the SCOPED CloudFormation exec role: CREATE_COMPLETE. Account now
  holds: boundary + scoped exec policies, CDKToolkit (termination-protected, scoped exec, no
  --trust), SecurityStack (native AWS::IAM::OIDCProvider, refresh role with permissions boundary,
  InvokeModel-only inline policy). Nothing else.
- Validated read-only, masked: exactly one OIDC provider; trust aud/sub branch-scoped to
  repo main; boundary attached; simulate-principal-policy on the real role — InvokeModel on the
  standard profile allowed, everything else (incl. InvokeModelWithResponseStream) implicitDeny.
- No account id/ARN in tracked files; report masked. NOT done (each needs its own explicit gate):
  GitHub secret/vars rewiring, no-spend workflow proof, paid smoke, other stacks.
- Kept as local audit residue for the next governance cleanup.

## 2026-07-25 — Push + CI (Claude) — #66 ssm fix

- Pushed: `8ed1449..be45b95` (`be45b95 fix: grant scoped exec policy the CDK bootstrap-version SSM
  read for #66`). `origin/main` is now at `be45b95`.
- CI green on the published SHA: Quality (30149030504), CodeQL/Push on main (30149030323), Infra
  Synth (30149030521 — 22/22 tests incl. the exact-pin SSM statement test). Web Quality correctly
  did not trigger.
- LIVE exec policy NOT updated; SecurityStack deploy NOT retried. Next requires a NEW explicit
  human gate: render from the published SHA -> `create-policy-version --set-as-default` on the exec
  policy -> confirm the live default version -> retry ONLY the SecurityStack deploy.
- Kept as local audit residue for the next governance cleanup.

## 2026-07-25T07:16:52Z — agent-refresh --record

- Status: ok
- Git: ## main...origin/main [ahead 1]
- Unpublished commits:
  - be45b95 fix: grant scoped exec policy the CDK bootstrap-version SSM read for #66
- Active handoffs:
  - .agent-handoff/active/66-aws-pilot-bootstrap.md
- Warnings:
  - active handoff file(s) present: .agent-handoff/active/66-aws-pilot-bootstrap.md
- Errors: none

## 2026-07-25 — Human gate (push approved) — #66 ssm fix

- Human gate: approved push for ONLY `be45b95 fix: grant scoped exec policy the CDK
  bootstrap-version SSM read for #66` (template statement `ReadCdkBootstrapVersionParameter`,
  exact-pin test, runbook note on the DefaultStackSynthesizer baseline requirement).
- Agent will run `agent-refresh -- --record`, push only this commit, follow Quality/CodeQL/Infra
  Synth, and record the result.
- The LIVE exec policy is NOT updated and the SecurityStack deploy is NOT retried in this stage —
  both require a NEW explicit human gate after CI is green on the published SHA.

## 2026-07-25 — Push + CI (Claude) — #66 stage 1

- Pushed: `1b2e762..8ed1449` (`8ed1449 feat: scope CDK bootstrap with permissions boundary and
  native OIDC provider for #66`). `origin/main` is now at `8ed1449`.
- CI green on the published SHA: Quality (30148618572), CodeQL/Push on main (30148618265), and
  **Infra Synth (30148618590)** — first real run over the native-provider stack: 21/21 infra tests,
  credential-free synth, template assertions (role name, `bedrock:InvokeModel`, trust sub, OIDC
  host, no literal account id) and the routed-ARN override regression all passed.
- Web Quality correctly did not trigger (no web paths).
- NO AWS resource was created. Etapa 2 (render templates -> create boundary -> create scoped exec
  policy -> `cdk bootstrap` scoped/termination-protected -> deploy SecurityStack only) awaits a NEW
  explicit human gate, per the approved pipeline. #66 stays In Progress (active/66 handoff).
- Kept as local audit residue for the next governance cleanup.

## 2026-07-25T07:03:23Z — agent-refresh --record

- Status: ok
- Git: ## main...origin/main [ahead 1]
- Unpublished commits:
  - 8ed1449 feat: scope CDK bootstrap with permissions boundary and native OIDC provider for #66
- Active handoffs:
  - .agent-handoff/active/66-aws-pilot-bootstrap.md
- Warnings:
  - active handoff file(s) present: .agent-handoff/active/66-aws-pilot-bootstrap.md
- Errors: none

## 2026-07-25 — Human gate (push approved) — #66 stage 1 (code/docs only)

- Human gate: approved push for ONLY `8ed1449 feat: scope CDK bootstrap with permissions boundary
  and native OIDC provider for #66` (native AWS::IAM::OIDCProvider, operator-managed boundary,
  versioned sanitized policy templates + tests, hardened runbook; includes both Codex review
  cycles' fixes).
- Agent will run `agent-refresh -- --record`, push only this commit, and follow Quality, CodeQL,
  and Infra Synth (infra paths trigger the lane; Web Quality does not).
- NO AWS resource creation in this stage — Etapa 2 (boundary/exec policy/CDKToolkit/SecurityStack)
  requires a NEW explicit human gate after CI is green on the published SHA.
- This gate entry + the post-push result stay as local audit residue (protocol mechanics).

## 2026-07-25 — #66 moved to execution after environment preflight (Codex)

- Confirmed #47 was pushed, CI-green, closed, and Done; local main matches origin/main.
- Read-only/no-spend preflight for #66 found no active CloudFormation stacks in the authorized
  account, while the expected GitHub variable/secret names already exist.
- Bedrock reports the target model authorized and entitled in `us-east-1`; no model was invoked.
- Moved #66 to Phase 1 / In Progress and recorded the safe execution sequence on the issue:
  bootstrap -> SecurityStack only -> OIDC/role validation -> secret rewiring -> no-spend workflow.
- Execution must stop for a separate explicit human approval before `confirm_ai_spend=true`.
- No account ID, ARN, credential, secret value, cloud mutation, commit, or push occurred.

## 2026-07-25 — Push + CI (Claude) — #47

- Pushed: `4561e87..1b2e762` (`1b2e762 docs: define pilot environment contract for #47`).
  `origin/main` is now at `1b2e762`. Branch protection behaved as designed (required checks
  expected; owner bypass on direct push).
- CI green: Quality (30146918943) and CodeQL/Push on main (30146918787). Web Quality + Infra Synth
  correctly did not trigger (docs-only change).
- #47 closed with delivery evidence; Project automation moves it to Done. Next in sequence: #66
  (authorized-account bootstrap + Bedrock OIDC smoke), then #55/#56, #67/#68/#69, #70.
- Kept as local audit residue for the next governance cleanup.

## 2026-07-25T06:05:58Z — agent-refresh --record

- Status: ok
- Git: ## main...origin/main [ahead 1]
- Unpublished commits:
  - 1b2e762 docs: define pilot environment contract for #47
- Active handoffs: none
- Warnings: none
- Errors: none

## 2026-07-25 — Human gate (push approved) — #47

- Human gate: approved push for `1b2e762 docs: define pilot environment contract for #47` (the
  pilot environment contract + pointer edits + done/47 handoff; includes the Codex review fixes:
  deployed-runtime fail-fast rule, account/profile convention, preview-vs-CORS policy, MD018
  rewording, and the COGNITO_* table-row placement).
- Scope: only this commit. Agent will run `agent-refresh -- --record`, push, follow Quality/CodeQL
  (docs-only — Web Quality/Infra Synth do not trigger), record the result, and close #47 with
  delivery evidence after CI green.
- This gate entry + the post-push result stay as local audit residue (protocol mechanics).

## 2026-07-25 — #47 pilot environment contract delivered (Claude)

- Executed the #47 inbox brief (docs-only): authored
  `docs/architecture/pilot-environment-contract.md` — canonical `local -> dev -> pilot` contract:
  environment matrix (ownership/persistence/auth/deploy-gate/durability/observability/spend);
  staging-deferred reconciliation of the older `dev/staging/prod` wording; runtime path fixing
  **API Gateway HTTP API + Lambda** for the Web BFF (resolves the ADR-0002 open point) and Option A
  (Cloudflare frontend + AWS BFF); DynamoDB on-demand behind the existing repository port;
  configuration registry by owner reusing existing env names + the minimal new set for #67-#69
  (`NEXT_PUBLIC_CBA_BFF_BASE_URL`, `CBA_WEB_TABLE`, `CBA_WEB_ALLOWED_ORIGINS`, `COGNITO_*`,
  `CBA_WEB_STORE=dynamodb`); executable no-spend readiness ladder + local fallback; #66 bootstrap
  sequencing; per-issue consumption map.
- Pointers added to `docs/wiki/Architecture.md`, `aws-iac-foundation.md` (Environment Model), and
  `github-security-and-oidc-baseline.md` (§3) — assigned-task edit per the do-not-touch rule.
- Handoff moved inbox -> active -> done with work log/final report. No AWS/Cloudflare/GitHub
  mutation, no model call, no paid operation, no MCP needed; no account id/ARN/secret in the diff.
- Validated: `agent-refresh` ok; `git diff --check` clean; root `npm test` 69/69; `validate` 60/0;
  all relative link targets exist; secret/identifier grep clean.
- Local `docs:` commit (scope: the contract, the three pointer files, done/47) — SHA in the chat
  report; NOT pushed (awaiting Codex review + human gate). EVENTS.md/CURRENT.md stay uncommitted
  residue per protocol.

## 2026-07-25 — #47 AWS pilot environment foundation kickoff (Codex)

- Audited #47 against ADR-0002, the AWS IaC/security foundations, architecture diagrams, BFF
  contracts, and #67-#70. Most broad architecture is already published; duplication is unnecessary.
- Moved #47 to Phase 1 / In Progress and recorded the residual decisions on the issue.
- Fixed the implementation target: `local -> dev -> pilot`; Cloudflare Workers/OpenNext frontend;
  API Gateway HTTP API + Lambda Web BFF; DynamoDB on-demand; Cognito; CloudWatch; SSM/Secrets Manager;
  GitHub OIDC-only deploy; internal AI with no-spend defaults.
- Added an executor brief under `.agent-handoff/inbox/`. #47 remains docs-only: no cloud mutation,
  deployment, paid call, commit, or push was performed by the architect.

## 2026-07-25 — GitHub MCP OAuth configuration and MCP set validation (Codex)

- Added the official remote GitHub MCP endpoint to the local/gitignored VS Code configuration.
- Uses VS Code OAuth; no PAT, authorization header, or GitHub credential was added to the file.
- Confirmed VS Code supports remote MCP OAuth and the endpoint exposes the expected OAuth challenge.
- Revalidated the local MCP set: Stitch, Cloudflare Docs, Cloudflare API, AWS MCP, GitHub, and
  Next.js DevTools are configured; the file remains mode `0600` and ignored by Git.
- Cloudflare Docs, AWS, Stitch, GitHub, and Next.js DevTools passed live/read-only checks; AWS exposed
  9 tools and Next.js DevTools exposed 4. Cloudflare API/account credentials returned HTTP 200 and
  its MCP endpoint exposed the expected IDE OAuth challenge.
- No source change, commit, push, GitHub mutation, paid model call, or secret exposure occurred.

## 2026-07-25 — Least-privilege AWS MCP diagnostics access (#71) (Codex)

- Created and closed #71 as a native Phase 1 child of #47; Project automation moved it to Done.
- Created a customer-managed diagnostics policy and a one-hour assume-role role/profile for local
  AWS MCP development. The same policy is attached to the role and used as its permissions boundary.
- AWS Access Analyzer returned zero findings. Read-only CloudFormation, CloudWatch Logs, and Bedrock
  catalog calls succeeded through the role.
- IAM simulation confirmed infrastructure diagnostics are allowed; Bedrock invocation, secret
  retrieval, S3/DynamoDB application-data reads, and CloudFormation mutation are denied.
- Installed `uv`/`uvx` user-wide under `~/.local/bin` and configured the local managed AWS MCP Server
  with a single-profile allowlist and `us-east-1` metadata. The MCP config remains gitignored and
  mode `0600`.
- A real MCP initialize plus tools-list handshake succeeded with 9 tools. No AWS resource deploy,
  secret read, application-data read, Bedrock invocation, paid model call, commit, or push occurred.
- No account ID, ARN, access key, token, or local MCP configuration was written to tracked files.

## 2026-07-25 — Cloudflare/AWS deploy roadmap decomposition (Codex)

- Human authorized the Project update for the Cloudflare frontend and AWS Web BFF deploy path.
- Kept #46 as the integrated parent and created four native sub-issues: #67 Cloudflare
  Workers/OpenNext learner frontend, #68 AWS Web BFF extraction, #69 Cognito plus cross-cloud
  security boundary, and #70 deploy pipeline plus deterministic post-deploy smoke gates.
- Added #67-#70 to Project #3 as Phase 1 / Todo and verified their Project fields and native
  parent/sub-issue links through the GitHub API.
- Recorded the decision on #46: the current Next.js app is not a pure static export; Cloudflare owns
  the learner surface while AWS owns BFF routes, exam content/correction, attempts/progress,
  identity, persistence, and AI orchestration.
- Guardrail recorded: never publish the source question bank, correct answers, explanations,
  credentials, or Bedrock configuration in Cloudflare/browser artifacts.
- Planned order: #47 -> #66 -> #55/#56 -> #67/#68/#69 -> #70 -> close #46.
- No source code, cloud deploy, paid model call, commit, or push in this board-admin task.

## 2026-07-25 — Project roadmap audit and cleanup (Codex)

- Human authorized the Project cleanup after a read-only audit of all repository Issues and Project
  #3.
- Closed #22, #33, #48, and #49 as completed after posting delivery evidence; Project automation
  moved them to Done.
- Created #66, `Bootstrap authorized AWS pilot account and validate Bedrock OIDC smoke`, and added it
  to Phase 1 / Todo without exposing account IDs, ARNs, or credentials.
- Updated #65 with the authorized-account preflight result, moved it from Phase 0 / Todo to Phase 1 /
  In Progress, and linked its completion to the successful runtime evidence from #66.
- Added `roadmap` + `saas` labels to the 16 previously unclassified roadmap tasks.
- Added 33 native parent/sub-issue relationships for #11, #12, #17, #19, #20, #22, #33, #48, #49,
  and #50 so the Project's Parent issue and Sub-issues progress fields reflect delivery.
- Re-audit result: 65 Project items, all with Phase and Status; no open/Done or closed/non-Done
  mismatch; no open issue is missing from the board.
- Remaining manual UI action: create a `Roadmap by Phase` Project view grouped by `Phase`. GitHub's
  public GraphQL/CLI APIs expose view reads but no create/update-view mutation.
- No source code, AWS resources, paid model calls, commit, or push in this roadmap-admin task.

## 2026-07-08 — BLOCKER: AWS account verification (pilot account) (Claude)

- The full GitHub→AWS identity path is validated end-to-end: branch protection applied; GitHub OIDC
  provider created; CDK bootstrap done; SecurityStack deployed; GitHub vars/secrets set; no-spend
  blueprint-refresh gate works; GitHub Actions successfully assumes the AWS role via OIDC.
- **Blocked above IAM/application level:** the pilot AWS account (ACTIVE in Organizations, STS works
  via SSO AdministratorAccess) is reported blocked / not recognized as a valid account for service
  operations. Symptoms: Bedrock Anthropic model access cannot be enabled (Claude Sonnet 5 stays
  `NOT_AUTHORIZED`); EC2 instance launch also fails "account-blocked" — proving account-level
  verification, not a Bedrock/IAM/policy issue.
- **Required external action (human/AWS):** open an AWS Support case under Account Management /
  Account Verification. No config/code workaround exists — do not attempt to bypass.
- Do NOT run paid Bedrock tests (`confirm_ai_spend=true`) while this blocker is open.
- After AWS unblocks: re-check Bedrock model availability; redeploy the corrected SecurityStack
  (`InvokeModel` — the live role still carries the debug `bedrock:Converse`, see prior entry); then
  the paid blueprint-refresh smoke only after explicit human approval.
- Roadmap issue #65 created and added to the Project board (Status: Todo, Phase 0) to track this
  external blocker without exposing account ids or ARNs.
- Open (deferred, low priority): redact the pre-existing account id in committed `COMMANDS.md`
  (Option A) — pending human decision.
- Kept as local audit residue for the next governance cleanup (no dedicated commit).

## 2026-07-08 — Revert Bedrock IAM action to `bedrock:InvokeModel` (Claude)

- During a human-run paid `confirm_ai_spend=true` test, the OIDC role was assumed correctly but the
  Converse call returned "Operation not allowed". That was misdiagnosed as an IAM-action mismatch and
  the policy was locally switched to `bedrock:Converse`. Reverted: **Converse is authorized by
  `bedrock:InvokeModel`** (AWS docs + the #54 §2 note already stated this); `bedrock:Converse` is not
  the required action.
- Reverted 4 files to the correct HEAD design (`git checkout`, no other changes touched):
  `infra/aws/lib/security-stack.js` (action `bedrock:InvokeModel`, Sid
  `InvokeStandardTierViaInferenceProfile`), `.github/workflows/infra-synth.yml` (assertion greps
  `bedrock:InvokeModel`), and the two architecture docs (role catalog / permission policy back to
  `bedrock:InvokeModel`).
- Validated: `node --check` OK; infra `npm test` 6/6; `synth:quiet` OK (template shows
  `"Action": "bedrock:InvokeModel"`); root `npm test` 69/69; `validate` 60/0; `git diff --check` clean.
- **Live drift:** `cdk diff SecurityStack` shows the **deployed** role still carries `bedrock:Converse`
  (the debug deploy applied the wrong action). Code is corrected but the live role is not — a
  human-gated redeploy of the corrected SecurityStack is required to restore `bedrock:InvokeModel`.
- **Real blocker for the paid test:** model access — `get-foundation-model-availability` for Claude
  Sonnet 5 returned `NOT_AUTHORIZED` (entitlement/region AVAILABLE). A human must enable model
  access / accept the model terms in Bedrock. No automated acceptance attempted.
- NOT done (await explicit human gate): the corrected SecurityStack redeploy; any
  `confirm_ai_spend=true` paid run. No account id / ARN written to tracked files.
- Kept as local audit residue for the next governance cleanup (no dedicated commit).

## 2026-07-08 — AWS #54 bootstrap + SecurityStack deploy + GitHub wiring (Claude)

- Human-gated, executed end-to-end against the pilot AWS account (us-east-1), no long-lived keys
  (SSO admin session). CDK `bootstrap` created the CDKToolkit; `cdk deploy SecurityStack` (only that
  stack) created the **GitHub OIDC provider** + the **blueprint-refresh Bedrock role** — branch-scoped
  WebIdentity trust (`repo:marciozampiron/backstage-cba-prep:ref:refs/heads/main`, `aud
  sts.amazonaws.com`), `bedrock:InvokeModel` on the sonnet-5 inference profile + the routed us-* (east-1/
  east-2/west-2) foundation-model ARNs, region-locked. Stack CREATE_COMPLETE; role + OIDC provider
  validated to exist. Account id / role ARN kept OUT of tracked files (they live only in the GitHub
  secret) per secret-hygiene.
- GitHub wiring (§5): set secret `AWS_BEDROCK_REFRESH_ROLE_ARN` + vars `AWS_REGION=us-east-1`,
  `BEDROCK_MODEL_STANDARD=us.anthropic.claude-sonnet-5`.
- No-spend gate verified: `blueprint-refresh` run with `confirm_ai_spend=false` (run 28963220211) —
  the `Check Bedrock refresh gate` step exited 0 with skip=true; `Configure AWS credentials` and all
  Bedrock/PR steps **skipped**. Zero role assumption, zero Bedrock call, zero spend.
- NOT done (await explicit human gate): the `confirm_ai_spend=true` paid run; `ai-batch` env hardening
  (env-scoped trust + one-line workflow change); other stacks (Identity/Data/Api/AiOrchestration/
  Observability). Follow-up: refresh `CURRENT.md` "next" pointer (the #54 runbook is now delivered).
- Kept as local audit residue for the next governance cleanup (no dedicated commit).

## 2026-07-08 — Branch protection applied to `main` (Claude)

- Applied the first `main` branch-protection ruleset via the GitHub API (Option A from
  `github-security-and-oidc-baseline.md` §1). Repo-config change only — **no commit, no push**.
- Required status checks (exact check-run names GitHub reports): `quality (20)`, `quality (22)`,
  `Analyze (javascript-typescript)`, `Analyze (actions)`. The last two ARE the CodeQL default-setup
  runs on this repo — the §1 table's single `CodeQL` name is stale; reconcile the doc under an
  assigned task (the security/OIDC docs are do-not-touch).
- `enforce_admins: false` (deliberate) — preserves the owner's direct-push-after-human-gate flow;
  required checks gate PR merges, the owner still pushes `main` directly.
- Light start per "começando": no PR/review requirement, `strict: false`; force-pushes and deletions
  disabled. Web Quality + Infra Synth left OUT (path-filtered → would deadlock non-matching PRs; Option A).
- Follow-ups: doc name reconciliation (`CodeQL` → `Analyze (...)`); tighten to PR-required/strict when
  moving to a PR flow; Option B (always-run Web Quality with an internal path gate) before making it
  required; then the #54 AWS bootstrap runbook.
- Kept as local audit for the next governance cleanup (uncommitted residue).

## 2026-07-08 — Push + CI (Claude) — governance cleanup

- Pushed: `973fdfa..4561e87` (`4561e87 docs: reconcile handoff state and audits after #48/#49 foundation`). `origin/main` is now at `4561e87`.
- CI green: Quality (28918407567) and CodeQL (28918406904); Web Quality + Infra Synth correctly did not trigger (coordination-docs-only, no `web/**`/`infra/aws/**` paths).
- The #48/#49-foundation audit trail is published and CURRENT.md is current; the only local residue is this cycle's own gate/record/result entries. No issue attached.
- Next (architect steer): apply GitHub branch protection (`github-security-and-oidc-baseline.md` §1) — the first real-security change. Open housekeeping: postcss Dependabot advisory.
- Kept as local audit for the next governance cleanup.

## 2026-07-08T04:52:10Z — agent-refresh --record

- Status: ok
- Git: ## main...origin/main [ahead 1]
- Unpublished commits:
  - 4561e87 docs: reconcile handoff state and audits after #48/#49 foundation
- Active handoffs: none
- Warnings: none
- Errors: none

## 2026-07-08 — Human gate (push approved) — governance cleanup

- Human gate: approved push for `4561e87 docs: reconcile handoff state and audits after #48/#49 foundation` (EVENTS.md audit trail since `ed2b7bd`, CURRENT.md refresh incl. architect fixes — "apply branch protection" as next step + #45 recorded closed, postcss kept open; done/52 nit). Coordination docs only.
- Agent will run `npm run agent-refresh -- --record`, push only this commit, follow Quality/CodeQL, and record the result. No issue attached (governance task).
- This gate entry + the post-push result are the next small local EVENTS.md residue (protocol mechanics).

## 2026-07-08 — Governance cleanup (Claude)

- Dedicated governance commit collecting the local EVENTS.md audit residue accumulated since the last
  cleanup (`ed2b7bd`): the architecture-docs / adaptive-AI-strategy push, the blueprint-refresh
  Bedrock fix, and the #48/#49 CI/security foundation cycles (#52, #54, #53, and the Node 20 test-glob
  fix) — every "kept as local audit" note lands here.
- `CURRENT.md` refreshed to 2026-07-08: active priority now reflects the delivered CI/security
  foundation (#51/#52/#53/#54) and three live CI lanes; do-not-touch extended with `infra/aws/**`,
  the `.github/workflows/*`, and the security/OIDC docs; records the Node-20 tooling lesson and the
  open housekeeping (#45 duplicate, postcss advisory). No SHAs pinned.
- Also folds in the one-line `done/52` nit (a leftover empty bullet) removed earlier.
- No product code touched; no feature issues altered; local commit only — push follows the human gate.

## 2026-07-08 — Push + CI + issue closed (Claude) — #53 (+ Node 20 fix)

- Pushed: `3cb9980` (#53 scaffold) then `973fdfa` (Node 20 test-glob fix-forward). `origin/main` is now at `973fdfa`.
- CI: `3cb9980` — Infra Synth first run **success** (28908298318) + Quality(22) success, but Quality(20) FAILED (glob-pattern `--test` path needs Node >=21). `973fdfa` restored green: Quality **20 + 22** success (28908507400), CodeQL success (28908507080).
- Issue #53 closed citing both commits; board Done. CDK app live under `infra/aws/` (JS/CommonJS, owner decision): security stack encoding the #54 OIDC/Bedrock model + 5 placeholder stacks; parseArnList fixes the `-c` override char-spread bug (unit tests + CI regression); Infra Synth lane is credential-free/no-deploy; root test scoped to `test/*.test.js` to decouple infra.
- Lesson: a Node-version-dependent feature (`node --test` glob) slipped past local (Node 22) — verify CI-matrix compatibility for tooling changes. #48/#49 CI/security foundation is now implemented (#51/#52/#53/#54); remaining is human branch-protection + bootstrap runbook, and #46/#47 deploy/env.
- Kept as local audit for the next governance cleanup.

## 2026-07-08T00:30:38Z — agent-refresh --record

- Status: ok
- Git: ## main...origin/main [ahead 1]
- Unpublished commits:
  - 973fdfa ci: scope root test glob for Node 20 compatibility
- Active handoffs: none
- Warnings: none
- Errors: none

## 2026-07-08 — Human gate (push approved) — #53 Node 20 CI fix

- Context: `3cb9980` (#53) went green on Infra Synth + Quality(22) but FAILED Quality(20) — the root `npm test` was changed to `node --test 'test/**/*.test.js'`, and glob-pattern paths need Node >=21 (matrix runs 20 + 22). Main is red until fixed.
- Human gate: approved push for `973fdfa ci: scope root test glob for Node 20 compatibility` (one-line: shell-expanded glob `test/*.test.js` — version-agnostic explicit file list, still scoped to test/).
- Agent will run `npm run agent-refresh -- --record`, push only this commit, confirm Quality goes green on both Node versions, then close #53 citing `3cb9980` + `973fdfa`.
- Out of scope (not pushed): EVENTS.md audit residue + the done/52 nit — next governance cleanup.

## 2026-07-08T00:25:22Z — agent-refresh --record

- Status: ok
- Git: ## main...origin/main [ahead 1]
- Unpublished commits:
  - 3cb9980 feat: scaffold AWS CDK app with synth-only validation for #53
- Active handoffs: none
- Warnings: none
- Errors: none

## 2026-07-07 — Human gate (push approved) — #53

- Human gate: approved push for #53, commit `3cb9980 feat: scaffold AWS CDK app with synth-only validation for #53` (CDK v2 app in JS under infra/aws/: security stack encoding the #54 OIDC/Bedrock model + 5 placeholder stacks, synth-only CI lane; architect review fixes amended: parseArnList override bug fixed with unit tests + CI regression, root npm test scoped to decouple infra; JS-over-TS accepted as a documented owner decision).
- Agent will run `npm run agent-refresh -- --record` immediately before push, then push only this commit, follow Quality + the first real Infra Synth run + CodeQL, and close #53 if green.
- Out of scope (not pushed): the EVENTS.md audit residue and the one-line done/52 nit fix — both fold into the next governance cleanup.

## 2026-07-07 — Push + CI + issue closed (Claude) — #54

- Pushed the approved scope: `ae586ba..3271c78` (`3271c78 docs: define AWS bootstrap and IAM/OIDC model for #54`). `origin/main` is now at `3271c78`.
- CI green: Quality (28903912968) and CodeQL (28903912706); Web Quality correctly did not trigger (docs-only).
- Issue #54 was closed in parallel by the human/Codex while CI was being watched; the delivery comment citing `3271c78` was posted separately (close-with-comment no-ops on an already-closed issue). Board item Done.
- AWS bootstrap + IAM/OIDC model live in `docs/architecture/aws-bootstrap-and-oidc.md`: OIDC provider (no manual thumbprint — architect blocker fixed), blueprint-refresh Bedrock role trust/permission policy JSON (Converse→InvokeModel, inference profile + routed model ARNs, region-locked), vars/secrets, 8-step runbook, CDK target, no-spend verification. Define only — no AWS resources created.
- #48 security track: #51 ✅ #52 ✅ #54 ✅. Remaining: human applies branch protection + runs the bootstrap runbook; #53 (CDK synth lane); #49/#47 (IaC/env foundation). Kept as local audit for the next governance cleanup.

## 2026-07-07T22:45:21Z — agent-refresh --record

- Status: ok
- Git: ## main...origin/main [ahead 1]
- Unpublished commits:
  - 3271c78 docs: define AWS bootstrap and IAM/OIDC model for #54
- Active handoffs: none
- Warnings: none
- Errors: none

## 2026-07-07 — Human gate (push approved) — #54

- Human gate: approved push for #54, commit `3271c78 docs: define AWS bootstrap and IAM/OIDC model for #54` (new `aws-bootstrap-and-oidc.md`: OIDC provider definition, blueprint-refresh Bedrock role with trust + least-privilege permission policy JSON [Converse→InvokeModel over inference profile + routed model ARNs, region-locked], vars/secrets, 8-step bootstrap runbook, CDK target for #49/#53, no-spend verification; architect blocker fixed: thumbprint placeholder removed — flag is optional per official AWS docs).
- Agent will run `npm run agent-refresh -- --record` immediately before push, then push only this commit, follow Quality/CodeQL, close #54 citing `3271c78`, and confirm the board is Done.
- Out of scope (not pushed): the EVENTS.md audit residue and the one-line `done/52` nit fix — both fold into the next governance cleanup.

## 2026-07-07 — Push + CI + issue closed (Claude) — #52

- Pushed the approved scope: `962218c..ae586ba` (`ae586ba docs: define GitHub security baseline and AWS OIDC roles for #52`). `origin/main` is now at `ae586ba`.
- CI green: Quality (28897034189) and CodeQL (28897033652); Web Quality correctly did not trigger (docs-only, no web paths).
- Issue #52 closed with the delivery summary and acceptance checklist; board item Done.
- GitHub security baseline live in `docs/architecture/github-security-and-oidc-baseline.md`: branch protection + required checks + Web Quality path-filter caveat, least-privilege permissions, Environments, AWS OIDC role catalog/trust boundaries, vars/secrets registry, secret hygiene, Dependabot/scanning posture. Design only — nothing applied.
- Post-close nit: removed a leftover empty `- Remaining risks/follow-ups:` bullet at the end of `done/52-github-security-oidc.md` (architect-flagged, cosmetic). Fixed locally to fold into the next commit, not a dedicated push cycle — so the working tree now also carries this one-line handoff fix alongside the EVENTS.md audit residue.
- Next in the #48 track: apply branch protection ruleset (human) choosing Option A/B; #54 (AWS OIDC provider + roles); #53 (CDK synth lane). Kept as local audit for the next governance cleanup.

## 2026-07-07T20:38:00Z — agent-refresh --record

- Status: ok
- Git: ## main...origin/main [ahead 1]
- Unpublished commits:
  - ae586ba docs: define GitHub security baseline and AWS OIDC roles for #52
- Active handoffs: none
- Warnings: none
- Errors: none

## 2026-07-07 — Human gate (push approved) — #52

- Human gate: approved push for #52, commit `ae586ba docs: define GitHub security baseline and AWS OIDC roles for #52` (new `github-security-and-oidc-baseline.md`: branch protection + required checks + Web Quality path-filter strategy, permissions model, GitHub Environments, AWS OIDC role catalog/trust boundaries, vars/secrets registry, secret hygiene, Dependabot/scanning posture; cross-link from the CI/CD foundation doc; SECURITY.md replaced with a real reporting policy). Design only — nothing applied.
- Agent will run `npm run agent-refresh -- --record` immediately before push, then push only this commit, follow Quality/CodeQL, and close #52 if green.
- Out of scope (not pushed): this EVENTS.md audit stays local until the next governance cleanup.

## 2026-07-07 — Push + CI (Claude) — blueprint-refresh Bedrock fix

- Pushed the approved scope: `b1748e9..962218c` (`962218c fix: run blueprint refresh through Bedrock OIDC`). `origin/main` is now at `962218c`.
- CI green: Quality (28873726019) and CodeQL (28873724638). **Web Quality correctly did not trigger** — the commit touches no `web/**`/`questions/**`/`spec/blueprint.json` paths, validating the #51 path filter in production.
- A Dependabot job ran for the known moderate `postcss` advisory in `/web` (run 28873736935, success; no PR opened yet) — the dependency follow-up remains open for a security cycle.
- Blueprint refresh is now Bedrock-native: manual-only + confirm_ai_spend gate, OIDC role assumption, tier-based port with BEDROCK_MODEL_STANDARD config, offline regression (69/69). No issue attached (bugfix cycle).
- Kept as local audit for the next governance cleanup.

## 2026-07-07T14:23:58Z — agent-refresh --record

- Status: ok
- Git: ## main...origin/main [ahead 1]
- Unpublished commits:
  - 962218c fix: run blueprint refresh through Bedrock OIDC
- Active handoffs: none
- Warnings: none
- Errors: none

## 2026-07-07 — Human gate (push approved) — blueprint-refresh Bedrock fix

- Human gate: approved push for `962218c fix: run blueprint refresh through Bedrock OIDC` (Codex-authored fix, Claude-reviewed: manual-only workflow with confirm_ai_spend gate, AWS OIDC via dedicated role, LLM_BACKEND=bedrock honored in blueprint.js with BEDROCK_MODEL_STANDARD mapping, offline regression test 69/69, npm ci added).
- Agent will run `npm run agent-refresh -- --record` immediately before push, then push only this commit, follow Quality/CodeQL, and record the result here. No issue attached (bugfix cycle).
- Out of scope (not pushed): this EVENTS.md audit stays local until the next governance cleanup.

## 2026-07-07 — Push + CI + issue closed (Claude) — #51

- Pushed the approved scope: `d68951d..b1748e9` (`b1748e9 ci: implement monorepo quality lanes for #51`). `origin/main` is now at `b1748e9`.
- CI green 3/3: Quality (28865118330), **Web Quality first real run (28865118187 — all steps passed, including the deterministic memory-store smokes and the restart-persistence smoke on the runner)**, CodeQL (28865117423).
- Issue #51 closed with the delivery summary and acceptance checklist; board item Done.
- Quality-lanes foundation live: root lane untouched, web lane path-filtered on `web/**` + `questions/**` + `spec/blueprint.json` (runtime-data finding incorporated), least-privilege permissions, check names documented for #52 branch protection.
- Next in the #48 track: #52 (branch protection + OIDC roles), #53 (CDK synth lane). Kept as local audit for the next governance cleanup.

## 2026-07-07T12:11:21Z — agent-refresh --record

- Status: ok
- Git: ## main...origin/main [ahead 1]
- Unpublished commits:
  - b1748e9 ci: implement monorepo quality lanes for #51
- Active handoffs: none
- Warnings: none
- Errors: none

## 2026-07-07 — Human gate (push approved) — #51

- Human gate: approved push for #51, commit `b1748e9 ci: implement monorepo quality lanes for #51` (new path-scoped Web Quality lane with deterministic memory-store smokes + restart smoke, least-privilege permissions, lanes/required-checks table in the foundation doc; architect finding amended: `questions/**` + `spec/blueprint.json` added to the web lane's path filters since the app loads them at runtime).
- Agent will run `npm run agent-refresh -- --record` immediately before push, then push only this commit, follow Quality + the first real Web Quality run + CodeQL, and close #51 if green.
- Out of scope (not pushed): this EVENTS.md audit stays local until the next governance cleanup.

## 2026-07-06 — Push + CI (Codex) — architecture docs

- Pushed the approved scope: `ed2b7bd..d68951d` containing:
  - `fbd3b22 docs: define CI/CD and AWS IaC strategy`
  - `d68951d docs: define adaptive AI study strategy`
- CI green: Quality (run 28834910949) and CodeQL (run 28834910646) both passed.
- Roadmap cards #51–#64 are already created/updated and referenced by the docs/specs.
- GitHub reported one existing Dependabot vulnerability (moderate) on the default branch during push; handle as a separate security/dependency follow-up, not part of this architecture-doc push.
- This push-result entry remains local EVENTS.md audit residue until the next governance cleanup.

## 2026-07-07T01:25:12Z — agent-refresh --record

- Status: ok
- Git: ## main...origin/main [ahead 2]
- Unpublished commits:
  - d68951d docs: define adaptive AI study strategy
  - fbd3b22 docs: define CI/CD and AWS IaC strategy
- Active handoffs: none
- Warnings: none
- Errors: none

## 2026-07-06 — Human gate (push approved) — architecture docs

- Human gate: approved push for exactly these two architecture/documentation commits:
  - `fbd3b22 docs: define CI/CD and AWS IaC strategy`
  - `d68951d docs: define adaptive AI study strategy`
- Approved scope: CI/CD + AWS IaC strategy docs, Adaptive AI Study Strategy spec, wiki/AGENTS references, and roadmap cards #51–#64 already created/updated.
- Agent will run `npm run agent-refresh -- --record` immediately before push, then push only these commits, follow Quality/CodeQL, and record the result here.

## 2026-07-06 — Push + CI (Claude) — governance cleanup

- Pushed the approved scope: `ffc16e6..ed2b7bd` (`ed2b7bd docs: reconcile handoff state and audits after #35-#43 cycles`). `origin/main` is now at `ed2b7bd`.
- CI green: Quality (run 28830340035) and CodeQL (run 28830339585) both passed.
- The #35–#43 audit trail, the refreshed CURRENT.md, and the documented `.vscode/mcp.json` ignore are now published; the only local EVENTS.md residue is this cycle's own gate/record/result entries (expected protocol mechanics).
- No issue attached (governance task). Open queue: Cognito adapter + /api/me + sign-in; §15 progress screen; human closes duplicate #45.

## 2026-07-06T23:28:42Z — agent-refresh --record

- Status: ok
- Git: ## main...origin/main [ahead 1]
- Unpublished commits:
  - ed2b7bd docs: reconcile handoff state and audits after #35-#43 cycles
- Active handoffs: none
- Warnings: none
- Errors: none

## 2026-07-06 — Human gate (push approved) — governance cleanup

- Human gate: approved push for the governance commit `ed2b7bd docs: reconcile handoff state and audits after #35-#43 cycles` (EVENTS.md audit trail #35–#43, CURRENT.md refresh, documented `.vscode/mcp.json` ignore).
- Agent will run `npm run agent-refresh -- --record` immediately before push, then push only this commit, follow Quality/CodeQL, and record the result here.
- Note: this gate entry and the post-push result are, by protocol mechanics, the next small local EVENTS.md residue.

## 2026-07-06 — Governance cleanup (Claude)

- Dedicated governance commit collecting the local audit trail of the #35–#43 push cycles (human
  gates, `agent-refresh --record` checkpoints, push + CI + issue-closure records, and the CodeQL
  transient-state resolution) — every prior "kept as local audit" note lands here.
- `CURRENT.md` refreshed post-#43: active priority now reflects Phase 1 design + Web MVP slices
  1–4b delivered; next candidates and the #45-duplicate housekeeping recorded; do-not-touch list
  extended with the product docs/prototype and the delivered web contracts. No SHAs pinned.
- `.gitignore`: documents the intentional, human-made `+.vscode/mcp.json` line — same MCP-secret
  hygiene family as the existing `.mcp.json`/`.mcp.local.json` ignores (protects the Stitch API
  key per the standing "never commit MCP configs/secrets" rule).
- No product code touched; no feature issues altered; local commit only — push follows the normal
  human gate.

## 2026-07-06 — Push + CI + issue closed (Claude) — #43

- Pushed the approved scope: `77989e3..ffc16e6` (`ffc16e6 feat: implement #11 slice 4b learner identity and auth boundary`). `origin/main` is now at `ffc16e6`.
- CI green: Quality (run 28829219681) and CodeQL (run 28829219337) both passed.
- Issue #43 closed with the delivery summary and acceptance-criteria checklist; Project board item Done via automation.
- Slice 4b done: identity port (dev|cognito seam), learnerId through store + 12 routes, ownership 403 NOT_RESOURCE_OWNER, per-learner mock rule, identity smoke 14/14. Web MVP slices 1–4b complete.
- Next: real Cognito adapter + /api/me + sign-in; §15 progress screen; dedicated governance commit for these EVENTS.md audits.
- Kept as local audit for a dedicated governance commit; not committing/pushing just for bookkeeping.

## 2026-07-06T23:03:01Z — agent-refresh --record

- Status: ok
- Git: ## main...origin/main [ahead 1]
- Unpublished commits:
  - ffc16e6 feat: implement #11 slice 4b learner identity and auth boundary
- Active handoffs: none
- Warnings: none
- Errors: none

## 2026-07-06 — Human gate (push approved) — #43

- Human gate: approved push for #43, commit `ffc16e6 feat: implement #11 slice 4b learner identity and auth boundary` (identity port `resolveLearner` with dev|cognito seam, learnerId through store + 12 routes, ownership 403 NOT_RESOURCE_OWNER, per-learner mock rule, committed identity smoke 14/14; architect amend: README slices 1–4b + package.json description).
- Agent will run `npm run agent-refresh -- --record` immediately before push, then push only this commit, follow Quality/CodeQL, and close #43 if green.
- Out of scope (not pushed): local `.gitignore` change; this EVENTS.md audit stays local until a dedicated governance commit.

## 2026-07-06 — Push + CI + issue closed (Claude) — #42

- Pushed the approved scope: `f93ec34..77989e3` (`77989e3 feat: implement #11 slice 4a persistence boundary for web attempts`). `origin/main` is now at `77989e3`.
- CI green: Quality (run 28819896893) and CodeQL (run 28819896162) both passed — CodeQL running normally again, confirming the earlier gap was transient.
- Issue #42 closed with the delivery summary; Project board item already Done via automation. Duplicate issue #45 remains flagged for human closure.
- Slice 4a done: repository boundary (port + in-memory/file adapters, restart-safe), store refactor with JSON-safe learner-scoped records, restart regression committed, NFT warning eliminated, README at slices 1–4a. Next: slice 4b — Cognito identity over the same records/routes.
- Kept as local audit for a dedicated governance commit; not committing/pushing just for bookkeeping.

## 2026-07-06T20:07:44Z — agent-refresh --record

- Status: ok
- Git: ## main...origin/main [ahead 1]
- Unpublished commits:
  - 77989e3 feat: implement #11 slice 4a persistence boundary for web attempts
- Active handoffs: none
- Warnings: none
- Errors: none

## 2026-07-06 — Human gate (push approved) — #42

- Human gate: approved push for #42, commit `77989e3 feat: implement #11 slice 4a persistence boundary for web attempts` (repository port + in-memory/JSON-file adapters, restart-safe write-through, store refactor with JSON-safe records, committed restart regression; architect amend: #45→#42 refs, Turbopack/NFT warning eliminated, README rewritten for slices 1–4a).
- Agent will run `npm run agent-refresh -- --record` immediately before push, then push only this commit, follow Quality/CodeQL, and close #42 if green.
- Out of scope (not pushed): local `.gitignore` change; this EVENTS.md audit stays local until a dedicated governance commit. Duplicate issue #45 flagged for human closure.

## 2026-07-06 — CodeQL resolution + baseline advance (Claude)

- Follow-up on the #41 CodeQL flag: default setup was **already `configured`** (untouched since 2026-07-01) — the 403 "not enabled" + missing run on `b39805a` was a transient repo-security state while the human worked in Settings → Code security (which also produced `f93ec34 Create SECURITY.md`, pushed directly by Márcio).
- Re-trigger via `PATCH code-scanning/default-setup` ran "CodeQL Setup" successfully; CodeQL analyses are green on `f93ec34` (19:05–19:06Z), which descends from `b39805a` — slice 3 code is scanned and clean.
- Local `main` fast-forwarded to `origin/main` (`f93ec34`); `agent-refresh` ok, in sync.

## 2026-07-06 — Push + CI + issue closed (Claude) — #41

- Pushed the approved scope: `2c30373..b39805a` (`b39805a feat: implement #11 slice 3 review missed and deterministic coach`). `origin/main` is now at `b39805a`.
- CI: Quality green (run 28815656680). **CodeQL did not run — code scanning is now DISABLED at the repository level** (API returns "not enabled"; it ran as default setup on every prior push, last at `2c30373`). Flagged for human decision: re-enable in Settings → Code security if unintentional.
- Issue #41 closed with the delivery summary; item added to the Project board and set to **Done** (issues created via `gh` are not auto-added — #39/#41 were missing; #41 added now).
- Slice 3 closes the post-attempt learning loop: §14 missed review + §4 deterministic coach + onlyMissed drill (blocker fix included). Next: slice 4 — auth + persistence + progress + metrics.
- Kept as local audit for a dedicated governance commit; not committing/pushing just for bookkeeping.

## 2026-07-06T18:54:32Z — agent-refresh --record

- Status: ok
- Git: ## main...origin/main [ahead 1]
- Unpublished commits:
  - b39805a feat: implement #11 slice 3 review missed and deterministic coach
- Active handoffs: none
- Warnings: none
- Errors: none

## 2026-07-06 — Human gate (push approved) — #41

- Human gate: approved push for #41, commit `b39805a feat: implement #11 slice 3 review missed and deterministic coach` (§14 missed review + §4 deterministic coach + review UI parity + wiring; architect blocker fix amended: onlyMissed now includes unanswered mock questions from submitted attempts, with committed regression in smoke-review-coach).
- Agent will run `npm run agent-refresh -- --record` immediately before push, then push only this commit, follow CI, close #41 and move the Board to Done if green.
- Out of scope (not pushed): local `.gitignore` change; this EVENTS.md audit stays local until a dedicated governance commit.

## 2026-07-06 — Push + CI + issue closed (Claude) — #40

- Pushed the approved scope: `b35abf8..2c30373` (`2c30373 feat: implement #11 slice 2 deterministic mock exam flow`). `origin/main` is now at `2c30373`.
- CI green: Quality (run 28803585241) and CodeQL (run 28803583746) both passed.
- Issue #40 closed with the delivery summary (contracts §2/§11–§13, Stitch-parity mock UI, blocker fix + committed blank-mock regression); Project board item already Done via automation.
- Next product item (architect): #11 slice 3 — Review Missed + deterministic Coach (§14 + §4 deterministic mode), closing the post-mock learning loop.
- Kept as local audit for a dedicated governance commit; not committing/pushing just for bookkeeping.

## 2026-07-06T15:36:33Z — agent-refresh --record

- Status: ok
- Git: ## main...origin/main [ahead 1]
- Unpublished commits:
  - 2c30373 feat: implement #11 slice 2 deterministic mock exam flow
- Active handoffs: none
- Warnings: none
- Errors: none

## 2026-07-06 — Human gate (push approved) — #40

- Human gate: approved push for #40, commit `2c30373 feat: implement #11 slice 2 deterministic mock exam flow` (mock exam contracts §2/§11–§13 + kind-aware results, Stitch-parity mock UI, architect blocker fix amended: blank-mock rollup counts unanswered as incorrect, dashboard weakest-null fallback, committed blank-mock regression smoke).
- Agent will run `npm run agent-refresh -- --record` immediately before push, then push only this commit, follow CI, and close #40 if green.
- Out of scope (not pushed): local `.gitignore` change; this EVENTS.md audit stays local until a dedicated governance commit.

## 2026-07-06 — Push + CI + issue closed (Claude) — #39

- Pushed the approved scope: `bee5869..b35abf8` (`b35abf8 feat: align #39 drill loop UI with Stitch prototype`). `origin/main` is now at `b35abf8`.
- CI green: Quality (run 28795631540) and CodeQL (run 28795629361) both passed.
- Issue #39 closed: slice 1 of #11 complete — functional drill loop (`bee5869`) + Stitch UI parity (`b35abf8`), deterministic end to end, contracts untouched (smoke 33/33), parity verified against the canonical prototype via headless screenshots.
- Next slices per `cba-web-mvp-scope.md`: mock exam (2), review missed + deterministic coach (3), real auth + persistence + metrics (4).
- Kept as local audit for a dedicated governance commit; not committing/pushing just for bookkeeping.

## 2026-07-06T13:36:05Z — agent-refresh --record

- Status: ok
- Git: ## main...origin/main [ahead 1]
- Unpublished commits:
  - b35abf8 feat: align #39 drill loop UI with Stitch prototype
- Active handoffs: none
- Warnings: none
- Errors: none

## 2026-07-06 — Human gate (push approved) — #39 UI parity

- Human gate: approved push for the #39 UI parity pass, commit `b35abf8 feat: align #39 drill loop UI with Stitch prototype` (shell + four screens restyled to the canonical Stitch prototype; zero BFF/contract changes; workspace-root warning fixed; devIndicators off; done handoff).
- Agent will run `npm run agent-refresh -- --record` immediately before push, then push only this commit, follow CI, and close #39 if green (functional slice `bee5869` + this parity pass complete the issue).
- Out of scope (not pushed): local `.gitignore` change; this EVENTS.md audit stays local until a dedicated governance commit.

## 2026-07-06T12:34:11Z — agent-refresh --record

- Status: ok
- Git: ## main...origin/main [ahead 1]
- Unpublished commits:
  - bee5869 feat: implement #11 slice 1 deterministic drill loop
- Active handoffs: none
- Warnings: none
- Errors: none

## 2026-07-06 — Human gate (push approved) — #39

- Human gate: approved push for #39, commit `bee5869 feat: implement #11 slice 1 deterministic drill loop` (Next.js drill-loop MVP: dashboard first-run, practice setup, one-question session, deterministic feedback with official source, mini-results; done handoff).
- Architect validation before gate: `agent-refresh` ok; `web npm run build` ok with a Next.js workspace-root warning; root `npm test` 68/68; `node bin/cli.js validate` 60/0; runtime smoke passed against `next start`.
- Agent will run `npm run agent-refresh -- --record` immediately before push, then push only this commit, follow CI, and close #39 if green.
- Out of scope (not pushed): local `.gitignore` change; this EVENTS.md audit stays local until a dedicated governance commit.

## 2026-07-06 — Push + CI + issue closed (Claude) — #38

- Pushed the approved scope: `6400160..5f03c85` (`5f03c85 docs: define second-pass Web BFF contracts for #38`). `origin/main` is now at `5f03c85`.
- CI green: Quality (run 28778869962) and CodeQL (run 28778869635) both passed.
- Issue #38 closed: learner-surface BFF contracts complete (§7–§17, fully deterministic); only Phase 4 admin review actions remain deferred; MVP-scope placeholders cleared.
- #11 (thin web simulator) is unblocked — engineering can build against `web-bff-contracts.md` without guessing endpoints.
- Kept as local audit for a dedicated governance commit; not committing/pushing just for bookkeeping.

## 2026-07-06T08:39:33Z — agent-refresh --record

- Status: ok
- Git: ## main...origin/main [ahead 1]
- Unpublished commits:
  - 5f03c85 docs: define second-pass Web BFF contracts for #38
- Active handoffs: none
- Warnings: none
- Errors: none

## 2026-07-06 — Human gate (push approved) — #38

- Human gate: approved push for #38, commit `5f03c85 docs: define second-pass Web BFF contracts for #38` (contracts §7–§17: practice sessions, mock session flow, missed review, progress, me/preferences; stale deferred refs fixed; MVP-scope placeholders cleared; done handoff).
- Agent will run `npm run agent-refresh -- --record` immediately before push, then push only this commit, follow CI, and close #38 if green.
- Out of scope (not pushed): local `.gitignore` change; this EVENTS.md audit stays local until a dedicated governance commit (architect's standing note).

## 2026-07-06 — Push + CI + issue closed (Claude) — #15

- Pushed the approved scope: `5b026b3..6400160` (`6400160 docs: consolidate CBA Web MVP scope for #15`). `origin/main` is now at `6400160`.
- CI green: Quality (run 28777969467) and CodeQL (run 28777968996) both passed.
- Issue #15 closed referencing the consolidation doc plus #35/#36/#16 as the artifacts satisfying its acceptance criteria; success metrics defined.
- Phase 1 design track complete: #37 → #34 → #35 → #36 → #16 → #15. Next design task flagged: second BFF contract pass (prerequisite for #11 build slices).
- Kept as local audit for the next governance commit; not committing/pushing just for bookkeeping.

## 2026-07-06T08:22:58Z — agent-refresh --record

- Status: ok
- Git: ## main...origin/main [ahead 1]
- Unpublished commits:
  - 6400160 docs: consolidate CBA Web MVP scope for #15
- Active handoffs: none
- Warnings: none
- Errors: none

## 2026-07-06 — Human gate (push approved) — #15

- Human gate: approved push for #15, commit `6400160 docs: consolidate CBA Web MVP scope for #15` (MVP scope consolidation: flow mapping table, five scope decisions, success metrics, build slices; done handoff).
- Agent will run `npm run agent-refresh -- --record` immediately before push, then push only this commit, follow CI, and close #15 if green.
- Out of scope (not pushed): local `.gitignore` change; this EVENTS.md audit stays local until the next governance commit.

## 2026-07-06 — Push + CI + issue closed (Claude) — #16

- Pushed the approved scope: `4a2776c..5b026b3` (`5b026b3 docs: define SaaS data model for #16`). `origin/main` is now at `5b026b3`.
- CI green: Quality (run 28777405185) and CodeQL (run 28777404755) both passed.
- Issue #16 closed with the delivery summary (13 entities, provenance chain, attempt/progress pipeline, #36 endpoint mapping, JSON bank migration mapping, persistence posture without lock-in).
- Kept as local audit for the next governance commit; not committing/pushing just for bookkeeping.

## 2026-07-06T08:12:26Z — agent-refresh --record

- Status: ok
- Git: ## main...origin/main [ahead 1]
- Unpublished commits:
  - 5b026b3 docs: define SaaS data model for #16
- Active handoffs: none
- Warnings: none
- Errors: none

## 2026-07-06 — Human gate (push approved) — #16

- Human gate: approved push for #16, commit `5b026b3 docs: define SaaS data model for #16` (canonical data model incl. architect review pass: ReviewTask/StudyPlan/Tenant sections + JSON bank migration mapping + ERD update; done handoff).
- Agent will run `npm run agent-refresh -- --record` immediately before push, then push only this commit.
- Out of scope (not pushed): local `.gitignore` change; this EVENTS.md audit stays local until the next governance commit.

## 2026-07-06 — Push + CI + issue closed (Claude) — #36

- Pushed the approved scope: `ff0ef8e..4a2776c` (`4a2776c docs: define Web BFF contracts for #36`). `origin/main` is now at `4a2776c`.
- CI green: Quality (run 28772003073) and CodeQL (run 28772002437) both passed.
- Issue #36 closed with the delivery summary (contract doc, screen-map link, done handoff, validations).
- Contracts are design-time only; session/practice/missed/progress/review-action endpoints are deferred to the next contract pass (listed in `docs/product/web-bff-contracts.md`).
- Kept as local audit for the next governance commit; not committing/pushing just for bookkeeping.

## 2026-07-06T06:20:18Z — agent-refresh --record

- Status: ok
- Git: ## main...origin/main [ahead 1]
- Unpublished commits:
  - 4a2776c docs: define Web BFF contracts for #36
- Active handoffs: none
- Warnings: none
- Errors: none

## 2026-07-06 — Human gate (push approved) — #36

- Human gate: approved push for #36, commit `4a2776c docs: define Web BFF contracts for #36` (Web BFF contract docs + screen-map link + done handoff).
- Agent will run `npm run agent-refresh -- --record` immediately before push, then push only this commit.
- Out of scope (not pushed): local `.gitignore` change; this EVENTS.md audit stays local until the next governance commit.

## 2026-07-06 — Push + CI + issue closed (Claude) — #35

- Pushed the approved scope: `6969185..ff0ef8e` (`0469638` design package + `ff0ef8e` Stitch prototype export). `origin/main` is now at `ff0ef8e`.
- CI green: Quality (run 28768570895) and CodeQL (run 28768570668) both passed.
- Issue #35 closed with the delivery summary (commits, canonical package path, validations).
- Canonical prototype: `docs/product/prototypes/stitch-cba-study-coach/` (`manifest.json` = source of truth; stale Stitch upstream duplicates are not part of the package).
- Kept as local audit for the next governance commit; not committing/pushing just for bookkeeping.

## 2026-07-06T04:50:03Z — agent-refresh --record

- Status: ok
- Git: ## main...origin/main [ahead 2]
- Unpublished commits:
  - ff0ef8e docs: add Stitch prototype export for #35
  - 0469638 docs: add #35 frontend prototype design package (screen map + AI design brief)
- Active handoffs: none
- Warnings: none
- Errors: none

## 2026-07-06 — Human gate (push approved) — #35

- Human gate: approved push for #35, commits `0469638` + `ff0ef8e`, scope frontend prototype docs + Stitch export.
- Agent will run `npm run agent-refresh -- --record` immediately before push, then push only these two commits.
- Out of scope (not pushed): local `.gitignore` and pre-existing working-tree changes stay uncommitted.

## 2026-07-06 — Push + CI (Claude)

- Pushed the approved scope: `302cdb4..6969185` (`6969185 fix: stop hardcoding origin main baseline in handoff state`).
- CI green: Quality (run 28764821100) and CodeQL (run 28764821077) both passed.
- Loop broken: post-push `agent-refresh` stays `ok` — `CURRENT.md` no longer pins an origin/main SHA, so advancing origin does not re-stale the baseline.
- Kept as local audit for the next governance commit; not committing/pushing just for bookkeeping.

## 2026-07-06T02:58:04Z — agent-refresh --record

- Status: ok
- Git: ## main...origin/main [ahead 1]
- Unpublished commits:
  - 6969185 fix: stop hardcoding origin main baseline in handoff state
- Active handoffs: none
- Warnings: none
- Errors: none

## 2026-07-06 — Human gate (push approved)

- Codex/architect approved the fix; human confirmed push of exactly this commit:
  - `6969185 fix: stop hardcoding origin main baseline in handoff state`
- Approved scope: stop hardcoding the origin/main baseline SHA in the handoff state (agent-refresh warn-not-block, CURRENT.md stable text, README no-hardcode rule, tests, EVENTS.md audit).
- Agent will run `npm run agent-refresh -- --record` immediately before push, then push only this commit.

## 2026-07-06 — Fix: stop hardcoding origin/main baseline (Claude)

- Root cause: pinning the `origin/main` baseline SHA in `CURRENT.md` goes stale on every push and blocked the next boot (reconcile loop).
- `CURRENT.md`: replaced the pinned origin/main SHA with a stable rule (`git rev-parse --short origin/main` / `git log -1 --oneline origin/main`).
- `agent-refresh`: a stale pinned origin/main baseline is now a WARNING, not a blocker; a hardcoded unpublished/amendable local SHA still blocks.
- `README.md`: the no-hardcode rule now covers published and local SHAs.
- Tests: stale-baseline test now asserts warn-not-block; added a no-pinned-SHA-passes test; kept the local-SHA-blocks test.
- No push (pending Codex/architect review).

## 2026-07-06 — Push + CI (Claude)

- Pushed the approved scope: `7d69262..302cdb4` (`d5e34bb docs: reconcile agent handoff state after push`, `302cdb4 docs: add agent command reference`).
- CI green: Quality (run 28764276198) and CodeQL (run 28764276006) both passed.
- `origin/main` is now at `302cdb4`.
- Follow-up: `CURRENT.md` baseline (`7d69262`) is now stale vs `origin/main` (`302cdb4`) — reconcile it in the next governance commit; `agent-refresh` will flag it until then.
- This audit is committed as part of the handoff-baseline fix (see the Fix event above), not a local uncommitted note.

## 2026-07-06T02:40:10Z — agent-refresh --record

- Status: ok
- Git: ## main...origin/main [ahead 2]
- Unpublished commits:
  - 302cdb4 docs: add agent command reference
  - d5e34bb docs: reconcile agent handoff state after push
- Active handoffs: none
- Warnings: none
- Errors: none

## 2026-07-06 — Human gate

- Human approved push in chat of exactly these two commits:
  - `d5e34bb docs: reconcile agent handoff state after push`
  - `302cdb4 docs: add agent command reference`
- Approved scope: reconcile handoff state after the previous push; add `.agent-handoff/COMMANDS.md`; update `.agent-handoff/README.md` to reference COMMANDS.md.
- Agent will run `npm run agent-refresh -- --record` immediately before push, then push only this approved scope.

## 2026-07-06T02:06:36Z — agent-refresh --record

- Status: ok
- Git: ## main...origin/main
- Unpublished commits: none
- Active handoffs: none
- Warnings: none
- Errors: none

## 2026-07-06 — Claude

- Reconciled stale `CURRENT.md` after push: updated the `origin/main` baseline `962300e` -> `7d69262`.
- Removed stale text implying unpublished local handoff/agent-refresh work; `main` is in sync with `origin/main` (ahead 0).
- Kept the prior `agent-refresh --record` blocked event below as valid history.
- No push performed.

## 2026-07-06T02:04:39Z — agent-refresh --record

- Status: blocked
- Git: ## main...origin/main
- Unpublished commits: none
- Active handoffs: none
- Warnings: none
- Errors:
  - CURRENT.md origin/main baseline is stale: 962300e != 7d69262

## 2026-07-06T01:41:29Z — agent-refresh --record

- Status: ok
- Git: ## main...origin/main [ahead 2]
- Unpublished commits:
  - 9f225d3 feat: add agent-refresh handoff state check
  - 6062f68 docs: add agent handoff protocol
- Active handoffs: none
- Warnings: none
- Errors: none

## 2026-07-06T01:41:02Z — Human gate

- Human approved push in chat with: `pode pushar`.
- Approved scope: agent handoff protocol plus agent-refresh handoff state check.
- Current unpublished commits at approval checkpoint:
  - `6062f68 docs: add agent handoff protocol`
  - `b41ce1b feat: add agent-refresh handoff state check`
- Agent must run `npm run agent-refresh -- --record` immediately before push and push only this approved governance scope.

## 2026-07-06 — Codex

- Completed Push gate protocol documentation locally.
- Moved `.agent-handoff/active/push-gate-protocol.md` to `.agent-handoff/done/push-gate-protocol.md`.
- No push performed.

## 2026-07-06 — Codex

- Documented Push gate semantics.
- `agent-refresh --record` is a technical checkpoint only; it does not authorize push.
- Push requires explicit human approval plus a `Human gate` event in `EVENTS.md`, then `npm run agent-refresh -- --record` immediately before push.
- No push performed.

## 2026-07-06T01:30:00Z — agent-refresh --record

- Status: ok
- Git: ## main...origin/main [ahead 2]
- Unpublished commits:
  - 632a4c1 feat: add agent-refresh handoff state check
  - 6062f68 docs: add agent handoff protocol
- Active handoffs: none
- Warnings: none
- Errors: none

## 2026-07-06 — Codex

- Completed `agent-refresh --record` support locally.
- Moved `.agent-handoff/active/agent-refresh-record.md` to `.agent-handoff/done/agent-refresh-record.md`.
- Validation: `node --check`, `node bin/cli.js agent-refresh --json`, `git diff --check`, and `npm test` passed (67/67).
- No push performed.

## 2026-07-06 — Codex

- Implemented explicit `agent-refresh --record` support after user tried the flag and it was ignored.
- `--record` appends an audit entry to `.agent-handoff/EVENTS.md`; normal `agent-refresh` remains read-only.
- No push performed.

## 2026-07-06 — Codex

- Completed `agent-refresh` CLI automation locally.
- Moved `.agent-handoff/active/agent-refresh-cli.md` to `.agent-handoff/done/agent-refresh-cli.md`.
- Validation: `node bin/cli.js agent-refresh --json`, `node --check`, `git diff --check`, and `npm test` passed (66/66).
- No push performed.

## 2026-07-05 — Codex

- Started `agent-refresh` CLI automation for the handoff protocol.
- Added `.agent-handoff/active/agent-refresh-cli.md` to mark task ownership while editing.
- No push performed.

## 2026-07-05 — Claude

- Removed stale unpublished commit SHA from `CURRENT.md`.
- Agents must use `git log --oneline origin/main..HEAD` for exact local unpublished commits.
- No push performed.

## 2026-07-05 23:05 BRT — Codex

- Added 5-minute state refresh cadence to the agent handoff protocol.
- Added `EVENTS.md` as the append-only coordination log.
- Updated `CURRENT.md` to record the local handoff-protocol commit pending human-approved push.
- No push performed.

## 2026-07-05 22:55 BRT — Codex

- Created local commit `b0c77f7 docs: add agent handoff protocol`.
- Added `.agent-handoff/README.md`, `CURRENT.md`, task/decision templates, and flow folders.
- Updated `AGENTS.md` with the required agent collaboration boot sequence.
- Validation: `git diff --check` and `npm test` passed.
- No push performed.
