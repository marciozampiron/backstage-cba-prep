// #90 (SEC-WEB-01 / SEC-AI-05): the application-owned bounds on expensive creations, exercised
// through the REAL dispatcher in process — no network, no AWS. The stage throttle is the
// infra half (asserted from synthesized IaC in infra/aws/test/api-stack.test.js); this half
// proves the per-principal contract: partitioned by trusted identity, not bypassable by anything
// the caller supplies, 429 with the stable privacy-safe envelope, and normal flows untouched.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.CBA_WEB_STORE = 'memory';
process.env.CBA_WEB_AUTH = 'dev';
const { handleApiRequest } = await import('../src/index.js');
const { RATE_BOUNDS, windowStartOf, rateWindowKey } = await import('../src/rate-limit.js');

// A frozen clock per test: the window is a function of `now`, so tests own time completely and
// can cross a window boundary deterministically instead of sleeping.
function callAt(nowMs, method, path, { learner, body, headers = {} } = {}) {
  return handleApiRequest({
    method,
    path,
    headers: learner ? { 'x-cba-learner': learner, ...headers } : headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    now: () => nowMs,
  });
}

const T0 = 1_755_800_000_000; // an arbitrary fixed instant; only its window arithmetic matters

test('the bound table is the reviewed one: closed, frozen, at or below the dev stage default', () => {
  assert.deepEqual(Object.keys(RATE_BOUNDS).sort(), [
    'POST /coach/message',
    'POST /mock-exams',
    'POST /practice-sessions',
    'POST /smoke-runs',
  ]);
  for (const [routeKey, bound] of Object.entries(RATE_BOUNDS)) {
    assert.ok(Object.isFrozen(bound), `${routeKey}: the bound is immutable`);
    assert.ok(bound.limit >= 1 && bound.windowMs >= 1000, routeKey);
    // "Equal to or lower than the stage default": per-second equivalent under dev's 10 r/s.
    assert.ok(bound.limit / (bound.windowMs / 1000) <= 10, `${routeKey}: within the stage baseline`);
  }
  assert.ok(Object.isFrozen(RATE_BOUNDS));
  assert.equal(windowStartOf(120_500, 60_000), 120_000, 'the floor of the window');
  assert.equal(windowStartOf(179_999, 60_000), 120_000, 'same minute, same window');
  assert.equal(windowStartOf(180_000, 60_000), 180_000, 'next minute, next window');
  assert.equal(rateWindowKey('l1', 'POST /mock-exams', 60_000), ['l1', 'POST /mock-exams', '60000'].join('\u0000'));
  // Injection resistance: the separator is NUL because a header cannot carry one — a learner id
  // crafted with spaces must NOT be able to land in another caller's partition.
  assert.notEqual(
    rateWindowKey('l1 POST /mock-exams', 'POST /coach/message', 60_000),
    rateWindowKey('l1', 'POST /mock-exams POST /coach/message', 60_000),
  );
});

test('the sixth mock creation in a window is refused with the stable 429 envelope', async () => {
  const learner = 'rl_mock_a';
  const okays = [];
  for (let i = 0; i < 5; i += 1) okays.push(await callAt(T0 + i, 'POST', '/mock-exams', { learner, body: {} }));
  // The use case itself may refuse a SECOND active mock (409) — that is its own contract. What
  // the bound owns is that the requests were ADMITTED to the handler: none of the five is a 429.
  for (const res of okays) assert.notEqual(res.status, 429);
  const sixth = await callAt(T0 + 5, 'POST', '/mock-exams', { learner, body: {} });
  assert.equal(sixth.status, 429);
  assert.equal(sixth.body.error.code, 'RATE_LIMITED');
  assert.equal(sixth.body.error.message, 'Too many requests for this operation. Retry shortly.');
  assert.match(sixth.body.error.requestId, /^req_/);
  // Privacy-safe: the envelope names nothing about the caller, the counts or the window.
  const text = JSON.stringify(sixth.body);
  assert.equal(text.includes(learner), false, 'no learner identifier in the refusal');
  assert.equal(/limit|window|count|quota|\b\d{2,}\b/i.test(sixth.body.error.message), false, 'no calibratable internals');
});

