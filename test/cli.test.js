import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { auditSources } from '../src/commands/audit-sources.js';
import { generateBlueprint } from '../src/commands/blueprint.js';
import { recordReviewDecision, reviewStateForQuestion } from '../src/domain/authoring-review/review-ledger.js';
import { validateQuestion as validateDomainQuestion } from '../src/domain/exam-content/question-validation.js';
import { summarizeResults } from '../src/domain/simulation/scoring.js';
import { DOMAINS } from '../src/lib/blueprint.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function runCli(args, opts = {}) {
  const home = opts.home || fs.mkdtempSync(path.join(os.tmpdir(), 'cba-cli-test-'));
  return spawnSync(process.execPath, ['bin/cli.js', ...args], {
    cwd: ROOT,
    input: opts.input,
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1', HOME: home, ...(opts.env || {}) },
  });
}

function parseJson(stdout) {
  try {
    return JSON.parse(stdout);
  } catch (err) {
    assert.fail('stdout was not JSON: ' + stdout + '\n' + err.message);
  }
}

test('domain question validation runs without the file-backed bank adapter', () => {
  const domain = DOMAINS.find((d) => d.key === 'catalog');
  const errors = validateDomainQuestion({
    id: 'cat-999',
    domain: domain.name,
    competency: domain.competencies[0],
    difficulty: 'easy',
    question: 'Which Backstage feature helps organize software components?',
    options: { A: 'Software Catalog', B: 'TechDocs only', C: 'Scaffolder template', D: 'Search plugin only' },
    answer: 'A',
    explanation: 'The Software Catalog is the Backstage system for organizing software components.',
    source: 'https://backstage.io/docs/features/software-catalog/',
    tags: ['domain-unit'],
  }, domain);

  assert.deepEqual(errors, []);
});

test('domain scoring summarizes results with injected exam domains', () => {
  const domains = [{ key: 'catalog', name: 'Backstage Catalog', weight: 22 }];
  const summary = summarizeResults([
    { domainKey: 'catalog', correct: true, skipped: false },
    { domainKey: 'catalog', correct: false, skipped: true },
  ], domains);

  assert.deepEqual(summary, {
    correct: 1,
    total: 2,
    answered: 1,
    pct: 50,
    per: { catalog: { name: 'Backstage Catalog', weight: 22, correct: 1, total: 2 } },
  });
});

test('review ledger marks changed reviewed content as stale', () => {
  const domain = DOMAINS.find((d) => d.key === 'catalog');
  const question = {
    id: 'cat-999',
    _domainKey: 'catalog',
    domain: domain.name,
    competency: domain.competencies[0],
    difficulty: 'easy',
    question: 'Which Backstage feature helps organize software components?',
    options: { A: 'Software Catalog', B: 'TechDocs only', C: 'Scaffolder template', D: 'Search plugin only' },
    answer: 'A',
    explanation: 'The Software Catalog is the Backstage system for organizing software components.',
    source: 'https://backstage.io/docs/features/software-catalog/',
    tags: ['domain-unit'],
  };
  const ledger = recordReviewDecision({ version: 1, reviews: {} }, question, 'verified', { reviewedAt: '2026-07-02T00:00:00.000Z' });

  assert.equal(reviewStateForQuestion(question, ledger).status, 'verified');
  assert.equal(reviewStateForQuestion({ ...question, answer: 'B' }, ledger).status, 'stale');
});

test('review-bank --json reports unreviewed coverage using an isolated ledger', () => {
  const ledgerPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cba-review-ledger-')), 'review-ledger.json');
  const res = runCli(['review-bank', '--json'], { env: { CBA_REVIEW_LEDGER_FILE: ledgerPath } });
  assert.equal(res.status, 0, res.stderr);
  const data = parseJson(res.stdout);
  assert.equal(data.total, 60);
  assert.deepEqual(data.counts, { verified: 0, unreviewed: 60, stale: 0, flagged: 0 });
});

test('review-bank next records a human verified decision', () => {
  const ledgerPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cba-review-ledger-')), 'review-ledger.json');
  const res = runCli(['review-bank', 'next', '--domain', 'catalog'], {
    input: 'v\n',
    env: { CBA_REVIEW_LEDGER_FILE: ledgerPath },
  });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /Marked cat-001 as verified/);

  const ledger = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
  assert.equal(ledger.reviews['cat-001'].status, 'verified');
  assert.equal(typeof ledger.reviews['cat-001'].hash, 'string');
});

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

test('auditSources maps every unique source to one fetch and classifies 200 as ok', async () => {
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
  assert.ok(summary.uniqueUrls > 0);
  assert.ok(summary.uniqueUrls <= summary.totalQuestions);
  assert.equal(calls, summary.uniqueUrls); // deduped: exactly one HEAD per unique URL
  assert.equal(summary.counts.ok, summary.uniqueUrls);
  assert.equal(summary.counts.dead, 0);
  assert.equal(summary.counts.soft, 0);
});

test('auditSources fails (code 2) when sources are dead (404)', async () => {
  const summary = await auditSources({
    concurrency: 20,
    fetchImpl: async () => ({ ok: false, status: 404 }),
  });

  assert.equal(summary.ok, false);
  assert.equal(summary.code, 2);
  assert.equal(summary.counts.dead, summary.uniqueUrls);
  assert.equal(summary.counts.ok, 0);
  assert.equal(summary.counts.soft, 0);
});

test('auditSources soft-passes (code 0) on bot-block / rate-limit (403)', async () => {
  const summary = await auditSources({
    concurrency: 20,
    fetchImpl: async () => ({ ok: false, status: 403 }),
  });

  assert.equal(summary.ok, true);
  assert.equal(summary.code, 0);
  assert.equal(summary.counts.soft, summary.uniqueUrls);
  assert.equal(summary.counts.dead, 0);
  assert.equal(summary.counts.ok, 0);
});

const pageFetch = async () => ({ ok: true, status: 200, text: async () => '<html>blueprint page</html>' });
const asExtracted = () => ({
  exam: { name: 'Certified Backstage Associate (CBA)' },
  domains: DOMAINS.map((d) => ({ name: d.name, weight: d.weight, competencies: [...d.competencies] })),
});

test('generateBlueprint reports no change when the page matches the local blueprint', async () => {
  const r = await generateBlueprint({ from: 'https://x', fetchImpl: pageFetch, callImpl: async () => JSON.stringify(asExtracted()) });
  assert.deepEqual(r.errors, []);
  assert.equal(r.changed, false);
  assert.equal(r.next.domains.length, 4);
});

test('generateBlueprint detects a weight change as a diff, preserving prefixes', async () => {
  const extracted = asExtracted();
  extracted.domains[0].weight = 30; // dev 24 -> 30
  extracted.domains[3].weight = 26; // cust 32 -> 26 (sum stays 100)
  const r = await generateBlueprint({ from: 'https://x', fetchImpl: pageFetch, callImpl: async () => JSON.stringify(extracted) });
  assert.deepEqual(r.errors, []);
  assert.equal(r.changed, true);
  assert.ok(r.diff.some((l) => /weight 24% -> 30%/.test(l)));
  assert.equal(r.next.domains[0].prefix, 'dw'); // prefix preserved via name match
});

test('generateBlueprint rejects a blueprint whose weights do not sum to ~100', async () => {
  const extracted = asExtracted();
  extracted.domains[0].weight = 5; // sum falls to 81
  const r = await generateBlueprint({ from: 'https://x', fetchImpl: pageFetch, callImpl: async () => JSON.stringify(extracted) });
  assert.ok(r.errors.some((e) => /weights sum/.test(e)), JSON.stringify(r.errors));
});
