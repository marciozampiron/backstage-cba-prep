import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { aiUsageEvent } from '../src/domain/ai-orchestration/usage.js';
import { AIProviderError, ModelAccessError, ModelInvocationError, ModelNotConfiguredError, OrchestratorError } from '../src/domain/ai-orchestration/errors.js';
import { assertModelProvider } from '../src/application/ports/model-provider.js';
import { assertAgentOrchestrator } from '../src/application/ports/agent-orchestrator.js';
import { createToolRegistry } from '../src/application/ports/tool-registry.js';
import { createBedrockModelProvider, mapBedrockError } from '../src/infrastructure/bedrock/model-provider.js';
import { createDirectOrchestrator } from '../src/infrastructure/orchestrator/direct.js';
import { createStrandsOrchestrator } from '../src/infrastructure/strands/orchestrator.js';
import { createAgentOrchestrator, createModelProvider } from '../src/infrastructure/ai/index.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BEDROCK_ENV = {
  LLM_BACKEND: 'bedrock',
  AWS_REGION: 'us-east-1',
  BEDROCK_MODEL_FAST: 'us.anthropic.claude-haiku-4-5-20251001-v1:0',
  BEDROCK_MODEL_STANDARD: 'us.anthropic.claude-sonnet-5',
  BEDROCK_MODEL_CRITICAL: 'us.anthropic.claude-opus-4-8',
};

// A ConverseCommand stand-in that just captures its input.
class FakeConverseCommand {
  constructor(input) {
    this.input = input;
  }
}
function fakeBedrockClient(response, onSend) {
  return {
    async send(cmd) {
      if (onSend) onSend(cmd);
      if (response instanceof Error) throw response;
      return response;
    },
  };
}

function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

// --- domain (pure) ---

test('aiUsageEvent sums tokens and keeps a provider-neutral shape', () => {
  const u = aiUsageEvent({ provider: 'bedrock', model: 'm', tier: 'standard', inputTokens: 10, outputTokens: 5, stopReason: 'end_turn' });
  assert.equal(u.totalTokens, 15);
  assert.equal(u.provider, 'bedrock');
  assert.equal(u.tier, 'standard');
  assert.equal(u.at, null);
});

test('domain errors are a domain-safe hierarchy with codes', () => {
  const e = new ModelAccessError('nope', { provider: 'bedrock' });
  assert.ok(e instanceof AIProviderError);
  assert.equal(e.code, 'access_denied');
  assert.equal(e.provider, 'bedrock');
});

// --- ports ---

test('assertModelProvider / assertAgentOrchestrator enforce the contract', () => {
  assert.throws(() => assertModelProvider({}), /invoke/);
  assert.throws(() => assertAgentOrchestrator({}), /run/);
  assert.equal(assertModelProvider({ invoke() {} }).invoke.constructor.name, 'Function');
});

test('createToolRegistry registers, lists, and validates tools', () => {
  const reg = createToolRegistry([{ name: 'ping', handler: () => 'pong' }]);
  assert.equal(reg.size, 1);
  reg.register({ name: 'echo', description: 'e', handler: (i) => i });
  assert.deepEqual(reg.names().sort(), ['echo', 'ping']);
  assert.equal(reg.get('ping').handler(), 'pong');
  assert.throws(() => reg.register({ name: 'bad' }), /handler/);
});

// --- Bedrock adapter (mock client, no SDK/network) ---

test('bedrock ModelProvider invokes Converse and returns provider-neutral text + usage', async () => {
  let sent = null;
  const provider = createBedrockModelProvider({
    env: BEDROCK_ENV,
    ConverseCommand: FakeConverseCommand,
    client: fakeBedrockClient(
      { output: { message: { content: [{ text: 'hello ' }, { text: 'world' }] } }, usage: { inputTokens: 12, outputTokens: 4 }, stopReason: 'end_turn' },
      (cmd) => { sent = cmd.input; }
    ),
  });

  const r = await provider.invoke({ prompt: 'hi', tier: 'standard', systemPrompt: 'be brief' });
  assert.equal(r.text, 'hello world');
  assert.equal(r.usage.inputTokens, 12);
  assert.equal(r.usage.totalTokens, 16);
  assert.equal(r.usage.provider, 'bedrock');
  assert.equal(sent.modelId, 'us.anthropic.claude-sonnet-5'); // standard tier
  assert.deepEqual(sent.system, [{ text: 'be brief' }]);
});

test('bedrock ModelProvider selects the model id by tier', async () => {
  let sent = null;
  const provider = createBedrockModelProvider({
    env: BEDROCK_ENV,
    ConverseCommand: FakeConverseCommand,
    client: fakeBedrockClient({ output: { message: { content: [{ text: 'x' }] } }, usage: {}, stopReason: 'end_turn' }, (cmd) => { sent = cmd.input; }),
  });
  await provider.invoke({ prompt: 'hi', tier: 'fast' });
  assert.equal(sent.modelId, 'us.anthropic.claude-haiku-4-5-20251001-v1:0');
});

test('bedrock ModelProvider maps SDK errors to domain-safe errors', async () => {
  const accessErr = Object.assign(new Error('User is not authorized'), { name: 'AccessDeniedException' });
  const provider = createBedrockModelProvider({ env: BEDROCK_ENV, ConverseCommand: FakeConverseCommand, client: fakeBedrockClient(accessErr) });
  await assert.rejects(() => provider.invoke({ prompt: 'hi' }), (err) => err instanceof ModelAccessError && err.code === 'access_denied');
});

