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

  let ok = 0;
  let broken = 0;
  let unreachable = 0;
  for (const { url, r } of results) {
    if (r.ok) {
      ok += 1;
    } else if (r.status >= 400 && r.status < 500) {
      broken += 1;
      console.log(`  ${c.red(`BROKEN ${r.status}`)}  ${url}`);
    } else {
      unreachable += 1;
      console.log(`  ${c.yellow('unreachable')}  ${c.gray(url)} ${c.gray(r.error || `status ${r.status}`)}`);
    }
  }

  console.log(hr());
  console.log(`  ${c.green(`${ok} ok`)} · ${broken ? c.red(`${broken} broken`) : '0 broken'} · ${unreachable ? c.yellow(`${unreachable} unreachable`) : '0 unreachable'}`);

  if (broken > 0) {
    console.log(c.red('\n  ✗ Some sources returned 4xx — fix or replace them.\n'));
    return 2;
  }
  if (unreachable > 0) {
    console.log(c.gray('\n  Network/5xx prevented some checks (soft-fail — not treated as an error).\n'));
    return 0;
  }
  console.log(c.green('\n  ✓ All sources reachable.\n'));
  return 0;
}
