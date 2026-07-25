// Lambda transport in COGNITO mode (#69 Slice B) — offline, in-process, memory store, fetch
// stubbed. Proves the binding rules end to end THROUGH the handler: access-token-only,
// ID-token rejection, dev-header rejection, provider-namespaced learners, cross-learner 403,
// /api/me (§16) with UserInfo enrichment cached after the first call, and public readiness.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.CBA_WEB_STORE = 'memory';
process.env.CBA_WEB_AUTH = 'cognito';
process.env.COGNITO_DOMAIN = 'https://auth.test.invalid';

// Offline userInfo stub: counts calls, echoes a per-bearer identity, and can fail on demand.
const userInfoCalls = [];
let userInfoFail = false;
globalThis.fetch = async (url, opts) => {
  userInfoCalls.push({ url: String(url), auth: opts?.headers?.authorization });
  if (userInfoFail) return { ok: false, status: 503 };
  const token = opts.headers.authorization.replace(/^Bearer\s+/i, '');
  return {
    ok: true,
    json: async () => ({ email: `${token}@example.test`, name: `Name of ${token}` }),
  };
};

const { handler } = await import('../src/lambda.js');

function cognitoEvent(method, rawPath, { sub, tokenUse = 'access', bearer, body, headers } = {}) {
  return {
    version: '2.0',
    rawPath,
    requestContext: {
      http: { method },
      ...(sub !== undefined ? { authorizer: { jwt: { claims: { sub, token_use: tokenUse } } } } : {}),
    },
    headers: {
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
      ...(headers ?? {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    isBase64Encoded: false,
  };
}

async function invoke(method, rawPath, opts) {
  const res = await handler(cognitoEvent(method, rawPath, opts));
  return { status: res.statusCode, body: JSON.parse(res.body) };
}

/* ---------------- fail-closed authentication ---------------- */

test('cognito: no authorizer claims -> 401 UNAUTHENTICATED on authenticated routes', async () => {
  const res = await invoke('GET', '/api/dashboard');
  assert.equal(res.status, 401);
  assert.equal(res.body.error.code, 'UNAUTHENTICATED');
});

test('cognito: an ID token is rejected even though it passed the JWT authorizer', async () => {
  const res = await invoke('GET', '/api/dashboard', { sub: 'id-token-user', tokenUse: 'id' });
  assert.equal(res.status, 401);
  assert.equal(res.body.error.code, 'UNAUTHENTICATED');
});

test('cognito: x-cba-learner is rejected even alongside a VALID access token', async () => {
  const res = await invoke('GET', '/api/dashboard', {
    sub: 'legit-user',
    bearer: 'tok-legit',
    headers: { 'x-cba-learner': 'spoof' },
  });
  assert.equal(res.status, 401);
  assert.equal(res.body.error.code, 'UNAUTHENTICATED');
});

test('cognito: valid claims WITHOUT a bearer fail closed — 401 and NOTHING persisted', async () => {
  // Cannot happen on a real gateway (the authorizer reads the Authorization header), but a
  // forged event / direct invoke must not mint a deterministic local profile.
  const denied = await invoke('GET', '/api/me', { sub: 'no-bearer-sub' });
  assert.equal(denied.status, 401);
  assert.equal(denied.body.error.code, 'UNAUTHENTICATED');
  const dash = await invoke('GET', '/api/dashboard', { sub: 'no-bearer-sub' });
  assert.equal(dash.status, 401);

  // Proof nothing was written: the first AUTHORIZED call still bootstraps from userInfo — a
  // fail-open bug would have persisted an @local.invalid profile above and returned it here.
  const ok = await invoke('GET', '/api/me', { sub: 'no-bearer-sub', bearer: 'nb-tok' });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.email, 'nb-tok@example.test');
  assert.ok(!ok.body.email.includes('local.invalid'));
});

test('cognito: readiness stays public without any token', async () => {
  const res = await invoke('GET', '/api/readiness');
  assert.equal(res.status, 200);
  assert.deepEqual(Object.keys(res.body).sort(), ['adapter', 'ready', 'runtimeEnv']);
});

/* ---------------- provider-namespaced learners + ownership ---------------- */

test('cognito: learners are namespaced by sub and ownership stays 403 across subs', async () => {
  const start = await invoke('POST', '/api/practice-sessions', {
    sub: 'owner-sub',
    bearer: 'tok-owner',
    body: { questionCount: 5 },
  });
  assert.equal(start.status, 201);
  const intruder = await invoke('GET', `/api/attempts/${start.body.attemptId}/results`, {
    sub: 'intruder-sub',
    bearer: 'tok-intruder',
  });
  assert.equal(intruder.status, 403);
  assert.equal(intruder.body.error.code, 'NOT_RESOURCE_OWNER');
});

/* ---------------- /api/me (§16) with cached UserInfo enrichment ---------------- */

test('cognito /api/me: first call enriches via userInfo, later calls hit the cache', async () => {
  userInfoCalls.length = 0;
  const first = await invoke('GET', '/api/me', { sub: 'me-sub', bearer: 'alice' });
  assert.equal(first.status, 200);
  assert.deepEqual(Object.keys(first.body).sort(), ['activeExam', 'createdAt', 'displayName', 'email']);
  assert.equal(first.body.email, 'alice@example.test');
  assert.equal(first.body.displayName, 'Name of alice');
  assert.deepEqual(first.body.activeExam, { examId: 'cba', name: 'Certified Backstage Associate' });
  assert.equal(userInfoCalls.length, 1, 'exactly one userInfo call');
  assert.equal(userInfoCalls[0].url, 'https://auth.test.invalid/oauth2/userInfo');

  const second = await invoke('GET', '/api/me', { sub: 'me-sub', bearer: 'alice' });
  assert.equal(second.status, 200);
  assert.equal(userInfoCalls.length, 1, 'cached profile — userInfo is NOT called per request');
});

test('cognito /api/me PUT: partial update per §16, no extra userInfo calls', async () => {
  userInfoCalls.length = 0;
  const updated = await invoke('PUT', '/api/me', {
    sub: 'me-sub',
    bearer: 'alice',
    body: { displayName: 'Novo Nome' },
  });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.displayName, 'Novo Nome');
  assert.equal(updated.body.email, 'alice@example.test', 'email never changes through /api/me');
  const readBack = await invoke('GET', '/api/me', { sub: 'me-sub', bearer: 'alice' });
  assert.equal(readBack.body.displayName, 'Novo Nome');
  assert.equal(userInfoCalls.length, 0, 'profile already cached');
});

test('cognito /api/me PUT: empty name and unknown exam -> 400 VALIDATION_FAILED', async () => {
  const badName = await invoke('PUT', '/api/me', { sub: 'me-sub', bearer: 'alice', body: { displayName: '  ' } });
  assert.equal(badName.status, 400);
  assert.equal(badName.body.error.code, 'VALIDATION_FAILED');
  const badExam = await invoke('PUT', '/api/me', { sub: 'me-sub', bearer: 'alice', body: { activeExamId: 'kcna' } });
  assert.equal(badExam.status, 400);
  assert.equal(badExam.body.error.code, 'VALIDATION_FAILED');
});

test('cognito /api/me: a userInfo outage surfaces as a generic 500 (no provider details)', async () => {
  userInfoFail = true;
  try {
    const res = await invoke('GET', '/api/me', { sub: 'fresh-sub', bearer: 'tok-fresh' });
    assert.equal(res.status, 500);
    assert.equal(res.body.error.code, 'INTERNAL');
    assert.ok(!JSON.stringify(res.body).match(/cognito|userinfo|oauth/i), 'no provider internals in the envelope');
  } finally {
    userInfoFail = false;
  }
});
