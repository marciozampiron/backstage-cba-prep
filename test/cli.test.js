import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { auditSources } from '../src/commands/audit-sources.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function runCli(args, opts = {}) {
  const home = opts.home || fs.mkdtempSync(path.join(os.tmpdir(), 'cba-cli-test-'));
  return spawnSync(process.execPath, ['bin/cli.js', ...args], {
    cwd: ROOT,
    input: opts.input,
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1', HOME: home },
  });
}

function parseJson(stdout) {
  try {
    return JSON.parse(stdout);
  } catch (err) {
    assert.fail('stdout was not JSON: ' + stdout + '\n' + err.message);
  }
}

test('validate --json reports a valid 60-question bank', () => {
  const res = runCli(['validate', '--json']);
  assert.equal(res.status, 0, res.stderr);
  const data = parseJson(res.stdout);
  assert.equal(data.ok, true);
  assert.equal(data.count, 60);
  assert.deepEqual(data.errors, []);
});

test('stats --json reports full blueprint coverage', () => {
  const res = runCli(['stats', '--json']);
  assert.equal(res.status, 0, res.stderr);
  const data = parseJson(res.stdout);
  assert.equal(data.total, 60);
  assert.equal(data.budget, 60);
  assert.equal(data.domains.length, 4);
  assert.deepEqual(data.domains.map((d) => d.count), [14, 13, 13, 20]);
});

test('history --json works with an empty local history', () => {
  const res = runCli(['history', '--json']);
  assert.equal(res.status, 0, res.stderr);
  const data = parseJson(res.stdout);
  assert.equal(data.count, 0);
  assert.deepEqual(data.attempts, []);
  assert.equal(data.weakest, null);
});

test('generate --dry-run emits an item-writing prompt without API keys', () => {
  const res = runCli(['generate', '--domain', 'catalog', '--count', '1', '--dry-run']);
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /Certified Backstage Associate/);
  assert.match(res.stdout, /Return ONLY a JSON object/);
});

test('exam can run a one-question non-interactive smoke test without saving history', () => {
  const res = runCli(['exam', '--count', '1', '--no-timer', '--no-shuffle', '--no-save'], { input: '\nS\n' });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /Mock Exam/);
  assert.match(res.stdout, /RESULTS/);
  assert.doesNotMatch(res.stdout, /Saved to history/);
});

test('auditSources can run with a mocked fetch implementation', async () => {
  let calls = 0;
  const summary = await auditSources({
    concurrency: 20,
    fetchImpl: async () => {
      calls += 1;
      return { ok: true, status: 200 };
    },
  });

  assert.equal(summary.ok, true);
  assert.equal(summary.code, 0);
  assert.equal(summary.totalQuestions, 60);
  assert.equal(summary.uniqueUrls, 14);
  assert.equal(summary.counts.ok, 14);
  assert.equal(summary.counts.dead, 0);
  assert.equal(summary.counts.soft, 0);
  assert.equal(calls, 14);
});
