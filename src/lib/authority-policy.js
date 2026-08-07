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
  'any-workflow-or-governance-role',
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
  'any-workflow-or-governance-role',
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
    role: 'none in this workflow',
    may: [],
    mayNever: ['any-workflow-or-governance-role'],
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
    boundTo: 'releaseSha+assemblyDigest+planDigest',
    authorizes: ['deploy', 'prepare-change-sets', 'execute-change-sets'],
  },
  'spend-authorization': {
    writtenBy: 'zamp',
    writtenWhen: 'per paid run',
    suppliedAs: 'out-of-band record',
    boundTo: 'model+ceilings',
    authorizes: ['invoke-paid-model-audit'],
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
  'invoke-paid-model-audit': { authorizedBy: 'spend-authorization', performedBy: 'zamp' },
};

/** Exact document set and keys. */
const DOCUMENTS = ['review-scope', 'execution-gate', 'cloud-authorization', 'spend-authorization'];
const DOCUMENT_KEYS = {
  'review-scope': ['writtenBy', 'writtenWhen', 'suppliedAs', 'filenameConvention', 'bounds', 'authorizes'],
  'execution-gate': ['writtenBy', 'writtenWhen', 'suppliedAs', 'filenameConvention', 'messageType', 'boundTo', 'authorizes'],
  'cloud-authorization': ['writtenBy', 'writtenWhen', 'suppliedAs', 'boundTo', 'authorizes'],
  'spend-authorization': ['writtenBy', 'writtenWhen', 'suppliedAs', 'boundTo', 'authorizes'],
};

/** Exact effect set and keys. */
const EFFECTS = ['push-reviewed-commit-to-task-branch', 'create-or-reuse-one-pull-request', 'merge', 'deploy', 'prepare-change-sets', 'execute-change-sets', 'invoke-paid-model-audit'];
const EFFECT_KEYS = ['authorizedBy', 'performedBy'];
/** Effects that change cloud state. Each is authorized by the cloud instrument and performed by
 * Zamp — preparing a change set is here because it creates resources and publishes assets. */
const CLOUD_EFFECTS = ['deploy', 'prepare-change-sets', 'execute-change-sets'];
const EFFECT_OPTIONAL_KEYS = ['note'];

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
export function validateAuthorityPolicy(policy) {
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
    if (name === 'review-scope' && doc.authorizes.length !== 0) {
      fail('policy.documents.review-scope.authorizes must be empty: the review scope authorizes nothing.');
    }
    // A document may only authorize an effect that names it back — checked before exact comparison so
    // a dangling authority is reported as dangling.
    for (const effect of doc.authorizes) {
      const declared = policy.effects?.[effect]?.authorizedBy;
      if (declared !== undefined && declared !== name) {
        fail(`policy.effects.${effect}.authorizedBy must be "${name}" because that document authorizes it.`);
      }
    }
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
    if (CLOUD_EFFECTS.includes(name) && effect.authorizedBy !== 'cloud-authorization') {
      fail(`policy.effects.${name} must be authorized by the cloud-authorization document.`);
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
  // Every effect a document authorizes must name that document back — no dangling authority.
  for (const name of DOCUMENTS) {
    for (const effect of policy.documents[name].authorizes) {
      if (policy.effects[effect].authorizedBy !== name) {
        fail(`policy.effects.${effect}.authorizedBy must be "${name}" because that document authorizes it.`);
      }
    }
  }

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
