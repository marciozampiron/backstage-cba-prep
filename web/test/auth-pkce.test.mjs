// PKCE S256 proof (#69 Slice C, binding): the EXACT settings our session layer feeds to
// oidc-client-ts produce an authorization request carrying code_challenge_method=S256 with a
// real code_verifier stored for the callback — proven offline against explicit metadata (no
// network, no Cognito). Also locks the scope set (never aws.cognito.signin.user.admin) and the
// Cognito logout URL shape.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OidcClient, InMemoryWebStorage, WebStorageStateStore } from 'oidc-client-ts';
import { buildOidcSettings, cognitoAuthority, cognitoLogoutUrl } from '../lib/auth-settings.js';

const CONFIG = {
  userPoolId: 'us-east-1_TESTPOOL',
  clientId: 'test-client-id',
  domain: 'https://auth.example.invalid',
};
const ORIGIN = 'https://app.example.invalid';

function offlineClient() {
  const settings = buildOidcSettings(CONFIG, ORIGIN);
  const storage = new InMemoryWebStorage();
  return {
    storage,
    client: new OidcClient({
      ...settings,
      stateStore: new WebStorageStateStore({ store: storage }),
      // Explicit metadata: the proof must not depend on network discovery.
      metadata: {
        issuer: settings.authority,
        authorization_endpoint: `${CONFIG.domain}/oauth2/authorize`,
        token_endpoint: `${CONFIG.domain}/oauth2/token`,
      },
    }),
  };
}

test('authority derives the region from the pool id itself', () => {
  assert.equal(cognitoAuthority('us-east-1_TESTPOOL'), 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_TESTPOOL');
});

test('sign-in request: code flow with PKCE S256 and a stored code_verifier', async () => {
  const { client, storage } = offlineClient();
  const req = await client.createSigninRequest({});
  const url = new URL(req.url);
  assert.equal(url.origin + url.pathname, 'https://auth.example.invalid/oauth2/authorize');
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('client_id'), 'test-client-id');
  assert.equal(url.searchParams.get('redirect_uri'), 'https://app.example.invalid/auth/callback');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256', 'PKCE S256 is mandatory');
  const challenge = url.searchParams.get('code_challenge');
  assert.ok(challenge && challenge.length >= 43, 'a real code_challenge is present');
  // The verifier is persisted for the callback leg — and never equals the challenge (S256).
  const stored = JSON.parse(storage.getItem(`oidc.${url.searchParams.get('state')}`));
  assert.ok(stored.code_verifier && stored.code_verifier.length >= 43);
  assert.notEqual(stored.code_verifier, challenge);
});

test('scopes are exactly openid email profile — never aws.cognito.signin.user.admin', async () => {
  const { client } = offlineClient();
  const req = await client.createSigninRequest({});
  const scope = new URL(req.url).searchParams.get('scope');
  assert.deepEqual(scope.split(' ').sort(), ['email', 'openid', 'profile']);
  assert.ok(!scope.includes('aws.cognito.signin.user.admin'));
});

test('logout URL targets the Cognito hosted logout with exact client and return origin', () => {
  const url = new URL(cognitoLogoutUrl(CONFIG, ORIGIN));
  assert.equal(url.origin + url.pathname, 'https://auth.example.invalid/logout');
  assert.equal(url.searchParams.get('client_id'), 'test-client-id');
  assert.equal(url.searchParams.get('logout_uri'), 'https://app.example.invalid/');
});
