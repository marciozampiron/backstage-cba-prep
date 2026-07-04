// AI Agent Orchestration context — provider-neutral usage record.
// Pure: no SDK, no clock. The shape is the future `AIUsageEvent`; the caller/use
// case stamps `at` so this stays deterministic and testable.

export function aiUsageEvent({ provider, model, tier = null, inputTokens = 0, outputTokens = 0, stopReason = null, at = null } = {}) {
  const input = Number(inputTokens) || 0;
  const output = Number(outputTokens) || 0;
  return {
    provider,
    model,
    tier,
    inputTokens: input,
    outputTokens: output,
    totalTokens: input + output,
    stopReason,
    at,
  };
}
