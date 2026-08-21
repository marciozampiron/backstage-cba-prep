#!/usr/bin/env node
'use strict';

/* =================================================================================================
 * RECOVER A DECLINED PLAN — an exceptional, narrow instrument (#111, review r18)
 *
 * WHY THIS EXISTS, AND WHY IT IS NOT THE LANE.
 *
 * The first plan_only of the dev tier refused with CHANGE_SET_SCHEMA_UNKNOWN. The refusal was
 * correct and nothing was deployed, but it happened AFTER preparation: two change sets exist,
 * CREATE_COMPLETE and AVAILABLE — that is, EXECUTABLE — carrying a plan no human ever approved,
 * and no `planDigest` was ever minted for them because the run refused before producing one.
 *
 * The release lane cannot remove them. Its abandon mode deletes EXACTLY the plan a gate names by
 * digest, and there is no digest to name. Worse, the lane is CHECKED OUT AT THE RELEASE SHA it
 * operates: running abandon against the release that produced these sets would execute the
 * PRE-r18 code, which refuses these very describes; running the fixed code means a different
 * release SHA, and the change-set name is derived from it (`cba-70-<releaseSha[0:12]>`), so the
 * fixed code addresses change sets that do not exist. Executor and target are coupled in the lane
 * and cannot be separated there. Codex found this; a local test of the new code against the live
 * describes does NOT prove the gated path.
 *
 * So this instrument SEPARATES THEM EXPLICITLY: `executorSha` is the code doing the work,
 * `targetReleaseSha` is the release whose change sets are addressed. They differ by design here,
 * and both are bound by the gate.
 *
 * WHAT IT MAY DO — and the boundary is mechanical, not a promise:
 *   - `inspect`  : read-only. Describes the reviewed group with the r18 schema and MINTS the
 *                  evidence (per-entry digests and the plan root) that a gate may then name.
 *                  No mutation is reachable: the phase's command allowlist has no deletion in it.
 *   - `abandon`  : deletes change sets, by their FULL observed ChangeSetId, one attempt each,
 *                  under a gate that names the root minted by `inspect`.
 *
 * WHAT IT MAY NEVER DO: `DeleteStack`. Not "does not"; CANNOT — `cloudformation delete-stack` is
 * absent from every phase's allowlist, and an unlisted command refuses before it is spawned.
 * Removing a REVIEW_IN_PROGRESS stack record is `delete-review-in-progress-stack-record`, which
 * spec/authority-policy.json declares "human-performed only; no automated lane may perform it",
 * with `executableProcedure: false` and `riskAcceptance: null`. No agent may route around that.
 *
 * THE EFFECT IS NOT NEW. This authorizes `abandon-change-sets`, already declared in the policy
 * under `cloud-authorization`. What is new is the INSTRUMENT, not the authority. The gate's mode
 * token is `abandon_declined` precisely so a lane gate can never be replayed here, nor this one
 * there: same effect, two instruments, non-interchangeable authorizations.
 * ============================================================================================= */

const crypto = require('node:crypto');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');

const { PreflightError } = require('../lib/deploy-preflight');
const { DEPLOYMENT_PLAN_GROUPS, stackNameFor } = require('../lib/context');
const {
  describePlannedChangeSet,
  deploymentConfigRefusal,
  canonicalChangeSet,
  entryDigestOf,
  setReviewedStackNames,
  strictUtcInstant,
  CLOUD_GATE_MAX_TTL_MS,
  EXIT,
} = require('./deploy-release');

/* ---------------------------------------------------------------------------------------------
 * The refusal vocabulary. Deliberately SEPARATE from the lane's CODES table: this instrument is
 * exceptional and narrow, and growing the lane's shared vocabulary with recovery-only states
 * would blur which surface owns which refusal. Unknown code throws, exactly like the lane's.
 * ------------------------------------------------------------------------------------------- */
