#!/usr/bin/env node
// Deploy preflight collector (#70 Slice A) — gathers observations, decides nothing.
//
// Every verdict comes from `lib/deploy-preflight.js`, which is pure. This file resolves the
// effective CDK context, runs ONE read-only AWS call, and emits a MANIFEST.
//
// THE MANIFEST IS THE POINT. A preflight that only exits zero proves that SOME configuration was
// valid; it does not bind the deploy to THAT configuration. A later `cdk deploy --all` that omits
// the `-c` values would still satisfy a pass/fail gate. So this command writes a manifest naming the
// release SHA, the environment, and a digest over the exact validated context, and a deploying job
// must re-derive that digest from the context it is about to use and refuse on mismatch.
//
// WHAT IT NEVER DOES. It echoes no supplied value, no AWS stderr, no account id, no ARN and no
// user pool id. Diagnostics are stable codes and field names (see the CODES table). Codex's Slice A
// review reproduced role-ARN and credential-shaped material in this command's output; that is what
// the codes replace.
//
// TRUSTED VS CALLER-SUPPLIED. `--expected-user-pool-id` is deliberately absent. Whoever can name
// "our" pool can redefine which existing domain a deploy is willing to adopt, which turns
// PREFLIGHT-2's redeploy allowance into a bypass. The expected pool is read from the ENVIRONMENT
// (`CBA_EXPECTED_USER_POOL_ID`), which GitHub only issues to an environment-scoped job after that
// Environment's protection rules are satisfied.
//
// EXIT CODES  0 = both conditions pass · 1 = at least one refused · 2 = usage error.
const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { evaluatePreflight, describeFailure, PROBE, PreflightError } = require('../lib/deploy-preflight');
const { VALID_ENVIRONMENTS } = require('../lib/context');

const EXIT = { OK: 0, REFUSED: 1, USAGE: 2 };

/** Hard ceiling on the probe, so one hung socket cannot stall a deploy lane indefinitely. */
const PROBE_TIMEOUT_MS = 30_000;

/** Context keys the manifest covers. A deploy must reproduce this digest from what it will use. */
const BOUND_CONTEXT_KEYS = ['authCallbackUrls', 'authLogoutUrls', 'authDomainPrefix'];

const RELEASE_SHA = /^[0-9a-f]{40}$/;

function parseArgs(argv) {
  const out = { context: {}, json: false, skipProbe: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-c' || a === '--context') {
      const pair = argv[++i];
      if (typeof pair !== 'string' || !pair.includes('=')) throw new PreflightError('-c needs key=value');
      const eq = pair.indexOf('=');
      out.context[pair.slice(0, eq)] = pair.slice(eq + 1);
    } else if (a === '--environment') out.environment = argv[++i];
    else if (a === '--region') out.region = argv[++i];
    else if (a === '--release-sha') out.releaseSha = argv[++i];
    else if (a === '--manifest-out') out.manifestOut = argv[++i];
    else if (a === '--json') out.json = true;
    else if (a === '--skip-probe') out.skipProbe = true;
    else if (a === '--help' || a === '-h') out.help = true;
    // The offending token is not echoed: an operator can mistype a secret into an argv position.
    else throw new PreflightError('unrecognised argument');
  }
  return out;
}

/**
 * Merge committed `cdk.json` context under the `-c` overrides, which is the CDK precedence order.
 *
 * Committed context counts as "explicitly supplied" for PREFLIGHT-2 — a value a human wrote into
 * `cdk.json` and reviewed is as deliberate as one passed on the command line. What the condition
 * refuses is the SILENT in-code fallback, not the location of the decision.
 */
function loadContext(overrides, cdkJsonPath) {
  let committed = {};
  try {
    const parsed = JSON.parse(fs.readFileSync(cdkJsonPath, 'utf8'));
    if (parsed && typeof parsed.context === 'object' && parsed.context !== null) committed = parsed.context;
  } catch {
    // An unreadable cdk.json is not this gate's failure to report — synth refuses it loudly.
  }
  return { ...committed, ...overrides };
}

/**
 * Canonical digest over the validated context.
 *
 * Sorted keys and a fixed separator, so the same configuration always yields the same digest
 * regardless of argument order. Only `BOUND_CONTEXT_KEYS` participate: binding unrelated context
 * would make the digest brittle without making the deploy safer.
 */
function contextDigest({ releaseSha, environment, context }) {
  const bound = {};
  for (const key of [...BOUND_CONTEXT_KEYS].sort()) {
    if (Object.hasOwn(context, key)) bound[key] = context[key];
  }
  const payload = JSON.stringify({ releaseSha, environment, context: bound });
  return createHash('sha256').update(payload).digest('hex');
}

/**
 * Ask Cognito whether the prefix is free in this region. Read-only, injectable, never in tests.
 *
 * `describe-user-pool-domain` answers for an ABSENT domain with an empty `DomainDescription`, not an
 * error — so "no UserPoolId in the response" is the availability signal, and an actual error is
 * ERROR rather than availability. A denied call, an expired credential and a wrong region all
 * produce errors, and none of them means the prefix is free.
 *
 * NOTHING from the AWS response or from stderr reaches the caller. The owning pool id names another
 * tenant's resource; the stderr can carry an account id or an ARN. Both stay here.
 */
