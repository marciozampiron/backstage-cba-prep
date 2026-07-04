// Infrastructure adapter: a zero-dependency AgentOrchestrator that runs a single
// model turn through a ModelProvider port (no tools, no multi-step loop). This is
// the default orchestrator and the testable baseline; the Strands adapter is the
// richer alternative selected by config.

import { assertModelProvider } from '../../application/ports/model-provider.js';
import { AIProviderError, OrchestratorError } from '../../domain/ai-orchestration/errors.js';

export function createDirectOrchestrator({ modelProvider } = {}) {
  assertModelProvider(modelProvider);

  return {
    async run({ prompt, systemPrompt = null, tier = 'standard', options = {} } = {}) {
      try {
        const { text, usage } = await modelProvider.invoke({ prompt, systemPrompt, tier, options });
        return { text, usage, stopReason: (usage && usage.stopReason) || 'end_turn' };
      } catch (err) {
        if (err instanceof AIProviderError) throw err; // already domain-safe
        throw new OrchestratorError(`direct orchestrator failed: ${(err && err.message) || err}`, { cause: err });
      }
    },
  };
}
