import { DOMAINS } from '../lib/blueprint.js';
import { loadBank } from '../lib/bank.js';
import { c, hr, bar } from '../lib/ui.js';

export function collectStats() {
  const { byDomain } = loadBank();
  let total = 0;
  let budget = 0;
  const domains = [];

  for (const d of DOMAINS) {
    const arr = byDomain[d.key] || [];
    total += arr.length;
    budget += d.target;

    const difficulties = { easy: 0, medium: 0, hard: 0 };
    const competencies = {};
    for (const q of arr) {
      if (difficulties[q.difficulty] != null) difficulties[q.difficulty] += 1;
      competencies[q.competency] = (competencies[q.competency] || 0) + 1;
    }

    domains.push({
      key: d.key,
      name: d.name,
      weight: d.weight,
      target: d.target,
      count: arr.length,
      pctOfTarget: d.target ? Math.round((arr.length / d.target) * 100) : 0,
      difficulties,
      competencies,
    });
  }

  return { total, budget, domains };
}

export function runStats(opts = {}) {
  const stats = collectStats();

  if (opts.json) {
    console.log(JSON.stringify(stats, null, 2));
    return stats;
  }

  console.log('\n  ' + c.bold('CBA question bank — coverage'));
  console.log(hr());

  for (const d of stats.domains) {
    console.log('\n  ' + c.bold(d.name) + ' ' + c.gray('· ' + d.weight + '% · budget ' + d.target));
    console.log('    ' + c.bold(String(d.count).padStart(2)) + ' q  ' + bar(Math.min(100, d.pctOfTarget)) + ' ' + d.pctOfTarget + '%   ' + c.gray('E:' + d.difficulties.easy + ' M:' + d.difficulties.medium + ' H:' + d.difficulties.hard));
    const blueprint = DOMAINS.find((domain) => domain.key === d.key);
    for (const comptcy of blueprint.competencies) {
      const n = d.competencies[comptcy] || 0;
      console.log('      ' + (n === 0 ? c.red('0') : c.green(String(n))) + ' ' + c.gray(comptcy));
    }
  }

  console.log('\n' + hr());
  console.log('  Total: ' + c.bold(stats.total) + ' questions / ' + stats.budget + ' budgeted for a full mock\n');
  return stats;
}
