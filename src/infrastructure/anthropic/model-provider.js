// Infrastructure adapter: implements the ModelProvider port using the first-party
// Anthropic Messages API over HTTP. `fetchImpl` is injectable so unit tests stay
// offline; no SDK is required (matches the project's existing zero-dep HTTP path).

import { resolveModelConfig } from '../../lib/model-config.js';
import { aiUsageEvent } from '../../domain/ai-orchestration/usage.js';
import { ModelAccessError, ModelInvocationError, ModelNotConfiguredError } from '../../domain/ai-orchestration/errors.js';

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';

// opts: { env, apiKey, fetchImpl }
export function createAnthropicModelProvider(opts = {}) {
  const env = opts.env || process.env;
  const cfg = resolveModelConfig(env);
  if (cfg.backend !== 'anthropic') {
    throw new ModelNotConfiguredError(`the anthropic adapter requires LLM_BACKEND=anthropic (current backend: ${cfg.backend})`, { provider: 'anthropic' });
  }
  const fetchImpl = opts.fetchImpl || fetch;

  return {
    async invoke({ prompt, tier = 'standard', systemPrompt = null, options = {} } = {}) {
      if (!prompt || typeof prompt !== 'string') {
        throw new ModelInvocationError('invoke() requires a non-empty prompt string', { provider: 'anthropic' });
      }
      const apiKey = opts.apiKey || env.ANTHROPIC_API_KEY;
      if (!apiKey) {
        throw new ModelNotConfiguredError('the anthropic adapter requires ANTHROPIC_API_KEY', { provider: 'anthropic' });
      }
      const model = cfg.models[tier] || cfg.models.standard;

      const body = {
        model,
        max_tokens: options.maxTokens ?? 1024,
        messages: [{ role: 'user', content: prompt }],
      };
      if (systemPrompt) body.system = systemPrompt;
      if (options.temperature != null) body.temperature = options.temperature;

      let res;
      try {
        res = await fetchImpl(ANTHROPIC_URL, {
          method: 'POST',
          headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
      } catch (err) {
        throw new ModelInvocationError(`Anthropic request failed: ${(err && err.message) || err}`, { provider: 'anthropic', cause: err });
      }

      if (!res.ok) {
        const detail = await safeText(res);
        if (res.status === 401 || res.status === 403) {
          throw new ModelAccessError(`Anthropic auth failed (${res.status}) — check ANTHROPIC_API_KEY.`, { provider: 'anthropic' });
        }
        throw new ModelInvocationError(`Anthropic ${res.status}: ${detail}`, { provider: 'anthropic' });
      }

      const data = await res.json();
      const text = (data.content || []).map((b) => b.text || '').join('');
      const usage = aiUsageEvent({
        provider: 'anthropic',
        model,
        tier,
        inputTokens: (data.usage && data.usage.input_tokens) || 0,
        outputTokens: (data.usage && data.usage.output_tokens) || 0,
        stopReason: data.stop_reason || null,
      });
      return { text, usage };
    },
  };
}

async function safeText(res) {
  try {
    return (await res.text()).slice(0, 200);
  } catch {
    return '';
  }
}
