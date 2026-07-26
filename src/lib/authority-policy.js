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
const TOP_LEVEL = ['$comment', 'version', 'actors', 'documents', 'effects', 'governedSurfaces', 'allowedAuthorityStatements'];

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
 * Prohibitions every implementing/reviewing agent must carry explicitly.
 *
 * The canonical rules say Opus may never access secrets or invoke a paid service through the
 * publication script, and that Codex may never implement, operate or grant the gate. Requiring them
 * here means the policy cannot quietly drop one.
 */
const REQUIRED_PROHIBITIONS = {
  opus: ['self-review', 'self-approve', 'merge', 'deploy', 'push-integration-branch', 'force-push', 'administer-repository', 'rewrite-reviewed-history', 'access-secrets', 'invoke-paid-service'],
  codex: ['implement', 'prepare-artifact', 'operate-artifact', 'push', 'merge', 'deploy', 'grant-human-gate', 'access-secrets', 'invoke-paid-service'],
  zamp: ['delegate-approval', 'delegate-merge'],
  gemini: ['any-workflow-or-governance-role'],
};

/** Exact document set and keys. */
const DOCUMENTS = ['review-scope', 'execution-gate'];
const DOCUMENT_KEYS = {
  'review-scope': ['writtenBy', 'writtenWhen', 'suppliedAs', 'filenameConvention', 'bounds', 'authorizes'],
  'execution-gate': ['writtenBy', 'writtenWhen', 'suppliedAs', 'filenameConvention', 'messageType', 'boundTo', 'authorizes'],
};

/** Exact effect set and keys. */
const EFFECTS = ['push-reviewed-commit-to-task-branch', 'create-or-reuse-one-pull-request', 'merge', 'deploy'];
const EFFECT_KEYS = ['authorizedBy', 'performedBy'];
const EFFECT_OPTIONAL_KEYS = ['note'];

/**
 * What may appear in `effects[*].authorizedBy`.
 *
 * `"none"` is deliberately NOT here. It was in an earlier draft for merge and deploy, and it was
 * wrong in a way that mattered: merge is authorized by Zamp's `MERGE_DECISION`, and deploy requires
 * its own human gate. Recording either as unauthorized-by-anything would read as "no gate needed".
 */
const AUTHORIZATION_SOURCES = [...DOCUMENTS, 'MERGE_DECISION', 'separate-human-gate'];

