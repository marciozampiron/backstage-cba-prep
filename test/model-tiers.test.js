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

// ─── ROUND 2 (Codex) ──────────────────────────────────────────────────────────────────────────

test('#117-2: the operational template and the CDK default agree with the central defaults — no override drift', async () => {
  const fs = await import('node:fs');
  // .env.example is the template operators copy: its values must BE the approved trio, or the
  // migration is silently undone by precedence.
  const envExample = fs.readFileSync(new URL('../.env.example', import.meta.url), 'utf8');
  for (const [tier, id] of Object.entries(APPROVED)) {
    const line = `BEDROCK_MODEL_${tier.toUpperCase()}=${id}`;
    assert.ok(envExample.includes(line), `.env.example must carry exactly: ${line}`);
  }
  // The CDK standard-tier default must be the SAME id the central config approves.
  const stack = fs.readFileSync(new URL('../infra/aws/lib/security-stack.js', import.meta.url), 'utf8');
  assert.ok(stack.includes(`'bedrockStandardInferenceProfileId', '${APPROVED.standard}'`), 'the CDK default must equal the approved standard id');
  // …and the infra README documents that same default.
  const readme = fs.readFileSync(new URL('../infra/aws/README.md', import.meta.url), 'utf8');
  assert.ok(readme.includes('`' + APPROVED.standard + '`'), 'infra README must document the approved standard id');
});

test('#117-2: every ADAPTER refuses an unknown tier as a DOMAIN error, with zero external calls', async () => {
  const { createAnthropicModelProvider } = await import('../src/infrastructure/anthropic/model-provider.js');
  const { createStrandsOrchestrator } = await import('../src/infrastructure/strands/orchestrator.js');
  const domainRefusal = (provider) => (e) =>
    e.name === 'ModelNotConfiguredError' && e.code === 'not_configured' && e.provider === provider && /unknown model tier "turbo"/.test(e.message);

  // Bedrock: zero client.send.
  let sends = 0;
  const bedrock = createBedrockModelProvider({
    env: { LLM_BACKEND: 'bedrock', AWS_REGION: 'us-east-1' },
    client: { send: async () => { sends += 1; throw new Error('must not be called'); } },
    ConverseCommand: class { constructor(i) { this.input = i; } },
  });
  await assert.rejects(() => bedrock.invoke({ prompt: 'x', tier: 'turbo' }), domainRefusal('bedrock'));
  assert.equal(sends, 0, 'bedrock: the refusal precedes any client.send');

  // Anthropic: zero fetch.
  let fetches = 0;
  const anthropic = createAnthropicModelProvider({
    env: { LLM_BACKEND: 'anthropic', ANTHROPIC_API_KEY: 'k' },
    apiKey: 'k',
    fetchImpl: async () => { fetches += 1; throw new Error('must not be called'); },
  });
  await assert.rejects(() => anthropic.invoke({ prompt: 'x', tier: 'turbo' }), domainRefusal('anthropic'));
  assert.equal(fetches, 0, 'anthropic: the refusal precedes any fetch');

  // Strands: zero agentFactory.
  let factories = 0;
  const strands = createStrandsOrchestrator({
    env: { LLM_BACKEND: 'bedrock', AWS_REGION: 'us-east-1' },
    agentFactory: async () => { factories += 1; throw new Error('must not be called'); },
  });
  await assert.rejects(() => strands.run({ prompt: 'x', tier: 'turbo' }), domainRefusal('strands'));
  assert.equal(factories, 0, 'strands: the refusal precedes any agentFactory');
});
