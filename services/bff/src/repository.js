// Persistence boundary for the simulation state (slice 4a, #42; moved from web/lib in #76;
// ASYNC contract since #77 Stage A).
//
// This is the repository PORT: the store (application layer) is its only caller — runtime
// adapters and React pages never import it. EVERY operation returns a Promise, because the
// managed adapter (DynamoDB, #77 Stage B) is asynchronous; the local adapters implement the
// same awaitable contract. Records are plain JSON-serializable objects, keyed by id and scoped
// by learnerId.
//
// Adapters:
//   - InMemorySimulationRepository — ephemeral (per process); used by deterministic tests/smokes.
//   - FileSimulationRepository — restart-safe local store: JSON file, atomic write-through
//     (tmp + rename), corrupt-file tolerant.
//
// Adapter selection lives in the composition seam (runtime.js + config.js), not here.
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';

/** Storage-level optimistic-concurrency violation — NEUTRAL port error (any adapter may raise
 *  it); the dispatcher maps it to 409 CONFLICT. Lives here so application code never imports
 *  from an infrastructure adapter. */
export class RepositoryConflictError extends Error {
  constructor(message) {
    super(message ?? 'Concurrent modification detected.');
    this.name = 'RepositoryConflictError';
  }
}

/** Count the answers a record carries, whatever shape holds them. */
function countAnswers(record) {
  const answers = record?.answers;
  if (Array.isArray(answers)) return answers.filter((a) => a != null).length;
  if (answers && typeof answers === 'object') return Object.keys(answers).length;
  return 0;
}

function emptyState() {
  return { counter: 0, sessions: {}, attempts: {}, mocks: {}, activeMocks: {}, profiles: {}, smokeRuns: {} };
}

export class InMemorySimulationRepository {
  constructor() {
    this.state = emptyState();
  }

  /** Write-through hook — no-op in memory. */
  persist() {}

  async nextId(prefix) {
    this.state.counter += 1;
    const id = `${prefix}_${this.state.counter.toString(36)}${Date.now().toString(36).slice(-4)}`;
    this.persist();
    return id;
  }

  async getSession(practiceSessionId) {
    return this.state.sessions[practiceSessionId] ?? null;
  }

  async saveSession(session) {
    this.state.sessions[session.practiceSessionId] = session;
    this.persist();
  }

  async getAttempt(attemptId) {
    return this.state.attempts[attemptId] ?? null;
  }

  async saveAttempt(attempt) {
    this.state.attempts[attempt.attemptId] = attempt;
    this.persist();
  }

  async listAttempts(learnerId) {
    return Object.values(this.state.attempts).filter((a) => a.learnerId === learnerId);
  }

  async getMock(mockExamId) {
    return this.state.mocks[mockExamId] ?? null;
  }

  async saveMock(mock) {
    this.state.mocks[mock.mockExamId] = mock;
    this.persist();
  }

  async listMocks(learnerId) {
    return Object.values(this.state.mocks).filter((m) => m.learnerId === learnerId);
  }

  /* One-active-mock claim (#77): the ATOMIC per-learner guard the store relies on instead of
     list-then-create. Local adapters are single-process, so a plain check-and-set is atomic
     enough here; the DynamoDB adapter implements the same contract with a conditional write. */
  async claimActiveMock(learnerId, mockExamId) {
    if (this.state.activeMocks[learnerId]) return false;
    this.state.activeMocks[learnerId] = mockExamId;
    this.persist();
    return true;
  }

  async getActiveMock(learnerId) {
    return this.state.activeMocks[learnerId] ?? null;
  }

  async releaseActiveMock(learnerId, mockExamId) {
    if (this.state.activeMocks[learnerId] === mockExamId) {
      delete this.state.activeMocks[learnerId];
      this.persist();
    }
  }

  /* Learner profile (#69 Slice B): the /api/me cache that keeps the identity provider's
     UserInfo endpoint off the per-request path. */
  async getProfile(learnerId) {
    return this.state.profiles[learnerId] ?? null;
  }

  async saveProfile(profile) {
    this.state.profiles[profile.learnerId] = profile;
    this.persist();
  }

  /* Smoke-run records (#75): the BFF-minted proof that a run belongs to a learner. Stored rather
     than claimed, because a Cognito access token cannot carry a per-run value without
     infrastructure this issue may not introduce. */
  async saveSmokeRun(run) {
    this.state.smokeRuns[run.runId] = run;
    this.persist();
  }

  async getSmokeRun(runId) {
    return this.state.smokeRuns[runId] ?? null;
  }

  /** Records still matching learner + run, per class. Zero everywhere is the only proof of a
      COMPLETE cleanup: counting what was deleted cannot distinguish "nothing existed" from
      "something survived contention". */
  async countSmokeRunRecords({ learnerId, runId }) {
    const owns = (r) => r && r.learnerId === learnerId && r.runId === runId;
    return {
      practiceSessions: Object.values(this.state.sessions).filter(owns).length,
      mockExams: Object.values(this.state.mocks).filter(owns).length,
      attempts: Object.values(this.state.attempts).filter(owns).length,
    };
  }

