import test from 'node:test';
import assert from 'node:assert/strict';
import { runAgentCheck } from '../src/commands/agent-check.js';

function capture() {
  const lines = [];
  return { log: (m) => lines.push(m), json: () => JSON.parse(lines.join('\n')) };
}

test('agent-check --json reports readiness for the anthropic backend (no spend)', async () => {
  const cap = capture();
  const code = await runAgentCheck({ env: { LLM_BACKEND: 'anthropic' }, json: true, log: cap.log });
  const data = cap.json();
  assert.equal(code, 0);
  assert.equal(data.backend, 'anthropic');
  assert.equal(data.orchestrator, 'direct');
  assert.equal(data.ok, true);
  assert.equal(data.providerOk, true);
  assert.equal(data.orchestratorOk, true);
  assert.ok(data.warnings.some((w) => /ANTHROPIC_API_KEY/.test(w))); // no key -> warning, not error
});

test('agent-check --json flags a misconfigured bedrock backend as not ready', async () => {
  const cap = capture();
  const code = await runAgentCheck({ env: { LLM_BACKEND: 'bedrock' }, json: true, log: cap.log }); // no region
  const data = cap.json();
  assert.equal(code, 1);
  assert.equal(data.ok, false);
  assert.equal(data.providerOk, false);
  assert.ok(data.errors.some((e) => /AWS_REGION/.test(e)));
});

test('agent-check flags an unknown orchestrator', async () => {
  const cap = capture();
  const code = await runAgentCheck({ env: { LLM_BACKEND: 'anthropic', ORCHESTRATOR: 'nope' }, json: true, log: cap.log });
  assert.equal(code, 1);
  assert.ok(cap.json().errors.some((e) => /unknown ORCHESTRATOR/.test(e)));
});

test('agent-check --smoke runs the orchestrator via an injected factory', async () => {
  let ran = null;
  const code = await runAgentCheck({
    env: { LLM_BACKEND: 'anthropic' },
    smoke: true,
    yes: true,
    log: () => {},
    createAgentOrchestrator: () => ({
      run: async (req) => {
        ran = req;
        return { text: 'pong', usage: { provider: 'anthropic', inputTokens: 2, outputTokens: 1, totalTokens: 3 } };
      },
    }),
  });
  assert.equal(code, 0);
  assert.equal(ran.prompt, 'ping');
  assert.equal(ran.options.maxTokens, 8);
});
