// Application port: runs an agent (a model plus optional tools and loop) and
// returns a provider-neutral result. Bedrock/Strands live behind this port in
// the infrastructure layer — never in the domain.

/**
 * @typedef {Object} AgentRequest
 * @property {string} prompt
 * @property {string} [systemPrompt]
 * @property {'fast'|'standard'|'critical'} [tier]
 * @property {Array<object>} [tools]
 * @property {{maxTokens?: number, temperature?: number}} [options]
 *
 * @typedef {Object} AgentRunResult
 * @property {string} text
 * @property {object} usage        // aiUsageEvent shape
 * @property {string|null} [stopReason]
 *
 * @typedef {Object} AgentOrchestrator
 * @property {(request: AgentRequest) => Promise<AgentRunResult>} run
 */

export function assertAgentOrchestrator(orchestrator) {
  if (!orchestrator || typeof orchestrator.run !== 'function') {
    throw new TypeError('AgentOrchestrator must implement async run(request)');
  }
  return orchestrator;
}
