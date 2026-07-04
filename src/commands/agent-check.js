import { resolveModelConfig, validateModelConfig, TIERS } from '../lib/model-config.js';
import { createModelProvider, createAgentOrchestrator } from '../infrastructure/ai/index.js';
import { c, hr, ask, closeInput } from '../lib/ui.js';

const ORCHESTRATORS = ['direct', 'strands'];

// No-spend readiness check for the AI orchestration layer: resolves config,
// constructs the ModelProvider + AgentOrchestrator from env, and reports — without
// invoking any model. `--smoke` (opt-in, paid) runs one tiny orchestrator turn.
export async function runAgentCheck(opts = {}) {
  const env = opts.env || process.env;
  const log = opts.log || console.log;
  const makeProvider = opts.createModelProvider || createModelProvider;
  const makeOrchestrator = opts.createAgentOrchestrator || createAgentOrchestrator;

  const cfg = resolveModelConfig(env);
  const check = validateModelConfig(cfg, env);
  const orchestrator = String(env.ORCHESTRATOR || 'direct').toLowerCase();

  const errors = [...check.errors];
  const warnings = [...check.warnings];
  if (!ORCHESTRATORS.includes(orchestrator)) errors.push(`unknown ORCHESTRATOR "${orchestrator}" (use direct | strands)`);
  if (cfg.backend === 'anthropic' && !env.ANTHROPIC_API_KEY) warnings.push('no ANTHROPIC_API_KEY — a live run will fail without it');

  // Construct the adapters (config errors surface here); no model is invoked.
  let modelProvider = null;
  let providerOk = false;
  let orchestratorOk = false;
  try {
    modelProvider = makeProvider({ env });
    providerOk = true;
  } catch (err) {
    errors.push(`model provider: ${err.message}`);
  }
  try {
    makeOrchestrator({ env, modelProvider });
    orchestratorOk = true;
  } catch (err) {
    errors.push(`orchestrator: ${err.message}`);
  }

  const uniqueErrors = [...new Set(errors)];
  const ok = uniqueErrors.length === 0;

  if (opts.json) {
    log(JSON.stringify({ backend: cfg.backend, orchestrator, region: cfg.region, models: cfg.models, providerOk, orchestratorOk, ok, errors: uniqueErrors, warnings }, null, 2));
    return ok ? 0 : 1;
  }

  log(`\n  ${c.bold('Agent readiness')} ${c.gray(`(backend: ${cfg.backend} · orchestrator: ${orchestrator})`)}`);
  log(hr());
  if (cfg.backend === 'bedrock') {
    log(`  region:  ${cfg.region ? c.cyan(cfg.region) : c.red('unset')}`);
    log(`  profile: ${cfg.profile ? c.cyan(cfg.profile) : c.gray('(env credentials)')}`);
    log('');
  }
  for (const tier of TIERS) log(`    ${c.bold(tier.padEnd(9))} ${c.cyan(cfg.models[tier])}`);
  log('');
  log(`  model provider: ${providerOk ? c.green('✓ constructs') : c.red('✗ failed')}    orchestrator: ${orchestratorOk ? c.green('✓ constructs') : c.red('✗ failed')}`);
  for (const w of warnings) log(`  ${c.yellow('⚠')}  ${c.gray(w)}`);
  for (const e of uniqueErrors) log(`  ${c.red('✗')}  ${e}`);
  log(hr());

  if (!ok) {
    log(c.red('\n  Not ready — fix the errors above.\n'));
    return 1;
  }
  if (!opts.smoke) {
    log(c.green('  ✓ Ready') + c.gray('  (dry-run — nothing invoked, no tokens spent).'));
    log(c.gray('  Live smoke (COSTS TOKENS): node bin/cli.js agent-check --smoke\n'));
    return 0;
  }

  // --- Live smoke (paid): one tiny orchestrator run ---
  log(c.yellow(`\n  ⚠  LIVE smoke — runs the ${orchestrator} orchestrator and MAY INCUR TOKEN COST.\n`));
  if (!opts.yes) {
    const answer = (await ask('  Type "yes" to proceed (anything else aborts): ')).trim().toLowerCase();
    closeInput();
    if (answer !== 'yes') {
      log(c.gray('  Aborted — nothing run.\n'));
      return 0;
    }
  }
  try {
    const out = await makeOrchestrator({ env }).run({ prompt: 'ping', options: { maxTokens: 8 } });
    const u = out && out.usage;
    log(c.green(`\n  ✓ ${orchestrator} responded${u ? ` — ${u.inputTokens} in / ${u.outputTokens} out (${u.provider})` : ''}.\n`));
    return 0;
  } catch (err) {
    log(c.red(`\n  ✗ run failed: ${err.message}\n`));
    return 2;
  }
}
