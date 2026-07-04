import test from 'node:test';
import assert from 'node:assert/strict';
import { runGenerate } from '../src/commands/generate.js';
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
