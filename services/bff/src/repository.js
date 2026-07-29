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
import { parseInstant } from './instant.js';
import path from 'node:path';

/** Storage-level optimistic-concurrency violation — NEUTRAL port error (any adapter may raise
 *  it); the dispatcher maps it to 409 CONFLICT. Lives here so application code never imports
 *  from an infrastructure adapter. */
/**
 * How long a smoke-scoped CHILD record lives (#75 R6, parcel 1).
 *
 * Lives here rather than in the application layer because the repository owns the anchor: a value a
 * caller can set is not a retention bound, it is a suggestion.
 */
export const SMOKE_CHILD_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Is this child visible to ORDINARY reads?
 *
 * A record with no `runId` is an ordinary learner's and is never filtered. A stamped one is hidden
 * once its anchor has passed — and hidden too when the anchor is missing or malformed, because an
 * unreadable bound is not the absence of one. Failing closed costs a test its data; failing open is
 * confidential data with no bound.
 */
export function smokeChildVisible(record, nowMs) {
  if (!record?.runId) return true;
  const until = parseInstant(record.retainUntil);
  return until !== null && nowMs < until;
}

/**
 * The retention anchor to persist, or a refusal — ONE rule, shared by every adapter.
 *
 * The distinction that matters is "this item does not exist yet" versus "this item exists and its
 * anchor is unreadable". Only the first may be stamped. Treating the second as new silently
 * RESTARTS retention on a legacy, partially written or corrupted row, so confidential data outlives
 * the bound it was written under — reached by nothing more than a later ordinary write.
 *
 * An existing row with a broken anchor is therefore refused. It stays exactly where it was: hidden
 * from ordinary reads and fully visible to cleanup, which is the only thing that should touch it.
 */
