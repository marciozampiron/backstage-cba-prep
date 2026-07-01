import { loadBank } from '../lib/bank.js';
import { c, hr } from '../lib/ui.js';

// Check a URL, trying HEAD first and falling back to GET (some servers reject HEAD).
async function check(url, timeoutMs = 9000) {
  for (const method of ['HEAD', 'GET']) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method,
        redirect: 'follow',
        signal: ctrl.signal,
        headers: { 'user-agent': 'backstage-cba-prep/audit-sources' },
      });
      clearTimeout(timer);
      if (res.ok || (res.status >= 300 && res.status < 400)) return { status: res.status, ok: true };
      if (method === 'GET') return { status: res.status, ok: false };
      // non-2xx/3xx on HEAD → retry with GET before judging
    } catch (err) {
      clearTimeout(timer);
      if (method === 'GET') return { status: 0, ok: false, error: err.name === 'AbortError' ? 'timeout' : err.message };
    }
  }
  return { status: 0, ok: false };
}

export async function runAuditSources() {
  const { all } = loadBank();
  const urls = [...new Set(all.map((q) => q.source).filter(Boolean))].sort();
  console.log(`\n  ${c.bold('Auditing source URLs')} ${c.gray(`(${urls.length} unique across ${all.length} questions)`)}`);
  console.log(hr());

  const CONCURRENCY = 6;
  const results = new Array(urls.length);
  let next = 0;
  async function worker() {
    while (next < urls.length) {
      const i = next++;
      results[i] = { url: urls[i], r: await check(urls[i]) };
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, urls.length) }, worker));

  // Only "definitively gone" statuses fail the build. A CI runner can be bot-blocked
  // (403) or rate-limited (429) without the page being dead, so those — plus 5xx and
  // network errors — are treated as soft (inconclusive), not failures.
  const GONE = new Set([404, 410]);
  let ok = 0;
  let dead = 0;
  let soft = 0;
  for (const { url, r } of results) {
    if (r.ok) {
      ok += 1;
    } else if (GONE.has(r.status)) {
      dead += 1;
      console.log(`  ${c.red(`DEAD ${r.status}`)}  ${url}`);
    } else {
      soft += 1;
      console.log(`  ${c.yellow('skipped')}  ${c.gray(url)} ${c.gray(r.error || (r.status ? `status ${r.status}` : 'no response'))}`);
    }
  }

  console.log(hr());
  console.log(`  ${c.green(`${ok} ok`)} · ${dead ? c.red(`${dead} dead`) : '0 dead'} · ${soft ? c.yellow(`${soft} skipped`) : '0 skipped'}`);

  if (dead > 0) {
    console.log(c.red('\n  ✗ Some sources are dead (404/410) — fix or replace them.\n'));
    return 2;
  }
  if (soft > 0) {
    console.log(c.gray('\n  Some checks were inconclusive (403/429/5xx/network) — soft, not a failure.\n'));
    return 0;
  }
  console.log(c.green('\n  ✓ All sources reachable.\n'));
  return 0;
}
