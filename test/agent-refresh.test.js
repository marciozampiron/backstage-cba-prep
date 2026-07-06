import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { collectAgentRefresh, runAgentRefresh } from '../src/commands/agent-refresh.js';

function tempRepo(currentText) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cba-agent-refresh-'));
  fs.mkdirSync(path.join(root, '.agent-handoff', 'active'), { recursive: true });
  fs.writeFileSync(path.join(root, 'AGENTS.md'), '# Agents\n');
  fs.writeFileSync(path.join(root, '.agent-handoff', 'README.md'), '# Handoff\n');
  fs.writeFileSync(path.join(root, '.agent-handoff', 'CURRENT.md'), currentText);
  fs.writeFileSync(path.join(root, '.agent-handoff', 'EVENTS.md'), '# Events\n');
  fs.writeFileSync(path.join(root, '.agent-handoff', 'active', '.gitkeep'), '');
  return root;
}

function fakeGit(outputs) {
  return (args) => {
    const key = args.join(' ');
    if (!(key in outputs)) throw new Error(`unexpected git call: ${key}`);
    return outputs[key];
  };
}

const current = `# Current Agent Coordination State\n\n## Current baseline\n\n- \`origin/main\` includes \`962300e docs: recreate AWS architecture diagrams for SaaS roadmap (#34)\`.\n- Local \`main\` may be ahead with unpublished handoff-protocol work. Run \`git log --oneline origin/main..HEAD\` to inspect exact local commits.\n`;

test('agent-refresh reports ok handoff state with unpublished local commits', () => {
  const root = tempRepo(current);
  const report = collectAgentRefresh({
    cwd: root,
    runGit: fakeGit({
      'status --short --branch': '## main...origin/main [ahead 1]',
      'log --oneline origin/main..HEAD': 'abc1234 docs: add agent handoff protocol',
      'rev-parse --short origin/main': '962300e',
    }),
  });

  assert.equal(report.ok, true);
  assert.deepEqual(report.errors, []);
  assert.equal(report.git.unpublishedCommits.length, 1);
  assert.equal(report.handoff.activeFiles.length, 0);
});

test('agent-refresh blocks when CURRENT.md origin/main baseline is stale', () => {
  const root = tempRepo(current);
  const report = collectAgentRefresh({
    cwd: root,
    runGit: fakeGit({
      'status --short --branch': '## main...origin/main',
      'log --oneline origin/main..HEAD': '',
      'rev-parse --short origin/main': 'fffffff',
    }),
  });

  assert.equal(report.ok, false);
  assert.ok(report.errors.some((error) => /origin\/main baseline is stale/.test(error)));
});

test('agent-refresh blocks hardcoded unpublished local commit SHAs in CURRENT.md', () => {
  const root = tempRepo(current + '\n- Local `main` is expected to be ahead by `abc1234 docs: add agent handoff protocol`.\n');
  const report = collectAgentRefresh({
    cwd: root,
    runGit: fakeGit({
      'status --short --branch': '## main...origin/main [ahead 1]',
      'log --oneline origin/main..HEAD': 'abc1234 docs: add agent handoff protocol',
      'rev-parse --short origin/main': '962300e',
    }),
  });

  assert.equal(report.ok, false);
  assert.ok(report.errors.some((error) => /hardcodes unpublished/.test(error)));
});

test('agent-refresh --json output is machine-readable', async () => {
  const root = tempRepo(current);
  const lines = [];
  const code = await runAgentRefresh({
    cwd: root,
    json: true,
    log: (line) => lines.push(line),
    runGit: fakeGit({
      'status --short --branch': '## main...origin/main',
      'log --oneline origin/main..HEAD': '',
      'rev-parse --short origin/main': '962300e',
    }),
  });

  assert.equal(code, 0);
  const report = JSON.parse(lines.join('\n'));
  assert.equal(report.ok, true);
  assert.equal(report.git.originMain, '962300e');
});


test('agent-refresh --record appends an explicit audit event', async () => {
  const root = tempRepo(current);
  const lines = [];
  const code = await runAgentRefresh({
    cwd: root,
    record: true,
    now: () => new Date('2026-07-06T12:00:00.000Z'),
    log: (line) => lines.push(line),
    runGit: fakeGit({
      'status --short --branch': '## main...origin/main [ahead 1]',
      'log --oneline origin/main..HEAD': 'abc1234 docs: add agent handoff protocol',
      'rev-parse --short origin/main': '962300e',
    }),
  });

  assert.equal(code, 0);
  assert.ok(lines.some((line) => /recorded: \.agent-handoff\/EVENTS\.md/.test(line)));
  const events = fs.readFileSync(path.join(root, '.agent-handoff', 'EVENTS.md'), 'utf8');
  assert.match(events, /2026-07-06T12:00:00Z — agent-refresh --record/);
  assert.match(events, /Status: ok/);
  assert.match(events, /abc1234 docs: add agent handoff protocol/);
});
