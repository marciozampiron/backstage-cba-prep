import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { c } from '../lib/ui.js';

const HANDOFF_DIR = '.agent-handoff';
const REQUIRED_FILES = [
  'AGENTS.md',
  '.agent-handoff/README.md',
  '.agent-handoff/CURRENT.md',
  '.agent-handoff/EVENTS.md',
];

function defaultRunGit(args, { cwd }) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function readText(fsImpl, file) {
  return fsImpl.readFileSync(file, 'utf8');
}

function exists(fsImpl, file) {
  try {
    fsImpl.accessSync(file);
    return true;
  } catch {
    return false;
  }
}

function listActiveFiles(fsImpl, dir) {
  if (!exists(fsImpl, dir)) return [];
  return fsImpl
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name !== '.gitkeep')
    .map((entry) => path.join(dir, entry.name).replace(/\\/g, '/'))
    .sort();
}

function runGitSafe(runGit, args, cwd) {
  try {
    return { ok: true, value: runGit(args, { cwd }) };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
}

function parseOriginMainSha(currentText) {
  const match = currentText.match(/`origin\/main`\s+includes\s+`([0-9a-f]{7,40})/i);
  return match ? match[1] : null;
}

function parseLocalMainHardcodedSha(currentText) {
  const match = currentText.match(/Local\s+`main`[^\n]*`([0-9a-f]{7,40})/i);
  return match ? match[1] : null;
}

function shortShaMatches(a, b) {
  if (!a || !b) return true;
  return a.startsWith(b) || b.startsWith(a);
}

function eventTimestamp(now) {
  return now().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function eventList(label, values) {
  if (!values.length) return `- ${label}: none`;
  return [`- ${label}:`, ...values.map((value) => `  - ${value}`)].join('\n');
}

function prependEvent(fsImpl, file, entry) {
  const current = exists(fsImpl, file) ? readText(fsImpl, file) : '# Agent Coordination Events\n\n';
  const marker = 'Append meaningful coordination changes here. Newest entries should go at the top.\n\n';
  if (current.includes(marker)) return current.replace(marker, marker + entry);
  return `${current.trimEnd()}\n\n${entry}`;
}

function recordAgentRefreshEvent({ cwd, fsImpl, report, now }) {
  const eventsPath = path.join(cwd, HANDOFF_DIR, 'EVENTS.md');
  const entry = `## ${eventTimestamp(now)} — agent-refresh --record\n\n${[
    `- Status: ${report.ok ? 'ok' : 'blocked'}`,
    `- Git: ${report.git.status.split('\n')[0] || 'unknown'}`,
    eventList('Unpublished commits', report.git.unpublishedCommits),
    eventList('Active handoffs', report.handoff.activeFiles),
    eventList('Warnings', report.warnings),
    eventList('Errors', report.errors),
  ].join('\n')}\n\n`;
  fsImpl.writeFileSync(eventsPath, prependEvent(fsImpl, eventsPath, entry));
  return path.relative(cwd, eventsPath).replace(/\\/g, '/');
}

export function collectAgentRefresh({ cwd = process.cwd(), fsImpl = fs, runGit = defaultRunGit } = {}) {
  const errors = [];
  const warnings = [];
  const root = cwd;

  const required = REQUIRED_FILES.map((file) => ({ file, exists: exists(fsImpl, path.join(root, file)) }));
  for (const r of required) {
    if (!r.exists) errors.push(`missing required coordination file: ${r.file}`);
  }

  const currentPath = path.join(root, HANDOFF_DIR, 'CURRENT.md');
  const currentText = exists(fsImpl, currentPath) ? readText(fsImpl, currentPath) : '';

  const activeDir = path.join(root, HANDOFF_DIR, 'active');
  const activeFiles = listActiveFiles(fsImpl, activeDir).map((file) => path.relative(root, file).replace(/\\/g, '/'));
  if (activeFiles.length) {
    warnings.push(`active handoff file(s) present: ${activeFiles.join(', ')}`);
  }

  const statusResult = runGitSafe(runGit, ['status', '--short', '--branch'], root);
  const logResult = runGitSafe(runGit, ['log', '--oneline', 'origin/main..HEAD'], root);
  const originResult = runGitSafe(runGit, ['rev-parse', '--short', 'origin/main'], root);

  if (!statusResult.ok) errors.push(`git status failed: ${statusResult.error}`);
  if (!logResult.ok) warnings.push(`git log origin/main..HEAD failed: ${logResult.error}`);
  if (!originResult.ok) warnings.push(`git rev-parse origin/main failed: ${originResult.error}`);

  const gitStatus = statusResult.ok ? statusResult.value : '';
  const unpublishedCommits = logResult.ok && logResult.value ? logResult.value.split('\n').filter(Boolean) : [];
  const originMain = originResult.ok ? originResult.value : null;

  const currentOrigin = parseOriginMainSha(currentText);
  if (currentOrigin && originMain && !shortShaMatches(currentOrigin, originMain)) {
    errors.push(`CURRENT.md origin/main baseline is stale: ${currentOrigin} != ${originMain}`);
  }

  const hardcodedLocal = parseLocalMainHardcodedSha(currentText);
  if (hardcodedLocal) {
    errors.push(
      `CURRENT.md hardcodes unpublished/amendable local commit SHA ${hardcodedLocal}; use git log origin/main..HEAD instead`
    );
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    git: {
      status: gitStatus,
      originMain,
      unpublishedCommits,
      dirty: gitStatus.split('\n').some((line) => line && !line.startsWith('##')),
    },
    handoff: {
      requiredFiles: required,
      activeFiles,
    },
  };
}

function printHuman(report, log) {
  log(c.bold('Agent refresh'));
  log(`  status: ${report.ok ? c.green('ok') : c.red('blocked')}`);
  if (report.git.status) log(`  git: ${report.git.status.split('\n')[0]}`);

  if (report.git.unpublishedCommits.length) {
    log('  unpublished commits:');
    for (const commit of report.git.unpublishedCommits) log(`    - ${commit}`);
  } else {
    log('  unpublished commits: none');
  }

  if (report.handoff.activeFiles.length) {
    log('  active handoffs:');
    for (const file of report.handoff.activeFiles) log(`    - ${file}`);
  } else {
    log('  active handoffs: none');
  }

  if (report.warnings.length) {
    log(c.yellow('  warnings:'));
    for (const warning of report.warnings) log(`    - ${warning}`);
  }

  if (report.errors.length) {
    log(c.red('  errors:'));
    for (const error of report.errors) log(`    - ${error}`);
  }
}

export async function runAgentRefresh({
  json = false,
  record = false,
  cwd = process.cwd(),
  fsImpl = fs,
  runGit = defaultRunGit,
  now = () => new Date(),
  log = console.log,
} = {}) {
  const report = collectAgentRefresh({ cwd, fsImpl, runGit });
  if (record) {
    try {
      report.recorded = recordAgentRefreshEvent({ cwd, fsImpl, report, now });
    } catch (err) {
      report.ok = false;
      report.recorded = null;
      report.errors.push(`failed to record agent-refresh event: ${err?.message || String(err)}`);
    }
  } else {
    report.recorded = null;
  }
  if (json) log(JSON.stringify(report, null, 2));
  else {
    printHuman(report, log);
    if (report.recorded) log(`  recorded: ${report.recorded}`);
  }
  return report.ok ? 0 : 1;
}
