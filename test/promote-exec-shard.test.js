// promote-exec-shard.sh (#111 wave-2 postmortem, Codex item B): the operator instrument that
// moves ONE live shard policy to its reviewed document via CreatePolicyVersion --set-as-default.
// These tests run the REAL script against a fake `aws` on PATH that keeps mutable state on disk,
// so every step's observation, refusal and halt is exercised end to end — no AWS, no credentials.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(here, '..', 'scripts', 'promote-exec-shard.sh');
const TEMPLATE = path.join(here, '..', 'infra', 'aws', 'bootstrap', 'policies', 'cfn-exec-release-app.template.json');

const ACCOUNT = '1'.repeat(12);
const EXEC_ROLE = `cdk-cbardev-cfn-exec-role-${ACCOUNT}-us-east-1`;

/** The reviewed document exactly as the script renders it for dev. */
function renderedExpected() {
  return JSON.parse(
    fs.readFileSync(TEMPLATE, 'utf8')
      .replaceAll('ACCOUNT_ID_PLACEHOLDER', ACCOUNT)
      .replaceAll('ENVIRONMENT_PLACEHOLDER', 'dev')
      .replaceAll('QUALIFIER_PLACEHOLDER', 'cbardev'),
  );
}

/** A stale live document: the reviewed one MINUS the statement the promotion exists to add. */
function staleDocument() {
  const doc = renderedExpected();
  doc.Statement = doc.Statement.filter((s) => s.Sid !== 'ApiGatewayV2StageTaggingOnlyWithFoundationTags');
  return doc;
}