test('mapBedrockError flags on-demand/inference-profile validation failures', () => {
  const e = Object.assign(new Error('on-demand throughput isn’t supported'), { name: 'ValidationException' });
  const mapped = mapBedrockError(e, 'anthropic.claude-sonnet-5');
  assert.ok(mapped instanceof ModelInvocationError);
  assert.match(mapped.message, /inference-profile/);
});

// --- Direct orchestrator (mock ModelProvider) ---

test('direct orchestrator runs one model turn and returns the result', async () => {
  const orch = createDirectOrchestrator({
    modelProvider: { invoke: async ({ prompt }) => ({ text: `echo:${prompt}`, usage: aiUsageEvent({ provider: 'bedrock', model: 'm', stopReason: 'end_turn' }) }) },
  });
  const r = await orch.run({ prompt: 'ping' });
  assert.equal(r.text, 'echo:ping');
  assert.equal(r.stopReason, 'end_turn');
});

test('direct orchestrator propagates domain-safe errors and wraps unknown ones', async () => {
  const domainSafe = createDirectOrchestrator({ modelProvider: { invoke: async () => { throw new ModelAccessError('denied', { provider: 'bedrock' }); } } });
  await assert.rejects(() => domainSafe.run({ prompt: 'x' }), (e) => e instanceof ModelAccessError);

  const rawError = createDirectOrchestrator({ modelProvider: { invoke: async () => { throw new Error('boom'); } } });
  await assert.rejects(() => rawError.run({ prompt: 'x' }), (e) => e instanceof OrchestratorError && e.code === 'orchestrator_failed');
});

// --- Strands orchestrator (mock agent factory, no SDK/network) ---

test('strands orchestrator builds an agent by tier and extracts text + usage', async () => {
  let built = null;
  const orch = createStrandsOrchestrator({
    env: BEDROCK_ENV,
    agentFactory: async (cfg) => {
      built = cfg;
      return { invoke: async (prompt) => ({ lastMessage: { role: 'assistant', content: [{ text: `strands:${prompt}` }] }, stopReason: 'end_turn', metrics: { accumulatedUsage: { inputTokens: 7, outputTokens: 3 } } }) };
    },
  });

  const r = await orch.run({ prompt: 'q', tier: 'standard', systemPrompt: 'sys' });
  assert.equal(built.modelId, 'us.anthropic.claude-sonnet-5');
  assert.equal(built.region, 'us-east-1');
  assert.equal(built.systemPrompt, 'sys');
  assert.equal(r.text, 'strands:q');
  assert.equal(r.usage.provider, 'strands+bedrock');
  assert.equal(r.usage.totalTokens, 10);
  assert.equal(r.stopReason, 'end_turn');
});

test('strands orchestrator wraps agent failures as OrchestratorError', async () => {
  const orch = createStrandsOrchestrator({ env: BEDROCK_ENV, agentFactory: async () => ({ invoke: async () => { throw new Error('strands boom'); } }) });
  await assert.rejects(() => orch.run({ prompt: 'x' }), (e) => e instanceof OrchestratorError && e.provider === 'strands');
});

// --- composition root ---

test('createAgentOrchestrator selects direct by default and strands by config', () => {
  assertAgentOrchestrator(createAgentOrchestrator({ env: BEDROCK_ENV }));
  assertAgentOrchestrator(createAgentOrchestrator({ env: { ...BEDROCK_ENV, ORCHESTRATOR: 'strands' } }));
  assertModelProvider(createModelProvider({ env: BEDROCK_ENV }));
  assert.throws(() => createAgentOrchestrator({ env: { ...BEDROCK_ENV, ORCHESTRATOR: 'nope' } }), /unknown ORCHESTRATOR/);
});

test('bedrock-backed adapters fail early when LLM_BACKEND is not bedrock', () => {
  assert.throws(
    () => createBedrockModelProvider({ env: { LLM_BACKEND: 'anthropic' } }),
    (e) => e instanceof ModelNotConfiguredError && /LLM_BACKEND=bedrock/.test(e.message)
  );
  assert.throws(() => createStrandsOrchestrator({ env: { LLM_BACKEND: 'anthropic' } }), (e) => e instanceof ModelNotConfiguredError);
  assert.throws(() => createModelProvider({ env: {} }), (e) => e instanceof ModelNotConfiguredError);
  assert.throws(() => createAgentOrchestrator({ env: {} }), (e) => e instanceof ModelNotConfiguredError);
});

test('bedrock adapter requires AWS_REGION even on the bedrock backend', () => {
  assert.throws(
    () => createBedrockModelProvider({ env: { LLM_BACKEND: 'bedrock' } }),
    (e) => e instanceof ModelNotConfiguredError && /AWS_REGION/.test(e.message)
  );
});

// --- DDD dependency rule (the guardrail the product requires) ---

test('domain and application layers never import AWS/Strands SDKs', () => {
  const offenders = [];
  for (const root of ['src/domain', 'src/application']) {
    for (const file of walk(path.join(ROOT, root))) {
      if (/@aws-sdk|@strands-agents|client-bedrock-runtime/.test(fs.readFileSync(file, 'utf8'))) {
        offenders.push(path.relative(ROOT, file));
      }
    }
  }
  assert.deepEqual(offenders, [], `provider SDK imported in domain/application: ${offenders.join(', ')}`);
});
