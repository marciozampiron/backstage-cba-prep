// EXECUTED proofs for scripts/provision-release-bootstrap.sh (#111, round 2): the REVIEWED
// template snapshot is the authority. Fixtures are GENERATED from that snapshot through the
// script's own resolver (spot-pinned below against hand-written facts of the real template, so
// the resolver cannot drift unseen), the fake aws serves the IAM-normalized live state CFN would
// materialize, and every adversarial case mutates that state away from the template. The full
// matrix runs for BOTH tiers. Every refusal must leave ZERO mutation; no output may carry an
// account id.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(ROOT, 'scripts/provision-release-bootstrap.sh');
const RESOLVER = path.join(ROOT, 'scripts/lib/bootstrap-expected-state.py');
const SNAPSHOT = path.join(ROOT, 'infra/aws/bootstrap/cdk-bootstrap-template.yaml');
const ACCOUNT = '111122223333';
const SHA = 'f'.repeat(40);
const REGION = 'us-east-1';
const KEY_ID = '11111111-2222-3333-4444-555555555555';
const CDK_VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'infra/aws/package-lock.json'), 'utf8'))
  .packages['node_modules/aws-cdk'].version;
const SNAPSHOT_TEXT = fs.readFileSync(SNAPSHOT, 'utf8');

// The reviewed snapshot's identity: any change to the committed template must come through THIS
// pin, which makes the change a review surface instead of a silent re-generation (r2-F1).
// r3-F4: stored with a single trailing newline so `git diff --check` stays clean.
const SNAPSHOT_SHA256 = '862af2dedb13198902e2d084587d19992edfff38224f19103ffa67de2a070447';

const ENVS = {
  dev: { qualifier: 'cbardev' },
  pilot: { qualifier: 'cbarpil' },
};
for (const [env, cfg] of Object.entries(ENVS)) {
  cfg.execArn = `arn:aws:iam::${ACCOUNT}:policy/cba-study-coach-cfn-exec-release-${env}`;
  cfg.policyNames = [
    `cba-study-coach-boundary-gha-deploy-${env}`,
    `cba-study-coach-boundary-runtime-${env}`,
    `cba-study-coach-cfn-exec-release-${env}`,
  ];
  cfg.execRole = `cdk-${cfg.qualifier}-cfn-exec-role-${ACCOUNT}-${REGION}`;
  cfg.docs = Object.fromEntries(cfg.policyNames.map((n) => {
    const t = n.includes('gha-deploy') ? 'gha-deploy-boundary' : n.includes('runtime') ? 'runtime-boundary' : 'cfn-exec-release';
    const rendered = fs.readFileSync(path.join(ROOT, 'infra/aws/bootstrap/policies', `${t}.template.json`), 'utf8')
      .replaceAll('ACCOUNT_ID_PLACEHOLDER', ACCOUNT)
      .replaceAll('ENVIRONMENT_PLACEHOLDER', env)
      .replaceAll('QUALIFIER_PLACEHOLDER', cfg.qualifier);
    return [n, JSON.parse(rendered)];
  }));
  // The model the script itself will resolve — fixtures and expectations share one origin, and
  // the spot-pin test below anchors that origin to hand-written facts of the real template.
  const physFile = path.join(os.tmpdir(), `cba-phys-${env}-${process.pid}.json`);
  fs.writeFileSync(physFile, JSON.stringify({ FileAssetsBucketEncryptionKey: KEY_ID }));
  cfg.model = JSON.parse(execFileSync('python3', [RESOLVER, SNAPSHOT, ACCOUNT, REGION, cfg.qualifier, cfg.execArn, physFile], { encoding: 'utf8' }));
  fs.rmSync(physFile, { force: true });
}

// IAM stores a bare account-id principal as the root ARN — the fake serves THAT form, so the
// validator's normalization is exercised on every run, not assumed.
function iamNormalize(node) {
  if (Array.isArray(node)) return node.map(iamNormalize);
  if (node && typeof node === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(node)) {
      if (k === 'Principal' && v && typeof v === 'object' && typeof v.AWS === 'string' && v.AWS === ACCOUNT) {
        out[k] = { ...v, AWS: `arn:aws:iam::${ACCOUNT}:root` };
      } else out[k] = iamNormalize(v);
    }
    return out;
  }
  return node;
}

function liveStateFor(env) {
  const { model, execArn, execRole, qualifier } = ENVS[env];
  const roles = {};
  for (const [lid, r] of Object.entries(model.roles)) {
    roles[r.name] = {
      lid,
      trust: iamNormalize(r.trust),
      tags: r.tags,
      attached: r.managed,
      inline: r.inline,
      maxSession: r.maxSessionDuration,
    };
  }
  const phys = Object.fromEntries(Object.keys(model.resources).map((lid) => [
    lid, lid === 'FileAssetsBucketEncryptionKey' ? KEY_ID
      : lid === 'ContainerAssetsRepository' ? model.ecr.name
        : lid === 'StagingBucket' ? model.bucket.name : lid.toLowerCase(),
  ]));
  return {
    roles,
    resources: Object.entries(model.resources).map(([lid, t]) => ({
      LogicalResourceId: lid, ResourceType: t, ResourceStatus: 'CREATE_COMPLETE', PhysicalResourceId: phys[lid],
    })),
    bucketPolicy: model.bucket.policy,
    bucketSseKeyArn: model.bucket.sseKmsKeyArn,
    bucketLifecycle: model.bucket.lifecycle,
    ecr: model.ecr,
    kms: model.kms,
    ssmValue: model.ssm.value,
    // The COMPLETE parameter map, as CloudFormation reports it (r3-F3).
    stackParams: Object.entries(model.stackParameters).map(([k, v]) => ({ ParameterKey: k, ParameterValue: v })),
    entities: {
      [`cba-study-coach-boundary-gha-deploy-${env}|PermissionsPolicy`]: [],
      [`cba-study-coach-boundary-gha-deploy-${env}|PermissionsBoundary`]: [`cba-study-coach-gha-deploy-${env}`],
      [`cba-study-coach-boundary-runtime-${env}|PermissionsPolicy`]: [],
      [`cba-study-coach-boundary-runtime-${env}|PermissionsBoundary`]: [`cba-study-coach-${env}-api-role`],
      [`cba-study-coach-cfn-exec-release-${env}|PermissionsPolicy`]: [execRole],
      [`cba-study-coach-cfn-exec-release-${env}|PermissionsBoundary`]: [],
    },
  };
}

