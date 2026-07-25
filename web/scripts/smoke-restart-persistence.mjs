// Regression smoke (#42, slice 4a; lifecycle hardened in #80): attempts must survive a REAL
// server restart through the file adapter of the repository boundary. Self-orchestrating: boots
// the Next server twice on a temp data dir and proves boot 2 is a different process.
//
// Process ownership rules (#80):
//   - the server is spawned DIRECTLY (node_modules/.bin/next, no npx wrapper) in its OWN process
//     group (detached), so stopping it kills the whole owned tree — and nothing else;
//   - the script fails fast if the port is already occupied (never reuses an unknown listener);
//   - stop = SIGTERM the group -> await the child exit -> escalate SIGKILL -> require the port
//     to be CLOSED before boot 2 and before the script finishes;
//   - try/finally guarantees the owned processes and the temp data dir are cleaned up on every
//     path, and cleanup failure fails the smoke visibly. No pkill of any kind.
//
// Run from web/ after `npm run build`:  node scripts/smoke-restart-persistence.mjs
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const PORT = Number(process.env.PORT ?? 3017);
// One host everywhere (#80 review): requests, the preflight probe, and the server bind all use
// 127.0.0.1 — an IPv6 listener on ::1 can no longer slip past the preflight or receive traffic.
const HOST = '127.0.0.1';
const BASE = `http://${HOST}:${PORT}`;
const NEXT_BIN = path.join(process.cwd(), 'node_modules', '.bin', 'next');
const dataDir = mkdtempSync(path.join(os.tmpdir(), 'cba-web-data-'));

let failures = 0;
const ok = (cond, label) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`);
  if (!cond) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const j = async (p, init) => {
  const res = await fetch(BASE + p, init);
  return { status: res.status, body: await res.json() };
};
const post = (p, body) =>
  j(p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

/* ---------------- owned-process lifecycle ---------------- */

function portInUse() {
  return new Promise((resolve) => {
    const sock = net.connect({ port: PORT, host: HOST });
    sock.once('connect', () => {
      sock.destroy();
      resolve(true);
    });
    sock.once('error', () => resolve(false));
  });
}

async function waitPortClosed(seconds) {
  for (let i = 0; i < seconds * 2; i++) {
    if (!(await portInUse())) return true;
    await sleep(500);
  }
  return false;
}

function startServer() {
  // detached => new process group whose pgid == child.pid: the whole Next tree (CLI + the real
  // next-server it forks) is ours to signal via -pid, and ONLY ours.
  const child = spawn(NEXT_BIN, ['start', '-H', HOST, '-p', String(PORT)], {
    cwd: process.cwd(),
    env: { ...process.env, CBA_WEB_STORE: 'file', CBA_WEB_DATA_DIR: dataDir },
    stdio: 'ignore',
    detached: true,
  });
  child.exited = new Promise((resolve) => child.once('exit', () => resolve(true)));
  return child;
}

function signalGroup(child, signal) {
  try {
    process.kill(-child.pid, signal); // own group only — never a broad pkill
    return true;
  } catch {
    return false; // group already gone
  }
}

async function waitExit(child, ms) {
  return Promise.race([child.exited, sleep(ms).then(() => false)]);
}

async function stopServer(child) {
  signalGroup(child, 'SIGTERM');
  let exited = await waitExit(child, 10_000);
  if (!exited) {
    signalGroup(child, 'SIGKILL');
    exited = await waitExit(child, 5_000);
  }
  const closed = await waitPortClosed(15);
  return { exited, closed };
}

async function waitReady() {
  for (let i = 0; i < 30; i++) {
    try {
      const res = await fetch(`${BASE}/api/dashboard`);
      if (res.ok) return true;
    } catch {
      /* not up yet */
    }
    await sleep(1000);
  }
  return false;
}

/* ---------------- the smoke ---------------- */

let server = null;
try {
  // Never adopt an unknown listener: an occupied port is an environment error, not a pass.
  if (await portInUse()) {
    ok(false, `port ${PORT} is free before boot 1 (occupied — refusing to reuse an unknown listener)`);
  } else {
    ok(true, `port ${PORT} is free before boot 1`);

    // ---- boot 1: create a completed drill ----
    server = startServer();
    const pid1 = server.pid;
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

    const stop1 = await stopServer(server);
    ok(stop1.exited, 'boot 1 stopped: owned process tree exited');
    ok(stop1.closed, `boot 1 stopped: port ${PORT} closed before boot 2`);
    if (!stop1.exited || !stop1.closed) {
      // Keep the server reference alive so finally can retry the owned-group cleanup.
      throw new Error('boot 1 shutdown incomplete — aborting to cleanup');
    }
    server = null;
    console.log('--- server stopped, restarting on the same data dir ---');

    // ---- boot 2: a DIFFERENT process must see the persisted state ----
    server = startServer();
    ok(server.pid !== pid1, `boot 2: distinct process (pid ${server.pid} != ${pid1})`);
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

    const stop2 = await stopServer(server);
    ok(stop2.exited && stop2.closed, `boot 2 stopped: process exited and port ${PORT} closed`);
    if (!stop2.exited || !stop2.closed) {
      throw new Error('boot 2 shutdown incomplete — aborting to cleanup');
    }
    server = null;
  }
} catch (err) {
  failures++;
  console.error('FAIL  unexpected error:', err);
} finally {
  // Cleanup is part of the contract: leftover processes or data dirs fail the smoke visibly.
  if (server) {
    const stop = await stopServer(server);
    if (!stop.exited || !stop.closed) {
      failures++;
      console.error(`FAIL  cleanup: owned server tree still alive or port ${PORT} still open`);
    }
  }
  try {
    rmSync(dataDir, { recursive: true, force: true });
    if (existsSync(dataDir)) throw new Error('data dir still present');
  } catch (err) {
    failures++;
    console.error('FAIL  cleanup: temp data dir not removed:', err.message);
  }
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
