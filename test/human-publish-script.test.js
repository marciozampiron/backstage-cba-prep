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
  assertApproverIsNotOperator,
  CANONICAL_APPROVER,
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

/**
 * A script whose REVIEW-SCOPE window is live against the real clock.
 *
 * `scriptFixture()` pins a 2026-07-26 expiry, which is correct for asserting on text but useless for
 * running the artifact: `check_gate_expiry` calls the real `date`, so once wall-clock passes that
 * instant every execution test starts failing for a reason unrelated to what it tests. Runtime tests
 * therefore build against now.
 */
function runnableScript(gateOver = {}, repoOver = {}) {
  const now = Date.now();
  const stamp = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const gate = gateFixture({ approvedAt: stamp(now - 60_000), expiresAt: stamp(now + 4 * 3600_000), ...gateOver });
  const repo = repoFixture(repoOver);
  return buildPublicationScript({
    result: validateGate({ gate, role: 'executor', executor: 'claude-opus-5', repo, nowMs: now }),
    repo: REPO,
    generatedAt: stamp(now),
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

test('ROUND #117-2: the GENERATED script for the exact #117 branch passes its own self-check', () => {
  // The defect's reproduction, inverted into a control: generate a full script whose gate names
  // the exact branch that tripped the old bare-word pattern, and prove every forbidden-operation
  // pattern — the narrowed paid-invocation detector included — accepts the result.
  const gate = gateFixture();
  gate.issue = 117;
  gate.sourceBranch = 'task/117-bedrock-model-tier-migration';
  const repo = repoFixture({
    branch: 'task/117-bedrock-model-tier-migration',
    worktrees: [{ path: '/w/117', branch: 'task/117-bedrock-model-tier-migration' }],
  });
  const script = scriptFixture(gate, repo);
  assert.ok(script.includes('task/117-bedrock-model-tier-migration'), 'the branch name is embedded in the script');
  for (const { label, re } of FORBIDDEN_SCRIPT_PATTERNS) {
    assert.equal(re.test(script), false, `the #117-branch script trips: ${label}`);
  }
});

test('ROUND #117-2: words in DATA never trip the paid-invocation detector — executable forms always do', () => {
  const paid = FORBIDDEN_SCRIPT_PATTERNS.find((p) => p.label === 'paid service invocation');
  // POSITIVE controls — the review's exact reproductions pinned: words in data NEVER trip.
  for (const legitimate of [
    "SOURCE_BRANCH='task/117-bedrock-model-tier-migration'",
    "SOURCE_BRANCH='task/118-bedrock-runtime-docs'",
    "aws_note='bedrock-runtime documentation only'",
    'PR title: document invoke-model safely',
    'PR body: endpoint https://api.anthropic.com/v1/messages is the paid host',
    'PR body: models are anthropic and openai families; bedrock ids stay in configuration',
    '# comment: the anthropic adapter and the openai provider are product functionality',
  ]) {
    assert.equal(paid.re.test(legitimate), false, `data must not trip the detector: ${legitimate}`);
  }
  // NEGATIVE controls — executable forms ALWAYS refuse: command position, global options
  // before the service, line continuations, and endpoints under an executable client.
  for (const forbidden of [
    'aws bedrock-runtime invoke-model --model-id us.anthropic.claude-sonnet-5',
    'aws bedrock-runtime converse --model-id x',
    'aws --region us-east-1 bedrock get-foundation-model-availability --model-id x',
    'aws \\\n  bedrock-runtime converse --model-id x',
    'x=1; aws bedrock list-inference-profiles',
    'curl https://bedrock-runtime.us-east-1.amazonaws.com/model/x/converse',
    'curl https://api.anthropic.com/v1/messages',
    'wget -qO- https://api.openai.com/v1/chat/completions',
    'env AWS_PROFILE=p aws bedrock-runtime converse --model-id x',
    '/usr/bin/aws bedrock-runtime converse --model-id x',
    'command aws bedrock-runtime converse --model-id x',
    'env curl https://api.anthropic.com/v1/messages',
  ]) {
    assert.equal(paid.re.test(forbidden), true, `an executable paid call must refuse: ${forbidden}`);
  }
});

test('the script performs exactly ONE push, of the task branch, without force', () => {
  const script = scriptFixture();
  const pushes = script.split('\n').filter((l) => /^\s*git push\b/.test(l));
  assert.equal(pushes.length, 1, `expected exactly one push, found ${pushes.length}`);
  // The refspec names the reviewed SHA, not a symbolic ref: pushing `refs/heads/<branch>` would
  // publish whatever the branch points at when the push runs, not what the gate approved.
  assert.equal(pushes[0].trim(), 'git push origin "$EXPECTED_HEAD:refs/heads/$SOURCE_BRANCH"');
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
  assert.match(script, /merge is Zamp's decision/);
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
  // The artifact deliberately CONTAINS a credential-marker pattern, to refuse a credential-shaped
  // gate id. That detector is not a secret, so it is excluded — and asserted to still be there,
  // because excluding it silently would be a way to lose the control.
  const raw = scriptFixture();
  assert.match(raw, /grep -Eqi 'akia\[0-9a-z\]\{16\}\|ghp_/, 'the credential detector must exist');
  const script = raw
    .split('\n')
    .filter((l) => !/grep -Eqi 'akia/.test(l))
    .join('\n');
  for (const re of [/ghp_[A-Za-z0-9]/, /github_pat_/, /AKIA[0-9A-Z]{8}/, /-----BEGIN [A-Z ]*PRIVATE KEY/, /xox[baprs]-/]) {
    assert.equal(re.test(script), false, `secret-shaped material matched ${re}`);
  }
  // Nor does it read one from the environment or the AWS credentials file.
  assert.equal(/\$\{?(GH_TOKEN|GITHUB_TOKEN|AWS_SECRET_ACCESS_KEY|ANTHROPIC_API_KEY)/.test(script), false);
});

/* ================= SCRIPT GUARDS ================= */

test('the confirmation is an operator acknowledgement, not a terminal check', () => {
  const script = scriptFixture();
  // The executor operates publication in the definitive model, so requiring a TTY would block the
  // actor that is supposed to run this. What stays deliberate is the exact phrase.
  assert.equal(/\[ -t 0 \]/.test(script), false, 'a TTY requirement would block the operator');
  assert.match(script, /IFS= read -r typed \|\| die "no confirmation was supplied/);
  assert.match(script, /\[ "\$typed" = "\$CONFIRMATION" \] \|\| die/);
  // The human decision is the gate, and it is shown at the confirmation so operation cannot be
  // mistaken for approval.
  assert.match(script, /approved by: \$GATE_APPROVER \(human owner; merge is their decision\)/);
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

test('every operational surface names the flow or links to the canonical contract', () => {
  // Duplication is what let the protocol drift before, so surfaces are allowed to carry a short
  // summary and a pointer instead of a full restatement. What is NOT allowed is silence.
  const files = [
    'AGENTS.md',
    '.agent-handoff/README.md',
    '.agent-handoff/COMMANDS.md',
    '.agent-handoff/MESSAGE-PROTOCOL.md',
    '.agent-handoff/publish-gates/README.md',
    '.agent-handoff/templates/task.md',
    '.agent-handoff/templates/message.md',
    'spec/security-rules.md',
    'docs/architecture/agent-publication-runbook.md',
    '.claude/skills/publication-prepare/SKILL.md',
    '.agents/skills/publication-review/SKILL.md',
  ];
  for (const rel of files) {
    const text = docText(rel);
    const linksCanonical = /MESSAGE-PROTOCOL\.md|agent-publication-runbook\.md/.test(text);
    const namesFlow = /agent-human-publish-script|HUMAN_GATE_GRANTED|Opus prepares/.test(text);
    assert.ok(linksCanonical || namesFlow, `${rel} must name the flow or link to a canonical source`);
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

test('the operator skill gates operation, and the reviewer skill stays read-only', () => {
  const prepare = docText('.claude/skills/publication-prepare/SKILL.md');
  assert.match(prepare, /HUMAN_GATE_GRANTED/);
  assert.match(prepare, /agent-human-publish-script/);
  assert.match(prepare, /verify-and-run/);
  // Opus operates, but may never approve its own work or merge.
  assert.match(prepare, /never do[^.]*approve your own work, and merge/i);
  assert.match(prepare, /REVIEW_APPROVED[^.]*never a gate|never a gate/i);

  const review = docText('.agents/skills/publication-review/SKILL.md');
  assert.match(review, /never implement, never prepare and never execute/i);
  assert.match(review, /sha256sum/);
  assert.match(review, /-rw-------/);
  assert.match(review, /read-only/i);
});

test('the security rules point at the canonical contract and keep merge with Zamp', () => {
  const rules = docText('spec/security-rules.md');
  assert.match(rules, /MESSAGE-PROTOCOL\.md/);
  assert.match(rules, /agent-publication-runbook\.md/);
  assert.match(rules, /HUMAN_GATE_GRANTED/);
  assert.match(rules, /agent-human-publish-script|verify-and-run/);
  assert.match(rules, /Zamp approves and decides and performs the merge/);
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
  assert.match(stdout, /prepares only/i);
  assert.match(stdout, /never runs it/i);
  assert.match(stdout, /HUMAN_GATE_GRANTED/);
  assert.match(stdout, /MESSAGE-PROTOCOL\.md/);
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

  // The #82 debt is paid: `services/bff/test/telemetry.test.js` no longer holds a literal NUL, so
  // the exception is gone rather than merely unused. An empty set is deliberate — it keeps the
  // mechanism in place for the next offender without leaving a name nobody re-derived.
  const KNOWN_PRE_EXISTING = new Set();

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
  // check_execution_gate is the one that matters: check_gate_expiry validates the REVIEW SCOPE
  // window, so on its own it would let an execution gate expire during the prompt and still push.
  for (const call of ['check_execution_gate', 'check_gate_expiry', 'check_origin_binding', 'check_remote_state', 'assert_pr_set']) {
    assert.ok(between.includes(call), `${call} must run again after the confirmation`);
  }
  assert.match(between, /check_execution_gate "after confirmation"/);
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

/* ================= #93 round 4: the execution gate is a second, digest-bound decision ========== */

/**
 * Runs the artifact up to a chosen marker, with `git` and `gh` replaced by refusing stubs.
 *
 * The previous harness truncated the script before the volatile checks, which is exactly what let
 * the post-confirmation gap hide: the part that was broken was the part never executed. This runs
 * the REAL script with a stub PATH, so control flow past the gate section is exercised and any
 * attempt to reach a remote fails loudly instead of silently succeeding.
 */
function runArtifact(script, { gate, digest, confirm = null, stubDir, env = {} } = {}) {
  const res = spawnSync('bash', ['-c', script], {
    encoding: 'utf8',
    input: confirm === null ? '' : `${confirm}\n`,
    env: {
      PATH: `${stubDir}:${process.env.PATH}`,
      CBA_EXECUTION_GATE: gate ?? '',
      CBA_ARTIFACT_DIGEST: digest ?? '',
      ...env,
    },
  });
  return res;
}

/**
 * Stub `git`, `gh` and optionally `date` so the artifact can run without a remote.
 *
 * `git push` and every `gh` mutation abort with a marker: if a control fails open, the test sees
 * FORBIDDEN_CALL rather than a passing assertion.
 */
function makeStubs(dir, { headSha, baseSha, branch, remoteBase, commits = [], remoteHead = '', prJson = '[]' } = {}) {
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  // The stubbed repository root is a SUBDIRECTORY, so a gate written in `dir` is genuinely outside
  // it — the artifact refuses an in-repository gate, and the fixture must respect that.
  const repoRoot = path.join(dir, 'repo');
  fs.mkdirSync(repoRoot, { recursive: true });
  const git = `#!/usr/bin/env bash
case "$*" in
  "rev-parse --show-toplevel") echo ${JSON.stringify(repoRoot)} ;;
  "rev-parse --abbrev-ref HEAD") echo ${JSON.stringify(branch)} ;;
  "rev-parse HEAD") echo ${JSON.stringify(headSha)} ;;
  "status --porcelain") ;;
  "worktree list --porcelain") echo "worktree ${repoRoot}"; echo "branch refs/heads/${branch}" ;;
  "rev-list --reverse"*) ${(commits.length ? commits : [headSha]).map((sha) => `echo ${JSON.stringify(sha)}`).join('; ')} ;;
  "remote get-url origin") echo ${JSON.stringify(`https://github.com/${REPO}.git`)} ;;
  "ls-remote origin refs/heads/main") echo -e ${JSON.stringify(remoteBase)}"\trefs/heads/main" ;;
  "ls-remote origin refs/heads/"*) ${remoteHead ? `echo -e ${JSON.stringify(remoteHead)}"\trefs/heads/x"` : 'true'} ;;
  "push"*) echo "FORBIDDEN_CALL git $*" >&2; exit 99 ;;
  "fetch"*) ;;
  "merge-base"*) exit 0 ;;
  *) echo "UNSTUBBED git $*" >&2; exit 98 ;;
esac
`;
  const gh = `#!/usr/bin/env bash
case "$*" in
  "pr list"*) printf '%s' ${JSON.stringify(prJson)} ;;
  *) echo "FORBIDDEN_CALL gh $*" >&2; exit 99 ;;
esac
`;
  fs.writeFileSync(path.join(bin, 'git'), git, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'gh'), gh, { mode: 0o755 });
  return bin;
}

const EXEC_GATE = (over = {}) => ({
  type: 'HUMAN_GATE_GRANTED',
  gateId: 'gate-93-exec',
  issue: 93,
  sourceBranch: 'task/93-human-publication-script',
  targetBranch: 'main',
  approver: 'marciozampiron',
  commits: [C1, C2],
  artifactDigest: 'd'.repeat(64),
  expiresAt: new Date(Date.now() + 3600_000).toISOString().replace(/\.\d{3}Z$/, 'Z'),
  ...over,
});

test('the artifact refuses to run without an execution gate — preparation authorizes nothing', async () => {
  await withTempDir(async (dir) => {
    const stubDir = makeStubs(dir, { headSha: C2, baseSha: BASE, branch: 'task/93-human-publication-script', remoteBase: BASE, commits: [C1, C2] });
    const r = runArtifact(runnableScript(), { gate: '', digest: 'd'.repeat(64), stubDir });
    assert.match(r.stderr, /set CBA_EXECUTION_GATE/);
    assert.equal(/FORBIDDEN_CALL/.test(r.stderr), false, 'nothing may be pushed');
  });
});

test('the artifact refuses to run without the digest the verify-and-run command supplies', async () => {
  await withTempDir(async (dir) => {
    const g = path.join(dir, 'gate.json');
    fs.writeFileSync(g, JSON.stringify(EXEC_GATE()));
    const stubDir = makeStubs(dir, { headSha: C2, baseSha: BASE, branch: 'task/93-human-publication-script', remoteBase: BASE, commits: [C1, C2] });
    const r = runArtifact(runnableScript(), { gate: g, digest: '', stubDir });
    assert.match(r.stderr, /CBA_ARTIFACT_DIGEST is unset/);
    assert.equal(/FORBIDDEN_CALL/.test(r.stderr), false);
  });
});

test('POSITIVE CONTROL: a well-formed execution gate is accepted', async () => {
  await withTempDir(async (dir) => {
    const g = path.join(dir, 'gate.json');
    fs.writeFileSync(g, JSON.stringify(EXEC_GATE()));
    const stubDir = makeStubs(dir, { headSha: C2, baseSha: BASE, branch: 'task/93-human-publication-script', remoteBase: BASE, commits: [C1, C2] });
    const r = runArtifact(runnableScript(), { gate: g, digest: 'd'.repeat(64), stubDir, confirm: 'nope' });
    assert.match(r.stdout, /Execution gate accepted: gate-93-exec approved by marciozampiron/, r.stderr);
    // It got as far as the confirmation and stopped there, without reaching any mutation.
    assert.match(r.stderr, /confirmation did not match/);
    assert.equal(/FORBIDDEN_CALL/.test(r.stderr), false);
  });
});

test('an execution gate for a DIFFERENT artifact cannot authorize this one', async () => {
  await withTempDir(async (dir) => {
    const g = path.join(dir, 'gate.json');
    // The gate was written for a previous artifact; regenerating changes the digest.
    fs.writeFileSync(g, JSON.stringify(EXEC_GATE({ artifactDigest: 'e'.repeat(64) })));
    const stubDir = makeStubs(dir, { headSha: C2, baseSha: BASE, branch: 'task/93-human-publication-script', remoteBase: BASE, commits: [C1, C2] });
    const r = runArtifact(runnableScript(), { gate: g, digest: 'd'.repeat(64), stubDir });
    assert.match(r.stderr, /authorizes a different artifact than the one being run/);
    assert.equal(/FORBIDDEN_CALL/.test(r.stderr), false);
  });
});

test('the execution gate must match issue, branch, approver, commits and be a HUMAN_GATE_GRANTED', async () => {
  const cases = [
    [{ type: 'REVIEW_APPROVED' }, /not a HUMAN_GATE_GRANTED/],
    [{ issue: 91 }, /for a different issue/],
    [{ sourceBranch: 'task/93-other' }, /different source branch/],
    [{ targetBranch: 'develop' }, /different target branch/],
    [{ approver: 'someone-else' }, /approver differs from the reviewed gate/],
    [{ commits: [C1] }, /does not name the reviewed commits exactly and in order/],
    [{ commits: [C2, C1] }, /does not name the reviewed commits exactly and in order/],
    [{ artifactDigest: '' }, /artifact digest must be 64 lowercase hex characters/],
    [{ artifactDigest: 'D'.repeat(64) }, /64 lowercase hex/],
    [{ gateId: 'has spaces' }, /gate id is malformed; the value is not echoed/],
    [{ expiresAt: 'tomorrow' }, /strict RFC3339/],
    // A fraction separated by anything other than a dot. GNU `date` parses it, so only the pattern
    // stands between a non-canonical gate and an accepted one.
    [{ expiresAt: new Date(Date.now() + 4 * 3600_000).toISOString().replace('.', ',') }, /strict RFC3339/],
    [{ commits: ['abc'] }, /full lowercase 40-character SHAs/],
    [{ expiresAt: '2020-01-01T00:00:00Z' }, /expired at/],
    [{ expiresAt: new Date(Date.now() + 40 * 3600_000).toISOString().replace(/\.\d{3}Z$/, 'Z') }, /exceeds 12 hours/],
  ];
  for (const [over, expected] of cases) {
    await withTempDir(async (dir) => {
      const g = path.join(dir, 'gate.json');
      fs.writeFileSync(g, JSON.stringify(EXEC_GATE(over)));
      const stubDir = makeStubs(dir, { headSha: C2, baseSha: BASE, branch: 'task/93-human-publication-script', remoteBase: BASE, commits: [C1, C2] });
      const r = runArtifact(runnableScript(), { gate: g, digest: 'd'.repeat(64), stubDir });
      assert.match(r.stderr, expected, `${JSON.stringify(over)} should be refused`);
      assert.equal(/FORBIDDEN_CALL/.test(r.stderr), false, `${JSON.stringify(over)} must not reach a mutation`);
    });
  }
});

test('a symlinked execution gate is refused rather than followed', async () => {
  await withTempDir(async (dir) => {
    const real = path.join(dir, 'gate.json');
    const link = path.join(dir, 'link.json');
    fs.writeFileSync(real, JSON.stringify(EXEC_GATE()));
    fs.symlinkSync(real, link);
    const stubDir = makeStubs(dir, { headSha: C2, baseSha: BASE, branch: 'task/93-human-publication-script', remoteBase: BASE, commits: [C1, C2] });
    const r = runArtifact(runnableScript(), { gate: link, digest: 'd'.repeat(64), stubDir });
    assert.match(r.stderr, /the execution gate path is a symlink/);
    assert.equal(/FORBIDDEN_CALL/.test(r.stderr), false);
  });
});

/* ================= #93 round 4: approver binding and single-descriptor write ==================== */

test('only the canonical human approver may approve, and never the operator', () => {
  const base = { approver: 'marciozampiron', executor: 'claude-opus-5' };
  assert.equal(assertApproverIsNotOperator(base, 'claude-opus-5'), 'marciozampiron');

  expectRefusal('APPROVER_IS_OPERATOR', () =>
    assertApproverIsNotOperator({ approver: 'claude-opus-5', executor: 'claude-opus-5' }, 'claude-opus-5'));
  expectRefusal('APPROVER_NOT_HUMAN', () =>
    assertApproverIsNotOperator({ approver: 'codex-reviewer', executor: 'claude-opus-5' }, 'claude-opus-5'));
  // Finding 5: a plausible synthetic person used to pass the shape heuristic.
  for (const impostor of ['OpenAI Codex', 'some-other-person', 'zamp-deputy', 'marciozampiron2']) {
    expectRefusal('APPROVER_NOT_CANONICAL', () =>
      assertApproverIsNotOperator({ approver: impostor, executor: 'claude-opus-5' }, 'claude-opus-5'));
  }
  assert.equal(CANONICAL_APPROVER, 'marciozampiron');
});

test('a non-canonical approver is refused end to end, without echoing the value', async () => {
  await withTempDir(async (dir) => {
    await withTmpScriptPath(async (out) => {
      const gate = gateFileIn(dir, gateFixture({ approver: 'OpenAI Codex' }));
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
      assert.match(output, /APPROVER_NOT_CANONICAL/);
      assert.equal(/OpenAI Codex/.test(output), false, 'the refused approver must not be echoed');
      assert.equal(fs.existsSync(out), false);
    });
  });
});

test('the artifact write cannot be redirected by a symlink planted at the path', async () => {
  await withTempDir(async (dir) => {
    await withTmpScriptPath(async (out) => {
      const victim = path.join(dir, 'victim.txt');
      fs.writeFileSync(victim, 'untouched\n');
      fs.symlinkSync(victim, out);
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
      assert.equal(fs.readFileSync(victim, 'utf8'), 'untouched\n', 'the symlink target must be untouched');
    });
  });
});

test('the pull request is bound to the reviewed commit, not to a branch name', () => {
  const script = scriptFixture();
  assert.match(script, /--json number,baseRefName,headRefName,headRefOid,isCrossRepository,headRepositoryOwner/);
  assert.match(script, /points at a commit that is not the reviewed head/);
  // Verified again after the push and after create/reuse — a branch can move in between.
  const push = script.indexOf('git push origin');
  const finalCheck = script.indexOf('final verification');
  assert.ok(finalCheck > push, 'the pull request must be re-verified after publishing');
  assert.match(script, /moved to \$final_ref after publishing/);
  assert.match(script, /pull request #\$pr_number points at \$pr_oid, not the reviewed head/);
});

/* ================= #93 round 5: the gate is re-evaluated after the confirmation ================= */

/**
 * Builds stubs whose `date` advances past a chosen instant only AFTER the confirmation is read.
 *
 * This is the regression for the real defect: the post-confirmation revalidation called
 * `check_gate_expiry`, which validates the REVIEW SCOPE window, so an execution gate that expired
 * while the prompt was open still reached `git push`. A static grep could not have caught it — the
 * call was present, it was simply the wrong one.
 */
function makeExpiringStubs(dir, opts) {
  const bin = makeStubs(dir, opts);
  const marker = path.join(dir, 'confirmed');
  // `date` reports "now" normally, then jumps a day forward once the marker exists. The artifact
  // creates no marker itself, so the stubbed `read` path below is what trips it.
  fs.writeFileSync(
    path.join(bin, 'date'),
    `#!/usr/bin/env bash
if [ -f ${JSON.stringify(marker)} ]; then
  exec /usr/bin/date -d "+2 days" "$@"
fi
exec /usr/bin/date "$@"
`,
    { mode: 0o755 },
  );
  return { bin, marker };
}

test('an execution gate that expires while the prompt is open cannot reach the push', async () => {
  await withTempDir(async (dir) => {
    const g = path.join(dir, 'gate.json');
    // A gate valid for one hour: still valid at the prompt, expired by the time `date` jumps.
    fs.writeFileSync(g, JSON.stringify(EXEC_GATE()));
    const { bin, marker } = makeExpiringStubs(dir, {
      headSha: C2,
      baseSha: BASE,
      branch: 'task/93-human-publication-script',
      remoteBase: BASE,
      commits: [C1, C2],
    });

    // Confirming creates the marker, so every `date` call after the confirmation sees a later clock.
    const script = runnableScript().replace(
      'IFS= read -r typed || die',
      `touch ${JSON.stringify(marker)}; IFS= read -r typed || die`,
    );
    const r = runArtifact(script, {
      gate: g,
      digest: 'd'.repeat(64),
      stubDir: bin,
      confirm: `publish 93 ${C2.slice(0, 12)}`,
    });

    assert.match(r.stderr, /after confirmation: the execution gate expired/);
    assert.equal(/FORBIDDEN_CALL/.test(r.stderr), false, 'the push must never be reached');
    assert.notEqual(r.status, 0);
  });
});

test('POSITIVE CONTROL: with a steady clock the same run reaches the push attempt', async () => {
  // Proof the test above fails for the right reason. Same script, same gate, no clock jump: the
  // artifact gets all the way to the push, where the stub refuses loudly.
  await withTempDir(async (dir) => {
    const g = path.join(dir, 'gate.json');
    fs.writeFileSync(g, JSON.stringify(EXEC_GATE()));
    const stubDir = makeStubs(dir, {
      headSha: C2,
      baseSha: BASE,
      branch: 'task/93-human-publication-script',
      remoteBase: BASE,
      commits: [C1, C2],
    });
    const r = runArtifact(runnableScript(), {
      gate: g,
      digest: 'd'.repeat(64),
      stubDir,
      confirm: `publish 93 ${C2.slice(0, 12)}`,
    });
    assert.match(r.stderr, /FORBIDDEN_CALL git push/, `expected to reach the push: ${r.stderr}`);
  });
});

test('the execution gate is read ONCE, into a snapshot, not re-read per field', () => {
  const script = scriptFixture();
  // One open with O_NOFOLLOW, one fstat, one read — all on the same descriptor, so there is no
  // window at all, and no field is parsed by resolving the pathname again.
  assert.match(script, /O_RDONLY \| fs\.constants\.O_NOFOLLOW/);
  assert.match(script, /fs\.fstatSync\(fd\)/);
  assert.match(script, /EXECUTION_GATE_JSON=\$\(node -e/);
  // After the snapshot exists, the pathname must not be read again.
  const afterSnapshot = script.slice(script.indexOf('EXECUTION_GATE_JSON=$(cat <&9)') + 30);
  assert.equal(
    /jq [^\n]*"\$CBA_EXECUTION_GATE"/.test(afterSnapshot),
    false,
    'no field may be parsed by re-reading the gate path',
  );
  assert.match(script, /gate_json\(\) \{ printf '%s' "\$EXECUTION_GATE_JSON" \| jq/);
});

test('the execution gate schema is closed, strictly typed, and never echoes a refused value', () => {
  const script = scriptFixture();
  assert.match(script, /expected_keys='\["approver","artifactDigest","commits","expiresAt","gateId","issue","sourceBranch","targetBranch","type"\]'/);
  assert.match(script, /the execution gate schema is wrong/);
  assert.match(script, /\^\[a-z0-9\]\[a-z0-9\._-\]\{2,63\}\$/); // gateId charset
  assert.match(script, /\^\[0-9a-f\]\{64\}\$/); // digest
  assert.match(script, /\(Z\|\[\+-\]\[0-9\]\{2\}:\[0-9\]\{2\}\)\$/); // strict RFC3339
  assert.match(script, /\^\[0-9a-f\]\{40\}\$/); // full SHAs
  assert.match(script, /the value is not echoed/);
  // The gate must live outside the repository, compared canonically.
  assert.match(script, /the execution gate must live outside the repository worktree/);
  assert.match(script, /pwd -P/);
});

/**
 * Lift the expiry check OUT of the generated artifact and run it on its own.
 *
 * Asserting on the script text is what let a defect through: the schema test above matches only the
 * TAIL of the pattern, so the fraction group could degrade to `(.[0-9]+)?` — a regex that matches
 * any character — and the assertion stayed green. A `\.` inside the generator's template literal is
 * not an escape sequence JavaScript knows, so it renders as a bare `.`; nothing in a text assertion
 * distinguishes the two.
 *
 * So this runs the generated bytes. The pattern is extracted from the artifact rather than copied,
 * because a copy proves only that the copy is correct.
 */
function runGeneratedExpiryCheck(script, value) {
  const m = /\nprintf '%s' "\$gate_expires" \| grep -Eq '([^']*)' \\\n\s*\|\| die /.exec(script);
  assert.ok(m, 'the artifact must still validate $gate_expires with a single extractable grep');
  const snippet = `set -u\ngate_expires=$1\nprintf '%s' "$gate_expires" | grep -Eq '${m[1]}' || exit 1\n`;
  return spawnSync('bash', ['-c', snippet, 'expiry-check', value], { encoding: 'utf8' }).status === 0;
}

test('the generated expiry check is strict RFC3339 and agrees with Stage A', () => {
  const script = scriptFixture();
  const cases = [
    // Accepted: the three canonical renderings the gate is allowed to carry.
    ['2026-07-30T18:00:00Z', true],
    ['2026-07-30T18:00:00.123Z', true],
    ['2026-07-30T18:00:00-03:00', true],
    ['2026-07-30T18:00:00.123456+05:30', true],
    // Refused: a bare `.` in the fraction group matches ANY character, so the separator itself has
    // to be pinned. The comma is the ISO 8601 alternate decimal mark and the one a human is most
    // likely to produce, but the hole is wider than that — a letter or a space passes just as well.
    ['2026-07-30T18:00:00,123Z', false],
    ['2026-07-30T18:00:00X123Z', false],
    ['2026-07-30T18:00:00 123Z', false],
    ['2026-07-30T18:00:00.Z', false],
    ['2026-07-30T18:00:00', false],
    ['2026-07-30 18:00:00Z', false],
    ['tomorrow', false],
  ];

  for (const [value, accepted] of cases) {
    assert.equal(
      runGeneratedExpiryCheck(script, value),
      accepted,
      `the generated artifact must ${accepted ? 'accept' : 'refuse'} ${JSON.stringify(value)}`,
    );

    // The artifact and Stage A validate the same field, so a value either passes both or neither.
    // A divergence means the closed schema is only closed on one side of the handoff.
    //
    // Only the FORMAT verdict is compared: a well-formed instant may still be refused for being
    // expired or wider than the TTL, and those are window rules the artifact checks separately.
    let stageAFormat = true;
    try {
      validateGate({
        gate: gateFixture({ expiresAt: value }),
        role: 'executor',
        executor: 'claude-opus-5',
        repo: repoFixture(),
        nowMs: Date.parse(APPROVED_AT) + 60_000,
      });
    } catch (err) {
      assert.ok(err instanceof GateError, `expected a GateError for ${JSON.stringify(value)}`);
      stageAFormat = !/strict RFC3339 timestamp/.test(err.message);
    }
    assert.equal(stageAFormat, accepted, `Stage A must agree with the artifact on ${JSON.stringify(value)}`);
  }
});

test('a gate inside the repository worktree is refused at run time', async () => {
  await withTempDir(async (dir) => {
    const stubDir = makeStubs(dir, {
      headSha: C2,
      baseSha: BASE,
      branch: 'task/93-human-publication-script',
      remoteBase: BASE,
      commits: [C1, C2],
    });
    // makeStubs reports `<dir>/repo` as the toplevel, so a gate written there is inside it.
    const inside = path.join(dir, 'repo', 'gate.json');
    fs.writeFileSync(inside, JSON.stringify(EXEC_GATE()));
    const r = runArtifact(runnableScript(), { gate: inside, digest: 'd'.repeat(64), stubDir });
    assert.match(r.stderr, /must live outside the repository worktree/);
    assert.equal(/FORBIDDEN_CALL/.test(r.stderr), false);
  });
});

/* ================= #93 round 6: the gate check must be adjacent to the push =================== */

test('a gate that expires DURING remote revalidation cannot reach the push', async () => {
  // The refined defect: `check_execution_gate "after confirmation"` ran before the origin binding,
  // the live remote reads and the pull-request query — all of which contact the network and can
  // block. A gate expiring in that span would previously still have reached `git push`.
  await withTempDir(async (dir) => {
    const g = path.join(dir, 'gate.json');
    fs.writeFileSync(g, JSON.stringify(EXEC_GATE()));
    const stubDir = makeStubs(dir, {
      headSha: C2,
      baseSha: BASE,
      branch: 'task/93-human-publication-script',
      remoteBase: BASE,
      commits: [C1, C2],
    });

    // The clock jumps only once the REMOTE revalidation starts — i.e. strictly after the
    // post-confirmation gate check and strictly before the push.
    const marker = path.join(dir, 'revalidating');
    fs.writeFileSync(
      path.join(stubDir, 'date'),
      `#!/usr/bin/env bash
if [ -f ${JSON.stringify(marker)} ]; then exec /usr/bin/date -d "+2 days" "$@"; fi
exec /usr/bin/date "$@"
`,
      { mode: 0o755 },
    );
    // `check_remote_state` runs twice: once in the pre-flight and once in the post-confirmation
    // revalidation. Counting the calls lets the clock advance on the SECOND pass only — strictly
    // after `check_execution_gate "after confirmation"` and strictly before the push.
    const counter = path.join(dir, 'ls-remote-count');
    const git = fs
      .readFileSync(path.join(stubDir, 'git'), 'utf8')
      .replace(
        '  "ls-remote origin refs/heads/main")',
        `  "ls-remote origin refs/heads/main") printf 'x' >> ${JSON.stringify(counter)}
    if [ "$(wc -c < ${JSON.stringify(counter)})" -ge 2 ]; then touch ${JSON.stringify(marker)}; fi;`,
      );
    fs.writeFileSync(path.join(stubDir, 'git'), git, { mode: 0o755 });

    const r = runArtifact(runnableScript(), {
      gate: g,
      digest: 'd'.repeat(64),
      stubDir,
      confirm: `publish 93 ${C2.slice(0, 12)}`,
    });

    assert.match(r.stderr, /immediately before push: the execution gate expired/);
    assert.equal(/FORBIDDEN_CALL git push/.test(r.stderr), false, 'the push must never be reached');
    assert.notEqual(r.status, 0);
  });
});

test('the execution gate is opened with O_NOFOLLOW, closing the last window', async () => {
  await withTempDir(async (dir) => {
    // A symlink planted at the gate path is refused by the kernel at open time, not by an earlier
    // `[ ! -L ]` test that a same-user process could race.
    const real = path.join(dir, 'real.json');
    const link = path.join(dir, 'gate.json');
    fs.writeFileSync(real, JSON.stringify(EXEC_GATE()));
    fs.symlinkSync(real, link);
    const stubDir = makeStubs(dir, {
      headSha: C2,
      baseSha: BASE,
      branch: 'task/93-human-publication-script',
      remoteBase: BASE,
      commits: [C1, C2],
    });
    const r = runArtifact(runnableScript(), { gate: link, digest: 'd'.repeat(64), stubDir });
    assert.match(r.stderr, /the execution gate path is a symlink/);
    assert.equal(/FORBIDDEN_CALL/.test(r.stderr), false);
  });
});

test('an oversized or non-regular execution gate is refused by the helper', async () => {
  await withTempDir(async (dir) => {
    const stubDir = makeStubs(dir, {
      headSha: C2,
      baseSha: BASE,
      branch: 'task/93-human-publication-script',
      remoteBase: BASE,
      commits: [C1, C2],
    });
    const big = path.join(dir, 'big.json');
    fs.writeFileSync(big, 'x'.repeat(70 * 1024));
    const oversized = runArtifact(runnableScript(), { gate: big, digest: 'd'.repeat(64), stubDir });
    assert.match(oversized.stderr, /larger than 64 KiB/);

    const empty = path.join(dir, 'empty.json');
    fs.writeFileSync(empty, '');
    const blank = runArtifact(runnableScript(), { gate: empty, digest: 'd'.repeat(64), stubDir });
    assert.match(blank.stderr, /the execution gate is empty/);
  });
});

test('publication evidence attributes authority to the execution gate', () => {
  const script = scriptFixture();
  // The review scope bounded preparation; recording it as the authorization would credit the wrong
  // decision in the prompt, the pull-request body and the final evidence.
  assert.match(script, /REVIEW_SCOPE_ID='scope-93'|REVIEW_SCOPE_ID='gate-93-001'/);
  assert.match(script, /EXECUTION_GATE_ID="\$gate_id"/);
  assert.equal(/^GATE_ID=/m.test(script), false, 'the ambiguous GATE_ID must be gone');
  assert.match(script, /execution gate : \$EXECUTION_GATE_ID {2}\(this is the authorization\)/);
  assert.match(script, /Authorized by execution gate \$EXECUTION_GATE_ID \(review scope \$REVIEW_SCOPE_ID\)/);
  assert.match(script, /authorized by {2}: execution gate \$EXECUTION_GATE_ID/);
});

/* ================= #93 round 7: adjacency, credential-shaped ids, and a FIFO gate ============== */

test('the gate check and the push are consecutive statements, with not even a note between', () => {
  const script = scriptFixture();
  const check = script.indexOf('check_execution_gate "immediately before push"');
  const push = script.indexOf('git push origin');
  assert.ok(check > -1 && check < push);
  const between = script
    .slice(check + 'check_execution_gate "immediately before push"'.length, push)
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '' && !l.startsWith('#'));
  assert.deepEqual(between, [], `nothing may sit between the check and the push: ${between.join(' | ')}`);
  // And the progress line moved ABOVE the check rather than being deleted.
  assert.ok(script.indexOf('Pushing the reviewed commit') < check);
});

test('a credential-shaped execution gateId is refused before it is ever echoed', async () => {
  // The gate id is printed at the prompt, in the pull-request body and in the evidence. A charset
  // check alone is not enough: `ghp_...` and `api_key...` are perfectly lowercase.
  const shaped = ['ghp_abcdefghij0123', 'github_pat_abc', 'sk-abcdefgh1234', 'my-secret-1', 'bearer-abc', 'api_key-1'];
  for (const id of shaped) {
    await withTempDir(async (dir) => {
      const g = path.join(dir, 'gate.json');
      fs.writeFileSync(g, JSON.stringify(EXEC_GATE({ gateId: id })));
      const stubDir = makeStubs(dir, {
        headSha: C2,
        baseSha: BASE,
        branch: 'task/93-human-publication-script',
        remoteBase: BASE,
        commits: [C1, C2],
      });
      const r = runArtifact(runnableScript(), { gate: g, digest: 'd'.repeat(64), stubDir });
      assert.match(r.stderr, /malformed; the value is not echoed|credential material and was refused unprinted/, id);
      assert.equal(r.stderr.includes(id), false, `the refused id ${id} must never be echoed`);
      assert.equal(r.stdout.includes(id), false, `the refused id ${id} must never be echoed`);
    });
  }
});

test('a benign gateId still passes, so the credential check is not simply refusing everything', async () => {
  await withTempDir(async (dir) => {
    const g = path.join(dir, 'gate.json');
    fs.writeFileSync(g, JSON.stringify(EXEC_GATE({ gateId: 'gate-93-001' })));
    const stubDir = makeStubs(dir, {
      headSha: C2,
      baseSha: BASE,
      branch: 'task/93-human-publication-script',
      remoteBase: BASE,
      commits: [C1, C2],
    });
    const r = runArtifact(runnableScript(), { gate: g, digest: 'd'.repeat(64), stubDir, confirm: 'nope' });
    assert.match(r.stdout, /Execution gate accepted: gate-93-001/, r.stderr);
  });
});

test('a FIFO planted at the gate path fails fast instead of hanging the operation', async () => {
  // Without O_NONBLOCK, opening a FIFO with no writer blocks forever: the operation would hang
  // rather than refuse. The bounded timeout is the assertion — if this test ever times out, the
  // flag has been lost.
  await withTempDir(async (dir) => {
    const fifo = path.join(dir, 'gate.json');
    const mk = spawnSync('mkfifo', [fifo], { encoding: 'utf8' });
    if (mk.status !== 0) return; // platform without mkfifo; the O_NONBLOCK assertion below still runs
    const stubDir = makeStubs(dir, {
      headSha: C2,
      baseSha: BASE,
      branch: 'task/93-human-publication-script',
      remoteBase: BASE,
      commits: [C1, C2],
    });
    const started = process.hrtime.bigint();
    const r = spawnSync('bash', ['-c', runnableScript()], {
      encoding: 'utf8',
      input: '',
      timeout: 15_000,
      env: {
        PATH: `${stubDir}:${process.env.PATH}`,
        CBA_EXECUTION_GATE: fifo,
        CBA_ARTIFACT_DIGEST: 'd'.repeat(64),
      },
    });
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    assert.notEqual(r.signal, 'SIGTERM', 'the open must not block until the timeout kills it');
    assert.ok(elapsedMs < 15_000, `expected a fast refusal, took ${Math.round(elapsedMs)}ms`);
    // A FIFO is not a regular file, so fstat refuses it.
    assert.match(r.stderr, /not a regular file|cannot be opened/);
    assert.equal(/FORBIDDEN_CALL/.test(r.stderr), false);
  });
});

test('the gate is opened with O_NONBLOCK as well as O_NOFOLLOW', () => {
  const script = scriptFixture();
  assert.match(script, /O_RDONLY \| fs\.constants\.O_NOFOLLOW \| fs\.constants\.O_NONBLOCK/);
  assert.match(script, /st\.isFile\(\)/);
});

test('the gate documents reserve each filename for exactly one channel', () => {
  const doc = docText('.agent-handoff/publish-gates/README.md');
  assert.match(doc, /review scope as `\/tmp\/cba-scope-<issue>\.json`/);
  assert.match(doc, /reserved for `CBA_EXECUTION_GATE` and is\s+never passed to `--gate`/);
});

/* ================= #93 round 8: the gate guards BOTH external effects ========================== */

/**
 * Stubs that let the push succeed, so the pull-request path can be reached.
 *
 * The other stub set aborts on `git push`, which is right for every test that must never publish.
 * This one has to get past it: the defect under test lives between the push and `gh pr create`, and a
 * harness that stops at the push cannot see it. `gh pr create` is still the tripwire.
 */
function makePostPushStubs(dir, { head, base, branch, expireAfterLsRemote }) {
  const bin = path.join(dir, 'bin');
  const repoRoot = path.join(dir, 'repo');
  fs.mkdirSync(bin, { recursive: true });
  fs.mkdirSync(repoRoot, { recursive: true });
  const counter = path.join(dir, 'ls-remote-count');
  const marker = path.join(dir, 'expired');

  fs.writeFileSync(
    path.join(bin, 'git'),
    `#!/usr/bin/env bash
case "$*" in
  "rev-parse --show-toplevel") echo ${JSON.stringify(repoRoot)} ;;
  "rev-parse --abbrev-ref HEAD") echo ${JSON.stringify(branch)} ;;
  "rev-parse HEAD") echo ${JSON.stringify(head)} ;;
  "status --porcelain") ;;
  "worktree list --porcelain") echo "worktree ${repoRoot}"; echo "branch refs/heads/${branch}" ;;
  "rev-list --reverse"*) echo ${JSON.stringify(head)} ;;
  "remote get-url origin") echo ${JSON.stringify(`https://github.com/${REPO}.git`)} ;;
  "ls-remote origin refs/heads/main")
    printf 'x' >> ${JSON.stringify(counter)}
    if [ "$(wc -c < ${JSON.stringify(counter)})" -ge ${expireAfterLsRemote} ]; then touch ${JSON.stringify(marker)}; fi
    echo -e ${JSON.stringify(base)}"\\trefs/heads/main" ;;
  "ls-remote origin refs/heads/"*)
    printf 'x' >> ${JSON.stringify(counter)}
    if [ "$(wc -c < ${JSON.stringify(counter)})" -ge ${expireAfterLsRemote} ]; then touch ${JSON.stringify(marker)}; fi
    # After the push the branch exists at the reviewed head; before it, it does not.
    if [ -f ${JSON.stringify(path.join(dir, 'pushed'))} ]; then echo -e ${JSON.stringify(head)}"\\trefs/heads/x"; fi ;;
  "push"*) touch ${JSON.stringify(path.join(dir, 'pushed'))}; echo "PUSH_HAPPENED" ;;
  "fetch"*) ;;
  "merge-base"*) exit 0 ;;
  *) echo "UNSTUBBED git $*" >&2; exit 98 ;;
