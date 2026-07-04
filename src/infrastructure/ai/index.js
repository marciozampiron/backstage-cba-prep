// Composition root for AI orchestration infrastructure. The application/domain
// layers depend on the ModelProvider / AgentOrchestrator ports; this wires the
// concrete adapter selected by config (env), with no code edit needed to switch.

import { createBedrockModelProvider } from '../bedrock/model-provider.js';
import { createDirectOrchestrator } from '../orchestrator/direct.js';
import { createStrandsOrchestrator } from '../strands/orchestrator.js';

// Only Bedrock today; this is the provider-neutral seam for future providers.
export function createModelProvider({ env = process.env } = {}) {
  return createBedrockModelProvider({ env });
}

// ORCHESTRATOR=direct (default, zero-dep) | strands (@strands-agents/sdk).
export function createAgentOrchestrator({ env = process.env, modelProvider } = {}) {
  const kind = String(env.ORCHESTRATOR || 'direct').toLowerCase();
  if (kind === 'strands') return createStrandsOrchestrator({ env });
  if (kind === 'direct') return createDirectOrchestrator({ modelProvider: modelProvider || createModelProvider({ env }) });
  throw new Error(`unknown ORCHESTRATOR "${kind}" (use direct | strands)`);
}
