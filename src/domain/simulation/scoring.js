export function summarizeResults(results, domains) {
  const per = {};
  for (const domain of domains) per[domain.key] = { name: domain.name, weight: domain.weight, correct: 0, total: 0 };

  let correct = 0;
  let answered = 0;
  for (const result of results) {
    const p = per[result.domainKey];
    if (p) {
      p.total += 1;
      if (result.correct) p.correct += 1;
    }
    if (result.correct) correct += 1;
    if (!result.skipped) answered += 1;
  }

  const total = results.length;
  const pct = total ? Math.round((correct / total) * 100) : 0;
  return { correct, total, answered, pct, per };
}
