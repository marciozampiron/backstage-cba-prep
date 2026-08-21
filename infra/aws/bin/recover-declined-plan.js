#!/usr/bin/env node
'use strict';

/* =================================================================================================
 * RECOVER A DECLINED PLAN — an exceptional, narrow instrument (#111, reviews r18–r19)
 *
 * WHY THIS EXISTS, AND WHY IT IS NOT THE LANE.
 *
 * The first plan_only of the dev tier refused with CHANGE_SET_SCHEMA_UNKNOWN. The refusal was
 * correct and nothing was deployed, but it happened AFTER preparation: change sets exist,
 * CREATE_COMPLETE and AVAILABLE — that is, EXECUTABLE — carrying a plan no human approved, and
 * no digest was ever minted for them because the run refused before producing one.
 *
 * The release lane cannot remove them: its abandon mode deletes EXACTLY the plan a gate names by
 * digest, and there is none — and the lane runs the CODE of the release it addresses, so the
 * release that names these sets runs the pre-r18 code that refuses their describes, while the
 * fixed code derives a different change-set name. Executor and target are COUPLED there.
 *
 * This instrument separates them. The EXECUTOR is this worktree's clean HEAD; the TARGET is the
 * release the verified manifest names, and the change-set name derives from the manifest — never
 * from the code that is running.
 *
 * THE AUTHORITY IS THE CANONICAL ONE (review r19, F1). There is no new gate schema and no new
 * mode: the abandon phase consumes the same eleven-key CBA_CLOUD_GATE the policy declares
 * (`cloud-authorization`, mode `abandon`, SPEC-DEPLOY-019), validated by the lane's own
 * `checkCloudGate` — closed keys, issue pin, mode enum, window, TTL, reviewed stack group,
 * manifest bundle digest and the continuation law over `absentEntryDigests`. The instrument adds
 * ZERO authority; it changes only WHERE the reviewed code runs.
 *
 * TWO PHASES, mutually exclusive:
 *   - `inspect`  : read-only. Describes the reviewed group through the lane's own reader and
 *                  MINTS the evidence (per-entry digests and the plan root) a gate may then name.
 *                  No mutation is reachable: the phase's command allowlist has no deletion in it.
 *   - `abandon`  : deletes change sets, by their FULL observed ChangeSetId, one attempt each,
 *                  under the canonical gate, consuming the inspect evidence as its binding.
 *
 * WHAT IT MAY NEVER DO: `DeleteStack`. Not "does not" — CANNOT: `cloudformation delete-stack` is
 * absent from every phase's allowlist, and an unlisted command refuses before it is spawned.
 * Removing a REVIEW_IN_PROGRESS stack record is `delete-review-in-progress-stack-record`, which
 * spec/authority-policy.json reserves to a human ("human-performed only; no automated lane may
 * perform it", riskAcceptance null). No agent may route around that.
 * ============================================================================================= */

const crypto = require('node:crypto');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');

const { PreflightError, CODES, manifestBundleDigest } = require('../lib/deploy-preflight');
const { RELEASE_BOOTSTRAP_QUALIFIERS, DEPLOYMENT_PLAN_GROUPS, stackNameFor } = require('../lib/context');
const { validManifestShape } = require('./deploy-preflight');
const {
  describePlannedChangeSet,
  deploymentConfigRefusal,
  canonicalChangeSet,
  entryDigestOf,
  setReviewedStackNames,
  checkCloudGate,
  assumeBootstrapRole,
  deepSortKeys,
  EXIT,
} = require('./deploy-release');

/* ---------------------------------------------------------------------------------------------
 * The refusal vocabulary. Lane codes (CLOUD_GATE_*, CHANGE_SET_*, PLAN_CHANGED, …) render from
 * the lane's own CODES table so one failure means one thing everywhere; only the states unique
 * to recovery live here. An unknown code throws, exactly like the lane's.
 * ------------------------------------------------------------------------------------------- */
