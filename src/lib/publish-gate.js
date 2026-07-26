// Publish-gate validation (#91) — PURE logic, no I/O, no network, no git.
//
// WHAT THIS IS, HONESTLY. Stage A is a LOCAL, ADVISORY pre-flight check. The role and executor
// identity are DECLARED BY THE CALLER (`--role`, `--executor`, `CBA_AGENT_ROLE`, `CBA_AGENT_ID`):
// nothing here authenticates them, and any caller can declare `executor`. This is therefore not
// mechanical identity separation — it is a guard rail that makes the correct path easy and the
// incorrect path noisy.
//
// AUTHORITATIVE separation belongs to Stage B and lives on the remote: a dedicated executor
// GitHub App/bot credential with no merge, administration or ruleset-bypass authority, plus branch
// protection on `main` applied to administrators. Until Stage B ships, a direct `git push origin
// main` remains possible and `enforce_admins` is still false — the exact condition behind the
// 2026-07-26 incident.
//
// Why the incident: a generic human approval meant for the coordinated #82/#85 release was read by
// the architect/reviewer agent as permission to push `main`; the push was in scope but the wrong
// role performed it, and two agents sharing a writable `main` then raced on `git commit --amend`.
// Prose in AGENTS.md was unambiguous and still did not stop it, so the decision is encoded here.
//
// Deliberately NOT claimed by Stage A:
//   - authenticated role/identity (Stage B credential);
//   - replay protection — a gate is not consumed, so the same file validates twice (Stage B owns
//     authoritative, idempotent consumption);
//   - remote base truth — `origin/main` is read from local refs, which are only as fresh as the
//     last fetch (Stage B validates against the live remote at publication time);
//   - exclusive-worktree enforcement — observed, reported, and treated as local convention.

/** Roles that may proceed. DECLARED, never authenticated in Stage A. */
export const PUBLISHING_ROLES = ['executor'];
export const NON_PUBLISHING_ROLES = ['architect', 'reviewer', 'observer'];

/** Approvals that name nobody. A review decision is not a publication command. */
const GENERIC_APPROVALS = [
  'approved', 'approve', 'ok', 'okay', 'lgtm', 'yes', 'go', 'ship it', 'shipit',
  'sim', 'aprovado', 'pode', 'pode pushar', 'human', 'owner', 'the human', 'anyone', 'n/a', '-',
];

const SHA_FULL = /^[0-9a-f]{40}$/;
const TASK_BRANCH = /^task\/(\d+)-[a-z0-9][a-z0-9-]*$/;
const ACTOR = /^[A-Za-z0-9][A-Za-z0-9._-]{1,63}$/;

// Gate ids are operator-authored and end up in console output and EVENTS.md, so they are bounded
// and charset-restricted rather than free text.
const GATE_ID = /^[a-z0-9][a-z0-9._-]{2,63}$/;

// RFC3339 with an explicit offset. `Date.parse` alone accepts loose input such as "2026-07-26",
// which would silently create an unbounded or ambiguous window.
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

/** A human decision should not authorize the next day's work. */
export const MAX_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours

// Credential shapes and words that must never ride in operator-authored metadata that we echo.
const SECRET_MARKER =
  /AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{8,}|gho_[A-Za-z0-9]{8,}|github_pat_|eyJ[A-Za-z0-9_-]{6,}|sk-[A-Za-z0-9]{8,}|xox[baprs]-|bearer|token|secret|password|credential|apikey|api[-_]key/i;

/**
 * Caller-controlled values must never be echoed raw: a refusal message is the one place an
 * operator reliably reads, and a mistyped credential in `--role` or `--executor` would land in a
 * terminal, a CI log and possibly a paste. A value is shown only when it is short, matches a safe
 * charset AND carries no credential marker; otherwise the message stays generic and the offending
 * value is dropped entirely.
 */
export function safeLabel(value) {
  if (typeof value !== 'string') return '<redacted>';
  if (value.length === 0 || value.length > 64) return '<redacted>';
  if (SECRET_MARKER.test(value)) return '<redacted>';
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,63}$/.test(value)) return '<redacted>';
  return value;
}

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
 * DECLARED-ROLE CHECK. Exported standalone so callers can run it as their very first statement,
 * before reading a gate, running git or constructing a network dependency.
 *
 * This checks what the caller SAYS it is. It is a guard rail against the wrong role acting by
 * habit or misreading, not a defence against a caller that lies. Stage B is what makes the claim
 * unforgeable.
 */
