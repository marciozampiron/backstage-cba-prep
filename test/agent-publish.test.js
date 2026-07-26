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
  safeLabel,
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
test('documentation never claims Stage A publishes, authenticates or consumes a gate', async () => {
  const { readFileSync } = await import('node:fs');
  const docs = {
    'COMMANDS.md': '../.agent-handoff/COMMANDS.md',
    'README.md': '../.agent-handoff/README.md',
    'AGENTS.md': '../AGENTS.md',
    'publish-gates/README.md': '../.agent-handoff/publish-gates/README.md',
    'runbook': '../docs/architecture/agent-publication-runbook.md',
  };
  // Forbidden CONCEPTS, not just one string: each is a capability Stage A does not have.
  const forbidden = [
    { label: 'agent pushing main', re: /agent[^.\n]{0,40}(may|can|must)[^.\n]{0,20}push[^.\n]{0,20}main/i },
    { label: 'stage A opening a PR', re: /(command|agent-publish)[^.\n]{0,40}opens? (or updates? )?a pull request/i },
    { label: 'publication authority bound mechanically', re: /publication authority is bound mechanically/i },
    { label: 'removed --dry-run flag', re: /agent-publish[^\n]{0,80}--dry-run/i },
    { label: 'agent-publish refusing to publish (implies it can)', re: /agent-publish[^.\n]{0,30}refuses to publish/i },
  ];
  for (const [name, rel] of Object.entries(docs)) {
    const text = readFileSync(new URL(rel, import.meta.url), 'utf8');
    for (const { label, re } of forbidden) {
      assert.ok(!re.test(text), `${name} still claims: ${label}`);
    }
    for (const line of text.split('\n')) {
      if (!line.includes('git push origin main')) continue;
      // A line may MENTION the command when narrating the incident, prohibiting it, or warning
      // that it is still possible until Stage B. It may never INSTRUCT it.
      assert.match(
        line,
        /incident|architect|never|refused|not allowed|remains possible|must not/i,
        `${name}: permitted push instruction: ${line}`,
      );
    }
  }
  // ...and the honest contract is stated where an agent will actually read it.
  const readme = readFileSync(new URL(docs['README.md'], import.meta.url), 'utf8');
  // Wrapped prose: normalise whitespace before matching so a line break cannot hide the contract.
  const flat = readme.replace(/\s+/g, ' ');
  assert.match(flat, /local advisory pre-flight validation only/i);
  assert.match(flat, /publication and merge are human actions/i);
  assert.match(flat, /never publishes, never opens a pull request, never consumes a gate and never authenticates identity/i);
});

/* ================= #91 round 2: redaction and CLI parsing ================= */

test('caller-supplied values are never echoed in refusals', () => {
  const TOKEN = ['ghp', '_', 'FAKESECRET123456'].join('');
  // role
  const roleErr = expectRefusal('ROLE_UNKNOWN', () => assertPublishingRole(TOKEN));
  assert.ok(!roleErr.message.includes('FAKESECRET'), 'role value echoed');
  // executor
  const execErr = expectRefusal('EXECUTOR_MISMATCH', () =>
    validateGate({ gate: gateFixture(), role: 'executor', executor: TOKEN, repo: repoFixture(), nowMs: NOW }));
  assert.ok(!execErr.message.includes('FAKESECRET'), 'executor value echoed');
  // sourceBranch / targetBranch / observed branch
  const srcErr = expectRefusal('BRANCH_SHAPE', () =>
    validateGate({ gate: gateFixture({ sourceBranch: `feature/${TOKEN}` }), role: 'executor', executor: 'claude-opus-5', repo: repoFixture({ branch: `feature/${TOKEN}` }), nowMs: NOW }));
  assert.ok(!srcErr.message.includes('FAKESECRET'), 'source branch echoed');
  const tgtErr = expectRefusal('TARGET_NOT_MAIN', () =>
    validateGate({ gate: gateFixture({ targetBranch: TOKEN }), role: 'executor', executor: 'claude-opus-5', repo: repoFixture(), nowMs: NOW }));
  assert.ok(!tgtErr.message.includes('FAKESECRET'), 'target branch echoed');
  const obsErr = expectRefusal('BRANCH_MISMATCH', () =>
    validateGate({ gate: gateFixture(), role: 'executor', executor: 'claude-opus-5', repo: repoFixture({ branch: `task/91-${TOKEN}` }), nowMs: NOW }));
  assert.ok(!obsErr.message.includes('FAKESECRET'), 'observed branch echoed');
});

