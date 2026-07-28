// /auth/config runtime-configuration route (#67 + #69) — offline: the route only depends on our
// own resolver, so it can be invoked directly with a controlled process.env.
//
// It is the ONE place the browser learns (a) which auth mode is active and (b) where the Web BFF
// lives. Both are served at REQUEST time; neither is ever a NEXT_PUBLIC_* build-time constant.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const KEYS = [
  'CBA_RUNTIME_ENV',
  'CBA_BFF_BASE_URL',
  'CBA_WEB_AUTH',
  'COGNITO_USER_POOL_ID',
  'COGNITO_CLIENT_ID',
  'COGNITO_DOMAIN',
];

async function callWith(env) {
  const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  for (const key of KEYS) delete process.env[key];
  Object.assign(process.env, env);
  try {
    const { GET } = await import('../app/auth/config/route.js');
    const res = await GET();
    return { status: res.status, body: await res.json() };
  } finally {
    for (const key of KEYS) delete process.env[key];
    for (const [key, value] of Object.entries(saved)) if (value !== undefined) process.env[key] = value;
  }
}

test('dev mode serves the runtime env and a null base URL (same-origin /api)', async () => {
  const res = await callWith({});
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { mode: 'dev', runtimeEnv: 'local', bffBaseUrl: null });
});

test('dev mode still serves an explicitly configured base URL', async () => {
  const res = await callWith({ CBA_BFF_BASE_URL: 'https://bff.dev.example.test/' });
  assert.equal(res.status, 200);
  assert.equal(res.body.bffBaseUrl, 'https://bff.dev.example.test');
});

test('cognito mode serves auth ids AND the base URL together', async () => {
  const res = await callWith({
    CBA_WEB_AUTH: 'cognito',
    CBA_RUNTIME_ENV: 'pilot',
    CBA_BFF_BASE_URL: 'https://api.pilot.example.test',
    COGNITO_USER_POOL_ID: 'us-east-1_TESTPOOL',
    COGNITO_CLIENT_ID: 'client-id',
    COGNITO_DOMAIN: 'https://auth.pilot.example.test',
  });
  assert.equal(res.status, 200);
  assert.deepEqual(Object.keys(res.body).sort(), [
    'bffBaseUrl',
    'clientId',
    'domain',
    'mode',
    'runtimeEnv',
    'userPoolId',
  ]);
  assert.equal(res.body.bffBaseUrl, 'https://api.pilot.example.test');
  assert.equal(res.body.runtimeEnv, 'pilot');
});

test('a deployed runtime WITHOUT a base URL fails closed — no config is served', async () => {
  const res = await callWith({ CBA_RUNTIME_ENV: 'pilot' });
  assert.equal(res.status, 500);
  assert.equal(res.body.error.code, 'RUNTIME_MISCONFIGURED');
  assert.equal(res.body.bffBaseUrl, undefined, 'nothing partial leaks out of a broken runtime');
});

test('a malformed base URL fails closed rather than reaching the browser', async () => {
  const res = await callWith({ CBA_RUNTIME_ENV: 'dev', CBA_BFF_BASE_URL: 'http://insecure.example.test' });
  assert.equal(res.status, 500);
  assert.equal(res.body.error.code, 'RUNTIME_MISCONFIGURED');
});

/* ---------------- deployed runtimes demand CBA_WEB_AUTH=cognito ---------------- */

test('deployed + valid base + auth ABSENT returns AUTH_MISCONFIGURED', async () => {
  for (const runtimeEnv of ['dev', 'pilot']) {
    const res = await callWith({
      CBA_RUNTIME_ENV: runtimeEnv,
      CBA_BFF_BASE_URL: 'https://bff.example.test',
    });
    assert.equal(res.status, 500, runtimeEnv);
    assert.equal(res.body.error.code, 'AUTH_MISCONFIGURED');
    assert.equal(res.body.mode, undefined, 'no dev mode leaks out of a deployed runtime');
  }
});

test('deployed + valid base + auth "dev" returns AUTH_MISCONFIGURED (no downgrade)', async () => {
  const res = await callWith({
    CBA_RUNTIME_ENV: 'pilot',
    CBA_BFF_BASE_URL: 'https://bff.example.test',
    CBA_WEB_AUTH: 'dev',
  });
  assert.equal(res.status, 500);
  assert.equal(res.body.error.code, 'AUTH_MISCONFIGURED');
});

test('deployed + valid base + UNKNOWN auth value returns AUTH_MISCONFIGURED', async () => {
  for (const mode of ['cognito ', 'Cognito', 'oidc', 'none']) {
    const res = await callWith({
      CBA_RUNTIME_ENV: 'dev',
      CBA_BFF_BASE_URL: 'https://bff.example.test',
      CBA_WEB_AUTH: mode,
    });
    assert.equal(res.status, 500, `"${mode}" must not be accepted`);
    assert.equal(res.body.error.code, 'AUTH_MISCONFIGURED');
  }
});

