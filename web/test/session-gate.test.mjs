// Session-gate regressions (#69 Slice C review): the four session outcomes, the route-transition
// rule (`ready` is bound to the validated pathname — never reused across routes), and the
// session-scoping of BOTH oidc stores. All offline, dependencies injected.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryWebStorage, WebStorageStateStore } from 'oidc-client-ts';
import { isGatedPath, validateSession, resolveGateStatus } from '../lib/session-gate.js';
import { buildSessionStores } from '../lib/auth-settings.js';

/* ---------------- session outcomes ---------------- */

test('validateSession: dev mode is ready without any user lookup', async () => {
  let userLookups = 0;
  const result = await validateSession({
    getConfig: async () => ({ mode: 'dev' }),
    getUser: async () => {
      userLookups += 1;
      return null;
    },
  });
  assert.deepEqual(result, { mode: 'dev', status: 'ready' });
  assert.equal(userLookups, 0, 'dev mode never checks a session');
});

test('validateSession: cognito with a session is ready; without one is signed-out', async () => {
  const signedIn = await validateSession({
    getConfig: async () => ({ mode: 'cognito' }),
    getUser: async () => ({ access_token: 'tok' }),
  });
  assert.deepEqual(signedIn, { mode: 'cognito', status: 'ready' });

  const signedOut = await validateSession({
    getConfig: async () => ({ mode: 'cognito' }),
    getUser: async () => null,
  });
  assert.deepEqual(signedOut, { mode: 'cognito', status: 'signed-out' });
});

test('validateSession: a config failure is an ERROR — never mistaken for dev mode', async () => {
  const result = await validateSession({
    getConfig: async () => {
      throw new Error('config unavailable');
    },
    getUser: async () => null,
  });
  assert.deepEqual(result, { mode: null, status: 'error' });
});

/* ---------------- route transitions: ready never carries over ---------------- */

test('gate: ready is BOUND to the validated pathname — a route change goes back to checking', () => {
  const validated = { path: '/', status: 'ready' };
  assert.equal(resolveGateStatus({ pathname: '/', knownMode: 'cognito', validated }), 'ready');
  // Navigating to another protected route BEFORE its own validation: no ready reuse.
  assert.equal(resolveGateStatus({ pathname: '/mock', knownMode: 'cognito', validated }), 'checking');
  // And a stale signed-out answer is not reused either.
  assert.equal(
    resolveGateStatus({ pathname: '/mock', knownMode: 'cognito', validated: { path: '/', status: 'signed-out' } }),
    'checking',
  );
});

test('gate: signed-out and error states hold for their own pathname', () => {
  assert.equal(
    resolveGateStatus({ pathname: '/mock', knownMode: 'cognito', validated: { path: '/mock', status: 'signed-out' } }),
    'signed-out',
  );
  assert.equal(
    resolveGateStatus({ pathname: '/', knownMode: null, validated: { path: '/', status: 'error' } }),
    'error',
  );
});

test('gate: nothing validated yet means checking, not ready', () => {
  assert.equal(resolveGateStatus({ pathname: '/', knownMode: null, validated: null }), 'checking');
  assert.equal(resolveGateStatus({ pathname: '/', knownMode: 'cognito', validated: null }), 'checking');
});

test('gate short-circuits: /auth/* is ungated; a known dev runtime never gates', () => {
  assert.equal(isGatedPath('/auth/callback'), false);
  assert.equal(isGatedPath('/'), true);
  assert.equal(resolveGateStatus({ pathname: '/auth/callback', knownMode: null, validated: null }), 'ready');
  assert.equal(resolveGateStatus({ pathname: '/', knownMode: 'dev', validated: null }), 'ready');
});

/* ---------------- both oidc stores are session-scoped ---------------- */

test('buildSessionStores: userStore AND stateStore exist and share the SAME session storage', async () => {
  const storage = new InMemoryWebStorage();
  const stores = buildSessionStores(storage, WebStorageStateStore);
  assert.deepEqual(Object.keys(stores).sort(), ['stateStore', 'userStore']);
  await stores.userStore.set('user-key', 'u');
  await stores.stateStore.set('state-key', 's');
  assert.equal(storage.getItem('oidc.user-key'), 'u');
  assert.equal(storage.getItem('oidc.state-key'), 's');
});
