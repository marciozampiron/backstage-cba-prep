// Lambda transport adapter tests (#78): API Gateway HTTP API v2 event mapping, response shape
// and security headers, ownership/errors THROUGH the handler, and the exam-mode allowlist —
// all offline, in-process, memory store, zero network and zero AWS SDK.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.CBA_WEB_STORE = 'memory';
process.env.CBA_WEB_AUTH = 'dev';
const { handler, toNeutralRequest } = await import('../src/lambda.js');
const { runDeployedContractSuite } = await import('./deployed-contract.suite.js');

function v2Event(method, rawPath, { learner, body, query, cookies, headers, base64 } = {}) {
  let encodedBody = body !== undefined ? JSON.stringify(body) : undefined;
  if (encodedBody !== undefined && base64) {
    encodedBody = Buffer.from(encodedBody, 'utf8').toString('base64');
  }
  return {
    version: '2.0',
    rawPath,
    requestContext: { http: { method } },
    headers: { ...(learner ? { 'x-cba-learner': learner } : {}), ...(headers ?? {}) },
    ...(cookies ? { cookies } : {}),
    queryStringParameters: query,
    body: encodedBody,
    isBase64Encoded: Boolean(base64 && encodedBody !== undefined),
  };
}

async function invoke(method, rawPath, opts) {
  const res = await handler(v2Event(method, rawPath, opts));
  return { status: res.statusCode, body: JSON.parse(res.body), headers: res.headers };
}

/* ---------------- event mapping ---------------- */

test('mapping: /api prefix is stripped once; method/query/headers pass through', () => {
  const neutral = toNeutralRequest(
    v2Event('GET', '/api/attempts/att_1/missed', { learner: 'mapper', query: { limit: '5' } }),
  );
  assert.equal(neutral.method, 'GET');
  assert.equal(neutral.path, '/attempts/att_1/missed');
  assert.deepEqual(neutral.query, { limit: '5' });
  assert.equal(neutral.headers['x-cba-learner'], 'mapper');
});

test('mapping: bare /api maps to /, non-prefixed paths pass through untouched', () => {
  assert.equal(toNeutralRequest(v2Event('GET', '/api')).path, '/');
  assert.equal(toNeutralRequest(v2Event('GET', '/readiness')).path, '/readiness');
  assert.equal(toNeutralRequest(v2Event('GET', '/apiary')).path, '/apiary', 'no greedy prefix strip');
});

test('mapping: v2 cookies array is rejoined into the cookie header (identity port input)', async () => {
  const res = await invoke('GET', '/api/dashboard', { cookies: ['cba_learner=cookieKid', 'other=1'] });
  assert.equal(res.status, 200);
  // isolation proof: the cookie learner is fresh (firstRun), distinct from other suite learners
  assert.equal(res.body.firstRun, true);
});

test('mapping: an explicit cookie header is never overridden by the cookies array', () => {
  const neutral = toNeutralRequest(
    v2Event('GET', '/api/dashboard', { headers: { cookie: 'cba_learner=explicit' }, cookies: ['cba_learner=fromArray'] }),
  );
  assert.equal(neutral.headers.cookie, 'cba_learner=explicit');
});

test('mapping: base64-encoded bodies are decoded before dispatch', async () => {
  const res = await invoke('POST', '/api/practice-sessions', {
    learner: 'b64',
    body: { questionCount: 5 },
    base64: true,
  });
  assert.equal(res.status, 201);
  assert.equal(res.body.questionCount, 5);
});

/* ---------------- response shape ---------------- */

test('responses carry JSON + no-store + hardening headers on success AND error', async () => {
  for (const res of [await invoke('GET', '/api/readiness'), await invoke('GET', '/api/nope')]) {
    assert.equal(res.headers['content-type'], 'application/json; charset=utf-8');
    assert.equal(res.headers['cache-control'], 'no-store');
    assert.equal(res.headers['x-content-type-options'], 'nosniff');
    assert.equal(res.headers['referrer-policy'], 'no-referrer');
  }
});

