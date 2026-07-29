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
  // VALIDATE AND BIND THE WHOLE CANDIDATE BEFORE COMMITTING ANYTHING. Assigning the clock first and
  // validating afterwards left a refused configuration half-applied: the caller was told the
  // repository was rejected while the new clock — and any repository already bound to it — had
  // already changed underneath them.
  const nextNow = now !== undefined ? now : state.now;
  if (typeof nextNow !== 'function') throw new Error('configureRuntime: now must be a function.');

  if (repository !== undefined && repository !== null) {
    if (typeof repository.bindClock !== 'function') {
      throw new Error('configureRuntime: the repository must implement bindClock(now).');
    }
    // A `false` result means the repository brought its own clock, so it would evaluate the same
    // write boundary at a different instant than the application. Ignoring that was the whole
    // defect: the contract existed and its answer was discarded. Deliberate skew is legitimate,
    // but it belongs outside runtime composition — construct and drive the adapter directly.
    if (!repository.bindClock(() => nextNow())) {
      throw new Error(
        'configureRuntime: this repository carries its own clock and would diverge from the runtime. '
        + 'Exercise deliberate skew outside configureRuntime().',
      );
    }
  }

  // Only now, with nothing left that can fail.
  state.now = nextNow;
  if (repository !== undefined) state.repository = repository;
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
