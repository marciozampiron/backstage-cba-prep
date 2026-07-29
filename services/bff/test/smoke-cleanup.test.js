// Smoke-run cleanup contract (#75) — offline, in process, no AWS and no network.
//
// #70's `always()` cleanup job calls this through the BFF, authenticated as the smoke learner. The
// interesting cases are all negative: this is a DELETE endpoint reachable by a token, so most of
// what matters is what it refuses. A cleanup that deletes slightly too much is data loss in a
// shared environment, and one that deletes too little leaves records that block the next run.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.CBA_WEB_STORE = 'memory';
process.env.CBA_WEB_AUTH = 'dev';
const { handleApiRequest } = await import('../src/index.js');
const { SMOKE_GROUP, hasSmokeCapability, isValidSmokeRunId, readSmokeRunHeader } = await import('../src/smoke-run.js');

const ZERO = { practiceSessions: 0, mockExams: 0, attempts: 0, answers: 0, projections: 0 };

function call(method, path, { learner, run, body, capable = true } = {}) {
  const headers = {};
  if (learner) headers['x-cba-learner'] = learner;
  if (capable) headers['x-cba-smoke'] = SMOKE_GROUP;
  if (run) headers['x-cba-smoke-run'] = run;
  return handleApiRequest({
    method,
    path,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

/** Mint a run the same way #70 will: through the BFF, owned by the caller. */
async function mintRun(learner) {
  const res = await call('POST', '/smoke-runs', { learner, body: {} });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(isValidSmokeRunId(res.body.runId), true);
  return res.body.runId;
}

/** Create one practice session (with a real answer) and one mock exam inside a run. */
async function seed(learner, run) {
  const drill = await call('POST', '/practice-sessions', {
    learner,
    run,
    body: { examId: 'cba', questionCount: 5 },
  });
  assert.equal(drill.status, 201, JSON.stringify(drill.body));

  // Answering for real matters: an answer count of zero would let cleanup claim success while
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
  return { drill: drill.body, mock: mock.body };
}

const cleanup = (learner, run) => call('DELETE', `/smoke-runs/${run}/data`, { learner, run });

/* ============================ the run id and the header ====================================== */

test('a smoke run id is bounded and opaque', () => {
  // It reaches a route path, a header and a persistence key, so an unbounded string would be both
  // an injection surface and an unbounded partition key.
  for (const bad of [
    '', 'short', 'a'.repeat(65), '-leading', 'has space', 'has/slash', 'has..dots',
    'has#hash', null, undefined, 42, {},
  ]) {
    assert.equal(isValidSmokeRunId(bad), false, JSON.stringify(bad));
  }
  assert.equal(isValidSmokeRunId('run-abcdefgh12345678'), true);
});

test('the run header is a reference and authorizes nothing on its own', () => {
  // Ownership is checked separately against the stored run record. A malformed value reads as
  // absent, so probing formats teaches a caller nothing.
  assert.equal(readSmokeRunHeader({ 'x-cba-smoke-run': 'run-abcdefgh12345678' }), 'run-abcdefgh12345678');
  assert.equal(readSmokeRunHeader({ 'x-cba-smoke-run': 'short' }), null);
  assert.equal(readSmokeRunHeader({}), null);
});

test('minted run ids are unique and unguessable', async () => {
  const ids = [];
  for (let i = 0; i < 5; i++) ids.push(await mintRun('smoke-mint'));
  assert.equal(new Set(ids).size, 5, 'a repeated id would let one run delete another');
  // Not sequential: a guessable id would leave the ownership check as the only barrier.
  assert.equal(ids.some((id, i) => i > 0 && id === ids[i - 1]), false);
});

/* ============================ positive ======================================================= */

test('cleanup removes everything the run created and reports what it removed', async () => {
  const learner = 'smoke-positive';
  const run = await mintRun(learner);
  await seed(learner, run);

  const res = await cleanup(learner, run);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.runId, run);
  assert.ok(res.body.deleted.practiceSessions >= 1, 'the practice session must be removed');
  assert.ok(res.body.deleted.mockExams >= 1, 'the mock exam must be removed');
  assert.ok(res.body.deleted.attempts >= 2, 'both attempts must be removed');
  assert.ok(res.body.deleted.answers >= 1, 'answers are counted where they are removed');

  // The learner id is NOT echoed: the response is written into a workflow summary.
  assert.equal(JSON.stringify(res.body).includes(learner), false);
});

test('a cleaned-up learner can immediately start another mock', async () => {
  // The one-active-mock claim is keyed by learner alone. Left behind it blocks every future mock —
  // a cleanup that makes the next run impossible is not a cleanup.
  const learner = 'smoke-reusable';
  const run = await mintRun(learner);
  await seed(learner, run);
  await cleanup(learner, run);

  const next = await mintRun(learner);
  const again = await call('POST', '/mock-exams', { learner, run: next, body: { examId: 'cba' } });
  assert.equal(again.status, 201, JSON.stringify(again.body));
});

/* ============================ ownership: the whole point ===================================== */

test('NEGATIVE: another learner cannot delete this run\'s data', async () => {
  const victim = 'smoke-victim';
  const run = await mintRun(victim);
  await seed(victim, run);

  // The attacker knows the run id exactly and is authenticated. Ownership is the only thing that
  // stops them, which is precisely what this asserts.
  const res = await cleanup('smoke-attacker', run);
  assert.equal(res.status, 403);
  assert.equal(res.body.error.code, 'FORBIDDEN');

  const own = await cleanup(victim, run);
  assert.ok(own.body.deleted.practiceSessions >= 1, 'the victim\'s records must still have been there');
});

test('NEGATIVE: a run cannot delete another run\'s data', async () => {
  const learner = 'smoke-two-runs';
  const runA = await mintRun(learner);
  const runB = await mintRun(learner);
  await seed(learner, runA);

  // Same learner, different run. Scoping by learner alone would delete runA's records here.
  const other = await cleanup(learner, runB);
  assert.equal(other.status, 200);
  assert.deepEqual(other.body.deleted, ZERO);

  const own = await cleanup(learner, runA);
  assert.ok(own.body.deleted.practiceSessions >= 1);
});

test('NEGATIVE: an unknown run id is refused exactly like someone else\'s', async () => {
  // The same answer for both, so a caller learns nothing about which run ids exist.
  const unknown = await call('DELETE', '/smoke-runs/run-doesnotexist000000/data', { learner: 'smoke-probe' });
  assert.equal(unknown.status, 403);
  assert.equal(unknown.body.error.code, 'FORBIDDEN');
});

test('NEGATIVE: a learner cannot stamp writes into a run they do not own', async () => {
  const owner = 'smoke-stamp-owner';
  const outsider = 'smoke-stamp-outsider';
  const run = await mintRun(owner);

  // The outsider references the owner's run on a WRITE. Letting it fall through unstamped was
  // worse than it looked: the record landed outside every run, so the outsider's own cleanup
  // reported success with zeros while the row stayed in the table — a false green on the exact
  // gate meant to catch leftovers. A present-but-unowned reference now fails closed.
  const drill = await call('POST', '/practice-sessions', {
    learner: outsider,
    run,
    body: { examId: 'cba', questionCount: 5 },
  });
  assert.equal(drill.status, 403, 'the write must be refused, not silently unstamped');
  assert.equal(drill.body.error.code, 'FORBIDDEN');

  const ownerCleanup = await cleanup(owner, run);
  assert.deepEqual(ownerCleanup.body.deleted, ZERO, 'nothing was ever created in this run');
});

test('NEGATIVE: a malformed run reference fails closed, and no write happens', async () => {
  const learner = 'smoke-malformed-ref';
  const res = await handleApiRequest({
    method: 'POST',
    path: '/practice-sessions',
    headers: { 'x-cba-learner': learner, 'x-cba-smoke': SMOKE_GROUP, 'x-cba-smoke-run': 'short' },
    body: JSON.stringify({ examId: 'cba', questionCount: 5 }),
  });
  assert.equal(res.status, 400);
  assert.equal(res.body.error.code, 'VALIDATION_FAILED');

  // Nothing was persisted: the dashboard has no attempt to show.
  const dash = await call('GET', '/dashboard', { learner });
  assert.equal(dash.status, 200);
  assert.equal(dash.body.recentAttempts?.length ?? 0, 0);
});

test('an ABSENT run header is ordinary traffic, not a refusal', async () => {
  const res = await call('POST', '/practice-sessions', {
    learner: 'smoke-no-header',
    body: { examId: 'cba', questionCount: 5 },
  });
  assert.equal(res.status, 201);
});

/* ============================ the capability is the authorization ============================ */

test('the smoke capability comes from a validated group claim in a deployed runtime', () => {
  // `cognito:groups` IS on an access token, unlike a custom attribute — which is what makes this
  // capability actually issuable. Membership is pre-provisioned once, never per run.
  assert.equal(hasSmokeCapability({}, { groups: [SMOKE_GROUP] }, { mode: 'cognito' }), true);
  assert.equal(hasSmokeCapability({}, { groups: ['learners'] }, { mode: 'cognito' }), false);
  assert.equal(hasSmokeCapability({}, { groups: [] }, { mode: 'cognito' }), false);
  assert.equal(hasSmokeCapability({}, {}, { mode: 'cognito' }), false);
  // A header must never self-promote a deployed caller.
  assert.equal(hasSmokeCapability({ 'x-cba-smoke': SMOKE_GROUP }, { groups: [] }, { mode: 'cognito' }), false);
});

test('NEGATIVE: an ordinary learner cannot mint or clean up a run', async () => {
  const ordinary = 'plain-learner';
  const mint = await call('POST', '/smoke-runs', { learner: ordinary, capable: false, body: {} });
  assert.equal(mint.status, 403, 'an authenticated learner is not a smoke operator');
  assert.equal(mint.body.error.code, 'FORBIDDEN');

  // And they cannot reach cleanup even with a run id that exists.
  const owner = 'smoke-cap-owner';
  const run = await mintRun(owner);
  const attempt = await call('DELETE', `/smoke-runs/${run}/data`, { learner: ordinary, capable: false });
  assert.equal(attempt.status, 403);
});

test('records created with no run are never in scope', async () => {
  const learner = 'ordinary-learner';
  await seed(learner, undefined);
  const run = await mintRun(learner);

  const res = await cleanup(learner, run);
  assert.deepEqual(res.body.deleted, ZERO, 'data with no run id belongs to no run');

  const dash = await call('GET', '/dashboard', { learner });
  assert.equal(dash.status, 200);
});

test('no input anywhere names a learner', async () => {
  const learner = 'smoke-no-learner-input';
  const run = await mintRun(learner);
  await seed(learner, run);

  const res = await handleApiRequest({
    method: 'DELETE',
    path: `/smoke-runs/${run}/data`,
    headers: { 'x-cba-learner': learner, 'x-cba-smoke': SMOKE_GROUP },
    body: JSON.stringify({ learnerId: 'someone-else', runId: 'run-elsewhere00000000' }),
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.runId, run, 'the body must not be able to re-scope the run');
  assert.ok(res.body.deleted.practiceSessions >= 1, 'it deleted the caller\'s own records');
});

/* ============================ idempotency / replay ========================================== */

test('replaying cleanup never deletes twice and never reports a false success', async () => {
  const learner = 'smoke-replay';
  const run = await mintRun(learner);
  await seed(learner, run);

  const first = await cleanup(learner, run);
  assert.equal(first.status, 200);
  assert.ok(first.body.deleted.attempts >= 2);

  // Deterministic, not merely safe. The run record survives as a tombstone, so ownership outlives
  // the data and every replay answers the same way: 200 with zeros. Consuming ownership on success
  // made the second call answer 403, which #70 would have to special-case.
  for (let i = 0; i < 3; i++) {
    const again = await cleanup(learner, run);
    assert.equal(again.status, 200, `replay ${i}`);
    assert.equal(again.body.runId, run);
    assert.deepEqual(again.body.deleted, ZERO);
  }
});

test('cleanup of a run that created nothing is a success with zeros, not an error', async () => {
  // #70 runs cleanup with `always()`, including after a job that failed before creating anything.
  // An error here would turn "nothing to clean" into a blocked promotion.
  const learner = 'smoke-never-ran';
  const run = await mintRun(learner);
  const res = await cleanup(learner, run);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.deleted, ZERO);
});

/* ============================ incomplete cleanup blocks ====================================== */

const { configureRuntime, resetRuntime } = await import('../src/runtime.js');
const { InMemorySimulationRepository } = await import('../src/repository.js');
const { cleanupSmokeRun } = await import('../src/store.js');

test('NEGATIVE: a record that survives every attempt makes cleanup FAIL, not succeed quietly', async () => {
  // The adapter deletes conditionally on the revision it read, so a record written between the read
  // and the delete is skipped. Counting deletions cannot tell "nothing existed" from "something
  // survived" — both report zero — and answering 200 there would let a run be promoted with records
  // still in the table. Completeness is therefore VERIFIED by re-querying the scope.
  class ContendedRepository extends InMemorySimulationRepository {
    async deleteSmokeRunData() {
      // Every delete loses its condition: nothing is ever removed.
      return { practiceSessions: 0, mockExams: 0, attempts: 0, answers: 0, projections: 0 };
    }
  }
  const repo = new ContendedRepository();
  await repo.saveSmokeRun({ runId: 'run-contended000000000', learnerId: 'l-contended', status: 'active', writeDeadlineAt: new Date(Date.now() + 864e5).toISOString(), ownershipExpiresAt: new Date(Date.now() + 6912e5).toISOString() });
  await repo.saveSession({
    practiceSessionId: 'ps_contended',
    attemptId: 'att_contended',
    learnerId: 'l-contended',
    runId: 'run-contended000000000',
  });

  configureRuntime({ repository: repo });
  try {
    await assert.rejects(
      () => cleanupSmokeRun('l-contended', 'run-contended000000000'),
      (err) => {
        assert.equal(err.status, 409, 'it must be a non-2xx so the job fails and promotion blocks');
        assert.equal(err.code, 'CLEANUP_INCOMPLETE');
        // Leftovers are reported per CLASS, never as ids — the summary says what survived without
        // naming a learner's records.
        assert.equal(err.details.remaining.practiceSessions, 1);
        assert.equal(JSON.stringify(err.details).includes('ps_contended'), false);
        assert.equal(JSON.stringify(err.details).includes('l-contended'), false);
        return true;
      },
    );
  } finally {
    resetRuntime();
  }
});

test('a later uncontended retry succeeds idempotently after a contended one', async () => {
  let contend = true;
  class SometimesContendedRepository extends InMemorySimulationRepository {
    async deleteSmokeRunData(scope) {
      if (contend) return { practiceSessions: 0, mockExams: 0, attempts: 0, answers: 0, projections: 0 };
      return super.deleteSmokeRunData(scope);
    }
  }
  const repo = new SometimesContendedRepository();
  await repo.saveSmokeRun({ runId: 'run-retryable000000000', learnerId: 'l-retry', status: 'active', writeDeadlineAt: new Date(Date.now() + 864e5).toISOString(), ownershipExpiresAt: new Date(Date.now() + 6912e5).toISOString() });
  await repo.saveSession({
    practiceSessionId: 'ps_retry',
    attemptId: 'att_retry',
    learnerId: 'l-retry',
    runId: 'run-retryable000000000',
  });

  configureRuntime({ repository: repo });
  try {
    await assert.rejects(() => cleanupSmokeRun('l-retry', 'run-retryable000000000'), (e) => e.code === 'CLEANUP_INCOMPLETE');
    // The skip is a deferral, not a leak: once contention clears, the same call finishes the job.
    contend = false;
    const res = await cleanupSmokeRun('l-retry', 'run-retryable000000000');
    assert.equal(res.runId, 'run-retryable000000000');
    assert.equal(res.deleted.practiceSessions, 1);
    assert.equal(await repo.getSession('ps_retry'), null);
  } finally {
    resetRuntime();
  }
});

/* ============================ a completed run is closed ====================================== */

test('NEGATIVE: a cleaned-up run accepts no new records, and replay stays at zero', async () => {
  // Without this, replay was deterministic only if nothing was written in between: a write could
  // rejoin a run that had already been reported clean, and the next cleanup would find records the
  // previous one swore were gone.
  const learner = 'smoke-closed';
  const run = await mintRun(learner);
  await seed(learner, run);

  const first = await cleanup(learner, run);
  assert.equal(first.status, 200);
  assert.ok(first.body.deleted.practiceSessions >= 1);
  assert.ok(first.body.completedAt, 'the run is finalized only after verification');

  const write = await call('POST', '/practice-sessions', {
    learner,
    run,
    body: { examId: 'cba', questionCount: 5 },
  });
  assert.equal(write.status, 409);
  assert.equal(write.body.error.code, 'RUN_CLOSED');

  // Cleanup itself is still authorized against a completed run — that is what keeps replay
  // deterministic — and it still finds nothing.
  const again = await cleanup(learner, run);
  assert.equal(again.status, 200);
  assert.deepEqual(again.body.deleted, ZERO);
});

test('NEGATIVE: losing the capability stops operating runs already owned', async () => {
  const learner = 'smoke-revoked';
  const run = await mintRun(learner);

  // Same learner, same owned run, capability gone — as when an operator is removed from the group.
  const write = await call('POST', '/practice-sessions', {
    learner,
    run,
    capable: false,
    body: { examId: 'cba', questionCount: 5 },
  });
  assert.equal(write.status, 403);
  assert.equal(write.body.error.code, 'FORBIDDEN');
});

test('a completed run carries a bounded retention, not an open-ended one', async () => {
  const learner = 'smoke-retention';
  const run = await mintRun(learner);
  const res = await cleanup(learner, run);
  assert.equal(res.status, 200);

  const { activeRepository } = await import('../src/runtime.js');
  const record = await activeRepository().getSmokeRun(run);
  assert.ok(record.completedAt, 'the tombstone keeps ownership alive for replay');
  // Ownership is learner data: it may outlive the records, but not indefinitely (SEC-DATA-01).
  const ttlMs = Date.parse(record.expiresAt) - Date.parse(record.completedAt);
  assert.ok(ttlMs > 0 && ttlMs <= 8 * 24 * 60 * 60 * 1000, `retention was ${ttlMs}ms`);
});

/* ============================ the time-of-check gap ========================================== */

test('NEGATIVE: a write in flight during cleanup cannot land after it reports success', async () => {
  // The dispatcher checks the run state BEFORE the handler runs. On its own that is a
  // time-of-check/time-of-use gap: a write that passed the check can still commit after cleanup has
  // reported zero, leaving records the run swore were gone — and the next cleanup would find them.
  // The state test therefore happens AT the write, conditionally.
  const { configureRuntime: cfg, resetRuntime: reset } = await import('../src/runtime.js');
  const { InMemorySimulationRepository: Repo } = await import('../src/repository.js');
  const { startSmokeRun, startDrill, cleanupSmokeRun } = await import('../src/store.js');

  let release;
  const paused = new Promise((r) => { release = r; });
  let pauseNext = false;

  class PausingRepository extends Repo {
    async saveSmokeScopedRecord(args) {
      if (pauseNext && args.kind === 'attempt') {
        pauseNext = false;
        await paused; // the write is mid-flight while cleanup runs
      }
      return super.saveSmokeScopedRecord(args);
    }
  }

  const repo = new PausingRepository();
  cfg({ repository: repo });
  try {
    const run = await startSmokeRun('l-inflight');
    pauseNext = true;
    const writing = startDrill('l-inflight', { questionCount: 5, runId: run.runId });

    const result = await cleanupSmokeRun('l-inflight', run.runId);
    assert.deepEqual(result.deleted, ZERO, 'nothing existed yet');

    release();
    // The write must now be REFUSED rather than landing behind the completed cleanup.
    await assert.rejects(() => writing, (err) => {
      assert.equal(err.status, 409);
      assert.equal(err.code, 'RUN_CLOSED');
      return true;
    });

    // And the scope really is empty — the assertion that would have failed before.
    const after = await repo.countSmokeRunRecords({ learnerId: 'l-inflight', runId: run.runId });
    assert.deepEqual(after, { practiceSessions: 0, mockExams: 0, attempts: 0 });
  } finally {
    reset();
  }
});

test('replaying cleanup does not slide the tombstone forward', async () => {
  // A replay six days after completion used to move the expiry from day seven to day thirteen, so
  // repeated replays could retain learner ownership indefinitely. Retention runs from when the run
  // finished, not from the last time somebody asked about it.
  const learner = 'smoke-retention-stable';
  const run = await mintRun(learner);
  const first = await cleanup(learner, run);
  assert.equal(first.status, 200);

  const { activeRepository } = await import('../src/runtime.js');
  const original = (await activeRepository().getSmokeRun(run)).expiresAt;

  await cleanup(learner, run);
  await cleanup(learner, run);
  assert.equal((await activeRepository().getSmokeRun(run)).expiresAt, original);
});

test('an expired run is refused by the application, not by waiting for TTL', async () => {
  // DynamoDB TTL is eventually consistent — it can lag by days. The authorization decision must not
  // wait for the row to disappear.
  const { configureRuntime: cfg, resetRuntime: reset } = await import('../src/runtime.js');
  const { InMemorySimulationRepository: Repo } = await import('../src/repository.js');
  const { startSmokeRun, ownedSmokeRun } = await import('../src/store.js');

  const repo = new Repo();
  cfg({ repository: repo });
  try {
    const run = await startSmokeRun('l-expired');
    assert.ok(await ownedSmokeRun('l-expired', run.runId), 'valid while unexpired');

    // OWNERSHIP is what gates cleanup. Past the write deadline the run is still cleanable — that
    // is the manual-recovery path — so the boundary tested here is ownershipExpiresAt.
    const stored = await repo.getSmokeRun(run.runId);
    stored.ownershipExpiresAt = new Date(Date.now() - 1000).toISOString();
    await repo.saveSmokeRun(stored);

    assert.equal(await ownedSmokeRun('l-expired', run.runId), null, 'expired ownership reads as gone');
  } finally {
    reset();
  }
});

/* ============================ the three clocks =============================================== */

test('a write-expired run refuses writes but is still cleanable', async () => {
  // Collapsing these two into one deadline made cleanup unreachable exactly when it was needed:
  // after 24h the route answered 403 while days of learner data remained.
  const { configureRuntime: cfg, resetRuntime: reset } = await import('../src/runtime.js');
  const { InMemorySimulationRepository: Repo } = await import('../src/repository.js');
  const { startSmokeRun, startDrill, cleanupSmokeRun, runIsClosed, runOwnershipExpired } =
    await import('../src/store.js');

  // The repository gets the SAME injected clock: retention is never read from Date.now, and a
  // repository on a different clock than the use case would fence on the wrong instant.
  // No explicit clock: composition binds it, which is the path the application actually uses.
  let clock = Date.parse('2026-07-28T00:00:00Z');
  const repo = new Repo();
  cfg({ repository: repo, now: () => clock });
  try {
    const run = await startSmokeRun('l-clocks');
    await startDrill('l-clocks', { questionCount: 5, runId: run.runId });

    clock += 25 * 60 * 60 * 1000; // past the write deadline, well inside ownership
    const stored = await repo.getSmokeRun(run.runId);
    assert.equal(runIsClosed(stored, clock), true, 'writes are refused');
    assert.equal(runOwnershipExpired(stored, clock), false, 'ownership survives');

    const result = await cleanupSmokeRun('l-clocks', run.runId);
    assert.ok(result.deleted.practiceSessions >= 1, 'the manual-recovery path must still work');
  } finally {
    reset();
  }
});

test('a malformed deadline fails closed rather than reading as "no deadline"', async () => {
  const { runIsClosed, runOwnershipExpired } = await import('../src/store.js');
  const now = Date.parse('2026-07-28T00:00:00Z');
  for (const bad of [undefined, null, '', 'soon', {}, 42]) {
    assert.equal(runIsClosed({ status: 'active', writeDeadlineAt: bad }, now), true, JSON.stringify(bad));
    assert.equal(runOwnershipExpired({ ownershipExpiresAt: bad }, now), true, JSON.stringify(bad));
  }
});

test('the write fence is exact at the deadline, on memory and file alike', async () => {
  // deadline-1ms, deadline, deadline+1ms — the boundary is where an off-by-one lets a write in
  // after cleanup was told the run was closed.
  const { configureRuntime: cfg, resetRuntime: reset } = await import('../src/runtime.js');
  const { InMemorySimulationRepository: Mem, FileSimulationRepository: File } =
    await import('../src/repository.js');
  const { mkdtempSync, rmSync } = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { startSmokeRun, startDrill } = await import('../src/store.js');

  const dir = mkdtempSync(path.join(os.tmpdir(), 'cba-fence-'));
  try {
    for (const [label, make] of Object.entries({
      memory: () => new Mem(),
      file: () => new File(path.join(dir, `${Math.random().toString(36).slice(2)}.json`)),
    })) {
      let clock = Date.parse('2026-07-28T00:00:00Z');
      const repo = make();
      cfg({ repository: repo, now: () => clock });

      const run = await startSmokeRun(`l-${label}`);
      const deadline = Date.parse((await repo.getSmokeRun(run.runId)).writeDeadlineAt);

      clock = deadline - 1;
      await startDrill(`l-${label}`, { questionCount: 5, runId: run.runId });

      clock = deadline;
      await assert.rejects(
        () => startDrill(`l-${label}`, { questionCount: 5, runId: run.runId }),
        (err) => err.code === 'RUN_CLOSED',
        `${label}: the deadline itself must already be closed`,
      );

      clock = deadline + 1;
      await assert.rejects(
        () => startDrill(`l-${label}`, { questionCount: 5, runId: run.runId }),
        (err) => err.code === 'RUN_CLOSED',
        label,
      );
      reset();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an injected repository without its own clock is adopted onto the runtime clock', async () => {
  // WALL-CLOCK INDEPENDENT by construction. The earlier version used a fixed 2026 date and passed
  // by accident: that instant is already past real time, so the repository refused using Date.now
  // rather than the injected clock, and the adoption it claimed to prove was never happening.
  // Starting a year AHEAD of Date.now means only the injected clock can be past the deadline.
  const { configureRuntime: cfg, resetRuntime: reset } = await import('../src/runtime.js');
  const { InMemorySimulationRepository: Mem } = await import('../src/repository.js');
  const { startSmokeRun, startDrill } = await import('../src/store.js');

  const YEAR = 365 * 24 * 60 * 60 * 1000;
  let clock = Date.now() + YEAR;
  const repo = new Mem();               // no clock of its own
  cfg({ repository: repo, now: () => clock });
  try {
    const run = await startSmokeRun('l-adopted');
    clock += 25 * 60 * 60 * 1000;       // past the deadline on the INJECTED clock ONLY
    assert.ok(Date.now() < Date.parse((await repo.getSmokeRun(run.runId)).writeDeadlineAt),
      'wall time must still be BEFORE the deadline, so only adoption can explain a refusal');
    await assert.rejects(
      () => startDrill('l-adopted', { questionCount: 5, runId: run.runId }),
      (err) => err.code === 'RUN_CLOSED',
      'the fence must see the injected clock, not wall time',
    );
  } finally {
    reset();
  }
});

test('a repository that cannot be bound is refused, not silently left on wall time', async () => {
  const { configureRuntime: cfg, resetRuntime: reset } = await import('../src/runtime.js');
  try {
    assert.throws(() => cfg({ repository: { getSmokeRun: async () => null }, now: () => 0 }),
      /bindClock/);
  } finally {
    reset();
  }
});

test('a repository built WITH its own clock keeps it', async () => {
  // Deliberate skew belongs outside normal composition, so an explicit clock is never overridden.
  const { InMemorySimulationRepository: Mem } = await import('../src/repository.js');
  const own = new Mem({ now: () => 111 });
  assert.equal(own.bindClock(() => 222), false);
  assert.equal(own.now(), 111);

  const adopted = new Mem();
  assert.equal(adopted.bindClock(() => 222), true);
  assert.equal(adopted.now(), 222);
});

test('completion derives both anchor and horizon from one clock read', async () => {
  const { configureRuntime: cfg, resetRuntime: reset } = await import('../src/runtime.js');
  const { InMemorySimulationRepository: Mem } = await import('../src/repository.js');
  const { startSmokeRun, cleanupSmokeRun, SMOKE_RUN_RETENTION_MS } = await import('../src/store.js');

  // A clock that MOVES on every read: two reads would make the horizon differ from exactly seven
  // days after the recorded completion.
  let tick = Date.parse('2026-07-28T00:00:00Z');
  const repo = new Mem();
  cfg({ repository: repo, now: () => (tick += 1000) });
  try {
    const run = await startSmokeRun('l-onetick');
    const result = await cleanupSmokeRun('l-onetick', run.runId);
    const stored = await repo.getSmokeRun(run.runId);
    assert.equal(
      Date.parse(stored.expiresAt) - Date.parse(stored.completedAt),
      SMOKE_RUN_RETENTION_MS,
      'the horizon must be exactly the retention constant from the anchor',
    );
    assert.equal(result.completedAt, stored.completedAt);
  } finally {
    reset();
  }
});

/* ============================ composition is atomic ========================================== */

test('NEGATIVE: a repository with its own clock is refused by runtime composition', async () => {
  // The bindClock contract existed and its answer was discarded, which is the same as not having
  // it: application and repository could evaluate the same write boundary at different instants.
  const { configureRuntime: cfg, resetRuntime: reset } = await import('../src/runtime.js');
  const { InMemorySimulationRepository: Mem } = await import('../src/repository.js');
  try {
    const own = new Mem({ now: () => 111 });
    assert.throws(() => cfg({ repository: own, now: () => 222 }), /would diverge/);
    // Deliberate skew is still possible — outside composition, driving the adapter directly.
    assert.equal(own.now(), 111);
  } finally {
    reset();
  }
});

test('NEGATIVE: a refused configuration changes nothing', async () => {
  const { configureRuntime: cfg, resetRuntime: reset, activeRepository } = await import('../src/runtime.js');
  const { InMemorySimulationRepository: Mem } = await import('../src/repository.js');
  try {
    const first = new Mem();
    cfg({ repository: first, now: () => 111 });
    assert.equal(first.now(), 111);

    // Refused for missing bindClock. The clock must NOT have moved, and the already-bound
    // repository must not have been dragged onto it — a caller told "rejected" would otherwise be
    // running on state they were told was not applied.
    assert.throws(() => cfg({ repository: { getSmokeRun: async () => null }, now: () => 222 }), /bindClock/);
    assert.equal(first.now(), 111, 'the prior repository keeps its clock');
    assert.equal(activeRepository(), first, 'the prior repository stays active');

    // And the same for a repository refused because it brought its own clock.
    assert.throws(() => cfg({ repository: new Mem({ now: () => 333 }), now: () => 444 }), /would diverge/);
    assert.equal(first.now(), 111);
    assert.equal(activeRepository(), first);

    // The assertions above now read the runtime clock directly — a bound repository resolves the
    // composition delegate on every call — but a repository bound AFTER the refusals proves the
    // same thing from a second direction: it adopts state.now at bind time, so it reports what the
    // refused calls actually left behind rather than what an earlier binding remembered.
    const probe = new Mem();
    cfg({ repository: probe });
    assert.equal(probe.now(), 111, 'a refused configuration must not have moved the runtime clock');
  } finally {
    reset();
  }
});

test('a successful configuration changes the clock and the repository together', async () => {
  const { configureRuntime: cfg, resetRuntime: reset, activeRepository } = await import('../src/runtime.js');
  const { InMemorySimulationRepository: Mem } = await import('../src/repository.js');
  try {
    const first = new Mem();
    cfg({ repository: first, now: () => 111 });
    const second = new Mem();
    cfg({ repository: second, now: () => 222 });
    assert.equal(activeRepository(), second);
    assert.equal(second.now(), 222, 'the new repository is on the new clock');
  } finally {
    reset();
  }
});

test('a clock-only reconfiguration moves the ACTIVE repository too', async () => {
  // The third supported transition. Replacing repository+clock together was covered, and refusal
  // rollback was covered, but `configureRuntime({ now })` on an already-bound repository was not:
  // the adapter had captured the clock of the call that bound it, so the application moved to the
  // new instant while the repository write fence stayed on the old one. Same divergence the
  // bindClock contract exists to prevent, reached through a supported path instead of a refused one.
  const { configureRuntime: cfg, resetRuntime: reset, activeRepository, now } =
    await import('../src/runtime.js');
  const { InMemorySimulationRepository: Mem } = await import('../src/repository.js');
  try {
    const repo = new Mem();
    cfg({ repository: repo, now: () => 111 });
    assert.equal(repo.now(), 111);

    cfg({ now: () => 222 });
    assert.equal(activeRepository(), repo, 'the repository is untouched by a clock-only update');
    assert.equal(now(), 222, 'the application observes the new clock');
    assert.equal(repo.now(), 222, 'and so does the repository it will fence against');
  } finally {
    reset();
  }
});

test('the env-composed repository fences on the composition clock, not wall time', async () => {
  // createRepositoryFromEnv must use the same delegate as the injection path, or a runtime that
  // never injected a repository gets an adapter on Date.now() while the application runs on the
  // configured clock.
  const { configureRuntime: cfg, resetRuntime: reset, activeRepository } =
    await import('../src/runtime.js');
  const priorStore = process.env.CBA_WEB_STORE;
  const priorEnv = process.env.CBA_RUNTIME_ENV;
  process.env.CBA_WEB_STORE = 'memory';
  process.env.CBA_RUNTIME_ENV = 'local';
  const restore = (key, value) => {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  };
  try {
    reset();
    cfg({ now: () => 111 });
    assert.equal(activeRepository().now(), 111, 'the env-composed adapter adopts the runtime clock');
    cfg({ now: () => 222 });
    assert.equal(activeRepository().now(), 222, 'and follows it when it changes');
  } finally {
    reset();
    restore('CBA_WEB_STORE', priorStore);
    restore('CBA_RUNTIME_ENV', priorEnv);
  }
});

/* ============================ the profile lease, end to end ================================== */

test('a run minted before the first /api/me leaves the profile bounded at creation', async () => {
  // R6 12a, through the routes: the lease is written at mint whether or not a profile exists, and
  // bootstrap consumes it — so there is no window in which an unbounded smoke profile can exist.
  const { activeRepository } = await import('../src/runtime.js');
  const learner = 'smoke-lease-e2e';

  const run = await mintRun(learner);
  const lease = await activeRepository().getSmokeLease(`dev-${learner}`);
  assert.ok(lease, 'the mint must have written the lease');

  const me = await call('GET', '/me', { learner });
  assert.equal(me.status, 200);

  const stored = activeRepository().state.profiles[`dev-${learner}`];
  assert.equal(stored.retainUntil, lease.retainUntil, 'the profile was stamped from the lease at creation');

  const storedRun = await activeRepository().getSmokeRun(run);
  assert.equal(lease.retainUntil, storedRun.ownershipExpiresAt, 'and the horizon is the run\'s, derived server-side');
});

test('an existing profile is stamped at mint, and an ordinary learner never is', async () => {
  const { activeRepository } = await import('../src/runtime.js');

  const learner = 'smoke-lease-existing';
  const first = await call('GET', '/me', { learner, capable: false }); // profile exists before any run
  assert.equal(first.status, 200);
  assert.equal(activeRepository().state.profiles[`dev-${learner}`].retainUntil, undefined);

  await mintRun(learner);
  assert.ok(activeRepository().state.profiles[`dev-${learner}`].retainUntil,
    'a profile that predates the capability is bound the first time its learner mints a run');

  const plain = 'never-smokes';
  await call('GET', '/me', { learner: plain, capable: false });
  assert.equal(activeRepository().state.profiles[`dev-${plain}`].retainUntil, undefined);
  assert.equal(await activeRepository().getSmokeLease(`dev-${plain}`), null, 'ordinary learners are never leased');
});

test('NEGATIVE: a mint that cannot bind the profile fails, and the lease still covers it', async () => {
  // R6 11d: the lease is durable before the stamp, so a failed mint reports no run — while the
  // effective horizon already includes the lease, and nothing visible is under-retained meanwhile.
  const { activeRepository } = await import('../src/runtime.js');
  const learner = 'smoke-lease-corrupt';

  await call('GET', '/me', { learner, capable: false });
  activeRepository().state.profiles[`dev-${learner}`].retainUntil = 'soon'; // physical corruption

  const mint = await call('POST', '/smoke-runs', { learner, body: {} });
  assert.equal(mint.status, 409, 'no successful mint over a profile that cannot be bounded');
  assert.equal(mint.body.error.code, 'CONFLICT');
  assert.equal(JSON.stringify(mint.body).includes('anchor'), false, 'the internal reason stays internal');

  const me = await call('GET', '/me', { learner, capable: false });
  assert.equal(me.status, 200, 'the lease keeps the corrupt-anchored profile visible — the invariant');
});

test('NEGATIVE: binding refuses an absent, expired or mismatched run', async () => {
  // R6 11f, at the use-case seam the mint calls.
  const { configureRuntime: cfg, resetRuntime: reset } = await import('../src/runtime.js');
  const { InMemorySimulationRepository: Mem } = await import('../src/repository.js');
  const { startSmokeRun, bindProfileToSmokeRun } = await import('../src/store.js');

  let clock = Date.parse('2026-07-29T00:00:00Z');
  const repo = new Mem();
  cfg({ repository: repo, now: () => clock });
  try {
    await assert.rejects(() => bindProfileToSmokeRun('l-bind', 'run-absent0000000000'), (e) => e.status === 403);

    const run = await startSmokeRun('l-bind');
    await assert.rejects(() => bindProfileToSmokeRun('l-somebody-else', run.runId), (e) => e.status === 403);

    clock += 9 * 864e5; // past ownership
    await assert.rejects(() => bindProfileToSmokeRun('l-bind', run.runId), (e) => e.status === 403);
  } finally {
    reset();
  }
});

test('a mint stamps the WINNING lease horizon, never its own', async () => {
  // A newer run's lease is already durable when an older mint completes. If that mint stamped its
  // OWN horizon onto a not-yet-stamped profile, the profile's anchor — and, in the managed adapter,
  // its physical ttl — would sit BELOW the effective lease horizon: the row could be TTL-deleted
  // while the lease still promised it. Monotonic stamping cannot save the FIRST stamp, so the value
  // stamped must be the winner the lease answered with.
  const { configureRuntime: cfg, resetRuntime: reset } = await import('../src/runtime.js');
  const { InMemorySimulationRepository: Mem } = await import('../src/repository.js');
  const { startSmokeRun } = await import('../src/store.js');

  let clock = Date.parse('2026-07-29T00:00:00Z');
  const repo = new Mem();
  cfg({ repository: repo, now: () => clock });
  try {
    // An ordinary, unstamped profile exists before any of this learner's runs.
    await repo.saveProfile({ learnerId: 'l-winner-e2e', email: 'x@local.invalid', displayName: 'W' });

    // A newer concurrent run's lease has already committed a farther horizon.
    const h2 = new Date(clock + 16 * 864e5).toISOString();
    await repo.extendSmokeLease({ learnerId: 'l-winner-e2e', retainUntil: h2 });

    // The OLDER mint completes now: its own ownership horizon (8d) loses to the lease (16d).
    const run = await startSmokeRun('l-winner-e2e');
    const own = (await repo.getSmokeRun(run.runId)).ownershipExpiresAt;
    assert.ok(Date.parse(own) < Date.parse(h2), 'the fixture requires the run to lose');

    const stored = repo.state.profiles['l-winner-e2e'];
    assert.equal(stored.retainUntil, h2, 'the first stamp must carry the winning horizon');
  } finally {
    reset();
  }
});
