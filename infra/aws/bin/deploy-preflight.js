#!/usr/bin/env node
// Deploy preflight collector (#70 Slice A) — gathers observations, decides nothing.
//
// Every verdict comes from `lib/deploy-preflight.js`, which is pure. This file resolves the
// effective CDK context, makes two read-only AWS calls, and emits a MANIFEST.
//
// THE MANIFEST IS THE POINT. A preflight that only exits zero proves that SOME configuration was
// valid; it does not bind a deploy to THAT configuration. The manifest's digest covers the release
// OID, the environment, the REGION, the TARGET ACCOUNT and every bound context value — us-east-1
// and us-west-2 must never share a digest, because Cognito-domain uniqueness and deploy targets are
// regional, and two accounts must never share one either. The `verify-manifest` subcommand is the
// purpose-built check the stages run; with `--recompute` it re-resolves the account, re-reads the
// effective context and recompares the digest, which is what a deploying job must do immediately
// before its deploy command.
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
// EXIT CODES  0 = pass · 1 = at least one refusal · 2 = usage error.
const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { evaluatePreflight, describeFailure, PROBE, PreflightError } = require('../lib/deploy-preflight');
const { VALID_ENVIRONMENTS } = require('../lib/context');

const EXIT = { OK: 0, REFUSED: 1, USAGE: 2 };

/** Hard ceiling on any single AWS call, so one hung socket cannot stall a deploy lane. */
const PROBE_TIMEOUT_MS = 30_000;

/** Context keys the manifest covers. A deploy must reproduce this digest from what it will use. */
const BOUND_CONTEXT_KEYS = ['authCallbackUrls', 'authLogoutUrls', 'authDomainPrefix'];

const RELEASE_SHA = /^[0-9a-f]{40}$/;
const MANIFEST_VERSION = 2;

/**
 * Canonical digest over everything a deploy must not silently change.
 *
 * Sorted keys and a fixed payload shape, so the same inputs always yield the same digest regardless
 * of argument order. Region and account identity are IN the digest and never in clear text anywhere
 * else: the manifest travels through job outputs and logs, and the account id must not.
 */
function contextDigest({ releaseSha, environment, region, accountId, context }) {
  const bound = {};
  for (const key of [...BOUND_CONTEXT_KEYS].sort()) {
    if (Object.hasOwn(context, key)) bound[key] = context[key];
  }
  const payload = JSON.stringify({ releaseSha, environment, region, accountId, context: bound });
  return createHash('sha256').update(payload).digest('hex');
}

function defaultRun(args, { timeoutMs } = {}) {
  return spawnSync('aws', [...args, '--cli-connect-timeout', '5', '--cli-read-timeout', '20'], {
    encoding: 'utf8',
    timeout: timeoutMs,
    killSignal: 'SIGKILL',
  });
}

/**
 * Who are we deployed as? Read-only; `sts:GetCallerIdentity` is not permission-gated, so this
 * widens no role. A failed or malformed answer is null, and null is a REFUSAL downstream — an
 * unbound account is exactly the drift the digest exists to catch.
 */
function resolveAccountId(run) {
  const res = run(['sts', 'get-caller-identity', '--output', 'json', '--no-cli-pager'], { timeoutMs: PROBE_TIMEOUT_MS });
  if (!res || res.status !== 0) return null;
  try {
    const body = JSON.parse(res.stdout || '{}');
    return typeof body.Account === 'string' && /^[0-9]{12}$/.test(body.Account) ? body.Account : null;
  } catch {
    return null;
  }
}

