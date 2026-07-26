// Human-operated publication script tests (#93).
//
// Every test is OFFLINE. The generator is pure, and the command receives injected `fs` and `runGit`
// seams, so nothing here contacts a remote, pushes a branch, opens a pull request or runs the
// generated script. Where a test does touch the real filesystem it writes only inside a per-test
// directory under the OS temp dir and removes it afterwards.
//
// What these tests are for: the artifact this command produces is the closest thing in the
// repository to a loaded weapon. It is a bash script that pushes. The suite proves what it may
// touch, what it may never contain, and that the docs, rules and skills all say the same thing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';

import {
  verifyAndRunCommand,
  assertSafeOutputPath,
  assertRepoSlug,
  buildPublicationScript,
  FORBIDDEN_SCRIPT_PATTERNS,
  OUTPUT_ROOT,
} from '../src/lib/human-publish-script.js';
import { deriveRepoSlug } from '../src/lib/repo-state.js';
import { runAgentHumanPublishScript, EXIT, SCRIPT_MODE } from '../src/commands/agent-human-publish-script.js';
import { parseGate, validateGate, GateError } from '../src/lib/publish-gate.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const BASE = 'a'.repeat(40);
const C1 = '1'.repeat(40);
const C2 = '2'.repeat(40);
const OTHER = '9'.repeat(40);

const APPROVED_AT = '2026-07-26T18:00:00Z';
const EXPIRES_AT = '2026-07-26T22:00:00Z';
const NOW = Date.parse('2026-07-26T19:00:00Z');
const REPO = 'marciozampiron/backstage-cba-prep';

function gateFixture(overrides = {}) {
  return {
    gateId: 'gate-93-001',
    issue: 93,
    executor: 'claude-opus-5',
    baseSha: BASE,
    commits: [C1, C2],
    sourceBranch: 'task/93-human-publication-script',
    targetBranch: 'main',
    approver: 'marciozampiron',
    approvedAt: APPROVED_AT,
    expiresAt: EXPIRES_AT,
    reviewedShas: [C1, C2],
    ...overrides,
  };
}

function repoFixture(overrides = {}) {
  return {
    branch: 'task/93-human-publication-script',
    headSha: C2,
    baseSha: BASE,
    commits: [C1, C2],
    clean: true,
    remoteBaseSha: BASE,
    worktrees: [{ path: '/w/93', branch: 'task/93-human-publication-script' }],
    handoffPresent: true,
    ...overrides,
  };
}

function validResult(gate = gateFixture(), repo = repoFixture()) {
  return validateGate({ gate, role: 'executor', executor: 'claude-opus-5', repo, nowMs: NOW });
}

function scriptFixture(gate, repo) {
  return buildPublicationScript({
    result: validResult(gate ?? gateFixture(), repo ?? repoFixture()),
    repo: REPO,
    generatedAt: new Date(NOW).toISOString(),
  });
}

function expectRefusal(code, fn) {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof GateError, `expected a GateError, got ${err}`);
    assert.equal(err.code, code);
    return err;
  }
  assert.fail(`expected refusal ${code}, but the call succeeded`);
}

/** Captures console output so a refusal can be asserted on without polluting the test log. */
async function captureAsync(fn) {
  const out = [];
  const log = console.log;
  const error = console.error;
  console.log = (...a) => out.push(a.join(' '));
  console.error = (...a) => out.push(a.join(' '));
  try {
    const value = await fn();
    return { value, output: out.join('\n') };
  } finally {
    console.log = log;
    console.error = error;
  }
}

/* ================= POSITIVE CONTROL ================= */

