// Infrastructure adapter: a zero-dependency AgentOrchestrator that runs a single
// model turn through a ModelProvider port (no tools, no multi-step loop). This is
// the default orchestrator and the testable baseline; the Strands adapter is the
// richer alternative selected by config. When a repository is provided it records
// each run (status/usage/error); `now`/`newId` are injectable for deterministic tests.

import { randomUUID } from 'node:crypto';
import { assertModelProvider } from '../../application/ports/model-provider.js';
import { agentRun } from '../../domain/ai-orchestration/agent-run.js';
import { AIProviderError, OrchestratorError } from '../../domain/ai-orchestration/errors.js';

export function createDirectOrchestrator({ modelProvider, repository = null, now = () => new Date().toISOString(), newId = randomUUID } = {}) {
  assertModelProvider(modelProvider);

  return {
    async run({ prompt, systemPrompt = null, tier = 'standard', options = {} } = {}) {
      const id = repository ? newId() : null;
      const startedAt = repository ? now() : null;
      try {
        const { text, usage } = await modelProvider.invoke({ prompt, systemPrompt, tier, options });
        if (repository) {
          await repository.save(agentRun({ id, orchestrator: 'direct', backend: usage && usage.provider, prompt, status: 'ok', usage, startedAt, finishedAt: now() }));
        }
        return { text, usage, stopReason: (usage && usage.stopReason) || 'end_turn' };
      } catch (err) {
        if (repository) {
          await repository.save(agentRun({ id, orchestrator: 'direct', prompt, status: 'error', error: (err && err.message) || String(err), startedAt, finishedAt: now() }));
        }
        if (err instanceof AIProviderError) throw err; // already domain-safe
        throw new OrchestratorError(`direct orchestrator failed: ${(err && err.message) || err}`, { cause: err });
      }
    },
  };
}
