// Synth-time guarantees for the SecurityStack (#66 architecture gate):
// native OIDC provider only, permissions boundary attached, zero custom-resource plumbing,
// and bedrock:InvokeModel scoped to exactly the expected resources.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { App } = require('aws-cdk-lib');
const { Template } = require('aws-cdk-lib/assertions');
const { SecurityStack } = require('../lib/security-stack');

function synthTemplate(context = {}) {
  const app = new App({ context });
  const stack = new SecurityStack(app, 'SecurityStack', {
    stackName: 'cba-study-coach-pilot-security',
  });
  return Template.fromStack(stack);
}

test('exactly one native AWS::IAM::OIDCProvider, with no ThumbprintList', () => {
  const template = synthTemplate();
  template.resourceCountIs('AWS::IAM::OIDCProvider', 1);
  const [provider] = Object.values(template.findResources('AWS::IAM::OIDCProvider'));
  assert.equal(provider.Properties.Url, 'https://token.actions.githubusercontent.com');
  assert.deepEqual(provider.Properties.ClientIdList, ['sts.amazonaws.com']);
  assert.equal(provider.Properties.ThumbprintList, undefined);
});

test('BedrockRefreshRole carries the operator-managed PermissionsBoundary', () => {
  const template = synthTemplate();
  const roles = template.findResources('AWS::IAM::Role');
  const role = Object.values(roles).find(
    (r) => r.Properties.RoleName === 'cba-study-coach-gha-bedrock-refresh',
  );
  assert.ok(role, 'refresh role must exist');
  const boundary = JSON.stringify(role.Properties.PermissionsBoundary);
  assert.ok(boundary, 'PermissionsBoundary must be set');
  assert.match(boundary, /cba-study-coach-pilot-boundary-bedrock-refresh/);
});

test('zero Lambda functions, zero Custom:: resources, zero plumbing roles', () => {
  const template = synthTemplate();
  template.resourceCountIs('AWS::Lambda::Function', 0);
  const resources = template.toJSON().Resources ?? {};
  const customTypes = Object.values(resources).filter((r) => r.Type.startsWith('Custom::'));
  assert.equal(customTypes.length, 0, 'no custom resources allowed');
  // The refresh role and the deploy role are the ONLY IAM roles — no custom-resource plumbing role.
  template.resourceCountIs('AWS::IAM::Role', 2);
});

test('bedrock:InvokeModel is granted only on the expected resources, and nothing else', () => {
  const template = synthTemplate();
  const policies = template.findResources('AWS::IAM::Policy');
  const statements = Object.values(policies).flatMap(
    (p) => p.Properties.PolicyDocument.Statement,
  );
  assert.equal(statements.length, 2, 'exactly two policy statements: the refresh grant and the deploy-role assumption');
  const stmt = statements.find((s) => s.Action === 'bedrock:InvokeModel');
  assert.ok(stmt, 'the bedrock grant must exist');
  assert.equal(stmt.Effect, 'Allow');
  const resources = stmt.Resource;
  assert.equal(resources.length, 4, 'inference profile + 3 routed model ARNs');
  const literal = resources.filter((r) => typeof r === 'string');
  assert.deepEqual(literal, [
    'arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-sonnet-5',
    'arn:aws:bedrock:us-east-2::foundation-model/anthropic.claude-sonnet-5',
    'arn:aws:bedrock:us-west-2::foundation-model/anthropic.claude-sonnet-5',
  ]);
  // No other bedrock action anywhere in the template; Converse never reappears (#66 guardrail).
  const flat = JSON.stringify(template.toJSON());
  assert.ok(!flat.includes('bedrock:Converse'), 'bedrock:Converse must not appear');
  assert.equal(flat.split('"bedrock:').length - 1, 1, 'only one bedrock action grant');
});

