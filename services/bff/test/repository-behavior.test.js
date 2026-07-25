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

  if (reopen) {
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
