// The #117 discriminants: each tier resolves EXACTLY its approved Bedrock inference profile,
// and NOTHING — unknown tier, missing config, AccessDenied — ever swaps a model silently.
// The tier NAME is a functional category: fast deliberately does not mean lowest-cost
// (Zamp's decision, on the record in model-config.js and issue #117).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveModelConfig, modelForTier } from '../src/lib/model-config.js';
import { createBedrockModelProvider } from '../src/infrastructure/bedrock/model-provider.js';

const APPROVED = {
  fast: 'us.anthropic.claude-opus-4-8',
  standard: 'us.anthropic.claude-sonnet-5',
  critical: 'us.anthropic.claude-opus-5',
};
const bedrockCfg = () => resolveModelConfig({ LLM_BACKEND: 'bedrock', AWS_REGION: 'us-east-1' });

test('#117: each tier resolves exactly the approved profile id — and never a neighbour generation', () => {
  const cfg = bedrockCfg();
  for (const [tier, id] of Object.entries(APPROVED)) assert.equal(modelForTier(cfg, tier), id);
  // fast never drifts to Haiku or another Opus…
  assert.ok(!/haiku/.test(modelForTier(cfg, 'fast')));
  assert.ok(!/opus-5|opus-4-6/.test(modelForTier(cfg, 'fast')));
  // …standard never to Sonnet 4.6 or another tier's model…
  assert.ok(!/sonnet-4-6|opus|haiku/.test(modelForTier(cfg, 'standard')));
  // …critical never to Opus 4.8/4.6.
  assert.ok(!/opus-4-8|opus-4-6/.test(modelForTier(cfg, 'critical')));
});

test('#117: unknown tier and missing configuration fail CLOSED, by name — no fallback', () => {
  const cfg = bedrockCfg();
  assert.throws(() => modelForTier(cfg, 'turbo'), /unknown model tier "turbo".*no fallback/);
  assert.throws(() => modelForTier(cfg, undefined), /unknown model tier/);
  const broken = structuredClone(cfg);
  broken.models.critical = '';
  assert.throws(() => modelForTier(broken, 'critical'), /missing model id for tier "critical".*no fallback/);
});

test('#117: AccessDenied propagates without modifying the selection — one attempt, the exact id, no swap', async () => {
  const attempts = [];
  class FakeCommand { constructor(input) { this.input = input; } }
  const client = {
    send: async (cmd) => {
      attempts.push(cmd.input.modelId);
      const err = new Error('AccessDeniedException: not authorized to invoke');
      err.name = 'AccessDeniedException';
      throw err;
    },
  };
  const provider = createBedrockModelProvider({
    env: { LLM_BACKEND: 'bedrock', AWS_REGION: 'us-east-1' },
    client,
    ConverseCommand: FakeCommand,
  });
  await assert.rejects(
    () => provider.invoke({ prompt: 'x', tier: 'critical' }),
    (e) => /access denied/i.test(e.message) && /us\.anthropic\.claude-opus-5/.test(e.message),
  );
  assert.deepEqual(attempts, ['us.anthropic.claude-opus-5'], 'exactly ONE attempt, with the exact approved id — a failure never retries under another model');
});