function run(env, phase, scen = {}, mutate = null) {
  const cfg = ENVS[env];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cba-relboot-'));
  const mut = path.join(dir, 'mutations');
  const npxLog = path.join(dir, 'npx-calls');
  fs.writeFileSync(mut, '');
  fs.writeFileSync(npxLog, '');
  const S = {
    env, qualifier: cfg.qualifier, execArn: cfg.execArn,
    stsOut: ACCOUNT, stsErr: '',
    expectedEnv: ACCOUNT, authorizedSha: SHA,
    gitHead: SHA, gitDirty: false,
    policyAbsent: [], policyErr: {}, policyDocs: {}, policyVersions: {}, policyPath: {}, createNoop: false,
    stackExists: true, stackErr: '', stackStatus: 'CREATE_COMPLETE', termProt: true,
    stackRoleArn: null, storedTemplate: null,
    resourcesNextToken: false, stackPolicy: false, createRc: 0, waitRc: 0,
    hang: null, hangWait: false, delayedChild: false,
    live: liveStateFor(env),
    docs: cfg.docs,
    ...scen,
  };
  if (mutate) mutate(S);
  const fixture = path.join(dir, 'state.json');
  fs.writeFileSync(fixture, JSON.stringify(S));

  fs.writeFileSync(path.join(dir, 'git'), `#!/usr/bin/env node
const fs = require('fs');
const S = JSON.parse(fs.readFileSync('${fixture}', 'utf8'));
const a = process.argv.slice(2);
const i = a.indexOf('-C');
const rest = i >= 0 ? a.filter((_, j) => j !== i && j !== i + 1) : a;
if (rest[0] === 'rev-parse') { process.stdout.write(S.gitHead + '\\n'); process.exit(0); }
if (rest[0] === 'status') { process.stdout.write(S.gitDirty ? ' M x\\n' : ''); process.exit(0); }
if (rest[0] === 'show') {
  const p = rest[1].split(':')[1];
  process.stdout.write(fs.readFileSync(require('path').join('${ROOT}', p), 'utf8'));
  process.exit(0);
}
process.stderr.write('unexpected git ' + a.join(' ') + '\\n'); process.exit(254);
`, { mode: 0o755 });

  // r3-F1: the script must NEVER execute npx/cdk — any call to this shim is a loud failure,
  // and the npx-calls log doubles as the executed proof that none happened.
  fs.writeFileSync(path.join(dir, 'npx'), `#!/usr/bin/env node
const fs = require('fs');
fs.appendFileSync('${npxLog}', process.argv.slice(2).join(' ') + '\\n');
process.stderr.write('REFUSED BY TEST: npx must never run under the operator script\\n');
process.exit(254);
`, { mode: 0o755 });

  fs.writeFileSync(path.join(dir, 'aws'), `#!/usr/bin/env node
const fs = require('fs');
const S = JSON.parse(fs.readFileSync('${fixture}', 'utf8'));
const raw = process.argv.slice(2);
const a = raw.filter((x, i) => !(x.startsWith('--cli-') || (i > 0 && raw[i - 1].startsWith('--cli-'))));
const sub = a[0] + ' ' + a[1];
if (S.hang === sub) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30000); }
const flag = (n) => { const i = a.indexOf(n); return i >= 0 ? a[i + 1] : null; };
const mut = (x) => fs.appendFileSync('${mut}', x + '\\n');
const die = (m) => { process.stderr.write(m + '\\n'); process.exit(254); };
const out = (o) => process.stdout.write(typeof o === 'string' ? o : JSON.stringify(o));
const pname = (arn) => arn.split('/').pop();
switch (sub) {
  case 'sts get-caller-identity': if (S.stsErr) die(S.stsErr); out(S.stsOut); break;
  case 'iam get-policy': {
    const n = pname(flag('--policy-arn'));
    if (S.policyErr[n]) die(S.policyErr[n]);
    if (S.policyAbsent.includes(n)) die('An error occurred (NoSuchEntity)');
    out({ Policy: { PolicyName: n, Path: S.policyPath[n] || '/', Arn: flag('--policy-arn'), DefaultVersionId: 'v1' } });
    break;
  }
  case 'iam list-policy-versions': {
    const n = pname(flag('--policy-arn'));
    const count = S.policyVersions[n] ?? 1;
    out({ Versions: Array.from({ length: count }, (_, i) => ({ VersionId: 'v' + (i + 1), IsDefaultVersion: i === 0 })) });
    break;
  }
  case 'iam get-policy-version': {
    const n = pname(flag('--policy-arn'));
    out({ PolicyVersion: { Document: S.policyDocs[n] ?? S.docs[n] } });
    break;
  }
  case 'iam list-entities-for-policy': {
    const key = pname(flag('--policy-arn')) + '|' + flag('--policy-usage-filter');
    const roles = S.entitiesOverride?.[key] ?? S.live.entities[key] ?? [];
    out({ PolicyRoles: roles.map((r) => ({ RoleName: r })), PolicyUsers: S.entitiesUsers ?? [], PolicyGroups: [] });
    break;
  }
  case 'iam create-policy': {
    const n = flag('--policy-name');
    mut('create-policy:' + n);
    if (!S.createNoop) { S.policyAbsent = S.policyAbsent.filter((x) => x !== n); fs.writeFileSync('${fixture}', JSON.stringify(S)); }
    break;
  }
  case 'iam get-role': {
    const r = S.live.roles[flag('--role-name')];
    if (!r) die('An error occurred (NoSuchEntity)');
    out({ Role: { Path: r.path || '/', Arn: 'arn:aws:iam::${ACCOUNT}:role/' + flag('--role-name'), AssumeRolePolicyDocument: r.trust, Tags: r.tags, MaxSessionDuration: r.maxSession ?? 3600, ...(r.boundary ? { PermissionsBoundary: { PermissionsBoundaryArn: r.boundary } } : {}) } });
    break;
  }
  case 'iam list-attached-role-policies': {
    const r = S.live.roles[flag('--role-name')] || {};
    out({ AttachedPolicies: (r.attached || []).map((arn) => ({ PolicyName: pname(arn), PolicyArn: arn })) });
    break;
  }
  case 'iam list-role-policies': {
    const r = S.live.roles[flag('--role-name')] || {};
    out({ PolicyNames: Object.keys(r.inline || {}) });
    break;
  }
  case 'iam get-role-policy': {
    const r = S.live.roles[flag('--role-name')] || {};
    out({ PolicyDocument: (r.inline || {})[flag('--policy-name')] ?? {} });
    break;
  }
  case 'cloudformation describe-stacks': {
    if (S.stackErr) die(S.stackErr);
    if (!S.stackExists) die('An error occurred (ValidationError): Stack does not exist');
    out({ Stacks: [{
      StackName: 'cba-release-toolkit-' + S.env, StackStatus: S.stackStatus,
      EnableTerminationProtection: S.termProt,
      ...(S.stackRoleArn ? { RoleARN: S.stackRoleArn } : {}),
      NotificationARNs: [],
      Parameters: S.live.stackParams,
      Outputs: [{ OutputKey: 'BootstrapVersion', OutputValue: S.live.ssmValue }, { OutputKey: 'BucketName', OutputValue: 'unused' }],
    }] });
    break;
  }
  case 'cloudformation get-template':
    out({ TemplateBody: S.storedTemplate ?? fs.readFileSync('${SNAPSHOT}', 'utf8') });
    break;
  case 'cloudformation list-stack-resources':
    out({ StackResourceSummaries: S.live.resources, ...(S.resourcesNextToken ? { NextToken: 'more' } : {}) });
    break;
  case 'cloudformation get-stack-policy': out(S.stackPolicy ? { StackPolicyBody: '{}' } : {}); break;
  case 'cloudformation create-stack': {
    const tb = flag('--template-body');
    const bytes = tb && tb.startsWith('file://') ? fs.readFileSync(tb.slice(7)) : Buffer.from(tb ?? '');
    const digest = require('crypto').createHash('sha256').update(bytes).digest('hex');
    mut('create-stack sha256=' + digest + ' ' + a.slice(2).filter((x) => !x.startsWith('file://')).join(' '));
    if (S.createRc !== 0) { process.stderr.write('create failed\\n'); process.exit(S.createRc); }
    S.stackExists = true; fs.writeFileSync('${fixture}', JSON.stringify(S));
    out({ StackId: 'arn:aws:cloudformation:us-east-1:${ACCOUNT}:stack/x/y' });
    break;
  }
  case 'cloudformation wait': {
    if (S.delayedChild) {
      // The adversarial of r3-F2: a same-group child that tries to register a mutation AFTER the
      // parent is gone. The bounded runner must kill the WHOLE group before reconciliation.
      require('child_process').spawn(process.execPath, ['-e',
        'setTimeout(() => require("fs").appendFileSync("${mut}", "delayed-mutation\\\\n"), 3000)'],
      { stdio: 'ignore' });
    }
    if (S.hangWait) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30000); }
    if (S.waitRc !== 0) { process.stderr.write('waiter failed\\n'); process.exit(S.waitRc); }
    break;
  }
  case 's3api get-bucket-lifecycle-configuration': out({ Rules: S.live.bucketLifecycle }); break;
  case 's3api get-bucket-acl':
    out({ Owner: { ID: 'owner-id' }, Grants: S.aclOverride ?? [{ Grantee: { ID: 'owner-id', Type: 'CanonicalUser' }, Permission: 'FULL_CONTROL' }] });
    break;
  case 'ssm get-parameter': out({ Parameter: { Name: flag('--name'), Value: S.live.ssmValue } }); break;
  case 's3api get-bucket-encryption':
    out({ ServerSideEncryptionConfiguration: { Rules: [{ ApplyServerSideEncryptionByDefault: { SSEAlgorithm: 'aws:kms', KMSMasterKeyID: S.live.bucketSseKeyArn } }] } });
    break;
  case 's3api get-bucket-versioning': out({ Status: 'Enabled' }); break;
  case 's3api get-public-access-block':
    out({ PublicAccessBlockConfiguration: { BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true } });
    break;
  case 's3api get-bucket-policy': out({ Policy: JSON.stringify(S.live.bucketPolicy) }); break;
  case 'ecr describe-repositories':
    out({ repositories: [{ repositoryName: flag('--repository-names'), imageTagMutability: S.live.ecr.imageTagMutability }] });
    break;
  case 'ecr get-lifecycle-policy': out({ lifecyclePolicyText: JSON.stringify(S.live.ecr.lifecycle) }); break;
  case 'ecr get-repository-policy': out({ policyText: JSON.stringify(S.live.ecr.policy) }); break;
  case 'kms describe-key': out({ KeyMetadata: { KeyId: flag('--key-id'), Enabled: true } }); break;
  case 'kms get-key-policy': out({ Policy: JSON.stringify(S.live.kms.keyPolicy) }); break;
  case 'kms list-aliases': out({ Aliases: S.aliasesOverride ?? [{ AliasName: S.live.kms.aliasName }] }); break;
  default: die('unexpected aws ' + a.join(' '));
}
`, { mode: 0o755 });

  let outText = ''; let code = 0;
  try {
    outText = execFileSync('bash', [...(process.env.DBGX ? ['-x'] : []), SCRIPT, env, phase], {
      encoding: 'utf8',
      env: {
        PATH: `${dir}:${process.env.PATH}`,
        ...(S.expectedEnv !== null ? { CBA_EXPECTED_ACCOUNT_ID: S.expectedEnv } : {}),
        ...(S.authorizedSha !== null ? { CBA_AUTHORIZED_SHA: S.authorizedSha } : {}),
        ...(scen.timeouts ?? {}),
      },
    });
  } catch (e) { outText = `${e.stdout ?? ''}${e.stderr ?? ''}`; code = e.status ?? 1; }
  const mutations = fs.readFileSync(mut, 'utf8').split('\n').filter(Boolean);
  const npxCalls = fs.readFileSync(npxLog, 'utf8').split('\n').filter(Boolean);
  if (scen.keepDir) return { out: outText, code, mutations, npxCalls, mutPath: mut, dir };
  fs.rmSync(dir, { recursive: true, force: true });
  return { out: outText, code, mutations, npxCalls };
}