const RECOVERY_CODES = {
  PHASE_INVALID: 'is not one of the two phases this instrument has — inspect (read-only) or abandon (deletes change sets); the phases are mutually exclusive and there is no default',
  ARGUMENT_MISSING: 'was not supplied — an instrument that guesses a parameter is addressing something nobody named',
  ARGUMENT_MALFORMED: 'does not satisfy its documented form',
  GATE_MISSING: 'is not present — deleting a change set requires the human authorization (CBA_CLOUD_GATE) and its absence is a refusal, never a default',
  GATE_UNREADABLE: 'could not be read as a regular file — a symlink, a device, a directory or an unparseable body authorizes nothing',
  GATE_MALFORMED: 'is not a well-formed recovery authorization (closed key set)',
  GATE_MODE_MISMATCH: 'names a mode this instrument does not perform — a release-lane gate is not a recovery gate, and neither may be replayed as the other',
  GATE_EXPIRED: 'has expired — the authorization is a bounded window and this run is outside it',
  GATE_NOT_YET_VALID: 'has an approval instant in the future — it authorizes nothing yet',
  GATE_TTL_EXCEEDED: 'grants a window longer than the maximum — a recovery decision is short-lived, never standing',
  GATE_STACKS_INVALID: 'does not name a reviewed plan group, in content and in order',
  EXECUTOR_UNRESOLVED: 'could not be resolved from git — the instrument must know exactly which code is running',
  EXECUTOR_MISMATCH: 'is not the executor the authorization names — the reviewed code is the only code allowed to perform this',
  EXECUTOR_WORKTREE_DIRTY: 'has uncommitted changes — a modified tree is not the reviewed executor, whatever its HEAD says',
  ACCOUNT_UNRESOLVED: 'could not be resolved — an operation that cannot name its account cannot prove where it is acting',
  ACCOUNT_MISMATCH: 'is not the account the authorization names',
  ACCOUNT_CHANGED: 'changed between the verification and the effect — the world moved under the operation, which therefore stops',
  CHANGE_SET_MISSING: 'has no change set under the target release name — there is nothing here to delete, and an absence is never assumed to be success elsewhere',
  CHANGE_SET_UNREADABLE: 'has a change set that could not be described — an unreadable set is never deleted on the assumption it is the right one',
  CHANGE_SET_SCHEMA_UNKNOWN: 'has a change set carrying a field the reviewed schema does not describe — an unreviewed response cannot be summarized into a digest',
  CHANGE_SET_PAGES_DIVERGE: 'has a change set whose pages do not describe the same change set — a description that contradicts itself identifies nothing',
  CHANGE_SET_PAGINATION_UNCONSUMED: 'has a change set whose description did not finish paginating — a partial description is not the set',
  PLAN_CHANGED: 'does not match the plan the authorization names — the change sets differ from the inspected ones (recreated, drifted or foreign), and NOTHING was deleted',
  COMMAND_NOT_ALLOWED: 'is not a command this phase may run — the allowlist is the boundary, not the intention of the caller',
  DELETE_FAILED: 'refused to delete — CloudFormation returned an error, which means the world changed between observation and action; a surprised operation stops, it does not retry',
  DELETE_STATE_UNKNOWN: 'the delete call failed and bounded re-observation could not prove the set absent or present; recorded as neither, and read-only reconciliation is required before a new decision',
  EVIDENCE_UNWRITABLE: 'could not be written — an operation whose record cannot be kept does not proceed',
};

function describeRecoveryFailure({ code, field }) {
  const text = RECOVERY_CODES[code];
  if (!text) throw new PreflightError(`unknown recovery failure code ${code}`);
  return `${field} ${text} [${code}]`;
}

/* ---------------------------------------------------------------------------------------------
 * THE COMMAND ALLOWLIST — the mechanical boundary.
 *
 * Every AWS invocation passes through here, and a command that is not listed for the RUNNING
 * PHASE never reaches the process spawner. `cloudformation delete-stack` appears in neither list,
 * so the stack-record deletion this instrument must never perform is unreachable by construction
 * rather than by the author's care.
 * ------------------------------------------------------------------------------------------- */
const PHASE_COMMANDS = Object.freeze({
  inspect: Object.freeze([
    'sts get-caller-identity',
    'cloudformation describe-change-set',
    'cloudformation describe-stacks',
  ]),
  abandon: Object.freeze([
    'sts get-caller-identity',
    'cloudformation describe-change-set',
    'cloudformation describe-stacks',
    'cloudformation delete-change-set',
  ]),
});

/** Default AWS runner: ambient credentials, bounded, never widened. */
function defaultRun(args, { timeoutMs } = {}) {
  return spawnSync('aws', [...args, '--cli-connect-timeout', '5', '--cli-read-timeout', '20'], {
    encoding: 'utf8',
    timeout: timeoutMs,
    killSignal: 'SIGKILL',
    env: process.env,
  });
}

