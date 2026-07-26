// `agent-human-publish-script` (#93) — PREPARE a publication script for a HUMAN to run.
//
// This command is the interim bridge between #91 Stage A (advisory local validation) and #91
// Stage B (authenticated bot identity plus remote enforcement). It writes a short-lived, bounded,
// reviewable bash script to /tmp and stops. It does not run it.
//
// THE THREE ROLES, MECHANICALLY SEPARATED IN TIME:
//   - the implementation executor PREPARES the script (this command);
//   - the architect/security reviewer READS it — reviewing is not implementing or executing;
//   - the HUMAN operator runs it explicitly with `bash <path>`.
//
// WHAT THIS COMMAND CANNOT DO. It performs no network call, spawns no shell, and issues no Git or
// GitHub mutation. Its git usage is inherited from the Stage A observer (`rev-parse`, `status`,
// `rev-list`, `merge-base`, `worktree list`, `remote get-url`) — all read verbs. Its only side
// effect is creating one file. That file is written 0600 and WITHOUT an executable bit, so running
// it is always a deliberate human act rather than something that can happen by accident.
//
// The declared role remains caller-supplied. This is a process guardrail, not authenticated role
// separation; only Stage B makes it unforgeable.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { c } from '../lib/ui.js';
import { assertPublishingRole, parseGate, validateGate, GateError } from '../lib/publish-gate.js';
import { defaultRunGit, readRepoState, deriveRepoSlug } from '../lib/repo-state.js';
import {
  assertSafeOutputPath,
  assertRepoSlug,
  buildPublicationScript,
  FORBIDDEN_SCRIPT_PATTERNS,
  OUTPUT_ROOT,
} from '../lib/human-publish-script.js';

export const EXIT = {
  OK: 0,
  VALIDATION_FAILED: 1,
  ROLE_REFUSED: 2, // same meaning as agent-publish: a refusal is provably not a validation failure
};

/** Mode 0600, no executable bit for anyone. Asserted after the write, not merely requested. */
export const SCRIPT_MODE = 0o600;

function printRefusal(command, err) {
  console.error(`${c.bold(`${command} refused`)} [${err.code ?? 'REFUSED'}]`);
  console.error(err.message);
}

function defaultOutputPath(issue, head) {
  return `${OUTPUT_ROOT}/cba-publish-${issue}-${head.slice(0, 12)}.sh`;
}

/**
 * Observe the output path on disk without following it.
 *
 * `lstat` and not `stat`: a symlink must be detected as a symlink, not silently resolved to its
 * target. The result feeds `assertSafeOutputPath`; the write itself additionally uses the `wx`
 * flag, so the check-then-write race cannot end in an overwrite.
 */
function observePath(fsImpl, outputPath, repoRoot) {
  let exists = false;
  let isSymlink = false;
  try {
    const st = fsImpl.lstatSync(outputPath);
    exists = true;
    isSymlink = st.isSymbolicLink();
  } catch {
    exists = false;
  }
  return { exists, isSymlink, repoRoot };
}

/**
 * @param {object} opts
 * @param {string} opts.role DECLARED role; only `executor` may prepare a script
 * @param {string} opts.executor DECLARED identity; must match the gate
 * @param {string} opts.gate path to the publish-gate manifest
 * @param {string} [opts.repo] `owner/repo`; derived from the origin remote when omitted
 * @param {string} [opts.out] output path under /tmp
 * @param {object} [opts.deps] test seams: { fs, runGit, now, cwd }
 */