/* ═══════════ the reviewed snapshot and its resolver are anchored to hand-written facts ═══════════ */

test('SNAPSHOT LOCK: the committed template is the pinned digest and declares what the review saw', () => {
  assert.equal(createHash('sha256').update(SNAPSHOT_TEXT).digest('hex'), SNAPSHOT_SHA256,
    'the committed snapshot changed — regenerating it is a REVIEW event, update this pin through review');
  const tpl = parseYaml(SNAPSHOT_TEXT);
  // 14 DECLARED (CdkBoostrapPermissionsBoundaryPolicy included, condition-false by default);
  // the resolver's model carries the 13 that materialize under this project's parameterization.
  assert.equal(Object.keys(tpl.Resources).length, 14);
  assert.equal(tpl.Resources.CdkBootstrapVersion.Properties.Value, '32');
  // The real template's facts round 2 was corrected WITH (r2-F4):
  assert.ok(JSON.stringify(tpl.Resources.LookupRole.Properties.ManagedPolicyArns).includes('ReadOnlyAccess'));
  assert.ok(JSON.stringify(tpl.Resources.DeploymentActionRole.Properties.ManagedPolicyArns).includes('AWSCloudFormationReadOnlyAccess'));
  assert.equal(tpl.Resources.ContainerAssetsRepository.Properties.ImageScanningConfiguration, undefined,
    'the template does NOT enable scan-on-push — requiring it live was the r2-F4 defect');
  assert.equal(tpl.Resources.ContainerAssetsRepository.Properties.ImageTagMutability, 'IMMUTABLE');
});

