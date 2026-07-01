import { DOMAINS } from './blueprint.js';

// results: [{ domainKey, correct: boolean, skipped: boolean }]
export function summarize(results) {
  const per = {};
  for (const d of DOMAINS) per[d.key] = { name: d.name, weight: d.weight, correct: 0, total: 0 };
  let correct = 0;
  let answered = 0;
  for (const r of results) {
    const p = per[r.domainKey];
    if (p) {
      p.total += 1;
      if (r.correct) p.correct += 1;
    }
    if (r.correct) correct += 1;
    if (!r.skipped) answered += 1;
  }
  const total = results.length;
  const pct = total ? Math.round((correct / total) * 100) : 0;
  return { correct, total, answered, pct, per };
}
