// Infrastructure adapter: implements the ModelProvider port using AWS Bedrock
// (Converse API via @aws-sdk/client-bedrock-runtime). The SDK is imported lazily
// and the client is injectable, so unit tests stay offline and the core CLI
// never loads the AWS SDK unless the Bedrock path is actually used.

import { requireBedrockConfig } from './config.js';
import { aiUsageEvent } from '../../domain/ai-orchestration/usage.js';
import { ModelAccessError, ModelInvocationError, ModelNotConfiguredError } from '../../domain/ai-orchestration/errors.js';

async function defaultClientFactory({ region }) {
  let mod;
  try {
    mod = await import('@aws-sdk/client-bedrock-runtime');
  } catch (err) {
    throw new ModelNotConfiguredError(
      'Bedrock backend needs @aws-sdk/client-bedrock-runtime — install it: npm i @aws-sdk/client-bedrock-runtime',
      { provider: 'bedrock', cause: err }
    );
  }
  return { client: new mod.BedrockRuntimeClient({ region }), ConverseCommand: mod.ConverseCommand };
}

// opts: { env, client, ConverseCommand, clientFactory }
// Inject `client` + `ConverseCommand` in tests to avoid any real SDK/network.
export function createBedrockModelProvider(opts = {}) {
  const env = opts.env || process.env;
  const cfg = requireBedrockConfig(env, 'bedrock');

  return {
    async invoke({ prompt, tier = 'standard', systemPrompt = null, options = {} } = {}) {
      if (!prompt || typeof prompt !== 'string') {
        throw new ModelInvocationError('invoke() requires a non-empty prompt string', { provider: 'bedrock' });
      }
      const modelId = cfg.models[tier] || cfg.models.standard;

      let client = opts.client;
      let ConverseCommand = opts.ConverseCommand;
      if (!client || !ConverseCommand) {
        const built = await (opts.clientFactory || defaultClientFactory)({ region: cfg.region });
        client = client || built.client;
        ConverseCommand = ConverseCommand || built.ConverseCommand;
      }

      const input = {
        modelId,
        messages: [{ role: 'user', content: [{ text: prompt }] }],
        inferenceConfig: {
          maxTokens: options.maxTokens ?? 1024,
          ...(options.temperature != null ? { temperature: options.temperature } : {}),
        },
      };
      if (systemPrompt) input.system = [{ text: systemPrompt }];

      let res;
      try {
        res = await client.send(new ConverseCommand(input));
      } catch (err) {
        throw mapBedrockError(err, modelId);
      }

      const text = (res?.output?.message?.content || []).map((b) => b.text || '').join('');
      const usage = aiUsageEvent({
        provider: 'bedrock',
        model: modelId,
        tier,
        inputTokens: res?.usage?.inputTokens || 0,
        outputTokens: res?.usage?.outputTokens || 0,
        stopReason: res?.stopReason || null,
      });
      return { text, usage };
    },
  };
}

// Map raw AWS SDK exceptions into domain-safe errors (see ai-orchestration/errors.js).
export function mapBedrockError(err, modelId) {
  const name = (err && err.name) || '';
  const msg = (err && err.message) || String(err);
  if (/AccessDenied/i.test(name) || /AccessDenied|not authorized|enable model access/i.test(msg)) {
    return new ModelAccessError(`Bedrock access denied for ${modelId} — enable model access / check IAM.`, { provider: 'bedrock', cause: err });
  }
  if (/ValidationException/i.test(name) && /inference profile|on-demand/i.test(msg)) {
    return new ModelInvocationError(`Bedrock rejected "${modelId}" — use a us.* inference-profile id.`, { provider: 'bedrock', cause: err });
  }
  if (/ResourceNotFound/i.test(name)) {
    return new ModelInvocationError(`Bedrock model not found: ${modelId}.`, { provider: 'bedrock', cause: err });
  }
  if (/Throttling|TooManyRequests/i.test(name)) {
    return new ModelInvocationError('Bedrock throttled the request — retry with backoff.', { provider: 'bedrock', cause: err });
  }
  return new ModelInvocationError(`Bedrock invocation failed: ${msg}`, { provider: 'bedrock', cause: err });
}