test('RESOLVER PINS: the model matches hand-written facts of the real template, per tier', () => {
  for (const [env, cfg] of Object.entries(ENVS)) {
    const m = cfg.model;
    assert.deepEqual(sortedKeys(m.resources), [
      'CdkBootstrapVersion', 'CloudFormationExecutionRole', 'ContainerAssetsRepository', 'DeploymentActionRole',
      'FileAssetsBucketEncryptionKey', 'FileAssetsBucketEncryptionKeyAlias', 'FilePublishingRole',
      'FilePublishingRoleDefaultPolicy', 'ImagePublishingRole', 'ImagePublishingRoleDefaultPolicy',
      'LookupRole', 'StagingBucket', 'StagingBucketPolicy',
    ], env);
    assert.deepEqual(m.roles.LookupRole.managed, ['arn:aws:iam::aws:policy/ReadOnlyAccess'], env);
    assert.deepEqual(m.roles.DeploymentActionRole.managed, ['arn:aws:iam::aws:policy/AWSCloudFormationReadOnlyAccess'], env);
    assert.deepEqual(m.roles.CloudFormationExecutionRole.managed, [cfg.execArn], env);
    assert.deepEqual(Object.keys(m.roles.DeploymentActionRole.inline), ['default'], env);
    assert.deepEqual(Object.keys(m.roles.LookupRole.inline), ['LookupRolePolicy'], env);
    const trust = m.roles.FilePublishingRole.trust.Statement;
    assert.equal(trust.length, 2, `${env}: exactly AssumeRole + TagSession — no trusted-accounts leak`);
    assert.deepEqual(trust.map((s) => s.Action).sort(), ['sts:AssumeRole', 'sts:TagSession'], env);
    assert.deepEqual(trust[0].Condition, { Null: { 'sts:ExternalId': 'true' } }, env);
    assert.equal(m.ssm.value, '32', env);
    assert.equal(m.bucket.name, `cdk-${cfg.qualifier}-assets-${ACCOUNT}-${REGION}`, env);
    assert.equal(m.ecr.name, `cdk-${cfg.qualifier}-container-assets-${ACCOUNT}-${REGION}`, env);
    assert.equal(m.kms.aliasName, `alias/cdk-${cfg.qualifier}-assets-key`, env);
  }
  function sortedKeys(o) { return Object.keys(o).sort(); }
});

