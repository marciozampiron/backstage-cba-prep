// Persistence boundary for the web simulation state (slice 4a, #42).
//
// This is the repository PORT: the store (application layer) is its only caller — route handlers
// and React pages never import it. Records are plain JSON-serializable objects, keyed by id and
// scoped by learnerId, so a managed adapter (DynamoDB on AWS per ADR-0002) can replace the local
// ones without touching the store, the routes, or the frontend. Review-state records ride the same
// boundary when the review-progress feature lands.
//
// Adapters:
//   - InMemorySimulationRepository — ephemeral (per process); used by the deterministic smokes.
//   - FileSimulationRepository — restart-safe local pilot store: JSON file, atomic write-through
//     (tmp + rename), corrupt-file tolerant.
//
// Selection: CBA_WEB_STORE=file|memory (default file), CBA_WEB_DATA_DIR (default <web>/.data).
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';

function emptyState() {
  return { counter: 0, sessions: {}, attempts: {}, mocks: {} };
}

export class InMemorySimulationRepository {
  constructor() {
    this.state = emptyState();
  }

  /** Write-through hook — no-op in memory. */
  persist() {}

  nextId(prefix) {
    this.state.counter += 1;
    const id = `${prefix}_${this.state.counter.toString(36)}${Date.now().toString(36).slice(-4)}`;
    this.persist();
    return id;
  }

  getSession(practiceSessionId) {
    return this.state.sessions[practiceSessionId] ?? null;
  }

  saveSession(session) {
    this.state.sessions[session.practiceSessionId] = session;
    this.persist();
  }

  getAttempt(attemptId) {
    return this.state.attempts[attemptId] ?? null;
  }

  saveAttempt(attempt) {
    this.state.attempts[attempt.attemptId] = attempt;
    this.persist();
  }

  listAttempts(learnerId) {
    return Object.values(this.state.attempts).filter((a) => a.learnerId === learnerId);
  }

  getMock(mockExamId) {
    return this.state.mocks[mockExamId] ?? null;
  }

  saveMock(mock) {
    this.state.mocks[mock.mockExamId] = mock;
    this.persist();
  }

  listMocks(learnerId) {
    return Object.values(this.state.mocks).filter((m) => m.learnerId === learnerId);
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
    }
  }

  persist() {
    const tmp = `${this.filePath}.tmp`;
    writeFileSync(/*turbopackIgnore: true*/ tmp, JSON.stringify(this.state));
    renameSync(/*turbopackIgnore: true*/ tmp, this.filePath);
  }
}

const globalKey = Symbol.for('cba.simulationRepository');

function dataFilePath() {
  const custom = process.env.CBA_WEB_DATA_DIR;
  if (custom) {
    // Dynamic by design (smokes point this at temp dirs); excluded from build-time file tracing.
    const dir = path.resolve(/*turbopackIgnore: true*/ process.cwd(), custom);
    return path.join(/*turbopackIgnore: true*/ dir, 'simulation.json');
  }
  // Statically scoped default: <web>/.data/simulation.json.
  return path.join(process.cwd(), '.data', 'simulation.json');
}

export function getRepository() {
  if (!globalThis[globalKey]) {
    const mode = process.env.CBA_WEB_STORE ?? 'file';
    globalThis[globalKey] =
      mode === 'memory'
        ? new InMemorySimulationRepository()
        : new FileSimulationRepository(dataFilePath());
  }
  return globalThis[globalKey];
}
