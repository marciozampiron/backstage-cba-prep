// `agent-publish` (#91 Stage A) — the ONLY sanctioned way an agent publishes source.
//
// It pushes an issue branch and opens/updates a pull request. It has no merge path, no
// branch-protection path, no credential-creation path and no deploy path — those are human
// actions, and Stage B moves the authoritative enforcement to the remote.
//
// Order of operations matters and is part of the control: the role is refused BEFORE the gate is
// read and before any network dependency is even constructed, so an architect/reviewer invocation
// cannot reach the network at all.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { c } from '../lib/ui.js';
import { assertPublishingRole, parseGate, validateGate, evidenceFor, GateError } from '../lib/publish-gate.js';

export const EXIT = {
  OK: 0,
  VALIDATION_FAILED: 1,
  ROLE_REFUSED: 2, // distinct so CI/tests can assert a refusal happened before any network use
};

function defaultRunGit(args, { cwd }) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

/** Reads observable repository state. No writes, no remote contact. */
function readRepoState(runGit, cwd, baseSha) {
  const branch = runGit(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd });
  const headSha = runGit(['rev-parse', 'HEAD'], { cwd });
  const status = runGit(['status', '--porcelain'], { cwd });
  // Commits unique to this branch relative to the gate's base, oldest first.
  const listed = runGit(['rev-list', '--reverse', `${baseSha}..HEAD`], { cwd });
  const commits = listed === '' ? [] : listed.split('\n').map((s) => s.trim()).filter(Boolean);
  const mergeBase = runGit(['merge-base', 'HEAD', baseSha], { cwd });
  return { branch, headSha, clean: status === '', commits, baseSha: mergeBase };
}

function printRefusal(err) {
  console.error(`${c.bold('agent-publish refused')} [${err.code}]`);
  console.error(err.message);
}

/**
 * @param {object} opts
 * @param {string} opts.role invoking role; only `executor` may proceed
 * @param {string} opts.executor invoking agent identity
 * @param {string} opts.gate path to the publish-gate manifest
 * @param {boolean} [opts.dryRun] validate and print the plan without contacting the remote
 * @param {object} [opts.deps] injected seams for tests: { fs, runGit, now, publish, cwd }
 */
export async function runAgentPublish(opts = {}) {
  const deps = opts.deps ?? {};
  const cwd = deps.cwd ?? process.cwd();
  const fsImpl = deps.fs ?? fs;
  const runGit = deps.runGit ?? defaultRunGit;
  const now = deps.now ?? (() => Date.now());

  // ---------------------------------------------------------------------------------------------
  // STEP 1 — ROLE. Nothing above this line touches the filesystem, git or the network, and nothing
  // below it runs for a non-publishing role. This is the control the 2026-07-26 incident needed.
  // ---------------------------------------------------------------------------------------------
  let role;
  try {
    role = assertPublishingRole(opts.role ?? process.env.CBA_AGENT_ROLE);
  } catch (err) {
    if (err instanceof GateError) {
      printRefusal(err);
      console.error(
        c.gray('No gate was read and no network call was made. Ask the executor agent to publish, ' +
          'or ask the human owner to merge.'),
      );
      return EXIT.ROLE_REFUSED;
    }
    throw err;
  }

  const executor = opts.executor ?? process.env.CBA_AGENT_ID;
  if (!executor) {
    console.error(`${c.bold('agent-publish refused')} [EXECUTOR_MISSING]`);
    console.error('Set --executor or CBA_AGENT_ID so the gate can be bound to an identity.');
    return EXIT.VALIDATION_FAILED;
  }

  // STEP 2 — gate manifest.
  const gatePath = opts.gate;
  if (!gatePath) {
    console.error(`${c.bold('agent-publish refused')} [GATE_MISSING]`);
    console.error('Pass --gate <path to the publish-gate manifest>. Publication requires a human gate.');
    return EXIT.VALIDATION_FAILED;
  }
  let raw;
  try {
    raw = fsImpl.readFileSync(path.resolve(cwd, gatePath), 'utf8');
  } catch {
    console.error(`${c.bold('agent-publish refused')} [GATE_MISSING]`);
    console.error(`No publish gate at "${gatePath}".`);
    return EXIT.VALIDATION_FAILED;
  }

  // STEP 3 — validate manifest, then repository state, then the two against each other.
  let result;
  try {
    const gate = parseGate(raw);
    const repo = readRepoState(runGit, cwd, gate.baseSha);
    result = validateGate({ gate, role, executor, repo, nowMs: now() });
  } catch (err) {
    if (err instanceof GateError) {
      printRefusal(err);
      return EXIT.VALIDATION_FAILED;
    }
    console.error(`${c.bold('agent-publish refused')} [REPO_UNREADABLE]`);
    console.error(err?.message ?? String(err));
    return EXIT.VALIDATION_FAILED;
  }

  const evidence = evidenceFor(result, { role, executor, at: new Date(now()).toISOString() });

  console.log(`${c.bold('Publish gate accepted')} ${result.gate.gateId}`);
  console.log(`  issue         : #${result.issue}`);
  console.log(`  executor      : ${executor} (${role})`);
  console.log(`  approved by   : ${result.gate.approver}`);
  console.log(`  source branch : ${result.sourceBranch}`);
  console.log(`  pull request  : ${result.sourceBranch} -> ${result.gate.targetBranch} (never merged here)`);
  console.log(`  base          : ${result.gate.baseSha.slice(0, 7)}`);
  console.log(`  commits       : ${result.commits.map((s) => s.slice(0, 7)).join(', ')}`);

  if (opts.dryRun) {
    console.log(c.gray('\nDry run: validation only. No branch was pushed and no pull request was touched.'));
    return EXIT.OK;
  }

  // STEP 4 — the only outward-facing action: push the ISSUE BRANCH and open/update the PR.
  // `publish` is injected so tests never reach a remote. It is intentionally incapable of merging.
  const publish = deps.publish;
  if (!publish) {
    console.error(`${c.bold('agent-publish stopped')} [NO_PUBLISHER]`);
    console.error(
      'No publisher is wired in this build. Stage A validates and records the decision; the branch ' +
        'push and pull request belong to the Stage B executor credential, which has no merge or ' +
        'administration authority. Re-run with --dry-run to confirm the gate.',
    );
    return EXIT.VALIDATION_FAILED;
  }
  await publish({ sourceBranch: result.sourceBranch, targetBranch: result.gate.targetBranch, evidence });
  console.log(c.gray('\nBranch published and pull request opened/updated. Merge remains a human action.'));
  return EXIT.OK;
}
