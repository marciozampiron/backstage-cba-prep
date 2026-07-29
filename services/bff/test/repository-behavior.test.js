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

export function runRepositorySuite(name, makeRepo, { reopen, corruptAnchor } = {}) {
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

  /* ---------------- #75 R6 parcel 1+2: child retention ---------------- */

  const ANCHOR_RUN = 'run-anchor000000000000';

  async function seedChild(repo, learnerId, runId) {
    if (!(await repo.getSmokeRun(runId))) {
      await repo.saveSmokeRun({
        runId,
        learnerId,
        status: 'active',
        writeDeadlineAt: new Date(Date.now() + 864e5).toISOString(),
        ownershipExpiresAt: new Date(Date.now() + 6912e5).toISOString(),
      });
    }
    await repo.saveAttempt({ attemptId: 'att_anchor', learnerId, runId, status: 'in_progress', answers: {} });
    return (await repo.getAttempt('att_anchor')).retainUntil;
  }

  test(`${name}: the repository stamps retainUntil, and a caller cannot set it`, async () => {
    const repo = await makeRepo();
    const anchor = await seedChild(repo, 'l-anchor', ANCHOR_RUN);
    assert.ok(anchor, 'a stamped child must carry an anchor');

    // A caller that can set its own retention has no retention. Each of these is IGNORED, never
    // adopted: the stored anchor is rewritten verbatim on every update.
    const far = new Date(Date.now() + 400 * 24 * 60 * 60 * 1000).toISOString();
    for (const supplied of [far, undefined, null, 'not-a-date', 0, {}]) {
      const record = { attemptId: 'att_anchor', learnerId: 'l-anchor', runId: ANCHOR_RUN, answers: {} };
      if (supplied !== undefined) record.retainUntil = supplied;
      const current = await repo.getAttempt('att_anchor');
      if (repo.revs) repo.revs.set(record, repo.revs.get(current));
      await repo.saveAttempt(record);
      assert.equal((await repo.getAttempt('att_anchor')).retainUntil, anchor, JSON.stringify(supplied));
    }
  });

  test(`${name}: an ordinary child is never stamped and never filtered`, async () => {
    const repo = await makeRepo();
    await repo.saveAttempt({ attemptId: 'att_plain2', learnerId: 'l-plain2', status: 'submitted', answers: {} });
    const plain = await repo.getAttempt('att_plain2');
    assert.equal(plain.retainUntil, undefined, 'no runId means no retention metadata');
    assert.equal((await repo.listAttempts('l-plain2')).length, 1);
  });

  test(`${name}: an expired child is hidden everywhere, and still reachable by cleanup`, async () => {
    const repo = await makeRepo();
    await seedChild(repo, 'l-expired-child', ANCHOR_RUN);
    await repo.saveSession({ practiceSessionId: 'ps_anchor', attemptId: 'att_anchor', learnerId: 'l-expired-child', runId: ANCHOR_RUN });
    await repo.saveMock({ mockExamId: 'mock_anchor', attemptId: 'att_anchor', learnerId: 'l-expired-child', runId: ANCHOR_RUN });

    // The PHYSICAL rows stay: DynamoDB TTL lags by days, so the application must decide.
    repo.now = () => Date.now() + 8 * 24 * 60 * 60 * 1000;

    assert.equal(await repo.getAttempt('att_anchor'), null);
    assert.equal(await repo.getSession('ps_anchor'), null);
    assert.equal(await repo.getMock('mock_anchor'), null);
    assert.deepEqual(await repo.listAttempts('l-expired-child'), []);
    assert.deepEqual(await repo.listMocks('l-expired-child'), []);

    // Cleanup reads RAW. Sharing the filter here would report a clean run while the rows remained.
    const raw = await repo.rawSmokeChildren({ learnerId: 'l-expired-child', runId: ANCHOR_RUN });
    assert.equal(raw.attempts.length, 1);
    assert.equal(raw.sessions.length, 1);
    assert.equal(raw.mocks.length, 1);

    const counted = await repo.countSmokeRunRecords({ learnerId: 'l-expired-child', runId: ANCHOR_RUN });
    assert.deepEqual(counted, { practiceSessions: 1, mockExams: 1, attempts: 1 },
      'verification must not report zero while physical rows remain');

    const deleted = await repo.deleteSmokeRunData({ learnerId: 'l-expired-child', runId: ANCHOR_RUN });
    assert.equal(deleted.attempts, 1);
    assert.deepEqual(await repo.countSmokeRunRecords({ learnerId: 'l-expired-child', runId: ANCHOR_RUN }),
      { practiceSessions: 0, mockExams: 0, attempts: 0 });
  });

  test(`${name}: a corrupted anchor on an EXISTING record fails closed and cannot be restarted`, async () => {
    // No conditional assertions. The previous version guarded everything behind
    // `if (raw.attempts[0]?.retainUntil === broken)`, and for DynamoDB the raw read is a structural
    // clone — so the mutation never persisted, the guard was false, and the test asserted NOTHING
    // while reporting success. That is why the suite stayed green while the defect reproduced.
    assert.equal(typeof corruptAnchor, 'function', `${name} must supply a physical-corruption seam`);

    for (const broken of [
      undefined, null, '', 'soon', '2099', '2026-13-01T00:00:00Z', 42, {},
      Number.NaN, Infinity, -Infinity,
    ]) {
      const repo = await makeRepo();
      await seedChild(repo, 'l-broken', ANCHOR_RUN);

      await corruptAnchor(repo, 'ATTEMPT', 'att_anchor', broken);
      const rawBefore = await repo.rawSmokeChildren({ learnerId: 'l-broken', runId: ANCHOR_RUN });
      assert.equal(rawBefore.attempts.length, 1, `${JSON.stringify(broken)}: the row must still exist`);

      // Hidden from every ordinary accessor…
      assert.equal(await repo.getAttempt('att_anchor'), null, JSON.stringify(broken));
      assert.deepEqual(await repo.listAttempts('l-broken'), [], JSON.stringify(broken));

      // …and NOT rewritable. The update must use the record READ FROM STORAGE, which carries the
      // adapter's revision token: a fresh object has none, so the managed adapter would fall back to
      // `attribute_not_exists(pk)` and be refused for ALREADY EXISTING — the right answer for the
      // wrong reason, and a regression that restarts retention would slip past it.
      await assert.rejects(
        () => repo.saveAttempt(rawBefore.attempts[0]),
        (err) => {
          assert.equal(err.name, 'RepositoryConflictError', JSON.stringify(broken));
          assert.equal(err.reason, 'RETENTION_ANCHOR_UNREADABLE',
            `${JSON.stringify(broken)}: refused for the anchor, not as a lost update`);
          return true;
        },
        `${JSON.stringify(broken)}: a corrupted existing record must not be re-anchored`,
      );

      // …while cleanup still reaches it, which is what stops failing closed from stranding it.
      assert.deepEqual(
        await repo.countSmokeRunRecords({ learnerId: 'l-broken', runId: ANCHOR_RUN }),
        { practiceSessions: 0, mockExams: 0, attempts: 1 },
        JSON.stringify(broken),
      );
      const deleted = await repo.deleteSmokeRunData({ learnerId: 'l-broken', runId: ANCHOR_RUN });
      assert.equal(deleted.attempts, 1, JSON.stringify(broken));
    }
  });

  test(`${name}: POSITIVE CONTROL — a valid existing anchor stays writable and does not move`, async () => {
    const repo = await makeRepo();
    const anchor = await seedChild(repo, 'l-valid-anchor', ANCHOR_RUN);
    for (let i = 0; i < 3; i++) {
      // Mutated IN PLACE, as the application does: a spread would be a new object and would lose
      // the optimistic revision the adapter tracks per read.
      const current = await repo.getAttempt('att_anchor');
      current.answers = { ...current.answers, [i + 1]: { selectedOption: 'A' } };
      await repo.saveAttempt(current);
      assert.equal((await repo.getAttempt('att_anchor')).retainUntil, anchor, `update ${i}`);
    }
  });

  /* ---------------- #75 R6 parcel 3: the active-mock claim ---------------- */

  test(`${name}: a claim is reclaimed LOGICALLY once its run's write window closes`, async () => {
    const repo = await makeRepo();
    await seedChild(repo, 'l-claim-exp', ANCHOR_RUN);
    assert.equal(await repo.claimActiveMock('l-claim-exp', 'mock_held', { runId: ANCHOR_RUN }), true);
    assert.equal(await repo.getActiveMock('l-claim-exp'), 'mock_held');

    // The PHYSICAL claim stays — TTL lags by days. A stale claim blocks every future mock for this
    // learner, which is the exact failure the fence exists to prevent, so the application reclaims.
    repo.now = () => Date.now() + 25 * 60 * 60 * 1000;
    assert.equal(await repo.getActiveMock('l-claim-exp'), null, 'an expired claim reads as absent');

    // Invisible is not enough. The physical row is still there, and requiring its ABSENCE left it
    // blocking every future mock for this learner — the exact failure this parcel exists to
    // prevent. A new run must be able to claim over a provably expired one.
    const NEXT_RUN = 'run-next00000000000000';
    await repo.saveSmokeRun({
      runId: NEXT_RUN,
      learnerId: 'l-claim-exp',
      status: 'active',
      writeDeadlineAt: new Date(repo.now() + 864e5).toISOString(),
      ownershipExpiresAt: new Date(repo.now() + 6912e5).toISOString(),
    });
    assert.equal(await repo.claimActiveMock('l-claim-exp', 'mock_next', { runId: NEXT_RUN }), true,
      'a new run must be able to claim over an expired row');
    assert.equal(await repo.getActiveMock('l-claim-exp'), 'mock_next');
  });

  test(`${name}: at the EXACT deadline the old claim is gone and a new one succeeds`, async () => {
    // The boundary the two rules disagreed on: the read said absent at `now >= deadline` while the
    // write allowed replacement only at `deadline < now`. At exact equality the caller got
    // MOCK_EXAM_IN_PROGRESS naming a winner that read as null — a state nothing can act on.
    const repo = await makeRepo();
    await seedChild(repo, 'l-claim-edge', ANCHOR_RUN);
    assert.equal(await repo.claimActiveMock('l-claim-edge', 'mock_old', { runId: ANCHOR_RUN }), true);

    const deadline = Date.parse((await repo.getSmokeRun(ANCHOR_RUN)).writeDeadlineAt);
    repo.now = () => deadline; // EXACTLY the deadline, not one millisecond past it

    assert.equal(await repo.getActiveMock('l-claim-edge'), null, 'the old claim must read as absent');

    const EDGE_RUN = 'run-edge00000000000000';
    await repo.saveSmokeRun({
      runId: EDGE_RUN,
      learnerId: 'l-claim-edge',
      status: 'active',
      writeDeadlineAt: new Date(deadline + 864e5).toISOString(),
      ownershipExpiresAt: new Date(deadline + 6912e5).toISOString(),
    });
    assert.equal(await repo.claimActiveMock('l-claim-edge', 'mock_edge', { runId: EDGE_RUN }), true,
      'and the new claim must succeed at the same instant');
    assert.equal(await repo.getActiveMock('l-claim-edge'), 'mock_edge');
  });

  test(`${name}: a LIVE claim still excludes another, expired or not`, async () => {
    // The replacement must not weaken mutual exclusion between claims that are still inside their
    // window — that is the invariant the whole projection exists for.
    const repo = await makeRepo();
    await seedChild(repo, 'l-claim-live', ANCHOR_RUN);
    assert.equal(await repo.claimActiveMock('l-claim-live', 'mock_a', { runId: ANCHOR_RUN }), true);
    assert.equal(await repo.claimActiveMock('l-claim-live', 'mock_b', { runId: ANCHOR_RUN }), false);
    assert.equal(await repo.getActiveMock('l-claim-live'), 'mock_a');
  });

  test(`${name}: a malformed run deadline refuses the claim, and writes nothing`, async () => {
    // The transaction exists to close the window between the application's check and the write.
    // Accepting an unreadable bound there wrote a claim the read path then had to hide.
    const repo = await makeRepo();
    await seedChild(repo, 'l-claim-bad', ANCHOR_RUN);
    const run = await repo.getSmokeRun(ANCHOR_RUN);
    run.writeDeadlineAt = 'tomorrow';
    await repo.saveSmokeRun(run);

    await assert.rejects(
      () => repo.claimActiveMock('l-claim-bad', 'mock_bad', { runId: ANCHOR_RUN }),
      (err) => err.name === 'RepositoryConflictError',
      'an unreadable deadline must be refused, not written',
    );
    assert.equal(await repo.getActiveMock('l-claim-bad'), null, 'and nothing may have been written');
  });

  test(`${name}: an ordinary claim carries no run and is never reclaimed`, async () => {
    const repo = await makeRepo();
    assert.equal(await repo.claimActiveMock('l-claim-plain', 'mock_plain2'), true);
    repo.now = () => Date.now() + 400 * 24 * 60 * 60 * 1000;
    assert.equal(await repo.getActiveMock('l-claim-plain'), 'mock_plain2', 'no run, no reclaim');
  });

  test(`${name}: a claim cannot be written once the run's window has closed`, async () => {
    const repo = await makeRepo();
    await seedChild(repo, 'l-claim-pin', ANCHOR_RUN);

    // Move the run's horizon into the past, as a concurrent close would. The claim write is pinned
    // to the run holding a FUTURE deadline, so it must be refused — not written and reclaimed later.
    const run = await repo.getSmokeRun(ANCHOR_RUN);
    run.writeDeadlineAt = new Date(Date.now() - 1000).toISOString();
    await repo.saveSmokeRun(run);

    await assert.rejects(
      () => repo.claimActiveMock('l-claim-pin', 'mock_pin', { runId: ANCHOR_RUN }),
      (err) => err.name === 'RepositoryConflictError',
      'a closed window must refuse the claim outright',
    );
    assert.equal(await repo.getActiveMock('l-claim-pin'), null, 'and nothing may have been written');
  });

  /* ---------------- #75 R6: the profile retention lease ---------------- */

  const H = (days) => new Date(Date.now() + days * 864e5).toISOString();

  test(`${name}: the lease is monotonic — an older mint can never shorten a newer horizon`, async () => {
    const repo = await makeRepo();
    const h8 = H(8);
    const h16 = H(16);
    await repo.extendSmokeLease({ learnerId: 'l-lease-mono', retainUntil: h8 });
    const extended = await repo.extendSmokeLease({ learnerId: 'l-lease-mono', retainUntil: h16 });
    assert.equal(extended.retainUntil, h16, 'extends forward');

    // The OLDER mint completes last — reverse order. Max cannot move backwards, so completion
    // order stops mattering; the older write loses and losing is harmless.
    const after = await repo.extendSmokeLease({ learnerId: 'l-lease-mono', retainUntil: h8 });
    assert.equal(after.retainUntil, h16, 'the newer horizon survives');
    assert.equal((await repo.getSmokeLease('l-lease-mono')).retainUntil, h16);
  });

  test(`${name}: a malformed lease horizon is refused, never written`, async () => {
    const repo = await makeRepo();
    for (const bad of ['tomorrow', '2099', '', null, undefined, 42]) {
      await assert.rejects(
        () => repo.extendSmokeLease({ learnerId: 'l-lease-bad', retainUntil: bad }),
        (err) => err.name === 'RepositoryConflictError',
        JSON.stringify(bad),
      );
    }
    assert.equal(await repo.getSmokeLease('l-lease-bad'), null);
  });

  test(`${name}: a profile CREATED under an unexpired lease is stamped from it`, async () => {
    // 12a: the learner minted before their first /api/me. The lease is what makes that safe — the
    // profile is bounded AT CREATION, so no window exists in which an unbounded smoke profile can.
    const repo = await makeRepo();
    const lease = await repo.extendSmokeLease({ learnerId: 'l-lease-birth', retainUntil: H(8) });
    await repo.saveProfile({ learnerId: 'l-lease-birth', email: 'x@local.invalid', displayName: 'S' });

    const visible = await repo.getProfile('l-lease-birth');
    assert.ok(visible, 'visible while the lease is live');
    assert.equal(visible.retainUntil, lease.retainUntil, 'stamped from the lease at creation');

    // 11a + 11e: /api/me never called again; past the horizon the profile AND the lease are
    // logically expired while both rows physically remain — TTL is housekeeping, not the answer.
    repo.now = () => Date.now() + 9 * 864e5;
    assert.equal(await repo.getProfile('l-lease-birth'), null, 'hidden with the row still present');
  });

  test(`${name}: an ordinary learner is never leased, stamped or hidden`, async () => {
    const repo = await makeRepo();
    await repo.saveProfile({ learnerId: 'l-ordinary-p', email: 'o@local.invalid', displayName: 'O' });
    const p = await repo.getProfile('l-ordinary-p');
    assert.equal(p.retainUntil, undefined, 'no lease means no stamp');
    repo.now = () => Date.now() + 400 * 864e5;
    assert.ok(await repo.getProfile('l-ordinary-p'), 'and never hidden, however far the clock goes');
  });

  test(`${name}: a caller-supplied retainUntil is discarded, and updates never extend a live anchor`, async () => {
    const repo = await makeRepo();
    const lease = await repo.extendSmokeLease({ learnerId: 'l-lease-own', retainUntil: H(8) });
    await repo.saveProfile({ learnerId: 'l-lease-own', email: 'x@local.invalid', displayName: 'A', retainUntil: H(400) });
    const born = await repo.getProfile('l-lease-own');
    assert.equal(born.retainUntil, lease.retainUntil, 'the supplied far-future anchor was discarded');

    born.displayName = 'B';
    born.retainUntil = H(400); // discarded again on update
    await repo.saveProfile(born);
    const updated = await repo.getProfile('l-lease-own');
    assert.equal(updated.retainUntil, lease.retainUntil, 'an ordinary update cannot extend retention');
    assert.equal(updated.displayName, 'B');
  });

  test(`${name}: the invariant — while an unexpired lease exists, the profile stays visible`, async () => {
    // 11d shape: a stamped profile whose anchor is CORRUPT contributes nothing, but the lease still
    // supplies the effective horizon. The stamp itself refuses, so the mint fails — and nothing
    // visible is under-retained meanwhile.
    assert.equal(typeof corruptAnchor, 'function', `${name} must supply a corruption seam`);
    const repo = await makeRepo();
    await repo.extendSmokeLease({ learnerId: 'l-lease-inv', retainUntil: H(8) });
    await repo.saveProfile({ learnerId: 'l-lease-inv', email: 'x@local.invalid', displayName: 'I' });
    await corruptProfileAnchor(repo, 'l-lease-inv', 'soon');

    assert.ok(await repo.getProfile('l-lease-inv'), 'the live lease keeps it visible');
    await assert.rejects(
      () => repo.stampProfileRetention({ learnerId: 'l-lease-inv', retainUntil: H(8) }),
      (err) => err.reason === 'RETENTION_ANCHOR_UNREADABLE',
      'the stamp must refuse a corrupt anchor rather than repair it',
    );
  });

  test(`${name}: an expired-but-present profile is reclaimed, and the learner is never stuck`, async () => {
    const repo = await makeRepo();
    await repo.extendSmokeLease({ learnerId: 'l-reclaim', retainUntil: H(1) });
    await repo.saveProfile({ learnerId: 'l-reclaim', email: 'x@local.invalid', displayName: 'R1' });

    // Past the horizon: hidden, physically present — the shape that used to deadlock bootstrap.
    const later = Date.now() + 2 * 864e5;
    repo.now = () => later;
    assert.equal(await repo.getProfile('l-reclaim'), null);

    // A new run's lease, then the bootstrap-shaped create: it must RECLAIM, not conflict forever.
    await repo.extendSmokeLease({ learnerId: 'l-reclaim', retainUntil: new Date(later + 8 * 864e5).toISOString() });
    await repo.saveProfile({ learnerId: 'l-reclaim', email: 'x@local.invalid', displayName: 'R2' });
    const reclaimed = await repo.getProfile('l-reclaim');
    assert.ok(reclaimed, 'the learner is not stuck until TTL');
    assert.equal(reclaimed.displayName, 'R2');
    assert.ok(Date.parse(reclaimed.retainUntil) > later, 'stamped from the new lease');
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

/** Corrupt a PROFILE's stored anchor in place, for the lease-invariant tests. */
async function corruptProfileAnchor(repo, learnerId, value) {
  if (repo.state) {
    repo.state.profiles[learnerId].retainUntil = value;
    repo.persist();
    return;
  }
  for (const [, item] of repo._fakeStore.items) {
    if (item.pk === `PROFILE#${learnerId}`) item.record.retainUntil = value;
  }
}

/** Physical corruption seam: write straight into storage, as a legacy or partial write would. */
const corruptLocalAnchor = async (repo, type, id, value) => {
  const bag = { ATTEMPT: 'attempts', SESSION: 'sessions', MOCK: 'mocks' }[type];
  const record = repo.state[bag][id];
  if (value === undefined) delete record.retainUntil;
  else record.retainUntil = value;
  repo.persist();
};

runRepositorySuite('memory', async () => new InMemorySimulationRepository(), { corruptAnchor: corruptLocalAnchor });

const tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'cba-repo-suite-'));
let fileCounter = 0;
runRepositorySuite(
  'file',
  async () => new FileSimulationRepository(path.join(tmpRoot, `s${++fileCounter}`, 'simulation.json')),
  { reopen: async (repo) => new FileSimulationRepository(repo.filePath), corruptAnchor: corruptLocalAnchor },
);

test('file suite cleanup', () => {
  rmSync(tmpRoot, { recursive: true, force: true });
});
