// Application port: a provider-neutral model invoker. Infrastructure adapters
// (Bedrock, and future providers) implement this; use cases depend only on this
// shape and never import an SDK.

export const MODEL_TIERS = ['fast', 'standard', 'critical'];

/**
 * @typedef {Object} ModelInvocation
 * @property {string} prompt
 * @property {'fast'|'standard'|'critical'} [tier]
 * @property {string} [systemPrompt]
 * @property {{maxTokens?: number, temperature?: number}} [options]
 *
 * @typedef {Object} ModelResult
 * @property {string} text
 * @property {object} usage  // aiUsageEvent shape from domain/ai-orchestration/usage.js
 *
 * @typedef {Object} ModelProvider
 * @property {(invocation: ModelInvocation) => Promise<ModelResult>} invoke
 */

export function assertModelProvider(provider) {
  if (!provider || typeof provider.invoke !== 'function') {
    throw new TypeError('ModelProvider must implement async invoke(invocation)');
  }
  return provider;
}
