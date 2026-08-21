// promote-exec-shard (#111 wave-2 postmortem, r2): the shard promotion now runs ONLY through the
// operator launcher — materialized tree, bound SHA, bound account, one-attempt CLI, predecessor
// precondition, full-topology proofs. These tests drive the REAL launcher end to end: a fake
// `git` serves the "commit" from a staged source root (so the archive, the manifest and the
// write-strip all actually happen), and a fake `aws` keeps mutable IAM state and records the
// environment of every call. No AWS, no credentials, no worktree copies executed.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

// r3-L4: the suite owns its residue. Every mkdtemp lands here; `after` removes them all, and the
// final test proves absence of what THIS run created (297 leftovers were found in /tmp).
const CREATED_DIRS = [];
function tmpdir(prefix) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  CREATED_DIRS.push(d);
  return d;
}
after(() => {
  for (const d of CREATED_DIRS) {
    try { execFileSync('chmod', ['-R', 'u+w', d]); } catch { /* may already be writable */ }
    fs.rmSync(d, { recursive: true, force: true });
  }
});
const ROOT = path.join(here, '..');
const SHA = 'ab'.repeat(20);
const ACCOUNT = '1'.repeat(12);
const EXEC_ROLE = `cdk-cbardev-cfn-exec-role-${ACCOUNT}-us-east-1`;

/** Canonical-JSON digest EXACTLY as the instrument computes it (sort_keys, compact separators). */
function canonicalSha(doc) {
  const canon = (v) => {
    if (Array.isArray(v)) return `[${v.map(canon).join(',')}]`;
    if (v && typeof v === 'object') {
      return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(',')}}`;
    }
    return JSON.stringify(v);
  };
  return crypto.createHash('sha256').update(canon(doc)).digest('hex');
}

function renderedExpected() {
  return JSON.parse(
    fs.readFileSync(path.join(ROOT, 'infra', 'aws', 'bootstrap', 'policies', 'cfn-exec-release-app.template.json'), 'utf8')
      .replaceAll('ACCOUNT_ID_PLACEHOLDER', ACCOUNT)
      .replaceAll('ENVIRONMENT_PLACEHOLDER', 'dev')
      .replaceAll('QUALIFIER_PLACEHOLDER', 'cbardev'),
  );
}
function staleDocument() {
  const doc = renderedExpected();
  doc.Statement = doc.Statement.filter((s) => s.Sid !== 'ApiGatewayV2StageTaggingOnlyWithFoundationTags');
  return doc;
}
const STALE_SHA = () => canonicalSha(staleDocument());

/** Stage a fake "repository": the REAL scripts and bootstrap inputs, served by a fake git. */
function harness(state = {}) {
  const dir = tmpdir('cba-promote-h-');
  const src = path.join(dir, 'repo');
  fs.mkdirSync(src);
  fs.writeFileSync(path.join(src, '.git'), 'gitdir: fake');
  fs.cpSync(path.join(ROOT, 'scripts'), path.join(src, 'scripts'), { recursive: true });
  fs.cpSync(path.join(ROOT, 'infra', 'aws', 'bootstrap'), path.join(src, 'infra', 'aws', 'bootstrap'), { recursive: true });

  // Fake git: serves HEAD, cleanliness, the launcher bytes and the archive FROM the staged root.
  fs.writeFileSync(path.join(dir, 'git'), `#!/usr/bin/env bash
set -euo pipefail
shift 2 # -C <root>
case "$1" in
  cat-file) exit 0 ;;
  rev-parse) echo "${SHA}" ;;
  status) : ;;
  show) cat ${JSON.stringify(src)}/scripts/provision.sh ;;
  archive) tar -cf - -C ${JSON.stringify(src)} scripts infra/aws/bootstrap ;;
  *) echo "fake git: $1" >&2; exit 64 ;;
esac
`, { mode: 0o755 });

  // Fake aws: mutable IAM state + a per-call record of argv AND the retry environment.
  const statePath = path.join(dir, 'state.json');
  fs.writeFileSync(statePath, JSON.stringify({
    document: staleDocument(), versions: ['v1'], defaultVersion: 'v1',
    roles: [EXEC_ROLE], users: [], boundaryCount: 0,
    account: ACCOUNT,
    boundaryAfterCreate: null, rolesAfterCreate: null, accountAfterCreate: null,
    boundaryFromCheck: null, documentAfterReads: null, malformedCreateResponse: false,
    failCreate: false, lostResponseOnCreate: false, failDelete: false, deleteWrongSurvivor: false,
    readbackDocument: null,
    created: null, createdDocument: null, deleted: [], calls: [],
    ...state,
  }));
  fs.writeFileSync(path.join(dir, 'aws'), `#!/usr/bin/env bash
