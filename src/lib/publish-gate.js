// Publish-gate validation (#91 Stage A) — PURE logic, no I/O, no network, no git.
//
// Why this exists: on 2026-07-26 a generic human approval meant for a coordinated release was read
// by the architect/reviewer agent as permission to run `git push origin main`. The push was in
// scope but the wrong ROLE performed it, and two agents sharing `main` then raced on
// `git commit --amend`. Prose in AGENTS.md could not have stopped either. Publication authority,
// role, exact commits, branch and the human decision are bound mechanically here instead.
//
// This module decides; `src/commands/agent-publish.js` performs. Keeping the decision pure means
// every abuse case is a unit test rather than a live push, and the role refusal is provably
// evaluated before anything touches the network.
//
// Remote branch protection (#91 Stage B) is the AUTHORITATIVE control. Everything here is the
// local half: it fails closed, but a determined caller with credentials can bypass local code.

/** Roles that may never publish. Checked first, before any other work. */
export const PUBLISHING_ROLES = ['executor'];
export const NON_PUBLISHING_ROLES = ['architect', 'reviewer', 'observer'];

/** Approvals that name nobody. A review decision is not a publication command. */
const GENERIC_APPROVALS = [
  'approved',
  'approve',
  'ok',
  'okay',
  'lgtm',
  'yes',
  'go',
  'ship it',
  'shipit',
  'sim',
  'aprovado',
  'pode',
  'pode pushar',
  'human',
  'owner',
  'the human',
  'anyone',
  'n/a',
  '-',
];

const SHA_FULL = /^[0-9a-f]{40}$/;
const TASK_BRANCH = /^task\/(\d+)-[a-z0-9][a-z0-9-]*$/;
const ACTOR = /^[A-Za-z0-9][A-Za-z0-9._-]{1,63}$/;

export class GateError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'GateError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new GateError(code, message);
}

/**
 * ROLE CHECK — deliberately its own exported function so callers can run it as the very first
 * statement, before reading a gate file, touching git or opening a socket. The #91 acceptance
 * criterion is that architect/reviewer fail BEFORE network access; making this callable in
 * isolation is what lets a test prove it.
 */
export function assertPublishingRole(role) {
  if (typeof role !== 'string' || role.trim() === '') {
    fail('ROLE_MISSING', 'A role is required. Set --role or CBA_AGENT_ROLE (only "executor" may publish).');
  }
  const normalized = role.trim().toLowerCase();
  if (NON_PUBLISHING_ROLES.includes(normalized)) {
    fail(
      'ROLE_FORBIDDEN',
      `Role "${normalized}" may review and recommend a gate but may never publish source branches, ` +
        'merge, deploy or act as executor (#91 decision 3). Refused before any network call.',
    );
  }
  if (!PUBLISHING_ROLES.includes(normalized)) {
    fail('ROLE_UNKNOWN', `Unknown role "${normalized}". Publishing roles: ${PUBLISHING_ROLES.join(', ')}.`);
  }
  return normalized;
}

/** Structural validation of the manifest itself, before it is compared to repository state. */
export function parseGate(raw) {
  let gate;
  if (typeof raw === 'string') {
    try {
      gate = JSON.parse(raw);
    } catch {
      fail('GATE_MALFORMED', 'The publish gate is not valid JSON.');
    }
  } else {
    gate = raw;
  }
  if (!gate || typeof gate !== 'object' || Array.isArray(gate)) {
    fail('GATE_MALFORMED', 'The publish gate must be a JSON object.');
  }

  const required = [
    'gateId',
    'issue',
    'executor',
    'baseSha',
    'commits',
    'sourceBranch',
    'targetBranch',
    'approver',
    'approvedAt',
    'expiresAt',
  ];
  for (const key of required) {
    if (gate[key] === undefined || gate[key] === null || gate[key] === '') {
      fail('GATE_INCOMPLETE', `The publish gate is missing "${key}".`);
    }
  }

  if (!Number.isInteger(gate.issue) || gate.issue <= 0) {
    fail('GATE_INCOMPLETE', 'The publish gate needs an integer "issue".');
  }
  if (typeof gate.executor !== 'string' || !ACTOR.test(gate.executor)) {
    fail('GATE_INCOMPLETE', 'The publish gate needs a named "executor" identity.');
  }
  if (!SHA_FULL.test(String(gate.baseSha))) {
    fail('GATE_INCOMPLETE', '"baseSha" must be a full 40-character commit SHA.');
  }
  if (!Array.isArray(gate.commits) || gate.commits.length === 0) {
    fail('GATE_INCOMPLETE', '"commits" must be a non-empty ordered array of full SHAs.');
  }
  for (const sha of gate.commits) {
    if (!SHA_FULL.test(String(sha))) {
      fail('GATE_INCOMPLETE', `"commits" must contain full 40-character SHAs — got "${sha}".`);
    }
  }
  if (new Set(gate.commits).size !== gate.commits.length) {
    fail('GATE_INCOMPLETE', '"commits" must not repeat a SHA.');
  }
  if (gate.reviewedShas !== undefined) {
    if (!Array.isArray(gate.reviewedShas)) fail('GATE_INCOMPLETE', '"reviewedShas" must be an array when present.');
    for (const sha of gate.reviewedShas) {
      if (!SHA_FULL.test(String(sha))) fail('GATE_INCOMPLETE', `"reviewedShas" must contain full SHAs — got "${sha}".`);
    }
  }
  return gate;
}

