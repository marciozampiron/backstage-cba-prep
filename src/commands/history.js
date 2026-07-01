import { load, HISTORY_FILE } from '../lib/history.js';
import { DOMAINS } from '../lib/blueprint.js';
import { c, hr, bar } from '../lib/ui.js';

function summarizeHistory(items) {
  const trend = items.length > 1 ? items[items.length - 1].pct - items[0].pct : null;
  const agg = Object.fromEntries(DOMAINS.map((d) => [d.key, { correct: 0, total: 0 }]));
  for (const e of items) {
    for (const [k, v] of Object.entries(e.perDomain || {})) {
      if (agg[k]) {
        agg[k].correct += v.correct || 0;
        agg[k].total += v.total || 0;
      }
    }
  }
  const weakest = DOMAINS.map((d) => ({ key: d.key, name: d.name, ...agg[d.key] }))
    .filter((x) => x.total)
    .sort((a, b) => a.correct / a.total - b.correct / b.total)[0] || null;
  return { file: HISTORY_FILE, count: items.length, trend, weakest, attempts: items };
}

export function runHistory(opts = {}) {
  const items = load();
  const summary = summarizeHistory(items);

  if (opts.json) {
    console.log(JSON.stringify(summary, null, 2));
    return summary;
  }

  if (!items.length) {
    console.log(c.gray('\n  No attempts recorded yet. Run node bin/cli.js exam first.\n'));
    return summary;
  }

  console.log('\n  ' + c.bold('Exam history') + ' ' + c.gray(HISTORY_FILE));
  console.log(hr());
  for (const e of items.slice(-15)) {
    const date = String(e.date || '').replace('T', ' ').slice(0, 16);
    console.log('  ' + c.gray(date.padEnd(16)) + '  ' + c.bold(String(e.pct).padStart(3) + '%') + '  ' + String(e.correct).padStart(2) + '/' + String(e.count).padStart(2) + '  ' + bar(e.pct) + '  ' + c.gray(e.domain || 'all'));
  }
  console.log(hr());

  if (items.length > 1) {
    const first = items[0];
    const last = items[items.length - 1];
    const trend = summary.trend;
    const arrow = trend > 0 ? c.green('▲ +' + trend + '%') : trend < 0 ? c.red('▼ ' + trend + '%') : c.gray('—');
    console.log('  ' + items.length + ' attempts · ' + first.pct + '% → ' + last.pct + '%  ' + arrow);
  }

  if (summary.weakest) console.log(c.gray('  Weakest so far: ' + summary.weakest.name + ' → node bin/cli.js exam --domain ' + summary.weakest.key));
  console.log('');
  return summary;
}
