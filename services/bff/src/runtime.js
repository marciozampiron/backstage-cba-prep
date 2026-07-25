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

const globalKey = Symbol.for('cba.bffRuntime');
if (!globalThis[globalKey]) {
  globalThis[globalKey] = { repository: null, now: () => Date.now() };
}
const state = globalThis[globalKey];

function createRepositoryFromEnv() {
  const config = resolveRuntimeConfig();
  if (config.store === 'memory') return new InMemorySimulationRepository();
  if (config.store === 'file') return new FileSimulationRepository(dataFilePath(config.dataDir));
  // dynamodb: the infrastructure adapter is constructed here (Stage B) — the application layer
  // below this seam never learns which adapter it got.
  throw new Error(
    `store "${config.store}" has no adapter wired in this build (dynamodb arrives with the ` +
      'DynamoDB infrastructure adapter).',
  );
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
