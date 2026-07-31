#!/usr/bin/env node
// The ONE sanctioned deployment entrypoint (#70 Slice A) — verification and deployment bound BY
// CONSTRUCTION, not by workflow choreography.
//
// Round 3 of the Codex review proved that choreography cannot bind: with verification and
// deployment as separate commands, a job could verify a safe context and then deploy a different
// one, verify under one set of credentials and deploy under another, or verify an AWS manifest and
// then deploy an unrelated Cloudflare target. Each passed the workflow invariants, because a
// textual ordering rule can only see that two commands exist — never that they used the same
// values.
//
// This entrypoint closes those holes STRUCTURALLY, in one process:
//
//   * The deploy arguments are DERIVED from the very context object that was verified. There is no
//     interface through which the deploy can receive different values: the `-c` flags handed to the
//     CDK child are read out of the same in-memory object whose digest was just compared.
//   * The account is resolved TWICE — once for the digest comparison and once immediately before
//     the child process is spawned. A credential swap between the two refuses with ACCOUNT_CHANGED.
//     What remains is the in-process window between the second resolution and the spawn, which no
//     userland check can close; it is disclosed here rather than papered over.
//   * The manifest names its service (`aws-cdk`), and this entrypoint deploys nothing else — there
//     is no code path that invokes wrangler or opennextjs. A Cloudflare deploy requires its own
//     manifest shape and its own bound entrypoint, in a later slice. The workflow invariants forbid
//     RAW deploy commands everywhere, so this file is the only way anything deploys at all.
//
// In Slice A the release lane never calls this file: nothing deploys yet. It exists now so the
// binding is established and adversarially tested BEFORE the first deploying slice, instead of
// being retrofitted around one.
//
// EXIT CODES  0 = deployed (child exit propagated) · 1 = refused · 2 = usage error.
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { describeFailure, PreflightError } = require('../lib/deploy-preflight');
const {
  contextDigest,
  loadContext,
  resolveAccountId,
  validManifestShape,
  parseContextPair,
  defaultRun,
  BOUND_CONTEXT_KEYS,
  MANIFEST_TARGET_SERVICE,
} = require('./deploy-preflight');

const EXIT = { OK: 0, REFUSED: 1, USAGE: 2 };

function parseArgs(argv) {
  const out = { context: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-c' || a === '--context') parseContextPair(out, argv[++i]);
    else if (a === '--manifest') out.manifest = argv[++i];
    else if (a === '--environment') out.environment = argv[++i];
    else if (a === '--release-sha') out.releaseSha = argv[++i];
    else if (a === '--region') out.region = argv[++i];
    else if (a === '--help' || a === '-h') out.help = true;
    // The offending token is not echoed: argv can hold a mistyped secret.
    else throw new PreflightError('unrecognised argument');
  }
  return out;
}

function usage() {
  return [
    'deploy-release — the only sanctioned deployment entrypoint (#70)',
    '',
    '  --manifest <path>       required; the manifest the preflight emitted',
    '  --environment <env>     required; must equal the manifest',
    '  --release-sha <40-hex>  required; must equal the manifest',
    '  --region <aws-region>   required; must equal the manifest',
    '  -c key=value            the effective context (repeatable) — the SAME values the',
    '                          preflight validated; the deploy is constructed from them',
    '',
    'It verifies the manifest digest against the effective values and the resolved account,',
    're-resolves the account immediately before the effect, and then deploys EXACTLY the',
    'verified context. Raw `cdk deploy` invocations are forbidden by the workflow invariants;',
    'this entrypoint is the only path to a deployment.',
  ].join('\n');
}

/** Default executor: the CDK child, stdio inherited so the deploy is observable. Injectable. */
function defaultExec(args) {
  const res = spawnSync('npx', args, { stdio: 'inherit' });
  return { status: res.status === null ? 1 : res.status };
}

/**
 * Verify, then deploy the verified values — one process, one context object.
 *
 * @returns {{exit:number, output:string, executed:boolean}}
 */