/** Surfaces whose statements the policy governs. Every cold-start document, template and skill. */
export const REQUIRED_SURFACES = [
  'AGENTS.md',
  '.agent-handoff/MESSAGE-PROTOCOL.md',
  '.agent-handoff/README.md',
  '.agent-handoff/COMMANDS.md',
  '.agent-handoff/publish-gates/README.md',
  '.agent-handoff/templates/task.md',
  '.agent-handoff/templates/message.md',
  'spec/security-rules.md',
  'docs/architecture/agent-publication-runbook.md',
  '.claude/skills/publication-prepare/SKILL.md',
  '.claude/skills/security-review/SKILL.md',
  '.agents/skills/publication-review/SKILL.md',
  '.agents/skills/review-security/SKILL.md',
];

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
  const a = [...actual].sort();
  const e = [...expected].sort();
  if (a.length !== e.length || a.some((v, i) => v !== e[i])) {
    fail(`${label} must be exactly [${e.join(', ')}] but was [${a.join(', ')}].`);
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

  // --- actors ---------------------------------------------------------------------------------
  assertMembers('policy.actors', Object.keys(policy.actors ?? {}), ACTORS);
  const capabilities = new Set(CAPABILITIES);
  const neverGrantable = new Set(NEVER_GRANTABLE);

  for (const name of ACTORS) {
    const actor = policy.actors[name];
    assertKeys(`policy.actors.${name}`, actor, ACTOR_KEYS, ACTOR_OPTIONAL_KEYS);
    if (typeof actor.role !== 'string' || actor.role.trim() === '') fail(`policy.actors.${name}.role must be a non-empty string.`);
    assertStringArray(`policy.actors.${name}.may`, actor.may);
    assertStringArray(`policy.actors.${name}.mayNever`, actor.mayNever);

    for (const cap of [...actor.may, ...actor.mayNever]) {
      if (!capabilities.has(cap)) fail(`policy.actors.${name} references unknown capability "${cap}".`);
    }
    for (const cap of actor.may) {
      if (neverGrantable.has(cap)) fail(`policy.actors.${name}.may contains "${cap}", which no actor may ever be granted.`);
    }
    // A capability cannot be both permitted and forbidden for the same actor.
    const both = actor.may.filter((cap) => actor.mayNever.includes(cap));
    if (both.length) fail(`policy.actors.${name} lists ${both.join(', ')} as both may and mayNever.`);

    for (const cap of REQUIRED_PROHIBITIONS[name]) {
      if (!actor.mayNever.includes(cap)) fail(`policy.actors.${name}.mayNever must include "${cap}".`);
    }
  }

  // --- documents ------------------------------------------------------------------------------
  assertMembers('policy.documents', Object.keys(policy.documents ?? {}), DOCUMENTS);
  for (const name of DOCUMENTS) {
    const doc = policy.documents[name];
    assertKeys(`policy.documents.${name}`, doc, DOCUMENT_KEYS[name]);
    if (!ACTORS.includes(doc.writtenBy)) fail(`policy.documents.${name}.writtenBy must be a declared actor.`);
    assertStringArray(`policy.documents.${name}.authorizes`, doc.authorizes);
    for (const effect of doc.authorizes) {
      if (!EFFECTS.includes(effect)) fail(`policy.documents.${name}.authorizes references unknown effect "${effect}".`);
    }
  }
  // The invariant the whole bridge rests on, as data.
  if (policy.documents['review-scope'].authorizes.length !== 0) {
    fail('policy.documents.review-scope.authorizes must be empty: the review scope authorizes nothing.');
  }
  assertStringArray('policy.documents.review-scope.bounds', policy.documents['review-scope'].bounds);

  // --- effects --------------------------------------------------------------------------------
  assertMembers('policy.effects', Object.keys(policy.effects ?? {}), EFFECTS);
  for (const name of EFFECTS) {
    const effect = policy.effects[name];
    assertKeys(`policy.effects.${name}`, effect, EFFECT_KEYS, EFFECT_OPTIONAL_KEYS);
    if (!AUTHORIZATION_SOURCES.includes(effect.authorizedBy)) {
      fail(`policy.effects.${name}.authorizedBy must be one of ${AUTHORIZATION_SOURCES.join(', ')} but was "${effect.authorizedBy}".`);
    }
    if (!ACTORS.includes(effect.performedBy)) fail(`policy.effects.${name}.performedBy must be a declared actor.`);
  }
  // Merge and deploy each need their own human decision, and neither is a document-authorized effect.
  if (policy.effects.merge.authorizedBy !== 'MERGE_DECISION' || policy.effects.merge.performedBy !== 'zamp') {
    fail('policy.effects.merge must be authorized by MERGE_DECISION and performed by zamp.');
  }
  if (policy.effects.deploy.authorizedBy !== 'separate-human-gate') {
    fail('policy.effects.deploy must require a separate human gate.');
  }
  // Every effect a document authorizes must name that document back — no dangling authority.
  for (const name of DOCUMENTS) {
    for (const effect of policy.documents[name].authorizes) {
      if (policy.effects[effect].authorizedBy !== name) {
        fail(`policy.effects.${effect}.authorizedBy must be "${name}" because that document authorizes it.`);
      }
    }
  }

  // --- governed surfaces ----------------------------------------------------------------------
  assertStringArray('policy.governedSurfaces', policy.governedSurfaces);
  assertMembers('policy.governedSurfaces', policy.governedSurfaces, REQUIRED_SURFACES);

  // --- allowlist ------------------------------------------------------------------------------
  if (!isPlainObject(policy.allowedAuthorityStatements)) fail('policy.allowedAuthorityStatements must be an object.');
  const governed = new Set(policy.governedSurfaces);
  for (const [surface, statements] of Object.entries(policy.allowedAuthorityStatements)) {
    if (!governed.has(surface)) fail(`policy.allowedAuthorityStatements has an entry for "${surface}", which is not a governed surface.`);
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
