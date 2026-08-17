// EXECUTED proofs for scripts/provision-preflight-role.sh (#111 round 4): observe-then-act.
// The fake aws serves full-JSON observations, distinguishes proven NoSuchEntity from injected
// transport/authorization errors, and RECORDS every mutating call. Account binding, the
// composite contamination and every observation failure must refuse with ZERO mutation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(ROOT, 'scripts/provision-preflight-role.sh');
const ACCOUNT = '111122223333';
const BOUNDARY_ARN = `arn:aws:iam::${ACCOUNT}:policy/cba-study-coach-boundary-preflight-dev`;
const render = (f) => fs.readFileSync(path.join(ROOT, 'infra/aws/bootstrap/policies', f), 'utf8')
  .replaceAll('ACCOUNT_ID_PLACEHOLDER', ACCOUNT).replaceAll('ENVIRONMENT_PLACEHOLDER', 'dev');
const TRUST = JSON.parse(render('preflight-role-trust.template.json'));
const POLICY = JSON.parse(render('preflight-role-policy.template.json'));
const BOUNDARY = JSON.parse(render('preflight-role-boundary.template.json'));

function run(scen = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cba-prov-'));
  const mut = path.join(dir, 'mutations');
  fs.writeFileSync(mut, '');
  const S = {
    stsOut: ACCOUNT, stsErr: '',
    boundaryExists: true, boundaryDoc: BOUNDARY, boundaryErr: '',
    roleExists: false, roleErr: '',
    trustDoc: TRUST, roleBoundary: BOUNDARY_ARN,
    inlineNames: [], inlineDoc: POLICY, attached: [], putNoop: false,
    expectedEnv: ACCOUNT,
    ...scen,
  };
  const fixture = path.join(dir, 'state.json');
  fs.writeFileSync(fixture, JSON.stringify(S));
  fs.writeFileSync(path.join(dir, 'aws'), `#!/usr/bin/env node
const fs = require('fs');
const S = JSON.parse(fs.readFileSync('${fixture}', 'utf8'));
const a = process.argv.slice(2);
const sub = a[0] + ' ' + a[1];
const mut = (x) => fs.appendFileSync('${mut}', x + '\\n');
const die = (msg) => { process.stderr.write(msg + '\\n'); process.exit(254); };
const roleJson = () => JSON.stringify({ Role: { Arn: 'arn:aws:iam::${ACCOUNT}:role/cba-study-coach-gha-release-preflight-dev', AssumeRolePolicyDocument: S.trustDoc, ...(S.roleBoundary ? { PermissionsBoundary: { PermissionsBoundaryArn: S.roleBoundary } } : {}) } });
switch (sub) {
  case 'sts get-caller-identity': if (S.stsErr) die(S.stsErr); process.stdout.write(S.stsOut); break;
  case 'iam get-policy': if (S.boundaryErr) die(S.boundaryErr); if (!S.boundaryExists) die('An error occurred (NoSuchEntity)'); process.stdout.write(JSON.stringify({ Policy: { DefaultVersionId: 'v1' } })); break;
  case 'iam get-policy-version': process.stdout.write(JSON.stringify({ PolicyVersion: { Document: S.boundaryDoc } })); break;
  case 'iam create-policy': mut('create-policy'); break;
  case 'iam get-role': if (S.roleErr) die(S.roleErr); if (!S.roleExists) die('An error occurred (NoSuchEntity)'); process.stdout.write(roleJson()); break;
  case 'iam create-role': mut('create-role'); S.roleExists = true; fs.writeFileSync('${fixture}', JSON.stringify(S)); break;
  case 'iam put-role-policy': mut('put-role-policy'); if (!S.putNoop) { S.inlineNames = ['cba-study-coach-preflight-readonly-dev']; fs.writeFileSync('${fixture}', JSON.stringify(S)); } break;
  case 'iam list-attached-role-policies': process.stdout.write(JSON.stringify({ AttachedPolicies: S.attached })); break;
  case 'iam list-role-policies': process.stdout.write(JSON.stringify({ PolicyNames: S.inlineNames })); break;
  case 'iam get-role-policy': process.stdout.write(JSON.stringify({ PolicyDocument: S.inlineDoc })); break;
  default: die('unexpected aws ' + a.join(' '));
}
`, { mode: 0o755 });
  let out = ''; let code = 0;
  try {
    out = execFileSync('bash', [SCRIPT, 'dev'], {
      encoding: 'utf8',
      env: { PATH: `${dir}:${process.env.PATH}`, ...(S.expectedEnv !== null ? { CBA_EXPECTED_ACCOUNT_ID: S.expectedEnv } : {}) },
    });
  } catch (e) { out = `${e.stdout ?? ''}${e.stderr ?? ''}`; code = e.status ?? 1; }
  const mutations = fs.readFileSync(mut, 'utf8').split('\n').filter(Boolean);
  fs.rmSync(dir, { recursive: true, force: true });
  return { out, code, mutations };
}

