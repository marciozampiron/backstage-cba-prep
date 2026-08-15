import { createHash } from 'node:crypto';

// Closed-schema validator for `spec/authority-policy.json` (#93) — PURE logic, no I/O.
//
// WHY THIS IS CODE AND NOT A LIST OF TEST ASSERTIONS. The policy is the authoritative statement of who
// may authorize what. If the vocabulary it is checked against lived inside the policy, the policy
// could widen its own bounds by adding an entry; if it lived only in scattered assertions, a new key
// or a new actor would simply go unchecked. The vocabulary therefore lives here, in code, and the
// policy is validated against it the way the execution gate is validated against its nine keys:
// exact key sets, exact member sets, every reference resolved, and nothing unknown tolerated.
//
// The prose scanner in the test suite is advisory. THIS is the guarantee.

/** Policy versions this validator understands. An unknown version fails closed. */
export const SUPPORTED_VERSIONS = [1];

/** Exact top-level keys. */
const TOP_LEVEL = ['$comment', 'version', 'actors', 'documents', 'effects', 'governedSurfaces', 'surfaceClassification', 'allowedAuthorityStatements'];

/** Exact actor set and their exact keys. */
const ACTORS = ['opus', 'codex', 'zamp', 'gemini'];
const ACTOR_KEYS = ['role', 'may', 'mayNever'];
const ACTOR_OPTIONAL_KEYS = ['note'];

/** The complete capability vocabulary. An actor may not reference anything outside it. */
export const CAPABILITIES = [
  // things an actor can legitimately be granted
  'commit-on-task-branch',
  'validate',
  'prepare-artifact',
  'operate-artifact-under-execution-gate',
  'review-read-only',
  'report-findings',
  'recommend-gate',
  'author-review-scope',
  'grant-execution-gate',
  'accept-risk',
  'authorize-spend',
  'author-cloud-authorization',
  'perform-cloud-effect',
  'merge',
  // things that appear only as prohibitions
  'self-review',
  'self-approve',
  'deploy',
  'push',
  'push-integration-branch',
  'force-push',
  'administer-repository',
  'rewrite-reviewed-history',
  'access-secrets',
  'invoke-paid-service',
  'implement',
  'operate-artifact',
  'grant-human-gate',
  'delegate-approval',
  'delegate-merge',
  // Round I7-2: the blanket workflow/governance ban was NARROWED to this — the seated persona
  // HAS a role in the flow (read-only auditor); what no amendment may ever grant it is AUTHORITY.
  'any-authority-bearing-role',
];

/**
 * Capabilities no actor may ever be granted.
 *
 * `merge` is deliberately absent: it is Zamp's to perform. What is here is the set whose presence in
 * any `may` list would contradict the protocol itself rather than merely reassign a task.
 */
export const NEVER_GRANTABLE = [
  'self-review',
  'self-approve',
  'force-push',
  'push-integration-branch',
  'administer-repository',
  'rewrite-reviewed-history',
  'access-secrets',
  'invoke-paid-service',
  'grant-human-gate',
  'delegate-approval',
  'delegate-merge',
  // Round I7-2: the blanket workflow/governance ban was NARROWED to this — the seated persona
  // HAS a role in the flow (read-only auditor); what no amendment may ever grant it is AUTHORITY.
  'any-authority-bearing-role',
];

/**
 * The EXACT authority matrix.
 *
 * A closed vocabulary is not a closed policy. Checking only that each capability is a known word left
 * the assignments wide open, and five adversarial mutations were accepted: `grant-execution-gate`
 * added to Opus, `authorize-spend` added to Codex, the execution gate written by Opus, the pull
 * request performed by Codex, and deploy performed by Opus. Each of those transfers human authority or
 * an operational effect while every word in the document remains legal.
 *
 * So the assignments themselves are pinned here, exactly. Widening a role now requires editing this
 * file — which is code, reviewed as code — rather than editing a data file the code merely spellchecks.
 */
const EXPECTED_ACTORS = {
  opus: {
    role: 'implementation executor and publication operator',
    may: ['commit-on-task-branch', 'validate', 'prepare-artifact', 'operate-artifact-under-execution-gate'],
    mayNever: ['self-review', 'self-approve', 'merge', 'deploy', 'push-integration-branch', 'force-push', 'administer-repository', 'rewrite-reviewed-history', 'access-secrets', 'invoke-paid-service', 'author-cloud-authorization', 'perform-cloud-effect'],
  },
  codex: {
    role: 'architect and independent technical/security reviewer',
    may: ['review-read-only', 'report-findings', 'recommend-gate'],
    mayNever: ['implement', 'prepare-artifact', 'operate-artifact', 'push', 'merge', 'deploy', 'grant-human-gate', 'access-secrets', 'invoke-paid-service', 'author-cloud-authorization', 'perform-cloud-effect'],
  },
  zamp: {
    role: 'approval, risk acceptance and merge authority',
    may: ['author-review-scope', 'grant-execution-gate', 'accept-risk', 'authorize-spend', 'author-cloud-authorization', 'perform-cloud-effect', 'merge'],
    mayNever: ['delegate-approval', 'delegate-merge'],
  },
  gemini: {
    // Slice I7: the persona is SEATED — and seated as NOTHING BUT an auditor. may stays empty
    // on purpose: the persona performs no effect; Zamp performs the paid invocation
    // (invoke-paid-model-audit), and the report is that effect's output.
    role: 'read-only semantic auditor — the Gemini Spec Auditor persona; no authority of any kind',
    may: [],
    mayNever: ['accept-risk', 'access-secrets', 'any-authority-bearing-role', 'author-cloud-authorization', 'authorize-spend', 'deploy', 'grant-human-gate', 'implement', 'invoke-paid-service', 'merge', 'operate-artifact', 'perform-cloud-effect', 'prepare-artifact', 'push'],
  },
};