/** Default git reader for the executor identity — injectable so tests never touch a real repo. */
function defaultGit(args) {
  return spawnSync('git', args, { encoding: 'utf8', timeout: 15_000 });
}

const SHA40 = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const ACCOUNT_ID = /^[0-9]{12}$/;
const DECISION_ID = /^[A-Za-z0-9._-]{8,64}$/;
const CORRELATION_ID = /^[A-Za-z0-9._-]{8,128}$/;
const RUN_ID = /^[0-9]{1,20}$/;
const REGION = /^[a-z]{2}(-gov)?-[a-z]+-[0-9]$/;
const ENVIRONMENT = /^(pilot|dev)$/;

const GATE_KEYS = [
  'account', 'approvedAt', 'decisionId', 'environment', 'executorSha', 'expiresAt',
  'issue', 'manifestDigest', 'mode', 'planDigest', 'region', 'stacks', 'targetReleaseSha',
];
const GATE_MODE = 'abandon_declined';
/** The change sets are named `cba-70-…`: this instrument recovers the #70 release lane's plans. */
const GATE_ISSUE = 70;

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith('--')) return { error: a };
    const key = a.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) return { error: a };
    out[key] = value;
    i += 1;
  }
  return out;
}

/** The plan root over ORDERED per-entry digests — the same construction the lane commits to. */
function rootOf(entryDigests) {
  return crypto.createHash('sha256').update(JSON.stringify(entryDigests), 'utf8').digest('hex');
}

/** Read a gate as a REGULAR file only: no symlink, no fifo, no directory, bounded in size. */
function readGateFile(path, readFileSync = fs.readFileSync, statSync = fs.lstatSync) {
  let st;
  try {
    st = statSync(path);
  } catch {
    return { error: 'GATE_UNREADABLE' };
  }
  if (!st.isFile()) return { error: 'GATE_UNREADABLE' };
  if (st.size === 0 || st.size > 65536) return { error: 'GATE_UNREADABLE' };
  let body;
  try {
    body = readFileSync(path, 'utf8');
  } catch {
    return { error: 'GATE_UNREADABLE' };
  }
  try {
    return { value: JSON.parse(body) };
  } catch {
    return { error: 'GATE_MALFORMED' };
  }
}

/**
 * The whole instrument. `argv` is the phase and its parameters; every effectful dependency is
 * injectable so the tests exercise the REAL control flow with no cloud and no repository.
 */