esac
`,
    { mode: 0o755 },
  );
  fs.writeFileSync(
    path.join(bin, 'gh'),
    `#!/usr/bin/env bash
case "$*" in
  "pr list"*) printf '%s' '[]' ;;
  "pr create"*) echo "FORBIDDEN_CALL gh $*" >&2; exit 99 ;;
  *) echo "FORBIDDEN_CALL gh $*" >&2; exit 99 ;;
esac
`,
    { mode: 0o755 },
  );
  fs.writeFileSync(
    path.join(bin, 'date'),
    `#!/usr/bin/env bash
if [ -f ${JSON.stringify(marker)} ]; then exec /usr/bin/date -d "+2 days" "$@"; fi
exec /usr/bin/date "$@"
`,
    { mode: 0o755 },
  );
  return bin;
}

test('POSITIVE CONTROL: with a steady clock the run reaches the pull-request creation', () => {
  // Proof the harness gets past the push at all — without this, the test below could pass for the
  // wrong reason.
  return withTempDir(async (dir) => {
    const g = path.join(dir, 'gate.json');
    fs.writeFileSync(g, JSON.stringify(EXEC_GATE({ commits: [C2] })));
    const stubDir = makePostPushStubs(dir, {
      head: C2,
      base: BASE,
      branch: 'task/93-human-publication-script',
      expireAfterLsRemote: 99, // never
    });
    const r = runArtifact(runnableScript({ commits: [C2], reviewedShas: [C2] }, { commits: [C2] }), {
      gate: g,
      digest: 'd'.repeat(64),
      stubDir,
      confirm: `publish 93 ${C2.slice(0, 12)}`,
    });
    assert.match(r.stdout, /PUSH_HAPPENED/, `the push must be reached: ${r.stderr}`);
    assert.match(r.stderr, /FORBIDDEN_CALL gh pr create/, `the pull request must be reached: ${r.stderr}`);
  });
});

test('a gate that expires AFTER the push cannot reach the pull-request creation', async () => {
  // The reported defect: seven statements, two of them network calls, sat between the pre-push gate
  // check and `gh pr create`. A gate expiring in that span still opened a pull request.
  await withTempDir(async (dir) => {
    const g = path.join(dir, 'gate.json');
    fs.writeFileSync(g, JSON.stringify(EXEC_GATE({ commits: [C2] })));
    // Five ls-remote calls precede the post-push one: two in the pre-flight, two in the
    // post-confirmation revalidation, and the fifth is the landed-ref read after the push.
    const stubDir = makePostPushStubs(dir, {
      head: C2,
      base: BASE,
      branch: 'task/93-human-publication-script',
      expireAfterLsRemote: 5,
    });
    const r = runArtifact(runnableScript({ commits: [C2], reviewedShas: [C2] }, { commits: [C2] }), {
      gate: g,
      digest: 'd'.repeat(64),
      stubDir,
      confirm: `publish 93 ${C2.slice(0, 12)}`,
    });

    assert.match(r.stdout, /PUSH_HAPPENED/, 'the push is expected to have happened by then');
    assert.match(r.stderr, /immediately before the pull request: the execution gate expired/);
    assert.equal(
      /FORBIDDEN_CALL gh pr create/.test(r.stderr),
      false,
      'the pull request must never be created once the gate has expired',
    );
    assert.notEqual(r.status, 0);
  });
});
