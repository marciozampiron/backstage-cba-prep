// Regression smoke (#42, slice 4a): attempts must survive a server restart through the file
// adapter of the repository boundary. Self-orchestrating: spawns `next start` twice on a temp
// data dir. Run from web/ after `npm run build`:  node scripts/smoke-restart-persistence.mjs
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PORT = Number(process.env.PORT ?? 3017);
const BASE = `http://localhost:${PORT}`;
const dataDir = mkdtempSync(path.join(os.tmpdir(), 'cba-web-data-'));
let failures = 0;
const ok = (cond, label) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`);
  if (!cond) failures++;
};
const j = async (p, init) => {
  const res = await fetch(BASE + p, init);
  return { status: res.status, body: await res.json() };
};
const post = (p, body) =>
  j(p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

function startServer() {
  const child = spawn('npx', ['next', 'start', '-p', String(PORT)], {
    cwd: process.cwd(),
    env: { ...process.env, CBA_WEB_STORE: 'file', CBA_WEB_DATA_DIR: dataDir },
    stdio: 'ignore',
  });
  return child;
}

async function waitReady() {
  for (let i = 0; i < 30; i++) {
    try {
      const res = await fetch(`${BASE}/api/dashboard`);
      if (res.ok) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

async function stopServer(child) {
  child.kill('SIGTERM');
  for (let i = 0; i < 20; i++) {
    try {
      await fetch(`${BASE}/api/dashboard`, { signal: AbortSignal.timeout(500) });
      await new Promise((r) => setTimeout(r, 500));
    } catch {
      return; // port closed
    }
  }
}

// ---- boot 1: create a completed drill ----
let server = startServer();
ok(await waitReady(), 'boot 1: server up (file store, temp data dir)');

let r = await post('/api/practice-sessions', { questionCount: 5 });
ok(r.status === 201, 'boot 1: drill started');
const sessionId = r.body.practiceSessionId;
const attemptId = r.body.attemptId;
for (let i = 0; i < 5; i++) {
  const nxt = await j(`/api/practice-sessions/${sessionId}/next`);
  await post(`/api/practice-sessions/${sessionId}/answers`, {
    index: nxt.body.index,
    questionVersionId: nxt.body.question.questionVersionId,
    selectedOption: 'B',
  });
}
r = await j(`/api/attempts/${attemptId}/results`);
ok(r.status === 200, 'boot 1: drill completed and scored');
const scoreBefore = r.body.score;

await stopServer(server);
console.log('--- server stopped, restarting on the same data dir ---');

// ---- boot 2: state must survive ----
server = startServer();
ok(await waitReady(), 'boot 2: server up again');

r = await j('/api/dashboard');
ok(r.status === 200 && r.body.firstRun === false, 'boot 2: dashboard remembers the learner (not first-run)');
ok(
  r.body.recentAttempts.some((a) => a.attemptId === attemptId),
  'boot 2: attempt survived the restart',
);
r = await j(`/api/attempts/${attemptId}/results`);
ok(
  r.status === 200 && r.body.score.correct === scoreBefore.correct && r.body.score.total === scoreBefore.total,
  'boot 2: identical deterministic score after restart',
);
r = await j(`/api/attempts/${attemptId}/missed?limit=60`);
ok(r.status === 200 && r.body.totalMissed === scoreBefore.total - scoreBefore.correct,
  'boot 2: missed review intact after restart');

await stopServer(server);
rmSync(dataDir, { recursive: true, force: true });

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
