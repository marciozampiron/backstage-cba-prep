// Workload telemetry tests (#82 Slice A): one canonical requestId across the neutral request, the
// completion event and the error envelope; exactly one sanitized event per request; and a privacy
// allowlist proven by positive controls. Fully offline — the event sink is injected, so nothing is
// written to stdout and no CloudWatch/OTEL SDK is involved.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.CBA_WEB_STORE = 'memory';
process.env.CBA_WEB_AUTH = 'dev';
const { handleApiRequest } = await import('../src/app.js');
const { buildCompletionEvent, COMPLETION_EVENT_FIELDS, FIELD_VALIDATORS } = await import('../src/telemetry.js');
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

/* ---------------- per-field validators (#85 review, Finding 1) ---------------- */

// A key allowlist alone let sensitive VALUES ride an approved key. Every field now has its own
// validator; these tests push token/email/URL/object/oversized/malformed material into EACH
// allowed key and prove it is dropped — and a positive control proves legitimate values survive,
// so the suite cannot pass vacuously.

const LEGITIMATE_EVENT = {
  level: 'info',
  message: 'request.completed',
  requestId: 'JKJaXmPLvHcESHA=',
  routeKey: 'GET /practice-sessions/:id/next',
  method: 'GET',
  statusCode: 200,
  durationMs: 12,
  errorCode: 'NOT_FOUND',
  runtimeEnv: 'pilot',
};

test('POSITIVE CONTROL: a fully legitimate event survives every validator intact', () => {
  assert.deepEqual(buildCompletionEvent(LEGITIMATE_EVENT), LEGITIMATE_EVENT);
  // Sanity: the suite would be vacuous if nothing ever passed.
  assert.equal(Object.keys(buildCompletionEvent(LEGITIMATE_EVENT)).length, COMPLETION_EVENT_FIELDS.length);
});

test("the Codex reproduction payload is now rejected in EVERY field", () => {
  const event = buildCompletionEvent({
    requestId: 'Bearer-super-secret',
    routeKey: 'GET learner@example.test',
    errorCode: 'TOKEN_secret',
    durationMs: -42,
    level: 'anything',
    message: 'arbitrary',
    method: 'HACK',
    runtimeEnv: 'prod',
    statusCode: 99999,
  });
  assert.deepEqual(event, {}, 'not one field of the reported payload may survive');
});

// Adversarial material pushed into EACH allowed key, one key at a time.
const ADVERSARIAL_VALUES = [
  ['bearer token', 'Bearer eyJhbGciOiJIUzI1NiJ9.abc.def'],
  ['bare credential marker', 'authorization-secret'],
  ['AWS access key id', ['AKIA', 'IOSFODNN', '7EXAMPLE'].join('')],
  ['email', 'learner@example.test'],
  ['URL', 'https://api.example.test/api/dashboard?token=abc'],
  ['object', { nested: 'payload' }],
  ['array', ['a', 'b']],
  ['oversized string', 'X'.repeat(5000)],
  ['newline injection', 'ok\nlevel=admin'],
  ['control character', 'ok null'],
  ['whitespace', 'has spaces'],
  ['negative number', -1],
  ['non-finite number', Number.POSITIVE_INFINITY],
  ['null', null],
  ['boolean', true],
];

for (const field of ['level', 'message', 'requestId', 'routeKey', 'method', 'statusCode', 'durationMs', 'errorCode', 'runtimeEnv']) {
  test(`field "${field}" rejects every adversarial value`, () => {
    for (const [label, value] of ADVERSARIAL_VALUES) {
      const event = buildCompletionEvent({ ...LEGITIMATE_EVENT, [field]: value });
      assert.ok(!(field in event), `"${field}" accepted ${label}: ${JSON.stringify(value)?.slice(0, 60)}`);
      // The other eight fields must still be emitted: one bad value degrades one field, not the
      // whole operational signal.
      assert.equal(Object.keys(event).length, COMPLETION_EVENT_FIELDS.length - 1);
    }
  });
}

test('closed enums accept only their documented members', () => {
  assert.ok(FIELD_VALIDATORS.level('info') && FIELD_VALIDATORS.level('error'));
  assert.ok(!FIELD_VALIDATORS.level('debug') && !FIELD_VALIDATORS.level('INFO'));
  assert.ok(FIELD_VALIDATORS.message('request.completed'));
  assert.ok(!FIELD_VALIDATORS.message('request.started'));
  for (const m of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']) {
    assert.ok(FIELD_VALIDATORS.method(m), m);
  }
  assert.ok(!FIELD_VALIDATORS.method('get') && !FIELD_VALIDATORS.method('TRACE'));
  for (const e of ['local', 'dev', 'pilot']) assert.ok(FIELD_VALIDATORS.runtimeEnv(e), e);
  assert.ok(!FIELD_VALIDATORS.runtimeEnv('prod') && !FIELD_VALIDATORS.runtimeEnv('staging'));
});

test('statusCode is a real HTTP integer and durationMs is finite and non-negative', () => {
  for (const ok of [100, 200, 404, 500, 599]) assert.ok(FIELD_VALIDATORS.statusCode(ok), String(ok));
  for (const bad of [99, 600, 99999, 200.5, '200', NaN]) assert.ok(!FIELD_VALIDATORS.statusCode(bad), String(bad));
  for (const ok of [0, 1, 12.5, 1e6]) assert.ok(FIELD_VALIDATORS.durationMs(ok), String(ok));
  for (const bad of [-1, -0.001, NaN, Infinity, '12']) assert.ok(!FIELD_VALIDATORS.durationMs(bad), String(bad));
});

