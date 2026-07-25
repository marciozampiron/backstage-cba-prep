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
  // The refresh role is the ONLY IAM role — no custom-resource plumbing role.
  template.resourceCountIs('AWS::IAM::Role', 1);
});

test('bedrock:InvokeModel is granted only on the expected resources, and nothing else', () => {
  const template = synthTemplate();
  const policies = template.findResources('AWS::IAM::Policy');
  const statements = Object.values(policies).flatMap(
    (p) => p.Properties.PolicyDocument.Statement,
  );
  assert.equal(statements.length, 1, 'exactly one policy statement');
  const [stmt] = statements;
  assert.equal(stmt.Action, 'bedrock:InvokeModel');
  assert.equal(stmt.Effect, 'Allow');
  const resources = stmt.Resource;
  assert.equal(resources.length, 4, 'inference profile + 3 routed model ARNs');
  const literal = resources.filter((r) => typeof r === 'string');
  assert.deepEqual(literal, [
    'arn:aws:bedrock:us-east-1::foundation-model/amazon.nova-pro-v1:0',
    'arn:aws:bedrock:us-east-2::foundation-model/amazon.nova-pro-v1:0',
    'arn:aws:bedrock:us-west-2::foundation-model/amazon.nova-pro-v1:0',
  ]);
  // No other bedrock action anywhere in the template; Converse never reappears (#66 guardrail).
  const flat = JSON.stringify(template.toJSON());
  assert.ok(!flat.includes('bedrock:Converse'), 'bedrock:Converse must not appear');
  assert.equal(flat.split('"bedrock:').length - 1, 1, 'only one bedrock action grant');
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
  template.resourceCountIs('AWS::IAM::Role', 1);
});