test('errors keep the contract envelope through the Lambda transport', async () => {
  const notFound = await invoke('GET', '/api/nope');
  assert.equal(notFound.status, 404);
  assert.equal(notFound.body.error.code, 'NOT_FOUND');

  const badBody = await handler({
    version: '2.0',
    rawPath: '/api/practice-sessions',
    requestContext: { http: { method: 'POST' } },
    headers: { 'x-cba-learner': 'bad' },
    body: 'not-json',
    isBase64Encoded: false,
  });
  assert.equal(badBody.statusCode, 400);
  assert.equal(JSON.parse(badBody.body).error.code, 'VALIDATION_FAILED');
});

/* ---------------- /api/me in DEV mode (#69 Slice B local regression) ---------------- */

test('dev /api/me: deterministic provider-free profile with the §16 shape', async () => {
  const res = await invoke('GET', '/api/me', { learner: 'meDev' });
  assert.equal(res.status, 200);
  assert.deepEqual(Object.keys(res.body).sort(), ['activeExam', 'createdAt', 'displayName', 'email']);
  assert.equal(res.body.displayName, 'dev-meDev');
  assert.equal(res.body.email, 'dev-meDev@local.invalid');
  assert.deepEqual(res.body.activeExam, { examId: 'cba', name: 'Certified Backstage Associate' });
});

test('dev /api/me PUT: display name updates and persists per learner', async () => {
  const updated = await invoke('PUT', '/api/me', { learner: 'meDev', body: { displayName: 'Dev Nome' } });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.displayName, 'Dev Nome');
  const readBack = await invoke('GET', '/api/me', { learner: 'meDev' });
  assert.equal(readBack.body.displayName, 'Dev Nome');
  const other = await invoke('GET', '/api/me', { learner: 'otherDev' });
  assert.equal(other.body.displayName, 'dev-otherDev', 'profiles are per learner');
});

/* ---------------- allowlist validator: forbidden fields MUST fail ---------------- */

test('allowlist: an injected top-level correction field is a violation', async () => {
  const { allowlistViolations, ALLOWLISTS } = await import('./deployed-contract.suite.js');
  const violations = allowlistViolations(
    { done: false, index: 0, total: 5, correctOption: 'A' },
    ALLOWLISTS.drillNext,
  );
  assert.ok(violations.some((v) => v.includes('correctOption')));
});

test('allowlist: an object smuggled under an allowed leaf is a violation (no nested leak)', async () => {
  const { allowlistViolations, ALLOWLISTS } = await import('./deployed-contract.suite.js');
  // Codex repro: stem is an allowed leaf, but an OBJECT there must fail — leaves are primitives.
  const violations = allowlistViolations(
    { question: { stem: { correctOption: 'A' } } },
    ALLOWLISTS.mockView,
  );
  assert.ok(violations.some((v) => v.includes('stem')));
});

test('allowlist: a correction field nested inside an array element is a violation', async () => {
  const { allowlistViolations, ALLOWLISTS } = await import('./deployed-contract.suite.js');
  const violations = allowlistViolations(
    { question: { options: [{ key: 'A', text: 'x', isCorrect: true }] } },
    ALLOWLISTS.mockView,
  );
  assert.ok(violations.some((v) => v.includes('isCorrect')));
});

/* ---------------- full contract suite through the Lambda transport (in-process) -------------- */

runDeployedContractSuite('lambda-in-process', async (method, path, opts = {}) =>
  invoke(method, path, opts),
{ readiness: { adapter: 'memory', runtimeEnvs: ['local'] } },
);

/* ---------------- readiness gate: unhealthy/misconfigured targets MUST fail -------------- */

test('readiness gate: ready:false fails even with the right shape', async () => {
  const { assertReadiness, DEPLOYED_READINESS } = await import('./deployed-contract.suite.js');
  assert.throws(() =>
    assertReadiness({ adapter: 'dynamodb', ready: false, runtimeEnv: 'pilot' }, DEPLOYED_READINESS),
  );
});

test('readiness gate: a local adapter or runtimeEnv fails the deployed expectations', async () => {
  const { assertReadiness, DEPLOYED_READINESS } = await import('./deployed-contract.suite.js');
  assert.throws(() =>
    assertReadiness({ adapter: 'file', ready: true, runtimeEnv: 'pilot' }, DEPLOYED_READINESS),
  );
  assert.throws(() =>
    assertReadiness({ adapter: 'dynamodb', ready: true, runtimeEnv: 'local' }, DEPLOYED_READINESS),
  );
});