test('GithubDeployRole: environment-scoped trust, pinned boundary, and ONLY bootstrap-role assumption', () => {
  // The deployment authority (#70 Slice B1): published as the Environment secret
  // AWS_DEPLOY_ROLE_ARN. Trust is the GitHub ENVIRONMENT subject — a token minted outside the
  // protected Environment carries a different sub and cannot assume it.
  for (const [environment, context] of [['pilot', {}], ['dev', { environment: 'dev' }]]) {
    const template = synthTemplate(context);
    const role = Object.values(template.findResources('AWS::IAM::Role')).find(
      (r) => r.Properties.RoleName === `cba-study-coach-gha-deploy-${environment}`,
    );
    assert.ok(role, `deploy role for ${environment} must exist`);
    const trust = JSON.stringify(role.Properties.AssumeRolePolicyDocument);
    assert.ok(trust.includes('"sts:AssumeRoleWithWebIdentity"'), 'web-identity trust only');
    assert.ok(
      trust.includes(`repo:marciozampiron/backstage-cba-prep:environment:${environment}`),
      'the trust subject is the GitHub Environment, never a branch',
    );
    assert.ok(trust.includes('"token.actions.githubusercontent.com:aud":"sts.amazonaws.com"'));
    const boundary = JSON.stringify(role.Properties.PermissionsBoundary);
    assert.match(boundary, new RegExp(`cba-study-coach-boundary-gha-deploy-${environment}`), "THIS TIER'S deploy boundary is attached — never the other's");
  }

  // Least privilege is structural: the ONLY inline permission is assuming the three CDK
  // bootstrap roles — deploy, file-publishing, lookup. No image-publishing (this app builds no
  // container assets), no cfn-execution role, no direct service permission of any kind.
  const template = synthTemplate();
  const statements = Object.values(template.findResources('AWS::IAM::Policy')).flatMap(
    (p) => p.Properties.PolicyDocument.Statement,
  );
  const stmt = statements.find((s) => s.Action === 'sts:AssumeRole');
  assert.ok(stmt, 'the bootstrap-assumption statement must exist');
  assert.equal(stmt.Effect, 'Allow');
  const flatResources = JSON.stringify(stmt.Resource);
  for (const name of ['deploy', 'file-publishing', 'lookup']) {
    assert.ok(flatResources.includes(`cdk-cbarpil-${name}-role-`), `${name} bootstrap role expected (pilot tier)`);
  }
  assert.equal(stmt.Resource.length, 3, 'exactly the three bootstrap roles');
  assert.equal(flatResources.includes('image-publishing'), false, 'no container-asset authority');
  assert.equal(flatResources.includes('cfn-exec'), false, 'never the CloudFormation execution role directly');

  // Per-environment isolation (round 4): the dev role names ONLY the dev bootstrap.
  const devTemplate = synthTemplate({ environment: 'dev' });
  const devStmt = Object.values(devTemplate.findResources('AWS::IAM::Policy'))
    .flatMap((p) => p.Properties.PolicyDocument.Statement)
    .find((st) => st.Action === 'sts:AssumeRole');
  const devFlat = JSON.stringify(devStmt.Resource);
  assert.ok(devFlat.includes('cdk-cbardev-deploy-role-'), 'the dev tier assumes its own bootstrap');
  assert.equal(devFlat.includes('cbarpil'), false, 'dev authority must not reach the pilot bootstrap');
  assert.equal(flatResources.includes('cbardev'), false, 'pilot authority must not reach the dev bootstrap');
});

test('OVERPRIVILEGE CONTROL: the closed action set — no wildcard, no iam:, no admin-shaped grant anywhere', () => {
  // The adversarial form of the least-privilege claim: enumerate EVERY action in EVERY policy
  // statement of the synthesized template and refuse anything outside the closed set. A future
  // edit that slips iam:PassRole, s3:*, or AdministratorAccess into this stack fails here by
  // name, not by review luck.
  const ALLOWED_ACTIONS = ['bedrock:InvokeModel', 'sts:AssumeRole', 'sts:AssumeRoleWithWebIdentity'];
  for (const context of [{}, { environment: 'dev' }]) {
    const template = synthTemplate(context);
    const docs = [
      ...Object.values(template.findResources('AWS::IAM::Policy')).map((p) => p.Properties.PolicyDocument),
      ...Object.values(template.findResources('AWS::IAM::Role')).map((r) => r.Properties.AssumeRolePolicyDocument),
    ];
    const actions = docs.flatMap((d) => d.Statement).flatMap((s) => (Array.isArray(s.Action) ? s.Action : [s.Action]));
    assert.ok(actions.length >= 4, 'the enumeration must actually see the grants');
    for (const action of actions) {
      assert.ok(ALLOWED_ACTIONS.includes(action), `action "${action}" is outside the closed set`);
      assert.equal(action.includes('*'), false, `wildcard action "${action}" is banned`);
    }
    const flat = JSON.stringify(template.toJSON());
    assert.equal(flat.includes('AdministratorAccess'), false, 'no managed admin policy');
    assert.equal(flat.includes('"iam:'), false, 'no iam: action of any kind');
  }
});

test('trust policy binds the GitHub OIDC aud and branch-scoped sub', () => {
  const template = synthTemplate();
  const flat = JSON.stringify(template.toJSON());
  assert.ok(flat.includes('"token.actions.githubusercontent.com:aud":"sts.amazonaws.com"'));
  assert.ok(
    flat.includes('repo:marciozampiron/backstage-cba-prep:ref:refs/heads/main'),
    'branch-scoped trust subject expected',
  );
});

test('no literal 12-digit account id in the synthesized template', () => {
  const template = synthTemplate();
  const flat = JSON.stringify(template.toJSON());
  assert.ok(!/\b\d{12}\b/.test(flat), 'pseudo parameters only — no literal account id');
});

test('importing an existing provider by context skips creating a new one', () => {
  const template = synthTemplate({
    githubOidcProviderArn:
      'arn:aws:iam::ACCOUNT_ID_PLACEHOLDER:oidc-provider/token.actions.githubusercontent.com',
  });
  template.resourceCountIs('AWS::IAM::OIDCProvider', 0);
  template.resourceCountIs('AWS::IAM::Role', 2);
});
