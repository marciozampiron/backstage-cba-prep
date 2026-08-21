'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  runRecoverDeclinedPlan,
  describeRecoveryFailure,
  RECOVERY_CODES,
  PHASE_COMMANDS,
  GATE_KEYS,
  GATE_MODE,
  rootOf,
} = require('../bin/recover-declined-plan');
const { entryDigestOf, canonicalChangeSet, setReviewedStackNames } = require('../bin/deploy-release');

/* =================================================================================================
 * The scenario is the real one, and it is the whole point of this instrument:
 *
 *   executorSha      = the code AFTER the r18 fix, which can read these describes;
 *   targetReleaseSha = the release BEFORE it, whose SHA names the change sets.
 *
 * The release lane cannot express that split — it runs the code of the release it addresses — so
 * every test here keeps the two SHAs distinct and proves that swapping them deletes nothing.
 * ============================================================================================= */
const ACCOUNT = '1'.repeat(12);
const EXECUTOR_SHA = 'cdce903ce06387c60ee0c432819ec67ab21b06cf';
const TARGET_SHA = 'e822c79630de19d43d1955011223f53b53b85cca';
const CHANGE_SET_NAME = `cba-70-${TARGET_SHA.slice(0, 12)}`;
const STACKS = ['IdentityStack', 'DataStack'];
const STACK_NAMES = ['cba-study-coach-dev-identity', 'cba-study-coach-dev-data'];
const NOW = Date.parse('2026-08-21T00:00:00Z');
const MANIFEST_DIGEST = 'a'.repeat(64);

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

/** The digest the instrument will compute for a given set of bodies — computed the same way. */
function expectedPlanDigest(bodies = {}) {
  setReviewedStackNames(STACK_NAMES);
  return rootOf(STACKS.map((stackId, i) => {
    const name = STACK_NAMES[i];
    return entryDigestOf(canonicalChangeSet(stackId, name, bodies[name] ?? describeBody(name)));
  }));
}