const RECOVERY_CODES = {
  PHASE_INVALID: 'is not one of the two phases this instrument has — inspect (read-only) or abandon (deletes change sets); the phases are mutually exclusive and there is no default',
  ARGUMENT_MISSING: 'was not supplied — an instrument that guesses a parameter is addressing something nobody named',
  ARGUMENT_MALFORMED: 'does not satisfy its documented form',
  MANIFEST_UNREADABLE: 'could not be read as a regular file — a symlink, a device, an oversized or unparseable body binds nothing',
  MANIFEST_INVALID: 'is not a verified release manifest (closed shape) — the target of a recovery is named by the manifest the bind produced, never by typed text',
  GATE_MODE_MISMATCH: 'names a gate mode this instrument does not perform — only an abandon authorization is consumable here, and a plan or deploy gate authorizes nothing',
  EVIDENCE_MISSING: 'was not supplied — the abandon phase consumes the inspect evidence as its binding, and its absence is a refusal, never a default',
  EVIDENCE_UNREADABLE: 'could not be read as a regular file — a symlink, a device, an oversized or unparseable body binds nothing',
  EVIDENCE_MALFORMED: 'is not a closed inspect record (exact key set, exact instrument and phase)',
  EVIDENCE_MISMATCH: 'does not bind to this operation — the inspect record must name this manifest digest, this release, this environment, this region, this stack group, this change-set name and the exact plan digest the gate names',
  EXECUTOR_UNRESOLVED: 'could not be resolved from git — the instrument must know exactly which code is running',
  EXECUTOR_MISMATCH: 'is not the executor the inspect evidence names — the tree that minted the digest is the tree allowed to spend it',
  EXECUTOR_WORKTREE_DIRTY: 'has uncommitted changes — a modified tree is not the reviewed executor, whatever its HEAD says',
  ACCOUNT_CHANGED: 'changed between the verification and the effect — the world moved under the operation, which therefore stops',
  CHANGE_SET_IDENTITY_FOREIGN: 'has a change set whose ARN names another account or region than the one this operation verified — a foreign identity is never deleted, whatever its digest',
  COMMAND_NOT_ALLOWED: 'is not a command this phase may run — the allowlist is the boundary, not the intention of the caller',
  ABANDON_DELETE_FAILED: 'refused to delete — CloudFormation returned an error, which means the world changed between observation and action; a surprised operation stops, it does not retry',
  ABANDON_STATE_UNKNOWN: 'the delete call failed and bounded re-observation could not prove the set absent or present; recorded as neither, and read-only reconciliation is required before a new decision',
  ABANDON_NOT_A_PREFIX: 'an absence after the first present entry cannot result from this instrument\'s ordered deletion — the observed world is not a state this operation produced; nothing was deleted',
  EVIDENCE_UNWRITABLE: 'could not be written — an operation whose record cannot be kept does not proceed, and one that already acted says so in its output instead of losing the fact',
};

function describeRecoveryFailure({ code, field }) {
  const text = RECOVERY_CODES[code] ?? CODES[code];
  if (!text) throw new PreflightError(`unknown recovery failure code ${code}`);
  return `${field} ${text} [${code}]`;
}

/* ---------------------------------------------------------------------------------------------
 * THE COMMAND ALLOWLIST — the mechanical boundary.
 *
 * Every AWS invocation passes through here, and a command that is not listed for the RUNNING
 * PHASE never reaches the process spawner. `cloudformation delete-stack` appears in neither
 * list, so the stack-record deletion this instrument must never perform is unreachable by
 * construction rather than by the author's care.
 * ------------------------------------------------------------------------------------------- */
const PHASE_COMMANDS = Object.freeze({
  inspect: Object.freeze([
    'sts get-caller-identity',
    'sts assume-role',
    'cloudformation describe-change-set',
    'cloudformation describe-stacks',
  ]),
  abandon: Object.freeze([
    'sts get-caller-identity',
    'sts assume-role',
    'cloudformation describe-change-set',
    'cloudformation describe-stacks',
    'cloudformation delete-change-set',
  ]),
});

/** Default AWS runner. Review r19 F2: `opts.env` MERGES over the process environment — the
 * assumed-role credentials and the imposed region genuinely reach the child, exactly as the
 * lane's runner does. Ignoring it made `region` decorative text. */