/* ═══════════ phase: policies (full matrix, both tiers) ═══════════ */

for (const env of ['dev', 'pilot']) {
  test(`EXECUTED policies fresh (${env}): all three created in order, read back, CDK never runs`, () => {
    const r = run(env, 'policies', { policyAbsent: [...ENVS[env].policyNames] });
    assert.equal(r.code, 0, r.out);
    assert.deepEqual(r.mutations, ENVS[env].policyNames.map((n) => `create-policy:${n}`));
    assert.match(r.out, /POLICIES OK/);
    assert.deepEqual(r.npxCalls, [], 'the policies phase must never execute the CDK — not even --version');
    assert.ok(!r.out.includes(ACCOUNT), 'no account id in the output');
  });

  test(`EXECUTED policies reentrant (${env}): zero mutation, consumers audited, next-gate notice`, () => {
    const r = run(env, 'policies', {});
    assert.equal(r.code, 0, r.out);
    assert.deepEqual(r.mutations, []);
    assert.match(r.out, /reentrada, zero mutacao/);
    assert.match(r.out, /PROXIMA FASE: 'bootstrap' exige o seu proprio gate/);
  });

  test(`EXECUTED policies COMPOSITE (${env}): one absent + one divergent — ZERO mutation`, () => {
    const divergent = { Version: '2012-10-17', Statement: [{ Sid: 'W', Effect: 'Allow', Action: '*', Resource: '*' }] };
    const r = run(env, 'policies', {
      policyAbsent: [ENVS[env].policyNames[1]],
      policyDocs: { [ENVS[env].policyNames[0]]: divergent },
    });
    assert.notEqual(r.code, 0);
    assert.match(r.out, /diverges from the reviewed template/);
    assert.deepEqual(r.mutations, []);
  });

  test(`EXECUTED policies consumers (${env}, r2-F3): boundary attached as a NORMAL policy refuses`, () => {
    const [gha, runtime] = ENVS[env].policyNames;
    const other = env === 'dev' ? 'pilot' : 'dev';
    const cases = [
      [{ entitiesOverride: { [`${gha}|PermissionsPolicy`]: ['some-role'] } }, /attached as a NORMAL policy/],
      [{ entitiesOverride: { [`${runtime}|PermissionsPolicy`]: ['some-role'] } }, /attached as a NORMAL policy/],
      [{ entitiesOverride: { [`${gha}|PermissionsBoundary`]: [`cba-study-coach-gha-deploy-${other}`] } }, /outside its nominal set/],
      [{ entitiesOverride: { [`${runtime}|PermissionsBoundary`]: [`cba-study-coach-${other}-api-role`] } }, /outside its nominal set/],
      [{ entitiesOverride: { [`${runtime}|PermissionsBoundary`]: ['totally-foreign-role'] } }, /outside its nominal set/],
      [{ entitiesOverride: { [`${ENVS[env].policyNames[2]}|PermissionsBoundary`]: ['any-role'] } }, /used as a permissions boundary/],
      [{ entitiesOverride: { [`${ENVS[env].policyNames[2]}|PermissionsPolicy`]: ['intruder-role'] } }, /attached beyond the expected execution role/],
    ];
    for (const [scen, re] of cases) {
      const r = run(env, 'policies', scen);
      assert.notEqual(r.code, 0, JSON.stringify(scen));
      assert.match(r.out, re, JSON.stringify(scen));
      assert.deepEqual(r.mutations, [], 'zero mutation');
    }
  });
}

test('EXECUTED policies divergence surfaces: document, version set, identity — ZERO mutation (dev)', () => {
  const names = ENVS.dev.policyNames;
  const divergent = { Version: '2012-10-17', Statement: [] };
  const cases = [
    [{ policyDocs: { [names[2]]: divergent } }, /diverges from the reviewed template/],
    [{ policyVersions: { [names[0]]: 2 } }, /version set beyond the single reviewed default/],
    [{ policyPath: { [names[1]]: '/elsewhere/' } }, /identity \(name\/path\/arn\) diverges/],
  ];
  for (const [scen, re] of cases) {
    const r = run('dev', 'policies', scen);
    assert.notEqual(r.code, 0);
    assert.match(r.out, re);
    assert.deepEqual(r.mutations, []);
  }
});

test('EXECUTED policies hollow create: success reported, nothing materialized — never OK (dev)', () => {
  const r = run('dev', 'policies', { policyAbsent: [...ENVS.dev.policyNames], createNoop: true });
  assert.notEqual(r.code, 0);
  assert.match(r.out, /did NOT materialize/);
  assert.ok(!/POLICIES OK/.test(r.out));
});

