#!/usr/bin/env node
// Deploy preflight collector (#70 Slice A) — gathers observations, decides nothing.
//
// Every verdict comes from `lib/deploy-preflight.js`, which is pure. This file resolves the
// effective CDK context the way the CDK CLI does, runs ONE read-only AWS call, and prints.
//
// USAGE
//   node bin/deploy-preflight.js --environment pilot --region us-east-1 \
//     -c 'authCallbackUrls=["https://app.example.com/auth/callback"]' \
//     -c 'authLogoutUrls=["https://app.example.com/"]' \
//     -c authDomainPrefix=cba-study-coach-pilot-abc123 \
//     [--expected-user-pool-id us-east-1_XXXX] [--json] [--skip-probe]
//
// THE ONE AWS CALL is `cognito-idp describe-user-pool-domain`, which is read-only and free. It
// creates nothing, mutates nothing and reads no secret. `--skip-probe` exists for offline dry runs
// and DELIBERATELY fails PREFLIGHT-2: skipping the question is not answering it.
//
// EXIT CODES  0 = both conditions pass · 1 = at least one refused · 2 = usage error.
// A non-zero exit is what stops the workflow before `cdk deploy`.
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { evaluatePreflight, PROBE, PreflightError } = require('../lib/deploy-preflight');
const { VALID_ENVIRONMENTS } = require('../lib/context');

const EXIT = { OK: 0, REFUSED: 1, USAGE: 2 };

/** Hard ceiling on the probe, so one hung socket cannot stall a deploy lane indefinitely. */
const PROBE_TIMEOUT_MS = 30_000;

function parseArgs(argv) {
  const out = { context: {}, json: false, skipProbe: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-c' || a === '--context') {
      const pair = argv[++i];
      if (typeof pair !== 'string' || !pair.includes('=')) throw new PreflightError(`-c needs key=value (got ${pair})`);
      const eq = pair.indexOf('=');
      const key = pair.slice(0, eq);
      const raw = pair.slice(eq + 1);
      // The CDK CLI hands `-c key=value` to the app as a STRING; JSON-shaped values are parsed by
      // the same helpers the stack uses, so this collector stores the raw string and lets
      // `parseExactUrlList` do the work. Mirroring the CLI matters more than convenience here.
      out.context[key] = raw;
    } else if (a === '--environment') out.environment = argv[++i];
    else if (a === '--region') out.region = argv[++i];
    else if (a === '--expected-user-pool-id') out.expectedUserPoolId = argv[++i];
    else if (a === '--json') out.json = true;
    else if (a === '--skip-probe') out.skipProbe = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else throw new PreflightError(`unknown argument: ${a}`);
  }
  return out;
}

/**
 * Merge committed `cdk.json` context under the `-c` overrides, which is the CDK precedence order.
 *
 * Committed context counts as "explicitly supplied" for PREFLIGHT-2 — a value a human wrote into
 * `cdk.json` and reviewed is exactly as deliberate as one passed on the command line. What the
 * condition refuses is the SILENT in-code fallback, not the location of the decision.
 */
function loadContext(overrides, cdkJsonPath) {
  let committed = {};
  try {
    const parsed = JSON.parse(fs.readFileSync(cdkJsonPath, 'utf8'));
    if (parsed && typeof parsed.context === 'object' && parsed.context !== null) committed = parsed.context;
  } catch {
    // An unreadable cdk.json is not this gate's failure to report — synth will refuse it loudly.
  }
  return { ...committed, ...overrides };
}

/**
 * Ask Cognito whether the prefix is free in this region. Read-only, injectable, never in tests.
 *
 * `describe-user-pool-domain` answers for an ABSENT domain with an empty `DomainDescription`, not an
 * error — so "no UserPoolId in the response" is the availability signal, and an actual error is
 * reported as ERROR rather than being read as availability. That distinction is the whole check: a
 * denied call, an expired credential or a wrong region all produce errors, and none of them means
 * the prefix is free.
 */
