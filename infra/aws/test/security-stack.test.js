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
  // The refresh role and the two tier deploy roles (#111 F1) are the ONLY IAM roles — no
  // custom-resource plumbing role.
  template.resourceCountIs('AWS::IAM::Role', 3);
});

test('bedrock:InvokeModel is granted only on the expected resources, and nothing else', () => {
  const template = synthTemplate();
  const policies = template.findResources('AWS::IAM::Policy');
  const statements = Object.values(policies).flatMap(
    (p) => p.Properties.PolicyDocument.Statement,
  );
  assert.equal(statements.length, 3, 'exactly three policy statements: the refresh grant and one bootstrap-assumption per tier (#111 F1)');
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

test('BOTH deploy roles live in the ONE foundation template, each with tier-exclusive trust, boundary and bootstrap authority', () => {
  // The deployment authorities (#70 Slice B1; #111 F1): each published as ITS Environment's
  // secret AWS_DEPLOY_ROLE_ARN. Trust is the GitHub ENVIRONMENT subject — a token minted outside
  // the protected Environment carries a different sub and cannot assume it. Both roles come from
  // ONE synth of ONE stack: the tier is no longer a context selector.
  const resources = synthTemplate().toJSON().Resources;
  for (const [tier, other, qualifier, otherQualifier] of [
    ['pilot', 'dev', 'cbarpil', 'cbardev'],
    ['dev', 'pilot', 'cbardev', 'cbarpil'],
  ]) {
    const entry = Object.entries(resources).find(
      ([, r]) => r.Type === 'AWS::IAM::Role' && r.Properties.RoleName === `cba-study-coach-gha-deploy-${tier}`,
    );
    assert.ok(entry, `deploy role for ${tier} must exist`);
    const [logicalId, role] = entry;
    const trust = JSON.stringify(role.Properties.AssumeRolePolicyDocument);
    assert.ok(trust.includes('"sts:AssumeRoleWithWebIdentity"'), 'web-identity trust only');
    assert.ok(
      trust.includes(`repo:marciozampiron/backstage-cba-prep:environment:${tier}`),
      'the trust subject is the GitHub Environment, never a branch',
    );
    assert.equal(trust.includes(`environment:${other}`), false, `the ${tier} trust must never name the ${other} Environment`);
    assert.ok(trust.includes('"token.actions.githubusercontent.com:aud":"sts.amazonaws.com"'));
    const boundary = JSON.stringify(role.Properties.PermissionsBoundary);
    assert.match(boundary, new RegExp(`cba-study-coach-boundary-gha-deploy-${tier}`), "THIS TIER'S deploy boundary is attached — never the other's");
    assert.equal(boundary.includes(`gha-deploy-${other}`), false, `the ${other} boundary must not leak into the ${tier} role`);

    // Least privilege is structural, per tier: THIS role's own policy grants exactly the three
    // CDK bootstrap roles of ITS qualifier — deploy, file-publishing, lookup. No image-publishing
    // (this app builds no container assets), no cfn-execution role, no direct service permission,
    // and never the OTHER tier's bootstrap.
    const policy = Object.values(resources).find(
      (r) => r.Type === 'AWS::IAM::Policy' && JSON.stringify(r.Properties.Roles).includes(`"${logicalId}"`),
    );
    assert.ok(policy, `the ${tier} role's default policy must exist`);
    const stmt = policy.Properties.PolicyDocument.Statement.find((s) => s.Action === 'sts:AssumeRole');
    assert.ok(stmt, 'the bootstrap-assumption statement must exist');
    assert.equal(stmt.Effect, 'Allow');
    assert.equal(stmt.Resource.length, 3, 'exactly the three bootstrap roles');
    const flatResources = JSON.stringify(stmt.Resource);
    for (const name of ['deploy', 'file-publishing', 'lookup']) {
      assert.ok(flatResources.includes(`cdk-${qualifier}-${name}-role-`), `${name} bootstrap role expected (${tier} tier)`);
    }
    assert.equal(flatResources.includes(otherQualifier), false, `${tier} authority must not reach the ${other} bootstrap`);
    assert.equal(flatResources.includes('image-publishing'), false, 'no container-asset authority');
    assert.equal(flatResources.includes('cfn-exec'), false, 'never the CloudFormation execution role directly');
  }
});

test('F1 GUARD: the deployed logical ids survive EXACTLY — the dev role is a pure addition', () => {
  // Read-only observation of the physical foundation cba-study-coach-pilot-security
  // (2026-08-17, UPDATE_COMPLETE): these are the logical ids CloudFormation currently binds to
  // the account-globals and the pilot deploy role. A changed id here means the F1 update would
  // REPLACE a live, trusted resource instead of adding beside it; this test turns that
  // replacement into a named failure before any template leaves synth.
  const resources = synthTemplate().toJSON().Resources;
  const DEPLOYED = {
    GithubOidc: 'AWS::IAM::OIDCProvider',
    BedrockRefreshRole2883EC0D: 'AWS::IAM::Role',
    BedrockRefreshRoleDefaultPolicyD6CC8AA4: 'AWS::IAM::Policy',
    GithubDeployRoleB0CF66A5: 'AWS::IAM::Role',
    GithubDeployRoleDefaultPolicyE8F540D1: 'AWS::IAM::Policy',
  };
  for (const [logicalId, type] of Object.entries(DEPLOYED)) {
    assert.ok(resources[logicalId], `deployed logical id ${logicalId} must survive`);
    assert.equal(resources[logicalId].Type, type, `${logicalId} must keep its deployed type`);
  }
  assert.equal(resources.GithubDeployRoleB0CF66A5.Properties.RoleName, 'cba-study-coach-gha-deploy-pilot');
  assert.equal(resources.BedrockRefreshRole2883EC0D.Properties.RoleName, 'cba-study-coach-gha-bedrock-refresh');
  // The dev role is the ADDITION: present, its own name, and under a DIFFERENT logical id.
  const devEntry = Object.entries(resources).find(
    ([, r]) => r.Type === 'AWS::IAM::Role' && r.Properties.RoleName === 'cba-study-coach-gha-deploy-dev',
  );
  assert.ok(devEntry, 'the dev deploy role must exist');
  assert.notEqual(devEntry[0], 'GithubDeployRoleB0CF66A5', 'the dev role must not reuse the pilot logical id');
});

test('F1 GUARD: the foundation template is assembly-invariant — the environment context never reaches it', () => {
  // Requirement 6 of the F1 design: dev and pilot assemblies reference the SAME foundation. The
  // strongest synth-time form of "same": the template is identical whatever the ambient tier
  // context says, so no assembly can even EXPRESS a divergent foundation.
  const base = synthTemplate().toJSON();
  for (const context of [{ environment: 'dev' }, { environment: 'pilot' }]) {
    assert.deepEqual(synthTemplate(context).toJSON(), base, `the template must not vary with ${JSON.stringify(context)}`);
  }
});

test('a per-tier boundary override reaches ONLY its tier', () => {
  // The override keys are per tier BY NAME (ghaDeployBoundaryArnDev/Pilot): an operator renaming
  // one tier's boundary must not re-aim the other tier's role.
  const template = synthTemplate({
    ghaDeployBoundaryArnDev: 'arn:aws:iam::ACCOUNT_ID_PLACEHOLDER:policy/operator-renamed-dev-boundary',
  });
  const roles = Object.values(template.findResources('AWS::IAM::Role'));
  const dev = roles.find((r) => r.Properties.RoleName === 'cba-study-coach-gha-deploy-dev');
  const pilot = roles.find((r) => r.Properties.RoleName === 'cba-study-coach-gha-deploy-pilot');
  assert.equal(dev.Properties.PermissionsBoundary, 'arn:aws:iam::ACCOUNT_ID_PLACEHOLDER:policy/operator-renamed-dev-boundary');
  assert.match(JSON.stringify(pilot.Properties.PermissionsBoundary), /cba-study-coach-boundary-gha-deploy-pilot/);
});

test('separate outputs for the two deploy roles, the pilot one under its DEPLOYED output id', () => {
  const outputs = synthTemplate().toJSON().Outputs;
  assert.ok(outputs.GithubDeployRoleArn, 'the deployed pilot output id survives');
  assert.match(outputs.GithubDeployRoleArn.Description, /pilot Environment secret AWS_DEPLOY_ROLE_ARN/);
  assert.ok(outputs.GithubDeployRoleDevArn, 'the dev role has its own output');
  assert.match(outputs.GithubDeployRoleDevArn.Description, /dev Environment secret AWS_DEPLOY_ROLE_ARN/);
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
  template.resourceCountIs('AWS::IAM::Role', 3);
});
