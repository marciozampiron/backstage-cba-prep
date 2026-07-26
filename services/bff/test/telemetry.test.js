// Workload telemetry tests (#82 Slice A): one canonical requestId across the neutral request, the
// completion event and the error envelope; exactly one sanitized event per request; and a privacy
// allowlist proven by positive controls. Fully offline — the event sink is injected, so nothing is
// written to stdout and no CloudWatch/OTEL SDK is involved.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.CBA_WEB_STORE = 'memory';
process.env.CBA_WEB_AUTH = 'dev';
const { handleApiRequest } = await import('../src/app.js');
const { buildCompletionEvent, COMPLETION_EVENT_FIELDS } = await import('../src/telemetry.js');
const { handler, toNeutralRequest } = await import('../src/lambda.js');

/** Collect completion events instead of printing them. */
function collector() {
  const events = [];
  return { events, emit: (event) => events.push(event) };
}

function v2Event(method, rawPath, { requestId = 'apigw-req-1', learner, body } = {}) {
  return {
    version: '2.0',
    rawPath,
    requestContext: { requestId, http: { method } },
    headers: learner ? { 'x-cba-learner': learner } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
    isBase64Encoded: false,
  };
}

/* ---------------- canonical requestId ---------------- */

test('the Lambda transport copies $context.requestId into the neutral request UNCHANGED', () => {
  const neutral = toNeutralRequest(v2Event('GET', '/api/dashboard', { requestId: 'abc-123-XYZ' }));
  assert.equal(neutral.requestId, 'abc-123-XYZ');
});

test('context.awsRequestId is never used as the correlation key', () => {
  // A forged event carrying BOTH: only the API Gateway value may surface.
  const event = v2Event('GET', '/api/dashboard', { requestId: 'apigw-value' });
  event.requestContext.awsRequestId = 'lambda-invocation-value';
  const neutral = toNeutralRequest(event);
  assert.equal(neutral.requestId, 'apigw-value');
  assert.notEqual(neutral.requestId, 'lambda-invocation-value');
});

test('the SAME id appears in the completion event and in the error envelope', async () => {
  const { events, emit } = collector();
  const res = await handleApiRequest({ method: 'GET', path: '/nope', requestId: 'one-and-only', emit });
  assert.equal(res.status, 404);
  assert.equal(res.body.error.requestId, 'one-and-only', 'error envelope carries the canonical id');
  assert.equal(events.length, 1);
  assert.equal(events[0].requestId, 'one-and-only', 'completion event carries the same id');
});

test('a successful request reports the same id it was given', async () => {
  const { events, emit } = collector();
  const res = await handleApiRequest({
    method: 'GET',
    path: '/readiness',
    requestId: 'success-id',
    emit,
  });
  assert.equal(res.status, 200);
  assert.equal(events[0].requestId, 'success-id');
});

test('NEGATIVE CONTROL: a second generated id would fail the same-id assertion', async () => {
  const { events, emit } = collector();
  const res = await handleApiRequest({ method: 'GET', path: '/nope', requestId: 'supplied-id', emit });
  // The dispatcher's fallback shape is `req_<base36>`; if it ever minted one despite a supplied
  // id, these assertions catch it in BOTH places.
  assert.ok(!/^req_/.test(res.body.error.requestId), 'no generated id in the envelope');
  assert.ok(!/^req_/.test(events[0].requestId), 'no generated id in the completion event');
  assert.equal(res.body.error.requestId, events[0].requestId);
});

test('a direct caller without an id still gets ONE id, shared by both surfaces', async () => {
  const { events, emit } = collector();
  const res = await handleApiRequest({ method: 'GET', path: '/nope', emit });
  assert.match(res.body.error.requestId, /^req_/, 'fallback only when nothing was supplied');
  assert.equal(res.body.error.requestId, events[0].requestId, 'still exactly one id per request');
});

test('blank/whitespace ids are treated as absent rather than propagated', async () => {
  for (const supplied of ['', '   ', null, undefined]) {
    const { events, emit } = collector();
    const res = await handleApiRequest({ method: 'GET', path: '/nope', requestId: supplied, emit });
    assert.match(res.body.error.requestId, /^req_/);
    assert.equal(res.body.error.requestId, events[0].requestId);
  }
});

test('end to end through the Lambda handler: envelope id equals the API Gateway id', async () => {
  const res = await handler(v2Event('GET', '/api/definitely-not-a-route', { requestId: 'gw-999' }));
  assert.equal(JSON.parse(res.body).error.requestId, 'gw-999');
});

/* ---------------- exactly one event per request ---------------- */

