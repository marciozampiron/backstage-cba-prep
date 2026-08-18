// EXECUTED proofs for scripts/provision-release-bootstrap.sh (#111): two mutually exclusive
// phases, observe-then-act, full read-back. The fake aws serves complete observations and
// RECORDS every mutating call; the fake npx records every cdk invocation with its exact
// arguments; the fake git pins the authorized SHA and the clean worktree. Every refusal must
// leave ZERO mutation behind; no output may carry an account id.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(ROOT, 'scripts/provision-release-bootstrap.sh');
const ACCOUNT = '111122223333';
const SHA = 'f'.repeat(40);
const QUALIFIER = 'cbardev';
const EXEC_ARN = `arn:aws:iam::${ACCOUNT}:policy/cba-study-coach-cfn-exec-release-dev`;
const CDK_VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'infra/aws/package-lock.json'), 'utf8'))
  .packages['node_modules/aws-cdk'].version;

const render = (f) => fs.readFileSync(path.join(ROOT, 'infra/aws/bootstrap/policies', f), 'utf8')
  .replaceAll('ACCOUNT_ID_PLACEHOLDER', ACCOUNT)
  .replaceAll('ENVIRONMENT_PLACEHOLDER', 'dev')
  .replaceAll('QUALIFIER_PLACEHOLDER', QUALIFIER);
const DOCS = {
  'cba-study-coach-boundary-gha-deploy-dev': JSON.parse(render('gha-deploy-boundary.template.json')),
  'cba-study-coach-boundary-runtime-dev': JSON.parse(render('runtime-boundary.template.json')),
  'cba-study-coach-cfn-exec-release-dev': JSON.parse(render('cfn-exec-release.template.json')),
};
const POLICY_NAMES = Object.keys(DOCS);

// The template the fake `cdk bootstrap --show-template` emits — the script derives its closed
// resource set from EXACTLY these bytes, and get-template must return them verbatim.
const TEMPLATE = `Resources:
  StagingBucket:
    Type: AWS::S3::Bucket
  ContainerAssetsRepository:
    Type: AWS::ECR::Repository
  FilePublishingRole:
    Type: AWS::IAM::Role
  ImagePublishingRole:
    Type: AWS::IAM::Role
  LookupRole:
    Type: AWS::IAM::Role
  DeploymentActionRole:
    Type: AWS::IAM::Role
  CloudFormationExecutionRole:
    Type: AWS::IAM::Role
  CdkBootstrapVersion:
    Type: AWS::SSM::Parameter
`;
const RESOURCE_TYPES = {
  StagingBucket: 'AWS::S3::Bucket',
  ContainerAssetsRepository: 'AWS::ECR::Repository',
  FilePublishingRole: 'AWS::IAM::Role',
  ImagePublishingRole: 'AWS::IAM::Role',
  LookupRole: 'AWS::IAM::Role',
  DeploymentActionRole: 'AWS::IAM::Role',
  CloudFormationExecutionRole: 'AWS::IAM::Role',
  CdkBootstrapVersion: 'AWS::SSM::Parameter',
};