test('EXECUTED positive: fresh account — boundary + role created, one put, full read-back, masked', () => {
  const r = run({ boundaryExists: false, roleExists: false });
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(r.mutations, ['create-policy', 'create-role', 'put-role-policy']);
  assert.match(r.out, /READ-BACK OK/);
  assert.ok(!r.out.includes(ACCOUNT), 'no account value prints');
  // Round 5 (F2): the validated ARN travels as exact bytes — no fresh AWS read in the command.
  const arnFile = r.out.match(/gravado \(0600, bytes exatos do read-back\): (\S+)/)?.[1];
  assert.ok(arnFile && fs.existsSync(arnFile), 'the ARN file exists');
  assert.equal(fs.statSync(arnFile).mode & 0o777, 0o600, 'mode 0600');
  assert.equal(fs.readFileSync(arnFile, 'utf8'), `arn:aws:iam::${ACCOUNT}:role/cba-study-coach-gha-release-preflight-dev`, 'exact validated bytes');
  assert.match(r.out, new RegExp(`cat ${arnFile.replace(/[.*+?^$()[\]{}|\\]/g, '\\$&')}`), 'the install command consumes the file bytes');
  assert.ok(!/gh secret set[^\n]*aws iam get-role/.test(r.out), 'no independent AWS re-read in the install command');
  fs.rmSync(arnFile, { force: true });
});

test('EXECUTED positive: clean pre-existing role — fully validated BEFORE the only put', () => {
  const r = run({ roleExists: true, inlineNames: ['cba-study-coach-preflight-readonly-dev'] });
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(r.mutations, ['put-role-policy']);
});

test('EXECUTED (round 4): the COMPOSITE — boundary absent + contaminated pre-existing role — refuses with ZERO mutation', () => {
  const widened = { ...TRUST, Statement: [{ ...TRUST.Statement[0], Condition: { StringEquals: { 'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com', 'token.actions.githubusercontent.com:sub': 'repo:someone/else:*' } } }] };
  const cases = [
    [{ boundaryExists: false, roleExists: true, trustDoc: widened }, /trust diverges/, 'boundary absent + widened trust'],
    [{ boundaryExists: false, roleExists: true, roleBoundary: null }, /boundary is absent or diverges/, 'boundary absent + role without boundary'],
    [{ boundaryExists: false, roleExists: true }, /boundary policy does not|boundary is absent/, 'boundary absent + role otherwise clean'],
  ];
  for (const [scen, re, label] of cases) {
    const r = run(scen);
    assert.notEqual(r.code, 0, label);
    assert.match(r.out, re, label);
    assert.deepEqual(r.mutations, [], `${label}: ZERO mutation — no create-policy before the role validates`);
  }
});

test('EXECUTED (round 4): account binding — divergent, missing, malformed STS — ZERO IAM calls, nothing echoed', () => {
  const cases = [
    [{ expectedEnv: '999988887777' }, /do not belong to the authorized account/, 'divergent account'],
    [{ expectedEnv: null }, /CBA_EXPECTED_ACCOUNT_ID is required/, 'missing expected id'],
    [{ expectedEnv: '12345' }, /CBA_EXPECTED_ACCOUNT_ID is required/, 'malformed expected id'],
    [{ stsOut: 'not-a-number' }, /STS account is malformed/, 'malformed STS output'],
    [{ stsErr: 'AccessDenied' }, /STS identity observation failed/, 'STS failure'],
  ];
  for (const [scen, re, label] of cases) {
    const r = run(scen);
    assert.notEqual(r.code, 0, label);
    assert.match(r.out, re, label);
    assert.deepEqual(r.mutations, [], `${label}: zero mutation`);
    assert.ok(!r.out.includes('999988887777') && !r.out.includes(ACCOUNT), `${label}: no account value echoed`);
  }
});