/** Build a fake `aws` whose IAM state lives in state.json and whose every call is logged. */
function fakeAws({ document = staleDocument(), versions = ['v1'], defaultVersion = 'v1', roles = [EXEC_ROLE], users = [], boundaryCount = 0, failCreate = false, failDelete = false, readbackDocument = null, rolesAfterCreate = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cba-fake-aws-iam-'));
  const state = {
    document, versions, defaultVersion, roles, users, boundaryCount,
    failCreate, failDelete, readbackDocument, rolesAfterCreate,
    created: null, deleted: [], calls: [],
  };
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(state));
  const driver = `#!/usr/bin/env python3
import json, sys
state_path = ${JSON.stringify(path.join(dir, 'state.json'))}
state = json.load(open(state_path))
args = sys.argv[1:]
state['calls'].append(args[:4])
def save(): json.dump(state, open(state_path, 'w'))
def out(obj): save(); print(json.dumps(obj)); sys.exit(0)
verb = ' '.join(args[:2])
if verb == 'sts get-caller-identity':
    out({'Account': '${ACCOUNT}'})
if verb == 'iam get-policy':
    out({'Policy': {'DefaultVersionId': state['defaultVersion']}})
if verb == 'iam list-policy-versions':
    out({'Versions': [{'VersionId': v, 'IsDefaultVersion': v == state['defaultVersion']} for v in state['versions']]})
if verb == 'iam get-policy-version':
    vid = args[args.index('--version-id') + 1]
    doc = state['document']
    if state['created'] and vid == state['created']:
        doc = state['readbackDocument'] if state['readbackDocument'] is not None else state['createdDocument']
    out({'PolicyVersion': {'VersionId': vid, 'IsDefaultVersion': vid == state['defaultVersion'], 'Document': doc}})
if verb == 'iam list-entities-for-policy':
    if '--policy-usage-filter' in args:
        n = state['boundaryCount']
        out({'PolicyRoles': [{'RoleName': f'b{i}'} for i in range(n)], 'PolicyUsers': [], 'PolicyGroups': []})
    roles = state['rolesAfterCreate'] if (state['created'] and state['rolesAfterCreate'] is not None) else state['roles']
    out({'PolicyRoles': [{'RoleName': r} for r in roles], 'PolicyUsers': [{'UserName': u} for u in state['users']], 'PolicyGroups': []})
if verb == 'iam create-policy-version':
    if state['failCreate']:
        save(); sys.exit(254)
    doc_arg = args[args.index('--policy-document') + 1]
    body = json.load(open(doc_arg[len('file://'):]))
    state['created'] = 'v2'
    state['createdDocument'] = body
    state['versions'].append('v2')
    if '--set-as-default' in args:
        state['defaultVersion'] = 'v2'
    out({'PolicyVersion': {'VersionId': 'v2', 'IsDefaultVersion': True}})
if verb == 'iam delete-policy-version':
    if state['failDelete']:
        save(); sys.exit(254)
    vid = args[args.index('--version-id') + 1]
    state['deleted'].append(vid)
    state['versions'] = [v for v in state['versions'] if v != vid]
    out({})
save(); print('fake aws: unsupported ' + verb, file=sys.stderr); sys.exit(64)
`;
  fs.writeFileSync(path.join(dir, 'aws'), `#!/usr/bin/env bash\nexec python3 ${JSON.stringify(path.join(dir, 'aws.py'))} "$@"\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(dir, 'aws.py'), driver);
  return {
    dir,
    state: () => JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8')),
  };
}

function run(fake, args = ['dev', 'app']) {
  return spawnSync('bash', [SCRIPT, ...args], {
    encoding: 'utf8',
    timeout: 60_000,
    env: { ...process.env, PATH: `${fake.dir}:${process.env.PATH}` },
  });
}

const mutations = (state) => state.calls.filter((c) => ['create-policy-version', 'delete-policy-version'].includes(c[1])).length;

test('happy path: create v2 as default, prove it, delete v1, single-version invariant restored', () => {
  const fake = fakeAws();
  const r = run(fake);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /PROMOTED: cba-study-coach-cfn-exec-release-dev-app v1 -> v2/);
  const s = fake.state();
  assert.deepEqual(s.createdDocument, renderedExpected(), 'the bytes sent are EXACTLY the reviewed rendering');
  assert.equal(s.defaultVersion, 'v2');
  assert.deepEqual(s.deleted, ['v1'], 'the old version is deleted only after the proof');
  assert.deepEqual(s.versions, ['v2'], 'exactly one version remains');
  // Order: the delete happens strictly AFTER the read-back and the consumer re-check.
  const verbs = s.calls.map((c) => c[1]);
  assert.ok(verbs.indexOf('delete-policy-version') > verbs.indexOf('create-policy-version'));
  assert.ok(verbs.indexOf('delete-policy-version') > verbs.lastIndexOf('get-policy-version'));
});

test('reentrant: a live document already at the reviewed bytes promotes NOTHING and says so', () => {
  const fake = fakeAws({ document: renderedExpected() });
  const r = run(fake);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /PROMOTION NOT NEEDED/);
  assert.equal(mutations(fake.state()), 0, 'zero mutating calls');
});

test('a broken single-version invariant REFUSES before any mutation', () => {
  const fake = fakeAws({ versions: ['v1', 'v3'] });
  const r = run(fake);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /expected exactly one existing version/);
  assert.equal(mutations(fake.state()), 0);
});

test('an unexpected consumer topology REFUSES before any mutation', () => {
  for (const [label, over, expected] of [
    ['an extra role', { roles: [EXEC_ROLE, 'some-other-role'] }, /attached to exactly/],
    ['a foreign role only', { roles: ['not-the-exec-role'] }, /attached to exactly/],
    ['a user attachment', { users: ['someone'] }, /users\/groups/],
    ['boundary usage', { boundaryCount: 1 }, /permissions boundary/],
  ]) {
    const fake = fakeAws(over);
    const r = run(fake);
    assert.equal(r.status, 1, label);
    assert.match(r.stdout, expected, label);
    assert.equal(mutations(fake.state()), 0, `${label}: zero mutating calls`);
  }
});

test('a read-back that differs from the reviewed bytes HALTS and deletes NOTHING', () => {
  const fake = fakeAws({ readbackDocument: { Version: '2012-10-17', Statement: [] } });
  const r = run(fake);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /read-back document DIFFERS/);
  const s = fake.state();
  assert.deepEqual(s.deleted, [], 'the old version survives a wrong read-back');
  assert.equal(s.defaultVersion, 'v2', 'the honest record: the wrong default IS live and the halt says to reconcile');
});

test('a consumer set that MOVES mid-promotion HALTS and deletes NOTHING', () => {
  const fake = fakeAws({ rolesAfterCreate: [EXEC_ROLE, 'attached-mid-flight'] });
  const r = run(fake);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /consumer set MOVED/);
  assert.deepEqual(fake.state().deleted, []);
});

test('a failed create HALTS with the old default explicitly untouched', () => {
  const fake = fakeAws({ failCreate: true });
  const r = run(fake);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /HALTED at CreatePolicyVersion/);
  assert.match(r.stdout, /old default v1 untouched/);
  assert.deepEqual(fake.state().deleted, []);
});

test('a failed cleanup HALTS while stating the promotion itself SUCCEEDED', () => {
  const fake = fakeAws({ failDelete: true });
  const r = run(fake);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /promotion itself SUCCEEDED/);
  const s = fake.state();
  assert.equal(s.defaultVersion, 'v2', 'the new default stands');
  assert.deepEqual(s.deleted, [], 'nothing was deleted; the leftover is named for later read-verified removal');
});

test('arguments are a closed vocabulary', () => {
  for (const args of [[], ['prod', 'app'], ['dev', 'everything'], ['dev']]) {
    const fake = fakeAws();
    const r = run(fake, args);
    assert.equal(r.status, 2, JSON.stringify(args));
    assert.equal(fake.state().calls.length, 0, 'not one aws call on bad arguments');
  }
});