function defaultRun(args, { timeoutMs, env } = {}) {
  return spawnSync('aws', [...args, '--cli-connect-timeout', '5', '--cli-read-timeout', '20'], {
    encoding: 'utf8',
    timeout: timeoutMs,
    killSignal: 'SIGKILL',
    env: env ? { ...process.env, ...env } : process.env,
  });
}

/** Default git reader for the executor identity — injectable so tests never touch a real repo. */
function defaultGit(args) {
  return spawnSync('git', args, { encoding: 'utf8', timeout: 15_000 });
}

/** Review r19 F5: the reconciliation observations form a WINDOW, not a burst — five immediate
 * reads can all land before an accepted deletion starts to show. Five seconds between reads,
 * like the lane's own poll; injectable so tests never actually wait. */
const RECONCILE_SLEEP_MS = 5000;
function defaultSleep() {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, RECONCILE_SLEEP_MS);
}

const SHA256 = /^[0-9a-f]{64}$/;
const ACCOUNT_ID = /^[0-9]{12}$/;
const DECISION_ID = /^[A-Za-z0-9._-]{8,64}$/;
const CORRELATION_ID = /^[A-Za-z0-9._-]{8,128}$/;
const RUN_ID = /^[0-9]{1,20}$/;

/** The closed key set of an inspect record — the binding the abandon phase consumes. */
const INSPECT_EVIDENCE_KEYS = Object.freeze([
  'accountVerified', 'changeSetName', 'entries', 'environment', 'executorSha', 'instrument',
  'manifestDigest', 'observedAt', 'phase', 'planDigest', 'region', 'source', 'stacks',
  'targetReleaseSha',
]);

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

/** Read a small JSON document from a REGULAR file only: no symlink, no fifo, bounded in size. */
function readClosedJson(path, readFileSync, lstatSync) {
  let st;
  try {
    st = lstatSync(path);
  } catch {
    return { error: true };
  }
  if (!st.isFile() || st.size === 0 || st.size > 262144) return { error: true };
  try {
    return { value: JSON.parse(readFileSync(path, 'utf8')), raw: readFileSync(path, 'utf8') };
  } catch {
    return { error: true, unparseable: true };
  }
}

/**
 * The whole instrument. Every effectful dependency is injectable so the tests exercise the REAL
 * control flow with no cloud and no repository; `defaultRun` itself has its own real-spawn test.
 */
