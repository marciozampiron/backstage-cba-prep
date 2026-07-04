// Composition root for AI orchestration infrastructure. The application/domain
// layers depend on the ModelProvider / AgentOrchestrator ports; this wires the
// concrete adapter selected by config (env), with no code edit needed to switch.

import { createAnthropicModelProvider } from '../anthropic/model-provider.js';
import { createBedrockModelProvider } from '../bedrock/model-provider.js';
import { createDirectOrchestrator } from '../orchestrator/direct.js';
import { createStrandsOrchestrator } from '../strands/orchestrator.js';
import { createFileAgentRunRepository } from '../persistence/agent-run-repository.js';

// Select the ModelProvider adapter by backend (LLM_BACKEND=anthropic|bedrock).
export function createModelProvider({ env = process.env } = {}) {
  const backend = String(env.LLM_BACKEND || 'anthropic').toLowerCase();
  if (backend === 'anthropic') return createAnthropicModelProvider({ env });
  if (backend === 'bedrock') return createBedrockModelProvider({ env });
  throw new Error(`unknown LLM_BACKEND "${backend}" (use anthropic | bedrock)`);
}

// ORCHESTRATOR=direct (default, zero-dep) | strands (@strands-agents/sdk).
// Opt-in run persistence: set CBA_AGENT_RUNS_FILE to record agent runs to JSON.
export function createAgentOrchestrator({ env = process.env, modelProvider, repository } = {}) {
  const repo = repository || (env.CBA_AGENT_RUNS_FILE ? createFileAgentRunRepository(env.CBA_AGENT_RUNS_FILE) : null);
  const kind = String(env.ORCHESTRATOR || 'direct').toLowerCase();
  if (kind === 'strands') return createStrandsOrchestrator({ env, repository: repo });
  if (kind === 'direct') return createDirectOrchestrator({ modelProvider: modelProvider || createModelProvider({ env }), repository: repo });
  throw new Error(`unknown ORCHESTRATOR "${kind}" (use direct | strands)`);
}
