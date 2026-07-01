import { DOMAINS } from '../lib/blueprint.js';
import { loadBank } from '../lib/bank.js';
import { c, hr, bar } from '../lib/ui.js';

export function runStats() {
  const { byDomain } = loadBank();
  console.log(`\n  ${c.bold('CBA question bank — coverage')}`);
  console.log(hr());

  let total = 0;
  let budget = 0;
  for (const d of DOMAINS) {
    const arr = byDomain[d.key] || [];
    total += arr.length;
    budget += d.target;

    const diff = { easy: 0, medium: 0, hard: 0 };
    const comp = {};
    for (const q of arr) {
      if (diff[q.difficulty] != null) diff[q.difficulty] += 1;
      comp[q.competency] = (comp[q.competency] || 0) + 1;
    }
    const pctOfTarget = d.target ? Math.round((arr.length / d.target) * 100) : 0;

    console.log(`\n  ${c.bold(d.name)} ${c.gray(`· ${d.weight}% · budget ${d.target}`)}`);
    console.log(`    ${c.bold(String(arr.length).padStart(2))} q  ${bar(Math.min(100, pctOfTarget))} ${pctOfTarget}%   ${c.gray(`E:${diff.easy} M:${diff.medium} H:${diff.hard}`)}`);
    for (const comptcy of d.competencies) {
      const n = comp[comptcy] || 0;
      console.log(`      ${n === 0 ? c.red('0') : c.green(String(n))} ${c.gray(comptcy)}`);
    }
  }

  console.log(`\n${hr()}`);
  console.log(`  Total: ${c.bold(total)} questions / ${budget} budgeted for a full mock\n`);
}