function probeDomain({ prefix, region, expectedUserPoolId, run = defaultRun }) {
  if (!region) return { status: PROBE.ERROR, prefix, region: null, detail: 'no region was supplied' };
  const res = run(
    ['cognito-idp', 'describe-user-pool-domain', '--domain', prefix, '--region', region, '--output', 'json', '--no-cli-pager'],
    { timeoutMs: PROBE_TIMEOUT_MS },
  );
  if (res.status !== 0) {
    return { status: PROBE.ERROR, prefix, region, detail: (res.stderr || '').trim().split('\n').pop() || `exit ${res.status}` };
  }
  let body;
  try {
    body = JSON.parse(res.stdout || '{}');
  } catch {
    return { status: PROBE.ERROR, prefix, region, detail: 'the probe response was not valid JSON' };
  }
  const owner = body?.DomainDescription?.UserPoolId;
  if (!owner) return { status: PROBE.AVAILABLE, prefix, region };
  if (expectedUserPoolId && owner === expectedUserPoolId) {
    return { status: PROBE.TAKEN_BY_EXPECTED_POOL, prefix, region, expectedUserPoolId };
  }
  // The owning pool id is NOT echoed: it names another tenant's resource when the domain is not ours.
  return { status: PROBE.TAKEN_BY_OTHER, prefix, region, detail: 'the prefix is registered to a different user pool' };
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
    `  --environment ${VALID_ENVIRONMENTS.join('|')}   required`,
    '  --region <aws-region>            required unless --skip-probe',
    '  -c key=value                     CDK context override (repeatable)',
    '  --expected-user-pool-id <id>     treat an existing domain owned by this pool as ours',
    '  --skip-probe                     offline dry run; PREFLIGHT-2 then FAILS by design',
    '  --json                           machine-readable output',
  ].join('\n');
}

/** @returns {{exit:number, output:string, result:object|null}} */
function runDeployPreflight(argv, { run = defaultRun, cdkJsonPath = path.join(__dirname, '..', 'cdk.json') } = {}) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    return { exit: EXIT.USAGE, output: `${err.message}\n\n${usage()}`, result: null };
  }
  if (opts.help) return { exit: EXIT.OK, output: usage(), result: null };
  if (!opts.environment) return { exit: EXIT.USAGE, output: `--environment is required\n\n${usage()}`, result: null };

  const context = loadContext(opts.context, cdkJsonPath);
  const prefix = context.authDomainPrefix;

  let domainProbe = null;
  if (opts.skipProbe) {
    domainProbe = { status: PROBE.NOT_CHECKED, region: opts.region || null };
  } else if (typeof prefix === 'string' && prefix.trim() !== '') {
    domainProbe = probeDomain({ prefix: prefix.trim(), region: opts.region, expectedUserPoolId: opts.expectedUserPoolId, run });
  } else {
    // No prefix to probe. PREFLIGHT-2 already refuses for the missing key; saying so is clearer
    // than reporting a probe that was never meaningful.
    domainProbe = { status: PROBE.NOT_CHECKED, region: opts.region || null };
  }

  let result;
  try {
    result = evaluatePreflight({ environment: opts.environment, context, domainProbe });
  } catch (err) {
    return { exit: EXIT.USAGE, output: err.message, result: null };
  }

  if (opts.json) return { exit: result.ok ? EXIT.OK : EXIT.REFUSED, output: JSON.stringify(result, null, 2), result };

  const lines = [`deploy preflight — environment ${result.environment}`];
  for (const check of result.checks) {
    lines.push(`  ${check.ok ? 'PASS' : 'FAIL'}  ${check.id}`);
    for (const f of check.failures) lines.push(`          ${f}`);
  }
  lines.push('');
  lines.push(result.ok ? 'Both conditions pass. Deploy may proceed.' : 'REFUSED before cdk deploy. Nothing was deployed.');
  return { exit: result.ok ? EXIT.OK : EXIT.REFUSED, output: lines.join('\n'), result };
}

module.exports = { runDeployPreflight, probeDomain, loadContext, parseArgs, EXIT, PROBE_TIMEOUT_MS };

if (require.main === module) {
  const { exit, output } = runDeployPreflight(process.argv.slice(2));
  process.stdout.write(`${output}\n`);
  process.exit(exit);
}
