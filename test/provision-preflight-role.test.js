// EXECUTED proofs for scripts/provision-preflight-role.sh (#111 round 3, Codex F1): the
// provisioner runs against a fake `aws` that serves scenario state and RECORDS every mutating
// call — widened trust, divergent policy, extra managed policy, absent/divergent boundary and a
// contaminated pre-existing role must each refuse with ZERO mutation; the positive paths must
// mutate exactly what they claim.
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
const TRUST = render('preflight-role-trust.template.json');
const POLICY = render('preflight-role-policy.template.json');
const BOUNDARY = render('preflight-role-boundary.template.json');

function run(scen = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cba-prov-'));
  const mut = path.join(dir, 'mutations');
  fs.writeFileSync(mut, '');
  const S = {
    boundaryExists: true, boundaryDoc: BOUNDARY,
    roleExists: false, trustDoc: TRUST, roleBoundary: BOUNDARY_ARN,
    inlineNames: ['cba-study-coach-preflight-readonly-dev'], inlineDoc: POLICY, attached: [],
    ...scen,
  };
  const fixture = path.join(dir, 'state.json');
  fs.writeFileSync(fixture, JSON.stringify(S));
  fs.writeFileSync(path.join(dir, 'aws'), `#!/usr/bin/env bash
STATE='${fixture}'
q() { node -e 'const s=require(process.argv[1]); console.log(JSON.stringify(eval("s."+process.argv[2])))' "$STATE" "$1"; }
sub="$1 $2"
args="$*"
case "$sub" in
  "sts get-caller-identity") echo '${ACCOUNT}'; exit 0 ;;
  "iam get-policy") [ "$(q boundaryExists)" = "true" ] && { echo v1; exit 0; } || exit 254 ;;
  "iam get-policy-version") q boundaryDoc | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>process.stdout.write(JSON.parse(d)))'; exit 0 ;;
  "iam create-policy") echo create-policy >> '${mut}'; exit 0 ;;
  "iam get-role")
    [ "$(q roleExists)" = "true" ] || exit 254
    case "$args" in
      *AssumeRolePolicyDocument*) q trustDoc | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>process.stdout.write(JSON.parse(d)))' ;;
      *PermissionsBoundaryArn*) q roleBoundary | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const v=JSON.parse(d);process.stdout.write(v===null?"None":v)})' ;;
      *Role.Arn*) echo "arn:aws:iam::${ACCOUNT}:role/cba-study-coach-gha-release-preflight-dev" ;;
      *) echo '{}' ;;
    esac; exit 0 ;;
  "iam create-role") echo create-role >> '${mut}'; node -e 'const s=require("${fixture}");s.roleExists=true;require("fs").writeFileSync("${fixture}",JSON.stringify(s))'; exit 0 ;;
  "iam put-role-policy") echo put-role-policy >> '${mut}'; exit 0 ;;
  "iam list-attached-role-policies") q attached; exit 0 ;;
  "iam list-role-policies") q inlineNames; exit 0 ;;
  "iam get-role-policy") q inlineDoc | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>process.stdout.write(JSON.parse(d)))'; exit 0 ;;
esac
echo "unexpected aws $args" >&2; exit 90
`, { mode: 0o755 });
  let out = ''; let code = 0;
  try { out = execFileSync('bash', [SCRIPT, 'dev'], { encoding: 'utf8', env: { PATH: `${dir}:${process.env.PATH}` } }); }
  catch (e) { out = `${e.stdout ?? ''}${e.stderr ?? ''}`; code = e.status ?? 1; }
  const mutations = fs.readFileSync(mut, 'utf8').split('\n').filter(Boolean);
  fs.rmSync(dir, { recursive: true, force: true });
  return { out, code, mutations };
}

test('EXECUTED positive: fresh account — boundary + role created, one put, full read-back, masked ARN', () => {
  const r = run({ boundaryExists: false, roleExists: false });
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(r.mutations, ['create-policy', 'create-role', 'put-role-policy']);
  assert.match(r.out, /READ-BACK OK/);
  assert.ok(!r.out.includes(ACCOUNT), 'the account id never prints');
});

test('EXECUTED positive: clean pre-existing role — validated BEFORE the only put', () => {
  const r = run({ roleExists: true });
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(r.mutations, ['put-role-policy'], 'no create; the put happens only after validation');
});

test('EXECUTED adversarial: widened trust, divergent policy, extra managed, absent/divergent boundary — each refuses with ZERO mutation', () => {
  const widenedTrust = JSON.stringify({ ...JSON.parse(TRUST), Statement: [{ ...JSON.parse(TRUST).Statement[0], Condition: { StringEquals: { 'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com', 'token.actions.githubusercontent.com:sub': 'repo:someone/else:*' } } }] });
  const divergentPolicy = JSON.stringify({ ...JSON.parse(POLICY), Statement: [{ ...JSON.parse(POLICY).Statement[0], Action: ['cognito-idp:DescribeUserPoolDomain', 'cognito-idp:DeleteUserPool'] }] });
  const cases = [
    [{ roleExists: true, trustDoc: widenedTrust }, /trust diverges/, 'widened trust'],
    [{ roleExists: true, inlineDoc: divergentPolicy }, /inline policy diverges/, 'divergent inline policy'],
    [{ roleExists: true, attached: [{ PolicyName: 'AdministratorAccess' }] }, /managed policies are attached/, 'extra managed policy'],
    [{ roleExists: true, roleBoundary: null }, /boundary is absent or diverges/, 'absent boundary'],
    [{ roleExists: true, roleBoundary: `arn:aws:iam::${ACCOUNT}:policy/other` }, /boundary is absent or diverges/, 'divergent boundary'],
    [{ boundaryExists: true, boundaryDoc: JSON.stringify({ Version: '2012-10-17', Statement: [] }) }, /existing boundary diverges/, 'divergent boundary POLICY'],
    [{ roleExists: true, inlineNames: ['cba-study-coach-preflight-readonly-dev', 'extra'] }, /unexpected inline policies/, 'extra inline policy'],
  ];
  for (const [scen, re, label] of cases) {
    const r = run(scen);
    assert.notEqual(r.code, 0, label);
    assert.match(r.out, re, label);
    assert.deepEqual(r.mutations, [], `${label}: ZERO mutation`);
  }
});
