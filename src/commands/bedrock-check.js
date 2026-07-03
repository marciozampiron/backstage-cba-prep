import { spawnSync } from 'node:child_process';
import { resolveModelConfig, validateModelConfig, TIERS } from '../lib/model-config.js';
import { c, hr, ask, closeInput } from '../lib/ui.js';

// Real Bedrock invocation via the AWS CLI (kept out of the default path so the
// zero-dependency project never needs the AWS SDK). Injectable for offline tests.
function defaultInvoke({ region, profile, modelId }) {
  const args = [
    'bedrock-runtime', 'converse',
    '--region', region,
    '--model-id', modelId,
    '--messages', JSON.stringify([{ role: 'user', content: [{ text: 'ping' }] }]),
    '--inference-config', JSON.stringify({ maxTokens: 8 }),
  ];
  if (profile) args.push('--profile', profile);
  const res = spawnSync('aws', args, { encoding: 'utf8' });
  return { code: res.status == null ? 1 : res.status, stdout: res.stdout || '', stderr: res.stderr || '', error: res.error ? res.error.message : '' };
}

function printConfig(cfg, check, log) {
  log(`\n  ${c.bold('Model config')} ${c.gray(`(backend: ${cfg.backend})`)}`);
  log(hr());
  if (cfg.backend === 'bedrock') {
    log(`  region:  ${cfg.region ? c.cyan(cfg.region) : c.red('unset')}`);
    log(`  profile: ${cfg.profile ? c.cyan(cfg.profile) : c.gray('(env credentials)')}`);
    log('');
  }
  for (const tier of TIERS) log(`    ${c.bold(tier.padEnd(9))} ${c.cyan(cfg.models[tier])}`);
  log('');
  for (const w of check.warnings) log(`  ${c.yellow('⚠')}  ${c.gray(w)}`);
  for (const e of check.errors) log(`  ${c.red('✗')}  ${e}`);
  log(hr());
}

export async function runBedrockCheck(opts = {}) {
  const env = opts.env || process.env;
  const log = opts.log || console.log;
  const cfg = resolveModelConfig(env);
  const check = validateModelConfig(cfg, env);

  // JSON mode is inspection-only and never triggers a paid call — safe for CI.
  if (opts.json) {
    log(JSON.stringify({ config: cfg, check }, null, 2));
    return check.ok ? 0 : 1;
  }

  printConfig(cfg, check, log);

  if (!check.ok) {
    log(c.red('\n  Config invalid — fix the errors above.\n'));
    return 1;
  }

  if (!opts.smoke) {
    log(c.green('  ✓ Config valid') + c.gray('  (dry-run — no model was invoked, no tokens spent).'));
    log(c.gray('  Live smoke test (COSTS TOKENS): node bin/cli.js bedrock-check --smoke\n'));
    return 0;
  }

  // --- Live smoke test (paid) ---
  if (cfg.backend !== 'bedrock') {
    log(c.red('\n  --smoke supports the bedrock backend only (set LLM_BACKEND=bedrock).\n'));
    return 1;
  }
  const tier = opts.tier && TIERS.includes(opts.tier) ? opts.tier : 'fast';
  const modelId = cfg.models[tier];

  log(c.yellow(`\n  ⚠  LIVE smoke test — this INVOKES a model and MAY INCUR TOKEN COST.`));
  log(`     tier ${c.bold(tier)} → ${c.cyan(modelId)} in ${c.cyan(cfg.region)}\n`);
  if (!opts.yes) {
    const answer = (await ask('  Type "yes" to proceed (anything else aborts): ')).trim().toLowerCase();
    closeInput();
    if (answer !== 'yes') {
      log(c.gray('  Aborted — no call made.\n'));
      return 0;
    }
  }

  const invoke = opts.invokeImpl || defaultInvoke;
  const r = invoke({ region: cfg.region, profile: cfg.profile, modelId });

  if (r.code === 0) {
    log(c.green(`\n  ✓ ${tier} model responded — ${modelId} is invocable in ${cfg.region}.\n`));
    return 0;
  }

  log(c.red(`\n  ✗ invoke failed (exit ${r.code}).`));
  const msg = String(r.stderr || r.error || '');
  if (/AccessDenied/i.test(msg)) {
    log(c.gray('    → request access: Bedrock console → Model access → enable Anthropic models.'));
  } else if (/on-demand|inference profile|ValidationException/i.test(msg)) {
    log(c.gray('    → use the us.* inference-profile id (aws bedrock list-inference-profiles), not the bare model id.'));
  } else if (/could not|not found|ENOENT|command not found/i.test(msg)) {
    log(c.gray('    → is the AWS CLI installed and on PATH?'));
  }
  if (msg) log(c.gray('    ' + msg.split('\n')[0].slice(0, 200)));
  log('');
  return 2;
}
