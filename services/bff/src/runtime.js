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
  if (config.store === 'memory') return new InMemorySimulationRepository();
  if (config.store === 'file') return new FileSimulationRepository(dataFilePath(config.dataDir));
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
    },
  });
}

/** Test/composition hook: inject a repository and/or a clock. */
export function configureRuntime({ repository, now } = {}) {
  if (repository !== undefined) state.repository = repository;
  if (now !== undefined) state.now = now;
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
