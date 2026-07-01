import { load, HISTORY_FILE } from '../lib/history.js';
import { DOMAINS } from '../lib/blueprint.js';
import { c, hr, bar } from '../lib/ui.js';

export function runHistory() {
  const items = load();
  if (!items.length) {
    console.log(c.gray('\n  No attempts recorded yet. Run `node bin/cli.js exam` first.\n'));
    return;
  }

  console.log(`\n  ${c.bold('Exam history')} ${c.gray(HISTORY_FILE)}`);
  console.log(hr());
  for (const e of items.slice(-15)) {
    const date = String(e.date || '').replace('T', ' ').slice(0, 16);
    console.log(`  ${c.gray(date.padEnd(16))}  ${c.bold(`${String(e.pct).padStart(3)}%`)}  ${String(e.correct).padStart(2)}/${String(e.count).padStart(2)}  ${bar(e.pct)}  ${c.gray(e.domain || 'all')}`);
  }
  console.log(hr());

  if (items.length > 1) {
    const first = items[0];
    const last = items[items.length - 1];
    const trend = last.pct - first.pct;
    const arrow = trend > 0 ? c.green(`▲ +${trend}%`) : trend < 0 ? c.red(`▼ ${trend}%`) : c.gray('—');
    console.log(`  ${items.length} attempts · ${first.pct}% → ${last.pct}%  ${arrow}`);
  }

  // Weakest domain across all recorded attempts, to suggest what to drill next.
  const agg = Object.fromEntries(DOMAINS.map((d) => [d.key, { correct: 0, total: 0 }]));
  for (const e of items) {
    for (const [k, v] of Object.entries(e.perDomain || {})) {
      if (agg[k]) {
        agg[k].correct += v.correct || 0;
        agg[k].total += v.total || 0;
      }
    }
  }
  const weakest = DOMAINS.map((d) => ({ d, a: agg[d.key] }))
    .filter((x) => x.a.total)
    .sort((a, b) => a.a.correct / a.a.total - b.a.correct / b.a.total)[0];
  if (weakest) console.log(c.gray(`  Weakest so far: ${weakest.d.name} → node bin/cli.js exam --domain ${weakest.d.key}`));
  console.log('');
}