export function assertPublishingRole(role) {
  if (typeof role !== 'string' || role.trim() === '') {
    fail('ROLE_MISSING', 'A declared role is required (--role or CBA_AGENT_ROLE). Only "executor" may proceed.');
  }
  const normalized = role.trim().toLowerCase();
  if (NON_PUBLISHING_ROLES.includes(normalized)) {
    fail(
      'ROLE_FORBIDDEN',
      `Declared role "${normalized}" may review and recommend a gate but may never publish source ` +
        'branches, merge, deploy or act as executor (#91 decision 3). Refused before reading the ' +
        'gate, running git or touching the network.',
    );
  }
  if (!PUBLISHING_ROLES.includes(normalized)) {
    // The raw value is caller-controlled and never echoed — it may be a mistyped credential.
    fail('ROLE_UNKNOWN', `Unknown declared role. Publishing roles: ${PUBLISHING_ROLES.join(', ')}.`);
  }
  return normalized;
}

function assertNoSecretMarker(field, value) {
  if (SECRET_MARKER.test(String(value))) {
    // The offending value is NEVER echoed — that is the whole point of refusing it.
    fail('GATE_METADATA_UNSAFE', `"${field}" looks like it contains credential material and was refused unprinted.`);
  }
}

function assertInstant(value, field) {
  const raw = String(value);
  if (!RFC3339.test(raw)) {
    fail('GATE_INCOMPLETE', `"${field}" must be a strict RFC3339 timestamp with an offset (e.g. 2026-07-26T18:00:00Z).`);
  }
  const ms = Date.parse(raw);
  if (Number.isNaN(ms)) fail('GATE_INCOMPLETE', `"${field}" is not a valid instant.`);
  return ms;
}

/** Structural validation of the manifest, before it is compared to repository state. */
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

  // CLOSED schema: the manifest is human-authored and echoed into evidence, so an unexpected key
  // is a defect, not something to normalise away. Silently dropping it would let a mistyped
  // `reviewedSHA` disable a control while the gate still "passes", and would let a pasted token
  // ride along in the parsed object. Fail closed, and never name or echo the offending key.
  const ALLOWED_FIELDS = [
    'gateId', 'issue', 'executor', 'baseSha', 'commits',
    'sourceBranch', 'targetBranch', 'approver', 'approvedAt', 'expiresAt', 'reviewedShas',
  ];
  const unknown = Object.keys(gate).filter((key) => !ALLOWED_FIELDS.includes(key));
  if (unknown.length > 0) {
    fail(
      'GATE_UNKNOWN_FIELD',
      `The publish gate carries ${unknown.length} field(s) outside the closed schema. The names and ` +
        'values are not echoed. Allowed fields: ' + ALLOWED_FIELDS.join(', ') + '.',
    );
  }

  const required = ALLOWED_FIELDS;
  for (const key of required) {
    if (gate[key] === undefined || gate[key] === null || gate[key] === '') {
      fail('GATE_INCOMPLETE', `The publish gate is missing "${key}".`);
    }
  }

  // gateId is echoed to the console and to EVENTS.md, so it is bounded and scanned first.
  if (typeof gate.gateId !== 'string') fail('GATE_INCOMPLETE', '"gateId" must be a string.');
  assertNoSecretMarker('gateId', gate.gateId);
  if (!GATE_ID.test(gate.gateId)) {
    fail('GATE_INCOMPLETE', '"gateId" must be 3-64 chars of [a-z0-9._-] starting alphanumeric.');
  }

  if (!Number.isInteger(gate.issue) || gate.issue <= 0) {
    fail('GATE_INCOMPLETE', 'The publish gate needs an integer "issue".');
  }
  assertNoSecretMarker('executor', gate.executor);
  if (typeof gate.executor !== 'string' || !ACTOR.test(gate.executor)) {
    fail('GATE_INCOMPLETE', 'The publish gate needs a named "executor" identity.');
  }
  assertNoSecretMarker('approver', gate.approver);
  if (!SHA_FULL.test(String(gate.baseSha))) {
    fail('GATE_INCOMPLETE', '"baseSha" must be a full 40-character commit SHA.');
  }
  if (!Array.isArray(gate.commits) || gate.commits.length === 0) {
    fail('GATE_INCOMPLETE', '"commits" must be a non-empty ordered array of full SHAs.');
  }
  for (const sha of gate.commits) {
    if (!SHA_FULL.test(String(sha))) fail('GATE_INCOMPLETE', '"commits" must contain full 40-character SHAs.');
  }
  if (new Set(gate.commits).size !== gate.commits.length) {
    fail('GATE_INCOMPLETE', '"commits" must not repeat a SHA.');
  }

  // reviewedShas is MANDATORY: an unreviewed fix-forward must never ride along with reviewed work.
  if (!Array.isArray(gate.reviewedShas) || gate.reviewedShas.length === 0) {
    fail('GATE_INCOMPLETE', '"reviewedShas" is required and must be a non-empty array of full SHAs.');
  }
  for (const sha of gate.reviewedShas) {
    if (!SHA_FULL.test(String(sha))) fail('GATE_INCOMPLETE', '"reviewedShas" must contain full 40-character SHAs.');
  }
  const commits = gate.commits.map(String);
  const reviewed = gate.reviewedShas.map(String);
  if (commits.length !== reviewed.length || commits.some((sha, i) => sha !== reviewed[i])) {
    fail(
      'REVIEW_SET_MISMATCH',
      '"reviewedShas" must equal "commits" exactly and in order. Every published commit must have ' +
        'been reviewed, and nothing reviewed may be silently dropped.',
    );
  }

  if (typeof gate.sourceBranch !== 'string' || typeof gate.targetBranch !== 'string') {
    fail('GATE_INCOMPLETE', '"sourceBranch" and "targetBranch" must be strings.');
  }
  return gate;
}

