// Local repository observation for publish-gate validation (#91 Stage A, #93 script preparation).
//
// READ-ONLY BY CONSTRUCTION. Every git invocation here is an observation: `rev-parse`, `status`,
// `rev-list`, `merge-base`, `worktree list`, `remote get-url`. No fetch, no push, no write verb.
// It lives in one module so the Stage A validator and the #93 script generator can never drift
// into observing different state and reaching different conclusions about the same repository.
import fsDefault from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export function defaultRunGit(args, { cwd }) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

export function tryGit(runGit, args, cwd) {
  try {
    return runGit(args, { cwd });
  } catch {
    return null;
  }
}

/**
 * Observe local state relevant to a gate. Reads only — no writes, no fetch, no remote contact.
 *
 * @param {(args: string[], opts: {cwd: string}) => string} runGit
 * @param {typeof import('node:fs')} fsImpl
 * @param {string} cwd
 * @param {{ baseSha: string, issue: number }} gate
 */
export function readRepoState(runGit, fsImpl, cwd, gate) {
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
    handoffPresent = (fsImpl ?? fsDefault)
      .readdirSync(path.join(cwd, '.agent-handoff', 'active'))
      .some((name) => name.startsWith(`${gate.issue}-`));
  } catch {
    handoffPresent = false;
  }

  return { branch, headSha, clean: status === '', commits, baseSha: mergeBase, remoteBaseSha, worktrees, handoffPresent };
}

/**
 * Derive `owner/repo` from the `origin` remote.
 *
 * Deliberately strict: only the two canonical GitHub forms are accepted. A URL carrying userinfo
 * (`https://user:token@github.com/...`) fails the pattern rather than being parsed and stripped, so
 * a credential embedded in a remote can never reach the generated script or an error message.
 *
 * @returns {string|null} `owner/repo`, or null when the remote is absent or not canonical
 */
export function deriveRepoSlug(runGit, cwd) {
  const url = tryGit(runGit, ['remote', 'get-url', 'origin'], cwd);
  if (!url) return null;
  const m = /^(?:git@github\.com:|https:\/\/github\.com\/)([A-Za-z0-9][A-Za-z0-9._-]{0,38}\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}?)(?:\.git)?$/.exec(url.trim());
  return m ? m[1] : null;
}