  /**
   * Delete everything a smoke RUN created for a smoke LEARNER (#75).
   *
   * Both bounds are required and neither is optional: `learnerId` says whose records these are and
   * `runId` says which run created them. A record matching only one of the two is left alone —
   * that is what stops one run deleting another run's data, and one learner deleting another's.
   *
   * Idempotent by construction: it deletes what matches and reports what it deleted, so a second
   * call returns the same shape with zeros. Counts are per record class, which is what the #70
   * summary needs to state that cleanup actually removed something.
   */
  async deleteSmokeRunData({ learnerId, runId }) {
    const deleted = { practiceSessions: 0, mockExams: 0, attempts: 0, answers: 0, projections: 0 };
    const owns = (record) => record && record.learnerId === learnerId && record.runId === runId;

    for (const [id, session] of Object.entries(this.state.sessions)) {
      if (!owns(session)) continue;
      // Answers live inside their session/attempt, so they are counted where they are removed —
      // a count of zero answers next to a deleted session would misreport the cleanup.
      deleted.answers += countAnswers(session);
      delete this.state.sessions[id];
      deleted.practiceSessions += 1;
    }
    for (const [id, mock] of Object.entries(this.state.mocks)) {
      if (!owns(mock)) continue;
      deleted.answers += countAnswers(mock);
      delete this.state.mocks[id];
      deleted.mockExams += 1;
    }
    for (const [id, attempt] of Object.entries(this.state.attempts)) {
      if (!owns(attempt)) continue;
      deleted.answers += countAnswers(attempt);
      delete this.state.attempts[id];
      deleted.attempts += 1;
    }

    // The one-active-mock claim is a projection, not a record: it is keyed by learner alone, so it
    // is only released when the mock it points at belonged to this run. Left behind, it would block
    // every future mock for that learner — a smoke that cleans up and then cannot run again.
    const active = this.state.activeMocks[learnerId];
    if (active !== undefined && this.state.mocks[active] === undefined) {
      delete this.state.activeMocks[learnerId];
      deleted.projections += 1;
    }

    // The profile cache is learner-scoped with no run id, so it is removed only once this learner
    // has no records left at all. Deleting it while another run's data survives would corrupt a
    // run this cleanup was never scoped to touch.
    if (this.state.profiles[learnerId] !== undefined && !this.#hasAnyRecords(learnerId)) {
      delete this.state.profiles[learnerId];
      deleted.projections += 1;
    }

    // The run record is NEVER deleted here. Consuming ownership at the end of a successful pass
    // looked tidy and broke replay: a failure after that point left the retry with no way to prove
    // ownership, so it answered 403 — and even on success the second call answered 403 instead of
    // the same result. It becomes a TOMBSTONE instead, so ownership outlives the data and a replay
    // is deterministic.
    const run = this.state.smokeRuns[runId];
    if (run) run.completedAt = run.completedAt ?? new Date().toISOString();

    this.persist();
    return deleted;
  }

  #hasAnyRecords(learnerId) {
    const anyOf = (bag) => Object.values(bag).some((r) => r && r.learnerId === learnerId);
    return anyOf(this.state.sessions) || anyOf(this.state.mocks) || anyOf(this.state.attempts);
  }

  /* Logical readiness only (#77): adapter kind + ready — never physical identifiers. */
  async readiness() {
    return { adapter: 'memory', ready: true };
  }
}

// Runtime-only data paths: the turbopackIgnore comments keep Next's build-time file tracing (NFT)
// from treating these dynamic fs calls as bundle-able imports of the whole project.
export class FileSimulationRepository extends InMemorySimulationRepository {
  constructor(filePath) {
    super();
    this.filePath = filePath;
    mkdirSync(/*turbopackIgnore: true*/ path.dirname(filePath), { recursive: true });
    if (existsSync(/*turbopackIgnore: true*/ filePath)) {
      try {
        this.state = {
          ...emptyState(),
          ...JSON.parse(readFileSync(/*turbopackIgnore: true*/ filePath, 'utf8')),
        };
      } catch {
        // Corrupt state file: keep it aside for inspection and start fresh — never crash the app.
        try {
          renameSync(/*turbopackIgnore: true*/ filePath, `${filePath}.corrupt`);
        } catch {
          /* best effort */
        }
        this.state = emptyState();
      }
      // Legacy files predate activeMocks: rebuild claims from in-progress mock attempts once.
      if (Object.keys(this.state.activeMocks).length === 0) {
        for (const mock of Object.values(this.state.mocks)) {
          const attempt = this.state.attempts[mock.attemptId];
          if (attempt?.status === 'in_progress') this.state.activeMocks[mock.learnerId] = mock.mockExamId;
        }
      }
    }
  }

  async readiness() {
    return { adapter: 'file', ready: true };
  }

  persist() {
    const tmp = `${this.filePath}.tmp`;
    writeFileSync(/*turbopackIgnore: true*/ tmp, JSON.stringify(this.state));
    renameSync(/*turbopackIgnore: true*/ tmp, this.filePath);
  }
}

export function dataFilePath(customDir) {
  if (customDir) {
    // Dynamic by design (smokes point this at temp dirs); excluded from build-time file tracing.
    const dir = path.resolve(/*turbopackIgnore: true*/ process.cwd(), customDir);
    return path.join(/*turbopackIgnore: true*/ dir, 'simulation.json');
  }
  // Statically scoped default: <cwd>/.data/simulation.json.
  return path.join(process.cwd(), '.data', 'simulation.json');
}
