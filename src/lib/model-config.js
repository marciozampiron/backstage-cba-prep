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
// The #117 target, decided by Zamp (2026-08-15): the FAST tier deliberately does NOT name the
// lowest-cost/latency model — the tier NAME stays a functional category, and Zamp chose
// Opus 4.8 for it; that tradeoff is on the record here and in issue #117. Models are NEVER
// selected automatically by price, availability or error, and there is NO silent fallback
// between tiers, models or generations (modelForTier below fails closed by name).
// Validation status: Bedrock Playground succeeded for all three under Zamp's HUMAN console
// identity; the agreement-availability API diverges (NOT_AVAILABLE for the Opus pair) — the
// divergence is recorded, and neither signal is definitive. Application-path validation is
// claimed ONLY after the programmatic smokes (paid, under Zamp's own spend authorization).
// Override via BEDROCK_MODEL_FAST / BEDROCK_MODEL_STANDARD / BEDROCK_MODEL_CRITICAL.
const BEDROCK_DEFAULTS = {
  fast: 'us.anthropic.claude-opus-4-8',
  standard: 'us.anthropic.claude-sonnet-5',
  critical: 'us.anthropic.claude-opus-5',
};

// Fail-closed tier resolution (#117): an unknown tier or a missing id REFUSES BY NAME — it
// never quietly borrows another tier's model. Every adapter must resolve through this.
export function modelForTier(cfg, tier) {
  if (!TIERS.includes(tier)) {
    throw new Error(`unknown model tier "${tier}" — tiers are ${TIERS.join(' | ')}; no fallback is performed`);
  }
  const id = cfg?.models?.[tier];
  if (!id || !String(id).trim()) {
    throw new Error(`missing model id for tier "${tier}" — configuration is incomplete; no fallback is performed`);
  }
  return id;
}

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
