// Composition root for AI orchestration infrastructure. The application/domain
// layers depend on the ModelProvider / AgentOrchestrator ports; this wires the
// concrete adapter selected by config (env), with no code edit needed to switch.

import { createAnthropicModelProvider } from '../anthropic/model-provider.js';
import { createBedrockModelProvider } from '../bedrock/model-provider.js';
import { createDirectOrchestrator } from '../orchestrator/direct.js';
import { createStrandsOrchestrator } from '../strands/orchestrator.js';

// Select the ModelProvider adapter by backend (LLM_BACKEND=anthropic|bedrock).
export function createModelProvider({ env = process.env } = {}) {
  const backend = String(env.LLM_BACKEND || 'anthropic').toLowerCase();
  if (backend === 'anthropic') return createAnthropicModelProvider({ env });
  if (backend === 'bedrock') return createBedrockModelProvider({ env });
  throw new Error(`unknown LLM_BACKEND "${backend}" (use anthropic | bedrock)`);
}

// ORCHESTRATOR=direct (default, zero-dep) | strands (@strands-agents/sdk).
export function createAgentOrchestrator({ env = process.env, modelProvider } = {}) {
  const kind = String(env.ORCHESTRATOR || 'direct').toLowerCase();
  if (kind === 'strands') return createStrandsOrchestrator({ env });
  if (kind === 'direct') return createDirectOrchestrator({ modelProvider: modelProvider || createModelProvider({ env }) });
  throw new Error(`unknown ORCHESTRATOR "${kind}" (use direct | strands)`);
}