export function resolveChildAnchor({ exists, existing, nowMs }) {
  if (!exists) return new Date(nowMs + SMOKE_CHILD_RETENTION_MS).toISOString();
  const stored = existing?.retainUntil;
  if (parseInstant(stored) === null) {
    // A distinguishable reason: a caller (and a test) must be able to tell this apart from a lost
    // update, which is a different failure with a different remedy.
    const err = new RepositoryConflictError(
      'This record has no readable retention anchor and cannot be rewritten; only cleanup may touch it.',
    );
    err.reason = 'RETENTION_ANCHOR_UNREADABLE';
    throw err;
  }
  return stored;
}

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
  /** @param {{ now?: () => number }} [opts] injected clock — retention is never read from Date.now */
  constructor({ now } = {}) {
    this.state = emptyState();
    // Whether a clock was EXPLICITLY supplied is the thing composition needs to know. A `typeof`
    // check cannot tell: the default is also a function, so an adapter that never received a clock
    // is indistinguishable from one that did.
    this.hasExplicitClock = now !== undefined;
    this.now = now ?? (() => Date.now());
  }

  /**
   * Adopt the composition's clock, unless this adapter was built with one of its own.
   *
   * Explicit rather than inferred: the application and the repository must evaluate the same write
   * boundary on the same instant, and a repository silently left on wall time would accept a write
   * the application had already ruled out.
   */
  bindClock(now) {
    if (typeof now !== 'function') throw new Error('bindClock requires a clock function.');
    if (this.hasExplicitClock) return false;
    this.now = now;
    return true;
  }

  /** Write-through hook — no-op in memory. */
  persist() {}

  async nextId(prefix) {
    this.state.counter += 1;
    const id = `${prefix}_${this.state.counter.toString(36)}${Date.now().toString(36).slice(-4)}`;
    this.persist();
    return id;
  }

  /* ORDINARY reads are filtered (#75 R6). Cleanup uses the RAW path below — reusing a filtered read
     there would let verification report zero while the rows sat in the table. */
  async getSession(practiceSessionId) {
    const found = this.state.sessions[practiceSessionId] ?? null;
    return smokeChildVisible(found, this.now()) ? found : null;
  }

  async saveSession(session) {
    this.#assertRunAccepts(session);
    this.state.sessions[session.practiceSessionId] =
      this.#withAnchor(session, this.state.sessions[session.practiceSessionId]);
    this.persist();
  }

  /**
   * Refuse any write carrying a run id whose run is no longer active (#75).
   *
   * Enforced HERE rather than at each call site, because fencing call sites closes instances while
   * this closes the CLASS. Creation was fenced and updates were not, so an answer written after
   * cleanup could reinsert an attempt the cleanup had already verified gone — and every future
   * write path would have had to remember the rule.
   */
  /**
   * Return the record to persist, with the retention anchor the REPOSITORY owns.
   *
   * Write-once: on create it is stamped from the injected clock; on update the stored anchor is
   * rewritten verbatim and the incoming value is ignored entirely rather than trusted. A caller
   * that could extend it — or drop it — would be setting its own retention.
   */
  #withAnchor(record, existing) {
    if (!record?.runId) return record;
    return {
      ...record,
      retainUntil: resolveChildAnchor({
        exists: existing !== undefined,
        existing,
        nowMs: this.now(),
      }),
    };
  }

  #assertRunAccepts(record) {
    if (!record?.runId) return;
    const run = this.state.smokeRuns[record.runId];
    // Status AND the write deadline, together. They are the same question asked about time, and
    // checking one here while the other is checked in the dispatcher leaves a window a request can
    // cross. A malformed deadline fails closed — an unreadable bound is not the absence of one.
    const deadline = parseInstant(run?.writeDeadlineAt);
    if (!run || run.status !== 'active' || deadline === null || this.now() >= deadline) {
      throw new RepositoryConflictError('This smoke run stopped accepting records.');
    }
  }

  async getAttempt(attemptId) {
    const found = this.state.attempts[attemptId] ?? null;
    return smokeChildVisible(found, this.now()) ? found : null;
  }

  async saveAttempt(attempt) {
    this.#assertRunAccepts(attempt);
    this.state.attempts[attempt.attemptId] =
      this.#withAnchor(attempt, this.state.attempts[attempt.attemptId]);
    this.persist();
  }

  async listAttempts(learnerId) {
    const at = this.now();
    return Object.values(this.state.attempts)
      .filter((a) => a.learnerId === learnerId)
      .filter((a) => smokeChildVisible(a, at));
  }

  async getMock(mockExamId) {
    const found = this.state.mocks[mockExamId] ?? null;
    return smokeChildVisible(found, this.now()) ? found : null;
  }

  async saveMock(mock) {
    this.#assertRunAccepts(mock);
    this.state.mocks[mock.mockExamId] =
      this.#withAnchor(mock, this.state.mocks[mock.mockExamId]);
    this.persist();
  }

  async listMocks(learnerId) {
    const at = this.now();
    return Object.values(this.state.mocks)
      .filter((m) => m.learnerId === learnerId)
      .filter((m) => smokeChildVisible(m, at));
  }

  /* One-active-mock claim (#77): the ATOMIC per-learner guard the store relies on instead of
     list-then-create. Local adapters are single-process, so a plain check-and-set is atomic
     enough here; the DynamoDB adapter implements the same contract with a conditional write. */
  async claimActiveMock(learnerId, mockExamId, { runId = null } = {}) {
    // The run is passed EXPLICITLY. The first attempt at this fence looked the run up from the mock
    // record — but `startMockExam` claims BEFORE saving that mock, so the lookup was always
    // undefined and the fence checked nothing at all. A guard that cannot see its subject is not a
    // guard.
    this.#assertRunAccepts({ runId });
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

  /**
   * Write a smoke-scoped record ONLY while its run is still active.
   *
   * The dispatcher's `RUN_CLOSED` check happens before the handler runs, so on its own it is a
   * time-of-check/time-of-use gap: a write that passed the check can still commit after cleanup
   * reported success, leaving records the run swore were gone. The state test therefore has to
   * happen AT the write. In this single-process adapter check-and-write is atomic by construction;
   * the managed adapter uses a transaction with a condition check on the run item.
   */
  async saveSmokeScopedRecord({ runId, kind, record }) {
    const save = { session: 'saveSession', mock: 'saveMock', attempt: 'saveAttempt' }[kind];
    if (!save) throw new Error(`unknown smoke-scoped record kind "${kind}"`);
    try {
      await this[save]({ ...record, runId });
      return true;
    } catch (err) {
      if (err instanceof RepositoryConflictError) return false;
      throw err;
    }
  }

  /** Move a run to `closing` so in-flight writes can no longer commit into it. */
  async closeSmokeRun(runId) {
    const run = this.state.smokeRuns[runId];
    if (!run) return null;
    if (run.status === 'active') run.status = 'closing';
    this.persist();
    return run;
  }

  /**
   * Mark a run completed — a TOMBSTONE, never a deletion.
   *
   * Separate from `deleteSmokeRunData` on purpose: the use case calls this only after it has proven
   * zero leftovers. Finalizing inside the delete marked a run complete while a projection was still
   * pending and before anything was verified, so a failure in between produced a run that looked
   * finished and was not.
   */
  async completeSmokeRun({ runId, completedAt, expiresAt }) {
    const run = this.state.smokeRuns[runId];
    if (!run) return null;
    // FIRST completion wins for both fields. Recomputing the expiry on every replay slid the
    // tombstone forward — a replay on day six moved it from day seven to day thirteen, so repeated
    // replays could retain it indefinitely. Retention is measured from when the run finished, not
    // from the last time somebody asked about it.
    run.completedAt = run.completedAt ?? completedAt;
    run.expiresAt = run.expiresAt ?? expiresAt;
    run.status = 'completed';
    this.persist();
    return run;
  }

  /**
   * RAW children matching learner + run — expired ones included, by design.
   *
   * Named and separate so it is asked for deliberately. Cleanup's job is to delete rows that
   * ordinary reads already hide; if it shared their filter it would report a clean run while the
   * data remained, and the verification would be measuring its own blindfold.
   */
  async rawSmokeChildren({ learnerId, runId }) {
    const owns = (r) => r && r.learnerId === learnerId && r.runId === runId;
    return {
      sessions: Object.values(this.state.sessions).filter(owns),
      mocks: Object.values(this.state.mocks).filter(owns),
      attempts: Object.values(this.state.attempts).filter(owns),
    };
  }

  /** Records still matching learner + run, per class. Zero everywhere is the only proof of a
      COMPLETE cleanup: counting what was deleted cannot distinguish "nothing existed" from
      "something survived contention". */
  async countSmokeRunRecords({ learnerId, runId }) {
    const raw = await this.rawSmokeChildren({ learnerId, runId });
    return {
      practiceSessions: raw.sessions.length,
      mockExams: raw.mocks.length,
      attempts: raw.attempts.length,
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
  /** Forwards the composition-owned clock: an adapter on wall time fences on a different instant
      than the use case that asked it to. */
  constructor(filePath, { now } = {}) {
    super({ now });
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
