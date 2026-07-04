// Infrastructure adapters for the AgentRunRepository port. Two simple stores for
// the CLI/dev: an in-memory one (default, tests) and a JSON-file one (opt-in
// persistence). No real database, no ORM — just Node built-ins.

import fs from 'node:fs';
import { assertAgentRunRepository } from '../../application/ports/agent-run-repository.js';

export function createInMemoryAgentRunRepository(initial = []) {
  const runs = new Map(initial.map((r) => [r.id, r]));
  return assertAgentRunRepository({
    async save(run) {
      runs.set(run.id, run);
      return run;
    },
    async get(id) {
      return runs.get(id) || null;
    },
    async list() {
      return [...runs.values()];
    },
  });
}

export function createFileAgentRunRepository(file) {
  function readAll() {
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      return Array.isArray(data.runs) ? data.runs : [];
    } catch (err) {
      if (err.code === 'ENOENT') return [];
      throw err;
    }
  }
  function writeAll(runs) {
    fs.writeFileSync(file, `${JSON.stringify({ version: 1, runs }, null, 2)}\n`);
  }
  return assertAgentRunRepository({
    async save(run) {
      const runs = readAll().filter((r) => r.id !== run.id);
      runs.push(run);
      writeAll(runs);
      return run;
    },
    async get(id) {
      return readAll().find((r) => r.id === id) || null;
    },
    async list() {
      return readAll();
    },
  });
}