function runRecoverDeclinedPlan(argv, {
  run = defaultRun,
  git = defaultGit,
  now = () => Date.now(),
  env = process.env,
  writeFileSync = fs.writeFileSync,
  readFileSync = fs.readFileSync,
  lstatSync = fs.lstatSync,
  sleep = () => {},
} = {}) {
  const failures = [];
  const lines = [];
  const refuse = () => ({
    exit: EXIT.REFUSED,
    output: [
      ...lines,
      'REFUSED — nothing was deleted:',
      ...failures.map((f) => `  ${describeRecoveryFailure(f)}`),
    ].join('\n'),
    deleted: [],
  });
  const fail = (code, field) => {
    failures.push({ code, field });
    return refuse();
  };

  const args = parseArgs(argv);
  if (args.error) return { exit: EXIT.USAGE, output: `usage: --phase <inspect|abandon> …  (unexpected argument ${args.error})`, deleted: [] };
  const phase = args.phase;
  if (phase !== 'inspect' && phase !== 'abandon') return fail('PHASE_INVALID', String(phase ?? '(absent)'));

  // --- the command allowlist, bound to THIS phase --------------------------------------------
  const allowed = PHASE_COMMANDS[phase];
  let blocked = null;
  const guardedRun = (cmd, opts) => {
    const verb = `${cmd[0]} ${cmd[1]}`;
    if (!allowed.includes(verb)) {
      blocked = verb;
      return null;
    }
    return run(cmd, opts);
  };

  // --- the executor: which code is running, and is it exactly the reviewed code ---------------
  const headRes = git(['rev-parse', 'HEAD']);
  const executorSha = headRes && headRes.status === 0 ? String(headRes.stdout || '').trim() : null;
  if (!executorSha || !SHA40.test(executorSha)) return fail('EXECUTOR_UNRESOLVED', 'executorSha');
  const statusRes = git(['status', '--porcelain']);
  if (!statusRes || statusRes.status !== 0) return fail('EXECUTOR_UNRESOLVED', 'executorWorktree');
  if (String(statusRes.stdout || '').trim() !== '') return fail('EXECUTOR_WORKTREE_DIRTY', 'executorWorktree');

  // --- the parameters, from the gate in abandon and from the flags in inspect -----------------
  let gate = null;
  let environment;
  let region;
  let targetReleaseSha;
  let stacks;
  let expectedAccount;
  let decisionId;
  let manifestDigest;

  if (phase === 'abandon') {
    const gatePath = env.CBA_CLOUD_GATE;
    if (!gatePath) return fail('GATE_MISSING', 'CBA_CLOUD_GATE');
    const read = readGateFile(gatePath, readFileSync, lstatSync);
    if (read.error) return fail(read.error, 'CBA_CLOUD_GATE');
    gate = read.value;
    if (!gate || typeof gate !== 'object' || Array.isArray(gate)) return fail('GATE_MALFORMED', 'CBA_CLOUD_GATE');
    const keys = Object.keys(gate).sort();
    if (keys.length !== GATE_KEYS.length || keys.some((k, i) => k !== GATE_KEYS[i])) return fail('GATE_MALFORMED', 'CBA_CLOUD_GATE');
    if (gate.mode !== GATE_MODE) return fail('GATE_MODE_MISMATCH', 'mode');
    if (gate.issue !== GATE_ISSUE) return fail('GATE_MALFORMED', 'issue');
    if (typeof gate.decisionId !== 'string' || !DECISION_ID.test(gate.decisionId)) return fail('GATE_MALFORMED', 'decisionId');
    if (typeof gate.environment !== 'string' || !ENVIRONMENT.test(gate.environment)) return fail('GATE_MALFORMED', 'environment');
    if (typeof gate.region !== 'string' || !REGION.test(gate.region)) return fail('GATE_MALFORMED', 'region');
    if (typeof gate.account !== 'string' || !ACCOUNT_ID.test(gate.account)) return fail('GATE_MALFORMED', 'account');
    if (typeof gate.targetReleaseSha !== 'string' || !SHA40.test(gate.targetReleaseSha)) return fail('GATE_MALFORMED', 'targetReleaseSha');
    if (typeof gate.executorSha !== 'string' || !SHA40.test(gate.executorSha)) return fail('GATE_MALFORMED', 'executorSha');
    if (typeof gate.manifestDigest !== 'string' || !SHA256.test(gate.manifestDigest)) return fail('GATE_MALFORMED', 'manifestDigest');
    if (typeof gate.planDigest !== 'string' || !SHA256.test(gate.planDigest)) return fail('GATE_MALFORMED', 'planDigest');
    if (!strictUtcInstant(gate.approvedAt)) return fail('GATE_MALFORMED', 'approvedAt');
    if (!strictUtcInstant(gate.expiresAt)) return fail('GATE_MALFORMED', 'expiresAt');
    if (!Array.isArray(gate.stacks) || gate.stacks.some((s) => typeof s !== 'string')) return fail('GATE_MALFORMED', 'stacks');

    const approved = Date.parse(gate.approvedAt);
    const expires = Date.parse(gate.expiresAt);
    if (!(approved < expires)) return fail('GATE_MALFORMED', 'expiresAt');
    if (expires - approved > CLOUD_GATE_MAX_TTL_MS) return fail('GATE_TTL_EXCEEDED', 'expiresAt');
    if (now() < approved) return fail('GATE_NOT_YET_VALID', 'approvedAt');
    if (now() >= expires) return fail('GATE_EXPIRED', 'expiresAt');

    // The executor the authorization names must be the executor running. A gate written for the
    // fixed code cannot be spent by any other tree, and the target it addresses is separate.
    if (gate.executorSha !== executorSha) return fail('EXECUTOR_MISMATCH', 'executorSha');

    ({ environment, region, targetReleaseSha, stacks, decisionId, manifestDigest } = gate);
    expectedAccount = gate.account;
  } else {
    environment = args.environment;
    region = args.region;
    targetReleaseSha = args.targetReleaseSha;
    decisionId = args.sourceDecision;
    manifestDigest = args.manifestDigest;
    stacks = typeof args.stacks === 'string' ? args.stacks.split(',').map((s) => s.trim()).filter(Boolean) : null;
    expectedAccount = args.account;
    for (const [name, value, shape] of [
      ['--environment', environment, ENVIRONMENT],
      ['--region', region, REGION],
      ['--target-release-sha', targetReleaseSha, SHA40],
      ['--account', expectedAccount, ACCOUNT_ID],
      ['--manifest-digest', manifestDigest, SHA256],
      ['--source-decision', decisionId, DECISION_ID],
      ['--source-run', args.sourceRun, RUN_ID],
      ['--source-correlation', args.sourceCorrelation, CORRELATION_ID],
      ['--evidence-out', args.evidenceOut, /^\/.+/],
    ]) {
      if (value === undefined) return fail('ARGUMENT_MISSING', name);
      if (!shape.test(String(value))) return fail('ARGUMENT_MALFORMED', name);
    }
    if (!stacks) return fail('ARGUMENT_MISSING', '--stacks');
  }

  // The group is a REVIEWED one, in content and in order — never an arbitrary stack list.
  const groupOk = DEPLOYMENT_PLAN_GROUPS.some(
    (group) => group.length === stacks.length && group.every((id, i) => id === stacks[i]),
  );
  if (!groupOk) return fail('GATE_STACKS_INVALID', phase === 'abandon' ? 'stacks' : '--stacks');

  const changeSetName = `cba-70-${targetReleaseSha.slice(0, 12)}`;
  const stackNames = stacks.map((stackId) => stackNameFor(environment, stackId));
  // Review material may name a stack only when THIS run computed it.
  setReviewedStackNames(stackNames);

  const awsEnv = { AWS_REGION: region, AWS_DEFAULT_REGION: region };
  const accountOf = () => {
    const res = guardedRun(['sts', 'get-caller-identity', '--output', 'json', '--no-cli-pager'], { timeoutMs: 30_000, env: awsEnv });
    if (!res || res.status !== 0) return null;
    try {
      const body = JSON.parse(res.stdout || '{}');
      return typeof body.Account === 'string' && ACCOUNT_ID.test(body.Account) ? body.Account : null;
    } catch {
      return null;
    }
  };

  const accountAtVerify = accountOf();
  if (blocked) return fail('COMMAND_NOT_ALLOWED', blocked);
  if (!accountAtVerify) return fail('ACCOUNT_UNRESOLVED', 'account');
  if (accountAtVerify !== expectedAccount) return fail('ACCOUNT_MISMATCH', 'account');

  lines.push(`recover-declined-plan — phase ${phase}`);
  lines.push(`  executor sha     : ${executorSha}`);
  lines.push(`  target release   : ${targetReleaseSha}  (change set name ${changeSetName})`);
  lines.push(`  environment      : ${environment} in ${region}, account verified`);
  lines.push(`  group            : ${stacks.join(', ')}`);

  // --- DESCRIBE the whole group, in order, with the reviewed reader ---------------------------
  // The lane's OWN reader: pagination consumed, pages required to agree, r18 schema enforced.
  // A separate copy here would be a second contract to keep in step, and the two would drift.
  const entries = [];
  for (let i = 0; i < stacks.length; i += 1) {
    const stackId = stacks[i];
    const stackName = stackNames[i];
    const described = describePlannedChangeSet(guardedRun, awsEnv, stackName, changeSetName);
    if (blocked) return fail('COMMAND_NOT_ALLOWED', blocked);
    if (described.missing) return fail('CHANGE_SET_MISSING', stackId);
    if (described.schemaViolations) return fail('CHANGE_SET_SCHEMA_UNKNOWN', stackId);
    if (described.pagesDiverge) return fail('CHANGE_SET_PAGES_DIVERGE', stackId);
    if (described.paginationUnconsumed) return fail('CHANGE_SET_PAGINATION_UNCONSUMED', stackId);
    if (described.error) return fail('CHANGE_SET_UNREADABLE', stackId);
    // The deployment configuration is REPORTED here, never enforced: this instrument deletes a
    // declined plan, and refusing to delete what the execution policy would not approve is
    // exactly the trap review F2 removed from the lane.
    const configNote = deploymentConfigRefusal(described.described);
    const entry = canonicalChangeSet(stackId, stackName, described.described);
    entries.push({ entry, configNote, changeSetId: described.described.ChangeSetId });
  }

  const entryDigests = entries.map((e) => entryDigestOf(e.entry));
  const planDigest = rootOf(entryDigests);
  const observedAt = new Date(now()).toISOString().replace(/\.\d{3}Z$/, 'Z');

  for (let i = 0; i < entries.length; i += 1) {
    const { entry, configNote } = entries[i];
    lines.push(`  ${entry.stackName} — ${entry.status} / ${entry.executionStatus} — entry ${entryDigests[i]}`);
    if (configNote) lines.push(`      note: deployment configuration outside the execution policy (${configNote}) — reported, not enforced`);
  }
  lines.push(`  PLAN_DIGEST ${planDigest}`);

  if (phase === 'inspect') {
    // The closed evidence a gate may then name. No ARN, no account id, no credential: the
    // ChangeSetIds stay in memory and are re-observed at deletion time.
    const evidence = {
      instrument: 'recover-declined-plan',
      phase: 'inspect',
      observedAt,
      executorSha,
      targetReleaseSha,
      changeSetName,
      environment,
      region,
      accountVerified: true,
      source: {
        runId: String(args.sourceRun),
        decisionId,
        correlationId: String(args.sourceCorrelation),
      },
      manifestDigest,
      stacks: [...stacks],
      entries: entries.map((e, i) => ({
        stackId: e.entry.stackId,
        stackName: e.entry.stackName,
        status: e.entry.status,
        executionStatus: e.entry.executionStatus,
        entryDigest: entryDigests[i],
        deploymentConfigWithinExecutionPolicy: e.configNote === null,
      })),
      planDigest,
    };
    try {
      writeFileSync(args.evidenceOut, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
    } catch {
      return fail('EVIDENCE_UNWRITABLE', '--evidence-out');
    }
    return {
      exit: EXIT.OK,
      output: [
        ...lines,
        `INSPECTED (read-only; this phase cannot delete anything): evidence written to ${args.evidenceOut}`,
        'The plan digest above is what a recovery authorization must name. Nothing was mutated.',
      ].join('\n'),
      deleted: [],
      planDigest,
      evidence,
    };
  }

  // --- ABANDON --------------------------------------------------------------------------------
  // The root is recomputed over the FULL group, from THIS observation, and compared to the one
  // the authorization names. A recreated, drifted or foreign set changes its entry digest, the
  // root dies with it, and nothing is deleted.
  if (planDigest !== gate.planDigest) return fail('PLAN_CHANGED', 'planDigest');

  const deleted = [];
  const partial = () => (deleted.length === 0 ? 'none' : deleted.join(', '));
  for (const { entry, changeSetId } of entries) {
    // Revalidated immediately before EACH deletion: an account that moved or a window that
    // lapsed stops the operation where it stands, with an honest record of the prefix.
    const accountAtEffect = accountOf();
    if (blocked) return fail('COMMAND_NOT_ALLOWED', blocked);
    if (accountAtEffect !== accountAtVerify) {
      failures.push({ code: 'ACCOUNT_CHANGED', field: 'account' });
      const refused = refuse();
      return { ...refused, deleted, output: `${refused.output}\nDeleted before the halt: ${partial()}. The remaining change sets were NOT deleted.` };
    }
    if (now() >= Date.parse(gate.expiresAt)) {
      failures.push({ code: 'GATE_EXPIRED', field: 'expiresAt' });
      const refused = refuse();
      return { ...refused, deleted, output: `${refused.output}\nDeleted before the window lapsed: ${partial()}. The remaining change sets were NOT deleted.` };
    }

    // By the FULL observed ChangeSetId — never by name, which a recreated set would also answer.
    const deletion = guardedRun(['cloudformation', 'delete-change-set', '--change-set-name', changeSetId, '--no-cli-pager'], { timeoutMs: 30_000, env: awsEnv });
    if (blocked) return fail('COMMAND_NOT_ALLOWED', blocked);
    if (!deletion || deletion.status !== 0) {
      // A failed delete CALL is AMBIGUOUS — the service may have accepted it while the transport
      // died — so the state is reconciled by bounded re-observation before anything is claimed.
      // Presence is an ALLOWLIST over the documented status enum and requires an UNBROKEN window:
      // one tainted read taints the whole window, and an unknown status proves nothing.
      const RECONCILE_ATTEMPTS = 5;
      const STANDING = ['CREATE_PENDING', 'CREATE_IN_PROGRESS', 'CREATE_COMPLETE', 'FAILED', 'DELETE_FAILED'];
      let observedMissing = false;
      let stoodStillAllWindow = true;
      for (let attempt = 0; attempt < RECONCILE_ATTEMPTS; attempt += 1) {
        if (attempt > 0) sleep();
        const observed = guardedRun(['cloudformation', 'describe-change-set', '--change-set-name', changeSetId, '--stack-name', entry.stackName, '--output', 'json', '--no-cli-pager'], { timeoutMs: 30_000, env: awsEnv });
        if (blocked) return fail('COMMAND_NOT_ALLOWED', blocked);
        if (observed && observed.status !== 0 && /ChangeSetNotFound|does not exist/i.test(`${observed.stderr || ''}${observed.stdout || ''}`)) {
          observedMissing = true;
          break;
        }
        let parsed = null;
        if (observed && observed.status === 0) {
          try {
            parsed = JSON.parse(observed.stdout);
          } catch {
            parsed = null;
          }
        }
        const identityOk = !!parsed && parsed.ChangeSetId === changeSetId;
        const status = identityOk && typeof parsed.Status === 'string' ? parsed.Status : null;
        if (status === null || !STANDING.includes(status)) stoodStillAllWindow = false;
      }
      if (observedMissing) {
        // It IS gone — the record says so, and the run still stops on the transport surprise.
        deleted.push(entry.stackName);
        failures.push({ code: 'DELETE_FAILED', field: entry.stackId });
        const refused = refuse();
        return { ...refused, deleted, output: `${refused.output}\nThe delete call for ${entry.stackName} failed in transport but the set is PROVABLY ABSENT — recorded as deleted. Deleted so far: ${partial()}. The remaining change sets were NOT deleted — a surprised operation stops.` };
      }
      if (stoodStillAllWindow) {
        failures.push({ code: 'DELETE_FAILED', field: entry.stackId });
        const refused = refuse();
        return { ...refused, deleted, output: `${refused.output}\nDeleted before the failure: ${partial()}. The set is provably still present; the remaining change sets were NOT deleted.` };
      }
      failures.push({ code: 'DELETE_STATE_UNKNOWN', field: entry.stackId });
      const refused = refuse();
      return { ...refused, deleted, output: `${refused.output}\nThe delete call for ${entry.stackName} failed AND its state could not be observed — claimed neither deleted nor present. Deleted before it: ${partial()}. Read-only reconciliation of ${entry.stackName} is required before a new decision.` };
    }
    deleted.push(entry.stackName);
  }

  // REPORT — never delete — the stack records a CREATE change set leaves behind. An inconclusive
  // read reports as unverifiable; "no record remains" is claimed only when every query answered.
  const reported = [];
  for (const stackName of stackNames) {
    const described = guardedRun(['cloudformation', 'describe-stacks', '--stack-name', stackName, '--output', 'json', '--no-cli-pager'], { timeoutMs: 30_000, env: awsEnv });
    if (blocked) return fail('COMMAND_NOT_ALLOWED', blocked);
    if (!described || described.status !== 0) {
      if (described && /does not exist|ValidationError/i.test(`${described.stderr || ''}`)) continue;
      reported.push(`${stackName} (status unverifiable)`);
      continue;
    }
    let status = null;
    try {
      status = JSON.parse(described.stdout || '{}').Stacks?.[0]?.StackStatus ?? null;
    } catch {
      status = null;
    }
    if (status === null) reported.push(`${stackName} (status unverifiable)`);
    else if (status === 'REVIEW_IN_PROGRESS') reported.push(`${stackName} (REVIEW_IN_PROGRESS)`);
  }

  return {
    exit: EXIT.OK,
    output: [
      ...lines,
      `  matched the inspected plan; decision ${decisionId}`,
      `Deleted the declined change sets, in order: ${deleted.join(', ')}.`,
      reported.length > 0
        ? `REPORTED (never deleted): ${reported.join(', ')} — resolving a stack record is a separate human decision under its own instrument, and this one has no DeleteStack.`
        : 'No stack record remains to report.',
    ].join('\n'),
    deleted,
    planDigest,
  };
}

module.exports = {
  runRecoverDeclinedPlan,
  describeRecoveryFailure,
  RECOVERY_CODES,
  PHASE_COMMANDS,
  GATE_KEYS,
  GATE_MODE,
  GATE_ISSUE,
  rootOf,
};

if (require.main === module) {
  const { exit, output } = runRecoverDeclinedPlan(process.argv.slice(2));
  process.stdout.write(`${output}\n`);
  process.exit(exit);
}
