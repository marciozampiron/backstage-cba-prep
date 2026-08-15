// Guards for the versioned bootstrap policy templates (#66 mutation gate):
// the operator-managed permissions boundary and the scoped CloudFormation execution policy.
// These JSONs are the source the runbook renders (ACCOUNT_ID_PLACEHOLDER -> STS account) to /tmp;
// the rendered copies never enter Git.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const POLICIES_DIR = join(__dirname, '..', 'bootstrap', 'policies');
const boundary = JSON.parse(
  readFileSync(join(POLICIES_DIR, 'bedrock-refresh-boundary.template.json'), 'utf8'),
);
const execPolicy = JSON.parse(
  readFileSync(join(POLICIES_DIR, 'cfn-exec-security.template.json'), 'utf8'),
);
const deployBoundary = JSON.parse(
  readFileSync(join(POLICIES_DIR, 'gha-deploy-boundary.template.json'), 'utf8'),
);

const BOUNDARY_ARN =
  'arn:aws:iam::ACCOUNT_ID_PLACEHOLDER:policy/cba-study-coach-pilot-boundary-bedrock-refresh';
const ROLE_ARN =
  'arn:aws:iam::ACCOUNT_ID_PLACEHOLDER:role/cba-study-coach-gha-bedrock-refresh';
const DEPLOY_BOUNDARY_ARNS = {
  dev: 'arn:aws:iam::ACCOUNT_ID_PLACEHOLDER:policy/cba-study-coach-boundary-gha-deploy-dev',
  pilot: 'arn:aws:iam::ACCOUNT_ID_PLACEHOLDER:policy/cba-study-coach-boundary-gha-deploy-pilot',
};
const DEPLOY_ROLE_ARNS = [
  'arn:aws:iam::ACCOUNT_ID_PLACEHOLDER:role/cba-study-coach-gha-deploy-dev',
  'arn:aws:iam::ACCOUNT_ID_PLACEHOLDER:role/cba-study-coach-gha-deploy-pilot',
];

const asArray = (v) => (Array.isArray(v) ? v : [v]);

test('all three policies pin the 2012-10-17 policy language version', () => {
  assert.equal(boundary.Version, '2012-10-17');
  assert.equal(execPolicy.Version, '2012-10-17');
  assert.equal(deployBoundary.Version, '2012-10-17');
});

test('boundary allows only bedrock:InvokeModel and nothing else', () => {
  assert.equal(boundary.Statement.length, 1, 'a single boundary statement');
  const [stmt] = boundary.Statement;
  assert.equal(stmt.Effect, 'Allow');
  assert.deepEqual(asArray(stmt.Action), ['bedrock:InvokeModel']);
});

test('boundary resources = standard inference profile + the 3 routed model ARNs', () => {
  const [stmt] = boundary.Statement;
  assert.deepEqual(stmt.Resource, [
    'arn:aws:bedrock:us-east-1:ACCOUNT_ID_PLACEHOLDER:inference-profile/us.anthropic.claude-sonnet-5',
    'arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-sonnet-5',
    'arn:aws:bedrock:us-east-2::foundation-model/anthropic.claude-sonnet-5',
    'arn:aws:bedrock:us-west-2::foundation-model/anthropic.claude-sonnet-5',
  ]);
});

