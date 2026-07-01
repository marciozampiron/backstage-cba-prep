import fs from 'node:fs';
import path from 'node:path';
import { DOMAINS, EXAM } from '../lib/blueprint.js';
import { SPEC_DIR } from '../lib/paths.js';
import { c, hr } from '../lib/ui.js';

function stripHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ');
}

// Best-effort scrape: find a percentage near each known domain name.
export async function runSync(opts = {}) {
  console.log(c.gray(`  Fetching ${EXAM.blueprintUrl} ...`));
  let text;
  try {
    const res = await fetch(EXAM.blueprintUrl, { headers: { 'user-agent': 'backstage-cba-prep/sync' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    text = stripHtml(await res.text());
  } catch (err) {
    console.log(c.red(`  Could not fetch the blueprint: ${err.message}`));
    return 1;
  }

  console.log(`\n  ${c.bold('Domain weights — local vs. live')}`);
  console.log(hr());
  const detected = {};
  let changed = false;
  const lower = text.toLowerCase();
  for (const d of DOMAINS) {
    const idx = lower.indexOf(d.name.toLowerCase());
    let live = null;
    if (idx >= 0) {
      const window = text.slice(idx, idx + d.name.length + 12);
      const m = window.match(/(\d{1,3})\s*%/);
      if (m) live = Number(m[1]);
    }
    detected[d.key] = live;
    const same = live === d.weight;
    if (!same) changed = true;
    const liveStr = live == null ? c.yellow('not found') : same ? c.green(`${live}%`) : c.red(`${live}%`);
    console.log(`    ${d.name.padEnd(32)} local ${c.bold(`${d.weight}%`)}   live ${liveStr}`);
  }
  console.log(hr());

  if (opts.write) {
    const stamp = {
      checkedUrl: EXAM.blueprintUrl,
      local: Object.fromEntries(DOMAINS.map((d) => [d.key, d.weight])),
      detected,
    };
    fs.writeFileSync(path.join(SPEC_DIR, 'last-sync.json'), `${JSON.stringify(stamp, null, 2)}\n`);
    console.log(c.gray('  Wrote spec/last-sync.json'));
  }

  if (changed) {
    console.log(c.yellow('\n  ⚠ Live blueprint differs from the local copy (or a domain was renamed).'));
    console.log(c.gray('  Reconcile src/lib/blueprint.js + spec/exam-blueprint.md, then re-run. (exit 3)'));
    return 3;
  }
  console.log(c.green('\n  ✓ Local blueprint matches the live page.\n'));
  return 0;
}
