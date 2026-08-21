'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  runRecoverDeclinedPlan,
  describeRecoveryFailure,
  RECOVERY_CODES,
  PHASE_COMMANDS,
  INSPECT_EVIDENCE_KEYS,
  RECONCILE_SLEEP_MS,
  defaultRun,
  defaultSleep,
  rootOf,
} = require('../bin/recover-declined-plan');
const { entryDigestOf, canonicalChangeSet, setReviewedStackNames, deepSortKeys } = require('../bin/deploy-release');
const { MANIFEST_VERSION, MANIFEST_TARGET_SERVICE, MANIFEST_TARGET_STACKS, BOUND_CONTEXT_KEYS, contextDigest } = require('../bin/deploy-preflight');
const { manifestBundleDigest } = require('../lib/deploy-preflight');

/* =================================================================================================
 * The scenario is the real one, and it is the whole point of this instrument:
 *
 *   EXECUTOR = the code AFTER the r18 fix (this worktree's clean HEAD);
 *   TARGET   = the release BEFORE it, named by its VERIFIED MANIFEST, whose SHA names the sets.
 *
 * The release lane cannot express that split — it runs the code of the release it addresses.
 * Every test keeps the two identities distinct, the authorization is the CANONICAL eleven-key
 * abandon gate (review r19 F1 — no invented mode, no new schema), and the binding between the
 * phases is the inspect evidence the abandon consumes (F4).
 * ============================================================================================= */
const ACCOUNT = '1'.repeat(12);
const EXECUTOR_SHA = 'cdce903ce06387c60ee0c432819ec67ab21b06cf';
const TARGET_SHA = 'e822c79630de19d43d1955011223f53b53b85cca';
const CHANGE_SET_NAME = `cba-70-${TARGET_SHA.slice(0, 12)}`;
const STACKS = ['IdentityStack', 'DataStack'];
const STACK_NAMES = ['cba-study-coach-dev-identity', 'cba-study-coach-dev-data'];
const NOW = Date.parse('2026-08-21T00:00:00Z');

/** A real cdk.json with an EMPTY context: the recompute (r20 F1) reads it, so the manifest's
 * contextDigest below is computed the same way the bind computed the real one — with the
 * ACCOUNT the cloud stub answers. A manifest minted for another account then genuinely fails. */
const CDK_JSON = (() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cba-recover-cdk-'));
  const p = path.join(dir, 'cdk.json');
  fs.writeFileSync(p, JSON.stringify({ context: {} }));
  return p;
})();
const contextDigestFor = (accountId) => contextDigest({
  releaseSha: TARGET_SHA, environment: 'dev', region: 'us-east-1', accountId, context: {},
});

/** A shape-valid manifest for the TARGET release — the bind artifact this instrument consumes. */
const manifestFor = (over = {}) => ({
  version: MANIFEST_VERSION,
  issue: 70,
  releaseSha: TARGET_SHA,
  environment: 'dev',
  region: 'us-east-1',
  contextDigest: contextDigestFor('1'.repeat(12)),
  assemblyDigest: 'd'.repeat(64),
  boundContextKeys: [...BOUND_CONTEXT_KEYS].sort(),
  preflight: { PREFLIGHT_1: 'pass', PREFLIGHT_2: 'pass' },
  target: { service: MANIFEST_TARGET_SERVICE, stacks: [...MANIFEST_TARGET_STACKS] },
  ...over,
});
const MANIFEST = manifestFor();
const MANIFEST_DIGEST = manifestBundleDigest(MANIFEST, deepSortKeys);

const uuidFor = (stackName) => `00000000-0000-0000-0000-${String(STACK_NAMES.indexOf(stackName) + 1).padStart(12, '0')}`;
const csArn = (stackName) => `arn:aws:cloudformation:us-east-1:${ACCOUNT}:changeSet/${CHANGE_SET_NAME}/${uuidFor(stackName)}`;
const stackArn = (stackName) => `arn:aws:cloudformation:us-east-1:${ACCOUNT}:stack/${stackName}/aaaaaaaa-bbbb-cccc-dddd-${String(STACK_NAMES.indexOf(stackName) + 1).padStart(12, '0')}`;

/** The live dev response shape, r18-complete: six explicit nulls and a deployment configuration. */
const describeBody = (stackName, over = {}) => ({
  Changes: [{ Type: 'Resource', ResourceChange: { Action: 'Add', LogicalResourceId: 'CDKMetadata', ResourceType: 'AWS::CDK::Metadata', Scope: [], Details: [] } }],
  ChangeSetName: CHANGE_SET_NAME,
  ChangeSetId: csArn(stackName),
  StackId: stackArn(stackName),
  StackName: stackName,
  Description: 'CDK Changeset for execution 04f1af7e-d012-436a-a40a-b22092899478',
  Parameters: [{ ParameterKey: 'BootstrapVersion', ParameterValue: '/cdk-bootstrap/cbardev/version', ResolvedValue: '32' }],
  CreationTime: '2026-08-20T12:56:47.555000+00:00',
  ExecutionStatus: 'AVAILABLE',
  Status: 'CREATE_COMPLETE',
  StatusReason: null,
  NotificationARNs: [],
  Capabilities: ['CAPABILITY_IAM', 'CAPABILITY_NAMED_IAM'],
  Tags: [{ Key: 'Project', Value: 'CBAStudyCoach' }],
  ParentChangeSetId: null,
  IncludeNestedStacks: true,
  RootChangeSetId: null,
  OnStackFailure: null,
  ImportExistingResources: false,
  StackDriftStatus: null,
  DeploymentMode: null,
  DeploymentConfig: { Mode: 'STANDARD', DisableRollback: false },
  ...over,
});

const entryDigestFor = (stackName, body) => {
  setReviewedStackNames(STACK_NAMES);
  const stackId = STACKS[STACK_NAMES.indexOf(stackName)];
  return entryDigestOf(canonicalChangeSet(stackId, stackName, body ?? describeBody(stackName)));
};
function expectedPlanDigest(bodies = {}) {
  return rootOf(STACK_NAMES.map((name) => entryDigestFor(name, bodies[name])));
}