test('the partition is the TRUSTED identity: another learner keeps their whole budget', async () => {
  const a = 'rl_part_a';
  const b = 'rl_part_b';
  for (let i = 0; i < 10; i += 1) await callAt(T0 + i, 'POST', '/coach/message', { learner: a, body: { action: 'next-step' } });
  const refusedA = await callAt(T0 + 11, 'POST', '/coach/message', { learner: a, body: { action: 'next-step' } });
  assert.equal(refusedA.status, 429, 'A exhausted A\'s budget');
  const freshB = await callAt(T0 + 12, 'POST', '/coach/message', { learner: b, body: { action: 'next-step' } });
  assert.notEqual(freshB.status, 429, 'B\'s budget is B\'s');
});

test('caller-supplied identifiers cannot buy a fresh window', async () => {
  const learner = 'rl_bypass_a';
  for (let i = 0; i < 5; i += 1) await callAt(T0 + i, 'POST', '/mock-exams', { learner, body: {} });
  // Everything a caller controls goes into the request; none of it may move the partition:
  // a learnerId in the body, a foreign id in the query, a spoofed forwarded header.
  const attempts = [
    { body: { learnerId: 'somebody_else' } },
    { body: { learner: 'rl_bypass_b', examId: 'cba' } },
    { body: {}, headers: { 'x-forwarded-for': '10.0.0.99', 'x-cba-request-id': 'forged' } },
  ];
  for (const attempt of attempts) {
    const res = await callAt(T0 + 20, 'POST', '/mock-exams', { learner, ...attempt });
    assert.equal(res.status, 429, JSON.stringify(attempt));
  }
});

test('the window rolls over: the same caller is admitted again in the next window', async () => {
  const learner = 'rl_roll_a';
  for (let i = 0; i < 5; i += 1) await callAt(T0 + i, 'POST', '/smoke-runs', { learner });
  const refused = await callAt(T0 + 6, 'POST', '/smoke-runs', { learner });
  assert.equal(refused.status, 429);
  const nextWindow = await callAt(T0 + 60_000, 'POST', '/smoke-runs', { learner });
  assert.notEqual(nextWindow.status, 429, 'a bound is a rate, not a ban');
});

test('the refusal happens BEFORE the handler and before the body is parsed', async () => {
  const learner = 'rl_early_a';
  for (let i = 0; i < 5; i += 1) await callAt(T0 + i, 'POST', '/mock-exams', { learner, body: {} });
  // A body that would 400 on parse still gets the 429: nothing caller-supplied ran.
  const res = await handleApiRequest({
    method: 'POST',
    path: '/mock-exams',
    headers: { 'x-cba-learner': learner },
    body: 'this is not json {{{',
    now: () => T0 + 10,
  });
  assert.equal(res.status, 429, 'the bound answers before body parsing can');
});

test('unbounded routes are untouched: reads and answers never see a 429 from this layer', async () => {
  const learner = 'rl_free_a';
  for (let i = 0; i < 25; i += 1) {
    const res = await callAt(T0 + i, 'GET', '/dashboard', { learner });
    assert.equal(res.status, 200, `read ${i + 1}`);
  }
  // A normal drill flow: one bounded creation, then unbounded answer traffic.
  const drill = await callAt(T0, 'POST', '/practice-sessions', { learner, body: { questionCount: 5 } });
  assert.equal(drill.status, 201, JSON.stringify(drill.body));
  for (let i = 0; i < 5; i += 1) {
    const next = await callAt(T0 + 100 + i, 'GET', `/practice-sessions/${drill.body.practiceSessionId}/next`, { learner });
    assert.equal(next.status, 200);
    const answer = await callAt(T0 + 200 + i, 'POST', `/practice-sessions/${drill.body.practiceSessionId}/answers`, {
      learner,
      body: {
        index: next.body.index,
        questionVersionId: next.body.question.questionVersionId,
        selectedOption: 'A',
        timeSpentSeconds: 3,
      },
    });
    assert.equal(answer.status, 200, JSON.stringify(answer.body));
  }
});

test('the anonymous readiness route is outside this layer entirely — the stage throttle owns it', async () => {
  for (let i = 0; i < 30; i += 1) {
    const res = await callAt(T0 + i, 'GET', '/readiness', {});
    assert.equal(res.status, 200, `readiness ${i + 1}`);
  }
});
