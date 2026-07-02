import { DOMAINS } from './blueprint.js';
import { summarizeResults } from '../domain/simulation/scoring.js';

// results: [{ domainKey, correct: boolean, skipped: boolean }]
export function summarize(results) {
  return summarizeResults(results, DOMAINS);
}