function run(phase, scen = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cba-relboot-'));
  const mut = path.join(dir, 'mutations');
  const npxLog = path.join(dir, 'npx-calls');
  fs.writeFileSync(mut, '');
  fs.writeFileSync(npxLog, '');
  const S = {
    stsOut: ACCOUNT, stsErr: '',
    expectedEnv: ACCOUNT, authorizedSha: SHA,
    gitHead: SHA, gitDirty: false,
    cdkVersion: `${CDK_VERSION} (build fake)`,
    policyAbsent: [], policyErr: {}, policyDocs: {}, policyVersions: {}, createNoop: false,
    stackExists: true, stackErr: '', stackStatus: 'CREATE_COMPLETE', termProt: true,
    stackRoleArn: null, storedTemplate: null, resourceStatus: 'CREATE_COMPLETE',
    extraResource: false, resourcesNextToken: false,
    execAttached: null, entitiesRoles: null, ssmAbsent: false, ssmValue: '21',
    pabOff: false, ecrMutable: false, stackPolicy: false, bootstrapRc: 0,
    ...scen,
  };
  const fixture = path.join(dir, 'state.json');
  fs.writeFileSync(fixture, JSON.stringify(S));
  fs.writeFileSync(path.join(dir, 'template.yaml'), TEMPLATE);

  fs.writeFileSync(path.join(dir, 'git'), `#!/usr/bin/env node
const fs = require('fs');
const S = JSON.parse(fs.readFileSync('${fixture}', 'utf8'));
const a = process.argv.slice(2);
const i = a.indexOf('-C');
const root = i >= 0 ? a[i + 1] : process.cwd();
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

  fs.writeFileSync(path.join(dir, 'npx'), `#!/usr/bin/env node
const fs = require('fs');
const S = JSON.parse(fs.readFileSync('${fixture}', 'utf8'));
const a = process.argv.slice(2);
fs.appendFileSync('${npxLog}', a.join(' ') + '\\n');
if (a.includes('--version')) { process.stdout.write(S.cdkVersion + '\\n'); process.exit(0); }
if (a.includes('--show-template')) { process.stdout.write(fs.readFileSync('${dir}/template.yaml', 'utf8')); process.exit(0); }
if (a[1] === 'cdk' && a[2] === 'bootstrap') {
  fs.appendFileSync('${mut}', 'cdk-bootstrap ' + a.slice(3).join(' ') + '\\n');
  if (S.bootstrapRc !== 0) { process.stderr.write('bootstrap failed\\n'); process.exit(S.bootstrapRc); }
  S.stackExists = true; fs.writeFileSync('${fixture}', JSON.stringify(S));
  process.exit(0);
}
process.stderr.write('unexpected npx ' + a.join(' ') + '\\n'); process.exit(254);
`, { mode: 0o755 });

  fs.writeFileSync(path.join(dir, 'aws'), `#!/usr/bin/env node
const fs = require('fs');
const S = JSON.parse(fs.readFileSync('${fixture}', 'utf8'));
const a = process.argv.slice(2);
const sub = a[0] + ' ' + a[1];
const flag = (n) => { const i = a.indexOf(n); return i >= 0 ? a[i + 1] : null; };
const mut = (x) => fs.appendFileSync('${mut}', x + '\\n');
const die = (m) => { process.stderr.write(m + '\\n'); process.exit(254); };
const out = (o) => process.stdout.write(typeof o === 'string' ? o : JSON.stringify(o));
const DOCS = ${JSON.stringify(DOCS)};
const TYPES = ${JSON.stringify(RESOURCE_TYPES)};
const pname = (arn) => arn.split('/').pop();
const roleOf = (n) => n.match(/^cdk-${QUALIFIER}-(.+)-role-/)?.[1];
switch (sub) {
  case 'sts get-caller-identity': if (S.stsErr) die(S.stsErr); out(S.stsOut); break;
  case 'iam get-policy': {
    const n = pname(flag('--policy-arn'));
    if (S.policyErr[n]) die(S.policyErr[n]);
    if (S.policyAbsent.includes(n)) die('An error occurred (NoSuchEntity)');
    out({ Policy: { PolicyName: n, Path: (S.policyPath && S.policyPath[n]) || '/', Arn: flag('--policy-arn'), DefaultVersionId: 'v1' } });
    break;
  }
  case 'iam list-policy-versions': {
    const n = pname(flag('--policy-arn'));
    const count = S.policyVersions[n] ?? 1;
    const vs = Array.from({ length: count }, (_, i) => ({ VersionId: 'v' + (i + 1), IsDefaultVersion: i === 0 }));
    out({ Versions: vs });
    break;
  }
  case 'iam get-policy-version': {
    const n = pname(flag('--policy-arn'));
    out({ PolicyVersion: { Document: S.policyDocs[n] ?? DOCS[n] } });
    break;
  }
  case 'iam create-policy': {
    const n = flag('--policy-name');
    mut('create-policy:' + n);
    if (!S.createNoop) { S.policyAbsent = S.policyAbsent.filter((x) => x !== n); fs.writeFileSync('${fixture}', JSON.stringify(S)); }
    break;
  }
  case 'cloudformation describe-stacks': {
    if (S.stackErr) die(S.stackErr);
    if (!S.stackExists) die("An error occurred (ValidationError): Stack with id ${'cba-release-toolkit-dev'} does not exist");
    out({ Stacks: [{
      StackName: 'cba-release-toolkit-dev', StackStatus: S.stackStatus,
      EnableTerminationProtection: S.termProt,
      ...(S.stackRoleArn ? { RoleARN: S.stackRoleArn } : {}),
      NotificationARNs: [],
      Parameters: [
        { ParameterKey: 'Qualifier', ParameterValue: '${QUALIFIER}' },
        { ParameterKey: 'CloudFormationExecutionPolicies', ParameterValue: '${EXEC_ARN}' },
        { ParameterKey: 'TrustedAccounts', ParameterValue: '' },
      ],
      Outputs: [
        { OutputKey: 'BootstrapVersion', OutputValue: S.ssmValue },
        { OutputKey: 'BucketName', OutputValue: 'cdk-fake-assets' },
      ],
    }] });
    break;
  }
  case 'cloudformation get-template':
    out({ TemplateBody: S.storedTemplate ?? fs.readFileSync('${dir}/template.yaml', 'utf8') });
    break;
  case 'cloudformation list-stack-resources': {
    const rs = Object.entries(TYPES).map(([id, t]) => ({
      LogicalResourceId: id, ResourceType: t, ResourceStatus: S.resourceStatus,
      PhysicalResourceId: id === 'ContainerAssetsRepository' ? 'cdk-fake-repo' : id.toLowerCase(),
    }));
    if (S.extraResource) rs.push({ LogicalResourceId: 'Backdoor', ResourceType: 'AWS::IAM::Role', ResourceStatus: 'CREATE_COMPLETE', PhysicalResourceId: 'backdoor' });
    out({ StackResourceSummaries: rs, ...(S.resourcesNextToken ? { NextToken: 'more' } : {}) });
    break;
  }
  case 'iam get-role': {
    const r = roleOf(flag('--role-name'));
    if (!r) die('unexpected role ' + flag('--role-name'));
    const trust = r === 'cfn-exec'
      ? { Version: '2012-10-17', Statement: [{ Effect: 'Allow', Principal: { Service: 'cloudformation.amazonaws.com' }, Action: 'sts:AssumeRole' }] }
      : { Version: '2012-10-17', Statement: [{ Effect: 'Allow', Principal: { AWS: 'arn:aws:iam::${ACCOUNT}:root' }, Action: 'sts:AssumeRole' }] };
    out({ Role: { Path: '/', Arn: 'arn:aws:iam::${ACCOUNT}:role/' + flag('--role-name'), AssumeRolePolicyDocument: trust } });
    break;
  }
  case 'iam list-attached-role-policies': {
    const r = roleOf(flag('--role-name'));
    const base = r === 'cfn-exec' ? [{ PolicyName: pname('${EXEC_ARN}'), PolicyArn: '${EXEC_ARN}' }] : [];
    out({ AttachedPolicies: S.execAttached && r === 'cfn-exec' ? S.execAttached : base });
    break;
  }
  case 'iam list-role-policies': out({ PolicyNames: ['default'] }); break;
  case 'iam get-role-policy': out({ PolicyDocument: { Version: '2012-10-17', Statement: [] } }); break;
  case 'iam list-entities-for-policy':
    out({ PolicyRoles: S.entitiesRoles ?? [{ RoleName: 'cdk-${QUALIFIER}-cfn-exec-role-${ACCOUNT}-us-east-1' }], PolicyUsers: [], PolicyGroups: [] });
    break;
  case 'ssm get-parameter':
    if (S.ssmAbsent) die('An error occurred (ParameterNotFound)');
    out({ Parameter: { Name: flag('--name'), Value: S.ssmValue } });
    break;
  case 's3api get-bucket-encryption': out({ ServerSideEncryptionConfiguration: { Rules: [{ ApplyServerSideEncryptionByDefault: { SSEAlgorithm: 'aws:kms' } }] } }); break;
  case 's3api get-bucket-versioning': out({ Status: 'Enabled' }); break;
  case 's3api get-bucket-ownership-controls': out({ OwnershipControls: { Rules: [{ ObjectOwnership: 'BucketOwnerEnforced' }] } }); break;
  case 's3api get-public-access-block':
    out({ PublicAccessBlockConfiguration: { BlockPublicAcls: true, BlockPublicPolicy: !S.pabOff, IgnorePublicAcls: true, RestrictPublicBuckets: true } });
    break;
  case 'ecr describe-repositories':
    out({ repositories: [{ repositoryName: flag('--repository-names'), encryptionConfiguration: { encryptionType: 'KMS' }, imageTagMutability: S.ecrMutable ? 'MUTABLE' : 'IMMUTABLE', imageScanningConfiguration: { scanOnPush: true } }] });
    break;
  case 'ecr get-lifecycle-policy': out({ lifecyclePolicyText: '{}' }); break;
  case 'ecr get-repository-policy': out({ policyText: '{}' }); break;
  case 'cloudformation get-stack-policy': out(S.stackPolicy ? { StackPolicyBody: '{}' } : {}); break;
  default: die('unexpected aws ' + a.join(' '));
}
`, { mode: 0o755 });

  let outText = ''; let code = 0;
  try {
    outText = execFileSync('bash', [SCRIPT, 'dev', phase], {
      encoding: 'utf8',
      env: {
        PATH: `${dir}:${process.env.PATH}`,
        ...(S.expectedEnv !== null ? { CBA_EXPECTED_ACCOUNT_ID: S.expectedEnv } : {}),
        ...(S.authorizedSha !== null ? { CBA_AUTHORIZED_SHA: S.authorizedSha } : {}),
      },
    });
  } catch (e) { outText = `${e.stdout ?? ''}${e.stderr ?? ''}`; code = e.status ?? 1; }
  const mutations = fs.readFileSync(mut, 'utf8').split('\n').filter(Boolean);
  const npxCalls = fs.readFileSync(npxLog, 'utf8').split('\n').filter(Boolean);
  fs.rmSync(dir, { recursive: true, force: true });
  return { out: outText, code, mutations, npxCalls };
}

/* ═══════════ phase: policies ═══════════ */

test('EXECUTED policies fresh: all three absent — created in order, read back, CDK never runs', () => {
  const r = run('policies', { policyAbsent: [...POLICY_NAMES] });
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(r.mutations, POLICY_NAMES.map((n) => `create-policy:${n}`));
  assert.match(r.out, /POLICIES OK/);
  assert.match(r.out, /read-back completo/);
  assert.deepEqual(r.npxCalls, [], 'the policies phase must never execute the CDK — not even --version');
  assert.ok(!r.out.includes(ACCOUNT), 'no account id in the output');
});

test('EXECUTED policies reentrant: all three exist identical — zero mutation, explicit next-gate notice', () => {
  const r = run('policies', {});
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(r.mutations, []);
  assert.match(r.out, /reentrada, zero mutacao/);
  assert.match(r.out, /PROXIMA FASE: 'bootstrap' exige o seu proprio gate/);
});

test('EXECUTED policies partial-fresh: one absent, two clean — only the absent one is created', () => {
  const r = run('policies', { policyAbsent: ['cba-study-coach-boundary-runtime-dev'] });
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(r.mutations, ['create-policy:cba-study-coach-boundary-runtime-dev']);
});

test('EXECUTED policies COMPOSITE: one absent + one divergent — refuses with ZERO mutation', () => {
  const divergent = { Version: '2012-10-17', Statement: [{ Sid: 'Widened', Effect: 'Allow', Action: '*', Resource: '*' }] };
  const r = run('policies', {
    policyAbsent: ['cba-study-coach-boundary-runtime-dev'],
    policyDocs: { 'cba-study-coach-boundary-gha-deploy-dev': divergent },
  });
  assert.notEqual(r.code, 0);
  assert.match(r.out, /diverges from the reviewed template/);
  assert.deepEqual(r.mutations, [], 'zero mutation before every existing policy validates');
});

test('EXECUTED policies divergence surfaces: document, version set — each refuses with ZERO mutation', () => {
  const divergent = { Version: '2012-10-17', Statement: [] };
  const cases = [
    [{ policyDocs: { 'cba-study-coach-cfn-exec-release-dev': divergent } }, /diverges from the reviewed template/],
    [{ policyVersions: { 'cba-study-coach-boundary-gha-deploy-dev': 2 } }, /version set beyond the single reviewed default/],
    [{ policyPath: { 'cba-study-coach-boundary-runtime-dev': '/elsewhere/' } }, /identity \(name\/path\/arn\) diverges/],
  ];
  for (const [scen, re] of cases) {
    const r = run('policies', scen);
    assert.notEqual(r.code, 0);
    assert.match(r.out, re);
    assert.deepEqual(r.mutations, []);
  }
});

test('EXECUTED policies hollow create: success reported, nothing materialized — never READ-BACK OK', () => {
  const r = run('policies', { policyAbsent: [...POLICY_NAMES], createNoop: true });
  assert.notEqual(r.code, 0);
  assert.match(r.out, /did NOT materialize/);
  assert.ok(!/POLICIES OK/.test(r.out));
});

/* ═══════════ phase: bootstrap ═══════════ */

test('EXECUTED bootstrap fresh: exact arguments, no --trust/--force, full read-back', () => {
  const r = run('bootstrap', { stackExists: false });
  assert.equal(r.code, 0, r.out);
  const boot = r.mutations.filter((m) => m.startsWith('cdk-bootstrap'));
  assert.equal(boot.length, 1, 'exactly one bootstrap invocation — never a blind retry');
  const args = boot[0];
  assert.match(args, new RegExp(`aws://${ACCOUNT}/us-east-1`));
  assert.match(args, /--qualifier cbardev/);
  assert.match(args, /--toolkit-stack-name cba-release-toolkit-dev/);
  assert.ok(args.includes(`--cloudformation-execution-policies ${EXEC_ARN}`));
  assert.match(args, /--termination-protection/);
  assert.match(args, /--template /);
  assert.ok(!args.includes('--trust'), 'no cross-account trust, ever');
  assert.ok(!args.includes('--force'), 'no forced update, ever');
  assert.equal(r.mutations.filter((m) => m.startsWith('create-policy')).length, 0, 'the bootstrap phase never creates a policy');
  assert.match(r.out, /READ-BACK OK/);
  assert.match(r.out, /BOOTSTRAP OK/);
  assert.ok(!r.out.includes(ACCOUNT), 'no account id in the output');
});