/* ═══════════ phase: bootstrap (full matrix, both tiers) ═══════════ */

for (const env of ['dev', 'pilot']) {
  const cfg = ENVS[env];

  test(`EXECUTED bootstrap fresh (${env}, r3-F1): the EXACT snapshot bytes go to CloudFormation; npx never runs; full read-back`, () => {
    const r = run(env, 'bootstrap', { stackExists: false });
    assert.equal(r.code, 0, r.out);
    const boot = r.mutations.filter((m) => m.startsWith('create-stack'));
    assert.equal(boot.length, 1, 'exactly one create-stack — never a blind retry');
    const args = boot[0];
    // EXECUTOR BINDING: the fake computed the sha256 of the bytes it was HANDED — they must be
    // the committed snapshot's, so "an executor that ignores --template" has nowhere to hide.
    assert.ok(args.includes(`sha256=${SNAPSHOT_SHA256}`), 'the submitted template bytes are the reviewed snapshot');
    assert.match(args, new RegExp(`--stack-name cba-release-toolkit-${env}`));
    assert.ok(args.includes(`ParameterKey=Qualifier,ParameterValue=${cfg.qualifier}`));
    assert.ok(args.includes(`ParameterKey=CloudFormationExecutionPolicies,ParameterValue=${cfg.execArn}`));
    assert.match(args, /--capabilities CAPABILITY_NAMED_IAM/);
    assert.match(args, /--enable-termination-protection/);
    assert.equal(r.mutations.filter((m) => m.startsWith('create-policy')).length, 0, 'this phase never creates a policy');
    assert.deepEqual(r.npxCalls, [], 'npx/cdk NEVER runs under the operator script (r3-F1)');
    assert.match(r.out, /snapshot revisado do SHA autorizado/);
    assert.match(r.out, /READ-BACK OK/);
    assert.ok(!r.out.includes(ACCOUNT), 'no account id in the output');
  });

  test(`EXECUTED bootstrap reentrant (${env}): full read-back against the model, zero mutation`, () => {
    const r = run(env, 'bootstrap', {});
    assert.equal(r.code, 0, r.out);
    assert.deepEqual(r.mutations, []);
    assert.deepEqual(r.npxCalls, []);
    assert.match(r.out, /reentrada, zero mutacao/);
  });
}

test('EXECUTED bootstrap role divergences (r2-F2): widened trust, extra principal, dropped condition, admin inline, extra managed, missing tag — each refuses with zero mutation (dev)', () => {
  const m = ENVS.dev.model;
  const names = Object.fromEntries(Object.entries(m.roles).map(([lid, r]) => [lid, r.name]));
  const cases = [
    ['wildcard principal', (S) => { S.live.roles[names.DeploymentActionRole].trust.Statement[0].Principal = { AWS: '*' }; }, /DeploymentActionRole: the trust document diverges/],
    ['extra same-account principal', (S) => { S.live.roles[names.FilePublishingRole].trust.Statement[0].Principal.AWS = [`arn:aws:iam::${ACCOUNT}:root`, `arn:aws:iam::${ACCOUNT}:role/other`]; }, /FilePublishingRole: the trust document diverges/],
    ['dropped ExternalId condition', (S) => { delete S.live.roles[names.LookupRole].trust.Statement[0].Condition; }, /LookupRole: the trust document diverges/],
    ['foreign service principal on exec', (S) => { S.live.roles[names.CloudFormationExecutionRole].trust.Statement.push({ Action: 'sts:AssumeRole', Effect: 'Allow', Principal: { Service: 'lambda.amazonaws.com' } }); }, /CloudFormationExecutionRole: the trust document diverges/],
    ['administrative inline doc', (S) => { S.live.roles[names.DeploymentActionRole].inline.default = { Version: '2012-10-17', Statement: [{ Effect: 'Allow', Action: '*', Resource: '*' }] }; }, /inline policy default diverges/],
    ['extra inline policy', (S) => { S.live.roles[names.ImagePublishingRole].inline.backdoor = { Version: '2012-10-17', Statement: [] }; }, /inline policy NAME set diverges/],
    ['extra managed on lookup', (S) => { S.live.roles[names.LookupRole].attached = [...S.live.roles[names.LookupRole].attached, 'arn:aws:iam::aws:policy/AdministratorAccess']; }, /managed policy set diverges/],
    ['missing bootstrap-role tag', (S) => { S.live.roles[names.FilePublishingRole].tags = []; }, /tag set diverges/],
    ['unexpected boundary', (S) => { S.live.roles[names.LookupRole].boundary = `arn:aws:iam::${ACCOUNT}:policy/foreign`; }, /permissions boundary diverges/],
  ];
  for (const [label, mutate, re] of cases) {
    const r = run('dev', 'bootstrap', {}, mutate);
    assert.notEqual(r.code, 0, label);
    assert.match(r.out, re, label);
    assert.deepEqual(r.mutations, [], `${label}: zero mutation`);
  }
});