test('safeLabel keeps validated detail and drops anything else', () => {
  assert.equal(safeLabel('task/91-role-separated-publication'), 'task/91-role-separated-publication');
  assert.equal(safeLabel('claude-opus-5'), 'claude-opus-5');
  for (const bad of [['ghp', '_', 'abcdefghij'].join(''), 'a b', 'x'.repeat(65), '', null, 42, 'has;semicolon', 'bearer-thing']) {
    assert.equal(safeLabel(bad), '<redacted>', `safeLabel leaked ${String(bad).slice(0, 20)}`);
  }
});

test('evidence never carries an unsanitized declared identity', () => {
  const TOKEN = ['ghp', '_', 'FAKESECRET123456'].join('');
  const result = validateGate({ gate: gateFixture(), role: 'executor', executor: 'claude-opus-5', repo: repoFixture(), nowMs: NOW });
  const evidence = evidenceFor(result, { role: 'executor', executor: TOKEN, at: '2026-07-26T19:00:00Z' });
  assert.equal(evidence.declaredExecutor, '<redacted>');
  assert.ok(!JSON.stringify(evidence).includes('FAKESECRET'));
});

test('the real CLI redacts a credential-shaped role on stderr', async () => {
  const { execFileSync } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const cli = fileURLToPath(new URL('../bin/cli.js', import.meta.url));
  const TOKEN = ['ghp', '_', 'FAKESECRET123456'].join('');
  let stderr = '';
  let status = 0;
  try {
    execFileSync(process.execPath, [cli, 'agent-publish', '--role', TOKEN, '--executor', 'codex', '--gate', '/does-not-exist'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    status = err.status;
    stderr = `${String(err.stdout ?? '')}${String(err.stderr ?? '')}`;
  }
  assert.equal(status, 2);
  assert.match(stderr, /ROLE_UNKNOWN/);
  assert.ok(!stderr.includes('FAKESECRET'), 'the CLI echoed the credential-shaped role');
});

test('--role=<value> and --role <value> refuse identically, before .env, gate or git', async () => {
  const { execFileSync } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const cli = fileURLToPath(new URL('../bin/cli.js', import.meta.url));
  for (const argv of [
    ['agent-publish', '--role=architect', '--executor=codex', '--gate=/does-not-exist'],
    ['agent-publish', '--role', 'architect', '--executor', 'codex', '--gate', '/does-not-exist'],
  ]) {
    let status = 0;
    let stderr = '';
    try {
      // CBA_AGENT_ROLE=executor proves the ARGUMENT wins: an environment variable cannot smuggle a
      // forbidden role past the pre-loadEnv refusal.
      execFileSync(process.execPath, [cli, ...argv], {
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, CBA_AGENT_ROLE: 'executor' },
      });
    } catch (err) {
      status = err.status;
      stderr = String(err.stderr ?? '');
    }
    assert.equal(status, 2, `${argv[1]} must exit 2`);
    assert.match(stderr, /ROLE_FORBIDDEN/, `${argv[1]} must be refused`);
    // This exact line only exists in the pre-loadEnv path.
    assert.match(stderr, /No \.env was loaded, no gate was read and no git command ran/, `${argv[1]} was refused too late`);
  }
});

/* ================= #91 round 3 ================= */

test('an explicit --role with NO value is refused before .env, gate or git', async () => {
  const { execFileSync } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const cli = fileURLToPath(new URL('../bin/cli.js', import.meta.url));
  let status = 0;
  let stderr = '';
  try {
    // CBA_AGENT_ROLE=executor would previously win, because `--role` with no value parses to
    // `true` and a type check treated that as "no argument given".
    execFileSync(process.execPath, [cli, 'agent-publish', '--role', '--executor', 'codex', '--gate', '/does-not-exist'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, CBA_AGENT_ROLE: 'executor' },
    });
  } catch (err) {
    status = err.status;
    stderr = String(err.stderr ?? '');
  }
  assert.equal(status, 2);
  assert.match(stderr, /ROLE_MISSING/);
  assert.match(stderr, /No \.env was loaded, no gate was read and no git command ran/);
  assert.ok(!/gate|git command ran\. Ask the executor/.test(stderr.replace(/No \.env[^\n]*/g, '')),
    'the late, in-command refusal path must not be the one that fired');
});

test('an explicitly given but malformed role never falls back to the environment', () => {
  for (const malformed of [true, 42, {}, [], null]) {
    expectRefusal('ROLE_MISSING', () => assertPublishingRole(malformed));
  }
});