/** The EXACT document matrix — every field value, not only the key set. */
const EXPECTED_DOCUMENTS = {
  'review-scope': {
    writtenBy: 'zamp',
    writtenWhen: 'before preparation',
    suppliedAs: '--gate',
    filenameConvention: '/tmp/cba-scope-<issue>.json',
    bounds: ['preparation', 'review'],
    authorizes: [],
  },
  'execution-gate': {
    writtenBy: 'zamp',
    writtenWhen: 'after review',
    suppliedAs: 'CBA_EXECUTION_GATE',
    filenameConvention: '/tmp/cba-gate-<issue>.json',
    messageType: 'HUMAN_GATE_GRANTED',
    boundTo: 'artifactDigest',
    authorizes: ['push-reviewed-commit-to-task-branch', 'create-or-reuse-one-pull-request'],
  },
  // #70 design round 3: publication authority, cloud authority and spend authority are THREE
  // instruments, not one. Conflating them let a runbook read the publication gate as permission
  // to mutate an account. Each is Zamp's, each names its own effects, none substitutes another.
  'cloud-authorization': {
    writtenBy: 'zamp',
    writtenWhen: 'per decision, before each cloud effect',
    suppliedAs: 'CBA_CLOUD_GATE',
    // Rounds 4-5: binding the release SHA and the assembly digest left the rest of the manifest
    // outside the authorization — and one document holding four effects could not prove that a
    // plan_only value cannot execute or abandon. The instrument binds its MODE, its decision,
    // its window and a digest of the COMPLETE closed manifest; `modes` says, as data, exactly
    // which effect each mode authorizes.
    boundTo: 'mode+decisionId+manifestDigest+stacks+planDigest+window',
    authorizes: ['deploy', 'prepare-change-sets', 'execute-change-sets', 'abandon-change-sets'],
    // `modes` is deliberately NOT pinned to a literal here. Round 5's reversion proof showed why:
    // with an identical literal in this file, every mode mutation was refused by the literal
    // comparison, so the partition law below could be deleted with the whole suite still green —
    // a control nothing can make fire. The two layers are now distinct and each is provable:
    // this file enforces the LAW (closed vocabulary, partition, membership), and the reviewed
    // VALUE is pinned in test/governance-model.test.js against the real file.
  },
  'spend-authorization': {
    writtenBy: 'zamp',
    writtenWhen: 'per paid run',
    suppliedAs: 'out-of-band record',
    boundTo: 'model+ceilings',
    authorizes: ['invoke-paid-model-audit'],
  },
  // Round 6: the stack-record cleanup effect named the cloud instrument, which did not authorize
  // it and gave it no mode — a dangling reverse reference that left the effect unauthorizable.
  // Folding it into the cloud instrument would have been worse: `CBA_CLOUD_GATE` is an
  // Environment variable a LANE reads, and the one thing this effect must never be is
  // machine-consumable. It gets its own instrument, supplied the way the spend one is — an
  // out-of-band human record with nothing to read it — bound to the exact stack, the status
  // observed and the instant of that observation, because the whole hazard is a stale reading.
  'stack-record-authorization': {
    writtenBy: 'zamp',
    writtenWhen: 'per stack record, immediately after observing its status',
    suppliedAs: 'out-of-band record',
    // Round 7: `observedAt` recorded WHEN someone looked and constrained nothing. The binding now
    // names the account, the region, the stack NAME and its immutable ARN (a name can be deleted
    // and recreated; the recreation is a different stack the same name addresses), the exact
    // status, and the instant — with a hard age limit below.
    boundTo: 'issue+decisionId+environment+account+region+stackName+stackId+observedStatus+observedAt',
    maxObservationAgeMinutes: 15,
    authorizes: ['delete-review-in-progress-stack-record'],
    // …and even a fresh, complete, re-verified observation cannot close the gap: DeleteStack has
    // no compare-and-delete, so the stack can acquire resources between the last read and the
    // call. That residual is Zamp's to accept or refuse — never Opus's — so until a risk
    // acceptance exists, this effect has NO executable procedure and no runbook may carry a
    // command that performs it.
    residualRisk: 'TOCTOU: CloudFormation offers no compare-and-delete, so the stack can change between the final re-observation and DeleteStack',
    // Round 8: a boolean is not a decision. `riskAccepted: false` could be flipped alongside
    // `executableProcedure` in one edit, and nothing in the DATA said what an acceptance must
    // contain. Acceptance is now a RECORD or nothing: null here, and any non-null value must be
    // the closed shape the validator enforces below — finding, justification, compensating
    // controls, Zamp as the accepting owner, review date and expiry. The record reaches this
    // file only through a reviewed commit, which is the gate; the shape law is what makes a
    // quiet two-literal flip impossible.
    riskAcceptance: null,
    executableProcedure: false,
  },
};

/** The EXACT effect matrix — who authorizes it and who performs it. */
const EXPECTED_EFFECTS = {
  'push-reviewed-commit-to-task-branch': { authorizedBy: 'execution-gate', performedBy: 'opus' },
  'create-or-reuse-one-pull-request': { authorizedBy: 'execution-gate', performedBy: 'opus' },
  merge: { authorizedBy: 'MERGE_DECISION', performedBy: 'zamp' },
  deploy: { authorizedBy: 'cloud-authorization', performedBy: 'zamp' },
  // Preparing a change set IS a cloud effect: it creates CloudFormation resources and publishes
  // assets. It is named separately from execution so an authorization can cover one and not the
  // other, and so neither can be read as covered by the publication instrument.
  'prepare-change-sets': { authorizedBy: 'cloud-authorization', performedBy: 'zamp' },
  'execute-change-sets': { authorizedBy: 'cloud-authorization', performedBy: 'zamp' },
  // Deleting a prepared change set is a cloud mutation with its own decision: a declined plan
  // stays EXECUTABLE until it is deleted, so cleanup cannot ride on the decision that declined.
  'abandon-change-sets': { authorizedBy: 'cloud-authorization', performedBy: 'zamp' },
  // Round 5: removing the empty stack RECORD a CREATE change set leaves behind is a DIFFERENT
  // effect from deleting a change set, and it is deliberately not automated — DeleteStack has
  // no expected-status precondition, and the release lock does not constrain an external
  // CloudFormation actor, so a stale observation could authorize deleting a stack that acquired
  // resources meanwhile. It is modelled here so the matrix can express it, and performed by a
  // human under its own decision, never by a lane.
  'delete-review-in-progress-stack-record': { authorizedBy: 'stack-record-authorization', performedBy: 'zamp', note: 'human-performed only; no automated lane may perform it' },
  'invoke-paid-model-audit': { authorizedBy: 'spend-authorization', performedBy: 'zamp' },
};

