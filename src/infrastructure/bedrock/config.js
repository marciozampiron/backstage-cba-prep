// Bedrock-backed adapters (the Bedrock ModelProvider and the Strands
// orchestrator, which drives a BedrockModel) require the bedrock backend and a
// region — inference profiles are regional. Fail early with a domain-safe error
// so a default (anthropic) environment never silently invokes Bedrock with a
// first-party model id and no region.

import { resolveModelConfig } from '../../lib/model-config.js';
import { ModelNotConfiguredError } from '../../domain/ai-orchestration/errors.js';

export function requireBedrockConfig(env = process.env, provider = 'bedrock') {
  const cfg = resolveModelConfig(env);
  if (cfg.backend !== 'bedrock') {
    throw new ModelNotConfiguredError(
      `the ${provider} adapter requires LLM_BACKEND=bedrock (current backend: ${cfg.backend})`,
      { provider }
    );
  }
  if (!cfg.region) {
    throw new ModelNotConfiguredError(`the ${provider} adapter requires AWS_REGION`, { provider });
  }
  return cfg;
}
