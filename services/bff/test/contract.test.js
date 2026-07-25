// Offline contract harness (#76): exercises the learner API surface purely in process — no
// Next.js, Lambda, API Gateway, AWS credentials, or network. Covers the #36/#38 contract rules
// the runtimes must never drift from: success shapes, ownership, idempotency, and the exam-mode
// pre-submit leak rules (with a post-submit positive control).
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.CBA_WEB_STORE = 'memory';
process.env.CBA_WEB_AUTH = 'dev';
const { handleApiRequest } = await import('../src/index.js');

function call(method, path, { learner, body, query } = {}) {
  return handleApiRequest({
    method,
    path,
    query,
    headers: learner ? { 'x-cba-learner': learner } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

// Exam-mode guard: no correction/grounding data anywhere in a payload (recursive).
const FORBIDDEN_PRE_SUBMIT = ['correctOption', 'isCorrect', 'correct', 'explanation', 'whyOthersWrong', 'sourceRefs'];
function forbiddenKeysIn(value, found = new Set()) {
  if (Array.isArray(value)) value.forEach((v) => forbiddenKeysIn(v, found));
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (FORBIDDEN_PRE_SUBMIT.includes(k)) found.add(k);
      forbiddenKeysIn(v, found);
    }
  }
  return [...found];
}

/* ---------------- transport basics ---------------- */

test('unknown route returns the 404 contract envelope', async () => {
  const res = await call('GET', '/nope');
  assert.equal(res.status, 404);
  assert.equal(res.body.error.code, 'NOT_FOUND');
  assert.match(res.body.error.requestId, /^req_/);
});

test('required-JSON endpoints reject a non-JSON body with 400', async () => {
  const res = await handleApiRequest({
    method: 'POST',
    path: '/practice-sessions',
    headers: { 'x-cba-learner': 'hx' },
    body: 'not-json',
  });
  assert.equal(res.status, 400);
  assert.equal(res.body.error.code, 'VALIDATION_FAILED');
});

test('mock start tolerates an empty body (optional-JSON policy)', async () => {
  const res = await handleApiRequest({
    method: 'POST',
    path: '/mock-exams',
    headers: { 'x-cba-learner': 'hMockBody' },
    body: '',
  });
  assert.equal(res.status, 201);
});

/* ---------------- dashboard / options ---------------- */

test('dashboard first-run shape', async () => {
  const res = await call('GET', '/dashboard', { learner: 'hFresh' });
  assert.equal(res.status, 200);
  assert.equal(res.body.firstRun, true);
  assert.equal(res.body.readiness.percent, null);
  assert.equal(res.body.coachNudge.mode, 'deterministic');
  assert.equal(res.body.recommendedDrill.reason, 'warm_up');
});

test('practice options lists domains and the fixed count/difficulty sets', async () => {
  const res = await call('GET', '/practice/options', { learner: 'hFresh' });
  assert.equal(res.status, 200);
  assert.equal(res.body.domains.length, 4);
  assert.deepEqual(res.body.questionCounts, [5, 10, 20]);
  assert.deepEqual(res.body.difficulties, ['mixed', 'easy', 'medium', 'hard']);
});

/* ---------------- practice drill: success + idempotency ---------------- */

async function startDrillFor(learner) {
  const res = await call('POST', '/practice-sessions', { learner, body: { questionCount: 5 } });
  assert.equal(res.status, 201);
  return res.body;
}

test('drill happy path: start -> next -> answer feedback -> completion -> results', async () => {
  const learner = 'hDrill';
  const drill = await startDrillFor(learner);
  assert.equal(drill.kind, 'practice');

  for (let i = 0; i < 5; i++) {
    const next = await call('GET', `/practice-sessions/${drill.practiceSessionId}/next`, { learner });
    assert.equal(next.status, 200);
    assert.equal(next.body.done, false);
    // pre-answer question payload never leaks correction data
    assert.deepEqual(forbiddenKeysIn(next.body), []);

    const answer = await call('POST', `/practice-sessions/${drill.practiceSessionId}/answers`, {
      learner,
      body: {
        index: next.body.index,
        questionVersionId: next.body.question.questionVersionId,
        selectedOption: next.body.question.options[0].key,
      },
    });
    assert.equal(answer.status, 200);
    // practice mode DOES return grounded feedback immediately (contract §10)
    assert.ok('correct' in answer.body);
    assert.ok(answer.body.correctOption);
    assert.ok(answer.body.explanation);
    assert.ok(Array.isArray(answer.body.sourceRefs));
  }

  const doneNext = await call('GET', `/practice-sessions/${drill.practiceSessionId}/next`, { learner });
  assert.equal(doneNext.body.done, true);

  const results = await call('GET', `/attempts/${drill.attemptId}/results`, { learner });
  assert.equal(results.status, 200);
  assert.equal(results.body.score.total, 5);
  assert.equal(results.body.coachSummary.mode, 'deterministic');
});

test('practice answer idempotency: identical re-post is safe, different selection is 409', async () => {
  const learner = 'hIdem';
  const drill = await startDrillFor(learner);
  const next = await call('GET', `/practice-sessions/${drill.practiceSessionId}/next`, { learner });
  const { index, question } = next.body;
  const first = question.options[0].key;
  const other = question.options[1].key;

  const payload = { index, questionVersionId: question.questionVersionId, selectedOption: first };
  const a1 = await call('POST', `/practice-sessions/${drill.practiceSessionId}/answers`, { learner, body: payload });
  assert.equal(a1.status, 200);
  const a2 = await call('POST', `/practice-sessions/${drill.practiceSessionId}/answers`, { learner, body: payload });
  assert.equal(a2.status, 200, 'identical re-post is a safe retry');
  assert.equal(a2.body.correct, a1.body.correct);

  const a3 = await call('POST', `/practice-sessions/${drill.practiceSessionId}/answers`, {
    learner,
    body: { ...payload, selectedOption: other },
  });
  assert.equal(a3.status, 409);
  assert.equal(a3.body.error.code, 'ALREADY_ANSWERED');
});

test('pinned-version rule: mismatched questionVersionId is 409 VERSION_MISMATCH', async () => {
  const learner = 'hVer';
  const drill = await startDrillFor(learner);
  const next = await call('GET', `/practice-sessions/${drill.practiceSessionId}/next`, { learner });
  const res = await call('POST', `/practice-sessions/${drill.practiceSessionId}/answers`, {
    learner,
    body: { index: next.body.index, questionVersionId: 'qv_wrong_v1', selectedOption: 'A' },
  });
  assert.equal(res.status, 409);
  assert.equal(res.body.error.code, 'VERSION_MISMATCH');
});

/* ---------------- ownership ---------------- */

test('ownership: another learner gets 403 NOT_RESOURCE_OWNER (not 404) on sessions, attempts, mocks', async () => {
  const owner = 'hOwner';
  const intruder = 'hIntruder';
  const drill = await startDrillFor(owner);

  const s = await call('GET', `/practice-sessions/${drill.practiceSessionId}/next`, { learner: intruder });
  assert.equal(s.status, 403);
  assert.equal(s.body.error.code, 'NOT_RESOURCE_OWNER');

  const r = await call('GET', `/attempts/${drill.attemptId}/results`, { learner: intruder });
  assert.equal(r.status, 403);
  assert.equal(r.body.error.code, 'NOT_RESOURCE_OWNER');

  const mock = await call('POST', '/mock-exams', { learner: owner, body: {} });
  assert.equal(mock.status, 201);
  const m = await call('GET', `/mock-exams/${mock.body.mockExamId}`, { learner: intruder });
  assert.equal(m.status, 403);
  assert.equal(m.body.error.code, 'NOT_RESOURCE_OWNER');
});

/* ---------------- mock exam: exam-mode leak rules + idempotent submit ---------------- */

test('mock exam-mode: pre-submit payloads never leak correction data; submit is idempotent; post-submit is the positive control', async () => {
  const learner = 'hMock';

  const start = await call('POST', '/mock-exams', { learner, body: {} });
  assert.equal(start.status, 201);
  assert.deepEqual(forbiddenKeysIn(start.body), [], 'start payload must carry refs only');
  assert.equal(start.body.questions.length, 60);
  assert.ok(!('stem' in start.body.questions[0]), 'start payload carries no stems');

  const second = await call('POST', '/mock-exams', { learner, body: {} });
  assert.equal(second.status, 409);
  assert.equal(second.body.error.code, 'MOCK_EXAM_IN_PROGRESS');

  const mockId = start.body.mockExamId;
  const view = await call('GET', `/mock-exams/${mockId}`, { learner });
  assert.equal(view.status, 200);
  assert.deepEqual(forbiddenKeysIn(view.body), [], 'question view must stay correction-free');

  const save = await call('POST', `/mock-exams/${mockId}/answers`, {
    learner,
    body: {
      index: view.body.question.index,
      questionVersionId: view.body.question.questionVersionId,
      selectedOption: view.body.question.options[0].key,
    },
  });
  assert.equal(save.status, 200);
  assert.deepEqual(forbiddenKeysIn(save.body), [], 'silent save: no feedback of any kind');
  assert.equal(save.body.saved, true);

  // pre-submit: results and missed review are both 409
  const early = await call('GET', `/attempts/${start.body.attemptId}/results`, { learner });
  assert.equal(early.status, 409);
  assert.equal(early.body.error.code, 'ATTEMPT_NOT_COMPLETED');
  const earlyMissed = await call('GET', `/attempts/${start.body.attemptId}/missed`, { learner });
  assert.equal(earlyMissed.status, 409);

  const submit1 = await call('POST', `/mock-exams/${mockId}/submit`, { learner });
  assert.equal(submit1.status, 200);
  assert.equal(submit1.body.status, 'submitted');
  const submit2 = await call('POST', `/mock-exams/${mockId}/submit`, { learner });
  assert.equal(submit2.status, 200, 'submit is idempotent');
  assert.equal(submit2.body.attemptId, submit1.body.attemptId);
  assert.equal(submit2.body.submittedAt, submit1.body.submittedAt);

  // positive control: AFTER submit the correction fields exist (proves the scanner catches them)
  const results = await call('GET', `/attempts/${start.body.attemptId}/results`, { learner });
  assert.equal(results.status, 200);
  assert.equal(results.body.score.total, 60);
  const missed = await call('GET', `/attempts/${start.body.attemptId}/missed`, { learner });
  assert.equal(missed.status, 200);
  assert.ok(missed.body.totalMissed > 0, 'unanswered questions count as missed');
  const leaked = forbiddenKeysIn(missed.body);
  assert.ok(leaked.includes('correctOption') && leaked.includes('explanation'),
    'post-submit review MUST carry correction data — otherwise the scanner is broken');
});

/* ---------------- deterministic coach ---------------- */

test('coach: deterministic mode only; unknown action is 400', async () => {
  const rec = await call('POST', '/coach/message', { learner: 'hCoach', body: { action: 'recommend_next' } });
  assert.equal(rec.status, 200);
  assert.equal(rec.body.mode, 'deterministic');
  assert.ok(rec.body.recommendedAction);

  const bad = await call('POST', '/coach/message', { learner: 'hCoach', body: { action: 'free_chat' } });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error.code, 'VALIDATION_FAILED');
});

/* ---------------- identity (dev provider via neutral headers) ---------------- */

test('identity: header learner is namespaced; absent header falls back to the deterministic dev learner', async () => {
  const a = await call('GET', '/dashboard', { learner: 'idA' });
  assert.equal(a.status, 200);
  const anon = await handleApiRequest({ method: 'GET', path: '/dashboard', headers: {} });
  assert.equal(anon.status, 200);
  // isolation: idA's drill must not appear for the anonymous dev learner
  await startDrillFor('idA');
  const anonDash = await handleApiRequest({ method: 'GET', path: '/dashboard', headers: {} });
  assert.equal(anonDash.body.recentAttempts.length, 0);
});
