// `agent-publish` (#91 Stage A) — LOCAL PRE-FLIGHT VALIDATION ONLY.
//
// Stage A validates a publish gate against local repository state and prints the plan. It does NOT
// push, open a pull request, merge, change branch protection, create credentials or deploy, and it
// contains no code path that could. Anything that says otherwise is wrong.
//
// Publication itself is Stage B: a dedicated executor GitHub App/bot credential that can push a
// task branch and open/update a PR, with no merge, administration or ruleset-bypass authority.
// No environment or administrative GitHub credential is wired here, deliberately.
//
// The declared role is checked FIRST — before the gate is read, before git runs, before any
// network dependency could exist. That ordering is the control; the honesty about what the check
// proves (a declared claim, not an authenticated identity) is part of it.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { c } from '../lib/ui.js';
import { assertPublishingRole, parseGate, validateGate, evidenceFor, GateError } from '../lib/publish-gate.js';

export const EXIT = {
  OK: 0,
  VALIDATION_FAILED: 1,
  ROLE_REFUSED: 2, // distinct so a refusal is provably not a validation failure
};

function defaultRunGit(args, { cwd }) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function tryGit(runGit, args, cwd) {
  try {
    return runGit(args, { cwd });
  } catch {
    return null;
  }
}

/** Observes local state. Reads only — no writes, no fetch, no remote contact. */
function readRepoState(runGit, fsImpl, cwd, gate) {
  const branch = runGit(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd });
  const headSha = runGit(['rev-parse', 'HEAD'], { cwd });
  const status = runGit(['status', '--porcelain'], { cwd });
  const listed = runGit(['rev-list', '--reverse', `${gate.baseSha}..HEAD`], { cwd });
  const commits = listed === '' ? [] : listed.split('\n').map((s) => s.trim()).filter(Boolean);
  const mergeBase = runGit(['merge-base', 'HEAD', gate.baseSha], { cwd });

  // Local knowledge of the remote. Absent (null) when there is no such ref — never fetched here.
  const remoteBaseSha = tryGit(runGit, ['rev-parse', 'refs/remotes/origin/main'], cwd);

  // Worktree observation: which branch is checked out where.
  const raw = tryGit(runGit, ['worktree', 'list', '--porcelain'], cwd);
  let worktrees;
  if (raw !== null) {
    worktrees = [];
    let current = {};
    for (const line of raw.split('\n')) {
      if (line.startsWith('worktree ')) current = { path: line.slice(9) };
      else if (line.startsWith('branch ')) current.branch = line.slice(7).replace('refs/heads/', '');
      else if (line.trim() === '') {
        if (current.path) worktrees.push(current);
        current = {};
      }
    }
    if (current.path) worktrees.push(current);
  }

  let handoffPresent = false;
  try {
    handoffPresent = fsImpl
      .readdirSync(path.join(cwd, '.agent-handoff', 'active'))
      .some((name) => name.startsWith(`${gate.issue}-`));
  } catch {
    handoffPresent = false;
  }

  return { branch, headSha, clean: status === '', commits, baseSha: mergeBase, remoteBaseSha, worktrees, handoffPresent };
}

function printRefusal(err) {
  console.error(`${c.bold('agent-publish refused')} [${err.code}]`);
  console.error(err.message);
}

/**
 * @param {object} opts
 * @param {string} opts.role DECLARED role; only `executor` proceeds
 * @param {string} opts.executor DECLARED identity; must match the gate
 * @param {string} opts.gate path to the publish-gate manifest
 * @param {object} [opts.deps] test seams: { fs, runGit, now, cwd }
 */
export async function runAgentPublish(opts = {}) {
  const deps = opts.deps ?? {};
  const cwd = deps.cwd ?? process.cwd();
  const fsImpl = deps.fs ?? fs;
  const runGit = deps.runGit ?? defaultRunGit;
  const now = deps.now ?? (() => Date.now());

  // --- STEP 1: declared role. Nothing below runs for a non-publishing role. ---
  let role;
  try {
    role = assertPublishingRole(opts.role ?? process.env.CBA_AGENT_ROLE);
  } catch (err) {
    if (!(err instanceof GateError)) throw err;
    printRefusal(err);
    console.error(c.gray('No gate was read and no git command ran. Ask the executor to validate, or the human owner to merge.'));
    return EXIT.ROLE_REFUSED;
  }

  const executor = opts.executor ?? process.env.CBA_AGENT_ID;
  if (!executor) {
    console.error(`${c.bold('agent-publish refused')} [EXECUTOR_MISSING]`);
    console.error('Set --executor or CBA_AGENT_ID so the gate can be bound to a declared identity.');
    return EXIT.VALIDATION_FAILED;
  }

  if (!opts.gate) {
    console.error(`${c.bold('agent-publish refused')} [GATE_MISSING]`);
    console.error('Pass --gate <manifest>. Validation requires a human-authored gate.');
    return EXIT.VALIDATION_FAILED;
  }
  let raw;
  try {
    raw = fsImpl.readFileSync(path.resolve(cwd, opts.gate), 'utf8');
  } catch {
    console.error(`${c.bold('agent-publish refused')} [GATE_MISSING]`);
    console.error('No publish gate at the given path.');
    return EXIT.VALIDATION_FAILED;
  }

  let result;
  try {
    const gate = parseGate(raw);
    const repo = readRepoState(runGit, fsImpl, cwd, gate);
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

  console.log(`${c.bold('Publish gate VALID (local pre-flight only)')} ${evidence.gateId}`);
  console.log(`  issue          : #${evidence.issue}`);
  console.log(`  declared as    : ${evidence.declaredExecutor} (${evidence.declaredRole}) ${c.gray('— declared, not authenticated')}`);
  console.log(`  approved by    : ${evidence.approver}`);
  console.log(`  source branch  : ${evidence.sourceBranch}`);
  console.log(`  intended PR    : ${evidence.sourceBranch} -> ${evidence.targetBranch}`);
  console.log(`  base           : ${evidence.baseSha.slice(0, 7)}`);
  console.log(`  commits        : ${evidence.commits.map((s) => s.slice(0, 7)).join(', ')}`);

  console.log(`\n${c.bold('Advisories')}`);
  for (const note of result.advisories) console.log(`  - ${note}`);

  console.log(
    `\n${c.gray('Stage A is validation only: nothing was pushed, no pull request was touched and no ')}` +
      `${c.gray('credential was used. Publication and merge belong to Stage B and to the human owner.')}`,
  );
  return EXIT.OK;
}
