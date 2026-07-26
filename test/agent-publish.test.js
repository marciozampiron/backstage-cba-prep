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

test('a commit added after review is a stale review, not a free ride', () => {
  expectRefusal('REVIEW_STALE', () =>
    validateGate({
      gate: gateFixture({ reviewedShas: [C1] }),
      role: 'executor',
      executor: 'claude-opus-5',
      repo: repoFixture(),
      nowMs: NOW,
    }));
});

/* ================= MANIFEST SHAPE ================= */

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

test('a valid gate reaches the publisher exactly once, with no merge capability', async () => {
  const calls = [];
  const code = await runAgentPublish({
    role: 'executor',
    executor: 'claude-opus-5',
    gate: 'gate.json',
    deps: {
      fs: { readFileSync: () => JSON.stringify(gateFixture()) },
      runGit: (args) => {
        const key = args.join(' ');
        if (key === 'rev-parse --abbrev-ref HEAD') return 'task/91-role-separated-publication';
        if (key === 'rev-parse HEAD') return C2;
        if (key === 'status --porcelain') return '';
        if (key === `rev-list --reverse ${BASE}..HEAD`) return `${C1}\n${C2}`;
        if (key === `merge-base HEAD ${BASE}`) return BASE;
        throw new Error(`unexpected git call: ${key}`);
      },
      now: () => NOW,
      publish: async (payload) => calls.push(payload),
    },
  });
  assert.equal(code, EXIT.OK);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].sourceBranch, 'task/91-role-separated-publication');
  assert.equal(calls[0].targetBranch, 'main');
  assert.equal(calls[0].evidence.merged, false, 'the command has no merge path');
  // Evidence carries decisions and SHAs, never credentials.
  const serialized = JSON.stringify(calls[0].evidence);
  for (const secret of ['token', 'ghp_', 'Bearer', 'password', 'secret']) {
    assert.ok(!serialized.toLowerCase().includes(secret.toLowerCase()), `evidence leaked ${secret}`);
  }
});

test('--dry-run validates without reaching the publisher at all', async () => {
  let reached = false;
  const code = await runAgentPublish({
    role: 'executor',
    executor: 'claude-opus-5',
    gate: 'gate.json',
    dryRun: true,
    deps: {
      fs: { readFileSync: () => JSON.stringify(gateFixture()) },
      runGit: (args) => {
        const key = args.join(' ');
        if (key === 'rev-parse --abbrev-ref HEAD') return 'task/91-role-separated-publication';
        if (key === 'rev-parse HEAD') return C2;
        if (key === 'status --porcelain') return '';
        if (key === `rev-list --reverse ${BASE}..HEAD`) return `${C1}\n${C2}`;
        if (key === `merge-base HEAD ${BASE}`) return BASE;
        throw new Error(`unexpected git call: ${key}`);
      },
      now: () => NOW,
      publish: async () => { reached = true; },
    },
  });
  assert.equal(code, EXIT.OK);
  assert.equal(reached, false, 'a dry run must not contact the remote');
});

/* ================= THE HOOK ================= */

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