/** A named human, not a mood. "approved" is a review decision; it is not a publication command. */
export function assertNamedApprover(approver) {
  const value = String(approver).trim();
  if (GENERIC_APPROVALS.includes(value.toLowerCase())) {
    fail(
      'APPROVER_GENERIC',
      `"${value}" is a generic approval, not an actor. The gate must name the approving human ` +
        '(#91 decision 4).',
    );
  }
  if (!ACTOR.test(value)) {
    fail('APPROVER_GENERIC', `"${value}" is not a valid actor identity.`);
  }
  return value;
}

function parseInstant(value, field) {
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) fail('GATE_INCOMPLETE', `"${field}" must be an ISO-8601 timestamp.`);
  return ms;
}

/**
 * Full validation of a gate against observed repository state.
 *
 * @param {object} args
 * @param {object} args.gate parsed manifest
 * @param {string} args.role already asserted publishing role
 * @param {string} args.executor identity of the agent invoking the command
 * @param {object} args.repo observed state: { branch, headSha, baseSha, commits, clean }
 * @param {number} args.nowMs current time
 * @returns {{ gate: object, issue: number, sourceBranch: string, commits: string[] }}
 */
export function validateGate({ gate, role, executor, repo, nowMs }) {
  assertPublishingRole(role);

  // --- branch rules: never main as a source, never main as a push destination ---
  const source = String(gate.sourceBranch);
  if (source === 'main' || source === 'master' || source === String(gate.targetBranch)) {
    fail(
      'SOURCE_IS_TARGET',
      `"${source}" cannot be a source branch. Agents publish an issue branch and never push to ` +
        'the integration branch (#91 decisions 1 and 2).',
    );
  }
  const match = TASK_BRANCH.exec(source);
  if (!match) {
    fail('BRANCH_SHAPE', `Source branch must look like task/<issue>-<slug> — got "${source}".`);
  }
  if (Number(match[1]) !== gate.issue) {
    fail('BRANCH_ISSUE_MISMATCH', `Branch "${source}" does not belong to issue #${gate.issue}.`);
  }
  if (String(gate.targetBranch) !== 'main') {
    fail('TARGET_NOT_MAIN', `The pull request must target main — got "${gate.targetBranch}".`);
  }
  if (repo.branch !== source) {
    fail(
      'BRANCH_MISMATCH',
      `Checked out branch "${repo.branch}" is not the gated source branch "${source}". ` +
        'Each agent task uses its own branch and worktree (#91 decision 5).',
    );
  }

  // --- human decision ---
  assertNamedApprover(gate.approver);
  const approvedAt = parseInstant(gate.approvedAt, 'approvedAt');
  const expiresAt = parseInstant(gate.expiresAt, 'expiresAt');
  if (expiresAt <= approvedAt) {
    fail('GATE_INCOMPLETE', '"expiresAt" must be after "approvedAt".');
  }
  if (nowMs > expiresAt) {
    fail('GATE_EXPIRED', `The publish gate expired at ${gate.expiresAt}. Ask the human owner for a new gate.`);
  }
  if (nowMs < approvedAt) {
    fail('GATE_NOT_YET_VALID', `The publish gate is not valid until ${gate.approvedAt}.`);
  }

  // --- identity ---
  if (String(gate.executor) !== String(executor)) {
    fail(
      'EXECUTOR_MISMATCH',
      `The gate names executor "${gate.executor}" but "${executor}" is invoking it. A gate is not ` +
        'transferable between agents or runs.',
    );
  }

  // --- repository state ---
  if (repo.clean === false) {
    fail('WORKTREE_DIRTY', 'The worktree has uncommitted changes. Publish only reviewed, committed history.');
  }
  if (String(repo.baseSha) !== String(gate.baseSha)) {
    fail(
      'BASE_DRIFT',
      `The branch base moved: gate names ${gate.baseSha.slice(0, 7)} but the repository reports ` +
        `${String(repo.baseSha).slice(0, 7)}. Re-review against the new base.`,
    );
  }

  const observed = repo.commits.map(String);
  const gated = gate.commits.map(String);
  if (observed.length !== gated.length || observed.some((sha, i) => sha !== gated[i])) {
    fail(
      'COMMIT_SET_DRIFT',
      `The commits to publish do not match the gate exactly and in order. Gate: ` +
        `[${gated.map((s) => s.slice(0, 7)).join(', ')}]; branch: ` +
        `[${observed.map((s) => s.slice(0, 7)).join(', ')}]. An amend, rebase, extra or reordered ` +
        'commit invalidates the human decision.',
    );
  }
  if (String(repo.headSha) !== gated[gated.length - 1]) {
    fail('HEAD_DRIFT', 'HEAD is not the last gated commit.');
  }

  // --- review currency: every published commit must have been reviewed ---
  if (gate.reviewedShas !== undefined) {
    const reviewed = new Set(gate.reviewedShas.map(String));
    const unreviewed = gated.filter((sha) => !reviewed.has(sha));
    if (unreviewed.length > 0) {
      fail(
        'REVIEW_STALE',
        `Commits were never reviewed: ${unreviewed.map((s) => s.slice(0, 7)).join(', ')}. ` +
          'Reviews identify their target by full SHA (#91 decision 7).',
      );
    }
  }

  return { gate, issue: gate.issue, sourceBranch: source, commits: gated };
}

/**
 * Evidence line for EVENTS.md. Contains identities, SHAs and the gate id — never a token, secret,
 * administrative endpoint or credential.
 */
export function evidenceFor(result, { role, executor, at }) {
  return {
    gateId: result.gate.gateId,
    issue: result.issue,
    role,
    executor,
    approver: result.gate.approver,
    sourceBranch: result.sourceBranch,
    targetBranch: result.gate.targetBranch,
    baseSha: result.gate.baseSha,
    commits: result.commits,
    publishedAt: at,
    merged: false,
  };
}
