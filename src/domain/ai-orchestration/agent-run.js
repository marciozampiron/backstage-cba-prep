// AI Agent Orchestration context — neutral records for an agent run and its tool
// calls. Pure: no SDK, no clock, no id generation. The infrastructure caller
// stamps ids/timestamps and persists via the AgentRunRepository port. `usage`
// carries the aiUsageEvent shape from usage.js.

export const AGENT_RUN_STATUSES = ['running', 'ok', 'error'];

export function toolCall({ name, input = null, output = null, error = null } = {}) {
  return { name, input, output, error: error ? String(error) : null };
}

export function agentRun({
  id,
  orchestrator,
  backend = null,
  prompt,
  status = 'running',
  usage = null,
  toolCalls = [],
  error = null,
  startedAt = null,
  finishedAt = null,
} = {}) {
  return {
    id,
    orchestrator,
    backend,
    prompt,
    status,
    usage,
    toolCalls: Array.isArray(toolCalls) ? toolCalls.map((t) => toolCall(t)) : [],
    error: error ? String(error) : null,
    startedAt,
    finishedAt,
  };
}
