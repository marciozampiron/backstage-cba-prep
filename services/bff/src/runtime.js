// Composition seam (#77 Stage A): the ONE place where the application's dependencies —
// repository and clock (id generation rides the repository port) — are resolved, and the ONE
// place tests inject fakes. Use cases never construct adapters and never read the wall clock
// directly.
import { resolveRuntimeConfig } from './config.js';
import {
  InMemorySimulationRepository,
  FileSimulationRepository,
  dataFilePath,
} from './repository.js';
import { DynamoDbSimulationRepository, createDynamoDbClient } from './dynamodb-repository.js';

const globalKey = Symbol.for('cba.bffRuntime');
if (!globalThis[globalKey]) {
  globalThis[globalKey] = { repository: null, now: () => Date.now() };
}
const state = globalThis[globalKey];

function createRepositoryFromEnv() {
  const config = resolveRuntimeConfig();
  // ONE clock, owned by composition and shared with the adapter. Without this the application can
  // evaluate a deadline on the injected clock while the repository fence evaluates it on wall time
  // — the fence would be measuring a different instant than the check that led to it.
  const clock = { now: () => state.now() };
  if (config.store === 'memory') return new InMemorySimulationRepository(clock);
  if (config.store === 'file') return new FileSimulationRepository(dataFilePath(config.dataDir), clock);
  // dynamodb (#77 Stage B): the SDK-backed document client is created lazily on first use so the
  // AWS SDK is only ever loaded in a deployed runtime; the application layer below this seam
  // never learns which adapter it got.
  let clientPromise = null;
  const lazy = (method) => async (params) => {
    clientPromise ??= createDynamoDbClient();
    return (await clientPromise)[method](params);
  };
  return new DynamoDbSimulationRepository({
    tableName: config.table,
    client: {
      get: lazy('get'),
      put: lazy('put'),
      update: lazy('update'),
      query: lazy('query'),
      delete: lazy('delete'),
      transactWrite: lazy('transactWrite'),
    },
  });
}

/** Test/composition hook: inject a repository and/or a clock. */
export function configureRuntime({ repository, now } = {}) {
  if (now !== undefined) state.now = now;
  if (repository !== undefined) {
    // A repository injected WITHOUT its own clock is adopted onto the runtime's, so the two can
    // never silently diverge. One that brought its own is left alone — a test may be exercising
    // exactly that skew on purpose.
    if (repository && typeof repository.now !== 'function') repository.now = () => state.now();
    state.repository = repository;
  }
}

/** Reset to environment-driven composition (tests). */
export function resetRuntime() {
  state.repository = null;
  state.now = () => Date.now();
}

export function activeRepository() {
  if (!state.repository) state.repository = createRepositoryFromEnv();
  return state.repository;
}

export const now = () => state.now();
export const nowIso = () => new Date(state.now()).toISOString();