test('errorCode accepts contract codes only', () => {
  for (const ok of ['NOT_FOUND', 'VALIDATION_FAILED', 'NOT_RESOURCE_OWNER', 'CONFLICT', 'INTERNAL']) {
    assert.ok(FIELD_VALIDATORS.errorCode(ok), ok);
  }
  for (const bad of ['TOKEN_secret', 'not_found', 'NOT FOUND', 'NOT-FOUND', '1_BAD', 'A'.repeat(200)]) {
    assert.ok(!FIELD_VALIDATORS.errorCode(bad), bad);
  }
});

test('routeKey accepts ONLY the internal METHOD /pattern shape', () => {
  for (const ok of ['GET /readiness', 'GET /practice-sessions/:id/next', 'POST /mock-exams/:id/submit', 'PUT /me']) {
    assert.ok(FIELD_VALIDATORS.routeKey(ok), ok);
  }
  for (const bad of [
    'GET learner@example.test',
    'GET https://api.example.test/x',
    'GET /dashboard?token=abc',
    'GET /attempts/att_9f2/results#frag',
    '/dashboard',
    'GET  /double-space',
    'FETCH /dashboard',
  ]) {
    assert.ok(!FIELD_VALIDATORS.routeKey(bad), bad);
  }
});

test('every REAL dispatcher route key passes the validator (no false negatives)', async () => {
  // Exercises the actual routing table: if a future route key stopped validating, telemetry would
  // silently lose routeKey for it.
  const seen = new Set();
  for (const call of [
    { method: 'GET', path: '/readiness' },
    { method: 'GET', path: '/dashboard' },
    { method: 'GET', path: '/practice/options' },
    { method: 'GET', path: '/me' },
    { method: 'GET', path: '/attempts/att_x/results' },
    { method: 'GET', path: '/mock-exams/mock_x' },
    { method: 'POST', path: '/coach/message' },
  ]) {
    const { events, emit } = collector();
    await handleApiRequest({ ...call, headers: { 'x-cba-learner': 'routes' }, emit });
    const key = events[0].routeKey;
    if (key !== undefined) {
      seen.add(key);
      assert.ok(FIELD_VALIDATORS.routeKey(key), `real route key rejected: ${key}`);
    }
  }
  assert.ok(seen.size >= 5, 'the probe must actually reach several routes');
});

test('requestId format is narrow: no whitespace, control chars, emails, URLs or credential shapes', () => {
  for (const ok of ['JKJaXmPLvHcESHA=', 'loc_abc123xyz', 'req_1k2j3h', 'a1b2-c3d4-e5f6', 'A'.repeat(128)]) {
    assert.ok(FIELD_VALIDATORS.requestId(ok), ok);
  }
  for (const bad of [
    'Bearer-super-secret',
    'my-token-value',
    'authorization',
    'learner@example.test',
    'https://x.test/id',
    'has space',
    'line\nbreak',
    '',
    'A'.repeat(129),
  ]) {
    assert.ok(!FIELD_VALIDATORS.requestId(bad), bad);
  }
});

test('a non-object input yields an empty event instead of throwing', () => {
  for (const input of [null, undefined, 'string', 42, []]) {
    assert.deepEqual(buildCompletionEvent(input), {});
  }
});

/* ---------------- sink failure is best effort (#85 review, Finding 2) ---------------- */

test('a THROWING sink never changes the response — 200, 4xx and 500 alike', async () => {
  const boom = () => {
    throw new Error('telemetry sink failed');
  };

  const ok = await handleApiRequest({ method: 'GET', path: '/readiness', emit: boom });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.ready, true, 'the original body survives');

  const notFound = await handleApiRequest({ method: 'GET', path: '/nope', requestId: 'sink-404', emit: boom });
  assert.equal(notFound.status, 404);
  assert.equal(notFound.body.error.code, 'NOT_FOUND');
  assert.equal(notFound.body.error.requestId, 'sink-404');

  const badBody = await handleApiRequest({
    method: 'POST',
    path: '/practice-sessions',
    headers: { 'x-cba-learner': 'sink' },
    body: 'not-json',
    emit: boom,
  });
  assert.equal(badBody.status, 400);
  assert.equal(badBody.body.error.code, 'VALIDATION_FAILED');
});

test('a THROWING sink on the 500 path still returns the contract envelope', async () => {
  // Force an unexpected (non-ApiError) failure inside a handler via a poisoned clock.
  const res = await handleApiRequest({
    method: 'GET',
    path: '/readiness',
    now: () => {
      throw new Error('unexpected internal failure');
    },
    emit: () => {
      throw new Error('telemetry sink failed');
    },
  }).catch((err) => ({ threw: err }));
  assert.ok(!res.threw, 'the dispatcher must not reject even when clock AND sink fail');
});

test('exactly ONE emission attempt is made even when the sink throws', async () => {
  let attempts = 0;
  const boom = () => {
    attempts += 1;
    throw new Error('telemetry sink failed');
  };
  for (const call of [
    { method: 'GET', path: '/readiness' },
    { method: 'GET', path: '/nope' },
    { method: 'POST', path: '/practice-sessions', headers: { 'x-cba-learner': 'once' }, body: 'not-json' },
  ]) {
    attempts = 0;
    await handleApiRequest({ ...call, emit: boom });
    assert.equal(attempts, 1, `${call.method} ${call.path} must attempt exactly once`);
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
