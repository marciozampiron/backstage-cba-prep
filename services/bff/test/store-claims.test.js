// Active-mock claim lifecycle regressions (#77 review): a claim left behind by a PARTIAL FAILURE
// (attempt finalized but a later save/release crashed) must never lock the learner out — the
// sweep releases any claim whose attempt is not in_progress. Runs the real store through the
// dispatcher with an injected memory repository.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.CBA_WEB_STORE = 'memory';
process.env.CBA_WEB_AUTH = 'dev';
const { handleApiRequest, configureRuntime, resetRuntime, InMemorySimulationRepository } =
  await import('../src/index.js');

function call(method, path, learner, body) {
  return handleApiRequest({
    method,
    path,
    headers: { 'x-cba-learner': learner },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

test('partial failure: submitted attempt with a surviving claim is swept — the learner can start again', async () => {
  const repo = new InMemorySimulationRepository();
  configureRuntime({ repository: repo });
  try {
    // Simulate the torn state: claim held, mock + attempt persisted, attempt already submitted —
    // exactly what remains when finalize saved the attempt but crashed before releasing.
    await repo.claimActiveMock('dev-torn', 'mock_torn');
    await repo.saveMock({ mockExamId: 'mock_torn', attemptId: 'att_torn', learnerId: 'dev-torn', autoSubmitted: false });
    await repo.saveAttempt({
      attemptId: 'att_torn',
      learnerId: 'dev-torn',
      kind: 'mock',
      status: 'submitted',
      submittedAt: new Date().toISOString(),
      expiresAt: new Date().toISOString(),
      questionOrder: [],
      answers: {},
      score: { correct: 0, total: 0, percent: 0 },
    });
    assert.equal(await repo.getActiveMock('dev-torn'), 'mock_torn', 'torn claim in place');

    const res = await call('POST', '/mock-exams', 'torn', {});
    assert.equal(res.status, 201, 'the sweep must release the torn claim and allow a new mock');
    assert.equal(await repo.getActiveMock('dev-torn'), res.body.mockExamId, 'new claim belongs to the new mock');
  } finally {
    resetRuntime();
  }
});

test('missing-records claim (crash between claim and saves) is also swept', async () => {
  const repo = new InMemorySimulationRepository();
  configureRuntime({ repository: repo });
  try {
    await repo.claimActiveMock('dev-ghost', 'mock_ghost'); // claim exists, records never written
    const res = await call('POST', '/mock-exams', 'ghost', {});
    assert.equal(res.status, 201, 'ghost claim must not lock the learner out');
  } finally {
    resetRuntime();
  }
});

test('healthy in-progress mock still blocks a second start (claim path intact)', async () => {
  const repo = new InMemorySimulationRepository();
  configureRuntime({ repository: repo });
  try {
    const first = await call('POST', '/mock-exams', 'busy', {});
    assert.equal(first.status, 201);
    const second = await call('POST', '/mock-exams', 'busy', {});
    assert.equal(second.status, 409);
    assert.equal(second.body.error.code, 'MOCK_EXAM_IN_PROGRESS');
    assert.equal(second.body.error.details.mockExamId, first.body.mockExamId);
  } finally {
    resetRuntime();
  }
});