/**
 * Ask Cognito whether the prefix is free in this region. Read-only, injectable, never in tests.
 *
 * `describe-user-pool-domain` answers for an ABSENT domain with an empty `DomainDescription`, not an
 * error — so "no UserPoolId in the response" is the availability signal, and an actual error is
 * ERROR rather than availability. A denied call, an expired credential and a wrong region all
 * produce errors, and none of them means the prefix is free.
 *
 * NOTHING from the AWS response or from stderr leaves this function. The owning pool id names
 * another tenant's resource; the stderr can carry an account id or an ARN. Both stay here.
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

function parseContextPair(out, pair) {
  if (typeof pair !== 'string' || !pair.includes('=')) throw new PreflightError('-c needs key=value');
  const eq = pair.indexOf('=');
  out.context[pair.slice(0, eq)] = pair.slice(eq + 1);
}

function parseArgs(argv) {
  const out = { context: {}, json: false, skipProbe: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-c' || a === '--context') parseContextPair(out, argv[++i]);
    else if (a === '--environment') out.environment = argv[++i];
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

function usage() {
  return [
    'deploy-preflight — #70 PREFLIGHT-1 and PREFLIGHT-2, evaluated before any cdk deploy',
    '',
    `  --environment ${VALID_ENVIRONMENTS.join('|')}   required (internal; never operator-facing)`,
    '  --release-sha <40-hex>           required; the immutable release OID under deployment',
    '  --region <aws-region>            required unless --skip-probe',
    '  -c key=value                     CDK context override (repeatable)',
    '  --manifest-out <path>            write the binding manifest for the stage/deploy jobs',
    '  --skip-probe                     offline dry run; PREFLIGHT-2 and the binding then FAIL by design',
    '  --json                           machine-readable output',
    '',
    'deploy-preflight verify-manifest — the purpose-built binding check',
    '',
    '  --manifest <path>                required; the manifest the preflight emitted',
    '  --environment <env>              required; must equal the manifest',
    '  --release-sha <40-hex>           required; must equal the manifest',
    '  --expect-digest <64-hex>         must equal the manifest digest',
    '  --recompute --region <r> -c ...  re-resolve the account and recompare from effective values;',
    '                                   a deploying job runs this immediately before its deploy',
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

  // --skip-probe means OFFLINE: no sts, no cognito. Both the uniqueness confirmation and the
  // account binding are then unanswered questions, and both refuse — by design.
  let accountId = null;
  let domainProbe;
  if (opts.skipProbe) {
    domainProbe = { status: PROBE.NOT_CHECKED, region: opts.region || null };
  } else {
    accountId = resolveAccountId(run);
    if (typeof prefix === 'string' && prefix.trim() !== '') {
      domainProbe = probeDomain({ prefix: prefix.trim(), region: opts.region, expectedUserPoolId, run });
    } else {
      domainProbe = { status: PROBE.NOT_CHECKED, region: opts.region || null };
    }
  }

  let result;
  try {
    result = evaluatePreflight({ environment: opts.environment, context, domainProbe });
  } catch (err) {
    return { exit: EXIT.USAGE, output: err.message, result: null, manifest: null };
  }

  const failures = [...result.failures];
  if (!accountId) failures.push({ check: 'BINDING', code: 'ACCOUNT_UNRESOLVED', field: 'targetAccount' });
  const ok = result.ok && accountId !== null;

  // The manifest is written ONLY on a pass. A manifest for a refused configuration is a token that
  // should not exist: anything downstream that finds one would be entitled to trust it.
  let manifest = null;
  if (ok) {
    manifest = {
      version: MANIFEST_VERSION,
      issue: 70,
      releaseSha: opts.releaseSha,
      environment: opts.environment,
      region: opts.region,
      boundContextKeys: [...BOUND_CONTEXT_KEYS].sort(),
      contextDigest: contextDigest({ releaseSha: opts.releaseSha, environment: opts.environment, region: opts.region, accountId, context }),
      preflight: { PREFLIGHT_1: 'pass', PREFLIGHT_2: 'pass' },
    };
    if (opts.manifestOut) writeFile(opts.manifestOut, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  }

  if (opts.json) {
    const payload = { ok, environment: result.environment, failures, manifest };
    return { exit: ok ? EXIT.OK : EXIT.REFUSED, output: JSON.stringify(payload, null, 2), result, manifest };
  }

  const lines = [`deploy preflight — environment ${result.environment}, release ${opts.releaseSha.slice(0, 12)}`];
  for (const check of result.checks) lines.push(`  ${check.ok ? 'PASS' : 'FAIL'}  ${check.id}`);
  lines.push(`  ${accountId ? 'PASS' : 'FAIL'}  BINDING (target account resolved)`);
  for (const f of failures) lines.push(`          ${f.check}: ${describeFailure(f)}`);
  lines.push('');
  lines.push(
    ok
      ? `All conditions pass. Context digest ${manifest.contextDigest.slice(0, 16)}… binds release, environment, region and account.`
      : 'REFUSED before cdk deploy. Nothing was deployed.',
  );
  return { exit: ok ? EXIT.OK : EXIT.REFUSED, output: lines.join('\n'), result, manifest };
}

function parseVerifyArgs(argv) {
  const out = { context: {}, json: false, recompute: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-c' || a === '--context') parseContextPair(out, argv[++i]);
    else if (a === '--manifest') out.manifest = argv[++i];
    else if (a === '--environment') out.environment = argv[++i];
    else if (a === '--release-sha') out.releaseSha = argv[++i];
    else if (a === '--expect-digest') out.expectDigest = argv[++i];
    else if (a === '--recompute') out.recompute = true;
    else if (a === '--region') out.region = argv[++i];
    else if (a === '--json') out.json = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else throw new PreflightError('unrecognised argument');
  }
  return out;
}

/** The manifest schema is CLOSED: exactly these keys, exactly these shapes. */
function validManifestShape(m) {
  if (!m || typeof m !== 'object' || Array.isArray(m)) return false;
  const want = ['boundContextKeys', 'contextDigest', 'environment', 'issue', 'preflight', 'region', 'releaseSha', 'version'];
  if (JSON.stringify(Object.keys(m).sort()) !== JSON.stringify(want)) return false;
  return (
    m.version === MANIFEST_VERSION &&
    m.issue === 70 &&
    RELEASE_SHA.test(m.releaseSha) &&
    VALID_ENVIRONMENTS.includes(m.environment) &&
    typeof m.region === 'string' &&
    m.region.length > 0 &&
    /^[0-9a-f]{64}$/.test(m.contextDigest) &&
    Array.isArray(m.boundContextKeys)
  );
}