test('EXECUTED bootstrap reentrant: stack exists and validates — zero mutation', () => {
  const r = run('bootstrap', {});
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(r.mutations, []);
  assert.match(r.out, /reentrada, zero mutacao/);
  assert.match(r.out, /nenhuma mutacao/);
});

test('EXECUTED bootstrap precondition: an absent or divergent policy stops the phase before any CDK', () => {
  const divergent = { Version: '2012-10-17', Statement: [] };
  for (const scen of [
    { policyAbsent: ['cba-study-coach-cfn-exec-release-dev'] },
    { policyDocs: { 'cba-study-coach-boundary-runtime-dev': divergent } },
  ]) {
    const r = run('bootstrap', { ...scen, stackExists: false });
    assert.notEqual(r.code, 0);
    assert.deepEqual(r.mutations, [], 'zero mutation');
    assert.ok(!r.npxCalls.some((c) => c.includes('bootstrap') && !c.includes('--version')), 'no cdk bootstrap reached');
  }
});

test('EXECUTED bootstrap divergence surfaces on the REENTRANT path — each refuses with zero mutation', () => {
  const cases = [
    [{ termProt: false }, /termination protection is not enabled/],
    [{ stackStatus: 'UPDATE_ROLLBACK_COMPLETE' }, /not in a terminal COMPLETE state/],
    [{ stackRoleArn: `arn:aws:iam::${ACCOUNT}:role/svc` }, /unexpected service role/],
    [{ storedTemplate: 'Resources: {}\n' }, /stored template diverges/],
    [{ resourceStatus: 'UPDATE_IN_PROGRESS' }, /not in a COMPLETE state/],
    [{ extraResource: true }, /resource set diverges/],
    [{ execAttached: [{ PolicyName: 'AdministratorAccess', PolicyArn: 'arn:aws:iam::aws:policy/AdministratorAccess' }] }, /not exactly the reviewed release policy/],
    [{ entitiesRoles: [{ RoleName: `cdk-cbardev-cfn-exec-role-${ACCOUNT}-us-east-1` }, { RoleName: 'intruder' }] }, /attached beyond the expected execution role/],
    [{ ssmAbsent: true }, /version is absent/],
    [{ pabOff: true }, /public access block is not fully enabled/],
    [{ ecrMutable: true }, /tag mutability or scanning/],
    [{ stackPolicy: true }, /unexpected stack policy/],
  ];
  for (const [scen, re] of cases) {
    const r = run('bootstrap', scen);
    assert.notEqual(r.code, 0, JSON.stringify(scen));
    assert.match(r.out, re, JSON.stringify(scen));
    assert.deepEqual(r.mutations, [], `${JSON.stringify(scen)}: zero mutation`);
  }
});

