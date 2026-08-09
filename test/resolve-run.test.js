/**
 * The canonical run-resolution procedure, executed — not described (design round 8).
 *
 * Every test drives bin/resolve-run.mjs with a SIMULATED `gh`: `exec` is a scripted closure and
 * `sleep` a recorder, so the contract of SPEC-LANE-006/007 is proven by running it, including the
 * sequences the pasted loop could never exercise — zero-then-found, duplication discovered only
 * AFTER the terminal conclusion, a vanished run, and an identity change.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveRun, ATTEMPTS, INTERVAL_MS, TITLE_RE, StopError } from '../bin/resolve-run.mjs';

const ID = 'cba-70-0123456789abcdef0123456789abcdef';
const TITLE = `cba-release dev_only ${ID}`;
const rows = (...pairs) => JSON.stringify(pairs.map(([databaseId, displayTitle]) => ({ databaseId, displayTitle })));

/** A scripted gh: list responses consumed in order (a function throws instead), watch scripted too. */
function fakeGh({ lists, watch = () => '' }) {
  const listQueue = [...lists];
  const calls = { list: 0, watch: 0, watchedIds: [] };
  const exec = (cmd, args) => {
    assert.equal(cmd, 'gh');
    if (args[0] === 'run' && args[1] === 'list') {
      calls.list += 1;
      // The query must stay pinned: workflow, branch, dispatch event, bounded page, closed fields.
      assert.deepEqual(args.slice(2), [
        '--workflow', 'Release Pilot', '--branch', 'main', '--event', 'workflow_dispatch',
        '--limit', '50', '--json', 'databaseId,displayTitle',
      ]);
      const next = listQueue.length > 1 ? listQueue.shift() : listQueue[0];
      if (typeof next === 'function') return next();
      return next;
    }
    if (args[0] === 'run' && args[1] === 'watch') {
      calls.watch += 1;
      calls.watchedIds.push(args[2]);
      assert.equal(args[3], '--exit-status');
      return watch();
    }
    throw new Error(`unexpected gh invocation: ${args.join(' ')}`);
  };
  return { exec, calls };
}

function sleepRecorder() {
  const waits = [];
  return { waits, sleep: async (ms) => { waits.push(ms); } };
}

const expectStop = async (promise, code) => {
  const err = await promise.then(() => null, (e) => e);
  assert.ok(err instanceof StopError, `expected a StopError, got ${err}`);
  assert.equal(err.code, code);
};

test('the bound and the interval are pinned to the reviewed values', () => {
  assert.equal(ATTEMPTS, 10);
  assert.equal(INTERVAL_MS, 30_000);
});

test('the title grammar is closed — substrings, prefixes and foreign shapes identify nothing', async () => {
  for (const bad of [
    ID, // the id alone is not a run name
    `cba-release dev_only ${ID} extra`,
    `x cba-release dev_only ${ID}`,
    'cba-release dev_only cba-70-0123', // short hex
    `cba-release pilot ${ID}`, // mode outside the closed set
    `cba-release dev_only cba-70-${'A'.repeat(32)}`, // uppercase hex
  ]) {
    assert.equal(TITLE_RE.test(bad), false, bad);
    const { exec } = fakeGh({ lists: [rows()] });
    const { sleep } = sleepRecorder();
    await expectStop(resolveRun({ workflow: 'Release Pilot', title: bad, exec, sleep }), 'RESOLVE_TITLE_MALFORMED');
  }
});

test('a title that merely CONTAINS the wanted name never matches — equality, not substring', async () => {
  const { exec, calls } = fakeGh({
    lists: [rows([1, `${TITLE} (retry)`], [2, `prefix ${TITLE}`])],
  });
  const { sleep, waits } = sleepRecorder();
  await expectStop(resolveRun({ workflow: 'Release Pilot', title: TITLE, exec, sleep }), 'RESOLVE_NO_RUN');
  assert.equal(calls.list, ATTEMPTS);
  // …and no sleep after the final attempt: exactly ATTEMPTS-1 waits, all of the pinned interval.
  assert.deepEqual(waits, Array(ATTEMPTS - 1).fill(INTERVAL_MS));
});