test('local dev keeps working — auth unset and auth=dev both serve the dev mode', async () => {
  for (const env of [{}, { CBA_WEB_AUTH: 'dev' }, { CBA_RUNTIME_ENV: 'local', CBA_WEB_AUTH: 'dev' }]) {
    const res = await callWith(env);
    assert.equal(res.status, 200, JSON.stringify(env));
    assert.equal(res.body.mode, 'dev');
    assert.equal(res.body.runtimeEnv, 'local');
    assert.equal(res.body.bffBaseUrl, null);
  }
});

test('cognito mode with incomplete auth ids fails closed', async () => {
  const res = await callWith({
    CBA_WEB_AUTH: 'cognito',
    CBA_RUNTIME_ENV: 'pilot',
    CBA_BFF_BASE_URL: 'https://api.pilot.example.test',
    COGNITO_USER_POOL_ID: 'us-east-1_TESTPOOL',
  });
  assert.equal(res.status, 500);
  assert.equal(res.body.error.code, 'AUTH_MISCONFIGURED');
});

/* ============================ #67 Stage B: the runtime-variable contract ===================== */

test('a deployed cognito runtime refuses the reserved .invalid placeholder', async () => {
  // The Cognito callback/logout URLs still default to `.invalid` while the custom-domain versus
  // workers.dev decision is open. Reaching a deployed tier with it renders a sign-in button that
  // cannot complete its redirect: the page looks healthy and the flow is dead. Failing here makes
  // it visible at config time instead of in the browser after the redirect.
  const res = await callWith({
    CBA_WEB_AUTH: 'cognito',
    CBA_RUNTIME_ENV: 'pilot',
    CBA_BFF_BASE_URL: 'https://api.pilot.example.test',
    COGNITO_USER_POOL_ID: 'us-east-1_TESTPOOL',
    COGNITO_CLIENT_ID: 'client-id',
    COGNITO_DOMAIN: 'https://auth.cba-study-coach.invalid',
  });
  assert.equal(res.status, 500);
  assert.equal(res.body.error.code, 'AUTH_MISCONFIGURED');
  assert.equal(res.body.domain, undefined, 'nothing partial leaks out of a broken runtime');
});

test('local development may still use the .invalid placeholder', async () => {
  // Only a DEPLOYED tier is refused: local work has no real Cognito domain and must not be blocked.
  const res = await callWith({
    CBA_WEB_AUTH: 'cognito',
    COGNITO_USER_POOL_ID: 'us-east-1_TESTPOOL',
    COGNITO_CLIENT_ID: 'client-id',
    COGNITO_DOMAIN: 'https://auth.cba-study-coach.invalid',
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.mode, 'cognito');
});

test('NEGATIVE: each malformed Cognito value fails closed on its own', async () => {
  const base = {
    CBA_WEB_AUTH: 'cognito',
    CBA_RUNTIME_ENV: 'pilot',
    CBA_BFF_BASE_URL: 'https://api.pilot.example.test',
    COGNITO_USER_POOL_ID: 'us-east-1_TESTPOOL',
    COGNITO_CLIENT_ID: 'client-id',
    COGNITO_DOMAIN: 'https://auth.pilot.example.test',
  };
  // NOTE: `Object.assign` turns an `undefined` value into the STRING "undefined", which is present
  // and non-empty — so an absent variable has to be modelled by DELETING the key, not by setting it
  // to undefined. The first version of this test did the latter and proved nothing.
  const cases = {
    'missing pool id': (e) => { delete e.COGNITO_USER_POOL_ID; },
    'missing client id': (e) => { delete e.COGNITO_CLIENT_ID; },
    'missing domain': (e) => { delete e.COGNITO_DOMAIN; },
    'empty pool id': { COGNITO_USER_POOL_ID: '' },
    'whitespace-only client id': { COGNITO_CLIENT_ID: '   ' },
    'padded client id': { COGNITO_CLIENT_ID: ' client-id ' },
    // A bare host would resolve `new URL('/logout', domain)` relative to the frontend and send the
    // learner to a logout URL on the wrong site.
    'bare host domain': { COGNITO_DOMAIN: 'auth.pilot.example.test' },
    'http domain': { COGNITO_DOMAIN: 'http://auth.pilot.example.test' },
    'domain with a query string': { COGNITO_DOMAIN: 'https://auth.pilot.example.test?x=1' },
    'domain with credentials': { COGNITO_DOMAIN: 'https://u:p@auth.pilot.example.test' },
  };
  for (const [label, override] of Object.entries(cases)) {
    const env = { ...base };
    if (typeof override === 'function') override(env);
    else Object.assign(env, override);
    const res = await callWith(env);
    assert.equal(res.status, 500, `${label} must fail closed`);
    assert.equal(res.body.error.code, 'AUTH_MISCONFIGURED', label);
  }
});
