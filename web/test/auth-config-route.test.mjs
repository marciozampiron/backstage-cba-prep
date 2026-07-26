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