test('POSITIVE CONTROL: a valid gate produces a script bound to exactly that gate', () => {
  const script = scriptFixture();
  assert.match(script, /^#!\/usr\/bin\/env bash\n/);
  assert.match(script, /set -euo pipefail/);
  assert.ok(script.includes(`REPO='${REPO}'`));
  assert.ok(script.includes("ISSUE='93'"));
  assert.ok(script.includes("SOURCE_BRANCH='task/93-human-publication-script'"));
  assert.ok(script.includes("TARGET_BRANCH='main'"));
  assert.ok(script.includes(`EXPECTED_HEAD='${C2}'`));
  assert.ok(script.includes(`BASE_SHA='${BASE}'`));
  assert.ok(script.includes(`'${C1}'`) && script.includes(`'${C2}'`));
});

/* ================= OUTPUT PATH ================= */

test('the output path must be under /tmp and nowhere else', () => {
  expectRefusal('OUTPUT_PATH_OUTSIDE_TMP', () => assertSafeOutputPath('/home/user/publish.sh'));
  expectRefusal('OUTPUT_PATH_OUTSIDE_TMP', () => assertSafeOutputPath('relative.sh'));
  expectRefusal('OUTPUT_PATH_OUTSIDE_TMP', () => assertSafeOutputPath('/tmpfoo/publish.sh'));
  assert.equal(assertSafeOutputPath('/tmp/cba-publish-93-abc.sh'), '/tmp/cba-publish-93-abc.sh');
  assert.equal(OUTPUT_ROOT, '/tmp');
});

test('the output path must never be inside the repository', () => {
  // Belt and braces on top of the /tmp constraint: if the root rule were ever relaxed, this one
  // still keeps a runnable artifact out of the tree where it would look like project code.
  expectRefusal('OUTPUT_PATH_OUTSIDE_TMP', () => assertSafeOutputPath(`${ROOT}/publish.sh`, { repoRoot: ROOT }));
  expectRefusal('OUTPUT_PATH_IN_REPO', () => assertSafeOutputPath('/tmp/x.sh', { repoRoot: '/tmp' }));
});

test('traversal segments are refused on the literal path, even when they normalise inside /tmp', () => {
  expectRefusal('OUTPUT_PATH_TRAVERSAL', () => assertSafeOutputPath('/tmp/../etc/publish.sh'));
  expectRefusal('OUTPUT_PATH_TRAVERSAL', () => assertSafeOutputPath('/tmp/a/../publish.sh'));
  expectRefusal('OUTPUT_PATH_TRAVERSAL', () => assertSafeOutputPath('/tmp/./publish.sh'));
});

test('a symlink at the output path is refused rather than followed', () => {
  expectRefusal('OUTPUT_PATH_SYMLINK', () => assertSafeOutputPath('/tmp/publish.sh', { isSymlink: true }));
});

test('an existing file at the output path is never overwritten', () => {
  expectRefusal('OUTPUT_PATH_EXISTS', () => assertSafeOutputPath('/tmp/publish.sh', { exists: true }));
});

test('the output filename is bounded, and control characters or whitespace are refused', () => {
  expectRefusal('OUTPUT_PATH_INVALID', () => assertSafeOutputPath(' /tmp/publish.sh'));
  expectRefusal('OUTPUT_PATH_INVALID', () => assertSafeOutputPath('/tmp/pub\nlish.sh'));
  expectRefusal('OUTPUT_PATH_INVALID', () => assertSafeOutputPath(`/tmp/pub${String.fromCharCode(0)}lish.sh`));
  expectRefusal('OUTPUT_PATH_INVALID', () => assertSafeOutputPath('/tmp/publish.txt'));
  expectRefusal('OUTPUT_PATH_INVALID', () => assertSafeOutputPath('/tmp/sub/dir/publish.sh'));
  expectRefusal('OUTPUT_PATH_INVALID', () => assertSafeOutputPath(`/tmp/${'x'.repeat(200)}.sh`));
  expectRefusal('OUTPUT_PATH_INVALID', () => assertSafeOutputPath(''));
  expectRefusal('OUTPUT_PATH_INVALID', () => assertSafeOutputPath(null));
});

/* ================= REPOSITORY SLUG ================= */

test('the repository slug is strict, and a credential-shaped one is refused without being echoed', () => {
  assert.equal(assertRepoSlug(REPO), REPO);
  expectRefusal('REPO_SLUG_INVALID', () => assertRepoSlug('not-a-slug'));
  expectRefusal('REPO_SLUG_INVALID', () => assertRepoSlug('owner/repo; rm -rf /'));
  expectRefusal('REPO_SLUG_INVALID', () => assertRepoSlug('owner/repo && curl evil'));
  expectRefusal('REPO_SLUG_INVALID', () => assertRepoSlug(''));
  expectRefusal('REPO_SLUG_INVALID', () => assertRepoSlug(null));
});

test('a remote URL carrying a credential fails the pattern instead of being parsed and stripped', () => {
  const run = (url) => deriveRepoSlug(() => url, '/w');
  assert.equal(run(`https://github.com/${REPO}.git`), REPO);
  assert.equal(run(`git@github.com:${REPO}.git`), REPO);
  assert.equal(run(`https://github.com/${REPO}`), REPO);
  // The point is that this returns null, not "marciozampiron/backstage-cba-prep": a token in a
  // remote URL must never be silently accepted, even though the slug after it looks fine.
  assert.equal(run(`https://user:ghp_EXAMPLETOKEN@github.com/${REPO}.git`), null);
  assert.equal(run('https://evil.example.com/marciozampiron/backstage-cba-prep.git'), null);
  assert.equal(run(''), null);
});

/* ================= FORBIDDEN OPERATIONS IN THE GENERATED SCRIPT ================= */

test('the generated script contains NO forbidden operation', () => {
  const script = scriptFixture();
  for (const { label, re } of FORBIDDEN_SCRIPT_PATTERNS) {
    assert.equal(re.test(script), false, `the generated script contains a forbidden operation: ${label}`);
  }
});

test('the forbidden-operation list actually detects what it claims to detect', () => {
  // A test asserting "no match" is worthless if the patterns never match anything. Each pattern is
  // proven against a sample of the operation it is supposed to catch.
  const samples = {
    'force push': 'git push --force origin task/93-x',
    'pushing an integration branch': 'git push origin HEAD:main',
    merge: 'gh pr merge 93 --squash',
    deploy: 'cdk deploy ApiStack',
    'repository administration': 'gh api repos/o/r/branches/main/protection -X PUT',
    'credential handling': 'GH_TOKEN=abc gh pr create',
    'history rewriting': 'git rebase -i origin/main',
    'paid service invocation': 'aws bedrock-runtime invoke-model --model-id x',
  };
  for (const { label, re } of FORBIDDEN_SCRIPT_PATTERNS) {
    const sample = samples[label];
    assert.ok(sample, `no sample for pattern "${label}"`);
    assert.equal(re.test(sample), true, `pattern "${label}" failed to match its own sample`);
  }
});

test('the script performs exactly ONE push, of the task branch, without force', () => {
  const script = scriptFixture();
  const pushes = script.split('\n').filter((l) => /^\s*git push\b/.test(l));
  assert.equal(pushes.length, 1, `expected exactly one push, found ${pushes.length}`);
  assert.equal(pushes[0].trim(), 'git push origin "refs/heads/$SOURCE_BRANCH:refs/heads/$SOURCE_BRANCH"');
});

test('the script never merges the pull request it creates', () => {
  const script = scriptFixture();
  // Comments and printed evidence say the word "merge" on purpose; what matters is that no
  // executable line performs one. `merge-base --is-ancestor` is a read-only ancestry query.
  const code = script.split('\n').filter((l) => !/^\s*#/.test(l) && l.trim() !== '');
  for (const line of code) {
    assert.equal(/\bgh\s+pr\s+merge\b/.test(line), false, `merge command in: ${line}`);
    assert.equal(/\bgit\s+merge(?![-\w])/.test(line), false, `merge command in: ${line}`);
  }
  assert.match(script, /merge is a separate human action/);
});

test('the script touches only `gh pr list`, `gh pr view` and `gh pr create`', () => {
  const script = scriptFixture();
  const ghCalls = [...script.matchAll(/\bgh\s+[a-z]+\s+[a-z]+/g)].map((m) => m[0].replace(/\s+/g, ' '));
  const allowed = new Set(['gh pr list', 'gh pr view', 'gh pr create']);
  for (const call of ghCalls) {
    assert.ok(allowed.has(call), `unexpected gh subcommand in the generated script: ${call}`);
  }
});

test('no secret-shaped material reaches the generated script', () => {
  const script = scriptFixture();
  for (const re of [/ghp_[A-Za-z0-9]/, /github_pat_/, /AKIA[0-9A-Z]{8}/, /-----BEGIN [A-Z ]*PRIVATE KEY/, /xox[baprs]-/]) {
    assert.equal(re.test(script), false, `secret-shaped material matched ${re}`);
  }
  // Nor does it read one from the environment or the AWS credentials file.
  assert.equal(/\$\{?(GH_TOKEN|GITHUB_TOKEN|AWS_SECRET_ACCESS_KEY|ANTHROPIC_API_KEY)/.test(script), false);
});

/* ================= SCRIPT GUARDS ================= */

test('the script refuses a non-interactive stdin, so the confirmation cannot be piped in', () => {
  const script = scriptFixture();
  assert.match(script, /\[ -t 0 \] \|\| die/);
});

test('the script refuses an expired gate and carries the exact expiry', () => {
  const script = scriptFixture();
  assert.ok(script.includes(`GATE_EXPIRES='${EXPIRES_AT}'`));
  assert.match(script, /the publish gate expired at \$GATE_EXPIRES/);
});

test('the script refuses an integration branch as source and requires main as target', () => {
  const script = scriptFixture();
  assert.match(script, /case "\$SOURCE_BRANCH" in\n\s*main\|master\) die/);
  assert.match(script, /\[ "\$TARGET_BRANCH" = "main" \] \|\| die/);
});

test('the script requires the exact HEAD and the exact ordered commit set', () => {
  const script = scriptFixture();
  assert.match(script, /\[ "\$head_sha" = "\$EXPECTED_HEAD" \] \|\| die/);
  assert.match(script, /the commit count changed since review/);
  assert.match(script, /differs from the reviewed set \(amend, rebase or reorder\)/);
});

test('the script checks branch, cleanliness and worktree exclusivity before anything else', () => {
  const script = scriptFixture();
  assert.match(script, /checked out branch is not the gated source branch/);
  assert.match(script, /the worktree has uncommitted changes/);
  assert.match(script, /checked out in more than one worktree/);
});

test('the script re-checks the LIVE remote base and refuses to discard remote commits', () => {
  const script = scriptFixture();
  // The base check must read the remote over the wire. A local remote-tracking ref is only as
  // fresh as the last fetch, so trusting it would let a moved main pass review silently.
  assert.match(script, /remote_base=\$\(git ls-remote origin "refs\/heads\/\$TARGET_BRANCH"/);
  assert.equal(
    /remote_base=\$\(git rev-parse/.test(script),
    false,
    'the live base must not come from a local remote-tracking ref',
  );
  assert.match(script, /origin\/\$TARGET_BRANCH moved since review/);
  assert.match(script, /remote_head=\$\(git ls-remote origin "refs\/heads\/\$SOURCE_BRANCH"/);
  assert.match(script, /git merge-base --is-ancestor "\$remote_head" "\$EXPECTED_HEAD"/);
  assert.match(script, /a force push is never performed/);
  // The only fetch is of the source branch's objects, needed to prove ancestry.
  const fetches = script.split('\n').filter((l) => /^\s*git fetch\b/.test(l));
  assert.equal(fetches.length, 1);
  assert.match(fetches[0], /refs\/heads\/\$SOURCE_BRANCH/);
});

test('the typed confirmation is bound to the issue and the reviewed head', () => {
  const script = scriptFixture();
  assert.ok(script.includes(`CONFIRMATION='publish 93 ${C2.slice(0, 12)}'`));
  assert.match(script, /\[ "\$typed" = "\$CONFIRMATION" \] \|\| die/);
  // A different head produces a different phrase, so a stale script cannot be confirmed by muscle
  // memory after the branch moved.
  const other = scriptFixture(
    gateFixture({ commits: [C1, OTHER], reviewedShas: [C1, OTHER] }),
    repoFixture({ commits: [C1, OTHER], headSha: OTHER }),
  );
  assert.ok(other.includes(`CONFIRMATION='publish 93 ${OTHER.slice(0, 12)}'`));
});

test('the confirmation is required BEFORE the push, not after', () => {
  const script = scriptFixture();
  assert.ok(script.indexOf('read -r typed') < script.indexOf('git push origin'));
});

test('the script reuses only a pull request whose base AND head match', () => {
  const script = scriptFixture();
  assert.match(script, /targets a different base; refusing to touch it/);
  assert.match(script, /has a different head; refusing to touch it/);
  const creates = [...script.matchAll(/gh pr create/g)];
  assert.equal(creates.length, 1);
});

/* ================= DRIFT REFUSALS PROPAGATE FROM STAGE A ================= */

test('a script is never built from a drifted gate', () => {
  const cases = [
    ['COMMIT_SET_DRIFT', gateFixture(), repoFixture({ commits: [C1, C2, OTHER] })],
    ['COMMIT_SET_DRIFT', gateFixture(), repoFixture({ commits: [C2, C1] })],
    ['BASE_DRIFT', gateFixture(), repoFixture({ baseSha: OTHER })],
    ['REMOTE_BASE_DRIFT', gateFixture(), repoFixture({ remoteBaseSha: OTHER })],
    ['BRANCH_MISMATCH', gateFixture(), repoFixture({ branch: 'task/93-something-else' })],
    ['HEAD_DRIFT', gateFixture(), repoFixture({ headSha: OTHER })],
    ['WORKTREE_DIRTY', gateFixture(), repoFixture({ clean: false })],
    [
      'WORKTREE_SHARED',
      gateFixture(),
      repoFixture({
        worktrees: [
          { path: '/w/93', branch: 'task/93-human-publication-script' },
          { path: '/w/other', branch: 'task/93-human-publication-script' },
        ],
      }),
    ],
    ['GATE_EXPIRED', gateFixture({ expiresAt: '2026-07-26T18:30:00Z' }), repoFixture()],
  ];
  for (const [code, gate, repo] of cases) {
    expectRefusal(code, () => validResult(gate, repo));
  }
  // The review-set equality is enforced when the manifest is parsed, before any repository state is
  // consulted at all, so it is exercised through parseGate.
  expectRefusal('REVIEW_SET_MISMATCH', () => parseGate(JSON.stringify(gateFixture({ reviewedShas: [C1] }))));
  expectRefusal('REVIEW_SET_MISMATCH', () => parseGate(JSON.stringify(gateFixture({ reviewedShas: [C2, C1] }))));
});

/* ================= THE GENERATOR CANNOT ACT ================= */

test('the generator source contains no network primitive and no Git or GitHub write verb', () => {
  const sources = [
    'src/lib/human-publish-script.js',
    'src/lib/repo-state.js',
    'src/commands/agent-human-publish-script.js',
  ].map((rel) => ({ rel, text: fs.readFileSync(path.join(ROOT, rel), 'utf8') }));

  // Comments and the script TEMPLATE legitimately name these operations — the template is the text
  // the human will run, and the docs explain what is forbidden. What must not exist is the
  // generator itself performing them, so executable JavaScript is checked separately from the
  // template literal and the comments.
  for (const { rel, text } of sources) {
    const code = text
      .replace(/`[\s\S]*?`/g, '``') // template literals, including the script body
      .replace(/^\s*(\/\/|\*|\/\*).*$/gm, '') // comment lines
      .replace(/'[^'\n]*'/g, "''"); // string literals (error messages name operations too)
    for (const re of [/\bfetch\s*\(/, /node:https?/, /node:net\b/, /XMLHttpRequest/, /axios/, /\bWebSocket\b/]) {
      assert.equal(re.test(code), false, `${rel} contains a network primitive matching ${re}`);
    }
    // repo-state.js is the one module allowed to spawn git, and only read verbs — proven by the
    // next test. Nothing else in this path may spawn a process at all.
    if (rel !== 'src/lib/repo-state.js') {
      for (const re of [/execSync\s*\(/, /\bspawn(Sync)?\s*\(/, /child_process/]) {
        assert.equal(re.test(code), false, `${rel} may not spawn a process (${re}) — repo-state owns git observation`);
      }
    }
  }
});

test('repo-state runs only read-only git verbs', () => {
  const text = fs.readFileSync(path.join(ROOT, 'src/lib/repo-state.js'), 'utf8');
  const verbs = [...text.matchAll(/runGit\(\s*\[\s*'([a-z-]+)'/g)].map((m) => m[1]);
  const tryVerbs = [...text.matchAll(/tryGit\(\s*runGit,\s*\[\s*'([a-z-]+)'/g)].map((m) => m[1]);
  const readOnly = new Set(['rev-parse', 'status', 'rev-list', 'merge-base', 'worktree', 'remote', 'log', 'show']);
  for (const verb of [...verbs, ...tryVerbs]) {
    assert.ok(readOnly.has(verb), `repo-state uses a non-read-only git verb: ${verb}`);
  }
  for (const write of ['push', 'commit', 'fetch', 'merge', 'rebase', 'reset', 'checkout', 'tag']) {
    assert.equal(new RegExp(`'${write}'`).test(text), false, `repo-state must not use git ${write}`);
  }
});

/* ================= THE COMMAND: ROLE, FILE MODE, SELF-CHECK ================= */

// `await` matters here: with a synchronous `finally` around an async callback the cleanup runs as
// soon as the promise is CREATED, deleting the artifact before a single assertion sees it.
async function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cba-93-'));
  try {
    return await fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * The command validates the output path against the real `/tmp` rule, so tests that exercise the
 * write path must use a real `/tmp` file. Each one uses a unique name and removes it afterwards.
 */
let tmpCounter = 0;
async function withTmpScriptPath(fn) {
  const p = `/tmp/cba-93-test-${process.pid}-${tmpCounter++}.sh`;
  try {
    return await fn(p);
  } finally {
    fs.rmSync(p, { force: true });
  }
}

function gateFileIn(dir, gate = gateFixture()) {
  const p = path.join(dir, 'gate.json');
  fs.writeFileSync(p, JSON.stringify(gate));
  return p;
}

function gitSeam(repo = repoFixture(), { remoteUrl = `https://github.com/${REPO}.git` } = {}) {
  return (args) => {
    const key = args.join(' ');
    if (key === 'rev-parse --abbrev-ref HEAD') return repo.branch;
    if (key === 'rev-parse HEAD') return repo.headSha;
    if (key === 'status --porcelain') return repo.clean ? '' : ' M file.js';
    if (key.startsWith('rev-list --reverse')) return repo.commits.join('\n');
    if (key.startsWith('merge-base')) return repo.baseSha;
    if (key === 'rev-parse refs/remotes/origin/main') return repo.remoteBaseSha;
    if (key === 'worktree list --porcelain') {
      return repo.worktrees.map((w) => `worktree ${w.path}\nbranch refs/heads/${w.branch}\n`).join('\n');
    }
    if (key === 'remote get-url origin') return remoteUrl;
    if (key === 'rev-parse --show-toplevel') return ROOT;
    throw new Error(`unexpected git command in test: ${key}`);
  };
}

test('a declared architect or reviewer cannot prepare a script, and nothing is written', async () => {
  for (const role of ['architect', 'reviewer', 'observer', undefined, '']) {
    const written = [];
    const { value, output } = await captureAsync(() =>
      runAgentHumanPublishScript({
        role,
        executor: 'claude-opus-5',
        gate: '/nonexistent/gate.json',
        deps: {
          fs: {
            readFileSync: () => assert.fail('the gate must not be read for a refused role'),
            writeFileSync: () => written.push('write'),
            lstatSync: () => assert.fail('the filesystem must not be observed for a refused role'),
          },
          runGit: () => assert.fail('git must not run for a refused role'),
          now: () => NOW,
          cwd: ROOT,
        },
      }),
    );
    assert.equal(value, EXIT.ROLE_REFUSED, `role ${String(role)} should be refused`);
    assert.equal(written.length, 0);
    assert.match(output, /no file was written/);
  }
});

test('the happy path writes one file, 0600, with no executable bit, and prints its sha256', async () => {
  await withTempDir(async (dir) => {
    await withTmpScriptPath(async (out) => {
      const gate = gateFileIn(dir);
      const { value, output } = await captureAsync(() =>
        runAgentHumanPublishScript({
          role: 'executor',
          executor: 'claude-opus-5',
          gate,
          out,
          deps: { runGit: gitSeam(), now: () => NOW, cwd: ROOT },
        }),
      );
      assert.equal(value, EXIT.OK);

      const mode = fs.statSync(out).mode & 0o777;
      assert.equal(mode, SCRIPT_MODE);
      assert.equal(mode, 0o600);
      assert.equal(mode & 0o111, 0, 'the script must not be executable by anyone');
      assert.equal(mode & 0o077, 0, 'the script must not be group- or world-readable');

      const written = fs.readFileSync(out, 'utf8');
      const digest = createHash('sha256').update(written, 'utf8').digest('hex');
      assert.ok(output.includes(digest), 'the printed sha256 must match the bytes on disk');
      assert.ok(output.includes(out));
      assert.match(output, /PREPARED — not executed/);
      assert.match(output, /bash /);
      assert.match(output, /declared, not authenticated/);
    });
  });
});

test('the command refuses to overwrite an existing artifact', async () => {
  await withTempDir(async (dir) => {
    await withTmpScriptPath(async (out) => {
      fs.writeFileSync(out, '# a previous artifact\n', { mode: 0o600 });
      const before = fs.readFileSync(out, 'utf8');
      const gate = gateFileIn(dir);
      const { value, output } = await captureAsync(() =>
        runAgentHumanPublishScript({
          role: 'executor',
          executor: 'claude-opus-5',
          gate,
          out,
          deps: { runGit: gitSeam(), now: () => NOW, cwd: ROOT },
        }),
      );
      assert.equal(value, EXIT.VALIDATION_FAILED);
      assert.match(output, /OUTPUT_PATH_EXISTS/);
      assert.equal(fs.readFileSync(out, 'utf8'), before, 'the existing file must be untouched');
    });
  });
});

test('the command refuses a symlinked output path without following it', async () => {
  await withTempDir(async (dir) => {
    await withTmpScriptPath(async (out) => {
      const target = path.join(dir, 'target.txt');
      fs.writeFileSync(target, 'original\n');
      fs.symlinkSync(target, out);
      const gate = gateFileIn(dir);
      const { value, output } = await captureAsync(() =>
        runAgentHumanPublishScript({
          role: 'executor',
          executor: 'claude-opus-5',
          gate,
          out,
          deps: { runGit: gitSeam(), now: () => NOW, cwd: ROOT },
        }),
      );
      assert.equal(value, EXIT.VALIDATION_FAILED);
      assert.match(output, /OUTPUT_PATH_SYMLINK/);
      assert.equal(fs.readFileSync(target, 'utf8'), 'original\n', 'the symlink target must be untouched');
    });
  });
});

test('the command refuses an output path inside the repository', async () => {
  await withTempDir(async (dir) => {
    const gate = gateFileIn(dir);
    const { value, output } = await captureAsync(() =>
      runAgentHumanPublishScript({
        role: 'executor',
        executor: 'claude-opus-5',
        gate,
        out: `${ROOT}/publish.sh`,
        deps: { runGit: gitSeam(), now: () => NOW, cwd: ROOT },
      }),
    );
    assert.equal(value, EXIT.VALIDATION_FAILED);
    assert.match(output, /OUTPUT_PATH_OUTSIDE_TMP/);
    assert.equal(fs.existsSync(`${ROOT}/publish.sh`), false);
  });
});

test('drift between the gate and the repository refuses before any file is written', async () => {
  await withTempDir(async (dir) => {
    await withTmpScriptPath(async (out) => {
      const gate = gateFileIn(dir);
      const { value, output } = await captureAsync(() =>
        runAgentHumanPublishScript({
          role: 'executor',
          executor: 'claude-opus-5',
          gate,
          out,
          deps: { runGit: gitSeam(repoFixture({ commits: [C1, C2, OTHER] })), now: () => NOW, cwd: ROOT },
        }),
      );
      assert.equal(value, EXIT.VALIDATION_FAILED);
      assert.match(output, /COMMIT_SET_DRIFT/);
      assert.equal(fs.existsSync(out), false, 'no artifact may exist after a refusal');
    });
  });
});

test('an executor that does not match the gate is refused', async () => {
  await withTempDir(async (dir) => {
    await withTmpScriptPath(async (out) => {
      const gate = gateFileIn(dir);
      const { value, output } = await captureAsync(() =>
        runAgentHumanPublishScript({
          role: 'executor',
          executor: 'some-other-agent',
          gate,
          out,
          deps: { runGit: gitSeam(), now: () => NOW, cwd: ROOT },
        }),
      );
      assert.equal(value, EXIT.VALIDATION_FAILED);
      assert.match(output, /EXECUTOR_MISMATCH/);
      assert.equal(fs.existsSync(out), false);
    });
  });
});

test('a gate is required; a missing one refuses without touching git', async () => {
  const { value, output } = await captureAsync(() =>
    runAgentHumanPublishScript({
      role: 'executor',
      executor: 'claude-opus-5',
      deps: { runGit: () => assert.fail('git must not run without a gate'), now: () => NOW, cwd: ROOT },
    }),
  );
  assert.equal(value, EXIT.VALIDATION_FAILED);
  assert.match(output, /GATE_MISSING/);
});

test('a remote URL carrying a credential refuses slug derivation instead of leaking it', async () => {
  await withTempDir(async (dir) => {
    await withTmpScriptPath(async (out) => {
      const gate = gateFileIn(dir);
      const { value, output } = await captureAsync(() =>
        runAgentHumanPublishScript({
          role: 'executor',
          executor: 'claude-opus-5',
          gate,
          out,
          deps: {
            runGit: gitSeam(repoFixture(), { remoteUrl: `https://u:ghp_EXAMPLETOKEN@github.com/${REPO}.git` }),
            now: () => NOW,
            cwd: ROOT,
          },
        }),
      );
      assert.equal(value, EXIT.VALIDATION_FAILED);
      // Derivation returns null rather than parsing the credential out, so the repository can never
      // be bound to the push target and the command stops.
      assert.match(output, /ORIGIN_UNRESOLVED/);
      assert.equal(/ghp_EXAMPLETOKEN/.test(output), false, 'the credential must never be echoed');
      assert.equal(fs.existsSync(out), false);
    });
  });
});

/* ================= THE GENERATED SCRIPT IS VALID BASH ================= */

test('the generated script parses as bash without executing it', async () => {
  const script = scriptFixture();
  // `bash -n` parses and reports syntax errors WITHOUT running anything — the only safe way to
  // check a script whose whole purpose is to push.
  await withTempDir((dir) => {
    const p = path.join(dir, 'candidate.sh');
    fs.writeFileSync(p, script, { mode: 0o600 });
    execFileSync('bash', ['-n', p], { stdio: ['ignore', 'pipe', 'pipe'] });
  });
});

/* ================= DOCUMENTS, RULES AND SKILLS AGREE ================= */

const docText = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

test('every document names the same three verbs and the same three actors', () => {
  const files = [
    'AGENTS.md',
    '.agent-handoff/README.md',
    '.agent-handoff/COMMANDS.md',
    'spec/security-rules.md',
    'docs/architecture/agent-publication-runbook.md',
    '.claude/skills/publication-prepare/SKILL.md',
    '.agents/skills/publication-review/SKILL.md',
  ];
  for (const rel of files) {
    const text = docText(rel);
    assert.match(text, /agent-human-publish-script/, `${rel} must name the generator command`);
    assert.match(text, /executor/i, `${rel} must name the executor role`);
    assert.match(text, /reviewer/i, `${rel} must name the reviewer role`);
    assert.match(text, /human/i, `${rel} must name the human operator`);
  }
});

test('no document claims an agent publishes, or that this is authenticated separation', () => {
  const files = [
    'AGENTS.md',
    '.agent-handoff/README.md',
    'spec/security-rules.md',
    'docs/architecture/agent-publication-runbook.md',
    '.claude/skills/publication-prepare/SKILL.md',
    '.agents/skills/publication-review/SKILL.md',
  ];
  const CLAIM = /\b(authenticated|mechanical)\s+(role|identity)\s+separation\b/;
  const NEGATED = /\b(not|never|no|without|does not|neither)\b/i;
  for (const rel of files) {
    // The honesty requirement from #91: the phrase may appear only inside a denial. Checking the
    // sentence rather than the whole file means a future edit that drops the "not" fails here.
    for (const sentence of docText(rel).split(/(?<=[.;:])\s+/)) {
      if (!CLAIM.test(sentence)) continue;
      assert.ok(
        NEGATED.test(sentence),
        `${rel} claims authenticated/mechanical role separation without denying it: ${sentence.trim()}`,
      );
    }
  }
  // And the runbook must state the residual gap explicitly.
  const runbook = docText('docs/architecture/agent-publication-runbook.md');
  assert.match(runbook, /enforce_admins.{0,40}false/s);
  assert.match(runbook, /process\s+guardrail/);
});

test('the executor skill forbids running, and the reviewer skill forbids preparing and running', () => {
  const prepare = docText('.claude/skills/publication-prepare/SKILL.md');
  assert.match(prepare, /never publish|never run/i);
  assert.match(prepare, /agent-human-publish-script/);
  assert.match(prepare, /bash <path>/);
  assert.equal(/\bgit push\b/.test(prepare.replace(/never push[^.]*/gi, '')), false);

  const review = docText('.agents/skills/publication-review/SKILL.md');
  assert.match(review, /never prepare and you never run/i);
  assert.match(review, /sha256sum/);
  assert.match(review, /-rw-------/);
  assert.match(review, /read-only/i);
});

test('the security rules record who may prepare, read and run, and that merge stays human', () => {
  const rules = docText('spec/security-rules.md');
  assert.match(rules, /No AI agent publishes source,\s+in any role/);
  assert.match(rules, /agent-human-publish-script/);
  assert.match(rules, /0600/);
  assert.match(rules, /non-executable/);
  assert.match(rules, /Merge remains a\s+separate human action/);
  assert.match(rules, /fix-forward/);
});

test('agent-publish is still validation-only and gained no publish path', () => {
  const text = docText('src/commands/agent-publish.js');
  for (const re of [/git push/, /gh pr/, /\bfetch\s*\(/, /child_process/]) {
    assert.equal(re.test(text.replace(/^\s*(\/\/|\*).*$/gm, '')), false, `agent-publish must not contain ${re}`);
  }
  assert.match(text, /LOCAL PRE-FLIGHT VALIDATION ONLY/);
});

/* ================= THE REAL CLI ENTRYPOINT ================= */

const CLI = path.join(ROOT, 'bin/cli.js');

function runCli(argv, env = {}) {
  try {
    const stdout = execFileSync(process.execPath, [CLI, ...argv], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...env },
    });
    return { status: 0, stdout, stderr: '' };
  } catch (err) {
    return { status: err.status, stdout: String(err.stdout ?? ''), stderr: String(err.stderr ?? '') };
  }
}

test('the REAL CLI refuses a forbidden role before .env, the gate, git or any write', () => {
  // Both argument syntaxes, and with CBA_AGENT_ROLE=executor set, to prove the explicit argument
  // wins and an environment value cannot smuggle a forbidden role past the check.
  const variants = [
    ['--role', 'architect'],
    ['--role=architect'],
    ['--role', 'reviewer'],
    ['--role=reviewer'],
  ];
  for (const roleArgs of variants) {
    const { status, stderr } = runCli(
      ['agent-human-publish-script', ...roleArgs, '--executor', 'x', '--gate', '/nonexistent', '--out', '/tmp/never-written.sh'],
      { CBA_AGENT_ROLE: 'executor' },
    );
    assert.equal(status, 2, `${roleArgs.join(' ')} must exit 2 from the real entrypoint`);
    assert.match(stderr, /ROLE_FORBIDDEN/);
    assert.match(stderr, /no file was written/);
    assert.equal(fs.existsSync('/tmp/never-written.sh'), false);
  }
});

test('the REAL CLI refuses `--role` with no value instead of falling back to the environment', () => {
  const { status, stderr } = runCli(
    ['agent-human-publish-script', '--role', '--executor', 'codex', '--gate', '/does-not-exist'],
    { CBA_AGENT_ROLE: 'executor' },
  );
  assert.equal(status, 2);
  assert.match(stderr, /ROLE_(UNKNOWN|MISSING|FORBIDDEN)/);
});

test('the REAL CLI does not echo a credential-shaped role value back to the terminal', () => {
  const TOKEN = 'ghp_EXAMPLEONLY0123456789abcdefghijklmn';
  const { status, stderr, stdout } = runCli([
    'agent-human-publish-script', '--role', TOKEN, '--executor', 'codex', '--gate', '/does-not-exist',
  ]);
  assert.equal(status, 2);
  assert.equal(stderr.includes(TOKEN), false, 'the refused value must never be echoed');
  assert.equal(stdout.includes(TOKEN), false);
});

test('the CLI help documents the command as preparation, not publication', () => {
  const { status, stdout } = runCli(['help']);
  assert.equal(status, 0);
  assert.match(stdout, /agent-human-publish-script/);
  assert.match(stdout, /never executed here|HUMAN to run/i);
});

/* ================= #93 round 2: repository binding, gate location, source hygiene ================= */

test('the repository is derived from origin, and a diverging --repo is refused', async () => {
  await withTempDir(async (dir) => {
    await withTmpScriptPath(async (out) => {
      const gate = gateFileIn(dir);
      const base = {
        role: 'executor',
        executor: 'claude-opus-5',
        gate,
        out,
        deps: { runGit: gitSeam(), now: () => NOW, cwd: ROOT },
      };
      // The push goes to origin; every gh query goes to $REPO. If they name different repositories
      // the branch lands in one place while the pull request is inspected in another.
      const diverging = await captureAsync(() =>
        runAgentHumanPublishScript({ ...base, repo: 'someone-else/backstage-cba-prep' }),
      );
      assert.equal(diverging.value, EXIT.VALIDATION_FAILED);
      assert.match(diverging.output, /REPO_ORIGIN_MISMATCH/);
      assert.equal(fs.existsSync(out), false);

      // A --repo that agrees with origin is accepted, because it is only a confirmation.
      const agreeing = await captureAsync(() => runAgentHumanPublishScript({ ...base, repo: REPO }));
      assert.equal(agreeing.value, EXIT.OK);
      assert.match(fs.readFileSync(out, 'utf8'), new RegExp(`REPO='${REPO}'`));
    });
  });
});

test('an unresolvable origin refuses rather than falling back to a caller-supplied repository', async () => {
  await withTempDir(async (dir) => {
    await withTmpScriptPath(async (out) => {
      const gate = gateFileIn(dir);
      const { value, output } = await captureAsync(() =>
        runAgentHumanPublishScript({
          role: 'executor',
          executor: 'claude-opus-5',
          gate,
          out,
          repo: REPO,
          deps: {
            runGit: gitSeam(repoFixture(), { remoteUrl: 'https://gitlab.example.com/o/r.git' }),
            now: () => NOW,
            cwd: ROOT,
          },
        }),
      );
      assert.equal(value, EXIT.VALIDATION_FAILED);
      assert.match(output, /ORIGIN_UNRESOLVED/);
      assert.equal(fs.existsSync(out), false);
    });
  });
});

test('a gate inside the repository worktree is refused, because the protocol would be unexecutable', async () => {
  await withTmpScriptPath(async (out) => {
    // `.agent-handoff/publish-gates/` is tracked and not ignored: a gate written there is an
    // untracked file, which makes the worktree dirty, which this command then refuses. The rule is
    // mechanical so the documents cannot drift back into an impossible protocol.
    for (const rel of ['.agent-handoff/publish-gates/gate.json', 'gate.json', 'src/gate.json']) {
      const { value, output } = await captureAsync(() =>
        runAgentHumanPublishScript({
          role: 'executor',
          executor: 'claude-opus-5',
          gate: path.join(ROOT, rel),
          out,
          deps: { runGit: gitSeam(), now: () => NOW, cwd: ROOT },
        }),
      );
      assert.equal(value, EXIT.VALIDATION_FAILED, rel);
      assert.match(output, /GATE_PATH_IN_REPO/);
      assert.equal(fs.existsSync(out), false);
    }
  });
});

test('a failed gate read never echoes the caller-supplied path or a raw error', async () => {
  await withTmpScriptPath(async (out) => {
    const secretish = '/tmp/cba-93-absent-ghp_EXAMPLEONLY0123456789.json';
    const { value, output } = await captureAsync(() =>
      runAgentHumanPublishScript({
        role: 'executor',
        executor: 'claude-opus-5',
        gate: secretish,
        out,
        deps: { runGit: gitSeam(), now: () => NOW, cwd: ROOT },
      }),
    );
    assert.equal(value, EXIT.VALIDATION_FAILED);
    assert.equal(output.includes(secretish), false, 'the gate path must never be echoed');
    assert.equal(/ghp_EXAMPLEONLY/.test(output), false);
    assert.equal(/ENOENT|no such file/i.test(output), false, 'no raw filesystem error may be printed');
  });
});

test('the script binds the push target to the API target at run time', () => {
  const script = scriptFixture();
  assert.match(script, /origin_url=\$\(git remote get-url origin\)/);
  assert.match(script, /the origin remote does not match the repository this script was generated for/);
  // The binding must be checked before either external effect.
  assert.ok(script.indexOf('origin_url=') < script.indexOf('git push origin'));
  assert.ok(script.indexOf('origin_url=') < script.indexOf('gh pr create'));
});

test('the pull-request set is asserted BEFORE the push, and re-asserted after it', () => {
  const script = scriptFixture();
  const before = script.indexOf('pr_count_before=$(assert_pr_set');
  const push = script.indexOf('git push origin');
  const after = script.indexOf('pr_count_after=$(assert_pr_set');
  assert.ok(before > -1 && push > -1 && after > -1);
  assert.ok(before < push, 'the pull-request set must be checked before anything is published');
  assert.ok(push < after, 'and re-checked against the state that exists after the push');
});

test('a fork or ambiguous pull request is refused rather than reused', () => {
  const script = scriptFixture();
  // `gh pr list --head` matches by branch NAME and spans forks, so identity has to be proven.
  assert.match(script, /open pull requests share this head branch; refusing to guess/);
  assert.match(script, /isCrossRepository/);
  assert.match(script, /comes from a fork; refusing to touch it/);
  assert.match(script, /headRepositoryOwner/);
  assert.match(script, /headed from another owner; refusing to touch it/);
  assert.match(script, /targets a different base; refusing to touch it/);
  assert.match(script, /has a different head; refusing to touch it/);
  // And it never opens a second pull request when one existed before the push but vanished.
  assert.match(script, /stopping rather than opening a second one/);
});

test('the script documents two bounded external effects, not one mutation', () => {
  const script = scriptFixture();
  assert.match(script, /exactly two bounded external effects/);
  assert.match(script, /FIRST external effect/);
  assert.match(script, /SECOND external effect/);
});

test('no source file in this repository is stored as binary', () => {
  // A single NUL byte makes Git treat a file as binary: the diff collapses to "Bin 0 -> N bytes"
  // and the whole file becomes invisible to review, on the command line and on GitHub. For a
  // security test suite that is a supply-chain problem — a reviewer cannot approve what they
  // cannot read.
  //
  // The scan is INVERTED on purpose: every tracked file is checked except a short list of formats
  // that are binary by nature. An allowlist of source extensions is what let this slip the first
  // time — it silently skipped HTML, CSS, TypeScript and Python.
  const BINARY_BY_NATURE =
    /\.(png|jpe?g|gif|webp|avif|ico|icns|bmp|tiff?|svgz|pdf|zip|gz|tgz|bz2|xz|7z|rar|woff2?|ttf|otf|eot|mp[34]|m4a|wav|ogg|webm|mov|avi|wasm|so|dylib|dll|exe|bin|class|jar|node|pyc|db|sqlite3?|keystore|jks|p12|pfx|der)$/i;

  const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' })
    .split('\0')
    .filter(Boolean)
    .filter((f) => !BINARY_BY_NATURE.test(f));
  assert.ok(tracked.length > 100, 'the file list should be substantial; a broken listing would pass vacuously');
  // Proof the scan reaches beyond this issue's own directories.
  for (const ext of ['.ts', '.html', '.css', '.py']) {
    const found = tracked.some((f) => f.endsWith(ext));
    if (found) continue;
    // Not every extension has to exist, but if the repository has one it must be in scope.
    const existsAnywhere = execFileSync('git', ['ls-files', `*${ext}`], { cwd: ROOT, encoding: 'utf8' }).trim();
    assert.equal(existsAnywhere, '', `${ext} files exist but were excluded from the scan`);
  }

  // Pre-existing debt, deliberately listed rather than hidden by narrowing the scan. This file was
  // merged to main under #82 and is owned by another track, so it is reported, not silently fixed.
  const KNOWN_PRE_EXISTING = new Set(['services/bff/test/telemetry.test.js']);

  const offenders = tracked.filter((f) => {
    const full = path.join(ROOT, f);
    return fs.existsSync(full) && fs.readFileSync(full).includes(0);
  });
  const unexpected = offenders.filter((f) => !KNOWN_PRE_EXISTING.has(f));
  assert.deepEqual(unexpected, [], `source files containing a NUL byte are unreviewable: ${unexpected.join(', ')}`);

  // And the exception must not outlive the problem: once #82's file is fixed, this fails and the
  // entry has to be removed.
  for (const known of KNOWN_PRE_EXISTING) {
    assert.ok(
      offenders.includes(known),
      `${known} no longer contains a NUL byte — remove it from KNOWN_PRE_EXISTING`,
    );
  }
});

test('.gitattributes forces textual diffs for every non-binary tracked extension', () => {
  // The guard above proves no NUL exists today. This proves that if one appears, the diff stays
  // readable anyway — the two together are what keeps a file reviewable.
  const attrs = fs.readFileSync(path.join(ROOT, '.gitattributes'), 'utf8');
  const BINARY_BY_NATURE = /^(png|jpe?g|gif|webp|avif|ico|icns|bmp|tiff?|svgz|pdf|zip|gz|tgz|bz2|xz|7z|rar|woff2?|ttf|otf|eot|mp[34]|m4a|wav|ogg|webm|mov|avi|wasm|so|dylib|dll|exe|bin|class|jar|node|pyc|db|sqlite3?|keystore|jks|p12|pfx|der)$/i;
  const extensions = new Set(
    execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' })
      .split('\0')
      .filter(Boolean)
      .map((f) => path.extname(f).slice(1))
      .filter((e) => e && !BINARY_BY_NATURE.test(e)),
  );
  const missing = [...extensions].filter((e) => !new RegExp(`^\\*\\.${e}\\s`, 'm').test(attrs));
  assert.deepEqual(missing, [], `.gitattributes does not force textual diffs for: ${missing.join(', ')}`);
});

/* ================= END-TO-END: the DOCUMENTED protocol must actually produce a script ========= */

/** Builds a throwaway repository with a base commit and a task branch. No network is ever used. */
function seedRepo(dir, { commits = 2 } = {}) {
  const repoDir = path.join(dir, 'repo');
  fs.mkdirSync(repoDir);
  const git = (...args) =>
    execFileSync('git', ['-C', repoDir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.invalid');
  git('config', 'user.name', 'Test');
  git('config', 'commit.gpgsign', 'false');
  // The remote URL is only ever parsed, never contacted.
  git('remote', 'add', 'origin', `https://github.com/${REPO}.git`);

  fs.writeFileSync(path.join(repoDir, 'README.md'), '# base\n');
  git('add', '.');
  git('commit', '-q', '-m', 'base');
  const baseSha = git('rev-parse', 'HEAD');

  git('checkout', '-q', '-b', 'task/93-human-publication-script');
  const shas = [];
  for (let n = 1; n <= commits; n++) {
    fs.writeFileSync(path.join(repoDir, `change-${n}.txt`), `change ${n}\n`);
    git('add', '.');
    git('commit', '-q', '-m', `change ${n}`);
    shas.push(git('rev-parse', 'HEAD'));
  }
  return { repoDir, git, baseSha, commits: shas };
}

test('E2E: following the documented protocol literally produces a script', async () => {
  // This test exists because the protocol was, at one point, impossible to follow: the gate was
  // documented to live in `.agent-handoff/publish-gates/`, which is tracked and not ignored, so
  // writing it there dirtied the worktree that the very same command refuses. A prose fix would
  // have drifted again; this walks the real steps in a real repository instead.
  await withTempDir(async (dir) => {
    const { repoDir, git, baseSha, commits } = seedRepo(dir);

    // The gate is authored OUTSIDE the repository, which is the documented channel.
    const gatePath = path.join(dir, 'gate.json');
    const stamp = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
    fs.writeFileSync(
      gatePath,
      JSON.stringify({
        gateId: 'gate-93-e2e',
        issue: 93,
        executor: 'claude-opus-5',
        baseSha,
        commits,
        sourceBranch: 'task/93-human-publication-script',
        targetBranch: 'main',
        approver: 'marciozampiron',
        approvedAt: stamp(NOW),
        expiresAt: stamp(NOW + 4 * 3600 * 1000),
        reviewedShas: commits,
      }),
    );

    // The worktree is clean at this point precisely BECAUSE the gate is not inside it.
    assert.equal(git('status', '--porcelain'), '', 'the documented protocol must leave the worktree clean');

    await withTmpScriptPath(async (out) => {
      const { value, output } = await captureAsync(() =>
        runAgentHumanPublishScript({
          role: 'executor',
          executor: 'claude-opus-5',
          gate: gatePath,
          out,
          deps: { now: () => NOW + 60_000, cwd: repoDir },
        }),
      );
      assert.equal(value, EXIT.OK, `the protocol must produce a script, got: ${output}`);

      const script = fs.readFileSync(out, 'utf8');
      assert.ok(script.includes(`EXPECTED_HEAD='${commits[commits.length - 1]}'`));
      assert.ok(script.includes(`BASE_SHA='${baseSha}'`));
      assert.ok(script.includes(`REPO='${REPO}'`));
      for (const sha of commits) assert.ok(script.includes(`'${sha}'`));
      for (const { label, re } of FORBIDDEN_SCRIPT_PATTERNS) {
        assert.equal(re.test(script), false, `E2E script contains a forbidden operation: ${label}`);
      }

      // Parsed, never run.
      const candidate = path.join(dir, 'candidate.sh');
      fs.writeFileSync(candidate, script, { mode: 0o600 });
      execFileSync('bash', ['-n', candidate], { stdio: ['ignore', 'pipe', 'pipe'] });

      // Nothing was published, and preparing did not disturb the worktree.
      assert.equal(git('rev-parse', '--abbrev-ref', 'HEAD'), 'task/93-human-publication-script');
      assert.equal(git('status', '--porcelain'), '', 'preparing a script must not touch the worktree');
    });
  });
});

test('E2E: a gate written into .agent-handoff/publish-gates/ dirties the worktree and is refused', async () => {
  await withTempDir(async (dir) => {
    const { repoDir, git } = seedRepo(dir, { commits: 1 });

    const gateDir = path.join(repoDir, '.agent-handoff', 'publish-gates');
    fs.mkdirSync(gateDir, { recursive: true });
    const gatePath = path.join(gateDir, 'gate.json');
    fs.writeFileSync(gatePath, '{}');

    // Demonstrates the contradiction the mechanical check now prevents: the file is untracked, so
    // the worktree is dirty and the clean requirement can never be met.
    assert.notEqual(git('status', '--porcelain'), '', 'a gate inside the repo makes the worktree dirty');

    await withTmpScriptPath(async (out) => {
      const { value, output } = await captureAsync(() =>
        runAgentHumanPublishScript({
          role: 'executor',
          executor: 'claude-opus-5',
          gate: gatePath,
          out,
          deps: { now: () => NOW, cwd: repoDir },
        }),
      );
      assert.equal(value, EXIT.VALIDATION_FAILED);
      assert.match(output, /GATE_PATH_IN_REPO/);
      assert.equal(fs.existsSync(out), false);
    });
  });
});

/* ================= #93 round 3: the artifact cannot be swapped after review ==================== */

test('the generated script ends with exactly one newline', () => {
  // The verify-and-run command captures the file with `$(cat ...)`, which strips trailing newlines,
  // and rehydrates it with `printf '%s\n'`. That only reproduces the file byte-for-byte if there is
  // exactly one trailing newline. The whole integrity guarantee rests on this.
  const script = scriptFixture();
  assert.ok(script.endsWith('\n'));
  assert.equal(script.endsWith('\n\n'), false, 'a second trailing newline would break the digest check');
});

test('the verify-and-run command reads once, hashes those bytes, and never reopens the path', () => {
  const cmd = verifyAndRunCommand('/tmp/x.sh', 'a'.repeat(64));
  // Exactly one read of the path.
  assert.equal((cmd.match(/\/tmp\/x\.sh/g) ?? []).length, 1, 'the path must appear exactly once');
  assert.match(cmd, /^\(\n\s+s=\$\(cat '\/tmp\/x\.sh'\)/);
  // The hash is computed over the captured variable, not over the file.
  assert.match(cmd, /printf '%s\\n' "\$s" \| sha256sum/);
  // The execution is of the captured variable, not of the path.
  assert.match(cmd, /bash -c "\$s"/);
  assert.equal(/bash\s+['"]?\/tmp\/x\.sh/.test(cmd), false, 'it must never run the path directly');
});

test('SUBSTITUTION ATTACK: replacing the file after review is refused and never executed', async () => {
  // The threat is concrete: the reviewer hashes the file, and anything running as the same user
  // replaces it before the human runs it. With `bash <path>` the human would execute the attacker's
  // commands under their own git/gh credentials. This proves the verify-and-run command does not.
  await withTempDir(async (dir) => {
    const target = path.join(dir, 'artifact.sh');
    const marker = path.join(dir, 'PWNED');

    // A benign stand-in for the real script: it only proves whether execution happened.
    const reviewed = "echo 'the reviewed script ran'\n";
    fs.writeFileSync(target, reviewed, { mode: 0o600 });
    const digest = createHash('sha256').update(reviewed, 'utf8').digest('hex');
    const cmd = verifyAndRunCommand(target, digest);

    // Control: unmodified, it runs and succeeds.
    const ok = spawnSync('bash', ['-c', cmd], { encoding: 'utf8' });
    assert.equal(ok.status, 0);
    assert.match(ok.stdout, /the reviewed script ran/);

    // Now the swap. The payload would create a marker file if it ever executed.
    fs.writeFileSync(target, `touch ${JSON.stringify(marker)}\necho 'attacker payload ran'\n`, { mode: 0o600 });
    const swapped = spawnSync('bash', ['-c', cmd], { encoding: 'utf8' });
    assert.match(swapped.stderr, /REFUSED: the script changed after review/);
    assert.equal(swapped.status, 1, 'a refusal must be detectable by exit status, not only by a message');
    assert.equal(/attacker payload ran/.test(swapped.stdout), false, 'the substituted script must not execute');
    assert.equal(fs.existsSync(marker), false, 'the substituted script must have no side effect');
  });
});

test('the prepared-script output tells the human to verify-and-run, not to `bash <path>`', async () => {
  await withTempDir(async (dir) => {
    await withTmpScriptPath(async (out) => {
      const gate = gateFileIn(dir);
      const { value, output } = await captureAsync(() =>
        runAgentHumanPublishScript({
          role: 'executor',
          executor: 'claude-opus-5',
          gate,
          out,
          deps: { runGit: gitSeam(), now: () => NOW, cwd: ROOT },
        }),
      );
      assert.equal(value, EXIT.OK);
      const digest = createHash('sha256').update(fs.readFileSync(out, 'utf8'), 'utf8').digest('hex');
      assert.ok(output.includes(verifyAndRunCommand(out, digest)), 'the exact verify-and-run command must be printed');
      assert.match(output, /Do not run it with a bare/);
      // And the digest it embeds must be the digest of the bytes on disk.
      assert.ok(output.includes(digest));
    });
  });
});

/* ================= #93 round 3: stale state during the confirmation ========================== */

test('every volatile check runs again after the confirmation and before the push', () => {
  const script = scriptFixture();
  const confirm = script.indexOf('read -r typed');
  const push = script.indexOf('git push origin');
  assert.ok(confirm > -1 && push > -1 && confirm < push);

  const between = script.slice(confirm, push);
  // Expiry, the origin binding, the live remote and the pull-request set can all change while a
  // terminal sits at the prompt, so each is re-asserted with nothing between it and the push.
  for (const call of ['check_gate_expiry', 'check_origin_binding', 'check_remote_state', 'assert_pr_set']) {
    assert.ok(between.includes(call), `${call} must run again after the confirmation`);
  }
  assert.match(between, /HEAD changed while awaiting confirmation/);
  assert.match(between, /the worktree changed while awaiting confirmation/);
  assert.match(between, /the pull-request set changed while awaiting confirmation/);

  // Each volatile check is defined once and called twice — not duplicated, which would let the two
  // copies drift apart.
  for (const fn of ['check_gate_expiry', 'check_origin_binding', 'check_remote_state']) {
    assert.equal((script.match(new RegExp(`^${fn}\\(\\) \\{`, 'gm')) ?? []).length, 1, `${fn} must be defined once`);
    assert.ok((script.match(new RegExp(`^\\s*${fn}$`, 'gm')) ?? []).length >= 2, `${fn} must be called at least twice`);
  }
});

/* ================= #93 round 3: the gate path cannot be smuggled in via a symlink ============= */

test('a symlinked gate path is refused instead of followed', async () => {
  await withTempDir(async (dir) => {
    await withTmpScriptPath(async (out) => {
      // The lexical check alone is bypassed by a link that looks external but reads from inside the
      // repository. `realpathSync` plus an outright symlink refusal closes it.
      const link = path.join(dir, 'gate.json');
      fs.symlinkSync(path.join(ROOT, '.agent-handoff', 'publish-gates', 'example.gate.json'), link);
      const { value, output } = await captureAsync(() =>
        runAgentHumanPublishScript({
          role: 'executor',
          executor: 'claude-opus-5',
          gate: link,
          out,
          deps: { runGit: gitSeam(), now: () => NOW, cwd: ROOT },
        }),
      );
      assert.equal(value, EXIT.VALIDATION_FAILED);
      assert.match(output, /GATE_PATH_SYMLINK/);
      assert.equal(fs.existsSync(out), false);
    });
  });
});

test('E2E: a gate reached through a symlink into the worktree is refused', async () => {
  await withTempDir(async (dir) => {
    const { repoDir } = seedRepo(dir, { commits: 1 });
    const inside = path.join(repoDir, 'gate.json');
    fs.writeFileSync(inside, '{}');
    const link = path.join(dir, 'outside-looking-gate.json');
    fs.symlinkSync(inside, link);

    await withTmpScriptPath(async (out) => {
      const { value, output } = await captureAsync(() =>
        runAgentHumanPublishScript({
          role: 'executor',
          executor: 'claude-opus-5',
          gate: link,
          out,
          deps: { now: () => NOW, cwd: repoDir },
        }),
      );
      assert.equal(value, EXIT.VALIDATION_FAILED);
      assert.match(output, /GATE_PATH_SYMLINK|GATE_PATH_IN_REPO/);
      assert.equal(fs.existsSync(out), false);
    });
  });
});

test('the script claims no other REMOTE mutation, and admits the local fetch', () => {
  const script = scriptFixture();
  assert.match(script, /NO OTHER REMOTE MUTATION/);
  // `git fetch` writes local objects and FETCH_HEAD, so "everything else is a read" was inaccurate.
  assert.match(script, /writes to the local object store and FETCH_HEAD/);
});