/** Exact document set and keys. */
const DOCUMENTS = ['review-scope', 'execution-gate', 'cloud-authorization', 'spend-authorization', 'stack-record-authorization'];
const DOCUMENT_KEYS = {
  'review-scope': ['writtenBy', 'writtenWhen', 'suppliedAs', 'filenameConvention', 'bounds', 'authorizes'],
  'execution-gate': ['writtenBy', 'writtenWhen', 'suppliedAs', 'filenameConvention', 'messageType', 'boundTo', 'authorizes'],
  'cloud-authorization': ['writtenBy', 'writtenWhen', 'suppliedAs', 'boundTo', 'authorizes', 'modes'],
  'spend-authorization': ['writtenBy', 'writtenWhen', 'suppliedAs', 'boundTo', 'authorizes'],
  'stack-record-authorization': ['writtenBy', 'writtenWhen', 'suppliedAs', 'boundTo', 'maxObservationAgeMinutes', 'authorizes', 'residualRisk', 'riskAcceptance', 'executableProcedure'],
};

/** Exact effect set and keys. */
const EFFECTS = ['push-reviewed-commit-to-task-branch', 'create-or-reuse-one-pull-request', 'merge', 'deploy', 'prepare-change-sets', 'execute-change-sets', 'abandon-change-sets', 'delete-review-in-progress-stack-record', 'invoke-paid-model-audit'];
const EFFECT_KEYS = ['authorizedBy', 'performedBy'];
/** Effects that change cloud state. Each is authorized by a CLOUD INSTRUMENT and performed by
 * Zamp — preparing a change set is here because it creates resources and publishes assets. */
const CLOUD_EFFECTS = ['deploy', 'prepare-change-sets', 'execute-change-sets', 'abandon-change-sets', 'delete-review-in-progress-stack-record'];
/**
 * The closed set of instruments that may authorize a cloud effect. Two, not one, and the split is
 * the point: the lane-readable instrument covers what a lane performs, and the out-of-band one
 * covers the effect no lane may perform. The publication gate is in neither.
 */
const CLOUD_INSTRUMENTS = ['cloud-authorization', 'stack-record-authorization'];
/** The closed mode vocabulary of the cloud instrument. A value outside it authorizes nothing. */
const CLOUD_MODES = ['plan_only', 'deploy', 'abandon'];
const EFFECT_OPTIONAL_KEYS = ['note'];

/**
 * The instrument/effect relation, in BOTH directions, as one law over two matrices.
 *
 * Round 6 found `delete-review-in-progress-stack-record` naming the cloud instrument while that
 * instrument neither authorized it nor gave it a mode: an effect that read as authorized and could
 * not be authorized by any value. Three things had to be true at once for that to survive — the
 * forward check only walked documents' `authorizes` lists, so an effect in NO list was never
 * visited; the reverse direction was unchecked; and the pinned literals in this file agreed with
 * the defect, so no data comparison could contradict it.
 *
 * The fix is a law that takes its two matrices as ARGUMENTS. It runs over the loaded policy inside
 * `validate`, and over this file's own literals at import time — a pin that contradicts itself
 * cannot even load — and a test can call it directly with a deliberately dangling pair, which is
 * the only way to prove a rule whose production inputs are supposed to be correct.
 *
 * @param {Record<string, {authorizedBy: string}>} effects
 * @param {Record<string, {authorizes: string[], modes?: Record<string, string[]>}>} documents
 * @param {string} label - what to call these matrices in a failure message
 */
export function assertAuthorityAgreement(effects, documents, label) {
  for (const [name, effect] of Object.entries(effects)) {
    const source = effect.authorizedBy;
    if (!DOCUMENTS.includes(source)) continue; // MERGE_DECISION is a message, not a document
    const doc = documents[source];
    if (!doc) fail(`${label}.effects.${name}.authorizedBy names "${source}", which is not a declared document.`);
    if (!doc.authorizes.includes(name)) {
      fail(`${label}.effects.${name}.authorizedBy is "${source}", but that document does not authorize ${name}.`);
    }
    // An instrument that distinguishes modes must place every effect it authorizes in one of them,
    // or the effect is authorized by the document and by no value the document can take.
    if (doc.modes && !Object.values(doc.modes).some((list) => list.includes(name))) {
      fail(`${label}.effects.${name} is authorized by "${source}", whose modes place it in none of them.`);
    }
  }
  for (const [source, doc] of Object.entries(documents)) {
    for (const name of doc.authorizes) {
      if (!effects[name]) fail(`${label}.documents.${source}.authorizes references unknown effect "${name}".`);
      if (effects[name].authorizedBy !== source) {
        fail(`${label}.effects.${name}.authorizedBy must be "${source}" because that document authorizes it.`);
      }
    }
  }
}

/**
 * What may appear in `effects[*].authorizedBy`.
 *
 * `"none"` is deliberately NOT here. It was in an earlier draft for merge and deploy, and it was
 * wrong in a way that mattered: merge is authorized by Zamp's `MERGE_DECISION`, and deploy requires
 * its own human gate. Recording either as unauthorized-by-anything would read as "no gate needed".
 *
 * `"separate-human-gate"` is gone too, and for the same reason one level up: it was a placeholder
 * for an instrument that now exists. Deploy is authorized by the `cloud-authorization` document
 * (#70 design round 3), which is named, bound and Zamp's — a placeholder cannot be validated.
 */
const AUTHORIZATION_SOURCES = [...DOCUMENTS, 'MERGE_DECISION'];

/**
 * The closed shape of a risk acceptance. A boolean is not a decision (round 8), and a free-text
 * record is not an ENFORCEABLE one (round 9): without digests and coverage fields, a future
 * activation could ride on an unrelated finding, a different stack's decision, or an acceptance
 * whose expiry only ever existed as prose. The four round-9 keys bind it:
 *  - `residualRiskSha256` digests THIS instrument's exact residualRisk text — edit the finding
 *    and the acceptance detaches, structurally;
 *  - `coversStackId` and `coversCleanupDecisionId` scope the acceptance to ONE stack record and
 *    ONE cleanup decision — an acceptance is never a class-wide waiver;
 *  - `zampStatementSha256` digests Zamp's VERBATIM written decision, because `acceptedBy: "zamp"`
 *    typed by an executor proves nothing; independent review verifies the transcript against the
 *    statement the digest names.
 */