/** A named human, not a mood. */
export function assertNamedApprover(approver) {
  const value = String(approver).trim();
  if (GENERIC_APPROVALS.includes(value.toLowerCase())) {
    fail('APPROVER_GENERIC', `"${value}" is a generic approval, not an actor. The gate must name the approving human.`);
  }
  if (!ACTOR.test(value)) fail('APPROVER_GENERIC', 'The approver must be a valid actor identity.');
  return value;
}

/**
 * Validate a gate against observed LOCAL repository state.
 *
 * @param {object} args
 * @param {object} args.gate parsed manifest
 * @param {string} args.role declared role (already asserted by the caller)
 * @param {string} args.executor declared executor identity
 * @param {object} args.repo { branch, headSha, baseSha, commits, clean, remoteBaseSha?, worktrees?, handoffPresent? }
 * @param {number} args.nowMs current time
 * @returns {{ gate, issue, sourceBranch, commits, advisories: string[] }}
 */
export function validateGate({ gate, role, executor, repo, nowMs }) {
  assertPublishingRole(role);
  const advisories = [];

  // --- branch rules ---
  const source = String(gate.sourceBranch);
  if (source === 'main' || source === 'master' || source === String(gate.targetBranch)) {
    fail('SOURCE_IS_TARGET', `"${safeLabel(source)}" cannot be a source branch. Agents publish an issue branch, never the integration branch.`);
  }
  const match = TASK_BRANCH.exec(source);
  if (!match) fail('BRANCH_SHAPE', `Source branch must look like task/<issue>-<slug> — got "${safeLabel(source)}".`);
  if (Number(match[1]) !== gate.issue) {
    fail('BRANCH_ISSUE_MISMATCH', `Branch "${safeLabel(source)}" does not belong to issue #${gate.issue}.`);
  }
  if (String(gate.targetBranch) !== 'main') {
    fail('TARGET_NOT_MAIN', `The pull request must target main — got "${safeLabel(String(gate.targetBranch))}".`);
  }
  if (repo.branch !== source) {
    fail('BRANCH_MISMATCH', `Checked out branch "${safeLabel(String(repo.branch))}" is not the gated source branch "${safeLabel(source)}".`);
  }

  // --- human decision, bounded in time ---
  assertNamedApprover(gate.approver);
  const approvedAt = assertInstant(gate.approvedAt, 'approvedAt');
  const expiresAt = assertInstant(gate.expiresAt, 'expiresAt');
  if (expiresAt <= approvedAt) fail('GATE_INCOMPLETE', '"expiresAt" must be after "approvedAt".');
  if (expiresAt - approvedAt > MAX_TTL_MS) {
    fail('GATE_TTL_TOO_LONG', `A publish gate may live at most ${MAX_TTL_MS / 3600000} hours. Ask for a fresh decision instead of a long window.`);
  }
  if (nowMs > expiresAt) fail('GATE_EXPIRED', 'The publish gate expired. Ask the human owner for a new gate.');
  if (nowMs < approvedAt) fail('GATE_NOT_YET_VALID', 'The publish gate is not valid yet.');

  // --- declared identity ---
  if (String(gate.executor) !== String(executor)) {
    fail('EXECUTOR_MISMATCH', `The gate names executor "${gate.executor}" but "${safeLabel(String(executor))}" is invoking it. A gate is not transferable.`);
  }

  // --- local repository state ---
  if (repo.clean === false) {
    fail('WORKTREE_DIRTY', 'The worktree has uncommitted changes. Publish only reviewed, committed history.');
  }
  if (String(repo.baseSha) !== String(gate.baseSha)) {
    fail('BASE_DRIFT', `The branch base moved: gate names ${gate.baseSha.slice(0, 7)} but the repository reports ${String(repo.baseSha).slice(0, 7)}.`);
  }

  const observed = repo.commits.map(String);
  const gated = gate.commits.map(String);
  if (observed.length !== gated.length || observed.some((sha, i) => sha !== gated[i])) {
    fail(
      'COMMIT_SET_DRIFT',
      'The commits on the branch do not match the gate exactly and in order. An amend, rebase, ' +
        'extra or reordered commit invalidates the human decision.',
    );
  }
  if (String(repo.headSha) !== gated[gated.length - 1]) fail('HEAD_DRIFT', 'HEAD is not the last gated commit.');

  // --- remote base: LOCAL KNOWLEDGE ONLY ---
  // `refs/remotes/origin/main` is as fresh as the last fetch. A newer remote main invalidates a
  // remote publication, but Stage A cannot prove currency; Stage B checks the live remote.
  if (repo.remoteBaseSha !== undefined && repo.remoteBaseSha !== null) {
    if (String(repo.remoteBaseSha) !== String(gate.baseSha)) {
      fail(
        'REMOTE_BASE_DRIFT',
        `Local knowledge of origin/main (${String(repo.remoteBaseSha).slice(0, 7)}) differs from the ` +
          `gate base (${gate.baseSha.slice(0, 7)}). Re-review against the current base.`,
      );
    }
    advisories.push('origin/main matched the gate base, but this is a LOCAL ref and may be stale — Stage B validates the live remote.');
  } else {
    advisories.push('origin/main was not observable locally; remote base currency is deferred to Stage B.');
  }

  // --- worktree exclusivity and handoff ownership: OBSERVED, not enforced ---
  if (Array.isArray(repo.worktrees)) {
    const sharing = repo.worktrees.filter((w) => w.branch === source);
    if (sharing.length > 1) {
      fail('WORKTREE_SHARED', `Branch "${source}" is checked out in ${sharing.length} worktrees. Each agent task uses its own.`);
    }
    advisories.push('Worktree exclusivity was observed locally; it is a convention, not remote enforcement.');
  } else {
    advisories.push('Worktree exclusivity was not observable; treated as local convention.');
  }
  if (repo.handoffPresent === false) {
    advisories.push(`No .agent-handoff/active handoff was found for issue #${gate.issue}; ownership is by convention only.`);
  }

  // --- replay: NOT prevented by Stage A ---
  advisories.push('Stage A does not consume a gate: the same file validates again. Authoritative, idempotent consumption is Stage B.');

  return { gate, issue: gate.issue, sourceBranch: source, commits: gated, advisories };
}

/**
 * Evidence for EVENTS.md. Every field here has already passed validation — nothing unvalidated is
 * copied out, and no token, secret or administrative endpoint is included.
 */
export function evidenceFor(result, { role, executor, at }) {
  return {
    gateId: result.gate.gateId,
    issue: result.issue,
    declaredRole: role,
    declaredExecutor: safeLabel(String(executor)),
    approver: result.gate.approver,
    sourceBranch: result.sourceBranch,
    targetBranch: result.gate.targetBranch,
    baseSha: result.gate.baseSha,
    commits: result.commits,
    validatedAt: at,
    published: false,
    merged: false,
    stage: 'A-local-validation-only',
  };
}