/** A cloud stub answering identity, assume-role, describes, deletes and stack records. */
function cloud({ bodies = {}, account = ACCOUNT, missing = new Set(), deleteStatus = 0, deleteStderr = '', stackRecordStderr = null, onCall, afterDelete } = {}) {
  const calls = [];
  const deletedIds = new Set();
  let deleteAttempts = 0;
  const fn = (args, opts) => {
    calls.push({ args, opts });
    if (onCall) {
      const intercepted = onCall(args, calls);
      if (intercepted) return intercepted;
    }
    const verb = `${args[0]} ${args[1]}`;
    if (verb === 'sts get-caller-identity') return { status: 0, stdout: JSON.stringify({ Account: typeof account === 'function' ? account(calls) : account }), stderr: '' };
    if (verb === 'sts assume-role') {
      return { status: 0, stdout: JSON.stringify({ Credentials: { AccessKeyId: 'ASIATESTKEY', SecretAccessKey: 'secret', SessionToken: 'token' } }), stderr: '' };
    }
    if (verb === 'cloudformation describe-change-set') {
      const stackName = args.includes('--stack-name') ? args[args.indexOf('--stack-name') + 1] : null;
      const named = args[args.indexOf('--change-set-name') + 1];
      if (missing.has(stackName) || (named.startsWith('arn:') && deletedIds.has(named))) {
        return { status: 254, stdout: '', stderr: 'ChangeSetNotFound: the change set does not exist' };
      }
      if (!named.startsWith('arn:') && named !== CHANGE_SET_NAME) {
        return { status: 254, stdout: '', stderr: 'ChangeSetNotFound: the change set does not exist' };
      }
      if (afterDelete && deleteAttempts > 0) return afterDelete(args, deletedIds);
      return { status: 0, stdout: JSON.stringify(bodies[stackName] ?? describeBody(stackName)), stderr: '' };
    }
    if (verb === 'cloudformation delete-change-set') {
      deleteAttempts += 1;
      if (deleteStatus === 0) deletedIds.add(args[args.indexOf('--change-set-name') + 1]);
      return { status: deleteStatus, stdout: '', stderr: deleteStderr };
    }
    if (verb === 'cloudformation describe-stacks') {
      const stackName = args[args.indexOf('--stack-name') + 1];
      if (stackRecordStderr !== null) return { status: 254, stdout: '', stderr: stackRecordStderr };
      return { status: 0, stdout: JSON.stringify({ Stacks: [{ StackName: stackName, StackStatus: 'REVIEW_IN_PROGRESS' }] }), stderr: '' };
    }
    return { status: 254, stdout: '', stderr: 'unexpected command' };
  };
  fn.of = (verb) => calls.filter((c) => `${c.args[0]} ${c.args[1]}` === verb);
  fn.calls = calls;
  return fn;
}

const cleanGit = (head = EXECUTOR_SHA, dirty = '') => (args) => {
  if (args[1] === 'HEAD') return { status: 0, stdout: `${head}\n`, stderr: '' };
  if (args[0] === 'status') return { status: 0, stdout: dirty, stderr: '' };
  return { status: 1, stdout: '', stderr: '' };
};

/** The CANONICAL eleven-key gate, exactly as the lane's checkCloudGate demands it. */
const gateFor = (over = {}) => JSON.stringify({
  absentEntryDigests: null,
  approvedAt: '2026-08-20T23:50:00Z',
  decisionId: 'zamp-2026-08-21.111-recover-01',
  environment: 'dev',
  expiresAt: '2026-08-21T00:30:00Z',
  issue: 70,
  manifestDigest: MANIFEST_DIGEST,
  mode: 'abandon',
  planDigest: expectedPlanDigest(),
  releaseSha: TARGET_SHA,
  stacks: [...STACKS],
  ...over,
});

/** A valid inspect record binding the abandon to the digest the gate names. */
const evidenceFor = (over = {}) => ({
  accountVerified: true,
  changeSetName: CHANGE_SET_NAME,
  entries: STACK_NAMES.map((name) => ({
    stackId: STACKS[STACK_NAMES.indexOf(name)],
    stackName: name,
    status: 'CREATE_COMPLETE',
    executionStatus: 'AVAILABLE',
    entryDigest: entryDigestFor(name),
    deploymentConfigWithinExecutionPolicy: true,
  })),
  environment: 'dev',
  executorSha: EXECUTOR_SHA,
  instrument: 'recover-declined-plan',
  manifestDigest: MANIFEST_DIGEST,
  observedAt: '2026-08-20T23:45:00Z',
  phase: 'inspect',
  planDigest: expectedPlanDigest(),
  region: 'us-east-1',
  source: { runId: '32371072834', decisionId: 'zamp-2026-08-20.111-plan-wave1', correlationId: 'cba-70-1d5c8a54a0f4f8b548b41c76238c0d50' },
  stacks: [...STACKS],
  targetReleaseSha: TARGET_SHA,
  ...over,
});

/** Run the instrument with injected files (manifest, evidence) and cloud. */
function runIt(argv, { run, gate, git = cleanGit(), now = () => NOW, manifest = MANIFEST, evidenceIn, out = {} } = {}) {
  const files = new Map();
  files.set('/gate/manifest.json', JSON.stringify(manifest));
  if (evidenceIn !== undefined) files.set('/gate/evidence.json', JSON.stringify(evidenceIn));
  return runRecoverDeclinedPlan(argv, {
    run,
    git,
    now,
    sleep: () => {},
    cdkJsonPath: CDK_JSON,
    env: gate === undefined ? {} : { CBA_CLOUD_GATE: gate },
    lstatSync: (p) => {
      if (!files.has(p)) throw new Error('ENOENT');
      return { isFile: () => true, size: files.get(p).length };
    },
    readFileSync: (p) => {
      if (!files.has(p)) throw new Error('ENOENT');
      return files.get(p);
    },
    writeFileSync: (p, contents) => { out.path = p; out.body = contents; },
  });
}

const INSPECT_ARGV = [
  '--phase', 'inspect',
  '--manifest', '/gate/manifest.json',
  '--source-run', '32371072834',
  '--source-decision', 'zamp-2026-08-20.111-plan-wave1',
  '--source-correlation', 'cba-70-1d5c8a54a0f4f8b548b41c76238c0d50',
  '--stacks', STACKS.join(','),
  '--evidence-out', '/tmp/evidence.json',
];
const ABANDON_ARGV = [
  '--phase', 'abandon',
  '--manifest', '/gate/manifest.json',
  '--evidence', '/gate/evidence.json',
  '--evidence-out', '/tmp/abandon-record.json',
];

// -------------------------------------------------------------------------------------------------
// The boundary that is mechanical, not intentional
// -------------------------------------------------------------------------------------------------