/** A cloud stub: records every command, answers identity, describe, delete and describe-stacks. */
function cloud({ bodies = {}, account = ACCOUNT, deleteStatus = 0, deleteStderr = '', onCall, afterDelete } = {}) {
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
    if (verb === 'cloudformation describe-change-set') {
      const stackName = args.includes('--stack-name') ? args[args.indexOf('--stack-name') + 1] : null;
      const named = args[args.indexOf('--change-set-name') + 1];
      if (named.startsWith('arn:') && deletedIds.has(named)) {
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

const gateFor = (over = {}) => ({
  account: ACCOUNT,
  approvedAt: '2026-08-20T23:50:00Z',
  decisionId: 'zamp-2026-08-21.111-recover-01',
  environment: 'dev',
  executorSha: EXECUTOR_SHA,
  expiresAt: '2026-08-21T00:30:00Z',
  issue: 70,
  manifestDigest: MANIFEST_DIGEST,
  mode: GATE_MODE,
  planDigest: expectedPlanDigest(),
  region: 'us-east-1',
  stacks: [...STACKS],
  targetReleaseSha: TARGET_SHA,
  ...over,
});

/** Run the instrument with an injected gate file and cloud. */
function runIt(argv, { run, gate, git = cleanGit(), now = () => NOW, evidence = {} } = {}) {
  const body = gate === undefined ? null : JSON.stringify(gate);
  return runRecoverDeclinedPlan(argv, {
    run,
    git,
    now,
    sleep: () => {},
    env: gate === undefined ? {} : { CBA_CLOUD_GATE: '/tmp/not-really-read.json' },
    lstatSync: () => ({ isFile: () => true, size: body ? body.length : 0 }),
    readFileSync: () => body,
    writeFileSync: (path, contents) => { evidence.path = path; evidence.body = contents; },
  });
}

const INSPECT_ARGV = [
  '--phase', 'inspect',
  '--environment', 'dev',
  '--region', 'us-east-1',
  '--target-release-sha', TARGET_SHA,
  '--account', ACCOUNT,
  '--manifest-digest', MANIFEST_DIGEST,
  '--source-run', '32371072834',
  '--source-decision', 'zamp-2026-08-20.111-plan-wave1',
  '--source-correlation', 'cba-70-1d5c8a54a0f4f8b548b41c76238c0d50',
  '--stacks', STACKS.join(','),
  '--evidence-out', '/tmp/evidence.json',
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
  // Every code the instrument can push must render; an unknown one throws rather than printing.
  for (const code of Object.keys(RECOVERY_CODES)) {
    assert.match(describeRecoveryFailure({ code, field: 'x' }), new RegExp(`\\[${code}\\]$`));
  }
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
// inspect — read-only, and it MINTS the digest
// -------------------------------------------------------------------------------------------------

test('inspect describes the group with the r18 reader, mints the digest and mutates nothing', () => {
  const run = cloud();
  const evidence = {};
  const r = runIt(INSPECT_ARGV, { run, evidence });
  assert.equal(r.exit, 0, r.output);
  assert.equal(run.of('cloudformation delete-change-set').length, 0, 'inspect deletes nothing');
  assert.equal(r.planDigest, expectedPlanDigest());

  const written = JSON.parse(evidence.body);
  assert.equal(evidence.path, '/tmp/evidence.json');
  // Requirement: the evidence is CLOSED and carries the audit chain.
  assert.deepEqual(Object.keys(written).sort(), [
    'accountVerified', 'changeSetName', 'entries', 'environment', 'executorSha', 'instrument',
    'manifestDigest', 'observedAt', 'phase', 'planDigest', 'region', 'source', 'stacks',
    'targetReleaseSha',
  ]);
  assert.deepEqual(written.source, {
    runId: '32371072834',
    decisionId: 'zamp-2026-08-20.111-plan-wave1',
    correlationId: 'cba-70-1d5c8a54a0f4f8b548b41c76238c0d50',
  });
  assert.equal(written.executorSha, EXECUTOR_SHA);
  assert.equal(written.targetReleaseSha, TARGET_SHA);
  assert.notEqual(written.executorSha, written.targetReleaseSha, 'executor and target are SEPARATE, and that is the point');
  assert.equal(written.changeSetName, CHANGE_SET_NAME);
  assert.equal(written.manifestDigest, MANIFEST_DIGEST);
  assert.deepEqual(written.stacks, STACKS);
  assert.equal(written.planDigest, expectedPlanDigest());
  assert.deepEqual(written.entries.map((e) => e.entryDigest).length, 2);
  assert.deepEqual(written.entries.map((e) => e.stackName), STACK_NAMES);
  // No ARN, no account id, no credential anywhere in the record.
  assert.equal(evidence.body.includes(ACCOUNT), false, 'the account id is never published');
  assert.equal(evidence.body.includes('arn:aws:'), false, 'no ARN is published');
});

test('inspect refuses a group that is not a reviewed plan group, in content and in order', () => {
  for (const group of ['DataStack,IdentityStack', 'IdentityStack', 'IdentityStack,DataStack,ApiStack', 'SecurityStack']) {
    const run = cloud();
    const argv = INSPECT_ARGV.map((a, i) => (INSPECT_ARGV[i - 1] === '--stacks' ? group : a));
    const r = runIt(argv, { run });
    assert.equal(r.exit, 1, group);
    assert.match(r.output, /GATE_STACKS_INVALID/, group);
    assert.equal(run.of('cloudformation delete-change-set').length, 0);
  }
});

// -------------------------------------------------------------------------------------------------
// abandon — the exact scenario, and every way it must refuse instead
// -------------------------------------------------------------------------------------------------

test('abandon deletes exactly the inspected sets, in order, by full ChangeSetId, and never a stack', () => {
  const run = cloud();
  const r = runIt(['--phase', 'abandon'], { run, gate: gateFor() });
  assert.equal(r.exit, 0, r.output);
  assert.deepEqual(r.deleted, STACK_NAMES, 'both, in the reviewed order');

  const deletions = run.of('cloudformation delete-change-set');
  assert.equal(deletions.length, 2);
  deletions.forEach((call, i) => {
    const named = call.args[call.args.indexOf('--change-set-name') + 1];
    assert.equal(named, csArn(STACK_NAMES[i]), 'deleted by the FULL observed id, never by name');
  });
  // The account is re-verified before EVERY deletion, not once at the start.
  assert.ok(run.of('sts get-caller-identity').length >= 3);
  assert.equal(run.calls.some((c) => `${c.args[0]} ${c.args[1]}` === 'cloudformation delete-stack'), false);
  // The empty records are REPORTED, never touched.
  assert.match(r.output, /REPORTED \(never deleted\)/);
  assert.match(r.output, /REVIEW_IN_PROGRESS/);
});

test('SWAPPING the executor and target SHAs deletes nothing — in either direction', () => {
  // The gate names the fixed code but a DIFFERENT tree is running it.
  const runA = cloud();
  const a = runIt(['--phase', 'abandon'], { run: runA, gate: gateFor(), git: cleanGit(TARGET_SHA) });
  assert.equal(a.exit, 1);
  assert.match(a.output, /EXECUTOR_MISMATCH/);
  assert.equal(runA.of('cloudformation delete-change-set').length, 0);
  assert.equal(runA.of('cloudformation describe-change-set').length, 0, 'it stops before reading anything');

  // The gate names the executor as the TARGET: the change-set name becomes the executor's, and
  // no such set exists — nothing is deleted, and the refusal names the absence.
  const runB = cloud();
  const b = runIt(['--phase', 'abandon'], { run: runB, gate: gateFor({ targetReleaseSha: EXECUTOR_SHA, planDigest: expectedPlanDigest() }) });
  assert.equal(b.exit, 1);
  assert.match(b.output, /CHANGE_SET_MISSING/);
  assert.equal(runB.of('cloudformation delete-change-set').length, 0);
});

test('a digest that is not this plan refuses as PLAN_CHANGED with zero deletions', () => {
  const run = cloud();
  const r = runIt(['--phase', 'abandon'], { run, gate: gateFor({ planDigest: 'b'.repeat(64) }) });
  assert.equal(r.exit, 1);
  assert.match(r.output, /PLAN_CHANGED/);
  assert.equal(run.of('cloudformation delete-change-set').length, 0);
  assert.deepEqual(r.deleted, []);
});

test('a RECREATED set changes its entry digest, so the root dies and nothing is deleted', () => {
  // Same name, same stack, new identity: exactly what a re-preparation would leave behind.
  const recreated = describeBody(STACK_NAMES[1], {
    ChangeSetId: `arn:aws:cloudformation:us-east-1:${ACCOUNT}:changeSet/${CHANGE_SET_NAME}/99999999-9999-9999-9999-999999999999`,
    CreationTime: '2026-08-21T09:00:00.000000+00:00',
  });
  const run = cloud({ bodies: { [STACK_NAMES[1]]: recreated } });
  const r = runIt(['--phase', 'abandon'], { run, gate: gateFor() });
  assert.equal(r.exit, 1);
  assert.match(r.output, /PLAN_CHANGED/);
  assert.equal(run.of('cloudformation delete-change-set').length, 0);
});

test('a schema-divergent description is never digested, and nothing is deleted', () => {
  for (const [label, over] of [
    ['an unreviewed field', { Sneaky: 'x' }],
    ['an undocumented deployment mode', { DeploymentConfig: { Mode: 'TURBO', DisableRollback: false } }],
    ['a null where none is documented', { Status: null }],
    ['a value outside the contract', { ExecutionStatus: 'MAYBE' }],
  ]) {
    const run = cloud({ bodies: { [STACK_NAMES[0]]: describeBody(STACK_NAMES[0], over) } });
    const r = runIt(['--phase', 'abandon'], { run, gate: gateFor() });
    assert.equal(r.exit, 1, label);
    assert.match(r.output, /CHANGE_SET_SCHEMA_UNKNOWN/, label);
    assert.equal(run.of('cloudformation delete-change-set').length, 0, label);
  }
});

test('a set whose pages disagree identifies nothing, and nothing is deleted', () => {
  let page = 0;
  const run = cloud({
    onCall: (args) => {
      if (`${args[0]} ${args[1]}` !== 'cloudformation describe-change-set') return null;
      const stackName = args[args.indexOf('--stack-name') + 1];
      page += 1;
      if (page === 1) return { status: 0, stdout: JSON.stringify({ ...describeBody(stackName), NextToken: 'p2' }), stderr: '' };
      return { status: 0, stdout: JSON.stringify(describeBody(stackName, { OnStackFailure: 'DELETE' })), stderr: '' };
    },
  });
  const r = runIt(['--phase', 'abandon'], { run, gate: gateFor() });
  assert.equal(r.exit, 1);
  assert.match(r.output, /CHANGE_SET_PAGES_DIVERGE/);
  assert.equal(run.of('cloudformation delete-change-set').length, 0);
});

test('a deployment configuration outside the execution policy is REPORTED, and still deletable', () => {
  // Review F2: refusing to delete what may not be executed would strand the set forever.
  const outside = { DeploymentConfig: { Mode: 'EXPRESS', DisableRollback: true } };
  const bodies = { [STACK_NAMES[0]]: describeBody(STACK_NAMES[0], outside) };
  const run = cloud({ bodies });
  const r = runIt(['--phase', 'abandon'], { run, gate: gateFor({ planDigest: expectedPlanDigest(bodies) }) });
  assert.equal(r.exit, 0, r.output);
  assert.deepEqual(r.deleted, STACK_NAMES);

  const inspectRun = cloud({ bodies });
  const evidence = {};
  const i = runIt(INSPECT_ARGV, { run: inspectRun, evidence });
  assert.equal(i.exit, 0);
  assert.match(i.output, /outside the execution policy/);
  assert.equal(JSON.parse(evidence.body).entries[0].deploymentConfigWithinExecutionPolicy, false);
});

// -------------------------------------------------------------------------------------------------
// The authorization itself
// -------------------------------------------------------------------------------------------------

test('the gate is a CLOSED schema, and a release-lane gate can never be replayed here', () => {
  const cases = [
    ['absent', undefined, /GATE_MISSING/],
    ['an extra key', { ...gateFor(), extra: 1 }, /GATE_MALFORMED/],
    ['a missing key', (() => { const g = gateFor(); delete g.executorSha; return g; })(), /GATE_MALFORMED/],
    ['the lane\'s abandon mode', gateFor({ mode: 'abandon' }), /GATE_MODE_MISMATCH/],
    ['a deploy mode', gateFor({ mode: 'deploy' }), /GATE_MODE_MISMATCH/],
    ['another issue', gateFor({ issue: 111 }), /GATE_MALFORMED/],
    ['a short digest', gateFor({ planDigest: 'abc' }), /GATE_MALFORMED/],
    ['a non-UTC instant', gateFor({ expiresAt: '2026-08-21T00:30:00+02:00' }), /GATE_MALFORMED/],
    ['a window over an hour', gateFor({ approvedAt: '2026-08-20T22:00:00Z', expiresAt: '2026-08-21T00:30:00Z' }), /GATE_TTL_EXCEEDED/],
    ['an expired window', gateFor({ approvedAt: '2026-08-20T22:30:00Z', expiresAt: '2026-08-20T23:00:00Z' }), /GATE_EXPIRED/],
    ['a future approval', gateFor({ approvedAt: '2026-08-21T00:30:00Z', expiresAt: '2026-08-21T01:00:00Z' }), /GATE_NOT_YET_VALID/],
    ['another account', gateFor({ account: '9'.repeat(12) }), /ACCOUNT_MISMATCH/],
  ];
  for (const [label, gate, expected] of cases) {
    const run = cloud();
    const r = runIt(['--phase', 'abandon'], { run, gate });
    assert.equal(r.exit, 1, label);
    assert.match(r.output, expected, label);
    assert.equal(run.of('cloudformation delete-change-set').length, 0, label);
  }
  assert.deepEqual([...GATE_KEYS].sort(), GATE_KEYS, 'the closed key set is compared sorted, so it must BE sorted');
});

test('a dirty or unknown executor tree performs nothing', () => {
  for (const [label, git] of [
    ['dirty', cleanGit(EXECUTOR_SHA, ' M infra/aws/bin/recover-declined-plan.js\n')],
    ['unresolvable HEAD', () => ({ status: 128, stdout: '', stderr: 'not a repository' })],
  ]) {
    const run = cloud();
    const r = runIt(['--phase', 'abandon'], { run, gate: gateFor(), git });
    assert.equal(r.exit, 1, label);
    assert.match(r.output, /EXECUTOR_WORKTREE_DIRTY|EXECUTOR_UNRESOLVED/, label);
    assert.equal(run.calls.length, 0, `${label}: not one cloud call may happen`);
  }
});

// -------------------------------------------------------------------------------------------------
// Honest partial progress
// -------------------------------------------------------------------------------------------------

test('an account that moves mid-operation stops it, and the record says exactly what was deleted', () => {
  let identityCalls = 0;
  const run = cloud({
    account: () => {
      identityCalls += 1;
      return identityCalls >= 3 ? '9'.repeat(12) : ACCOUNT;
    },
  });
  const r = runIt(['--phase', 'abandon'], { run, gate: gateFor() });
  assert.equal(r.exit, 1);
  assert.match(r.output, /ACCOUNT_CHANGED/);
  assert.equal(run.of('cloudformation delete-change-set').length, 1, 'the first was deleted, the second was not');
  assert.deepEqual(r.deleted, [STACK_NAMES[0]]);
  assert.match(r.output, /Deleted before the halt: cba-study-coach-dev-identity/);
});

test('a window that lapses mid-operation stops it before the next deletion', () => {
  let calls = 0;
  const clock = () => {
    calls += 1;
    return calls > 4 ? Date.parse('2026-08-21T00:40:00Z') : NOW;
  };
  const run = cloud();
  const r = runIt(['--phase', 'abandon'], { run, gate: gateFor(), now: clock });
  assert.equal(r.exit, 1);
  assert.match(r.output, /GATE_EXPIRED/);
  assert.ok(run.of('cloudformation delete-change-set').length <= 1);
  assert.match(r.output, /Deleted before the window lapsed/);
});

test('a failed delete never guesses: absent, present and unknown are three different records', () => {
  // ABSENT — the transport died but the set is provably gone: recorded as deleted, run stops.
  const gone = cloud({ deleteStatus: 254, deleteStderr: 'Read timeout on endpoint URL', afterDelete: () => ({ status: 254, stdout: '', stderr: 'ChangeSetNotFound' }) });
  const a = runIt(['--phase', 'abandon'], { run: gone, gate: gateFor() });
  assert.equal(a.exit, 1);
  assert.match(a.output, /PROVABLY ABSENT/);
  assert.deepEqual(a.deleted, [STACK_NAMES[0]]);
  assert.equal(gone.of('cloudformation delete-change-set').length, 1, 'a surprised operation does not continue');

  // PRESENT — every observation of the window is well-formed and standing: a plain failure.
  const present = cloud({ deleteStatus: 254, deleteStderr: 'ValidationError' });
  const p = runIt(['--phase', 'abandon'], { run: present, gate: gateFor() });
  assert.equal(p.exit, 1);
  assert.match(p.output, /DELETE_FAILED/);
  assert.deepEqual(p.deleted, []);

  // UNKNOWN — one tainted read taints the whole window; neither state is claimed.
  const murky = cloud({ deleteStatus: 254, deleteStderr: 'Throttling', afterDelete: () => ({ status: 254, stdout: '', stderr: 'Throttling: Rate exceeded' }) });
  const u = runIt(['--phase', 'abandon'], { run: murky, gate: gateFor() });
  assert.equal(u.exit, 1);
  assert.match(u.output, /DELETE_STATE_UNKNOWN/);
  assert.match(u.output, /claimed neither deleted nor present/);
  assert.deepEqual(u.deleted, []);
});

test('a describe that fails for an unrelated reason is not read as an absence', () => {
  const run = cloud({
    onCall: (args) => (`${args[0]} ${args[1]}` === 'cloudformation describe-change-set'
      ? { status: 254, stdout: '', stderr: 'AccessDenied: not authorized' }
      : null),
  });
  const r = runIt(['--phase', 'abandon'], { run, gate: gateFor() });
  assert.equal(r.exit, 1);
  assert.match(r.output, /CHANGE_SET_UNREADABLE/);
  assert.equal(run.of('cloudformation delete-change-set').length, 0);
});
