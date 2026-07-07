import test from 'node:test';
import assert from 'node:assert/strict';
import { runGenerate } from '../src/commands/generate.js';
import { generateBlueprint } from '../src/commands/blueprint.js';
import { DOMAINS } from '../src/lib/blueprint.js';

// Offline: inject a fake ModelProvider (no network) and a capturing append (no
// bank mutation). Verifies that `generate --provider anthropic` routes through
// the ModelProvider port with a tier-based invocation.
test('generate --provider anthropic routes through the ModelProvider port', async () => {
  const catalog = DOMAINS.find((d) => d.key === 'catalog');
  const validQuestion = {
    competency: catalog.competencies[0],
    difficulty: 'easy',
    question: 'Which Backstage feature organizes software components?',
    options: { A: 'Software Catalog', B: 'TechDocs only', C: 'Scaffolder template', D: 'Search plugin only' },
    answer: 'A',
    explanation: 'The Software Catalog organizes software components in Backstage.',
    source: 'https://backstage.io/docs/features/software-catalog/',
    tags: ['port-test'],
  };

  let invoked = null;
  let appended = null;
  const prev = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = 'test-key';
  try {
    const code = await runGenerate({
      provider: 'anthropic',
      domain: 'catalog',
      count: 1,
      model: 'claude-sonnet-5',
      modelProvider: {
        invoke: async (inv) => {
          invoked = inv;
          return {
            text: JSON.stringify({ questions: [validQuestion] }),
            usage: { provider: 'anthropic', model: 'claude-sonnet-5', tier: 'standard', inputTokens: 5, outputTokens: 3, totalTokens: 8, stopReason: 'end_turn' },
          };
        },
      },
      appendImpl: (key, qs) => {
        appended = { key, qs };
        return qs.map((q, i) => ({ ...q, id: `cat-90${i}` }));
      },
    });

    assert.equal(code, 0);
    assert.equal(invoked.tier, 'standard');
    assert.equal(invoked.options.maxTokens, 4096); // preserve the pre-port 4096 output cap
    assert.match(invoked.prompt, /Certified Backstage Associate/);
    assert.equal(appended.key, 'catalog');
    assert.equal(appended.qs.length, 1);
  } finally {
    if (prev === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = prev;
  }
});

const pageFetch = async () => ({ ok: true, status: 200, text: async () => '<html>blueprint page</html>' });
const asExtracted = () => ({
  exam: { name: 'Certified Backstage Associate (CBA)' },
  domains: DOMAINS.map((d) => ({ name: d.name, weight: d.weight, competencies: [...d.competencies] })),
});

test('blueprint --provider anthropic routes through the ModelProvider port', async () => {
  let invoked = null;
  const r = await generateBlueprint({
    from: 'https://x',
    fetchImpl: pageFetch,
    modelProvider: {
      invoke: async (inv) => {
        invoked = inv;
        return { text: JSON.stringify(asExtracted()), usage: { provider: 'anthropic', model: 'claude-sonnet-5', tier: 'standard', inputTokens: 4, outputTokens: 6, totalTokens: 10, stopReason: 'end_turn' } };
      },
    },
  });

  assert.equal(invoked.tier, 'standard');
  assert.equal(invoked.options.maxTokens, 4096);
  assert.deepEqual(r.errors, []);
  assert.equal(r.changed, false); // extracted == current blueprint
  assert.equal(r.usage.totalTokens, 10);
});

test('blueprint ModelProvider path honors LLM_BACKEND=bedrock', async () => {
  const prev = {
    LLM_BACKEND: process.env.LLM_BACKEND,
    BEDROCK_MODEL_STANDARD: process.env.BEDROCK_MODEL_STANDARD,
    MODEL_STANDARD: process.env.MODEL_STANDARD,
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
  };
  process.env.LLM_BACKEND = 'bedrock';
  delete process.env.BEDROCK_MODEL_STANDARD;
  delete process.env.MODEL_STANDARD;
  delete process.env.ANTHROPIC_API_KEY;

  let capturedEnv = null;
  let invoked = null;
  try {
    const r = await generateBlueprint({
      from: 'https://x',
      fetchImpl: pageFetch,
      model: 'us.anthropic.test-profile',
      createModelProviderImpl: ({ env }) => {
        capturedEnv = env;
        return {
          invoke: async (inv) => {
            invoked = inv;
            return { text: JSON.stringify(asExtracted()), usage: { provider: 'bedrock', model: env.BEDROCK_MODEL_STANDARD, tier: 'standard', inputTokens: 4, outputTokens: 6, totalTokens: 10, stopReason: 'end_turn' } };
          },
        };
      },
    });

    assert.equal(capturedEnv.LLM_BACKEND, 'bedrock');
    assert.equal(capturedEnv.BEDROCK_MODEL_STANDARD, 'us.anthropic.test-profile');
    assert.equal(capturedEnv.MODEL_STANDARD, undefined);
    assert.equal(capturedEnv.ANTHROPIC_API_KEY, undefined);
    assert.equal(invoked.tier, 'standard');
    assert.equal(r.usage.provider, 'bedrock');
    assert.equal(r.changed, false);
  } finally {
    for (const [key, value] of Object.entries(prev)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