const RISK_ACCEPTANCE_KEYS = ['acceptedBy', 'decisionId', 'finding', 'justification', 'compensatingControls', 'acceptedAt', 'reviewBy', 'expiresAt', 'boundToEffect', 'residualRiskSha256', 'coversCleanupAuthorizationSha256', 'coversCleanupDecisionId', 'zampStatement'];
/** The closed shape of the statement pointer: source, LOCATOR, normalization and canonical
 * bytes — round 10 fixed the bytes, round 11 fixed the address: a source CLASS plus a timestamp
 * finds nothing univocally, so the pointer names the decision file and the commit that
 * introduced it, both verifiable from history. */
const ZAMP_STATEMENT_KEYS = ['source', 'locator', 'sentAt', 'encoding', 'bytes', 'sha256'];
const ZAMP_STATEMENT_LOCATOR_KEYS = ['path', 'introducedIn'];
const DECISION_FILE_RE = /^\.agent-handoff\/decisions\/[a-z0-9][a-z0-9-]*\.md$/;
const COMMIT_SHA_RE = /^[0-9a-f]{40}$/;
const SHA256_HEX_RE = /^[0-9a-f]{64}$/;

/**
 * §6b `bundle` framing over ONE record, as the single shared implementation — round 11: two
 * reviewers framing the same bytes with different record names or media types produce different
 * digests, both "compatible with the prose", which is no canon at all. Everything is pinned
 * here: the envelope shape, the record shape, and the content hash inside it.
 */
export function framedBundleDigest({ producer, name, mediaType, content }) {
  const bytes = typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
  const doc = {
    digestKind: 'bundle',
    version: 1,
    producer,
    records: [{
      name,
      mediaType,
      bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    }],
  };
  return createHash('sha256').update(JSON.stringify(doc), 'utf8').digest('hex');
}

/** The exact envelope of Zamp's verbatim decision statement: the record NAME carries the
 * COMPLETE locator — path AND introducing commit — so the digest and the locator can never
 * disagree about identity. Round 12: with only the path in the envelope, two locators differing
 * in `introducedIn` kept the same digest, which is exactly the disagreement the name exists to
 * prevent. */
export const ZAMP_STATEMENT_MEDIA_TYPE = 'text/markdown';
export function zampStatementDigest(locator, content) {
  if (!isPlainObject(locator) || typeof locator.path !== 'string' || typeof locator.introducedIn !== 'string') {
    throw new PolicyError('zampStatementDigest requires the complete locator: { path, introducedIn }.');
  }
  return framedBundleDigest({
    producer: 'zamp',
    name: `${locator.path}@${locator.introducedIn}`,
    mediaType: ZAMP_STATEMENT_MEDIA_TYPE,
    content,
  });
}

/**
 * The reproducible verification of a statement locator against HISTORY — round 12: a SHA that
 * merely looks like a SHA proves nothing. `git` is injected exactly like the resolve-run
 * helper's `exec`, so the four steps are testable against a scripted history and runnable
 * verbatim by review and by the runtime consumer against the real repository:
 *   1. the commit exists;
 *   2. it is an ancestor of the reviewed HEAD;
 *   3. it ADDED the file at the locator's path (not modified it, not merely contained it);
 *   4. the blob at that path in that commit has the recorded byte length and, digested under
 *      the statement envelope WITH this locator, the recorded sha256.
 * Every failure is a named refusal; ok is only ok when all four hold.
 *
 * Round 13: `reviewedHead` is itself part of the proof, so it obeys the protocol's identity
 * rule — a full lowercase 40-character SHA, confirmed to exist, BEFORE any ancestry test.
 * `HEAD` and a branch name are moving targets: a statement introduced after the actually
 * reviewed commit would become "an ancestor of HEAD" the moment anything advances.
 */
export function verifyStatementLocator({ locator, bytes, sha256, reviewedHead, git }) {
  if (typeof reviewedHead !== 'string' || !COMMIT_SHA_RE.test(reviewedHead)) {
    return { ok: false, reason: 'REVIEWED_HEAD_NOT_A_FULL_SHA' };
  }
  try {
    git('git', ['cat-file', '-e', `${reviewedHead}^{commit}`]);
  } catch {
    return { ok: false, reason: 'REVIEWED_HEAD_MISSING' };
  }
  try {
    git('git', ['cat-file', '-e', `${locator.introducedIn}^{commit}`]);
  } catch {
    return { ok: false, reason: 'LOCATOR_COMMIT_MISSING' };
  }
  try {
    git('git', ['merge-base', '--is-ancestor', locator.introducedIn, reviewedHead]);
  } catch {
    return { ok: false, reason: 'LOCATOR_COMMIT_NOT_ANCESTOR' };
  }
  let changes;
  try {
    changes = git('git', ['diff-tree', '--no-commit-id', '--name-status', '-r', '--root', locator.introducedIn]);
  } catch {
    return { ok: false, reason: 'LOCATOR_COMMIT_UNREADABLE' };
  }
  const entry = String(changes).split('\n').map((l) => l.split('\t')).find((cols) => cols[1] === locator.path);
  if (!entry || entry[0] !== 'A') return { ok: false, reason: 'LOCATOR_FILE_NOT_ADDED_THERE' };
  let content;
  try {
    content = git('git', ['show', `${locator.introducedIn}:${locator.path}`]);
  } catch {
    return { ok: false, reason: 'LOCATOR_BLOB_MISSING' };
  }
  const buf = Buffer.from(String(content), 'utf8');
  if (buf.length !== bytes) return { ok: false, reason: 'LOCATOR_BYTES_MISMATCH' };
  if (zampStatementDigest(locator, buf) !== sha256) return { ok: false, reason: 'LOCATOR_CONTENT_MISMATCH' };
  return { ok: true };
}

/** The exact envelope of the out-of-band cleanup authorization value: nine keys, THIS order —
 * and round 12 made the shape a PRECONDITION, not a projection: an extra key silently dropped
 * and a missing key silently serialized away meant this was a digest of what the function kept,
 * not of the value presented. Anything but the exact closed object REFUSES. (The full per-key
 * grammar parser remains SPEC-DEPLOY-022's activation obligation; this function refuses shape,
 * the parser will refuse content.) */