test('the manifest is a CLOSED schema: unknown fields fail without being echoed', () => {
  const TOKEN = ['ghp', '_', 'FAKESECRET123456'].join('');
  const cases = [
    ['synthetic token', { token: TOKEN }],
    ['nested object', { extra: { nested: TOKEN } }],
    ['array', { extras: [TOKEN] }],
    ['typo of a real field', { reviewedSHA: [C1, C2] }],
    ['plausible-looking addition', { mergeAfter: true }],
  ];
  for (const [label, extra] of cases) {
    const err = expectRefusal('GATE_UNKNOWN_FIELD', () => parseGate(gateFixture(extra)), label);
    assert.ok(!err.message.includes('FAKESECRET'), `${label}: value echoed`);
    for (const key of Object.keys(extra)) {
      assert.ok(!err.message.includes(key), `${label}: field name "${key}" echoed`);
    }
  }
  // POSITIVE CONTROL: the exact allowed set still parses.
  const ok = parseGate(gateFixture());
  assert.deepEqual(Object.keys(ok).sort(), [
    'approvedAt', 'approver', 'baseSha', 'commits', 'executor',
    'expiresAt', 'gateId', 'issue', 'reviewedShas', 'sourceBranch', 'targetBranch',
  ]);
});

test('evidence never gains a field beyond its own fixed shape', () => {
  const result = validateGate({ gate: gateFixture(), role: 'executor', executor: 'claude-opus-5', repo: repoFixture(), nowMs: NOW });
  const evidence = evidenceFor(result, { role: 'executor', executor: 'claude-opus-5', at: '2026-07-26T19:00:00Z' });
  assert.deepEqual(Object.keys(evidence).sort(), [
    'approver', 'baseSha', 'commits', 'declaredExecutor', 'declaredRole', 'gateId',
    'issue', 'merged', 'published', 'sourceBranch', 'stage', 'targetBranch', 'validatedAt',
  ]);
});

test('the gate schema doc says a gate is BOUND to commits, never consumed by them', async () => {
  const { readFileSync } = await import('node:fs');
  const doc = readFileSync(new URL('../.agent-handoff/publish-gates/README.md', import.meta.url), 'utf8')
    .replace(/\s+/g, ' ');
  assert.match(doc, /A gate is bound to a specific commit sequence/i);
  // "consumed" may only appear as a deferred Stage B property, never as Stage A behaviour.
  const consumedClaims = doc.match(/[^.]*\bconsume[sd]?\b[^.]*\./gi) ?? [];
  for (const sentence of consumedClaims) {
    assert.match(sentence, /never consume|Stage B|not.*consume|does not consume/i,
      `gate doc claims consumption as Stage A behaviour: ${sentence.trim()}`);
  }
});

test('the handoff leads with the canonical state, not the superseded first commit', async () => {
  const { readFileSync } = await import('node:fs');
  const raw = readFileSync(new URL('../.agent-handoff/active/91-role-separated-publication.md', import.meta.url), 'utf8');
  const canonicalStart = raw.indexOf('## CANONICAL CURRENT STATE');
  assert.ok(canonicalStart > 0, 'the handoff must carry a canonical current-state section');

  // A cold-start reader must not have to reach the end of the file to learn the real limits.
  const historicalStart = raw.indexOf('## HISTORICAL');
  assert.ok(historicalStart > canonicalStart, 'canonical state must precede any historical section');

  const summary = raw.slice(canonicalStart, historicalStart).replace(/\s+/g, ' ');
  // Superseded concepts must not describe current behaviour in the summary.
  for (const { label, re } of [
    { label: 'a publisher seam', re: /publisher seam|reaches the publisher/i },
    { label: 'the removed --dry-run flag', re: /--dry-run/ },
    { label: 'replay protection as provided', re: /replay protection(?![^.]*not provided)/i },
    { label: 'authenticated identity', re: /authenticated identity(?![^.]*never)/i },
    { label: 'only sanctioned publication path', re: /only sanctioned publication path/i },
  ]) {
    assert.ok(!re.test(summary), `the canonical summary still claims: ${label}`);
  }
  // ...and it states the real limits.
  assert.match(summary, /local advisory pre-flight validation only/i);
  assert.match(summary, /Declared by the caller.*never authenticated/i);
  assert.match(summary, /validated, never consumed/i);
  assert.match(summary, /remains possible until Stage\s*B/i);

  // Every superseded section is labelled as such.
  for (const heading of raw.split('\n').filter((l) => l.startsWith('## '))) {
    if (/first commit|as first written|tests as of/i.test(heading)) {
      assert.match(heading, /HISTORICAL|SUPERSEDED/i, `unlabelled historical section: ${heading}`);
    }
  }
});