function runDeployRelease(argv, { run = defaultRun, exec = defaultExec, cdkJsonPath = path.join(__dirname, '..', 'cdk.json'), readFile = fs.readFileSync } = {}) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    return { exit: EXIT.USAGE, output: `${err.message}\n\n${usage()}`, executed: false };
  }
  if (opts.help) return { exit: EXIT.OK, output: usage(), executed: false };
  for (const [key, label] of [['manifest', '--manifest'], ['environment', '--environment'], ['releaseSha', '--release-sha'], ['region', '--region']]) {
    if (!opts[key]) return { exit: EXIT.USAGE, output: `${label} is required\n\n${usage()}`, executed: false };
  }

  const failures = [];
  const refuse = () => {
    const lines = [`deploy-release — environment ${opts.environment}`, '  FAIL  BINDING'];
    for (const f of failures) lines.push(`          ${describeFailure(f)}`);
    lines.push('', 'REFUSED. Nothing was deployed.');
    return { exit: EXIT.REFUSED, output: lines.join('\n'), executed: false };
  };

  // 1. The manifest, closed all the way down. A tampered nested claim is a forgery, not a variant.
  let manifest = null;
  try {
    const raw = readFile(opts.manifest, 'utf8');
    try {
      manifest = JSON.parse(raw);
    } catch {
      failures.push({ check: 'VERIFY', code: 'MANIFEST_MALFORMED', field: 'manifest' });
    }
  } catch {
    failures.push({ check: 'VERIFY', code: 'MANIFEST_UNREADABLE', field: 'manifest' });
  }
  if (manifest && !validManifestShape(manifest)) {
    failures.push({ check: 'VERIFY', code: 'MANIFEST_MALFORMED', field: 'manifest' });
    manifest = null;
  }
  if (!manifest) return refuse();

  // 2. Identity: this environment, this release, this region, this service.
  if (manifest.environment !== opts.environment) failures.push({ check: 'VERIFY', code: 'MANIFEST_ENVIRONMENT_MISMATCH', field: 'environment' });
  if (manifest.releaseSha !== opts.releaseSha) failures.push({ check: 'VERIFY', code: 'MANIFEST_RELEASE_MISMATCH', field: 'releaseSha' });
  if (manifest.region !== opts.region) failures.push({ check: 'VERIFY', code: 'MANIFEST_REGION_MISMATCH', field: 'region' });
  if (manifest.target.service !== MANIFEST_TARGET_SERVICE) failures.push({ check: 'VERIFY', code: 'DEPLOY_TARGET_UNSUPPORTED', field: 'target' });
  if (failures.length > 0) return refuse();

  // 3. The effective context and the account, digested and compared. THIS context object — not a
  //    copy, not a re-read — is what the deploy arguments are built from below.
  const context = loadContext(opts.context, cdkJsonPath);
  const accountAtVerify = resolveAccountId(run);
  if (!accountAtVerify) {
    failures.push({ check: 'VERIFY', code: 'ACCOUNT_UNRESOLVED', field: 'targetAccount' });
    return refuse();
  }
  const recomputed = contextDigest({
    releaseSha: manifest.releaseSha,
    environment: manifest.environment,
    region: manifest.region,
    accountId: accountAtVerify,
    context,
  });
  if (recomputed !== manifest.contextDigest) {
    failures.push({ check: 'VERIFY', code: 'MANIFEST_RECOMPUTE_MISMATCH', field: 'contextDigest' });
    return refuse();
  }

  // 4. The account again, immediately before the effect. A swap between verification and deploy is
  //    the round-3 reproduction; re-resolving here shrinks the window to this process's own gap
  //    between the check and the spawn, which is disclosed at the top of this file.
  const accountAtDeploy = resolveAccountId(run);
  if (accountAtDeploy !== accountAtVerify) {
    failures.push({ check: 'DEPLOY', code: 'ACCOUNT_CHANGED', field: 'targetAccount' });
    return refuse();
  }

  // 5. The deploy, CONSTRUCTED from the verified object. Every bound key present in the verified
  //    context becomes a `-c` flag with that exact value; there is no argument through which a
  //    caller can hand the child anything else.
  const childArgs = ['cdk', 'deploy', '--all', '--require-approval', 'never', '-c', `environment=${manifest.environment}`];
  for (const key of [...BOUND_CONTEXT_KEYS].sort()) {
    if (Object.hasOwn(context, key)) childArgs.push('-c', `${key}=${context[key]}`);
  }
  const child = exec(childArgs);
  const exit = child.status === 0 ? EXIT.OK : EXIT.REFUSED;
  return {
    exit,
    output: [
      `deploy-release — environment ${manifest.environment}, release ${manifest.releaseSha.slice(0, 12)}`,
      `  PASS  BINDING (digest ${manifest.contextDigest.slice(0, 16)}…, account pinned)`,
      child.status === 0 ? 'Deployed the verified context.' : 'The deploy child failed; the binding held.',
    ].join('\n'),
    executed: true,
  };
}

module.exports = { runDeployRelease, EXIT };

if (require.main === module) {
  const { exit, output } = runDeployRelease(process.argv.slice(2));
  process.stdout.write(`${output}\n`);
  process.exit(exit);
}