test('DeleteStack is unreachable: no phase allowlist contains it, and inspect cannot delete at all', () => {
  const flat = JSON.stringify(PHASE_COMMANDS);
  assert.equal(flat.includes('delete-stack'), false, 'the stack-record deletion must not be expressible');
  assert.equal(PHASE_COMMANDS.inspect.includes('cloudformation delete-change-set'), false, 'a read-only phase must not be able to delete');
  assert.deepEqual(
    PHASE_COMMANDS.abandon.filter((c) => c.startsWith('cloudformation delete')),
    ['cloudformation delete-change-set'],
    'exactly one deletion verb exists, and it is the change-set one',
  );
  for (const code of Object.keys(RECOVERY_CODES)) {
    assert.match(describeRecoveryFailure({ code, field: 'x' }), new RegExp(`\\[${code}\\]$`));
  }
  // Lane codes render through the same door; an unknown code still throws.
  assert.match(describeRecoveryFailure({ code: 'CLOUD_GATE_EXPIRED', field: 'expiresAt' }), /\[CLOUD_GATE_EXPIRED\]$/);
  assert.throws(() => describeRecoveryFailure({ code: 'NOT_A_CODE', field: 'x' }));
});

test('the phases are mutually exclusive and there is no default', () => {
  for (const phase of [undefined, 'both', 'INSPECT', 'delete', '']) {
    const argv = phase === undefined ? [] : ['--phase', phase];
    const r = runRecoverDeclinedPlan(argv, { run: () => assert.fail('no cloud call may happen'), git: cleanGit() });
    assert.notEqual(r.exit, 0, String(phase));
    if (argv.length > 0) assert.match(r.output, /PHASE_INVALID/);
  }
});

// -------------------------------------------------------------------------------------------------
// Review r19 F2 — the REAL runner, the region on both channels, and foreign identities
// -------------------------------------------------------------------------------------------------

