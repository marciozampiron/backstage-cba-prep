// Synth-time guarantees for the SecurityStack (#66 architecture gate):
// native OIDC provider only, permissions boundary attached, zero custom-resource plumbing,
// and bedrock:InvokeModel scoped to exactly the expected resources.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
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

test('F2 GUARD: synthesized boundaries AGREE with the operator cfn-exec-security CreateRole conditions, per tier', () => {
  // The exec policy allows iam:CreateRole for each deploy role ONLY under its canonical boundary
  // and denies boundary detach/swap — so a template whose boundary diverges from the policy is
  // "accepted at synth, unexecutable at deploy". This test reads BOTH sides: the operator policy
  // names the boundary each tier's CreateRole demands, and the synthesized role must attach a
  // boundary whose literal policy name is exactly that — no context can widen it (#111 F2: the
  // ghaDeployBoundaryArn* override keys were removed outright).
  const execPolicy = JSON.parse(fs.readFileSync(
    path.join(__dirname, '..', 'bootstrap', 'policies', 'cfn-exec-security.template.json'),
    'utf8',
  ));
  const resources = synthTemplate().toJSON().Resources;
  for (const [tier, sid] of [
    ['dev', 'CreateGhaDeployRoleDevOnlyWithItsBoundary'],
    ['pilot', 'CreateGhaDeployRolePilotOnlyWithItsBoundary'],
  ]) {
    const stmt = execPolicy.Statement.find((s) => s.Sid === sid);
    assert.ok(stmt, `${sid} must exist in the operator policy`);
    const allowedBoundaryName = stmt.Condition.StringEquals['iam:PermissionsBoundary'].split(':policy/')[1];
    assert.equal(allowedBoundaryName, `cba-study-coach-boundary-gha-deploy-${tier}`);

    const role = Object.values(resources).find(
      (r) => r.Type === 'AWS::IAM::Role' && r.Properties.RoleName === `cba-study-coach-gha-deploy-${tier}`,
    );
    assert.ok(role, `deploy role for ${tier} must exist`);
    // Agreement on the ROLE name too: the policy's CreateRole Resource is the exact role the
    // template creates — a drift on either side must fail here by name.
    assert.equal(stmt.Resource.split(':role/')[1], role.Properties.RoleName);
    // The synthesized boundary is an Fn::Join over pseudo parameters; its literal tail is the
    // policy name — the same comparison surface the exec policy pins, with no account id.
    const flatBoundary = JSON.stringify(role.Properties.PermissionsBoundary);
    assert.ok(flatBoundary.includes(`:policy/${allowedBoundaryName}`), `the ${tier} role must attach its canonical boundary`);
    const other = tier === 'dev' ? 'pilot' : 'dev';
    assert.equal(flatBoundary.includes(`gha-deploy-${other}`), false, `the ${other} boundary must not appear on the ${tier} role`);
  }
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

test('F1 GUARD round 2: NO context can produce the foundation without its OIDC provider', () => {
  // The import-an-existing-provider path is GONE from this stack: a template that lost
  // `GithubOidc` would make the next redeploy of the deployed foundation DELETE the live
  // provider and sever every OIDC trust in the account. The old key is inert EVERYWHERE
  // (round 3): no stack reads it, so supplying it changes nothing at all.
  for (const context of [
    {},
    { githubOidcProviderArn: 'arn:aws:iam::ACCOUNT_ID_PLACEHOLDER:oidc-provider/token.actions.githubusercontent.com' },
    { environment: 'dev' },
  ]) {
    const template = synthTemplate(context);
    template.resourceCountIs('AWS::IAM::OIDCProvider', 1);
    assert.ok(template.toJSON().Resources.GithubOidc, 'the provider must keep its deployed logical id');
    template.resourceCountIs('AWS::IAM::Role', 3);
  }
});
