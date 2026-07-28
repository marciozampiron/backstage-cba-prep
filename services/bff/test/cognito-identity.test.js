// Cognito identity adapter unit tests (#69 Slice B) — all offline, fetch stubbed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  principalFromJwtClaims,
  resolveCognitoDomain,
  createProfileLoader,
  bearerFromHeaders,
} from '../src/cognito-identity.js';

/* ---------------- principal mapping: access tokens ONLY ---------------- */

test('principal: a valid ACCESS token claim set maps to a neutral principal', () => {
  const p = principalFromJwtClaims({ token_use: 'access', sub: 'abc-123', username: 'u' });
  assert.deepEqual(p, { provider: 'cognito', sub: 'abc-123', tokenUse: 'access', groups: [] });
});

test('principal: cognito:groups is carried through, and nothing else is', () => {
  // #75: the smoke capability is a GROUP because `cognito:groups` is actually present on an access
  // token, unlike a custom attribute. Only that claim is mapped — a token cannot smuggle anything
  // else into the neutral principal.
  const p = principalFromJwtClaims({
    token_use: 'access',
    sub: 'abc-123',
    'cognito:groups': ['cba-smoke', 'learners'],
    'custom:anything': 'ignored',
    scope: 'aws.cognito.signin.user.admin',
  });
  assert.deepEqual(p, { provider: 'cognito', sub: 'abc-123', tokenUse: 'access', groups: ['cba-smoke', 'learners'] });

  // A malformed or absent groups claim degrades to none, never to a truthy value.
  for (const claim of [undefined, null, 'cba-smoke', 42, {}, [1, '', 'ok']]) {
    const q = principalFromJwtClaims({ token_use: 'access', sub: 'abc-123', 'cognito:groups': claim });
    assert.ok(Array.isArray(q.groups));
    assert.equal(q.groups.includes(''), false);
    assert.equal(q.groups.some((g) => typeof g !== 'string'), false);
  }
});

test('principal: ID tokens are REJECTED even though they pass the JWT authorizer', () => {
  assert.equal(principalFromJwtClaims({ token_use: 'id', sub: 'abc-123' }), null);
});

test('principal: missing/odd claims are rejected (no principal, port answers 401)', () => {
  assert.equal(principalFromJwtClaims(undefined), null);
  assert.equal(principalFromJwtClaims({}), null);
  assert.equal(principalFromJwtClaims({ token_use: 'access' }), null, 'no sub');
  assert.equal(principalFromJwtClaims({ token_use: 'access', sub: 'bad sub!' }), null, 'sub charset');
  assert.equal(principalFromJwtClaims({ token_use: 'refresh', sub: 'abc' }), null);
});

/* ---------------- domain configuration ---------------- */

test('COGNITO_DOMAIN: https absolute URL required; trailing slash normalized', () => {
  assert.equal(resolveCognitoDomain({ COGNITO_DOMAIN: 'https://auth.example.invalid/' }), 'https://auth.example.invalid');
  assert.throws(() => resolveCognitoDomain({}), /COGNITO_DOMAIN is not configured/);
  assert.throws(() => resolveCognitoDomain({ COGNITO_DOMAIN: 'not-a-url' }), /absolute URL/);
  assert.throws(() => resolveCognitoDomain({ COGNITO_DOMAIN: 'http://auth.example.invalid' }), /https/);
});

/* ---------------- profile loader: bearer stays in the closure ---------------- */

test('profile loader: calls /oauth2/userInfo with the bearer and sanitizes the result', async () => {
  const calls = [];
  const loader = createProfileLoader({
    bearer: 'tok-123',
    env: { COGNITO_DOMAIN: 'https://auth.example.invalid' },
    fetchImpl: async (url, opts) => {
      calls.push({ url, auth: opts.headers.authorization });
      return { ok: true, json: async () => ({ email: '  m@example.com ', name: ' Marcio ', sub: 'x', ignored: 'y' }) };
    },
  });
  const profile = await loader();
  assert.deepEqual(calls, [{ url: 'https://auth.example.invalid/oauth2/userInfo', auth: 'Bearer tok-123' }]);
  assert.deepEqual(profile, { email: 'm@example.com', displayName: 'Marcio' });
});

test('profile loader: displayName falls back preferred_username -> email local part -> Learner', async () => {
  const make = (payload) =>
    createProfileLoader({
      bearer: 't',
      env: { COGNITO_DOMAIN: 'https://auth.example.invalid' },
      fetchImpl: async () => ({ ok: true, json: async () => payload }),
    })();
  assert.deepEqual(await make({ email: 'a@b.c', preferred_username: 'pref' }), { email: 'a@b.c', displayName: 'pref' });
  assert.deepEqual(await make({ email: 'a@b.c' }), { email: 'a@b.c', displayName: 'a' });
  assert.deepEqual(await make({}), { email: null, displayName: 'Learner' });
});

test('profile loader: a non-200 userInfo response throws WITHOUT provider details', async () => {
  const loader = createProfileLoader({
    bearer: 't',
    env: { COGNITO_DOMAIN: 'https://auth.example.invalid' },
    fetchImpl: async () => ({ ok: false, status: 503 }),
  });
  await assert.rejects(loader, /profile lookup failed \(status 503\)/);
});

test('profile loader: the bearer token is not a readable property of anything returned', () => {
  const loader = createProfileLoader({ bearer: 'secret-token', env: { COGNITO_DOMAIN: 'https://a.invalid' } });
  assert.equal(typeof loader, 'function');
  assert.ok(!JSON.stringify({ ...loader }).includes('secret-token'), 'closure only — never serialized');
});

/* ---------------- bearer extraction ---------------- */

test('bearer extraction: case-insensitive scheme, absent/foreign schemes -> null', () => {
  assert.equal(bearerFromHeaders({ authorization: 'Bearer abc' }), 'abc');
  assert.equal(bearerFromHeaders({ authorization: 'bearer abc' }), 'abc');
  assert.equal(bearerFromHeaders({ authorization: 'Basic abc' }), null);
  assert.equal(bearerFromHeaders({}), null);
});