test('exactly ONE completion event per request — success, contract error and 404 alike', async () => {
  for (const call of [
    { method: 'GET', path: '/readiness' },
    { method: 'GET', path: '/nope' },
    { method: 'POST', path: '/practice-sessions', headers: { 'x-cba-learner': 'telemetry' }, body: 'not-json' },
  ]) {
    const { events, emit } = collector();
    await handleApiRequest({ ...call, emit });
    assert.equal(events.length, 1, `${call.method} ${call.path} must emit one event`);
  }
});

/* ---------------- allowlist and cardinality ---------------- */

test('routeKey is the bounded route PATTERN, never the concrete path with ids', async () => {
  const { events, emit } = collector();
  const start = await handleApiRequest({
    method: 'POST',
    path: '/practice-sessions',
    headers: { 'x-cba-learner': 'routekey' },
    body: { questionCount: 5 },
    emit,
  });
  const sessionId = start.body.practiceSessionId;
  const next = collector();
  await handleApiRequest({
    method: 'GET',
    path: `/practice-sessions/${sessionId}/next`,
    headers: { 'x-cba-learner': 'routekey' },
    emit: next.emit,
  });
  assert.equal(next.events[0].routeKey, 'GET /practice-sessions/:id/next');
  assert.ok(!next.events[0].routeKey.includes(sessionId), 'the concrete id must not widen cardinality');
  assert.equal(events[0].routeKey, 'POST /practice-sessions');
});

test('the completion event carries ONLY allowlisted fields', async () => {
  const { events, emit } = collector();
  await handleApiRequest({
    method: 'POST',
    path: '/practice-sessions',
    headers: { 'x-cba-learner': 'allowlist', authorization: 'Bearer super-secret', cookie: 'cba_learner=x' },
    body: { questionCount: 5 },
    emit,
  });
  for (const key of Object.keys(events[0])) {
    assert.ok(COMPLETION_EVENT_FIELDS.includes(key), `"${key}" is not in the allowlist`);
  }
});

test('POSITIVE CONTROL: forbidden material is dropped even when handed straight to the builder', () => {
  const event = buildCompletionEvent({
    level: 'info',
    requestId: 'r1',
    routeKey: 'GET /dashboard',
    // Everything below is forbidden by the privacy contract and must not survive:
    authorization: 'Bearer token-value',
    cookie: 'cba_learner=abc',
    email: 'learner@example.test',
    learnerId: 'cognito-sub-123',
    attemptId: 'att_1',
    questionStem: 'Which Backstage plugin...',
    correctOption: 'B',
    body: { answer: 'B' },
    url: 'https://api.example.test/api/dashboard',
    tableName: 'cba-study-coach-pilot-simulation',
  });
  assert.deepEqual(Object.keys(event).sort(), ['level', 'requestId', 'routeKey']);
  const serialized = JSON.stringify(event);
  for (const leak of ['Bearer', 'cba_learner', 'example.test', 'cognito-sub', 'att_1', 'Backstage', 'simulation']) {
    assert.ok(!serialized.includes(leak), `"${leak}" leaked into the event`);
  }
});

test('POSITIVE CONTROL: non-scalar and oversized values are dropped from allowlisted fields too', () => {
  const event = buildCompletionEvent({
    requestId: 'r1',
    message: { nested: 'object' },
    routeKey: ['array'],
    errorCode: 'X'.repeat(500),
    statusCode: 200,
  });
  assert.deepEqual(Object.keys(event).sort(), ['requestId', 'statusCode']);
});

test('a real request never emits a learner id, token, cookie, body or exam content', async () => {
  const { events, emit } = collector();
  const start = await handleApiRequest({
    method: 'POST',
    path: '/mock-exams',
    headers: { 'x-cba-learner': 'privacy', authorization: 'Bearer tok', cookie: 'cba_learner=privacy' },
    body: {},
    emit,
  });
  const serialized = JSON.stringify(events[0]);
  for (const leak of ['privacy', 'Bearer', 'tok', 'cba_learner', start.body.mockExamId, start.body.attemptId]) {
    assert.ok(!serialized.includes(leak), `"${leak}" leaked into the completion event`);
  }
});

test('the event reports status, duration and errorCode without any payload', async () => {
  const { events, emit } = collector();
  let clock = 1000;
  await handleApiRequest({
    method: 'GET',
    path: '/nope',
    requestId: 'timed',
    now: () => (clock += 25),
    emit,
  });
  const event = events[0];
  assert.equal(event.statusCode, 404);
  assert.equal(event.errorCode, 'NOT_FOUND');
  assert.equal(event.method, 'GET');
  assert.equal(event.level, 'info');
  assert.ok(typeof event.durationMs === 'number' && event.durationMs >= 0);
});