exec python3 ${JSON.stringify(path.join(dir, 'aws.py'))} "$@"
`, { mode: 0o755 });
  fs.writeFileSync(path.join(dir, 'aws.py'), `
import json, os, sys
state_path = ${JSON.stringify(statePath)}
state = json.load(open(state_path))
# Strip the GLOBAL flags (they precede the service in the real invocation) so the verb anchors
# on service+operation; the operation-level flags (--version-id, --policy-document, ...) stay.
FLAGS_WITH_VALUE = {'--cli-connect-timeout', '--cli-read-timeout', '--output', '--query'}
args = []
skip = False
for a in sys.argv[1:]:
    if skip: skip = False; continue
    if a in FLAGS_WITH_VALUE: skip = True; continue
    if a == '--no-cli-pager': continue
    args.append(a)
state['calls'].append({'argv': args[:6], 'maxAttempts': os.environ.get('AWS_MAX_ATTEMPTS'), 'retryMode': os.environ.get('AWS_RETRY_MODE')})
def save(): json.dump(state, open(state_path, 'w'))
def out(obj): save(); print(json.dumps(obj)); sys.exit(0)
def arg(flag):
    return args[args.index(flag) + 1]
verb = ' '.join(args[:2])
created_active = state['created'] is not None
if verb == 'sts get-caller-identity':
    acct = state['accountAfterCreate'] if (created_active and state['accountAfterCreate'] is not None) else state['account']
    save(); print(acct); sys.exit(0)
if verb == 'iam get-policy':
    out({'Policy': {'DefaultVersionId': state['defaultVersion']}})
if verb == 'iam list-policy-versions':
    out({'Versions': [{'VersionId': v, 'IsDefaultVersion': v == state['defaultVersion']} for v in state['versions']]})
if verb == 'iam get-policy-version':
    vid = arg('--version-id')
    state['getVersionReads'] = state.get('getVersionReads', 0) + 1
    doc = state['document']
    if state['documentAfterReads'] is not None and state['getVersionReads'] > state['documentAfterReads']['after']:
        doc = state['documentAfterReads']['document']
    if created_active and vid == state['created']:
        doc = state['readbackDocument'] if state['readbackDocument'] is not None else state['createdDocument']
    out({'PolicyVersion': {'VersionId': vid, 'IsDefaultVersion': vid == state['defaultVersion'], 'Document': doc}})
if verb == 'iam list-entities-for-policy':
    if '--policy-usage-filter' in args:
        state['boundaryChecks'] = state.get('boundaryChecks', 0) + 1
        n = state['boundaryAfterCreate'] if (created_active and state['boundaryAfterCreate'] is not None) else state['boundaryCount']
        if state['boundaryFromCheck'] is not None and state['boundaryChecks'] >= state['boundaryFromCheck']:
            n = 1
        out({'PolicyRoles': [{'RoleName': 'b%d' % i} for i in range(n)], 'PolicyUsers': [], 'PolicyGroups': []})
    roles = state['rolesAfterCreate'] if (created_active and state['rolesAfterCreate'] is not None) else state['roles']
    out({'PolicyRoles': [{'RoleName': r} for r in roles], 'PolicyUsers': [{'UserName': u} for u in state['users']], 'PolicyGroups': []})
if verb == 'iam create-policy-version':
    if state['failCreate']:
        save(); sys.exit(254)
    doc_arg = arg('--policy-document')
    body = json.load(open(doc_arg[len('file://'):]))
    state['created'] = 'v2'
    state['createdDocument'] = body
    state['versions'].append('v2')
    if '--set-as-default' in args:
        state['defaultVersion'] = 'v2'
    if state['lostResponseOnCreate']:
        # The mutation HAPPENED; the response never arrived. One attempt means one version.
        save(); sys.exit(255)
    if state['malformedCreateResponse']:
        out({})
    out({'PolicyVersion': {'VersionId': 'v2', 'IsDefaultVersion': True}})