test('EXECUTED bootstrap failure: read-only reconciliation, no retry', () => {
  const r = run('bootstrap', { stackExists: false, bootstrapRc: 1 });
  assert.notEqual(r.code, 0);
  assert.match(r.out, /read-only reconciliation follows; no retry/);
  assert.equal(r.mutations.filter((m) => m.startsWith('cdk-bootstrap')).length, 1, 'exactly one attempt');
  assert.ok(!r.out.includes(ACCOUNT), 'reconciliation output is masked');
});

test('EXECUTED bootstrap pagination: a truncated resource listing proves nothing — refuses', () => {
  const r = run('bootstrap', { resourcesNextToken: true });
  assert.notEqual(r.code, 0);
  assert.match(r.out, /paginated\/truncated/);
  assert.deepEqual(r.mutations, []);
});

/* ═══════════ common bindings ═══════════ */

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
    ['bootstrap', { cdkVersion: '1.0.0 (build old)' }, /does not match the lockfile/],
  ];
  for (const [phase, scen, re] of cases) {
    const r = run(phase, scen);
    assert.notEqual(r.code, 0, JSON.stringify(scen));
    assert.match(r.out, re, JSON.stringify(scen));
    assert.deepEqual(r.mutations, [], `${JSON.stringify(scen)}: zero mutation`);
    assert.ok(!r.out.includes('999988887777') && !r.out.includes(ACCOUNT), 'no account echoed');
  }
});

test('EXECUTED observation errors are NEVER absence: IAM and CloudFormation refuse with zero mutation', () => {
  const cases = [
    ['policies', { policyErr: { 'cba-study-coach-boundary-gha-deploy-dev': 'An error occurred (AccessDenied)' } }],
    ['policies', { policyErr: { 'cba-study-coach-cfn-exec-release-dev': 'Read timeout on endpoint URL' } }],
    ['bootstrap', { stackErr: 'An error occurred (AccessDenied) when calling DescribeStacks' }],
  ];
  for (const [phase, scen] of cases) {
    const r = run(phase, scen);
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
