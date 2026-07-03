// Provider-neutral model configuration.
// The domain/application layers ask for a TIER ('fast' | 'standard' | 'critical').
// This infrastructure helper resolves a tier to a concrete model id from the
// environment — no model ids are hardcoded in the domain (see spec/domain-driven-design.md).

export const TIERS = ['fast', 'standard', 'critical'];

// First-party Anthropic API ids (LLM_BACKEND=anthropic, the default).
const ANTHROPIC_DEFAULTS = {
  fast: 'claude-haiku-4-5',
  standard: 'claude-sonnet-5',
  critical: 'claude-opus-4-8',
};

// AWS Bedrock cross-region inference-profile ids (LLM_BACKEND=bedrock).
// Confirm/pin these with `aws bedrock list-inference-profiles`; override via
// BEDROCK_MODEL_FAST / BEDROCK_MODEL_STANDARD / BEDROCK_MODEL_CRITICAL.
const BEDROCK_DEFAULTS = {
  fast: 'us.anthropic.claude-haiku-4-5-20251001-v1:0',
  standard: 'us.anthropic.claude-sonnet-5',
  critical: 'us.anthropic.claude-opus-4-8',
};

export function resolveModelConfig(env = process.env) {
  const backend = String(env.LLM_BACKEND || 'anthropic').toLowerCase();
  const isBedrock = backend === 'bedrock';
  const defaults = isBedrock ? BEDROCK_DEFAULTS : ANTHROPIC_DEFAULTS;

  const models = {};
  for (const tier of TIERS) {
    const key = tier.toUpperCase();
    const override = isBedrock ? env[`BEDROCK_MODEL_${key}`] : env[`MODEL_${key}`];
    models[tier] = override || defaults[tier];
  }

  return {
    backend,
    region: env.AWS_REGION || null,
    profile: env.AWS_PROFILE || null,
    models, // { fast, standard, critical }
  };
}

// Validate the config shape WITHOUT any network call (safe for CI / no-spend).
export function validateModelConfig(cfg, env = process.env) {
  const errors = [];
  const warnings = [];

  if (cfg.backend !== 'anthropic' && cfg.backend !== 'bedrock') {
    errors.push(`unknown LLM_BACKEND "${cfg.backend}" (use anthropic | bedrock)`);
  }
  for (const tier of TIERS) {
    if (!cfg.models[tier] || !String(cfg.models[tier]).trim()) {
      errors.push(`missing model id for tier "${tier}"`);
    }
  }

  if (cfg.backend === 'bedrock') {
    if (!cfg.region) errors.push('AWS_REGION is required for the bedrock backend');
    if (!cfg.profile && !env.AWS_ACCESS_KEY_ID) {
      warnings.push('no AWS_PROFILE and no AWS_ACCESS_KEY_ID — a live smoke test will fail without credentials');
    }
    // Claude on Bedrock is inference-profile-only (no ON_DEMAND), so ids must be a
    // cross-region profile (us.* / eu.* / apac.* / global.*). Profile ids are not
    // uniformly versioned — us.anthropic.claude-sonnet-5 is canonical while Haiku
    // carries a date suffix — so the region prefix is the reliable signal.
    for (const tier of TIERS) {
      const id = cfg.models[tier];
      if (id && !/^(us|eu|apac|global)\./.test(id)) {
        warnings.push(`bedrock ${tier} id "${id}" is not a cross-region inference profile (us.* / eu.* / apac.* / global.*) — a bare model id may not be invocable`);
      }
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}
