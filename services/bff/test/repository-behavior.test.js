// Behavioral suite for the ASYNC SimulationRepository port (#77 Stage A): every adapter must
// pass the exact same suite. Memory and file run here; the DynamoDB adapter joins with its
// mock client in Stage B (same `runRepositorySuite`, imported from this file).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  InMemorySimulationRepository,
  FileSimulationRepository,
} from '../src/repository.js';

export function runRepositorySuite(name, makeRepo, { reopen } = {}) {
  test(`${name}: nextId is awaitable, unique, and prefix-scoped`, async () => {
    const repo = await makeRepo();
    const a = await repo.nextId('att');
    const b = await repo.nextId('att');
    assert.match(a, /^att_/);
    assert.match(b, /^att_/);
    assert.notEqual(a, b);
  });

  test(`${name}: session round-trip and miss`, async () => {
    const repo = await makeRepo();
    assert.equal(await repo.getSession('nope'), null);
    await repo.saveSession({ practiceSessionId: 'ps_1', attemptId: 'att_1', learnerId: 'l1' });
    const s = await repo.getSession('ps_1');
    assert.equal(s.attemptId, 'att_1');
  });

  test(`${name}: attempt round-trip, learner-scoped listing`, async () => {
    const repo = await makeRepo();
    assert.equal(await repo.getAttempt('nope'), null);
    await repo.saveAttempt({ attemptId: 'att_a', learnerId: 'l1', status: 'in_progress' });
    await repo.saveAttempt({ attemptId: 'att_b', learnerId: 'l1', status: 'submitted' });
    await repo.saveAttempt({ attemptId: 'att_c', learnerId: 'l2', status: 'submitted' });
    const got = await repo.getAttempt('att_a');
    assert.equal(got.learnerId, 'l1');
    const l1 = await repo.listAttempts('l1');
    const l2 = await repo.listAttempts('l2');
    assert.deepEqual(l1.map((a) => a.attemptId).sort(), ['att_a', 'att_b']);
    assert.deepEqual(l2.map((a) => a.attemptId), ['att_c']);
    assert.deepEqual(await repo.listAttempts('l3'), []);
  });

  test(`${name}: attempt updates replace the stored record`, async () => {
    const repo = await makeRepo();
    await repo.saveAttempt({ attemptId: 'att_u', learnerId: 'l1', status: 'in_progress', answers: {} });
    const first = await repo.getAttempt('att_u');
    first.status = 'submitted';
    first.answers[1] = { selectedOption: 'B' };
    await repo.saveAttempt(first);
    const again = await repo.getAttempt('att_u');
    assert.equal(again.status, 'submitted');
    assert.equal(again.answers[1].selectedOption, 'B');
  });

  test(`${name}: mock round-trip, learner-scoped listing`, async () => {
    const repo = await makeRepo();
    assert.equal(await repo.getMock('nope'), null);
    await repo.saveMock({ mockExamId: 'mock_1', attemptId: 'att_m', learnerId: 'l1', autoSubmitted: false });
    await repo.saveMock({ mockExamId: 'mock_2', attemptId: 'att_n', learnerId: 'l2', autoSubmitted: false });
    const m = await repo.getMock('mock_1');
    assert.equal(m.learnerId, 'l1');
    assert.deepEqual((await repo.listMocks('l1')).map((x) => x.mockExamId), ['mock_1']);
  });

  test(`${name}: active-mock claim is atomic per learner and release-safe`, async () => {
    const repo = await makeRepo();
    assert.equal(await repo.getActiveMock('l1'), null);
    assert.equal(await repo.claimActiveMock('l1', 'mock_a'), true);
    assert.equal(await repo.claimActiveMock('l1', 'mock_b'), false, 'second claim must lose');
    assert.equal(await repo.getActiveMock('l1'), 'mock_a');
    assert.equal(await repo.claimActiveMock('l2', 'mock_c'), true, 'claims are learner-scoped');
    await repo.releaseActiveMock('l1', 'mock_WRONG');
    assert.equal(await repo.getActiveMock('l1'), 'mock_a', 'only the owning claim releases');
    await repo.releaseActiveMock('l1', 'mock_a');
    assert.equal(await repo.getActiveMock('l1'), null);
    assert.equal(await repo.claimActiveMock('l1', 'mock_d'), true, 'reclaim after release');
  });

  test(`${name}: readiness reports the logical adapter shape only`, async () => {
    const repo = await makeRepo();
    const r = await repo.readiness();
    assert.deepEqual(Object.keys(r).sort(), ['adapter', 'ready']);
    assert.equal(typeof r.adapter, 'string');
    assert.equal(r.ready, true);
  });

  /* ---------------- #75 smoke-run cleanup ---------------- */

  const RUN = 'run-20260728-a1b2c3';
  const OTHER = 'run-20260728-zzzzzz';
  const ZERO = { practiceSessions: 0, mockExams: 0, attempts: 0, answers: 0, projections: 0 };

  /** Seed one run's worth of records for a learner, straight through the port. */
  async function seedRun(repo, learnerId, runId, suffix) {
    // The run record has to exist and be ACTIVE: stamped writes are fenced on it, so seeding
    // records for a run that was never opened is not a state the application can produce.
    if (!(await repo.getSmokeRun(runId))) {
      // A seeded run needs a real write deadline: the fence reads it, and a missing one fails
      // closed by design.
      await repo.saveSmokeRun({
        runId,
        learnerId,
        status: 'active',
        startedAt: new Date(0).toISOString(),
        writeDeadlineAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
        ownershipExpiresAt: new Date(Date.now() + 8 * 24 * 60 * 60 * 1000).toISOString(),
      });
    }
    await repo.saveSession({ practiceSessionId: `ps_${suffix}`, attemptId: `att_${suffix}`, learnerId, runId });
    await repo.saveMock({ mockExamId: `mock_${suffix}`, attemptId: `att_${suffix}m`, learnerId, runId });
    await repo.saveAttempt({
      attemptId: `att_${suffix}`,
      learnerId,
      runId,
      status: 'submitted',
      answers: { 1: { selectedOption: 'A' }, 2: { selectedOption: 'B' } },
    });
    await repo.saveAttempt({ attemptId: `att_${suffix}m`, learnerId, runId, status: 'in_progress', answers: {} });
  }

  test(`${name}: deleteSmokeRunData removes the run's records and reports counts`, async () => {
    const repo = await makeRepo();
    await seedRun(repo, 'l-clean', RUN, 'c1');

    const deleted = await repo.deleteSmokeRunData({ learnerId: 'l-clean', runId: RUN });
    assert.equal(deleted.practiceSessions, 1);
    assert.equal(deleted.mockExams, 1);
    assert.equal(deleted.attempts, 2);
    // Answers are counted where they are removed — a zero here next to a deleted attempt would
    // misreport what the cleanup actually did.
    assert.equal(deleted.answers, 2);

    assert.equal(await repo.getSession('ps_c1'), null);
    assert.equal(await repo.getMock('mock_c1'), null);
    assert.equal(await repo.getAttempt('att_c1'), null);
    assert.deepEqual(await repo.listAttempts('l-clean'), []);
  });

  test(`${name}: deleteSmokeRunData is idempotent`, async () => {
    const repo = await makeRepo();
    await seedRun(repo, 'l-replay', RUN, 'r1');
    await repo.deleteSmokeRunData({ learnerId: 'l-replay', runId: RUN });
    // #70 retries this job. A different response on retry would have to be interpreted rather than
    // simply reported.
    for (let i = 0; i < 3; i++) {
      assert.deepEqual(await repo.deleteSmokeRunData({ learnerId: 'l-replay', runId: RUN }), ZERO, `replay ${i}`);
    }
  });

  test(`${name}: deleteSmokeRunData never crosses learner or run`, async () => {
    const repo = await makeRepo();
    await seedRun(repo, 'l-mine', RUN, 'm1');
    await seedRun(repo, 'l-theirs', RUN, 't1');
    await seedRun(repo, 'l-mine', OTHER, 'o1');

    const deleted = await repo.deleteSmokeRunData({ learnerId: 'l-mine', runId: RUN });
    assert.equal(deleted.practiceSessions, 1);

    // Another learner's records, same run id: untouched.
    assert.notEqual(await repo.getSession('ps_t1'), null);
    assert.notEqual(await repo.getMock('mock_t1'), null);
    // Same learner, another run: untouched. Scoping by learner alone would have taken these.
    assert.notEqual(await repo.getSession('ps_o1'), null);
    assert.notEqual(await repo.getAttempt('att_o1'), null);
  });

  test(`${name}: records with no run id are never in scope`, async () => {
    const repo = await makeRepo();
    // An ordinary learner's data carries no run id at all.
    await repo.saveSession({ practiceSessionId: 'ps_plain', attemptId: 'att_plain', learnerId: 'l-plain' });
    await repo.saveAttempt({ attemptId: 'att_plain', learnerId: 'l-plain', status: 'submitted', answers: {} });

    assert.deepEqual(await repo.deleteSmokeRunData({ learnerId: 'l-plain', runId: RUN }), ZERO);
    assert.notEqual(await repo.getSession('ps_plain'), null);
    assert.notEqual(await repo.getAttempt('att_plain'), null);
  });

  test(`${name}: the active-mock claim is released only when its mock is gone`, async () => {
    const repo = await makeRepo();
    await seedRun(repo, 'l-active', RUN, 'a1');
    assert.equal(await repo.claimActiveMock('l-active', 'mock_a1'), true);

    // A stale claim would block every future mock for this learner — a smoke that cleans up and
    // can then never run again is not a cleanup.
    const deleted = await repo.deleteSmokeRunData({ learnerId: 'l-active', runId: RUN });
    assert.ok(deleted.projections >= 1);
    assert.equal(await repo.getActiveMock('l-active'), null);
    assert.equal(await repo.claimActiveMock('l-active', 'mock_next'), true);
  });

  test(`${name}: the profile projection survives while another run's records do`, async () => {
    const repo = await makeRepo();
    await seedRun(repo, 'l-profile', RUN, 'p1');
    await seedRun(repo, 'l-profile', OTHER, 'p2');
    await repo.saveProfile({ learnerId: 'l-profile', displayName: 'Smoke' });

    // The profile carries no run id, so removing it here would damage a run this call never scoped.
    await repo.deleteSmokeRunData({ learnerId: 'l-profile', runId: RUN });
    assert.notEqual(await repo.getProfile('l-profile'), null);

    // Once the last records are gone it goes too, so a smoke learner leaves nothing behind.
    await repo.deleteSmokeRunData({ learnerId: 'l-profile', runId: OTHER });
    assert.equal(await repo.getProfile('l-profile'), null);
  });

  test(`${name}: a closed run refuses every stamped mutation, not just creation`, async () => {
    const repo = await makeRepo();
    await seedRun(repo, 'l-fence', RUN, 'f1');
    await repo.closeSmokeRun(RUN);

    // Fencing creation and not updates closed instances rather than the class: an answer written
    // after cleanup could reinsert an attempt the cleanup had already verified gone.
    for (const [label, write] of Object.entries({
      attempt: () => repo.saveAttempt({ attemptId: 'att_f1', learnerId: 'l-fence', runId: RUN, answers: {} }),
      session: () => repo.saveSession({ practiceSessionId: 'ps_f1', attemptId: 'att_f1', learnerId: 'l-fence', runId: RUN }),
      mock: () => repo.saveMock({ mockExamId: 'mock_f1', attemptId: 'att_f1', learnerId: 'l-fence', runId: RUN }),
    })) {
      await assert.rejects(write, (err) => err?.name === 'RepositoryConflictError', label);
    }
  });

  test(`${name}: a closed run refuses the active-mock claim`, async () => {
    const repo = await makeRepo();
    await seedRun(repo, 'l-claim', RUN, 'c9');
    await repo.closeSmokeRun(RUN);

    // The projection was outside the fence, and the first attempt at fencing it looked the run up
    // from a mock that `startMockExam` has not saved yet — so it checked nothing. The run is passed
    // explicitly now.
    await assert.rejects(
      () => repo.claimActiveMock('l-claim', 'mock_never_saved', { runId: RUN }),
      (err) => err?.name === 'RepositoryConflictError',
    );
    assert.equal(await repo.getActiveMock('l-claim'), null, 'no stale claim may survive cleanup');
  });

  test(`${name}: an ordinary claim with no run is unaffected`, async () => {
    const repo = await makeRepo();
    assert.equal(await repo.claimActiveMock('l-plain-claim', 'mock_plain'), true);
  });

  if (reopen) {
    test(`${name}: a cleaned-up run stays cleaned up across re-instantiation`, async () => {
      const repo = await makeRepo();
      await seedRun(repo, 'l-persist-clean', RUN, 'pc1');
      await seedRun(repo, 'l-persist-clean', OTHER, 'pc2');
      await repo.deleteSmokeRunData({ learnerId: 'l-persist-clean', runId: RUN });

      // The deletion has to be written through, not merely applied in memory: #70 reads the result
      // from a different process than the one that created the records.
      const fresh = await reopen(repo);
      assert.equal(await fresh.getSession('ps_pc1'), null);
      assert.equal(await fresh.getAttempt('att_pc1'), null);
      assert.notEqual(await fresh.getSession('ps_pc2'), null);
      assert.deepEqual(await fresh.deleteSmokeRunData({ learnerId: 'l-persist-clean', runId: RUN }), ZERO);
    });

    test(`${name}: state survives adapter re-instantiation`, async () => {
      const repo = await makeRepo();
      await repo.saveAttempt({ attemptId: 'att_persist', learnerId: 'l1', status: 'submitted' });
      await repo.saveMock({ mockExamId: 'mock_persist', attemptId: 'att_persist', learnerId: 'l1' });
      const fresh = await reopen(repo);
      assert.equal((await fresh.getAttempt('att_persist')).status, 'submitted');
      assert.equal((await fresh.getMock('mock_persist')).learnerId, 'l1');
    });
  }
}

runRepositorySuite('memory', async () => new InMemorySimulationRepository());

const tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'cba-repo-suite-'));
let fileCounter = 0;
runRepositorySuite(
  'file',
  async () => new FileSimulationRepository(path.join(tmpRoot, `s${++fileCounter}`, 'simulation.json')),
  { reopen: async (repo) => new FileSimulationRepository(repo.filePath) },
);

test('file suite cleanup', () => {
  rmSync(tmpRoot, { recursive: true, force: true });
});