function runRecoverDeclinedPlan(argv, {
  run = defaultRun,
  git = defaultGit,
  now = () => Date.now(),
  env = process.env,
  writeFileSync = fs.writeFileSync,
  readFileSync = fs.readFileSync,
  lstatSync = fs.lstatSync,
  sleep = defaultSleep,
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

  // --- the command allowlist, bound to THIS phase, with the region imposed on every call -------
  const allowed = PHASE_COMMANDS[phase];
  let blocked = null;
  let regionForCalls = null; // set once the manifest names it; every AWS call carries it
  const guardedRun = (cmd, opts = {}) => {
    const verb = `${cmd[0]} ${cmd[1]}`;
    if (!allowed.includes(verb)) {
      blocked = verb;
      return null;
    }
    // Review r19 F2: the region is not ambient. It rides BOTH channels — the argument the CLI
    // obeys and the environment the SDK reads — so no profile default can re-aim a call.
    const withRegion = regionForCalls ? [...cmd, '--region', regionForCalls] : cmd;
    const withEnv = regionForCalls
      ? { ...opts, env: { AWS_REGION: regionForCalls, AWS_DEFAULT_REGION: regionForCalls, ...(opts.env ?? {}) } }
      : opts;
    return run(withRegion, withEnv);
  };

  // --- the executor: which code is running, on a clean tree, before ANY cloud call -------------
  const headRes = git(['rev-parse', 'HEAD']);
  const executorSha = headRes && headRes.status === 0 ? String(headRes.stdout || '').trim() : null;
  if (!executorSha || !/^[0-9a-f]{40}$/.test(executorSha)) return fail('EXECUTOR_UNRESOLVED', 'executorSha');
  const statusRes = git(['status', '--porcelain']);
  if (!statusRes || statusRes.status !== 0) return fail('EXECUTOR_UNRESOLVED', 'executorWorktree');
  if (String(statusRes.stdout || '').trim() !== '') return fail('EXECUTOR_WORKTREE_DIRTY', 'executorWorktree');

  // --- the TARGET: named by the verified manifest, never by typed text -------------------------
  // The manifest is the bind artifact of the release whose change sets are addressed. Its shape
  // is the closed one the lane validates, and its bundle digest is what the gate must name —
  // review r19 F4: the digest is COMPUTED from these bytes here, not accepted as an argument.
  if (args.manifest === undefined) return fail('ARGUMENT_MISSING', '--manifest');
  const manifestRead = readClosedJson(args.manifest, readFileSync, lstatSync);
  if (manifestRead.error) return fail('MANIFEST_UNREADABLE', '--manifest');
  const manifest = manifestRead.value;
  if (!validManifestShape(manifest)) return fail('MANIFEST_INVALID', '--manifest');
  const manifestDigest = manifestBundleDigest(manifest, deepSortKeys);
  const targetReleaseSha = manifest.releaseSha;
  const environment = manifest.environment;
  const region = manifest.region;
  const changeSetName = `cba-70-${targetReleaseSha.slice(0, 12)}`;

  // --- phase-specific authorization ------------------------------------------------------------
  let gate = null;
  let stacks;
  let evidenceIn = null;

  if (phase === 'abandon') {
    // THE CANONICAL GATE (review r19 F1): the lane's own checkCloudGate — closed eleven keys,
    // issue 70, the mode enum, the window and TTL, the reviewed stack group, the continuation
    // law over absentEntryDigests, and the manifest bundle digest — nothing reimplemented here.
    const checked = checkCloudGate(env.CBA_CLOUD_GATE, manifest, now());
    if (checked.failures) {
      for (const f of checked.failures) failures.push({ code: f.code, field: f.field });
      return refuse();
    }
    gate = checked.gate;
    // This instrument performs ONE effect. A plan_only or deploy gate is well-formed and still
    // authorizes nothing here — same effect vocabulary, different instrument, no replay.
    if (gate.mode !== 'abandon') return fail('GATE_MODE_MISMATCH', 'mode');
    stacks = [...gate.stacks];

    // THE INSPECT EVIDENCE IS THE BINDING (review r19 F4): the abandon consumes the record the
    // inspect minted and confronts every claim in it — the digest the gate names must be the
    // digest that record minted, for this manifest, this release, this group, this name.
    if (args.evidence === undefined) return fail('EVIDENCE_MISSING', '--evidence');
    const evidenceRead = readClosedJson(args.evidence, readFileSync, lstatSync);
    if (evidenceRead.error) return fail('EVIDENCE_UNREADABLE', '--evidence');
    evidenceIn = evidenceRead.value;
    const shapeOk = evidenceIn && typeof evidenceIn === 'object' && !Array.isArray(evidenceIn)
      && JSON.stringify(Object.keys(evidenceIn).sort()) === JSON.stringify([...INSPECT_EVIDENCE_KEYS])
      && evidenceIn.instrument === 'recover-declined-plan'
      && evidenceIn.phase === 'inspect'
      && typeof evidenceIn.planDigest === 'string' && SHA256.test(evidenceIn.planDigest)
      && typeof evidenceIn.executorSha === 'string' && /^[0-9a-f]{40}$/.test(evidenceIn.executorSha);
    if (!shapeOk) return fail('EVIDENCE_MALFORMED', '--evidence');
    const bindings = [
      ['manifestDigest', evidenceIn.manifestDigest === manifestDigest],
      ['targetReleaseSha', evidenceIn.targetReleaseSha === targetReleaseSha],
      ['environment', evidenceIn.environment === environment],
      ['region', evidenceIn.region === region],
      ['changeSetName', evidenceIn.changeSetName === changeSetName],
      ['stacks', JSON.stringify(evidenceIn.stacks) === JSON.stringify(stacks)],
      ['planDigest', evidenceIn.planDigest === gate.planDigest],
    ];
    const broken = bindings.find(([, ok]) => !ok);
    if (broken) return fail('EVIDENCE_MISMATCH', broken[0]);
    // The tree that minted the digest is the tree allowed to spend it. Honest limit: nothing
    // authenticates a git HEAD — this is a process guardrail, like every executor claim before
    // #91 Stage B — but it is checked mechanically and a mismatch refuses with zero calls made.
    if (evidenceIn.executorSha !== executorSha) return fail('EXECUTOR_MISMATCH', 'executorSha');
    // Every halt of this phase writes a structured record; require the path before acting.
    if (args.evidenceOut === undefined) return fail('ARGUMENT_MISSING', '--evidence-out');
  } else {
    stacks = typeof args.stacks === 'string' ? args.stacks.split(',').map((s) => s.trim()).filter(Boolean) : null;
    for (const [name, value, shape] of [
      ['--source-run', args.sourceRun, RUN_ID],
      ['--source-decision', args.sourceDecision, DECISION_ID],
      ['--source-correlation', args.sourceCorrelation, CORRELATION_ID],
      ['--evidence-out', args.evidenceOut, /^\/.+/],
    ]) {
      if (value === undefined) return fail('ARGUMENT_MISSING', name);
      if (!shape.test(String(value))) return fail('ARGUMENT_MALFORMED', name);
    }
    if (!stacks) return fail('ARGUMENT_MISSING', '--stacks');
    // The group is a REVIEWED one, in content and in order — never an arbitrary stack list.
    if (!DEPLOYMENT_PLAN_GROUPS.some((g) => JSON.stringify([...g]) === JSON.stringify(stacks))) {
      return fail('CLOUD_GATE_STACKS_INVALID', '--stacks');
    }
  }

  const stackNames = stacks.map((stackId) => stackNameFor(environment, stackId));
  setReviewedStackNames(stackNames);
  regionForCalls = region;

  // --- identity, then THIS TIER'S deploy role: the least-privilege path the lane itself uses ---
  const accountOf = () => {
    const res = guardedRun(['sts', 'get-caller-identity', '--output', 'json', '--no-cli-pager'], { timeoutMs: 30_000 });
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
  const qualifier = RELEASE_BOOTSTRAP_QUALIFIERS[environment];
  const credEnv = assumeBootstrapRole(guardedRun, {
    account: accountAtVerify,
    region,
    qualifier,
    name: 'deploy',
    session: `cba-70-recover-${phase}`,
  });
  if (blocked) return fail('COMMAND_NOT_ALLOWED', blocked);
  if (!credEnv) return fail('BOOTSTRAP_ROLE_UNASSUMABLE', 'deployRole');
  const cfn = (cmd, opts = {}) => guardedRun(cmd, { ...opts, env: { ...credEnv, ...(opts.env ?? {}) } });

  lines.push(`recover-declined-plan — phase ${phase}`);
  lines.push(`  executor sha     : ${executorSha}`);
  lines.push(`  target release   : ${targetReleaseSha}  (change set name ${changeSetName})`);
  lines.push(`  environment      : ${environment} in ${region}, account verified, deploy role assumed`);
  lines.push(`  group            : ${stacks.join(', ')}`);

  // --- DESCRIBE the group, in order, with the lane's own reader --------------------------------
  // Pagination consumed, pages required to agree, the r18 schema enforced — one reading contract.
  // In abandon, an absent set is a CLASSIFICATION (the continuation law below decides); in
  // inspect it is a refusal: a fresh record of a partially-deleted world would mint a digest
  // no fresh gate should name — continuations derive from the abandon artifact, never from here.
  const entries = [];
  const absentStacks = new Set();
  for (let i = 0; i < stacks.length; i += 1) {
    const stackId = stacks[i];
    const stackName = stackNames[i];
    const described = describePlannedChangeSet(cfn, {}, stackName, changeSetName);
    if (blocked) return fail('COMMAND_NOT_ALLOWED', blocked);
    if (described.missing) {
      if (phase === 'abandon') {
        absentStacks.add(stackName);
        continue;
      }
      return fail('CHANGE_SET_MISSING', stackId);
    }
    if (described.schemaViolations) return fail('CHANGE_SET_SCHEMA_UNKNOWN', stackId);
    if (described.pagesDiverge) return fail('CHANGE_SET_PAGES_DIVERGE', stackId);
    if (described.paginationUnconsumed) return fail('CHANGE_SET_PAGINATION_UNCONSUMED', stackId);
    if (described.error) return fail('CHANGE_SET_UNREADABLE', stackId);
    // Review r19 F2: the identity the response CLAIMS must be the identity this run verified —
    // an ARN naming another account or region is a foreign object, whatever its digest would be.
    const body = described.described;
    const csArnPrefix = `arn:aws:cloudformation:${region}:${accountAtVerify}:changeSet/`;
    const stackArnPrefix = `arn:aws:cloudformation:${region}:${accountAtVerify}:stack/${stackName}/`;
    if (typeof body.ChangeSetId !== 'string' || !body.ChangeSetId.startsWith(csArnPrefix)
      || typeof body.StackId !== 'string' || !body.StackId.startsWith(stackArnPrefix)) {
      return fail('CHANGE_SET_IDENTITY_FOREIGN', stackId);
    }
    // The deployment configuration is REPORTED, never enforced: this instrument removes a
    // declined plan, and refusing to delete what the execution policy would not approve is
    // exactly the trap review F2 (r18) removed from the lane.
    const configNote = deploymentConfigRefusal(body);
    entries.push({ entry: canonicalChangeSet(stackId, stackName, body), configNote, changeSetId: body.ChangeSetId, stackName });
  }

  const observedAt = new Date(now()).toISOString().replace(/\.\d{3}Z$/, 'Z');

  if (phase === 'inspect') {
    const entryDigests = entries.map((e) => entryDigestOf(e.entry));
    const planDigest = rootOf(entryDigests);
    for (let i = 0; i < entries.length; i += 1) {
      const { entry, configNote } = entries[i];
      lines.push(`  ${entry.stackName} — ${entry.status} / ${entry.executionStatus} — entry ${entryDigests[i]}`);
      if (configNote) lines.push(`      note: deployment configuration outside the execution policy (${configNote}) — reported, not enforced`);
    }
    lines.push(`  PLAN_DIGEST ${planDigest}`);
    // The closed record a gate may then name. No ARN, no account id, no credential: the
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
      source: { runId: String(args.sourceRun), decisionId: String(args.sourceDecision), correlationId: String(args.sourceCorrelation) },
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
    const body = `${JSON.stringify(evidence, null, 2)}\n`;
    try {
      writeFileSync(args.evidenceOut, body, { mode: 0o600 });
    } catch {
      return fail('EVIDENCE_UNWRITABLE', '--evidence-out');
    }
    return {
      exit: EXIT.OK,
      output: [
        ...lines,
        `INSPECTED (read-only; this phase cannot delete anything): evidence written to ${args.evidenceOut}`,
        `  evidence sha256  : ${crypto.createHash('sha256').update(body, 'utf8').digest('hex')}`,
        'The plan digest above is what an abandon authorization must name. Nothing was mutated.',
      ].join('\n'),
      deleted: [],
      planDigest,
      evidence,
    };
  }

  // --- ABANDON: the continuation law, ported member for member from the lane -------------------
  // The root is recomputed over the FULL reviewed group in order — present entries re-described
  // and re-digested, absent ones taking their digests from the gate (copied by Zamp from the
  // newest abandon artifact). The same root must emerge: a recreated set, a foreign set, a
  // missing digest or a leftover digest all kill it, and NOTHING is deleted on a dead root.
  const suppliedAbsent = [...(gate.absentEntryDigests ?? [])];
  const alreadyAbsent = [];
  const rootList = [];
  const fullMap = [];
  const presentByName = new Map(entries.map((e) => [e.stackName, e]));
  let seenPresent = false;
  let nonPrefixAbsence = null;
  let continuationBroken = false;
  for (let i = 0; i < stacks.length; i += 1) {
    const stackName = stackNames[i];
    if (absentStacks.has(stackName)) {
      // Deletion is ORDERED, so a genuine continuation's absences form a PREFIX. An absence
      // after the first present entry is a state this operation cannot have produced.
      if (seenPresent) {
        nonPrefixAbsence = stacks[i];
        break;
      }
      const supplied = suppliedAbsent.shift();
      if (supplied === undefined) {
        continuationBroken = true;
        break;
      }
      rootList.push(supplied);
      alreadyAbsent.push(stackName);
      fullMap.push({ stackName, changeSetName, status: 'ALREADY_ABSENT', canonicalSha256: supplied });
    } else {
      seenPresent = true;
      const e = presentByName.get(stackName);
      const digest = entryDigestOf(e.entry);
      rootList.push(digest);
      fullMap.push({ stackName, changeSetName, status: e.entry.status, canonicalSha256: digest });
    }
  }

  const deleted = [];
  const reportedRecords = [];
  // Review r19 F3: EVERY outcome of this phase writes a structured artifact sufficient to build
  // the next continuation by itself — the ORIGINAL root, the full ordered stack → digest map
  // (previously-absent positions included), what this run deleted, and how it ended.
  const writeRecord = (outcome) => {
    const record = {
      instrument: 'recover-declined-plan',
      phase: 'abandon',
      outcome,
      observedAt,
      decisionId: gate.decisionId,
      executorSha,
      targetReleaseSha,
      changeSetName,
      environment,
      region,
      manifestDigest,
      planDigest: gate.planDigest,
      changeSets: fullMap,
      alreadyAbsent: [...alreadyAbsent],
      deleted: [...deleted],
      reportedStackRecords: [...reportedRecords],
      failures: failures.map((f) => f.code),
    };
    try {
      writeFileSync(args.evidenceOut, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
      return true;
    } catch {
      return false;
    }
  };
  const haltWith = (code, field, note) => {
    failures.push({ code, field });
    const recorded = writeRecord('REFUSED');
    const refused = refuse();
    const tail = recorded ? '' : '\nTHE RECORD COULD NOT BE WRITTEN — the facts above exist only in this output; keep it.';
    return { ...refused, deleted, output: `${refused.output}${note ? `\n${note}` : ''}${tail}` };
  };

  if (nonPrefixAbsence !== null) return haltWith('ABANDON_NOT_A_PREFIX', nonPrefixAbsence);
  if (continuationBroken || suppliedAbsent.length > 0) return haltWith('CHANGE_SET_MISSING', 'absentEntryDigests');
  const root = rootOf(rootList);
  if (root !== gate.planDigest) return haltWith('PLAN_CHANGED', 'planDigest');

  const partial = () => (deleted.length === 0 ? 'none' : deleted.join(', '));
  for (const { entry, changeSetId } of entries) {
    // Revalidated immediately before EACH deletion: an account that moved or a window that
    // lapsed stops the operation where it stands, with the honest prefix on the record.
    const accountAtEffect = accountOf();
    if (blocked) return fail('COMMAND_NOT_ALLOWED', blocked);
    if (accountAtEffect !== accountAtVerify) {
      return haltWith('ACCOUNT_CHANGED', 'account', `Deleted before the halt: ${partial()}. The remaining change sets were NOT deleted.`);
    }
    if (now() >= Date.parse(gate.expiresAt)) {
      return haltWith('CLOUD_GATE_EXPIRED', 'expiresAt', `Deleted before the window lapsed: ${partial()}. The remaining change sets were NOT deleted.`);
    }

    // By the FULL observed ChangeSetId — never by name, which a recreated set would also answer.
    const deletion = cfn(['cloudformation', 'delete-change-set', '--change-set-name', changeSetId, '--no-cli-pager'], { timeoutMs: 30_000 });
    if (blocked) return fail('COMMAND_NOT_ALLOWED', blocked);
    if (!deletion || deletion.status !== 0) {
      // A failed delete CALL is AMBIGUOUS — the service may have accepted it while the transport
      // died — so the state is reconciled by bounded re-observation over a real window before
      // anything is claimed. Presence is an ALLOWLIST over the documented status enum and
      // requires an UNBROKEN window: one tainted read taints it all.
      const RECONCILE_ATTEMPTS = 5;
      const STANDING = ['CREATE_PENDING', 'CREATE_IN_PROGRESS', 'CREATE_COMPLETE', 'FAILED', 'DELETE_FAILED'];
      let observedMissing = false;
      let stoodStillAllWindow = true;
      for (let attempt = 0; attempt < RECONCILE_ATTEMPTS; attempt += 1) {
        if (attempt > 0) sleep();
        const observed = cfn(['cloudformation', 'describe-change-set', '--change-set-name', changeSetId, '--stack-name', entry.stackName, '--output', 'json', '--no-cli-pager'], { timeoutMs: 30_000 });
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
        deleted.push(entry.stackName);
        return haltWith('ABANDON_DELETE_FAILED', entry.stackId, `The delete call for ${entry.stackName} failed in transport but the set is PROVABLY ABSENT — recorded as deleted. Deleted so far: ${partial()}. The remaining change sets were NOT deleted — a surprised operation stops.`);
      }
      if (stoodStillAllWindow) {
        return haltWith('ABANDON_DELETE_FAILED', entry.stackId, `Deleted before the failure: ${partial()}. The set is provably still present; the remaining change sets were NOT deleted.`);
      }
      return haltWith('ABANDON_STATE_UNKNOWN', entry.stackId, `The delete call for ${entry.stackName} failed AND its state could not be observed — claimed neither deleted nor present. Deleted before it: ${partial()}. Read-only reconciliation of ${entry.stackName} is required before a new decision.`);
    }
    deleted.push(entry.stackName);
  }

  // REPORT — never delete — the stack records a CREATE change set leaves behind, over the FULL
  // group (the already-absent prefix left its records too). Review r19 F6: ONLY the exact
  // stack-does-not-exist answer concludes absence; every other failure reports as unverifiable.
  for (const stackName of stackNames) {
    const described = cfn(['cloudformation', 'describe-stacks', '--stack-name', stackName, '--output', 'json', '--no-cli-pager'], { timeoutMs: 30_000 });
    if (blocked) return fail('COMMAND_NOT_ALLOWED', blocked);
    if (!described || described.status !== 0) {
      if (described && /Stack with id [^\n]* does not exist/i.test(`${described.stderr || ''}`)) continue;
      reportedRecords.push(`${stackName} (status unverifiable)`);
      continue;
    }
    let status = null;
    try {
      status = JSON.parse(described.stdout || '{}').Stacks?.[0]?.StackStatus ?? null;
    } catch {
      status = null;
    }
    if (status === null) reportedRecords.push(`${stackName} (status unverifiable)`);
    else if (status === 'REVIEW_IN_PROGRESS') reportedRecords.push(`${stackName} (REVIEW_IN_PROGRESS)`);
  }

  const recorded = writeRecord('ABANDONED');
  return {
    exit: recorded ? EXIT.OK : EXIT.REFUSED,
    output: [
      ...lines,
      `  PLAN_DIGEST ${root} (matched the declined plan; decision ${gate.decisionId})`,
      alreadyAbsent.length > 0 ? `  already absent (continuation prefix): ${alreadyAbsent.join(', ')}` : null,
      `Deleted the declined change sets, in order: ${deleted.length > 0 ? deleted.join(', ') : 'none — the whole group was already absent'}.`,
      reportedRecords.length > 0
        ? `REPORTED (never deleted): ${reportedRecords.join(', ')} — resolving a stack record is a separate human decision under its own instrument, and this one has no DeleteStack.`
        : 'No stack record remains to report.',
      recorded ? `Continuation record written to ${args.evidenceOut}.` : `${describeRecoveryFailure({ code: 'EVIDENCE_UNWRITABLE', field: args.evidenceOut })} — THE DELETIONS ABOVE HAPPENED; keep this output.`,
    ].filter((l) => l !== null).join('\n'),
    deleted,
    planDigest: root,
  };
}

module.exports = {
  runRecoverDeclinedPlan,
  describeRecoveryFailure,
  RECOVERY_CODES,
  PHASE_COMMANDS,
  INSPECT_EVIDENCE_KEYS,
  RECONCILE_SLEEP_MS,
  defaultRun,
  defaultSleep,
  rootOf,
};

if (require.main === module) {
  const { exit, output } = runRecoverDeclinedPlan(process.argv.slice(2));
  process.stdout.write(`${output}\n`);
  process.exit(exit);
}