test('zero, then one: the run is found, watched, re-verified and returned', async () => {
  const { exec, calls } = fakeGh({
    lists: [rows(), rows(), rows([42, TITLE], [7, 'unrelated run'])],
  });
  const { sleep, waits } = sleepRecorder();
  const runId = await resolveRun({ workflow: 'Release Pilot', title: TITLE, exec, sleep });
  assert.equal(runId, 42);
  assert.deepEqual(calls.watchedIds, ['42']);
  assert.deepEqual(waits, [INTERVAL_MS, INTERVAL_MS]);
  // list, list, list (found), watch, list (re-verification) — the final query is not optional.
  assert.equal(calls.list, 4);
});

test('two runs at the FIRST sight stop immediately, before any watch and any sleep', async () => {
  const { exec, calls } = fakeGh({ lists: [rows([1, TITLE], [2, TITLE])] });
  const { sleep, waits } = sleepRecorder();
  await expectStop(resolveRun({ workflow: 'Release Pilot', title: TITLE, exec, sleep }), 'RESOLVE_DUPLICATE_RUNS');
  assert.equal(calls.watch, 0);
  assert.deepEqual(waits, []);
});

test('a duplicate that appears only DURING the watch is caught by the post-terminal re-check', async () => {
  // First query finds one run; the re-verification after the terminal conclusion finds two.
  const { exec, calls } = fakeGh({
    lists: [rows([42, TITLE]), rows([42, TITLE], [43, TITLE])],
  });
  const { sleep } = sleepRecorder();
  await expectStop(resolveRun({ workflow: 'Release Pilot', title: TITLE, exec, sleep }), 'RESOLVE_DUPLICATE_AFTER_TERMINAL');
  assert.equal(calls.watch, 1); // the duplicate was NOT visible before the watch — only the re-check sees it
});

test('a run that vanished between the watch and the re-check stops', async () => {
  const { exec } = fakeGh({ lists: [rows([42, TITLE]), rows()] });
  const { sleep } = sleepRecorder();
  await expectStop(resolveRun({ workflow: 'Release Pilot', title: TITLE, exec, sleep }), 'RESOLVE_RUN_VANISHED');
});

test('the same name resolving to a DIFFERENT id after the watch stops — identity, not count', async () => {
  const { exec } = fakeGh({ lists: [rows([42, TITLE]), rows([43, TITLE])] });
  const { sleep } = sleepRecorder();
  await expectStop(resolveRun({ workflow: 'Release Pilot', title: TITLE, exec, sleep }), 'RESOLVE_IDENTITY_CHANGED');
});

test('a failed or cancelled run is a stop, not a retry', async () => {
  const { exec } = fakeGh({
    lists: [rows([42, TITLE])],
    watch: () => { throw new Error('exit 1'); },
  });
  const { sleep } = sleepRecorder();
  await expectStop(resolveRun({ workflow: 'Release Pilot', title: TITLE, exec, sleep }), 'RESOLVE_RUN_FAILED');
});

test('gh failing, and gh emitting garbage, are distinct named stops', async () => {
  const failing = fakeGh({ lists: [() => { throw new Error('gh exploded'); }] });
  const { sleep } = sleepRecorder();
  await expectStop(
    resolveRun({ workflow: 'Release Pilot', title: TITLE, exec: failing.exec, sleep }),
    'RESOLVE_GH_LIST_FAILED',
  );
  for (const garbage of ['not json', '{"databaseId":1}', JSON.stringify([{ databaseId: '42', displayTitle: TITLE }])]) {
    const { exec } = fakeGh({ lists: [garbage] });
    await expectStop(
      resolveRun({ workflow: 'Release Pilot', title: TITLE, exec, sleep }),
      'RESOLVE_GH_OUTPUT_UNPARSEABLE',
    );
  }
});

test('a missing workflow name refuses before any gh call', async () => {
  const { exec, calls } = fakeGh({ lists: [rows()] });
  const { sleep } = sleepRecorder();
  await expectStop(resolveRun({ workflow: '  ', title: TITLE, exec, sleep }), 'RESOLVE_WORKFLOW_MISSING');
  assert.equal(calls.list, 0);
});
