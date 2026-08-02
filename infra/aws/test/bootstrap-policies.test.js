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
const DEPLOY_BOUNDARY_ARN =
  'arn:aws:iam::ACCOUNT_ID_PLACEHOLDER:policy/cba-study-coach-boundary-gha-deploy';
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
    'arn:aws:bedrock:us-east-1:ACCOUNT_ID_PLACEHOLDER:inference-profile/us.amazon.nova-pro-v1:0',
    'arn:aws:bedrock:us-east-1::foundation-model/amazon.nova-pro-v1:0',
    'arn:aws:bedrock:us-east-2::foundation-model/amazon.nova-pro-v1:0',
    'arn:aws:bedrock:us-west-2::foundation-model/amazon.nova-pro-v1:0',
  ]);
});

test('exec policy: CreateRole requires the exact iam:PermissionsBoundary and the exact role', () => {
  // Two grants, each pinned name-to-boundary: the bedrock-refresh role to ITS boundary, the two
  // GitHub deploy roles (#70 Slice B1) to the deploy boundary. No unpinned CreateRole exists.
  const createRole = execPolicy.Statement.filter(
    (s) => s.Effect === 'Allow' && asArray(s.Action).includes('iam:CreateRole'),
  );
  assert.equal(createRole.length, 2, 'exactly two CreateRole grants — refresh and gha-deploy');
  const refresh = createRole.find((s) => asArray(s.Resource).includes(ROLE_ARN));
  assert.deepEqual(asArray(refresh.Resource), [ROLE_ARN]);
  assert.equal(refresh.Condition?.StringEquals?.['iam:PermissionsBoundary'], BOUNDARY_ARN);
  const deploy = createRole.find((s) => s !== refresh);
  assert.deepEqual(asArray(deploy.Resource), DEPLOY_ROLE_ARNS);
  assert.equal(deploy.Condition?.StringEquals?.['iam:PermissionsBoundary'], DEPLOY_BOUNDARY_ARN);
});

test('deploy boundary allows only sts:AssumeRole on exactly the three CDK bootstrap roles', () => {
  assert.equal(deployBoundary.Statement.length, 1, 'a single boundary statement');
  const [stmt] = deployBoundary.Statement;
  assert.equal(stmt.Effect, 'Allow');
  assert.deepEqual(asArray(stmt.Action), ['sts:AssumeRole']);
  assert.deepEqual(stmt.Resource, [
    'arn:aws:iam::ACCOUNT_ID_PLACEHOLDER:role/cdk-cbarel-deploy-role-ACCOUNT_ID_PLACEHOLDER-us-east-1',
    'arn:aws:iam::ACCOUNT_ID_PLACEHOLDER:role/cdk-cbarel-file-publishing-role-ACCOUNT_ID_PLACEHOLDER-us-east-1',
    'arn:aws:iam::ACCOUNT_ID_PLACEHOLDER:role/cdk-cbarel-lookup-role-ACCOUNT_ID_PLACEHOLDER-us-east-1',
  ]);
  // No image-publishing (no container assets) and never the CloudFormation execution role.
  const flat = JSON.stringify(deployBoundary);
  assert.ok(!flat.includes('image-publishing'), 'no container-asset authority');
  assert.ok(!flat.includes('cfn-exec'), 'the exec role is assumed by CloudFormation, never by GitHub');
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
  assert.deepEqual(asArray(policyDeny.Resource), [BOUNDARY_ARN, DEPLOY_BOUNDARY_ARN]);
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