export const CLEANUP_VALUE_KEY_ORDER = ['issue', 'decisionId', 'environment', 'account', 'region', 'stackName', 'stackId', 'observedStatus', 'observedAt'];
export function cleanupAuthorizationDigest(value) {
  if (!isPlainObject(value)) {
    throw new PolicyError('cleanup authorization value must be a plain object.');
  }
  const got = Object.keys(value).sort();
  const want = [...CLEANUP_VALUE_KEY_ORDER].sort();
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    const extra = got.filter((k) => !want.includes(k));
    const missing = want.filter((k) => !got.includes(k));
    throw new PolicyError(`cleanup authorization value must have exactly the nine closed keys — a digest of a projection is not a digest of the value presented (extra: [${extra.join(', ')}]; missing: [${missing.join(', ')}]).`);
  }
  for (const key of CLEANUP_VALUE_KEY_ORDER) {
    const v = value[key];
    if (key === 'issue') {
      if (v !== 70) throw new PolicyError('cleanup authorization value.issue must be the integer 70.');
    } else if (typeof v !== 'string' || v.trim() === '') {
      throw new PolicyError(`cleanup authorization value.${key} must be a non-empty string; a present-but-undefined key would vanish in serialization and two different values would share a digest.`);
    }
  }
  const ordered = {};
  for (const key of CLEANUP_VALUE_KEY_ORDER) ordered[key] = value[key];
  return framedBundleDigest({
    producer: 'zamp',
    name: 'stack-record-authorization-value',
    mediaType: 'application/json',
    content: JSON.stringify(ordered),
  });
}

/**
 * §6b `text` framing, as ONE function both the validator and any future tooling share. Round 10:
 * `sha256(raw text)` violated the project's own digest law — every digest carries its kind,
 * version and subject INSIDE the digested bytes, so a text digest can never be confused with a
 * bundle digest over the same characters, and a trailing newline is a different document.
 */
export function framedTextDigest(subject, text) {
  const doc = {
    digestKind: 'text',
    version: 1,
    records: [{ subject, encoding: 'utf-8', bytes: Buffer.byteLength(text, 'utf8'), text }],
  };
  return createHash('sha256').update(JSON.stringify(doc), 'utf8').digest('hex');
}
const DECISION_ID_RE = /^[A-Za-z0-9._-]{8,64}$/;
/** Strict RFC3339 UTC to whole seconds, calendar round-trip — the deploy lane's rule, applied to
 * governance instants for the same reason: Date.parse alone normalizes 2026-02-30 into March. */
const STRICT_UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
function strictUtcInstant(v) {
  if (typeof v !== 'string' || !STRICT_UTC_RE.test(v)) return false;
  const ms = Date.parse(v);
  return !Number.isNaN(ms) && new Date(ms).toISOString() === v.replace('Z', '.000Z');
}

// The pinned matrices are held to the same law as the data they validate. A literal that names an
// instrument which does not name it back stops this module from loading at all.
assertAuthorityAgreement(EXPECTED_EFFECTS, EXPECTED_DOCUMENTS, 'EXPECTED');

/** Surfaces whose statements the policy governs. Every cold-start document, template and skill. */
export const REQUIRED_SURFACES = [
  'AGENTS.md',
  '.agent-handoff/MESSAGE-PROTOCOL.md',
  '.agent-handoff/README.md',
  '.agent-handoff/COMMANDS.md',
  '.agent-handoff/CURRENT.md',
  '.agent-handoff/publish-gates/README.md',
  '.agent-handoff/templates/task.md',
  '.agent-handoff/templates/message.md',
  '.agent-handoff/templates/decision.md',
  '.agent-handoff/done/93-human-publication-script.md',
  'spec/security-rules.md',
  'docs/architecture/agent-publication-runbook.md',
  'bin/cli.js',
  '.claude/skills/publication-prepare/SKILL.md',
  '.claude/skills/security-review/SKILL.md',
  '.agents/skills/publication-review/SKILL.md',
  '.agents/skills/review-security/SKILL.md',
];

/**
 * How an operational source relates to authority.
 *
 * Every discovered operational source must be exactly one of these. A source with no classification is
 * a failure, not a default — that gap is how `CURRENT.md`, the #93 handoff and the CLI help sat
 * outside the authoritative allowlist while looking covered.
 */
export const SURFACE_CLASSES = ['canonical-authority', 'link-only', 'historical'];

export class PolicyError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PolicyError';
  }
}

const fail = (message) => {
  throw new PolicyError(message);
};

const isPlainObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Exact key comparison: nothing missing, nothing extra. */
function assertKeys(label, obj, required, optional = []) {
  if (!isPlainObject(obj)) fail(`${label} must be an object.`);
  const keys = Object.keys(obj);
  const allowed = new Set([...required, ...optional]);
  const unknown = keys.filter((k) => !allowed.has(k));
  if (unknown.length) fail(`${label} has unknown key(s): ${unknown.join(', ')}.`);
  const missing = required.filter((k) => !keys.includes(k));
  if (missing.length) fail(`${label} is missing key(s): ${missing.join(', ')}.`);
}

/** Exact member comparison for a set of names. */
function assertMembers(label, actual, expected) {
  const a = new Set(actual);
  const e = new Set(expected);
  const missing = [...e].filter((v) => !a.has(v));
  const extra = [...a].filter((v) => !e.has(v));
  if (missing.length || extra.length) {
    // Naming the difference rather than dumping both lists: a maintainer needs to know which item to
    // add or remove, not to diff two sorted arrays by eye.
    const parts = [];
    if (missing.length) parts.push(`missing ${missing.join(', ')}`);
    if (extra.length) parts.push(`unexpected ${extra.join(', ')}`);
    fail(`${label} must be exactly the declared set — ${parts.join('; ')}.`);
  }
}

function assertStringArray(label, value) {
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
    fail(`${label} must be an array of strings.`);
  }
}

/**
 * Validate the authority policy as a closed document.
 *
 * @param {unknown} policy parsed JSON
 * @returns {object} the same policy, once it has been proven well-formed
 */