test('exec policy: CreateRole requires the exact iam:PermissionsBoundary and the exact role', () => {
  // Three grants, each pinned name-to-boundary: the bedrock-refresh role to ITS boundary, and
  // EACH GitHub deploy role to ITS TIER'S boundary (round 4: per-environment isolation). No
  // unpinned CreateRole exists, and no statement can create the other tier's role.
  const createRole = execPolicy.Statement.filter(
    (s) => s.Effect === 'Allow' && asArray(s.Action).includes('iam:CreateRole'),
  );
  assert.equal(createRole.length, 3, 'exactly three CreateRole grants — refresh, gha-deploy-dev, gha-deploy-pilot');
  const refresh = createRole.find((s) => asArray(s.Resource).includes(ROLE_ARN));
  assert.deepEqual(asArray(refresh.Resource), [ROLE_ARN]);
  assert.equal(refresh.Condition?.StringEquals?.['iam:PermissionsBoundary'], BOUNDARY_ARN);
  for (const env of ['dev', 'pilot']) {
    const stmt = createRole.find((s) => asArray(s.Resource).some((r) => r.endsWith(`gha-deploy-${env}`)));
    assert.ok(stmt, `the ${env} CreateRole grant must exist`);
    assert.deepEqual(asArray(stmt.Resource), [`arn:aws:iam::ACCOUNT_ID_PLACEHOLDER:role/cba-study-coach-gha-deploy-${env}`]);
    assert.equal(stmt.Condition?.StringEquals?.['iam:PermissionsBoundary'], DEPLOY_BOUNDARY_ARNS[env], `${env} role pins to the ${env} boundary — never the other tier's`);
  }
});

test('deploy boundary allows only sts:AssumeRole on exactly ONE TIER\'s three CDK bootstrap roles', () => {
  assert.equal(deployBoundary.Statement.length, 1, 'a single boundary statement');
  const [stmt] = deployBoundary.Statement;
  assert.equal(stmt.Effect, 'Allow');
  assert.deepEqual(asArray(stmt.Action), ['sts:AssumeRole']);
  // The template renders per environment (QUALIFIER_PLACEHOLDER -> cbardev | cbarpil), so ONE
  // rendered boundary reaches ONE tier's bootstrap — dev authority cannot execute pilot.
  assert.deepEqual(stmt.Resource, [
    'arn:aws:iam::ACCOUNT_ID_PLACEHOLDER:role/cdk-QUALIFIER_PLACEHOLDER-deploy-role-ACCOUNT_ID_PLACEHOLDER-us-east-1',
    'arn:aws:iam::ACCOUNT_ID_PLACEHOLDER:role/cdk-QUALIFIER_PLACEHOLDER-file-publishing-role-ACCOUNT_ID_PLACEHOLDER-us-east-1',
    'arn:aws:iam::ACCOUNT_ID_PLACEHOLDER:role/cdk-QUALIFIER_PLACEHOLDER-lookup-role-ACCOUNT_ID_PLACEHOLDER-us-east-1',
  ]);
  for (const [env, qualifier] of [['dev', 'cbardev'], ['pilot', 'cbarpil']]) {
    const rendered = JSON.stringify(deployBoundary).replaceAll('QUALIFIER_PLACEHOLDER', qualifier);
    assert.ok(rendered.includes(`cdk-${qualifier}-deploy-role`), `${env} rendering reaches its own bootstrap`);
    assert.equal(rendered.includes('QUALIFIER_PLACEHOLDER'), false, 'every placeholder renders');
  }
  // No image-publishing (no container assets), never the CloudFormation execution role, and
  // never the #66 foundation bootstrap.
  const flat = JSON.stringify(deployBoundary);
  assert.ok(!flat.includes('image-publishing'), 'no container-asset authority');
  assert.ok(!flat.includes('cfn-exec'), 'the exec role is assumed by CloudFormation, never by GitHub');
  assert.ok(!flat.includes('hnb659fds'), 'the foundation bootstrap is unreachable from the release chain');
});

test('exec policy: gha-deploy role lifecycle is confined to exactly the two deploy roles', () => {
  const lifecycle = execPolicy.Statement.find((s) => s.Sid === 'GhaDeployRoleLifecycleExactRolesOnly');
  assert.ok(lifecycle, 'the lifecycle statement must exist');
  assert.equal(lifecycle.Effect, 'Allow');
  assert.deepEqual(asArray(lifecycle.Resource), DEPLOY_ROLE_ARNS);
  assert.ok(!asArray(lifecycle.Action).includes('iam:CreateRole'), 'creation stays in the boundary-pinned statement');
});

