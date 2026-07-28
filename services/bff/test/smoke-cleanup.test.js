// Smoke-run cleanup contract (#75) — offline, in process, no AWS and no network.
//
// #70's `always()` cleanup job calls this through the BFF, authenticated as the smoke learner. The
// interesting cases are all negative: this is a DELETE endpoint reachable by a token, so most of
// what matters is what it refuses. A cleanup that deletes slightly too much is a data-loss bug in
// a shared environment, and one that deletes too little leaves records that block the next run.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.CBA_WEB_STORE = 'memory';
process.env.CBA_WEB_AUTH = 'dev';
const { handleApiRequest } = await import('../src/index.js');
const { isValidSmokeRunId, resolveSmokeRun } = await import('../src/smoke-run.js');

const RUN = 'run-20260728-a1b2c3';
const OTHER_RUN = 'run-20260728-zzzzzz';

function call(method, path, { learner, run, body } = {}) {
  const headers = {};
  if (learner) headers['x-cba-learner'] = learner;
  if (run) headers['x-cba-smoke-run'] = run;
  return handleApiRequest({
    method,
    path,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

/** Create one practice session and one mock exam for a learner, optionally inside a smoke run. */
async function seed(learner, run) {
  const drill = await call('POST', '/practice-sessions', {
    learner,
    run,
    body: { examId: 'cba', questionCount: 5 },
  });
  assert.equal(drill.status, 201, JSON.stringify(drill.body));
  // The practice-session response carries no question refs — the next-question call does. Answering
  // for real matters here: an answer count of zero would let the cleanup claim success while
  // leaving the records that actually hold learner input.
  const next = await call('GET', `/practice-sessions/${drill.body.practiceSessionId}/next`, { learner, run });
  assert.equal(next.status, 200, JSON.stringify(next.body));
  const answer = await call('POST', `/practice-sessions/${drill.body.practiceSessionId}/answers`, {
    learner,
    run,
    body: {
      index: next.body.index,
      questionVersionId: next.body.question.questionVersionId,
      selectedOption: 'A',
    },
  });
  assert.equal(answer.status, 200, JSON.stringify(answer.body));
  const mock = await call('POST', '/mock-exams', { learner, run, body: { examId: 'cba' } });
  assert.equal(mock.status, 201, JSON.stringify(mock.body));
  return { drill: drill.body, mock: mock.body, answerStatus: answer.status };
}

const cleanup = (learner, run, pathRun = run) =>
  call('DELETE', `/smoke-runs/${pathRun}/data`, { learner, run });

/* ============================ the run id itself ============================================== */

test('a smoke run id is bounded and opaque', () => {
  // It reaches a route path and a persistence key, so an unbounded string would be both an
  // injection surface and an unbounded partition key.
  assert.equal(isValidSmokeRunId(RUN), true);
  for (const bad of [
    '', 'short', 'a'.repeat(65), '-leading', 'has space', 'has/slash', 'has..dots',
    'has#hash', null, undefined, 42, {},
  ]) {
    assert.equal(isValidSmokeRunId(bad), false, JSON.stringify(bad));
  }
});

test('in a deployed runtime the run identity comes from the principal, never a header', () => {
  // A header would let anyone holding an ordinary learner token promote themselves into a smoke
  // principal, and from there delete data.
  const headers = { 'x-cba-smoke-run': RUN };
  assert.equal(resolveSmokeRun(headers, null, { mode: 'cognito' }), null);
  assert.equal(resolveSmokeRun(headers, { smokeRunId: undefined }, { mode: 'cognito' }), null);
  assert.deepEqual(resolveSmokeRun({}, { smokeRunId: RUN }, { mode: 'cognito' }), { runId: RUN });
  // A malformed claim is not trusted either.
  assert.equal(resolveSmokeRun({}, { smokeRunId: 'nope' }, { mode: 'cognito' }), null);
  // Local dev keeps the header, because local identity is header-based already.
  assert.deepEqual(resolveSmokeRun(headers, null, { mode: 'dev' }), { runId: RUN });
});

/* ============================ positive ======================================================= */

test('cleanup removes everything the run created and reports what it removed', async () => {
  const learner = 'smoke-positive';
  await seed(learner, RUN);

  const before = await call('GET', '/dashboard', { learner, run: RUN });
  assert.equal(before.status, 200);

  const res = await cleanup(learner, RUN);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.runId, RUN);
  assert.ok(res.body.deleted.practiceSessions >= 1, 'the practice session must be removed');
  assert.ok(res.body.deleted.mockExams >= 1, 'the mock exam must be removed');
  assert.ok(res.body.deleted.attempts >= 2, 'both attempts must be removed');
  assert.ok(res.body.deleted.answers >= 1, 'answers are counted where they are removed');

  // The learner id is NOT echoed: the response is written into a workflow summary.
  assert.equal(JSON.stringify(res.body).includes(learner), false);
});

test('a cleaned-up learner can immediately start another mock', async () => {
  // The one-active-mock claim is keyed by learner alone. Left behind, it blocks every future mock —
  // a cleanup that makes the next run impossible is not a cleanup.
  const learner = 'smoke-reusable';
  await seed(learner, RUN);
  await cleanup(learner, RUN);
  const again = await call('POST', '/mock-exams', { learner, run: OTHER_RUN, body: { examId: 'cba' } });
  assert.equal(again.status, 201, JSON.stringify(again.body));
});

/* ============================ ownership: the whole point ===================================== */

test('NEGATIVE: another learner cannot delete this run\'s data', async () => {
  const victim = 'smoke-victim';
  const attacker = 'smoke-attacker';
  await seed(victim, RUN);

  // The attacker holds a perfectly valid smoke token for the SAME run id.
  const res = await cleanup(attacker, RUN);
  assert.equal(res.status, 200, 'it is not an error — there is simply nothing of theirs to delete');
  assert.deepEqual(res.body.deleted, {
    practiceSessions: 0, mockExams: 0, attempts: 0, answers: 0, projections: 0,
  });

  // The victim's data is untouched, which is the assertion that matters.
  const still = await cleanup(victim, RUN);
  assert.ok(still.body.deleted.practiceSessions >= 1, 'the victim\'s records must still have been there');
});

test('NEGATIVE: a smoke run cannot delete another run\'s data', async () => {
  const learner = 'smoke-two-runs';
  await seed(learner, RUN);

  // Same learner, different authenticated run. Scoping by learner alone would delete these.
  const other = await cleanup(learner, OTHER_RUN);
  assert.equal(other.status, 200);
  assert.deepEqual(other.body.deleted, {
    practiceSessions: 0, mockExams: 0, attempts: 0, answers: 0, projections: 0,
  });

  const own = await cleanup(learner, RUN);
  assert.ok(own.body.deleted.practiceSessions >= 1);
});

test('NEGATIVE: the path run id only confirms the authenticated one', async () => {
  const learner = 'smoke-path-mismatch';
  await seed(learner, RUN);

  // A valid smoke token plus a different run id in the path must be refused, not re-scoped.
  const res = await cleanup(learner, RUN, OTHER_RUN);
  assert.equal(res.status, 403);
  assert.equal(res.body.error.code, 'FORBIDDEN');

  const own = await cleanup(learner, RUN);
  assert.ok(own.body.deleted.practiceSessions >= 1, 'the refusal must not have deleted anything');
});

test('NEGATIVE: an ordinary learner cannot reach the operation at all', async () => {
  const learner = 'ordinary-learner';
  await seed(learner, undefined);

  const res = await call('DELETE', `/smoke-runs/${RUN}/data`, { learner });
  assert.equal(res.status, 403);
  assert.equal(res.body.error.code, 'FORBIDDEN');

  // And their records survive: an ordinary learner's data has no run id, so it is never in scope.
  const dash = await call('GET', '/dashboard', { learner });
  assert.equal(dash.status, 200);
});

test('an anonymous dev caller is still scoped to its own default learner', async () => {
  // In dev mode identity IS header-based, so an absent learner header resolves the deterministic
  // default learner rather than failing — that is the existing local contract, not something this
  // operation may change. What matters is that the anonymous caller is scoped to THAT learner and
  // cannot reach anyone else's records. (Deployed mode refuses the header outright; see the
  // principal test above, which is where the real boundary lives.)
  const victim = 'smoke-anon-victim';
  await seed(victim, RUN);

  const res = await handleApiRequest({
    method: 'DELETE',
    path: `/smoke-runs/${RUN}/data`,
    headers: { 'x-cba-smoke-run': RUN },
  });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.deleted, {
    practiceSessions: 0, mockExams: 0, attempts: 0, answers: 0, projections: 0,
  }, 'the anonymous default learner owns none of the victim\'s records');

  const own = await cleanup(victim, RUN);
  assert.ok(own.body.deleted.practiceSessions >= 1, 'the victim\'s data must have survived');
});

test('no input anywhere names a learner', async () => {
  const learner = 'smoke-no-learner-input';
  await seed(learner, RUN);

  // A body is not even read by this route, but if one were smuggled in it must change nothing.
  const res = await handleApiRequest({
    method: 'DELETE',
    path: `/smoke-runs/${RUN}/data`,
    headers: { 'x-cba-learner': learner, 'x-cba-smoke-run': RUN },
    body: JSON.stringify({ learnerId: 'someone-else', runId: OTHER_RUN }),
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.runId, RUN, 'the body must not be able to re-scope the run');
  assert.ok(res.body.deleted.practiceSessions >= 1, 'it deleted the caller\'s own records, not the named ones');
});

/* ============================ idempotency / replay ========================================== */

test('cleanup is idempotent: replaying it returns the same shape with zeros', async () => {
  const learner = 'smoke-replay';
  await seed(learner, RUN);

  const first = await cleanup(learner, RUN);
  assert.equal(first.status, 200);
  assert.ok(first.body.deleted.attempts >= 2);

  for (let i = 0; i < 3; i++) {
    const again = await cleanup(learner, RUN);
    assert.equal(again.status, 200, `replay ${i} must succeed`);
    assert.equal(again.body.runId, RUN);
    // The same SHAPE with zeros — #70 retries this job, and a different response on retry would
    // have to be interpreted rather than simply reported.
    assert.deepEqual(again.body.deleted, {
      practiceSessions: 0, mockExams: 0, attempts: 0, answers: 0, projections: 0,
    });
  }
});

test('cleanup of a run that never existed is a success with zeros, not an error', async () => {
  // #70 runs cleanup with `always()`, including after a job that failed before creating anything.
  // An error here would turn "nothing to clean" into a blocked promotion.
  const res = await cleanup('smoke-never-ran', 'run-20260728-nothing1');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.deleted, {
    practiceSessions: 0, mockExams: 0, attempts: 0, answers: 0, projections: 0,
  });
});

test('NEGATIVE: a malformed run id in the path is refused', async () => {
  const res = await call('DELETE', '/smoke-runs/short/data', { learner: 'smoke-bad-id', run: RUN });
  assert.equal(res.status, 403, 'it does not match the authenticated run');
});