export function validateAuthorityPolicy(policy, { now = Date.now() } = {}) {
  assertKeys('policy', policy, TOP_LEVEL);

  if (!SUPPORTED_VERSIONS.includes(policy.version)) {
    fail(`policy version ${JSON.stringify(policy.version)} is not supported (expected one of ${SUPPORTED_VERSIONS.join(', ')}).`);
  }
  assertStringArray('policy.$comment', policy.$comment);

  // --- actors: exact assignments, not merely known words --------------------------------------
  assertMembers('policy.actors', Object.keys(policy.actors ?? {}), ACTORS);
  const capabilities = new Set(CAPABILITIES);
  const neverGrantable = new Set(NEVER_GRANTABLE);

  for (const name of ACTORS) {
    const actor = policy.actors[name];
    const expected = EXPECTED_ACTORS[name];
    assertKeys(`policy.actors.${name}`, actor, ACTOR_KEYS, ACTOR_OPTIONAL_KEYS);
    assertStringArray(`policy.actors.${name}.may`, actor.may);
    assertStringArray(`policy.actors.${name}.mayNever`, actor.mayNever);

    // Vocabulary first, so an unknown word is reported as such rather than as a mismatch.
    for (const cap of [...actor.may, ...actor.mayNever]) {
      if (!capabilities.has(cap)) fail(`policy.actors.${name} references unknown capability "${cap}".`);
    }
    for (const cap of actor.may) {
      if (neverGrantable.has(cap)) fail(`policy.actors.${name}.may contains "${cap}", which no actor may ever be granted.`);
    }
    const both = actor.may.filter((cap) => actor.mayNever.includes(cap));
    if (both.length) fail(`policy.actors.${name} lists ${both.join(', ')} as both may and mayNever.`);

    // Then the assignments themselves.
    if (actor.role !== expected.role) {
      fail(`policy.actors.${name}.role must be exactly "${expected.role}".`);
    }
    assertMembers(`policy.actors.${name}.may`, actor.may, expected.may);
    assertMembers(`policy.actors.${name}.mayNever`, actor.mayNever, expected.mayNever);
  }

  // --- documents: exact field VALUES, not only their keys --------------------------------------
  assertMembers('policy.documents', Object.keys(policy.documents ?? {}), DOCUMENTS);
  for (const name of DOCUMENTS) {
    const doc = policy.documents[name];
    const expected = EXPECTED_DOCUMENTS[name];
    assertKeys(`policy.documents.${name}`, doc, DOCUMENT_KEYS[name]);
    assertStringArray(`policy.documents.${name}.authorizes`, doc.authorizes);
    // Unknown references first, so an unknown effect is reported as unknown rather than as a mismatch.
    for (const effect of doc.authorizes) {
      if (!EFFECTS.includes(effect)) fail(`policy.documents.${name}.authorizes references unknown effect "${effect}".`);
    }
    // Round 5: the mode map must PARTITION the document's effects — every mode's effects are
    // authorized effects, every authorized effect belongs to exactly one mode, and no mode is
    // outside the closed vocabulary. Without this, one instrument holding four effects proves
    // nothing about what a plan_only value may do.
    if (name === 'cloud-authorization') {
      const modes = doc.modes;
      if (!isPlainObject(modes)) fail('policy.documents.cloud-authorization.modes must be an object.');
      const seen = new Map();
      for (const [mode, effects] of Object.entries(modes)) {
        if (!CLOUD_MODES.includes(mode)) fail(`policy.documents.cloud-authorization.modes has unknown mode "${mode}".`);
        assertStringArray(`policy.documents.cloud-authorization.modes.${mode}`, effects);
        for (const effect of effects) {
          if (!doc.authorizes.includes(effect)) {
            fail(`policy.documents.cloud-authorization.modes.${mode} references "${effect}", which the document does not authorize.`);
          }
          if (seen.has(effect)) {
            fail(`policy.documents.cloud-authorization.modes lists "${effect}" under both ${seen.get(effect)} and ${mode}; an effect belongs to exactly one mode.`);
          }
          seen.set(effect, mode);
        }
      }
      const unmapped = doc.authorizes.filter((effect) => !seen.has(effect));
      if (unmapped.length) {
        fail(`policy.documents.cloud-authorization.modes does not cover ${unmapped.join(', ')}; every authorized effect must name the mode that authorizes it.`);
      }
    }
    // Round 7: risk acceptance is Zamp's alone, so the policy states the two together and refuses
    // the combination that would let a procedure exist over an unaccepted residual: `riskAccepted:
    // false` with `executableProcedure: true` is a document authorizing an operation nobody
    // accepted the risk of. Accepting it is a decision recorded by Zamp, never a default reached
    // by editing one field.
    if (Object.prototype.hasOwnProperty.call(doc, 'executableProcedure')) {
      if (typeof doc.executableProcedure !== 'boolean') {
        fail(`policy.documents.${name}.executableProcedure must be a boolean.`);
      }
      if (typeof doc.residualRisk !== 'string' || doc.residualRisk.trim() === '') {
        fail(`policy.documents.${name}.residualRisk must state the risk that is being accepted or not.`);
      }
      // Round 8: acceptance is a RECORD, not a boolean. A bare flag could be flipped together
      // with `executableProcedure` in one edit; a record must carry the finding, the reasoning,
      // the compensating controls, the accepting owner, a review date and an expiry — and every
      // field is held to a shape, so "accepted" cannot be asserted without saying by whom, why,
      // under what controls and until when.
      const acc = doc.riskAcceptance;
      if (acc !== null) {
        if (!isPlainObject(acc)) {
          fail(`policy.documents.${name}.riskAcceptance must be null or a closed acceptance record.`);
        }
        assertKeys(`policy.documents.${name}.riskAcceptance`, acc, RISK_ACCEPTANCE_KEYS);
        if (acc.acceptedBy !== 'zamp' || !policy.actors?.[acc.acceptedBy]?.may?.includes('accept-risk')) {
          fail(`policy.documents.${name}.riskAcceptance.acceptedBy must be "zamp": accept-risk is Zamp's capability alone.`);
        }
        // Rounds 9-10: the declared owner is not the decision, and a bare hex is not a
        // statement. The pointer names the SOURCE, the normalization and the canonical bytes of
        // Zamp's verbatim written decision, digested under the §6b `bundle` framing; independent
        // review recomputes it from the actual message.
        const stmt = acc.zampStatement;
        if (!isPlainObject(stmt)) {
          fail(`policy.documents.${name}.riskAcceptance.zampStatement must be a closed statement pointer; "acceptedBy: zamp" typed by an executor proves nothing.`);
        }
        assertKeys(`policy.documents.${name}.riskAcceptance.zampStatement`, stmt, ZAMP_STATEMENT_KEYS);
        if (stmt.source !== 'zamp-verbatim-message') {
          fail(`policy.documents.${name}.riskAcceptance.zampStatement.source must be "zamp-verbatim-message": the statement is Zamp's own message on the record, not a paraphrase.`);
        }
        // Round 11: a source CLASS is not an address. The locator names the decision file and
        // the commit that introduced it — both verifiable against history, neither reusable.
        if (!isPlainObject(stmt.locator)) {
          fail(`policy.documents.${name}.riskAcceptance.zampStatement.locator must name where the statement immutably lives; a source class plus a timestamp finds nothing univocally.`);
        }
        assertKeys(`policy.documents.${name}.riskAcceptance.zampStatement.locator`, stmt.locator, ZAMP_STATEMENT_LOCATOR_KEYS);
        if (typeof stmt.locator.path !== 'string' || !DECISION_FILE_RE.test(stmt.locator.path)) {
          fail(`policy.documents.${name}.riskAcceptance.zampStatement.locator.path must be a decision file under .agent-handoff/decisions/.`);
        }
        if (typeof stmt.locator.introducedIn !== 'string' || !COMMIT_SHA_RE.test(stmt.locator.introducedIn)) {
          fail(`policy.documents.${name}.riskAcceptance.zampStatement.locator.introducedIn must be the full 40-character SHA of the commit that introduced the decision file.`);
        }
        if (!strictUtcInstant(stmt.sentAt)) {
          fail(`policy.documents.${name}.riskAcceptance.zampStatement.sentAt must be a strict RFC3339 UTC instant.`);
        }
        if (stmt.encoding !== 'utf-8') {
          fail(`policy.documents.${name}.riskAcceptance.zampStatement.encoding must be "utf-8": without a fixed normalization, two byte streams can claim the same statement.`);
        }
        if (!Number.isInteger(stmt.bytes) || stmt.bytes <= 0) {
          fail(`policy.documents.${name}.riskAcceptance.zampStatement.bytes must be a positive integer — the exact length of the canonical bytes.`);
        }
        if (typeof stmt.sha256 !== 'string' || !SHA256_HEX_RE.test(stmt.sha256)) {
          fail(`policy.documents.${name}.riskAcceptance.zampStatement.sha256 must be the §6b bundle digest of the statement's canonical bytes.`);
        }
        if (typeof acc.decisionId !== 'string' || !DECISION_ID_RE.test(acc.decisionId)) {
          fail(`policy.documents.${name}.riskAcceptance.decisionId must match ${DECISION_ID_RE}.`);
        }
        for (const key of ['finding', 'justification']) {
          if (typeof acc[key] !== 'string' || acc[key].trim() === '') {
            fail(`policy.documents.${name}.riskAcceptance.${key} must be a non-empty string.`);
          }
        }
        // Rounds 9-10: the acceptance is bound to the EXACT residual it accepts, under the §6b
        // `text` framing — kind, version and subject INSIDE the digested bytes, so a raw-text
        // digest, another framing, another subject or a stray newline all detach. Editing the
        // instrument's residualRisk detaches every prior acceptance, structurally.
        if (acc.residualRiskSha256 !== framedTextDigest(`policy.documents.${name}.residualRisk`, doc.residualRisk)) {
          fail(`policy.documents.${name}.riskAcceptance.residualRiskSha256 does not match the §6b text-framed digest of this instrument's exact residualRisk — an acceptance of some other finding, framing or byte stream accepts nothing here.`);
        }
        // Rounds 9-10: an acceptance covers ONE stack record under ONE cleanup decision, never a
        // class — and the stack is bound by the DIGEST of the out-of-band cleanup authorization
        // (which contains stackId and decisionId), because a live ARN never enters the tracked
        // policy. The runtime consumer recomputes this digest from the value it is handed.
        if (typeof acc.coversCleanupAuthorizationSha256 !== 'string' || !SHA256_HEX_RE.test(acc.coversCleanupAuthorizationSha256)) {
          fail(`policy.documents.${name}.riskAcceptance.coversCleanupAuthorizationSha256 must be the §6b bundle digest of the out-of-band cleanup authorization value — the stack is bound by digest, never by copying its ARN into the tracked policy.`);
        }
        if (typeof acc.coversCleanupDecisionId !== 'string' || !DECISION_ID_RE.test(acc.coversCleanupDecisionId) || acc.coversCleanupDecisionId === acc.decisionId) {
          fail(`policy.documents.${name}.riskAcceptance.coversCleanupDecisionId must name the cleanup decision it covers, and cannot name the acceptance itself.`);
        }
        if (!Array.isArray(acc.compensatingControls) || acc.compensatingControls.length === 0
          || acc.compensatingControls.some((c) => typeof c !== 'string' || c.trim() === '')) {
          fail(`policy.documents.${name}.riskAcceptance.compensatingControls must be a non-empty array of non-empty strings.`);
        }
        for (const key of ['acceptedAt', 'reviewBy', 'expiresAt']) {
          if (!strictUtcInstant(acc[key])) {
            fail(`policy.documents.${name}.riskAcceptance.${key} must be a strict RFC3339 UTC instant the calendar round-trips.`);
          }
        }
        if (!(acc.acceptedAt < acc.reviewBy && acc.reviewBy <= acc.expiresAt)) {
          fail(`policy.documents.${name}.riskAcceptance must be ordered acceptedAt < reviewBy <= expiresAt; an acceptance whose review or expiry precedes it was written backwards, and one with no expiry is not an acceptance.`);
        }
        // Round 9: ordering is not validity. The validator evaluates the CLOCK, so a tree holding
        // an expired (or not-yet-made) acceptance fails closed until Zamp renews or the procedure
        // reverts; and the runtime consumer must re-check expiry immediately before the effect.
        if (Date.parse(acc.acceptedAt) > now) {
          fail(`policy.documents.${name}.riskAcceptance is dated in the future; a decision that has not been made yet authorizes nothing.`);
        }
        if (now >= Date.parse(acc.expiresAt)) {
          fail(`policy.documents.${name}.riskAcceptance has expired; an expired acceptance authorizes nothing and the procedure reverts to non-executable.`);
        }
        if (!doc.authorizes.includes(acc.boundToEffect)) {
          fail(`policy.documents.${name}.riskAcceptance.boundToEffect must be an effect this document authorizes.`);
        }
      }
      if (doc.executableProcedure && acc === null) {
        fail(`policy.documents.${name} declares an executable procedure over an unaccepted residual risk; acceptance is Zamp's closed riskAcceptance record, never a default.`);
      }
    }
    if (name === 'stack-record-authorization') {
      if (!Number.isInteger(doc.maxObservationAgeMinutes) || doc.maxObservationAgeMinutes < 1 || doc.maxObservationAgeMinutes > 15) {
        fail('policy.documents.stack-record-authorization.maxObservationAgeMinutes must be an integer of at most 15: an observation older than that authorizes nothing.');
      }
    }
    if (name === 'review-scope' && doc.authorizes.length !== 0) {
      fail('policy.documents.review-scope.authorizes must be empty: the review scope authorizes nothing.');
    }
    // (The document/effect relation in both directions is `assertAuthorityAgreement`, below.)
    for (const [field, want] of Object.entries(expected)) {
      const got = doc[field];
      if (Array.isArray(want)) {
        assertStringArray(`policy.documents.${name}.${field}`, got);
        // Order matters for `authorizes`: it is the order the artifact performs them in.
        if (got.length !== want.length || got.some((v, i) => v !== want[i])) {
          fail(`policy.documents.${name}.${field} must be exactly [${want.join(', ')}].`);
        }
      } else if (got !== want) {
        fail(`policy.documents.${name}.${field} must be exactly "${want}" but was ${JSON.stringify(got)}.`);
      }
    }
  }

  // --- effects: exact authorizer AND exact performer ------------------------------------------
  assertMembers('policy.effects', Object.keys(policy.effects ?? {}), EFFECTS);
  for (const name of EFFECTS) {
    const effect = policy.effects[name];
    const expected = EXPECTED_EFFECTS[name];
    assertKeys(`policy.effects.${name}`, effect, EFFECT_KEYS, EFFECT_OPTIONAL_KEYS);
    if (!AUTHORIZATION_SOURCES.includes(effect.authorizedBy)) {
      fail(`policy.effects.${name}.authorizedBy must be one of ${AUTHORIZATION_SOURCES.join(', ')} but was "${effect.authorizedBy}".`);
    }
    if (!ACTORS.includes(effect.performedBy)) fail(`policy.effects.${name}.performedBy must be a declared actor.`);
    if (name === 'merge' && effect.authorizedBy !== 'MERGE_DECISION') {
      fail("policy.effects.merge must be authorized by MERGE_DECISION — recording it otherwise reads as no gate needed.");
    }
    // #70 design round 3: the placeholder became a named instrument. Deploy — and every other
    // cloud effect — must be authorized by the cloud-authorization document, never by the
    // publication gate and never by a word that validates nothing.
    if (CLOUD_EFFECTS.includes(name) && !CLOUD_INSTRUMENTS.includes(effect.authorizedBy)) {
      fail(`policy.effects.${name} must be authorized by a cloud instrument (${CLOUD_INSTRUMENTS.join(' or ')}).`);
    }
    if (effect.authorizedBy !== expected.authorizedBy) {
      fail(`policy.effects.${name}.authorizedBy must be exactly "${expected.authorizedBy}".`);
    }
    if (effect.performedBy !== expected.performedBy) {
      fail(`policy.effects.${name}.performedBy must be exactly "${expected.performedBy}".`);
    }
    // Defence in depth: an actor forbidden from an effect cannot be recorded as performing it.
    if (policy.actors[effect.performedBy].mayNever.includes(name)) {
      fail(`policy.effects.${name}.performedBy is "${effect.performedBy}", which may never ${name}.`);
    }
  }
  // Both directions of the instrument/effect relation, as ONE law (see assertAuthorityAgreement).
  assertAuthorityAgreement(policy.effects, policy.documents, 'policy');

  // --- governed surfaces and their classification ----------------------------------------------
  assertStringArray('policy.governedSurfaces', policy.governedSurfaces);
  // A SUPERSET of the required set, not an equal set. The required list is what must always be
  // governed; discovery adds transient operational sources — another track's active handoff, a queued
  // inbox task — and those must be governed too while they exist, without being pinned in code where a
  // completed task would break the policy.
  {
    const governedNow = new Set(policy.governedSurfaces);
    const missing = REQUIRED_SURFACES.filter((s) => !governedNow.has(s));
    if (missing.length) fail(`policy.governedSurfaces is missing required surface(s): ${missing.join(', ')}.`);
    if (governedNow.size !== policy.governedSurfaces.length) fail('policy.governedSurfaces contains a duplicate.');
  }

  assertKeys('policy.surfaceClassification', policy.surfaceClassification, SURFACE_CLASSES);
  const classified = new Map();
  for (const cls of SURFACE_CLASSES) {
    const list = policy.surfaceClassification[cls];
    assertStringArray(`policy.surfaceClassification["${cls}"]`, list);
    for (const surface of list) {
      if (classified.has(surface)) {
        fail(`"${surface}" is classified as both ${classified.get(surface)} and ${cls}; each source has exactly one class.`);
      }
      classified.set(surface, cls);
    }
  }
  // The canonical class IS the governed set — the exact allowlist applies to precisely those files.
  assertMembers('policy.surfaceClassification["canonical-authority"]', policy.surfaceClassification['canonical-authority'], policy.governedSurfaces);

  // --- allowlist ------------------------------------------------------------------------------
  if (!isPlainObject(policy.allowedAuthorityStatements)) fail('policy.allowedAuthorityStatements must be an object.');
  const governed = new Set(policy.governedSurfaces);
  for (const surface of Object.keys(policy.allowedAuthorityStatements)) {
    if (!governed.has(surface)) fail(`policy.allowedAuthorityStatements has an entry for "${surface}", which is not a governed surface.`);
  }
  // Keys must MATCH the governed set: a missing key would silently permit a whole surface to go
  // unchecked, which is the same fail-open shape as an unclassified source.
  assertMembers('policy.allowedAuthorityStatements keys', Object.keys(policy.allowedAuthorityStatements), policy.governedSurfaces);
  for (const [surface, statements] of Object.entries(policy.allowedAuthorityStatements)) {
    assertStringArray(`policy.allowedAuthorityStatements["${surface}"]`, statements);
    const seen = new Set();
    for (const s of statements) {
      if (s !== s.trim() || /\s{2,}/.test(s)) fail(`policy.allowedAuthorityStatements["${surface}"] must hold normalized statements; "${s.slice(0, 60)}" is not.`);
      if (seen.has(s)) fail(`policy.allowedAuthorityStatements["${surface}"] lists a duplicate statement.`);
      seen.add(s);
    }
  }

  return policy;
}