export async function runAgentHumanPublishScript(opts = {}) {
  const deps = opts.deps ?? {};
  const cwd = deps.cwd ?? process.cwd();
  const fsImpl = deps.fs ?? fs;
  const runGit = deps.runGit ?? defaultRunGit;
  const now = deps.now ?? (() => Date.now());
  const CMD = 'agent-human-publish-script';

  // --- STEP 1: declared role. The reviewer reviews and the human runs; neither generates. ---
  let role;
  try {
    role = assertPublishingRole(opts.role ?? process.env.CBA_AGENT_ROLE);
  } catch (err) {
    if (!(err instanceof GateError)) throw err;
    printRefusal(CMD, err);
    console.error(c.gray('No gate was read, no git command ran and no file was written.'));
    return EXIT.ROLE_REFUSED;
  }

  const executor = opts.executor ?? process.env.CBA_AGENT_ID;
  if (!executor) {
    printRefusal(CMD, { code: 'EXECUTOR_MISSING', message: 'Set --executor or CBA_AGENT_ID so the gate can be bound to a declared identity.' });
    return EXIT.VALIDATION_FAILED;
  }
  if (!opts.gate) {
    printRefusal(CMD, { code: 'GATE_MISSING', message: 'Pass --gate <manifest>. A script is only ever prepared from a human-authored gate.' });
    return EXIT.VALIDATION_FAILED;
  }

  let repoRoot;
  try {
    repoRoot = runGit(['rev-parse', '--show-toplevel'], { cwd });
  } catch {
    repoRoot = cwd;
  }

  // The gate may NOT live inside this worktree. `.agent-handoff/publish-gates/` is tracked and not
  // ignored, so a gate written there is an untracked file — which makes the worktree dirty, which
  // this very command then refuses. The documented protocol was literally unexecutable. The gate is
  // a human decision bound to SHAs; it belongs outside the branch being published, and this check
  // makes that mechanical so the documents cannot drift back.
  const gatePath = path.resolve(cwd, opts.gate);
  if (gatePath === repoRoot || gatePath.startsWith(`${repoRoot}${path.sep}`)) {
    printRefusal(CMD, {
      code: 'GATE_PATH_IN_REPO',
      message:
        'The publish gate must live outside the repository worktree. A gate written inside it is an ' +
        'untracked file, which makes the worktree dirty and is then refused. Write it to a path ' +
        'outside the repository, for example under /tmp.',
    });
    return EXIT.VALIDATION_FAILED;
  }

  // --- STEP 2: the same Stage A validation. A script is never built from an unvalidated gate. ---
  let result;
  let gate;
  try {
    const raw = fsImpl.readFileSync(gatePath, 'utf8');
    gate = parseGate(raw);
    const repoState = readRepoState(runGit, fsImpl, cwd, gate);
    result = validateGate({ gate, role, executor, repo: repoState, nowMs: now() });
  } catch (err) {
    if (err instanceof GateError) {
      printRefusal(CMD, err);
      return EXIT.VALIDATION_FAILED;
    }
    // The raw error is NOT printed: a failed `readFileSync` embeds the path it was given, and that
    // path is caller-supplied. Refusals name what went wrong, never the value that caused it.
    printRefusal(CMD, {
      code: 'REPO_UNREADABLE',
      message: 'The gate could not be read, or the repository state could not be observed. No path or raw error is echoed.',
    });
    return EXIT.VALIDATION_FAILED;
  }

  // --- STEP 3: repository slug and output path. ---
  let repoSlug;
  let outputPath;
  try {
    // The repository is DERIVED from the origin remote, never merely accepted. The script pushes
    // to `origin` but queries `$REPO` through `gh`; if those two named different repositories the
    // branch would land in one place while the pull request was inspected in another. A supplied
    // `--repo` is therefore only ever a confirmation of what origin already says.
    const derived = deriveRepoSlug(runGit, cwd);
    if (!derived) {
      throw new GateError(
        'ORIGIN_UNRESOLVED',
        'The origin remote is missing or is not a canonical GitHub URL, so the repository cannot be bound to the push target.',
      );
    }
    if (opts.repo != null && opts.repo !== derived) {
      throw new GateError(
        'REPO_ORIGIN_MISMATCH',
        'The requested repository is not the origin remote of this worktree. Publication must target the repository this branch is pushed to.',
      );
    }
    repoSlug = assertRepoSlug(derived);
    const headSha = result.commits[result.commits.length - 1];
    const requested = opts.out ?? defaultOutputPath(gate.issue, headSha);
    outputPath = assertSafeOutputPath(requested, observePath(fsImpl, requested, repoRoot));
  } catch (err) {
    if (err instanceof GateError) {
      printRefusal(CMD, err);
      return EXIT.VALIDATION_FAILED;
    }
    throw err;
  }

  // --- STEP 4: build, then self-check the built text before it reaches the filesystem. ---
  const generatedAt = new Date(now()).toISOString();
  const script = buildPublicationScript({ result, repo: repoSlug, generatedAt });

  // The generator is trusted to be correct, and the output is still scanned. A defect that adds a
  // forbidden verb must fail here rather than in front of the human operator.
  for (const { label, re } of FORBIDDEN_SCRIPT_PATTERNS) {
    if (re.test(script)) {
      printRefusal(CMD, {
        code: 'SCRIPT_SELF_CHECK_FAILED',
        message: `The generated script contains a forbidden operation (${label}). Nothing was written; this is a defect in the generator.`,
      });
      return EXIT.VALIDATION_FAILED;
    }
  }

  // --- STEP 5: write 0600, non-executable, never overwriting. ---
  try {
    // `wx` fails when the path exists, closing the gap between the lstat above and this write.
    fsImpl.writeFileSync(outputPath, script, { mode: SCRIPT_MODE, flag: 'wx' });
    // The mode passed to open() is masked by the umask, so the permissions are set explicitly and
    // then verified. A world-readable script naming branches and SHAs is not a leak of secrets, but
    // an executable one invites exactly the accidental run this design exists to prevent.
    fsImpl.chmodSync(outputPath, SCRIPT_MODE);
    const mode = fsImpl.statSync(outputPath).mode & 0o777;
    if (mode !== SCRIPT_MODE) {
      throw new GateError('SCRIPT_MODE_UNEXPECTED', `The script was written with mode ${mode.toString(8)} instead of 600.`);
    }
  } catch (err) {
    if (err instanceof GateError) {
      printRefusal(CMD, err);
      return EXIT.VALIDATION_FAILED;
    }
    printRefusal(CMD, {
      code: err?.code === 'EEXIST' ? 'OUTPUT_PATH_EXISTS' : 'OUTPUT_WRITE_FAILED',
      message:
        err?.code === 'EEXIST'
          ? 'The output path already exists; refusing to overwrite a previous artifact.'
          : 'The script could not be written.',
    });
    return EXIT.VALIDATION_FAILED;
  }

  const digest = createHash('sha256').update(script, 'utf8').digest('hex');
  const head = result.commits[result.commits.length - 1];

  console.log(`${c.bold('Publication script PREPARED — not executed')} ${gate.gateId}`);
  console.log(`  issue          : #${gate.issue}`);
  console.log(`  declared as    : ${executor} (${role}) ${c.gray('— declared, not authenticated')}`);
  console.log(`  approved by    : ${gate.approver}`);
  console.log(`  branch         : ${result.sourceBranch} -> ${gate.targetBranch} ${c.gray('(pull request only)')}`);
  console.log(`  head           : ${head.slice(0, 12)}`);
  console.log(`  commits        : ${result.commits.length}`);
  console.log(`  gate expires   : ${gate.expiresAt}`);
  console.log(`  script         : ${outputPath} ${c.gray('(mode 600, not executable)')}`);
  console.log(`  sha256         : ${digest}`);

  console.log(`\n${c.bold('Next, in order')}`);
  console.log('  1. the architect/security reviewer READS the script and confirms the sha256 above;');
  console.log(`  2. the HUMAN operator runs it: ${c.bold(`bash ${outputPath}`)}`);
  console.log('  3. the human merges the pull request separately, after checks and review.');
  console.log(
    `\n${c.gray('No agent may run this script. It can only push the gated branch and open or reuse one ')}` +
      `${c.gray('pull request — never merge, deploy, push main, force-push or change repository settings.')}`,
  );
  return EXIT.OK;
}
