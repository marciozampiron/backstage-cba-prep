// Public surface of the provider-neutral Web BFF service (#76).
// Runtime adapters (Next.js routes, the #78 Lambda adapter, the contract harness) consume
// `handleApiRequest`; the ports are exported for adapter wiring and tests only.
export { handleApiRequest } from './app.js';
export { resolveLearner } from './identity.js';
export { ApiError } from './store.js';
export {
  getRepository,
  InMemorySimulationRepository,
  FileSimulationRepository,
} from './repository.js';
