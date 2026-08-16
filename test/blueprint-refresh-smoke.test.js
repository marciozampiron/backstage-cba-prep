// The smoke_only contract (#117/#111, Codex's implementation request): EXACTLY ONE standard-tier
// Converse call under the refresh role, evidence, then STOP. These tests read the workflow and
// refuse every way the contract could be hollowed out.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RAW = fs.readFileSync(path.join(ROOT, '.github/workflows/blueprint-refresh.yml'), 'utf8');
const WF = parse(RAW);
const smokeJob = WF.jobs.smoke;
const smoke = smokeJob.steps.find((s) => /Standard-tier smoke/.test(s.name ?? ''));

test('smoke_only: the input exists, closed, defaulting to false, and the step requires it plus the gate', () => {
  const input = (WF.on ?? WF[true]).workflow_dispatch.inputs.smoke_only;
  assert.equal(input.type, 'boolean');
  assert.equal(input.default, false);
  assert.ok(smoke, 'the smoke step exists in its own job');
  // Round 2 (Codex): the smoke is an AUTHORITY BOUNDARY — its own job, minimal permissions.
  assert.match(smokeJob.if, /smoke_only == 'true'/);
  assert.deepEqual(smokeJob.permissions, { contents: 'read', 'id-token': 'write' }, 'contents read-only; no pull-requests permission');
  assert.match(smokeJob.steps[0].run, /confirm_ai_spend=true is required/, 'the paid gate fails closed in the smoke job');
  // …and the refresh job is barred at JOB level under smoke_only.
  assert.match(WF.jobs.refresh.if, /smoke_only != 'true'/);
});

test('smoke_only: exactly ONE Converse call, standard tier only, maxTokens=8, no retry, no fallback', () => {
  const calls = (smoke.run.match(/bedrock-runtime converse/g) ?? []).length;
  assert.equal(calls, 1, 'exactly one invocation in the script');
  const code = smoke.run.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');
  assert.ok(!/for |while |until |retry/i.test(code), 'no loop or retry construct in executable lines');
  assert.match(smoke.run, /"maxTokens":8/);
  assert.match(smoke.run, /BEDROCK_MODEL_STANDARD" != "us\.anthropic\.claude-sonnet-5"/, 'divergent model fails closed');
  assert.ok(!/FAST|CRITICAL/i.test(smoke.run.replace(/Fail closed/g, '')), 'no fast/critical tier appears');
  assert.match(smoke.run, /assumed-role\/cba-study-coach-gha-bedrock-refresh\//, 'identity pinned to the refresh role');
  assert.match(smoke.run, /REFUSED: identity/, 'divergent identity fails closed');
  assert.match(smoke.run, /set -euo pipefail/, 'any failure stops the step — no second attempt');
  // Round 2 (Codex): the CLI's automatic retries are disabled — one ATTEMPT, not one command.
  assert.equal(smoke.env.AWS_MAX_ATTEMPTS, '1');
  assert.match(smoke.run, /export AWS_MAX_ATTEMPTS=1/);
  // Account divergence fails closed, and the account is never printed.
  assert.match(smoke.run, /caller account diverges/, 'divergent account refuses');
  assert.ok(!/echo[^\n]*ACCOUNT_ID|echo[^\n]*\$CALLER_ACCOUNT|echo[^\n]*\$ROLE_ACCOUNT/.test(smoke.run), 'account values are never echoed');
  // Only end_turn is success — every other stopReason refuses.
  assert.match(smoke.run, /"\$STOP" != "end_turn"/, 'non-end_turn stopReason refuses');
  for (const line of ['timestamp=', 'identity=$MASKED', 'region=', 'model=', 'stopReason=', 'attempts=1']) {
    assert.ok(smoke.run.includes(line), `evidence line present: ${line}`);
  }
  assert.match(smoke.run, /sed -E 's\/\[0-9\]\{12\}\/ACCOUNT\/g'/, 'identity is masked');
});

test('smoke_only: the smoke job ends the workflow — the smoke step is LAST, and refresh cannot run', () => {
  assert.equal(smokeJob.steps.indexOf(smoke), smokeJob.steps.length - 1, 'nothing runs after the evidence');
  assert.match(WF.jobs.refresh.if, /smoke_only != 'true'/, 'the refresh job is barred at job level');
  assert.ok(!('needs' in smokeJob), 'the smoke depends on nothing and triggers nothing');
});
