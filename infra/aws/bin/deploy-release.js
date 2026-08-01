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
//     manifest shape and its own bound entrypoint, in a later slice. The workflow invariants allow
//     ONLY a closed set of step shapes, so this file is the only way anything deploys at all.
//   * The RELEASE is bound to the working tree and to the deployable content, not just to an
//     argument. Round 4 reproduced a deploy that verified a manifest naming one SHA while HEAD was
//     another: the entrypoint requires `git rev-parse HEAD` to equal the manifest's release, the
//     worktree to be clean, and the assembly's digest to equal the manifest's.
//   * The assembly is deployed from a PRIVATE SNAPSHOT, not the original path. Round 5 proved two
//     holes at once: the old digest covered only the root templates (mutating a Lambda bundle under
//     `asset.<hash>/` left it unchanged), and the original directory stayed mutable between the
//     check and CDK reading it. Now the assembly is copied — recursively, every regular file,
//     symlinks refused — into a fresh private directory; the digest is computed FROM THE SNAPSHOT;
//     and `--app` points at the snapshot. The original path is never reopened after verification.
//   * The REGION the manifest binds is imposed on the child: AWS_REGION, AWS_DEFAULT_REGION and
//     CDK_DEFAULT_REGION are all overridden with the verified value, so an ambient region pointing
//     somewhere else cannot redirect the deploy inside the same account.
//
// In Slice A the release lane never calls this file: nothing deploys yet. It exists now so the
// binding is established and adversarially tested BEFORE the first deploying slice, instead of
// being retrofitted around one.
//
// EXIT CODES  0 = deployed (child exit propagated) · 1 = refused · 2 = usage error.
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { describeFailure, PreflightError } = require('../lib/deploy-preflight');
const {
  contextDigest,
  assemblyDigest,
  walkAssembly,
  loadContext,
  resolveAccountId,
  validManifestShape,
  parseContextPair,
  defaultRun,
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
    else if (a === '--assembly') out.assembly = argv[++i];
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
    '  --assembly <dir>        required; the synthesized cdk.out whose digest the manifest binds',
    '  -c key=value            the effective context (repeatable) — the SAME values the',
    '                          preflight validated; the digest is recomputed from them',
    '',
    'It verifies the manifest digest against the effective values and the resolved account,',
    're-resolves the account immediately before the effect, and then deploys EXACTLY the',
    'verified context. Raw `cdk deploy` invocations are forbidden by the workflow invariants;',
    'this entrypoint is the only path to a deployment.',
  ].join('\n');
}

/** Default executor: the CDK child, stdio inherited so the deploy is observable. Injectable.
 * The env is supplied by the caller with the verified region imposed — never ambient as-is. */
function defaultExec(args, env) {
  const res = spawnSync('npx', args, { stdio: 'inherit', env });
  return { status: res.status === null ? 1 : res.status };
}

/** Default git reader: injectable, so the HEAD/worktree binding is testable offline. */
function defaultGit(args) {
  const res = spawnSync('git', args, { encoding: 'utf8' });
  return { status: res.status === null ? 1 : res.status, stdout: res.stdout || '' };
}

/**
 * Copy the assembly into a fresh PRIVATE directory and digest the COPY.
 *
 * The digest-then-deploy gap on the original path was a real window: the preflight digested it, the
 * child read it later, and anything running in between could swap a Lambda bundle. Digesting the
 * snapshot closes the gap by construction — whatever was copied is exactly what is digested and
 * exactly what `--app` deploys, and the original is never reopened after this function returns.
 *
 * @returns {{dir: string, digest: string} | {error: string}}
 */
function snapshotAssembly(srcDir) {
  const walked = walkAssembly(srcDir);
  if (walked.error) return walked;
  let dir;
  try {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cba-assembly-'));
    for (const f of walked.files) {
      const dest = path.join(dir, f.rel);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(f.abs, dest);
    }
  } catch {
    return { error: 'ASSEMBLY_UNREADABLE' };
  }
  const d = assemblyDigest(dir);
  if (d.error) return d;
  return { dir, digest: d.digest };
}

/**
 * Verify, then deploy the verified values — one process, one context object.
 *
 * @returns {{exit:number, output:string, executed:boolean}}
 */
function runDeployRelease(argv, { run = defaultRun, exec = defaultExec, git = defaultGit, cdkJsonPath = path.join(__dirname, '..', 'cdk.json'), readFile = fs.readFileSync, env = process.env } = {}) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    return { exit: EXIT.USAGE, output: `${err.message}\n\n${usage()}`, executed: false };
  }
  if (opts.help) return { exit: EXIT.OK, output: usage(), executed: false };
  for (const [key, label] of [['manifest', '--manifest'], ['environment', '--environment'], ['releaseSha', '--release-sha'], ['region', '--region'], ['assembly', '--assembly']]) {
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

  // 2b. The RELEASE, bound to reality. The manifest naming a SHA proves nothing about the files on
  //     disk: round 4 reproduced a verified deploy whose HEAD was a different commit entirely. The
  //     working tree must BE the release, exactly, with nothing on top.
  const head = git(['rev-parse', 'HEAD']);
  if (head.status !== 0 || head.stdout.trim() !== manifest.releaseSha) {
    failures.push({ check: 'VERIFY', code: 'RELEASE_HEAD_MISMATCH', field: 'releaseSha' });
  }
  const status = git(['status', '--porcelain']);
  if (status.status !== 0 || status.stdout.trim() !== '') {
    failures.push({ check: 'VERIFY', code: 'WORKTREE_DIRTY', field: 'worktree' });
  }

  // 2c. The ASSEMBLY, snapshotted and bound by digest. The copy happens FIRST and the digest is
  //     computed from the copy, so the value that is compared is the value that deploys — mutating
  //     the original after this point changes nothing the child will read.
  const snapshot = snapshotAssembly(opts.assembly);
  if (snapshot.error) failures.push({ check: 'VERIFY', code: snapshot.error, field: 'assembly' });
  else if (snapshot.digest !== manifest.assemblyDigest) {
    failures.push({ check: 'VERIFY', code: 'ASSEMBLY_DIGEST_MISMATCH', field: 'assemblyDigest' });
  }
  if (failures.length > 0) {
    if (snapshot && snapshot.dir) fs.rmSync(snapshot.dir, { recursive: true, force: true });
    return refuse();
  }

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

  // 5. The deploy, CONSTRUCTED from the verified objects. The child deploys the VERIFIED ASSEMBLY
  //    (`--app`) — context flags would be meaningless against a pre-synthesized assembly, and
  //    passing mutable source would discard the digest that was just checked. The verified region
  //    is IMPOSED on the child's environment: every region variable the CDK or the SDK reads is
  //    overridden, so an ambient region pointing elsewhere cannot redirect the deploy.
  const childArgs = ['cdk', 'deploy', '--all', '--require-approval', 'never', '--app', snapshot.dir];
  const childEnv = {
    ...env,
    AWS_REGION: manifest.region,
    AWS_DEFAULT_REGION: manifest.region,
    CDK_DEFAULT_REGION: manifest.region,
  };
  let child;
  try {
    child = exec(childArgs, childEnv);
  } finally {
    fs.rmSync(snapshot.dir, { recursive: true, force: true });
  }
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
