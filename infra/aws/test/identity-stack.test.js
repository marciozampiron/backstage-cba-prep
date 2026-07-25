// IdentityStack synth guarantees (#69 Slice A): PKCE-READY public client (code grant only, NO
// secret, NO implicit flow, every direct auth flow explicitly off — PKCE itself is executed by
// the SPA and proven in Slice C), exact callback/logout URLs (wildcards/plain-http rejected),
// usable classic hosted UI (pinned version + branding attachment), invite-only pool, pilot
// durable vs dev disposable — and zero literal account ids anywhere.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { App } = require('aws-cdk-lib');
const { Template } = require('aws-cdk-lib/assertions');
const { IdentityStack } = require('../lib/identity-stack');

const cache = {};
function identityTemplate(env, extraContext = {}) {
  const key = env + JSON.stringify(extraContext);
  if (!cache[key]) {
    const app = new App({ context: { environment: env, ...extraContext } });
    cache[key] = Template.fromStack(new IdentityStack(app, 'IdentityStack', {}));
  }
  return cache[key];
}

function clientOf(t) {
  return Object.values(t.findResources('AWS::Cognito::UserPoolClient'))[0].Properties;
}

test('pool: invite-only, email sign-in, strong password policy, pilot durable', () => {
  const t = identityTemplate('pilot');
  const pool = Object.values(t.findResources('AWS::Cognito::UserPool'))[0];
  assert.equal(pool.Properties.UserPoolName, 'cba-study-coach-pilot-users');
  assert.equal(pool.Properties.AdminCreateUserConfig.AllowAdminCreateUserOnly, true, 'self sign-up must be OFF');
  assert.deepEqual(pool.Properties.UsernameAttributes, ['email']);
  assert.equal(pool.Properties.Policies.PasswordPolicy.MinimumLength, 12);
  assert.equal(pool.Properties.DeletionProtection, 'ACTIVE');
  assert.equal(pool.DeletionPolicy, 'Retain');
});

test('pool: dev is disposable and separately named', () => {
  const t = identityTemplate('dev');
  const pool = Object.values(t.findResources('AWS::Cognito::UserPool'))[0];
  assert.equal(pool.Properties.UserPoolName, 'cba-study-coach-dev-users');
  assert.equal(pool.Properties.DeletionProtection, 'INACTIVE');
  assert.equal(pool.DeletionPolicy, 'Delete');
});

test('client: public SPA (PKCE-ready) — no secret, code grant only, no implicit', () => {
  const client = clientOf(identityTemplate('pilot'));
  assert.equal(client.GenerateSecret, false, 'a browser client can never hold a secret');
  assert.deepEqual(client.AllowedOAuthFlows, ['code'], 'authorization code grant ONLY');
  assert.ok(!JSON.stringify(client.AllowedOAuthFlows).includes('implicit'));
  assert.equal(client.PreventUserExistenceErrors, 'ENABLED');
  assert.deepEqual(client.AllowedOAuthScopes.sort(), ['email', 'openid', 'profile']);
});

test('client: every DIRECT auth flow is explicitly off — refresh-token auth is the only one', () => {
  const client = clientOf(identityTemplate('pilot'));
  // Omitting authFlows would let Cognito default to ALLOW_USER_SRP_AUTH + ALLOW_CUSTOM_AUTH.
  assert.deepEqual(client.ExplicitAuthFlows, ['ALLOW_REFRESH_TOKEN_AUTH']);
});

test('hosted UI: classic version pinned and exactly one branding attachment (usable login pages)', () => {
  const t = identityTemplate('pilot');
  const domain = Object.values(t.findResources('AWS::Cognito::UserPoolDomain'))[0];
  assert.equal(domain.Properties.ManagedLoginVersion, 1, 'classic hosted UI, not the paid managed login');
  const attachments = Object.values(t.findResources('AWS::Cognito::UserPoolUICustomizationAttachment'));
  assert.equal(attachments.length, 1, 'programmatic clients get no branding without an attachment');
  assert.ok(attachments[0].Properties.ClientId, 'attachment bound to the SPA client');
});

test('client: default callback/logout URLs are exact placeholders per environment', () => {
  const pilot = clientOf(identityTemplate('pilot'));
  assert.deepEqual(pilot.CallbackURLs, ['https://pilot.invalid/auth/callback']);
  assert.deepEqual(pilot.LogoutURLs, ['https://pilot.invalid/']);
  const dev = clientOf(identityTemplate('dev'));
  assert.deepEqual(dev.CallbackURLs, ['http://localhost:3000/auth/callback']);
});

test('client: context overrides flow through as exact values', () => {
  const t = identityTemplate('dev', {
    authCallbackUrls: '["https://dev.example.test/auth/callback"]',
    authLogoutUrls: '["https://dev.example.test/"]',
  });
  const client = clientOf(t);
  assert.deepEqual(client.CallbackURLs, ['https://dev.example.test/auth/callback']);
  assert.deepEqual(client.LogoutURLs, ['https://dev.example.test/']);
});

test('client: wildcard or non-https callback URLs fail synth', () => {
  assert.throws(
    () =>
      Template.fromStack(
        new IdentityStack(
          new App({ context: { environment: 'dev', authCallbackUrls: '["https://*.example.test/cb"]' } }),
          'IdentityStack',
          {},
        ),
      ),
    /wildcards are forbidden/,
  );
  assert.throws(
    () =>
      Template.fromStack(
        new IdentityStack(
          new App({ context: { environment: 'dev', authCallbackUrls: '["http://app.example.test/cb"]' } }),
          'IdentityStack',
          {},
        ),
      ),
    /must use https/,
  );
});

test('domain: hosted OAuth endpoints use the environment cognito prefix', () => {
  const t = identityTemplate('pilot');
  const domain = Object.values(t.findResources('AWS::Cognito::UserPoolDomain'))[0];
  assert.equal(domain.Properties.Domain, 'cba-study-coach-pilot');
});

test('invalid environment fails construction; no literal account ids synthesize', () => {
  assert.throws(
    () => new IdentityStack(new App({ context: { environment: 'production' } }), 'IdentityStack', {}),
    /must be one of dev\|pilot/,
  );
  const flat = JSON.stringify(identityTemplate('pilot').toJSON());
  assert.ok(!/\b\d{12}\b/.test(flat), 'no literal account id');
});
