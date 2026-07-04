// Application port: persistence for agent runs (and their usage). Infrastructure
// implements this — in-memory, file, or a database later. Use cases depend only
// on this shape; no SDK, DB client, or framework leaks into application/domain.

/**
 * @typedef {Object} AgentRunRepository
 * @property {(run: object) => Promise<object>} save   // upsert by run.id
 * @property {(id: string) => Promise<object|null>} get
 * @property {() => Promise<object[]>} list
 */

export function assertAgentRunRepository(repo) {
  if (!repo || typeof repo.save !== 'function' || typeof repo.get !== 'function' || typeof repo.list !== 'function') {
    throw new TypeError('AgentRunRepository must implement async save(run), get(id), list()');
  }
  return repo;
}