test('defaultRun spawns the real child with opts.env MERGED over the process environment', () => {
  // A fake `aws` on PATH records its argv and the env it actually received.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cba-fake-aws-'));
  try {
    const log = path.join(dir, 'calls.log');
    fs.writeFileSync(path.join(dir, 'aws'), `#!/usr/bin/env bash\nprintf '%s\\n' "ARGS:$*" "REGION:\${AWS_REGION:-unset}" >> '${log}'\necho '{}'\n`, { mode: 0o755 });
    const oldPath = process.env.PATH;
    process.env.PATH = `${dir}:${oldPath}`;
    try {
      const res = defaultRun(['sts', 'get-caller-identity'], { timeoutMs: 10_000, env: { AWS_REGION: 'us-east-1' } });
      assert.equal(res.status, 0);
      const logged = fs.readFileSync(log, 'utf8');
      assert.match(logged, /ARGS:sts get-caller-identity/);
      assert.match(logged, /--cli-connect-timeout 5/);
      assert.match(logged, /REGION:us-east-1/, 'opts.env must reach the child — a runner that drops it makes the region decorative');
    } finally {
      process.env.PATH = oldPath;
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('every AWS call carries the manifest region on BOTH channels — argument and environment', () => {
  const run = cloud();
  const r = runIt(INSPECT_ARGV, { run });
  assert.equal(r.exit, 0, r.output);
  assert.ok(run.calls.length >= 4, 'identity, assume-role and the describes all happened');
  for (const call of run.calls) {
    const region = call.args[call.args.indexOf('--region') + 1];
    assert.equal(region, 'us-east-1', `${call.args[0]} ${call.args[1]} must carry --region`);
    assert.equal(call.opts?.env?.AWS_REGION, 'us-east-1', `${call.args[0]} ${call.args[1]} must carry AWS_REGION`);
    assert.equal(call.opts?.env?.AWS_DEFAULT_REGION, 'us-east-1');
  }
  // And the cloudformation calls run under the ASSUMED deploy role, not ambient credentials.
  for (const call of run.of('cloudformation describe-change-set')) {
    assert.equal(call.opts?.env?.AWS_ACCESS_KEY_ID, 'ASIATESTKEY', 'the tier deploy role is the least-privilege path');
  }
});

test('the tier deploy role is assumed like the lane assumes it, and an unassumable role stops everything', () => {
  const run = cloud();
  const ok = runIt(INSPECT_ARGV, { run });
  assert.equal(ok.exit, 0);
  const assume = run.of('sts assume-role');
  assert.equal(assume.length, 1);
  const roleArn = assume[0].args[assume[0].args.indexOf('--role-arn') + 1];
  assert.equal(roleArn, `arn:aws:iam::${ACCOUNT}:role/cdk-cbardev-deploy-role-${ACCOUNT}-us-east-1`);

  const failing = cloud({ onCall: (args) => (args[1] === 'assume-role' ? { status: 254, stdout: '', stderr: 'AccessDenied' } : null) });
  const r = runIt(ABANDON_ARGV, { run: failing, gate: gateFor(), evidenceIn: evidenceFor() });
  assert.equal(r.exit, 1);
  assert.match(r.output, /BOOTSTRAP_ROLE_UNASSUMABLE/);
  assert.equal(failing.of('cloudformation delete-change-set').length, 0);
});

test('an ARN naming another account or region is FOREIGN and is never deleted', () => {
  for (const [label, over] of [
    ['another account in the change-set ARN', { ChangeSetId: `arn:aws:cloudformation:us-east-1:${'9'.repeat(12)}:changeSet/${CHANGE_SET_NAME}/${uuidFor(STACK_NAMES[0])}` }],
    ['another region in the change-set ARN', { ChangeSetId: `arn:aws:cloudformation:eu-west-1:${ACCOUNT}:changeSet/${CHANGE_SET_NAME}/${uuidFor(STACK_NAMES[0])}` }],
    ['another region in the stack ARN', { StackId: `arn:aws:cloudformation:eu-west-1:${ACCOUNT}:stack/${STACK_NAMES[0]}/aaaaaaaa-bbbb-cccc-dddd-000000000001` }],
  ]) {
    const run = cloud({ bodies: { [STACK_NAMES[0]]: describeBody(STACK_NAMES[0], over) } });
    const r = runIt(ABANDON_ARGV, { run, gate: gateFor(), evidenceIn: evidenceFor() });
    assert.equal(r.exit, 1, label);
    assert.match(r.output, /CHANGE_SET_IDENTITY_FOREIGN/, label);
    assert.equal(run.of('cloudformation delete-change-set').length, 0, label);
  }
});

// -------------------------------------------------------------------------------------------------
// Review r19 F5 — the reconciliation window is real time, not a burst
// -------------------------------------------------------------------------------------------------

test('the production sleep is a five-second bounded wait, and the window lets a deletion surface', () => {
  assert.equal(RECONCILE_SLEEP_MS, 5000);
  const original = Atomics.wait;
  let captured = null;
  Atomics.wait = (arr, index, value, timeout) => { captured = timeout; return 'timed-out'; };
  try {
    defaultSleep();
  } finally {
    Atomics.wait = original;
  }
  assert.equal(captured, RECONCILE_SLEEP_MS, 'defaultSleep must actually wait between observations');

  // Convergence: the set still answers at the first re-observation and is gone by the third —
  // exactly what an accepted deletion looks like. The whole window testifies: ABSENT.
  let reconciles = 0;
  const run = cloud({
    deleteStatus: 254,
    deleteStderr: 'Read timeout on endpoint URL',
    afterDelete: (args) => {
      reconciles += 1;
      if (reconciles < 3) return { status: 0, stdout: JSON.stringify(describeBody(args[args.indexOf('--stack-name') + 1], { ChangeSetId: args[args.indexOf('--change-set-name') + 1] })), stderr: '' };
      return { status: 254, stdout: '', stderr: 'ChangeSetNotFound' };
    },
  });
  const r = runIt(ABANDON_ARGV, { run, gate: gateFor(), evidenceIn: evidenceFor() });
  assert.equal(r.exit, 1);
  assert.match(r.output, /PROVABLY ABSENT/, 'a deletion that surfaces mid-window is a deletion');
  assert.deepEqual(r.deleted, [STACK_NAMES[0]]);
});

// -------------------------------------------------------------------------------------------------
// The target is the MANIFEST, and the authority is the CANONICAL gate (review r19 F1)
// -------------------------------------------------------------------------------------------------

test('inspect derives everything from the verified manifest and mints the digest, mutating nothing', () => {
  const run = cloud();
  const out = {};
  const r = runIt(INSPECT_ARGV, { run, out });
  assert.equal(r.exit, 0, r.output);
  assert.equal(run.of('cloudformation delete-change-set').length, 0, 'inspect deletes nothing');
  assert.equal(r.planDigest, expectedPlanDigest());
  assert.match(r.output, /evidence sha256\s+: [0-9a-f]{64}/, 'the record digest is printed for the audit chain');

  const written = JSON.parse(out.body);
  assert.deepEqual(Object.keys(written).sort(), [...INSPECT_EVIDENCE_KEYS]);
  assert.equal(written.targetReleaseSha, TARGET_SHA, 'the target comes from the manifest, never typed');
  assert.equal(written.manifestDigest, MANIFEST_DIGEST, 'the digest is COMPUTED from the manifest bytes');
  assert.equal(written.executorSha, EXECUTOR_SHA);
  assert.notEqual(written.executorSha, written.targetReleaseSha, 'executor and target are SEPARATE, and that is the point');
  assert.equal(written.changeSetName, CHANGE_SET_NAME);
  assert.deepEqual(written.source, { runId: '32371072834', decisionId: 'zamp-2026-08-20.111-plan-wave1', correlationId: 'cba-70-1d5c8a54a0f4f8b548b41c76238c0d50' });
  assert.equal(out.body.includes(ACCOUNT), false, 'the account id is never published');
  assert.equal(out.body.includes('arn:aws:'), false, 'no ARN is published');
});

test('a manifest that is malformed, unreadable or re-aimed refuses before any cloud call', () => {
  const noCloud = () => assert.fail('no cloud call may happen');
  const bad = runIt(INSPECT_ARGV, { run: noCloud, manifest: manifestFor({ extra: 1 }) });
  assert.equal(bad.exit, 1);
  assert.match(bad.output, /MANIFEST_INVALID/);

  const gone = runRecoverDeclinedPlan(INSPECT_ARGV, {
    run: noCloud, git: cleanGit(), now: () => NOW, env: {},
    lstatSync: () => { throw new Error('ENOENT'); }, readFileSync: () => { throw new Error('ENOENT'); },
  });
  assert.equal(gone.exit, 1);
  assert.match(gone.output, /MANIFEST_UNREADABLE/);

  // A gate written for THIS manifest refuses against another: the binding is the bundle digest.
  const otherManifest = manifestFor({ contextDigest: 'e'.repeat(64) });
  const run = cloud();
  const r = runIt(ABANDON_ARGV, { run, gate: gateFor(), manifest: otherManifest, evidenceIn: evidenceFor() });
  assert.equal(r.exit, 1);
  assert.match(r.output, /CLOUD_GATE_MISMATCH/);
  assert.equal(run.of('cloudformation delete-change-set').length, 0);
});

test('abandon consumes the CANONICAL eleven-key gate — the lane\'s own checkCloudGate, nothing invented', () => {
  const run = cloud();
  const out = {};
  const r = runIt(ABANDON_ARGV, { run, gate: gateFor(), evidenceIn: evidenceFor(), out });
  assert.equal(r.exit, 0, r.output);
  assert.deepEqual(r.deleted, STACK_NAMES, 'both, in the reviewed order');
  const deletions = run.of('cloudformation delete-change-set');
  assert.equal(deletions.length, 2);
  deletions.forEach((call, i) => {
    assert.equal(call.args[call.args.indexOf('--change-set-name') + 1], csArn(STACK_NAMES[i]), 'deleted by the FULL observed id, never by name');
  });
  assert.ok(run.of('sts get-caller-identity').length >= 3, 'the account is re-verified before every deletion');
  assert.match(r.output, /REPORTED \(never deleted\)/);
  assert.match(r.output, /REVIEW_IN_PROGRESS/);
  // Every outcome writes the continuation record.
  const record = JSON.parse(out.body);
  assert.equal(record.outcome, 'ABANDONED');
  assert.deepEqual(record.deleted, STACK_NAMES);
  assert.equal(record.planDigest, expectedPlanDigest());
});

test('the canonical gate\'s own law is enforced — malformed shapes, windows and groups refuse by lane code', () => {
  const cases = [
    ['a twelve-key gate', gateFor({ extra: 1 }), /CLOUD_GATE_MALFORMED/],
    ['a missing key', (() => { const g = JSON.parse(gateFor()); delete g.manifestDigest; return JSON.stringify(g); })(), /CLOUD_GATE_MALFORMED/],
    ['another issue', gateFor({ issue: 111 }), /CLOUD_GATE_MALFORMED/],
    ['plan_only with a null digest', gateFor({ mode: 'plan_only', planDigest: null }), /GATE_MODE_MISMATCH/],
    ['a deploy gate', gateFor({ mode: 'deploy' }), /GATE_MODE_MISMATCH/],
    ['an expired window', gateFor({ approvedAt: '2026-08-20T22:30:00Z', expiresAt: '2026-08-20T23:00:00Z' }), /CLOUD_GATE_EXPIRED/],
    ['a window over an hour', gateFor({ approvedAt: '2026-08-20T22:00:00Z', expiresAt: '2026-08-21T00:30:00Z' }), /CLOUD_GATE_TTL_EXCEEDED/],
    ['a future approval', gateFor({ approvedAt: '2026-08-21T00:10:00Z', expiresAt: '2026-08-21T00:40:00Z' }), /CLOUD_GATE_NOT_YET_VALID/],
    ['a foreign environment', gateFor({ environment: 'pilot' }), /CLOUD_GATE_MISMATCH/],
    ['a foreign release', gateFor({ releaseSha: EXECUTOR_SHA }), /CLOUD_GATE_MISMATCH/],
    ['a wrong manifest digest', gateFor({ manifestDigest: 'f'.repeat(64) }), /CLOUD_GATE_MISMATCH/],
    ['an unreviewed group', gateFor({ stacks: ['DataStack', 'IdentityStack'] }), /CLOUD_GATE_STACKS_INVALID/],
    ['absent entirely', undefined, /CLOUD_GATE_MISSING/],
  ];
  for (const [label, gate, expected] of cases) {
    const run = cloud();
    const r = runIt(ABANDON_ARGV, { run, gate, evidenceIn: evidenceFor() });
    assert.equal(r.exit, 1, label);
    assert.match(r.output, expected, label);
    assert.equal(run.of('cloudformation delete-change-set').length, 0, label);
  }
});

// -------------------------------------------------------------------------------------------------
// Review r19 F4 — the inspect evidence is the binding, and every claim in it is confronted
// -------------------------------------------------------------------------------------------------

test('abandon requires the inspect evidence and confronts every binding in it', () => {
  // The ARGUMENT absent and the FILE absent are different facts with different names.
  const noArg = runIt(['--phase', 'abandon', '--manifest', '/gate/manifest.json', '--evidence-out', '/tmp/x.json'], { run: cloud(), gate: gateFor() });
  assert.equal(noArg.exit, 1);
  assert.match(noArg.output, /EVIDENCE_MISSING/);
  const cases = [
    ['a file that is not there', undefined, /EVIDENCE_UNREADABLE/],
    ['an extra key', evidenceFor({ extra: 1 }), /EVIDENCE_MALFORMED/],
    ['a wrong instrument', evidenceFor({ instrument: 'somebody-else' }), /EVIDENCE_MALFORMED/],
    ['an abandon record where an inspect one belongs', evidenceFor({ phase: 'abandon' }), /EVIDENCE_MALFORMED/],
    ['a different plan digest than the gate names', evidenceFor({ planDigest: 'b'.repeat(64) }), /EVIDENCE_MISMATCH/],
    ['a different manifest digest', evidenceFor({ manifestDigest: 'f'.repeat(64) }), /EVIDENCE_MISMATCH/],
    ['a different release', evidenceFor({ targetReleaseSha: EXECUTOR_SHA }), /EVIDENCE_MISMATCH/],
    ['a different change-set name', evidenceFor({ changeSetName: 'cba-70-abcdefabcdef' }), /EVIDENCE_MISMATCH/],
    // Inconsistent inside (one stack, two entries): malformed before any binding is consulted.
    ['a group its own entries contradict', evidenceFor({ stacks: ['ApiStack'] }), /EVIDENCE_MALFORMED/],
    // Consistent inside, but a DIFFERENT group than the gate names: the binding refuses it.
    ['a different group, internally consistent', evidenceFor({
      stacks: ['ApiStack'],
      planDigest: rootOf(['a'.repeat(64)]),
      entries: [{ stackId: 'ApiStack', stackName: 'cba-study-coach-dev-api', status: 'CREATE_COMPLETE', executionStatus: 'AVAILABLE', entryDigest: 'a'.repeat(64), deploymentConfigWithinExecutionPolicy: true }],
    }), /EVIDENCE_MISMATCH/],
    ['a different region', evidenceFor({ region: 'eu-west-1' }), /EVIDENCE_MISMATCH/],
  ];
  for (const [label, evidenceIn, expected] of cases) {
    const run = cloud();
    const r = runIt(ABANDON_ARGV, { run, gate: gateFor(), evidenceIn });
    assert.equal(r.exit, 1, label);
    assert.match(r.output, expected, label);
    assert.equal(run.of('cloudformation delete-change-set').length, 0, label);
    assert.equal(run.of('cloudformation describe-change-set').length, 0, `${label}: it stops before reading the cloud`);
  }
});

test('the tree that minted the digest is the tree allowed to spend it — and swaps delete nothing', () => {
  // The evidence names the fixed code, but ANOTHER tree is running.
  const runA = cloud();
  const a = runIt(ABANDON_ARGV, { run: runA, gate: gateFor(), evidenceIn: evidenceFor(), git: cleanGit(TARGET_SHA) });
  assert.equal(a.exit, 1);
  assert.match(a.output, /EXECUTOR_MISMATCH/);
  assert.equal(runA.calls.length, 0, 'not one cloud call');

  // The manifest re-aimed at the EXECUTOR's release: the gate bound to the true manifest dies
  // on its digest, so the swap never even reaches the change sets.
  const swapped = manifestFor({ releaseSha: EXECUTOR_SHA });
  const runB = cloud();
  const b = runIt(ABANDON_ARGV, { run: runB, gate: gateFor(), manifest: swapped, evidenceIn: evidenceFor() });
  assert.equal(b.exit, 1);
  assert.match(b.output, /CLOUD_GATE_MISMATCH/);
  assert.equal(runB.of('cloudformation delete-change-set').length, 0);
});

// -------------------------------------------------------------------------------------------------
// The digest law and review r19 F3 — the continuation
// -------------------------------------------------------------------------------------------------

test('a digest that is not this plan refuses as PLAN_CHANGED with zero deletions, and the halt is recorded', () => {
  const recreated = describeBody(STACK_NAMES[1], {
    ChangeSetId: `arn:aws:cloudformation:us-east-1:${ACCOUNT}:changeSet/${CHANGE_SET_NAME}/99999999-9999-9999-9999-999999999999`,
    CreationTime: '2026-08-21T09:00:00.000000+00:00',
  });
  const bodies = { [STACK_NAMES[1]]: recreated };
  const liveDigest = expectedPlanDigest(bodies);
  const run = cloud({ bodies });
  const out = {};
  // The gate and evidence agree with each other but the WORLD moved: recreated set, new digest.
  const r = runIt(ABANDON_ARGV, { run, gate: gateFor(), evidenceIn: evidenceFor(), out });
  assert.equal(r.exit, 1);
  assert.match(r.output, /PLAN_CHANGED/);
  assert.equal(run.of('cloudformation delete-change-set').length, 0);
  assert.notEqual(liveDigest, expectedPlanDigest(), 'the recreation is what changed the digest');
  const record = JSON.parse(out.body);
  assert.equal(record.outcome, 'REFUSED');
  assert.deepEqual(record.failures, ['PLAN_CHANGED']);
});

test('REGRESSION (r19 F3): a halted abandon resumes from its own newest artifact alone', () => {
  // RUN A: the first set deletes; the delete of the second fails with the set provably present.
  let deletions = 0;
  const runA = cloud({
    onCall: (args) => {
      if (args[1] !== 'delete-change-set') return null;
      deletions += 1;
      return deletions === 2 ? { status: 254, stdout: '', stderr: 'ValidationError: cannot delete' } : null;
    },
  });
  const outA = {};
  const a = runIt(ABANDON_ARGV, { run: runA, gate: gateFor(), evidenceIn: evidenceFor(), out: outA });
  assert.equal(a.exit, 1);
  assert.match(a.output, /ABANDON_DELETE_FAILED/);
  assert.deepEqual(a.deleted, [STACK_NAMES[0]]);
  const recordA = JSON.parse(outA.body);
  assert.equal(recordA.outcome, 'REFUSED');
  assert.deepEqual(recordA.deleted, [STACK_NAMES[0]]);
  assert.equal(recordA.planDigest, expectedPlanDigest(), 'the ORIGINAL root stays on the record');
  assert.equal(recordA.changeSets.length, 2, 'the full ordered map survives the halt');

  // RUN B derives ONLY from record A: the deleted prefix's digest is copied into the new gate's
  // absentEntryDigests, the root is unchanged, and the world now lacks the first set.
  const prefixDigest = recordA.changeSets.find((c) => c.stackName === STACK_NAMES[0]).canonicalSha256;
  const gateB = gateFor({
    decisionId: 'zamp-2026-08-21.111-recover-02',
    absentEntryDigests: [prefixDigest],
    planDigest: recordA.planDigest,
  });
  const runB = cloud({ missing: new Set([STACK_NAMES[0]]) });
  const outB = {};
  const b = runIt(ABANDON_ARGV, { run: runB, gate: gateB, evidenceIn: evidenceFor(), out: outB });
  assert.equal(b.exit, 0, b.output);
  assert.deepEqual(b.deleted, [STACK_NAMES[1]], 'exactly the remainder, nothing re-deleted');
  assert.match(b.output, /already absent \(continuation prefix\): cba-study-coach-dev-identity/);
  const recordB = JSON.parse(outB.body);
  assert.equal(recordB.outcome, 'ABANDONED');
  assert.deepEqual(recordB.alreadyAbsent, [STACK_NAMES[0]]);
  assert.equal(recordB.planDigest, recordA.planDigest, 'a second interruption would resume from THIS record the same way');
});

test('the continuation law refuses what an ordered deletion cannot have produced', () => {
  // An absence AFTER the first present entry: not a prefix.
  const runA = cloud({ missing: new Set([STACK_NAMES[1]]) });
  const a = runIt(ABANDON_ARGV, { run: runA, gate: gateFor({ absentEntryDigests: [entryDigestFor(STACK_NAMES[1])] }), evidenceIn: evidenceFor() });
  assert.equal(a.exit, 1);
  assert.match(a.output, /ABANDON_NOT_A_PREFIX/);
  assert.equal(runA.of('cloudformation delete-change-set').length, 0);

  // An absent set with no digest on the gate: not a continuation.
  const runB = cloud({ missing: new Set([STACK_NAMES[0]]) });
  const b = runIt(ABANDON_ARGV, { run: runB, gate: gateFor(), evidenceIn: evidenceFor() });
  assert.equal(b.exit, 1);
  assert.match(b.output, /CHANGE_SET_MISSING/);
  assert.equal(runB.of('cloudformation delete-change-set').length, 0);

  // A leftover supplied digest: the gate describes a world that is not this one.
  const runC = cloud();
  const c = runIt(ABANDON_ARGV, { run: runC, gate: gateFor({ absentEntryDigests: [entryDigestFor(STACK_NAMES[0])] }), evidenceIn: evidenceFor() });
  assert.equal(c.exit, 1);
  assert.match(c.output, /CHANGE_SET_MISSING/);
  assert.equal(runC.of('cloudformation delete-change-set').length, 0);
});

test('a schema-divergent or self-contradicting description is never digested, and nothing is deleted', () => {
  for (const [label, over, expected] of [
    ['an unreviewed field', { Sneaky: 'x' }, /CHANGE_SET_SCHEMA_UNKNOWN/],
    ['an undocumented deployment mode', { DeploymentConfig: { Mode: 'TURBO', DisableRollback: false } }, /CHANGE_SET_SCHEMA_UNKNOWN/],
    ['a null where none is documented', { Status: null }, /CHANGE_SET_SCHEMA_UNKNOWN/],
  ]) {
    const run = cloud({ bodies: { [STACK_NAMES[0]]: describeBody(STACK_NAMES[0], over) } });
    const r = runIt(ABANDON_ARGV, { run, gate: gateFor(), evidenceIn: evidenceFor() });
    assert.equal(r.exit, 1, label);
    assert.match(r.output, expected, label);
    assert.equal(run.of('cloudformation delete-change-set').length, 0, label);
  }
  let page = 0;
  const run = cloud({
    onCall: (args) => {
      if (args[1] !== 'describe-change-set') return null;
      const stackName = args[args.indexOf('--stack-name') + 1];
      page += 1;
      if (page === 1) return { status: 0, stdout: JSON.stringify({ ...describeBody(stackName), NextToken: 'p2' }), stderr: '' };
      return { status: 0, stdout: JSON.stringify(describeBody(stackName, { OnStackFailure: 'DELETE' })), stderr: '' };
    },
  });
  const r = runIt(ABANDON_ARGV, { run, gate: gateFor(), evidenceIn: evidenceFor() });
  assert.equal(r.exit, 1);
  assert.match(r.output, /CHANGE_SET_PAGES_DIVERGE/);
  assert.equal(run.of('cloudformation delete-change-set').length, 0);
});

test('a deployment configuration outside the execution policy is REPORTED, and still deletable', () => {
  const outside = { DeploymentConfig: { Mode: 'EXPRESS', DisableRollback: true } };
  const bodies = { [STACK_NAMES[0]]: describeBody(STACK_NAMES[0], outside) };
  const digest = expectedPlanDigest(bodies);
  const run = cloud({ bodies });
  const evidence = evidenceFor({
    planDigest: digest,
    entries: STACK_NAMES.map((name) => ({
      stackId: STACKS[STACK_NAMES.indexOf(name)],
      stackName: name,
      status: 'CREATE_COMPLETE',
      executionStatus: 'AVAILABLE',
      entryDigest: entryDigestFor(name, bodies[name]),
      deploymentConfigWithinExecutionPolicy: name !== STACK_NAMES[0],
    })),
  });
  const r = runIt(ABANDON_ARGV, { run, gate: gateFor({ planDigest: digest }), evidenceIn: evidence });
  assert.equal(r.exit, 0, r.output);
  assert.deepEqual(r.deleted, STACK_NAMES);

  const inspectRun = cloud({ bodies });
  const out = {};
  const i = runIt(INSPECT_ARGV, { run: inspectRun, out });
  assert.equal(i.exit, 0);
  assert.match(i.output, /outside the execution policy/);
  assert.equal(JSON.parse(out.body).entries[0].deploymentConfigWithinExecutionPolicy, false);
});

// -------------------------------------------------------------------------------------------------
// Honest partial progress
// -------------------------------------------------------------------------------------------------

test('a dirty or unknown executor tree performs nothing', () => {
  for (const [label, git] of [
    ['dirty', cleanGit(EXECUTOR_SHA, ' M infra/aws/bin/recover-declined-plan.js\n')],
    ['unresolvable HEAD', () => ({ status: 128, stdout: '', stderr: 'not a repository' })],
  ]) {
    const run = cloud();
    const r = runIt(ABANDON_ARGV, { run, gate: gateFor(), evidenceIn: evidenceFor(), git });
    assert.equal(r.exit, 1, label);
    assert.match(r.output, /EXECUTOR_WORKTREE_DIRTY|EXECUTOR_UNRESOLVED/, label);
    assert.equal(run.calls.length, 0, `${label}: not one cloud call may happen`);
  }
});

test('an account that moves mid-operation stops it, and the record says exactly what was deleted', () => {
  let identityCalls = 0;
  const run = cloud({
    account: () => {
      identityCalls += 1;
      return identityCalls >= 3 ? '9'.repeat(12) : ACCOUNT;
    },
  });
  const out = {};
  const r = runIt(ABANDON_ARGV, { run, gate: gateFor(), evidenceIn: evidenceFor(), out });
  assert.equal(r.exit, 1);
  assert.match(r.output, /ACCOUNT_CHANGED/);
  assert.equal(run.of('cloudformation delete-change-set').length, 1, 'the first was deleted, the second was not');
  assert.deepEqual(r.deleted, [STACK_NAMES[0]]);
  assert.match(r.output, /Deleted before the halt: cba-study-coach-dev-identity/);
  const record = JSON.parse(out.body);
  assert.equal(record.outcome, 'REFUSED');
  assert.deepEqual(record.deleted, [STACK_NAMES[0]]);
});

test('a window that lapses mid-operation stops it before the next deletion', () => {
  let flipped = false;
  const run = cloud({
    onCall: (args) => {
      if (args[1] === 'delete-change-set') flipped = true;
      return null;
    },
  });
  const clock = () => (flipped ? Date.parse('2026-08-21T00:40:00Z') : NOW);
  const r = runIt(ABANDON_ARGV, { run, gate: gateFor(), evidenceIn: evidenceFor(), now: clock });
  assert.equal(r.exit, 1);
  assert.match(r.output, /CLOUD_GATE_EXPIRED/);
  assert.equal(run.of('cloudformation delete-change-set').length, 1);
  assert.match(r.output, /Deleted before the window lapsed: cba-study-coach-dev-identity/);
});

test('a failed delete never guesses: present and unknown are different records', () => {
  // PRESENT — every observation of the window is well-formed and standing: a plain failure.
  const present = cloud({ deleteStatus: 254, deleteStderr: 'ValidationError' });
  const p = runIt(ABANDON_ARGV, { run: present, gate: gateFor(), evidenceIn: evidenceFor() });
  assert.equal(p.exit, 1);
  assert.match(p.output, /ABANDON_DELETE_FAILED/);
  assert.deepEqual(p.deleted, []);

  // UNKNOWN — one tainted read taints the whole window; neither state is claimed.
  const murky = cloud({ deleteStatus: 254, deleteStderr: 'Throttling', afterDelete: () => ({ status: 254, stdout: '', stderr: 'Throttling: Rate exceeded' }) });
  const u = runIt(ABANDON_ARGV, { run: murky, gate: gateFor(), evidenceIn: evidenceFor() });
  assert.equal(u.exit, 1);
  assert.match(u.output, /ABANDON_STATE_UNKNOWN/);
  assert.match(u.output, /claimed neither deleted nor present/);
  assert.deepEqual(u.deleted, []);
});

test('r19 F6: only the exact stack-does-not-exist answer concludes absence', () => {
  // Any OTHER ValidationError is inconclusive and must report as unverifiable — never as gone.
  const murky = cloud({ stackRecordStderr: 'ValidationError: rate exceeded for DescribeStacks' });
  const a = runIt(ABANDON_ARGV, { run: murky, gate: gateFor(), evidenceIn: evidenceFor() });
  assert.equal(a.exit, 0, a.output);
  assert.match(a.output, /status unverifiable/);
  assert.equal(a.output.includes('No stack record remains'), false);

  const gone = cloud({ stackRecordStderr: `ValidationError: Stack with id ${STACK_NAMES[0]} does not exist` });
  const b = runIt(ABANDON_ARGV, { run: gone, gate: gateFor(), evidenceIn: evidenceFor() });
  assert.equal(b.exit, 0, b.output);
  assert.match(b.output, /No stack record remains to report/);
});

test('a record that cannot be written refuses the success it would otherwise claim — honestly', () => {
  const run = cloud();
  const files = new Map([['/gate/manifest.json', JSON.stringify(MANIFEST)], ['/gate/evidence.json', JSON.stringify(evidenceFor())]]);
  const r = runRecoverDeclinedPlan(ABANDON_ARGV, {
    run,
    git: cleanGit(),
    now: () => NOW,
    sleep: () => {},
    env: { CBA_CLOUD_GATE: gateFor() },
    lstatSync: (p) => { if (!files.has(p)) throw new Error('ENOENT'); return { isFile: () => true, size: files.get(p).length }; },
    readFileSync: (p) => { if (!files.has(p)) throw new Error('ENOENT'); return files.get(p); },
    writeFileSync: () => { throw new Error('EACCES'); },
  });
  assert.equal(r.exit, 1, 'a kept record is part of the contract');
  assert.match(r.output, /THE DELETIONS ABOVE HAPPENED/, 'what already happened is never unsaid');
  assert.deepEqual(r.deleted, STACK_NAMES);
});

// -------------------------------------------------------------------------------------------------
// Review r20 — the three findings, each with the reproduction Codex ran
// -------------------------------------------------------------------------------------------------

test('r20 F1: a manifest minted for account A dies in account B — coordinately, with zero effects', () => {
  // The EXACT reproduction: the manifest's contextDigest was computed for account A; the world —
  // identity, role, every ARN — answers coordinately as account B. Shape and bundle digest both
  // pass (the bytes travelled intact); only the recompute with the RESOLVED account catches it.
  const ACCOUNT_B = '9'.repeat(12);
  const bArn = (stackName) => `arn:aws:cloudformation:us-east-1:${ACCOUNT_B}:changeSet/${CHANGE_SET_NAME}/${uuidFor(stackName)}`;
  const bodies = Object.fromEntries(STACK_NAMES.map((n) => [n, describeBody(n, {
    ChangeSetId: bArn(n),
    StackId: `arn:aws:cloudformation:us-east-1:${ACCOUNT_B}:stack/${n}/aaaaaaaa-bbbb-cccc-dddd-${String(STACK_NAMES.indexOf(n) + 1).padStart(12, '0')}`,
  })]));
  for (const argv of [INSPECT_ARGV, ABANDON_ARGV]) {
    const run = cloud({ account: ACCOUNT_B, bodies });
    const r = runIt(argv, { run, gate: gateFor(), evidenceIn: evidenceFor() });
    assert.equal(r.exit, 1, argv[1]);
    assert.match(r.output, /MANIFEST_RECOMPUTE_MISMATCH/, argv[1]);
    assert.equal(run.of('sts assume-role').length, 0, `${argv[1]}: no role is assumed in the wrong account`);
    assert.equal(run.of('cloudformation describe-change-set').length, 0, `${argv[1]}: nothing is described`);
    assert.equal(run.of('cloudformation delete-change-set').length, 0, `${argv[1]}: nothing is deleted`);
  }
  // The control: the SAME world in account A passes — the recompute is a binding, not a wall.
  const ok = runIt(INSPECT_ARGV, { run: cloud() });
  assert.equal(ok.exit, 0, ok.output);
});

test('r20 F2: forged NESTED evidence refuses before a single cloud call', () => {
  const cases = [
    ['accountVerified false', evidenceFor({ accountVerified: false })],
    ['a forged entries string', evidenceFor({ entries: 'FORGED' })],
    ['a forged source string', evidenceFor({ source: 'FORGED' })],
    ['an invalid timestamp', evidenceFor({ observedAt: 'yesterday' })],
    ['a non-UTC timestamp', evidenceFor({ observedAt: '2026-08-20T23:45:00+02:00' })],
    ['an entry with an extra key', (() => { const e = evidenceFor(); e.entries[0].extra = 1; return e; })()],
    ['an entry out of order', (() => { const e = evidenceFor(); e.entries.reverse(); return e; })()],
    ['an entry digest edited', (() => { const e = evidenceFor(); e.entries[0].entryDigest = 'b'.repeat(64); return e; })()],
    ['a source missing its run', (() => { const e = evidenceFor(); delete e.source.runId; return e; })()],
    // r21: STRING-SHAPED is not STRING. A numeric runId satisfies the regex through String();
    // the closed schema demands the type itself, with no coercion anywhere.
    ['a numeric runId', (() => { const e = evidenceFor(); e.source.runId = 32371072834; return e; })()],
    ['a numeric decisionId', (() => { const e = evidenceFor(); e.source.decisionId = 12345678; return e; })()],
    ['a numeric correlationId', (() => { const e = evidenceFor(); e.source.correlationId = 12345678; return e; })()],
    ['all three numeric at once', (() => { const e = evidenceFor(); e.source = { runId: 32371072834, decisionId: 12345678, correlationId: 87654321 }; return e; })()],
  ];
  for (const [label, evidenceIn] of cases) {
    const run = cloud();
    const r = runIt(ABANDON_ARGV, { run, gate: gateFor(), evidenceIn });
    assert.equal(r.exit, 1, label);
    assert.match(r.output, /EVIDENCE_MALFORMED|EVIDENCE_MISMATCH/, label);
    assert.equal(run.calls.length, 0, `${label}: not one cloud call may happen`);
  }
});

test('r20 F3: a refusal after progress SAYS so — the header and the facts can no longer disagree', () => {
  // Account moves after the first deletion.
  let identityCalls = 0;
  const moving = cloud({ account: () => { identityCalls += 1; return identityCalls >= 3 ? '9'.repeat(12) : ACCOUNT; } });
  const a = runIt(ABANDON_ARGV, { run: moving, gate: gateFor(), evidenceIn: evidenceFor() });
  assert.equal(a.exit, 1);
  assert.match(a.output, /REFUSED AFTER PARTIAL PROGRESS — 1 change set\(s\) had already been deleted \(cba-study-coach-dev-identity\)/);
  assert.equal(a.output.includes('nothing was deleted'), false, 'the contradiction is gone');

  // The window lapses after the first deletion.
  let flipped = false;
  const lapsing = cloud({ onCall: (args) => { if (args[1] === 'delete-change-set') flipped = true; return null; } });
  const b = runIt(ABANDON_ARGV, { run: lapsing, gate: gateFor(), evidenceIn: evidenceFor(), now: () => (flipped ? Date.parse('2026-08-21T00:40:00Z') : NOW) });
  assert.equal(b.exit, 1);
  assert.match(b.output, /REFUSED AFTER PARTIAL PROGRESS — 1 change set\(s\)/);
  assert.equal(b.output.includes('nothing was deleted'), false);

  // The second delete fails with the set provably present.
  let deletions = 0;
  const failing = cloud({ onCall: (args) => {
    if (args[1] !== 'delete-change-set') return null;
    deletions += 1;
    return deletions === 2 ? { status: 254, stdout: '', stderr: 'ValidationError: cannot delete' } : null;
  } });
  const c = runIt(ABANDON_ARGV, { run: failing, gate: gateFor(), evidenceIn: evidenceFor() });
  assert.equal(c.exit, 1);
  assert.match(c.output, /REFUSED AFTER PARTIAL PROGRESS — 1 change set\(s\)/);
  assert.equal(c.output.includes('nothing was deleted'), false);

  // And a refusal with NO progress keeps the plain header — the words track the facts.
  const clean = cloud();
  const d = runIt(ABANDON_ARGV, { run: clean, gate: gateFor({ planDigest: 'b'.repeat(64) }), evidenceIn: evidenceFor({ planDigest: 'b'.repeat(64) }) });
  assert.equal(d.exit, 1);
  assert.match(d.output, /REFUSED — nothing was deleted:/);
});