test('EXECUTED bootstrap stack/resource/data divergences (r2-F1): each refuses with zero mutation (dev)', () => {
  const cases = [
    ['termination protection off', { termProt: false }, /termination protection is not enabled/],
    ['non-terminal status', { stackStatus: 'UPDATE_ROLLBACK_COMPLETE' }, /not a terminal COMPLETE state/],
    ['service role present', { stackRoleArn: `arn:aws:iam::${ACCOUNT}:role/svc` }, /unexpected service role/],
    ['stored template diverges', { storedTemplate: 'Resources: {}\n' }, /stored template diverges/],
    ['stack policy present', { stackPolicy: true }, /unexpected stack policy/],
    ['truncated listing', { resourcesNextToken: true }, /paginated\/truncated/],
  ];
  for (const [label, scen, re] of cases) {
    const r = run('dev', 'bootstrap', scen);
    assert.notEqual(r.code, 0, label);
    assert.match(r.out, re, label);
    assert.deepEqual(r.mutations, [], `${label}: zero mutation`);
  }
  const mutCases = [
    ['extra deployed resource', (S) => { S.live.resources.push({ LogicalResourceId: 'Backdoor', ResourceType: 'AWS::IAM::Role', ResourceStatus: 'CREATE_COMPLETE', PhysicalResourceId: 'x' }); }, /deployed but the template declares no such resource/],
    ['missing NON-CORE resource', (S) => { S.live.resources = S.live.resources.filter((r) => r.LogicalResourceId !== 'StagingBucketPolicy'); }, /StagingBucketPolicy is declared by the template but not deployed/],
    ['resource in progress', (S) => { S.live.resources[0].ResourceStatus = 'UPDATE_IN_PROGRESS'; }, /is in state UPDATE_IN_PROGRESS/],
    ['bucket policy divergence', (S) => { S.live.bucketPolicy = { Version: '2012-10-17', Statement: [] }; }, /bucket policy diverges/],
    ['ssm version divergence', (S) => { S.live.ssmValue = '7'; }, /diverges from the template's 32/],
    ['ecr lifecycle divergence', (S) => { S.live.ecr.lifecycle = { rules: [] }; }, /lifecycle policy diverges/],
    ['kms key policy divergence', (S) => { S.live.kms.keyPolicy = { Version: '2012-10-17', Statement: [] }; }, /key policy diverges/],
    ['kms alias absent', (S) => { S.aliasesOverride = []; }, /template alias is absent/],
    // r3-F3: the three named adversarials — destructive lifecycle, 12h sessions, BootstrapVariant.
    ['DESTRUCTIVE bucket lifecycle rule', (S) => { S.live.bucketLifecycle = [...S.live.bucketLifecycle, { Id: 'ExpireEverything', Status: 'Enabled', Expiration: { Days: 1 } }]; }, /lifecycle configuration diverges .* expire live assets/],
    ['12-hour session on the deploy role', (S) => { const n = Object.keys(S.live.roles).find((k) => k.includes('-deploy-role-')); S.live.roles[n].maxSession = 43200; }, /MaxSessionDuration diverges/],
    ['BootstrapVariant divergence', (S) => { S.live.stackParams = S.live.stackParams.map((p) => (p.ParameterKey === 'BootstrapVariant' ? { ...p, ParameterValue: 'Someone Elses Bootstrap' } : p)); }, /parameter BootstrapVariant diverges/],
    ['smuggled extra parameter', (S) => { S.live.stackParams.push({ ParameterKey: 'Backdoor', ParameterValue: 'x' }); }, /unexpected parameter Backdoor/],
    ['non-owner ACL grant', (S) => { S.aclOverride = [{ Grantee: { ID: 'owner-id', Type: 'CanonicalUser' }, Permission: 'FULL_CONTROL' }, { Grantee: { URI: 'http://acs.amazonaws.com/groups/global/AllUsers', Type: 'Group' }, Permission: 'READ' }]; }, /ACL is not owner-only/],
  ];
  for (const [label, mutate, re] of mutCases) {
    const r = run('dev', 'bootstrap', {}, mutate);
    assert.notEqual(r.code, 0, label);
    assert.match(r.out, re, label);
    assert.deepEqual(r.mutations, [], `${label}: zero mutation`);
  }
});

test('EXECUTED bootstrap precondition: absent/divergent policy stops before any mutation (dev)', () => {
  const r = run('dev', 'bootstrap', { policyAbsent: [ENVS.dev.policyNames[2]], stackExists: false });
  assert.notEqual(r.code, 0);
  assert.deepEqual(r.mutations, []);
  assert.deepEqual(r.npxCalls, []);
});

test('EXECUTED bootstrap failure and TIMEOUTS (r2-F5/r3-F2): named refusals, reconciliation, one attempt', () => {
  const createFail = run('dev', 'bootstrap', { stackExists: false, createRc: 1 });
  assert.notEqual(createFail.code, 0);
  assert.match(createFail.out, /FAILED at create-stack/);
  assert.equal(createFail.mutations.filter((m) => m.startsWith('create-stack')).length, 1);
  assert.ok(!createFail.out.includes(ACCOUNT));

  const waitFail = run('dev', 'bootstrap', { stackExists: false, waitRc: 255 });
  assert.notEqual(waitFail.code, 0);
  assert.match(waitFail.out, /read-only reconciliation follows; no retry/);
  assert.equal(waitFail.mutations.filter((m) => m.startsWith('create-stack')).length, 1);

  const hungObs = run('dev', 'policies', { hang: 'iam get-policy', timeouts: { CBA_OBSERVE_TIMEOUT_SECONDS: '1' } });
  assert.notEqual(hungObs.code, 0);
  assert.match(hungObs.out, /OBSERVATION_TIMEOUT/);
  assert.deepEqual(hungObs.mutations, [], 'a hung observation mutates nothing');

  const hungBoot = run('dev', 'bootstrap', { stackExists: false, hangWait: true, timeouts: { CBA_BOOTSTRAP_TIMEOUT_SECONDS: '1' } });
  assert.notEqual(hungBoot.code, 0);
  assert.match(hungBoot.out, /BOOTSTRAP TIMEOUT .*INDETERMINATE/);
  assert.match(hungBoot.out, /reconciliation/);
  assert.equal(hungBoot.mutations.filter((m) => m.startsWith('create-stack')).length, 1, 'exactly one attempt, never retried');
});

test('EXECUTED r3-F2: a same-group child trying a DELAYED mutation dies with the group — the mutation never lands', async () => {
  const r = run('dev', 'bootstrap', { stackExists: false, hangWait: true, delayedChild: true, keepDir: true, timeouts: { CBA_BOOTSTRAP_TIMEOUT_SECONDS: '1' } });
  try {
    assert.notEqual(r.code, 0);
    assert.match(r.out, /killed and reaped/);
    // The child scheduled its write for T+3s; the group was killed at T+1s. The mutations file
    // SURVIVES past T+3s (keepDir), so a still-alive child could land its write — re-read and
    // prove it never does.
    await new Promise((resolve) => { setTimeout(resolve, 3500); });
    const after = fs.readFileSync(r.mutPath, 'utf8').split('\n').filter(Boolean);
    assert.ok(!after.includes('delayed-mutation'), 'the delayed mutation must never land');
  } finally {
    fs.rmSync(r.dir, { recursive: true, force: true });
  }
});

test('EXECUTED r3-F2: zero, garbage and above-ceiling timeouts are REFUSED — never a disabled deadline', () => {
  const cases = [
    [{ CBA_OBSERVE_TIMEOUT_SECONDS: '0' }, /must be a positive integer no greater than 600/],
    [{ CBA_OBSERVE_TIMEOUT_SECONDS: 'abc' }, /must be a positive integer no greater than 600/],
    [{ CBA_OBSERVE_TIMEOUT_SECONDS: '9999' }, /must be a positive integer no greater than 600/],
    [{ CBA_BOOTSTRAP_TIMEOUT_SECONDS: '0' }, /must be a positive integer no greater than 7200/],
    [{ CBA_BOOTSTRAP_TIMEOUT_SECONDS: '99999' }, /must be a positive integer no greater than 7200/],
  ];
  for (const [timeouts, re] of cases) {
    const r = run('dev', 'policies', { timeouts });
    assert.notEqual(r.code, 0, JSON.stringify(timeouts));
    assert.match(r.out, re, JSON.stringify(timeouts));
    assert.deepEqual(r.mutations, [], 'zero mutation');
  }
});

/* ═══════════ common bindings and the closed CLI ═══════════ */

test('EXECUTED bindings: account, SHA, worktree, CDK — each refuses with ZERO mutation, nothing echoed', () => {
  const cases = [
    ['policies', { expectedEnv: '999988887777' }, /do not belong to the authorized account/],
    ['policies', { expectedEnv: null }, /CBA_EXPECTED_ACCOUNT_ID is required/],
    ['policies', { expectedEnv: '12345' }, /CBA_EXPECTED_ACCOUNT_ID is required/],
    ['policies', { stsOut: 'not-a-number' }, /STS account is malformed/],
    ['policies', { stsErr: 'AccessDenied' }, /STS identity observation failed/],
    ['policies', { authorizedSha: null }, /CBA_AUTHORIZED_SHA is required/],
    ['policies', { authorizedSha: 'abc123' }, /CBA_AUTHORIZED_SHA is required/],
    ['policies', { gitHead: 'e'.repeat(40) }, /HEAD does not match/],
    ['policies', { gitDirty: true }, /worktree is dirty/],
  ];
  for (const [phase, scen, re] of cases) {
    const r = run('dev', phase, scen);
    assert.notEqual(r.code, 0, JSON.stringify(scen));
    assert.match(r.out, re, JSON.stringify(scen));
    assert.deepEqual(r.mutations, [], `${JSON.stringify(scen)}: zero mutation`);
    assert.ok(!r.out.includes('999988887777') && !r.out.includes(ACCOUNT), 'no account echoed');
  }
});

test('EXECUTED observation errors are NEVER absence — zero mutation', () => {
  const cases = [
    ['policies', { policyErr: { [ENVS.dev.policyNames[0]]: 'An error occurred (AccessDenied)' } }],
    ['bootstrap', { stackErr: 'An error occurred (AccessDenied) when calling DescribeStacks' }],
  ];
  for (const [phase, scen] of cases) {
    const r = run('dev', phase, scen);
    assert.notEqual(r.code, 0, JSON.stringify(scen));
    assert.match(r.out, /not a proven absence/, JSON.stringify(scen));
    assert.deepEqual(r.mutations, [], 'zero mutation');
  }
});

test('EXECUTED closed CLI: no combined mode, no default, no third argument', () => {
  for (const args of [['dev'], ['dev', 'all'], ['dev', ''], ['staging', 'policies'], ['dev', 'policies', 'bootstrap']]) {
    let code = 0; let out = '';
    try {
      out = execFileSync('bash', [SCRIPT, ...args], { encoding: 'utf8', env: { PATH: process.env.PATH } });
    } catch (e) { out = `${e.stdout ?? ''}${e.stderr ?? ''}`; code = e.status ?? 1; }
    assert.notEqual(code, 0, JSON.stringify(args));
    assert.match(out, /usage:|REFUSED/, JSON.stringify(args));
  }
});