test('EXECUTED (round 4): observation errors are NEVER absence — AccessDenied/timeout/generic refuse with ZERO mutation', () => {
  const cases = [
    [{ roleErr: 'An error occurred (AccessDenied) when calling GetRole' }, 'AccessDenied on get-role'],
    [{ roleErr: 'Read timeout on endpoint URL' }, 'timeout on get-role'],
    [{ boundaryErr: 'An error occurred (AccessDenied) when calling GetPolicy' }, 'AccessDenied on get-policy'],
    [{ boundaryErr: 'ServiceUnavailable' }, 'generic error on get-policy'],
  ];
  for (const [scen, label] of cases) {
    const r = run(scen);
    assert.notEqual(r.code, 0, label);
    assert.match(r.out, /observation of .* failed \(not a proven absence\)/, label);
    assert.deepEqual(r.mutations, [], `${label}: zero mutation`);
  }
});

test('EXECUTED adversarial (kept from round 3): every single-surface divergence refuses with ZERO mutation', () => {
  const widened = { ...TRUST, Statement: [{ ...TRUST.Statement[0], Action: 'sts:AssumeRole' }] };
  const divergentPolicy = { ...POLICY, Statement: [{ ...POLICY.Statement[0], Action: ['cognito-idp:DescribeUserPoolDomain', 'cognito-idp:DeleteUserPool'] }] };
  const cases = [
    [{ roleExists: true, trustDoc: widened }, /trust diverges/],
    [{ roleExists: true, inlineNames: ['cba-study-coach-preflight-readonly-dev'], inlineDoc: divergentPolicy }, /inline policy diverges/],
    [{ roleExists: true, attached: [{ PolicyName: 'AdministratorAccess' }] }, /managed policies are attached/],
    [{ roleExists: true, roleBoundary: `arn:aws:iam::${ACCOUNT}:policy/other` }, /boundary is absent or diverges/],
    [{ roleExists: true, inlineNames: ['cba-study-coach-preflight-readonly-dev', 'extra'] }, /unexpected inline policies/],
    [{ boundaryDoc: { Version: '2012-10-17', Statement: [] } }, /existing boundary diverges/],
  ];
  for (const [scen, re] of cases) {
    const r = run(scen);
    assert.notEqual(r.code, 0);
    assert.match(r.out, re);
    assert.deepEqual(r.mutations, []);
  }
});


test('EXECUTED (round 5): a put that reports success but materializes NOTHING refuses — never READ-BACK OK', () => {
  const r = run({ boundaryExists: false, roleExists: false, putNoop: true });
  assert.notEqual(r.code, 0);
  assert.match(r.out, /put reported success but the inline policy is NOT present/);
  assert.ok(!/READ-BACK OK/.test(r.out), 'a hollow put never reads back OK');
});


test('EXECUTED (charset): every AWS-bound string in the script satisfies the IAM Latin-1 description charset', () => {
  // The first live run refused: the description carried an em-dash (U+2014), outside IAM
  // description charset [\t\n\r\x20-\x7E\xA1-\xFF]. The --description literal must stay inside it.
  const script = fs.readFileSync(SCRIPT, 'utf8');
  const desc = script.match(/--description "([^"]+)"/)?.[1];
  assert.ok(desc, 'the description literal exists');
  assert.match(desc, /^[\t\n\r\x20-\x7E\xA1-\xFF$\{\}A-Za-z_]*$/, 'description is IAM-charset-safe');
  assert.ok(!/[\u2010-\u2015\u2018-\u201F]/.test(desc), 'no unicode dashes or quotes in the description');
});