if verb == 'iam delete-policy-version':
    if state['failDelete']:
        save(); sys.exit(254)
    vid = arg('--version-id')
    state['deleted'].append(vid)
    victim = state['created'] if state['deleteWrongSurvivor'] else vid
    state['versions'] = [v for v in state['versions'] if v != victim]
    if state['deleteWrongSurvivor']:
        state['defaultVersion'] = 'v1'
    out({})
save(); print('fake aws: unsupported ' + verb, file=sys.stderr); sys.exit(64)
`);
  return { dir, src, state: () => JSON.parse(fs.readFileSync(statePath, 'utf8')) };
}

/** Run exactly as the runbook does: extract the launcher from the "commit" and bash -p it. */
function runLauncher(h, { phase = 'promote-app', env = {}, extraEnv = {} } = {}) {
  const launcher = path.join(h.dir, 'launcher.sh');
  const shown = execFileSync(path.join(h.dir, 'git'), ['-C', h.src, 'show', `${SHA}:scripts/provision.sh`], { encoding: 'utf8' });
  fs.writeFileSync(launcher, shown);
  let out = ''; let code = 0;
  try {
    out = execFileSync('bash', ['-p', launcher, 'dev', phase], {
      encoding: 'utf8',
      timeout: 120_000,
      env: {
        PATH: `${h.dir}:${process.env.PATH}`,
        CBA_REPO_ROOT: h.src,
        CBA_AUTHORIZED_SHA: SHA,
        CBA_EXPECTED_ACCOUNT_ID: ACCOUNT,
        CBA_EXPECTED_OLD_DOC_SHA256: STALE_SHA(),
        ...env,
        ...extraEnv,
      },
    });
  } catch (e) { out = `${e.stdout ?? ''}${e.stderr ?? ''}`; code = e.status ?? 1; }
  return { out, code };
}

const mutating = (s) => s.calls.filter((c) => ['create-policy-version', 'delete-policy-version'].includes(c.argv[1]));

test('happy path through the REAL launcher: materialize, bind, prove, promote, restore', () => {
  const h = harness();
  const r = runLauncher(h);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /arvore materializada do commit|launcher:/);
  assert.match(r.out, /PROMOTED: cba-study-coach-cfn-exec-release-dev-app v1 -> v2/);
  const s = h.state();
  assert.deepEqual(s.createdDocument, renderedExpected(), 'the bytes promoted are the MANIFEST-BOUND rendering');
  assert.deepEqual(s.deleted, ['v1']);
  assert.deepEqual(s.versions, ['v2']);
  // r2-F3: every AWS call runs with retries pinned to ONE attempt.
  for (const call of s.calls) {
    assert.equal(call.maxAttempts, '1', `${call.argv.join(' ')} must run with AWS_MAX_ATTEMPTS=1`);
    assert.equal(call.retryMode, 'standard');
  }
  // r2-F4: the delete comes only after the post-create topology and read-back proofs.
  const verbs = s.calls.map((c) => c.argv.slice(0, 3).join(' '));
  const deleteAt = verbs.findIndex((v) => v.includes('delete-policy-version'));
  const boundaryChecks = verbs.filter((v) => v.includes('list-entities-for-policy')).length;
  assert.ok(boundaryChecks >= 6, 'attachments AND boundary are observed at observe/create/final');
  assert.ok(deleteAt > verbs.findIndex((v) => v.includes('create-policy-version')));
});

test('r2-F1: the worktree copy REFUSES to run directly — only the materialized tree may promote', () => {
  const h = harness();
  let out = ''; let code = 0;
  try {
    out = execFileSync('bash', [path.join(ROOT, 'scripts', 'promote-exec-shard.sh'), 'dev', 'app'], {
      encoding: 'utf8',
      env: { PATH: `${h.dir}:${process.env.PATH}`, CBA_EXPECTED_ACCOUNT_ID: ACCOUNT, CBA_EXPECTED_OLD_DOC_SHA256: STALE_SHA() },
    });
  } catch (e) { out = `${e.stdout ?? ''}${e.stderr ?? ''}`; code = e.status ?? 1; }
  assert.equal(code, 1);
  assert.match(out, /only executes from the tree materialized/);
  assert.equal(h.state().calls.length, 0, 'not one aws call');
});

test('r3-H1: the WORKTREE copy is refused even when handed a VALID materialized tree', () => {
  // Codex's reproduction: unreviewed worktree bytes riding on reviewed templates. The child must
  // prove the RUNNING COPY lives at MAT_ROOT, not merely that some valid tree exists.
  const h = harness();
  // Build a genuine materialized tree exactly as the launcher would.
  const mat = tmpdir('cba-valid-mat-');
  execFileSync('bash', ['-c', `tar -cf - -C ${JSON.stringify(h.src)} scripts infra/aws/bootstrap | tar -x -C ${JSON.stringify(mat)}`]);
  const digests = execFileSync('bash', ['-c', `cd ${JSON.stringify(mat)} && find . -type f -print0 | LC_ALL=C sort -z | xargs -0 sha256sum`], { encoding: 'utf8' });
  fs.writeFileSync(path.join(mat, '.cba-manifest'), `SHA ${SHA}\n${digests}`);
  execFileSync('chmod', ['-R', 'a-w', mat]);
  let out = ''; let code = 0;
  try {
    out = execFileSync('bash', ['-p', path.join(ROOT, 'scripts', 'promote-exec-shard.sh'), 'dev', 'app'], {
      encoding: 'utf8',
      env: {
        PATH: `${h.dir}:${process.env.PATH}`,
        CBA_MATERIALIZED_ROOT: mat,
        CBA_AUTHORIZED_SHA: SHA,
        CBA_EXPECTED_ACCOUNT_ID: ACCOUNT,
        CBA_EXPECTED_OLD_DOC_SHA256: STALE_SHA(),
      },
    });
  } catch (e) { out = `${e.stdout ?? ''}${e.stderr ?? ''}`; code = e.status ?? 1; }
  assert.equal(code, 1);
  assert.match(out, /this copy is not the materialized one/);
  assert.equal(h.state().calls.length, 0, 'the bypass never reaches a single aws call');
});

test('r2-F1: a WRONG account refuses with zero IAM mutation, and a hostile PYTHONPATH changes nothing', () => {
  const wrong = harness({ account: '9'.repeat(12) });
  const r = runLauncher(wrong);
  assert.equal(r.code, 1);
  assert.match(r.out, /do not belong to the authorized account/);
  assert.equal(mutating(wrong.state()).length, 0);

  // Hostile PYTHONPATH/PYTHONSTARTUP: python runs -I everywhere, so the promotion still succeeds
  // and still promotes exactly the reviewed bytes.
  const hostileDir = tmpdir('cba-hostile-');
  fs.writeFileSync(path.join(hostileDir, 'json.py'), 'raise SystemExit("hostile json module imported")');
  const h = harness();
  const r2 = runLauncher(h, { extraEnv: { PYTHONPATH: hostileDir, PYTHONSTARTUP: path.join(hostileDir, 'json.py') } });
  assert.equal(r2.code, 0, r2.out);
  assert.deepEqual(h.state().createdDocument, renderedExpected());
});

test('r2-F1: a template edited AFTER the authorization cannot ride in — the archive serves the commit', () => {
  const h = harness();
  // "Worktree tampering": the staged repo's WORKTREE file changes, but the fake git archive
  // serves the staged tree as the commit — so to simulate a tamper that the manifest must catch,
  // corrupt the archive output side instead: stage a different template, then hand the launcher
  // a manifest-breaking tree by editing a file INSIDE the materialized tree is impossible (it is
  // write-stripped and private). What IS reachable — and what the guard closes — is a stale or
  // hand-made CBA_MATERIALIZED_ROOT handed straight to the child:
  const fakeTree = tmpdir('cba-forged-');
  fs.cpSync(path.join(h.src, 'scripts'), path.join(fakeTree, 'scripts'), { recursive: true });
  fs.cpSync(path.join(h.src, 'infra'), path.join(fakeTree, 'infra'), { recursive: true });
  // Tamper the template, build a manifest that LIES about the SHA but hashes correctly.
  const tpl = path.join(fakeTree, 'infra', 'aws', 'bootstrap', 'policies', 'cfn-exec-release-app.template.json');
  const doc = JSON.parse(fs.readFileSync(tpl, 'utf8'));
  doc.Statement.push({ Sid: 'Smuggled', Effect: 'Allow', Action: '*', Resource: '*' });
  fs.writeFileSync(tpl, JSON.stringify(doc, null, 2));
  const digests = execFileSync('bash', ['-c', `cd ${JSON.stringify(fakeTree)} && find . -type f -print0 | LC_ALL=C sort -z | xargs -0 sha256sum`], { encoding: 'utf8' });
  fs.writeFileSync(path.join(fakeTree, '.cba-manifest'), `SHA ${'c'.repeat(40)}\n${digests}`);
  execFileSync('chmod', ['-R', 'a-w', fakeTree]);
  let out = ''; let code = 0;
  try {
    out = execFileSync('bash', ['-p', path.join(fakeTree, 'scripts', 'promote-exec-shard.sh'), 'dev', 'app'], {
      encoding: 'utf8',
      env: {
        PATH: `${h.dir}:${process.env.PATH}`,
        CBA_MATERIALIZED_ROOT: fakeTree,
        CBA_AUTHORIZED_SHA: SHA, // the AUTHORIZED sha — which the forged manifest does not name
        CBA_EXPECTED_ACCOUNT_ID: ACCOUNT,
        CBA_EXPECTED_OLD_DOC_SHA256: STALE_SHA(),
      },
    });
  } catch (e) { out = `${e.stdout ?? ''}${e.stderr ?? ''}`; code = e.status ?? 1; }
  execFileSync('chmod', ['-R', 'u+w', fakeTree]);
  assert.equal(code, 1);
  assert.match(out, /manifest does not name the authorized SHA/);
  assert.equal(mutating(h.state()).length, 0);
});

test('r2-F2: the predecessor is a PRECONDITION — an unexpected live document refuses before any create', () => {
  // The live default is neither the target nor the named predecessor.
  const surprise = staleDocument();
  surprise.Statement = surprise.Statement.slice(0, 3);
  const h = harness({ document: surprise });
  const r = runLauncher(h);
  assert.equal(r.code, 1);
  assert.match(r.out, /not the predecessor the decision names/);
  assert.equal(mutating(h.state()).length, 0);

  // And the digest is REQUIRED: absent means refuse, not assume.
  const h2 = harness();
  const r2 = runLauncher(h2, { env: { CBA_EXPECTED_OLD_DOC_SHA256: '' } });
  assert.equal(r2.code, 1);
  assert.match(r2.out, /CBA_EXPECTED_OLD_DOC_SHA256 is required/);
  assert.equal(mutating(h2.state()).length, 0);
});

test('reentrant: live already at the reviewed bytes — no predecessor needed, zero mutation', () => {
  const h = harness({ document: renderedExpected() });
  const r = runLauncher(h, { env: { CBA_EXPECTED_OLD_DOC_SHA256: '' } });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /PROMOTION NOT NEEDED/);
  assert.equal(mutating(h.state()).length, 0);
});

test('r2-F3: a LOST RESPONSE after acceptance halts with ONE version created and zero retries', () => {
  const h = harness({ lostResponseOnCreate: true });
  const r = runLauncher(h);
  assert.equal(r.code, 1);
  assert.match(r.out, /the ONE attempt failed or its response was lost \(no retry was made\)/);
  const s = h.state();
  const creates = s.calls.filter((c) => c.argv[1] === 'create-policy-version');
  assert.equal(creates.length, 1, 'exactly ONE create attempt — a retry would be a second unauthorized mutation');
  assert.deepEqual(s.versions, ['v1', 'v2'], 'the honest ambiguous state: the version exists, the response was lost');
  assert.deepEqual(s.deleted, [], 'nothing is deleted from an ambiguous state');
});

test('r2-F1/F4: an account that MOVES between the create and the delete halts before the deletion', () => {
  // The re-check immediately before EACH mutation is not decoration: credentials that rotate or
  // re-aim mid-operation must stop the second mutation even though the first was authorized.
  const h = harness({ accountAfterCreate: '9'.repeat(12) });
  const r = runLauncher(h);
  assert.equal(r.code, 1);
  assert.match(r.out, /do not belong to the authorized account/);
  assert.deepEqual(h.state().deleted, [], 'the delete never ran under the moved identity');
  assert.equal(h.state().created, 'v2', 'the honest record: the create HAD happened');
});

test('r2-F4: a boundary usage appearing AFTER the create halts before any deletion', () => {
  const h = harness({ boundaryAfterCreate: 1 });
  const r = runLauncher(h);
  assert.equal(r.code, 1);
  assert.match(r.out, /permissions boundary/);
  assert.deepEqual(h.state().deleted, [], 'the old version survives a moved topology');
});

test('r3-M2: a predecessor that MOVES between the proof and the create refuses with zero mutation', () => {
  // First read (observe) serves the named predecessor; the re-read at the last boundary before
  // the create serves something else — the create must never run.
  const moved = staleDocument();
  moved.Statement = moved.Statement.slice(0, 2);
  const h = harness({ documentAfterReads: { after: 1, document: moved } });
  const r = runLauncher(h);
  assert.equal(r.code, 1);
  assert.match(r.out, /live document MOVED after the first proof/);
  assert.equal(mutating(h.state()).length, 0);
});

test('r3-M2: a boundary appearing between the post-create proof and the delete halts the delete', () => {
  // Boundary checks: observe(1), pre-create(2), post-create(3) all clean; the pre-delete
  // re-check(4) sees the boundary — the old version must survive.
  const h = harness({ boundaryFromCheck: 4 });
  const r = runLauncher(h);
  assert.equal(r.code, 1);
  assert.match(r.out, /permissions boundary/);
  assert.deepEqual(h.state().deleted, [], 'the late boundary stopped the delete');
  assert.equal(h.state().created, 'v2', 'the honest record: the promotion had landed');
});

test('r3-M3: a MALFORMED success response halts with the ambiguous state named — no traceback, no delete', () => {
  const h = harness({ malformedCreateResponse: true });
  const r = runLauncher(h);
  assert.equal(r.code, 1);
  assert.match(r.out, /response is MALFORMED — the mutation may have landed/);
  assert.equal(r.out.includes('Traceback'), false, 'the failure is a named halt, never a stack trace');
  const s = h.state();
  assert.deepEqual(s.deleted, []);
  assert.equal(s.calls.filter((c) => c.argv[1] === 'create-policy-version').length, 1, 'no retry');
});

test('r3-L4: the suite leaves NO residue — everything this run created is tracked for removal', () => {
  // Every directory the suite made is on the tracked list (the `after` hook removes them; this
  // proves nothing escaped the tracking to become one of the 297 orphans the review found).
  assert.ok(CREATED_DIRS.length >= 10, 'the tracker saw the harnesses');
  for (const d of CREATED_DIRS) {
    assert.ok(d.startsWith(os.tmpdir()), d);
    assert.ok(/cba-(promote-h|hostile|forged|valid-mat)-/.test(d), `untracked prefix: ${d}`);
  }
});

test('r2-F4: a wrong SURVIVOR after the delete halts with the survivor named', () => {
  const h = harness({ deleteWrongSurvivor: true });
  const r = runLauncher(h);
  assert.equal(r.code, 1);
  assert.match(r.out, /surviving version is not the proven new default/);
});

test('a read-back that differs from the reviewed bytes halts and deletes nothing', () => {
  const h = harness({ readbackDocument: { Version: '2012-10-17', Statement: [] } });
  const r = runLauncher(h);
  assert.equal(r.code, 1);
  assert.match(r.out, /does not prove the reviewed default/);
  assert.deepEqual(h.state().deleted, []);
});

test('consumer topology refusals: extra role, user attachment, pre-existing boundary — zero mutation', () => {
  for (const [label, over, expected] of [
    ['an extra role', { roles: [EXEC_ROLE, 'other'] }, /attached as a role policy to exactly/],
    ['a user attachment', { users: ['someone'] }, /attached as a role policy to exactly/],
    ['boundary usage', { boundaryCount: 2 }, /permissions boundary/],
    ['a broken version invariant', { versions: ['v1', 'v9'] }, /exactly one existing version/],
  ]) {
    const h = harness(over);
    const r = runLauncher(h);
    assert.equal(r.code, 1, label);
    assert.match(r.out, expected, label);
    assert.equal(mutating(h.state()).length, 0, `${label}: zero mutating calls`);
  }
});

test('r2-F6: the child interface is CLOSED — a third argument refuses with zero calls', () => {
  const h = harness();
  let code = 0; let out = '';
  try {
    out = execFileSync('bash', [path.join(ROOT, 'scripts', 'promote-exec-shard.sh'), 'dev', 'app', 'extra'], { encoding: 'utf8', env: { PATH: `${h.dir}:${process.env.PATH}` } });
  } catch (e) { out = `${e.stdout ?? ''}${e.stderr ?? ''}`; code = e.status ?? 1; }
  assert.equal(code, 2);
  assert.match(out, /exactly two arguments/);
  assert.equal(h.state().calls.length, 0);
  // And the launcher's own dispatch only knows the three promote phases.
  const bad = runLauncher(h, { phase: 'promote-everything' });
  assert.notEqual(bad.code, 0);
  assert.equal(mutating(h.state()).length, 0);
});
