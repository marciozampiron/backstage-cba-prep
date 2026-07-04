import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { agentRun, toolCall } from '../src/domain/ai-orchestration/agent-run.js';
import { assertAgentRunRepository } from '../src/application/ports/agent-run-repository.js';
import { createInMemoryAgentRunRepository, createFileAgentRunRepository } from '../src/infrastructure/persistence/agent-run-repository.js';
import { createDirectOrchestrator } from '../src/infrastructure/orchestrator/direct.js';
import { createAgentOrchestrator } from '../src/infrastructure/ai/index.js';

const okProvider = {
  invoke: async ({ prompt }) => ({ text: `echo:${prompt}`, usage: { provider: 'anthropic', model: 'm', inputTokens: 2, outputTokens: 1, totalTokens: 3, stopReason: 'end_turn' } }),
};
const fixed = { now: () => '2026-07-04T00:00:00.000Z', newId: () => 'run-1' };

test('agentRun/toolCall build neutral records', () => {
  const r = agentRun({ id: 'r1', orchestrator: 'direct', prompt: 'hi', status: 'ok', toolCalls: [{ name: 't', output: 'x' }] });
  assert.equal(r.id, 'r1');
  assert.equal(r.status, 'ok');
  assert.equal(r.toolCalls[0].name, 't');
  assert.equal(toolCall({ name: 'a', error: new Error('boom') }).error, 'Error: boom');
});

test('assertAgentRunRepository enforces the contract', () => {
  assert.throws(() => assertAgentRunRepository({ save() {} }), /save\(run\), get\(id\), list\(\)/);
});

test('in-memory repository saves (upsert), gets, and lists', async () => {
  const repo = createInMemoryAgentRunRepository();
  await repo.save({ id: 'a', status: 'ok' });
  await repo.save({ id: 'a', status: 'error' }); // upsert by id
  assert.equal((await repo.get('a')).status, 'error');
  assert.equal((await repo.list()).length, 1);
});

test('file repository persists across instances', async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cba-runs-')), 'runs.json');
  await createFileAgentRunRepository(file).save({ id: 'x', status: 'ok' });
  const repo2 = createFileAgentRunRepository(file);
  assert.equal((await repo2.get('x')).status, 'ok');
  assert.equal((await repo2.list()).length, 1);
});

test('direct orchestrator records a successful run', async () => {
  const repo = createInMemoryAgentRunRepository();
  const orch = createDirectOrchestrator({ modelProvider: okProvider, repository: repo, ...fixed });
  await orch.run({ prompt: 'ping' });
  const [run] = await repo.list();
  assert.equal(run.id, 'run-1');
  assert.equal(run.status, 'ok');
  assert.equal(run.orchestrator, 'direct');
  assert.equal(run.usage.totalTokens, 3);
  assert.equal(run.startedAt, '2026-07-04T00:00:00.000Z');
  assert.equal(run.finishedAt, '2026-07-04T00:00:00.000Z');
});

test('direct orchestrator records a failed run and still throws', async () => {
  const repo = createInMemoryAgentRunRepository();
  const orch = createDirectOrchestrator({ modelProvider: { invoke: async () => { throw new Error('boom'); } }, repository: repo, ...fixed });
  await assert.rejects(() => orch.run({ prompt: 'x' }));
  const [run] = await repo.list();
  assert.equal(run.status, 'error');
  assert.match(run.error, /boom/);
});

test('direct orchestrator without a repository does not record (backward compatible)', async () => {
  const orch = createDirectOrchestrator({ modelProvider: okProvider });
  const r = await orch.run({ prompt: 'ping' });
  assert.equal(r.text, 'echo:ping');
});

test('createAgentOrchestrator wires a file repository from CBA_AGENT_RUNS_FILE', async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cba-runs-')), 'runs.json');
  const orch = createAgentOrchestrator({ env: { LLM_BACKEND: 'anthropic', CBA_AGENT_RUNS_FILE: file }, modelProvider: okProvider });
  await orch.run({ prompt: 'ping' });
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(saved.runs.length, 1);
  assert.equal(saved.runs[0].status, 'ok');
});
