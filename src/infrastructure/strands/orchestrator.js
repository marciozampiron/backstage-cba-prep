// Infrastructure adapter: implements the AgentOrchestrator port using the Strands
// Agents SDK (@strands-agents/sdk) with a Bedrock model. The SDK is imported
// lazily and the agent factory is injectable, so unit tests stay offline and the
// core CLI never loads Strands unless this orchestrator is actually selected.

import { randomUUID } from 'node:crypto';
import { requireBedrockConfig } from '../bedrock/config.js';
import { toStrandsTools } from './tools.js';
import { aiUsageEvent } from '../../domain/ai-orchestration/usage.js';
import { agentRun } from '../../domain/ai-orchestration/agent-run.js';
import { OrchestratorError, ModelNotConfiguredError } from '../../domain/ai-orchestration/errors.js';

// Builds a real Strands Agent (new Agent({ model: new BedrockModel({...}) })).
// Returns an object with `invoke(prompt) -> AgentResult`.
async function defaultAgentFactory({ region, modelId, maxTokens, temperature, systemPrompt, tools }) {
  let mod;
  try {
    mod = await import('@strands-agents/sdk');
  } catch (err) {
    throw new ModelNotConfiguredError(
      'Strands orchestrator needs @strands-agents/sdk — install it: npm i @strands-agents/sdk',
      { provider: 'strands', cause: err }
    );
  }
  const model = new mod.BedrockModel({ region, modelId, maxTokens, temperature });
  const strandsTools = tools && tools.length ? await toStrandsTools(tools, { strands: mod }) : undefined;
  return new mod.Agent({
    model,
    systemPrompt: systemPrompt || undefined,
    tools: strandsTools,
  });
}

// opts: { env, agentFactory }  — inject `agentFactory` in tests to avoid Strands/AWS.
export function createStrandsOrchestrator(opts = {}) {
  const env = opts.env || process.env;
  const cfg = requireBedrockConfig(env, 'strands');
  const agentFactory = opts.agentFactory || defaultAgentFactory;
  const repository = opts.repository || null;
  const now = opts.now || (() => new Date().toISOString());
  const newId = opts.newId || randomUUID;

  return {
    async run({ prompt, systemPrompt = null, tier = 'standard', tools = null, options = {} } = {}) {
      const modelId = cfg.models[tier] || cfg.models.standard;
      const id = repository ? newId() : null;
      const startedAt = repository ? now() : null;
      const record = async (fields) => {
        if (repository) await repository.save(agentRun({ id, orchestrator: 'strands', prompt, startedAt, finishedAt: now(), ...fields }));
      };

      let agent;
      try {
        agent = await agentFactory({
          region: cfg.region,
          modelId,
          maxTokens: options.maxTokens ?? 1024,
          temperature: options.temperature,
          systemPrompt,
          tools,
        });
      } catch (err) {
        // ModelNotConfiguredError etc. are already domain-safe; otherwise wrap.
        const e = err && err.code ? err : new OrchestratorError(`could not build Strands agent: ${(err && err.message) || err}`, { provider: 'strands', cause: err });
        await record({ status: 'error', error: e.message });
        throw e;
      }

      let result;
      try {
        result = await agent.invoke(prompt);
      } catch (err) {
        const e = new OrchestratorError(`Strands agent run failed: ${(err && err.message) || err}`, { provider: 'strands', cause: err });
        await record({ status: 'error', error: e.message });
        throw e;
      }

      const text = (result?.lastMessage?.content || []).map((b) => b.text || '').join('');
      const u = (result?.metrics && (result.metrics.accumulatedUsage || result.metrics.usage)) || {};
      const usage = aiUsageEvent({
        provider: 'strands+bedrock',
        model: modelId,
        tier,
        inputTokens: u.inputTokens || 0,
        outputTokens: u.outputTokens || 0,
        stopReason: result?.stopReason || null,
      });
      await record({ status: 'ok', backend: 'strands+bedrock', usage });
      return { text, usage, stopReason: result?.stopReason || null };
    },
  };
}