function probeDomain({ prefix, region, expectedUserPoolId, run = defaultRun }) {
  if (!region) return { status: PROBE.ERROR, region: null };
  const res = run(
    ['cognito-idp', 'describe-user-pool-domain', '--domain', prefix, '--region', region, '--output', 'json', '--no-cli-pager'],
    { timeoutMs: PROBE_TIMEOUT_MS },
  );
  if (!res || res.status !== 0) return { status: PROBE.ERROR, region };
  let body;
  try {
    body = JSON.parse(res.stdout || '{}');
  } catch {
    return { status: PROBE.ERROR, region };
  }
  const owner = body?.DomainDescription?.UserPoolId;
  if (!owner) return { status: PROBE.AVAILABLE, region };
  if (expectedUserPoolId && owner === expectedUserPoolId) {
    // `ownershipVerified` is the fact the evaluator needs; the id itself is never carried forward.
    return { status: PROBE.TAKEN_BY_EXPECTED_POOL, region, ownershipVerified: true };
  }
  return { status: PROBE.TAKEN_BY_OTHER, region };
}

function defaultRun(args, { timeoutMs } = {}) {
  return spawnSync('aws', [...args, '--cli-connect-timeout', '5', '--cli-read-timeout', '20'], {
    encoding: 'utf8',
    timeout: timeoutMs,
    killSignal: 'SIGKILL',
  });
}

function usage() {
  return [
    'deploy-preflight — #70 PREFLIGHT-1 and PREFLIGHT-2, evaluated before any cdk deploy',
    '',
    `  --environment ${VALID_ENVIRONMENTS.join('|')}   required (internal; never operator-facing)`,
    '  --release-sha <40-hex>           required; the immutable release under deployment',
    '  --region <aws-region>            required unless --skip-probe',
    '  -c key=value                     CDK context override (repeatable)',
    '  --manifest-out <path>            write the binding manifest for the deploy job',
    '  --skip-probe                     offline dry run; PREFLIGHT-2 then FAILS by design',
    '  --json                           machine-readable output',
    '',
    'The expected user pool id is read from CBA_EXPECTED_USER_POOL_ID in the environment,',
    'never from an argument: a caller who can name "our" pool can redefine what a deploy adopts.',
  ].join('\n');
}

/** @returns {{exit:number, output:string, result:object|null, manifest:object|null}} */
function runDeployPreflight(argv, { run = defaultRun, cdkJsonPath = path.join(__dirname, '..', 'cdk.json'), env = process.env, writeFile = fs.writeFileSync } = {}) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    return { exit: EXIT.USAGE, output: `${err.message}\n\n${usage()}`, result: null, manifest: null };
  }
  if (opts.help) return { exit: EXIT.OK, output: usage(), result: null, manifest: null };
  if (!opts.environment) return { exit: EXIT.USAGE, output: `--environment is required\n\n${usage()}`, result: null, manifest: null };
  if (!opts.releaseSha || !RELEASE_SHA.test(opts.releaseSha)) {
    return { exit: EXIT.USAGE, output: `--release-sha must be a full 40-character lowercase SHA\n\n${usage()}`, result: null, manifest: null };
  }

  const context = loadContext(opts.context, cdkJsonPath);
  const prefix = context.authDomainPrefix;
  const expectedUserPoolId = env.CBA_EXPECTED_USER_POOL_ID || '';

  let domainProbe;
  if (opts.skipProbe || typeof prefix !== 'string' || prefix.trim() === '') {
    domainProbe = { status: PROBE.NOT_CHECKED, region: opts.region || null };
  } else {
    domainProbe = probeDomain({ prefix: prefix.trim(), region: opts.region, expectedUserPoolId, run });
  }

  let result;
  try {
    result = evaluatePreflight({ environment: opts.environment, context, domainProbe });
  } catch (err) {
    return { exit: EXIT.USAGE, output: err.message, result: null, manifest: null };
  }

  // The manifest is written ONLY on a pass. A manifest for a refused configuration is a token that
  // should not exist: anything downstream that finds one would be entitled to trust it.
  let manifest = null;
  if (result.ok) {
    manifest = {
      version: 1,
      issue: 70,
      releaseSha: opts.releaseSha,
      environment: opts.environment,
      boundContextKeys: [...BOUND_CONTEXT_KEYS].sort(),
      contextDigest: contextDigest({ releaseSha: opts.releaseSha, environment: opts.environment, context }),
      preflight: { PREFLIGHT_1: 'pass', PREFLIGHT_2: 'pass' },
    };
    if (opts.manifestOut) writeFile(opts.manifestOut, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  }

  if (opts.json) {
    const payload = { ok: result.ok, environment: result.environment, failures: result.failures, manifest };
    return { exit: result.ok ? EXIT.OK : EXIT.REFUSED, output: JSON.stringify(payload, null, 2), result, manifest };
  }

  const lines = [`deploy preflight — environment ${result.environment}, release ${opts.releaseSha.slice(0, 12)}`];
  for (const check of result.checks) {
    lines.push(`  ${check.ok ? 'PASS' : 'FAIL'}  ${check.id}`);
    for (const f of check.failures) lines.push(`          ${describeFailure(f)}`);
  }
  lines.push('');
  lines.push(
    result.ok
      ? `Both conditions pass. Context digest ${manifest.contextDigest.slice(0, 16)}… — a deploy must reproduce it.`
      : 'REFUSED before cdk deploy. Nothing was deployed.',
  );
  return { exit: result.ok ? EXIT.OK : EXIT.REFUSED, output: lines.join('\n'), result, manifest };
}

module.exports = { runDeployPreflight, probeDomain, loadContext, contextDigest, parseArgs, EXIT, PROBE_TIMEOUT_MS, BOUND_CONTEXT_KEYS };

if (require.main === module) {
  const { exit, output } = runDeployPreflight(process.argv.slice(2));
  process.stdout.write(`${output}\n`);
  process.exit(exit);
}
