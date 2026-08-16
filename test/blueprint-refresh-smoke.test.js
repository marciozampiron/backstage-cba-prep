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
const steps = WF.jobs.refresh.steps;
const smoke = steps.find((s) => /Standard-tier smoke/.test(s.name ?? ''));

test('smoke_only: the input exists, closed, defaulting to false, and the step requires it plus the gate', () => {
  const input = (WF.on ?? WF[true]).workflow_dispatch.inputs.smoke_only;
  assert.equal(input.type, 'boolean');
  assert.equal(input.default, false);
  assert.ok(smoke, 'the smoke step exists');
  assert.match(smoke.if, /smoke_only == 'true'/);
  assert.match(smoke.if, /steps\.gate\.outputs\.skip != 'true'/, 'confirm_ai_spend gating applies to the smoke too');
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
  for (const line of ['timestamp=', 'identity=$MASKED', 'region=', 'model=', 'stopReason=', 'attempts=1']) {
    assert.ok(smoke.run.includes(line), `evidence line present: ${line}`);
  }
  assert.match(smoke.run, /sed -E 's\/\[0-9\]\{12\}\/ACCOUNT\/g'/, 'identity is masked');
});

test('smoke_only: the workflow TERMINATES after the evidence — every later step refuses to run', () => {
  const after = steps.slice(steps.indexOf(smoke) + 1);
  assert.ok(after.length >= 4, 'the refresh/PR steps exist after the smoke');
  for (const s of after) {
    assert.match(String(s.if ?? ''), /smoke_only != 'true'/, `step "${s.name ?? s.uses}" must refuse under smoke_only`);
  }
});