test('exec policy: boundary tampering stays explicitDeny', () => {
  const denies = execPolicy.Statement.filter((s) => s.Effect === 'Deny');
  const denied = denies.flatMap((s) => asArray(s.Action));
  for (const action of [
    'iam:DeleteRolePermissionsBoundary',
    'iam:PutRolePermissionsBoundary',
    'iam:CreatePolicyVersion',
    'iam:DeletePolicy',
    'iam:DeletePolicyVersion',
    'iam:SetDefaultPolicyVersion',
  ]) {
    assert.ok(denied.includes(action), `${action} must be explicitly denied`);
  }
  const roleDeny = denies.find((s) =>
    asArray(s.Action).includes('iam:DeleteRolePermissionsBoundary'),
  );
  assert.deepEqual(asArray(roleDeny.Resource), [ROLE_ARN, ...DEPLOY_ROLE_ARNS]);
  const policyDeny = denies.find((s) => asArray(s.Action).includes('iam:DeletePolicy'));
  assert.deepEqual(asArray(policyDeny.Resource), [BOUNDARY_ARN, DEPLOY_BOUNDARY_ARNS.dev, DEPLOY_BOUNDARY_ARNS.pilot]);
});

test('exec policy Allow statements carry no PassRole, lambda, logs, s3, or bedrock actions', () => {
  const allowed = execPolicy.Statement.filter((s) => s.Effect === 'Allow').flatMap((s) =>
    asArray(s.Action),
  );
  for (const action of allowed) {
    assert.ok(!/^iam:PassRole$/i.test(action), 'iam:PassRole is banned');
    assert.ok(!/^(lambda|logs|s3|bedrock):/i.test(action), `${action} service is banned`);
  }
});

test('exec policy: SSM access is exactly GetParameters on the CDK bootstrap-version parameter', () => {
  const ssmStatements = execPolicy.Statement.filter((s) =>
    asArray(s.Action).some((a) => a.toLowerCase().startsWith('ssm:')),
  );
  assert.equal(ssmStatements.length, 1, 'exactly one SSM statement');
  const [stmt] = ssmStatements;
  assert.equal(stmt.Effect, 'Allow');
  assert.deepEqual(asArray(stmt.Action), ['ssm:GetParameters'], 'only ssm:GetParameters');
  assert.deepEqual(asArray(stmt.Resource), [
    'arn:aws:ssm:us-east-1:ACCOUNT_ID_PLACEHOLDER:parameter/cdk-bootstrap/hnb659fds/version',
  ]);
  // No SSM action or ssm parameter ARN may appear anywhere else in either policy.
  const boundaryFlat = JSON.stringify(boundary);
  assert.ok(!/ssm:/i.test(boundaryFlat), 'boundary must carry no SSM access');
  const otherExec = execPolicy.Statement.filter((s) => s !== stmt);
  assert.ok(
    !/ssm/i.test(JSON.stringify(otherExec)),
    'no other exec statement may reference SSM',
  );
});

test('no wildcard anywhere in actions or resources of any policy', () => {
  for (const [name, doc] of [['boundary', boundary], ['exec', execPolicy], ['deploy-boundary', deployBoundary]]) {
    for (const stmt of doc.Statement) {
      for (const action of asArray(stmt.Action)) {
        assert.ok(!action.includes('*'), `${name}: wildcard in action "${action}" is banned`);
      }
      for (const resource of asArray(stmt.Resource)) {
        assert.ok(!resource.includes('*'), `${name}: wildcard in resource "${resource}" is banned`);
      }
    }
  }
});

test('no real 12-digit account id in the versioned templates', () => {
  for (const file of [
    'bedrock-refresh-boundary.template.json',
    'cfn-exec-security.template.json',
    'gha-deploy-boundary.template.json',
  ]) {
    const raw = readFileSync(join(POLICIES_DIR, file), 'utf8');
    assert.ok(!/\b\d{12}\b/.test(raw), `${file}: only ACCOUNT_ID_PLACEHOLDER allowed`);
    assert.ok(raw.includes('ACCOUNT_ID_PLACEHOLDER'), `${file}: placeholder expected`);
  }
});