/**
 * The purpose-built binding check.
 *
 * Plain mode proves the manifest travelled intact and names THIS environment, THIS release and THIS
 * digest — that is what the Slice A stage jobs run. `--recompute` is the deploy-time form: it
 * re-resolves the account from the assumed credentials, re-reads the effective context, recomputes
 * the digest and compares. A deploying job runs it immediately before the deploy command, so the
 * values the deploy will use are the values that were validated — not merely SOME validated values.
 *
 * @returns {{exit:number, output:string}}
 */
function runVerifyManifest(argv, { run = defaultRun, cdkJsonPath = path.join(__dirname, '..', 'cdk.json'), readFile = fs.readFileSync } = {}) {
  let opts;
  try {
    opts = parseVerifyArgs(argv);
  } catch (err) {
    return { exit: EXIT.USAGE, output: `${err.message}\n\n${usage()}` };
  }
  if (opts.help) return { exit: EXIT.OK, output: usage() };
  for (const [key, label] of [['manifest', '--manifest'], ['environment', '--environment'], ['releaseSha', '--release-sha']]) {
    if (!opts[key]) return { exit: EXIT.USAGE, output: `${label} is required\n\n${usage()}` };
  }
  if (opts.recompute && !opts.region) {
    return { exit: EXIT.USAGE, output: `--recompute requires --region\n\n${usage()}` };
  }

  const failures = [];
  let manifest = null;
  let raw = null;
  try {
    raw = readFile(opts.manifest, 'utf8');
  } catch {
    failures.push({ check: 'VERIFY', code: 'MANIFEST_UNREADABLE', field: 'manifest' });
  }
  if (raw !== null) {
    try {
      manifest = JSON.parse(raw);
    } catch {
      failures.push({ check: 'VERIFY', code: 'MANIFEST_MALFORMED', field: 'manifest' });
    }
    if (manifest && !validManifestShape(manifest)) {
      failures.push({ check: 'VERIFY', code: 'MANIFEST_MALFORMED', field: 'manifest' });
      manifest = null;
    }
  }

  if (manifest) {
    if (manifest.environment !== opts.environment) failures.push({ check: 'VERIFY', code: 'MANIFEST_ENVIRONMENT_MISMATCH', field: 'environment' });
    if (manifest.releaseSha !== opts.releaseSha) failures.push({ check: 'VERIFY', code: 'MANIFEST_RELEASE_MISMATCH', field: 'releaseSha' });
    if (opts.expectDigest && manifest.contextDigest !== opts.expectDigest) {
      failures.push({ check: 'VERIFY', code: 'MANIFEST_DIGEST_MISMATCH', field: 'contextDigest' });
    }
    if (opts.recompute) {
      if (opts.region !== manifest.region) {
        failures.push({ check: 'VERIFY', code: 'MANIFEST_REGION_MISMATCH', field: 'region' });
      } else {
        const accountId = resolveAccountId(run);
        if (!accountId) {
          failures.push({ check: 'VERIFY', code: 'ACCOUNT_UNRESOLVED', field: 'targetAccount' });
        } else {
          const context = loadContext(opts.context, cdkJsonPath);
          const recomputed = contextDigest({ releaseSha: manifest.releaseSha, environment: manifest.environment, region: manifest.region, accountId, context });
          if (recomputed !== manifest.contextDigest) {
            failures.push({ check: 'VERIFY', code: 'MANIFEST_RECOMPUTE_MISMATCH', field: 'contextDigest' });
          }
        }
      }
    }
  }

  const ok = failures.length === 0;
  if (opts.json) return { exit: ok ? EXIT.OK : EXIT.REFUSED, output: JSON.stringify({ ok, failures }, null, 2) };
  const lines = [`manifest verification — environment ${opts.environment}, release ${opts.releaseSha.slice(0, 12)}`];
  lines.push(`  ${ok ? 'PASS' : 'FAIL'}  VERIFY${opts.recompute ? ' (recomputed)' : ''}`);
  for (const f of failures) lines.push(`          ${describeFailure(f)}`);
  return { exit: ok ? EXIT.OK : EXIT.REFUSED, output: lines.join('\n') };
}

module.exports = {
  runDeployPreflight,
  runVerifyManifest,
  probeDomain,
  loadContext,
  contextDigest,
  parseArgs,
  EXIT,
  PROBE_TIMEOUT_MS,
  BOUND_CONTEXT_KEYS,
  MANIFEST_VERSION,
};

if (require.main === module) {
  const argv = process.argv.slice(2);
  const res = argv[0] === 'verify-manifest' ? runVerifyManifest(argv.slice(1)) : runDeployPreflight(argv);
  process.stdout.write(`${res.output}\n`);
  process.exit(res.exit);
}
