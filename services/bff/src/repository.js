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

function emptyState() {
  return { counter: 0, sessions: {}, attempts: {}, mocks: {} };
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

export function dataFilePath(customDir) {
  if (customDir) {
    // Dynamic by design (smokes point this at temp dirs); excluded from build-time file tracing.
    const dir = path.resolve(/*turbopackIgnore: true*/ process.cwd(), customDir);
    return path.join(/*turbopackIgnore: true*/ dir, 'simulation.json');
  }
  // Statically scoped default: <cwd>/.data/simulation.json.
  return path.join(process.cwd(), '.data', 'simulation.json');
}
