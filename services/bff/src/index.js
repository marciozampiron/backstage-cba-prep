// Public surface of the provider-neutral Web BFF service (#76; async port + composition seam #77).
// Runtime adapters (Next.js routes, the #78 Lambda adapter, the contract harness) consume
// `handleApiRequest`; the seam and ports are exported for adapter wiring and tests only.
export { handleApiRequest } from './app.js';
export { resolveLearner } from './identity.js';
export { ApiError } from './store.js';
export { resolveRuntimeConfig } from './config.js';
export { configureRuntime, resetRuntime, activeRepository } from './runtime.js';
export {
  InMemorySimulationRepository,
  FileSimulationRepository,
  RepositoryConflictError,
  dataFilePath,
} from './repository.js';
export { DynamoDbSimulationRepository } from './dynamodb-repository.js';
