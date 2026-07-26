// Role-separated publication tests (#91 Stage A).
//
// Every abuse case from the 2026-07-26 incident is exercised here as a unit test with injected
// seams, so no test ever contacts a remote, pushes a branch or opens a pull request. The network
// dependency is a SPY: when it is called, the test says so; when the control works, it is never
// constructed at all.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runAgentPublish, EXIT } from '../src/commands/agent-publish.js';
import {
  assertPublishingRole,
  parseGate,
  validateGate,
  assertNamedApprover,
  evidenceFor,
  GateError,
} from '../src/lib/publish-gate.js';

const BASE = 'a'.repeat(40);
const C1 = '1'.repeat(40);
const C2 = '2'.repeat(40);
const OTHER = '9'.repeat(40);

const APPROVED_AT = '2026-07-26T18:00:00Z';
const EXPIRES_AT = '2026-07-26T22:00:00Z';
const NOW = Date.parse('2026-07-26T19:00:00Z');

function gateFixture(overrides = {}) {
  return {
    gateId: 'gate-91-001',
    issue: 91,
    executor: 'claude-opus-5',
    baseSha: BASE,
    commits: [C1, C2],
    sourceBranch: 'task/91-role-separated-publication',
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
    branch: 'task/91-role-separated-publication',
    headSha: C2,
    baseSha: BASE,
    commits: [C1, C2],
    clean: true,
    remoteBaseSha: BASE,
    worktrees: [{ path: '/w/91', branch: 'task/91-role-separated-publication' }],
    handoffPresent: true,
    ...overrides,
  };
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

/* ================= POSITIVE CONTROL ================= */

test('POSITIVE CONTROL: a well-formed gate on the right branch validates', () => {
  const result = validateGate({
    gate: gateFixture(),
    role: 'executor',
    executor: 'claude-opus-5',
    repo: repoFixture(),
    nowMs: NOW,
  });
  assert.equal(result.issue, 91);
  assert.equal(result.sourceBranch, 'task/91-role-separated-publication');
  assert.deepEqual(result.commits, [C1, C2]);
});

/* ================= ROLE SEPARATION ================= */

test('architect and reviewer are refused, and every other role too', () => {
  for (const role of ['architect', 'reviewer', 'observer']) {
    expectRefusal('ROLE_FORBIDDEN', () => assertPublishingRole(role));
    expectRefusal('ROLE_FORBIDDEN', () => assertPublishingRole(role.toUpperCase()));
  }
  expectRefusal('ROLE_UNKNOWN', () => assertPublishingRole('admin'));
  expectRefusal('ROLE_MISSING', () => assertPublishingRole(''));
  expectRefusal('ROLE_MISSING', () => assertPublishingRole(undefined));
  assert.equal(assertPublishingRole('executor'), 'executor');
  assert.equal(assertPublishingRole(' Executor '), 'executor');
});

test('a forbidden role is refused BEFORE any filesystem, git or network access', async () => {
  // The seams throw if touched. If the role check ran late, one of them would fire.
  const touched = [];
  const deps = {
    fs: { readFileSync: () => { touched.push('fs'); throw new Error('fs must not be read'); } },
    runGit: () => { touched.push('git'); throw new Error('git must not run'); },
    publish: async () => { touched.push('network'); throw new Error('network must not be reached'); },
    now: () => NOW,
  };
  for (const role of ['architect', 'reviewer']) {
    const code = await runAgentPublish({
      role,
      executor: 'codex',
      gate: '/nonexistent/gate.json',
      deps,
    });
    assert.equal(code, EXIT.ROLE_REFUSED, `${role} must exit with the dedicated refusal code`);
  }
  assert.deepEqual(touched, [], 'no fs, git or network seam may be touched for a forbidden role');
});

test('the executor role still needs an identity and a gate', async () => {
  const deps = { runGit: () => assert.fail('git must not run'), now: () => NOW };
  assert.equal(await runAgentPublish({ role: 'executor', gate: 'x.json', deps }), EXIT.VALIDATION_FAILED);
  assert.equal(await runAgentPublish({ role: 'executor', executor: 'claude-opus-5', deps }), EXIT.VALIDATION_FAILED);
});

/* ================= BRANCH RULES ================= */

test('main can never be a source branch, and the PR always targets main', () => {
  for (const source of ['main', 'master']) {
    expectRefusal('SOURCE_IS_TARGET', () =>
      validateGate({
        gate: gateFixture({ sourceBranch: source }),
        role: 'executor',
        executor: 'claude-opus-5',
        repo: repoFixture({ branch: source }),
        nowMs: NOW,
      }));
  }
  expectRefusal('TARGET_NOT_MAIN', () =>
    validateGate({
      gate: gateFixture({ targetBranch: 'release' }),
      role: 'executor',
      executor: 'claude-opus-5',
      repo: repoFixture(),
      nowMs: NOW,
    }));
});

test('the source branch must be task/<issue>-<slug> and match the gated issue', () => {
  for (const bad of ['feature/x', 'task/nope', 'task/91', 'Task/91-x', 'task/91_underscore']) {
    expectRefusal('BRANCH_SHAPE', () =>
      validateGate({
        gate: gateFixture({ sourceBranch: bad }),
        role: 'executor',
        executor: 'claude-opus-5',
        repo: repoFixture({ branch: bad }),
        nowMs: NOW,
      }));
  }
  expectRefusal('BRANCH_ISSUE_MISMATCH', () =>
    validateGate({
      gate: gateFixture({ sourceBranch: 'task/82-observability' }),
      role: 'executor',
      executor: 'claude-opus-5',
      repo: repoFixture({ branch: 'task/82-observability' }),
      nowMs: NOW,
    }));
});

test('publishing from a different checked-out branch fails closed', () => {
  expectRefusal('BRANCH_MISMATCH', () =>
    validateGate({
      gate: gateFixture(),
      role: 'executor',
      executor: 'claude-opus-5',
      repo: repoFixture({ branch: 'task/82-aws-observability' }),
      nowMs: NOW,
    }));
});

/* ================= HUMAN DECISION ================= */

test('generic approvals are not publication commands', () => {
  for (const generic of ['approved', 'ok', 'LGTM', 'yes', 'go', 'aprovado', 'pode pushar', 'human', '-']) {
    expectRefusal('APPROVER_GENERIC', () => assertNamedApprover(generic));
  }
  assert.equal(assertNamedApprover('marciozampiron'), 'marciozampiron');
});

test('an expired or not-yet-valid gate cannot be replayed', () => {
  expectRefusal('GATE_EXPIRED', () =>
    validateGate({
      gate: gateFixture(),
      role: 'executor',
      executor: 'claude-opus-5',
      repo: repoFixture(),
      nowMs: Date.parse('2026-07-27T00:00:00Z'),
    }));
  expectRefusal('GATE_NOT_YET_VALID', () =>
    validateGate({
      gate: gateFixture(),
      role: 'executor',
      executor: 'claude-opus-5',
      repo: repoFixture(),
      nowMs: Date.parse('2026-07-26T12:00:00Z'),
    }));
});

test('a gate is bound to one executor and is not transferable', () => {
  expectRefusal('EXECUTOR_MISMATCH', () =>
    validateGate({
      gate: gateFixture(),
      role: 'executor',
      executor: 'some-other-agent',
      repo: repoFixture(),
      nowMs: NOW,
    }));
});

/* ================= COMMIT AND BASE INTEGRITY ================= */

test('extra, missing or reordered commits invalidate the human decision', () => {
  const cases = [
    ['extra commit', [C1, C2, OTHER]],
    ['missing commit', [C1]],
    ['reordered', [C2, C1]],
    ['replaced by an amend', [C1, OTHER]],
    ['empty branch', []],
  ];
  for (const [label, commits] of cases) {
    expectRefusal('COMMIT_SET_DRIFT', () =>
      validateGate({
        gate: gateFixture(),
        role: 'executor',
        executor: 'claude-opus-5',
        repo: repoFixture({ commits, headSha: commits[commits.length - 1] ?? BASE }),
        nowMs: NOW,
      }), `case: ${label}`);
  }
});

test('a moved base fails closed instead of publishing against new history', () => {
  expectRefusal('BASE_DRIFT', () =>
    validateGate({
      gate: gateFixture(),
      role: 'executor',
      executor: 'claude-opus-5',
      repo: repoFixture({ baseSha: OTHER }),
      nowMs: NOW,
    }));
});

test('a dirty worktree cannot publish', () => {
  expectRefusal('WORKTREE_DIRTY', () =>
    validateGate({
      gate: gateFixture(),
      role: 'executor',
      executor: 'claude-opus-5',
      repo: repoFixture({ clean: false }),
      nowMs: NOW,
    }));
});

test('a malformed or incomplete manifest is refused', () => {
  expectRefusal('GATE_MALFORMED', () => parseGate('{not json'));
  expectRefusal('GATE_MALFORMED', () => parseGate('[]'));
  for (const key of ['gateId', 'issue', 'executor', 'baseSha', 'commits', 'sourceBranch', 'targetBranch', 'approver', 'approvedAt', 'expiresAt']) {
    const broken = gateFixture();
    delete broken[key];
    expectRefusal('GATE_INCOMPLETE', () => parseGate(broken), `missing ${key}`);
  }
  expectRefusal('GATE_INCOMPLETE', () => parseGate(gateFixture({ baseSha: 'abc1234' })));
  expectRefusal('GATE_INCOMPLETE', () => parseGate(gateFixture({ commits: ['abc1234'] })));
  expectRefusal('GATE_INCOMPLETE', () => parseGate(gateFixture({ commits: [C1, C1] })));
  expectRefusal('GATE_INCOMPLETE', () => parseGate(gateFixture({ issue: '91' })));
});

test('the committed example gate is a schema fixture, never a usable gate', async () => {
  const { readFileSync } = await import('node:fs');
  const example = JSON.parse(readFileSync(new URL('../.agent-handoff/publish-gates/example.gate.json', import.meta.url), 'utf8'));
  parseGate(example); // shape is valid, so the schema doc stays honest
  // ...but it can never publish: it is long expired and names nobody real.
  expectRefusal('GATE_EXPIRED', () =>
    validateGate({
      gate: example,
      role: 'executor',
      executor: example.executor,
      repo: repoFixture({ branch: example.sourceBranch, commits: example.commits, headSha: example.commits[0], baseSha: example.baseSha }),
      nowMs: NOW,
    }));
});

/* ================= END TO END, STILL OFFLINE ================= */

test('the pre-push hook refuses main and master and is executable', async () => {
  const { readFileSync, statSync } = await import('node:fs');
  const hookUrl = new URL('../.githooks/pre-push', import.meta.url);
  const hook = readFileSync(hookUrl, 'utf8');
  assert.match(hook, /refs\/heads\/main/);
  assert.match(hook, /refs\/heads\/master/);
  assert.match(hook, /exit 1/);
  // Honest about its own limits: the remote control is authoritative.
  assert.match(hook, /NOT the authoritative control/);
  assert.ok(statSync(hookUrl).mode & 0o111, 'the hook must be executable');
});

/* ================= #91 fix-forward: honesty and the new rules ================= */

test('declared role/identity are never presented as authenticated', async () => {
  const { readFileSync } = await import('node:fs');
  const lib = readFileSync(new URL('../src/lib/publish-gate.js', import.meta.url), 'utf8');
  const cmd = readFileSync(new URL('../src/commands/agent-publish.js', import.meta.url), 'utf8');
  for (const source of [lib, cmd]) {
    assert.match(source, /DECLARED|declared/, 'the code must say the claim is declared');
  }
  assert.match(lib, /not mechanical identity separation|guard rail/i);
  // The evidence record labels the claim rather than asserting identity.
  const result = validateGate({ gate: gateFixture(), role: 'executor', executor: 'claude-opus-5', repo: repoFixture(), nowMs: NOW });
  const evidence = evidenceFor(result, { role: 'executor', executor: 'claude-opus-5', at: '2026-07-26T19:00:00Z' });
  assert.ok('declaredRole' in evidence && 'declaredExecutor' in evidence);
  assert.equal(evidence.published, false);
  assert.equal(evidence.stage, 'A-local-validation-only');
});

test('reviewedShas is mandatory and must equal commits exactly and in order', () => {
  const noReview = gateFixture();
  delete noReview.reviewedShas;
  expectRefusal('GATE_INCOMPLETE', () => parseGate(noReview));
  expectRefusal('GATE_INCOMPLETE', () => parseGate(gateFixture({ reviewedShas: [] })));
  expectRefusal('GATE_INCOMPLETE', () => parseGate(gateFixture({ reviewedShas: ['abc1234'] })));
  // extra reviewed sha
  expectRefusal('REVIEW_SET_MISMATCH', () => parseGate(gateFixture({ reviewedShas: [C1, C2, OTHER] })));
  // missing reviewed sha -> an unreviewed commit would ride along
  expectRefusal('REVIEW_SET_MISMATCH', () => parseGate(gateFixture({ reviewedShas: [C1] })));
  // out of order
  expectRefusal('REVIEW_SET_MISMATCH', () => parseGate(gateFixture({ reviewedShas: [C2, C1] })));
});

test('a newer origin/main invalidates a remote publication', () => {
  expectRefusal('REMOTE_BASE_DRIFT', () =>
    validateGate({ gate: gateFixture(), role: 'executor', executor: 'claude-opus-5', repo: repoFixture({ remoteBaseSha: OTHER }), nowMs: NOW }));
});

test('remote-base currency and replay are DEFERRED, and say so instead of pretending', () => {
  const first = validateGate({ gate: gateFixture(), role: 'executor', executor: 'claude-opus-5', repo: repoFixture(), nowMs: NOW });
  assert.ok(first.advisories.some((a) => /Stage A does not consume a gate/.test(a)));
  assert.ok(first.advisories.some((a) => /LOCAL ref and may be stale/.test(a)));
  // Replay is genuinely NOT prevented in Stage A — this asserts the honest current behaviour so a
  // future Stage B change that adds consumption must update this test deliberately.
  const second = validateGate({ gate: gateFixture(), role: 'executor', executor: 'claude-opus-5', repo: repoFixture(), nowMs: NOW });
  assert.equal(second.gate.gateId, first.gate.gateId, 'the same gate validates twice: Stage B owns consumption');
  // With no local knowledge of the remote, that is reported rather than assumed fine.
  const blind = validateGate({ gate: gateFixture(), role: 'executor', executor: 'claude-opus-5', repo: repoFixture({ remoteBaseSha: null }), nowMs: NOW });
  assert.ok(blind.advisories.some((a) => /deferred to Stage B/.test(a)));
});

test('gateId containing credential material is refused and never echoed', () => {
  for (const bad of ['ghp_abcdefghijklmnop', 'gate-token-91', 'bearer-gate', 'gate-secret', 'AKIAIOSFODNN7EXAMPLE'.toLowerCase()]) {
    const err = expectRefusal('GATE_METADATA_UNSAFE', () => parseGate(gateFixture({ gateId: bad })));
    assert.ok(!err.message.includes(bad), 'the refused value must not be echoed back');
  }
  // shape/length limits
  expectRefusal('GATE_INCOMPLETE', () => parseGate(gateFixture({ gateId: 'ab' })));
  expectRefusal('GATE_INCOMPLETE', () => parseGate(gateFixture({ gateId: 'A'.repeat(65) })));
  expectRefusal('GATE_INCOMPLETE', () => parseGate(gateFixture({ gateId: 'Gate With Spaces' })));
});

test('timestamps must be strict RFC3339 and the TTL is bounded', () => {
  for (const bad of ['2026-07-26', '2026-07-26 18:00:00', 'yesterday', '2026-07-26T18:00:00']) {
    expectRefusal('GATE_INCOMPLETE', () =>
      validateGate({ gate: gateFixture({ approvedAt: bad }), role: 'executor', executor: 'claude-opus-5', repo: repoFixture(), nowMs: NOW }));
  }
  expectRefusal('GATE_TTL_TOO_LONG', () =>
    validateGate({
      gate: gateFixture({ expiresAt: '2026-07-28T18:00:00Z' }),
      role: 'executor', executor: 'claude-opus-5', repo: repoFixture(), nowMs: NOW,
    }));
  // an offset form is accepted
  validateGate({
    gate: gateFixture({ approvedAt: '2026-07-26T15:00:00-03:00', expiresAt: '2026-07-26T19:00:00-03:00' }),
    role: 'executor', executor: 'claude-opus-5', repo: repoFixture(), nowMs: NOW,
  });
});

test('a branch checked out in two worktrees fails closed', () => {
  expectRefusal('WORKTREE_SHARED', () =>
    validateGate({
      gate: gateFixture(),
      role: 'executor', executor: 'claude-opus-5',
      repo: repoFixture({ worktrees: [
        { path: '/w/a', branch: 'task/91-role-separated-publication' },
        { path: '/w/b', branch: 'task/91-role-separated-publication' },
      ] }),
      nowMs: NOW,
    }));
});

test('unobservable worktrees and a missing handoff are reported as convention, not claimed', () => {
  const result = validateGate({
    gate: gateFixture(),
    role: 'executor', executor: 'claude-opus-5',
    repo: repoFixture({ worktrees: undefined, handoffPresent: false }),
    nowMs: NOW,
  });
  assert.ok(result.advisories.some((a) => /not observable.*local convention/i.test(a)));
  assert.ok(result.advisories.some((a) => /ownership is by convention only/.test(a)));
});

test('the REAL CLI refuses a forbidden role before loading .env, reading a gate or running git', async () => {
  const { execFileSync } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const cli = fileURLToPath(new URL('../bin/cli.js', import.meta.url));
  for (const role of ['architect', 'reviewer']) {
    let status = 0;
    let stderr = '';
    try {
      execFileSync(process.execPath, [cli, 'agent-publish', '--role', role, '--executor', 'x', '--gate', '/nonexistent'], {
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      status = err.status;
      stderr = String(err.stderr ?? '');
    }
    assert.equal(status, 2, `${role} must exit 2 from the real entrypoint`);
    assert.match(stderr, /ROLE_FORBIDDEN/);
    assert.match(stderr, /No \.env was loaded, no gate was read and no git command ran/);
  }
});

test('Stage A promises no publisher: no push, PR or merge capability exists in the command', async () => {
  const { readFileSync } = await import('node:fs');
  const raw = readFileSync(new URL('../src/commands/agent-publish.js', import.meta.url), 'utf8');
  // Strip comments so prose ABOUT the prohibition cannot satisfy or trip the check.
  const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

  // No git write verbs reachable as arguments.
  for (const verb of ['push', 'commit', 'merge', 'rebase', 'reset', 'tag']) {
    assert.ok(!new RegExp(`['\"\`]${verb}['\"\`]`).test(code), `Stage A must not invoke git ${verb}`);
  }
  // No GitHub API surface of any kind.
  for (const api of ['octokit', 'api.github.com', 'pulls', 'pull_request', 'createPullRequest', 'gh pr']) {
    assert.ok(!code.toLowerCase().includes(api.toLowerCase()), `Stage A must not reach ${api}`);
  }
  // No network primitives and no injected publisher seam left behind.
  for (const net of ['fetch(', 'https.request', 'http.request', 'publish:', 'deps.publish']) {
    assert.ok(!code.includes(net), `Stage A must not contain ${net}`);
  }
  // ...and it says what it is.
  assert.match(raw, /LOCAL PRE-FLIGHT VALIDATION ONLY/);
});
test('documentation contains no permitted "git push origin main" instruction', async () => {
  const { readFileSync } = await import('node:fs');
  for (const rel of ['../.agent-handoff/COMMANDS.md', '../.agent-handoff/README.md', '../AGENTS.md']) {
    const text = readFileSync(new URL(rel, import.meta.url), 'utf8');
    for (const line of text.split('\n')) {
      if (!line.includes('git push origin main')) continue;
      // Only the incident narrative may mention it, never as an instruction.
      assert.match(line, /incident|architect|never|refused|not allowed/i, `permitted push instruction found: ${line}`);
    }
  }
});
