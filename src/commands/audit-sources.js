import { loadBank } from '../lib/bank.js';
import { c, hr } from '../lib/ui.js';

async function check(url, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 9000;
  const fetchImpl = opts.fetchImpl || fetch;
  for (const method of ['HEAD', 'GET']) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetchImpl(url, {
        method,
        redirect: 'follow',
        signal: ctrl.signal,
        headers: { 'user-agent': 'backstage-cba-prep/audit-sources' },
      });
      clearTimeout(timer);
      if (res.ok || (res.status >= 300 && res.status < 400)) return { status: res.status, ok: true };
      if (method === 'GET') return { status: res.status, ok: false };
    } catch (err) {
      clearTimeout(timer);
      if (method === 'GET') return { status: 0, ok: false, error: err.name === 'AbortError' ? 'timeout' : err.message };
    }
  }
  return { status: 0, ok: false };
}

function classify(url, r) {
  if (r.ok) return { url, status: r.status, ok: true, category: 'ok' };
  if (r.status === 404 || r.status === 410) return { url, status: r.status, ok: false, category: 'dead' };
  return {
    url,
    status: r.status,
    ok: false,
    category: 'soft',
    error: r.error || (r.status ? 'status ' + r.status : 'no response'),
  };
}

export async function auditSources(opts = {}) {
  const { all } = loadBank();
  const urls = [...new Set(all.map((q) => q.source).filter(Boolean))].sort();
  const concurrency = opts.concurrency ?? 6;
  const results = new Array(urls.length);
  let next = 0;

  async function worker() {
    while (next < urls.length) {
      const i = next++;
      const r = await check(urls[i], { timeoutMs: opts.timeoutMs, fetchImpl: opts.fetchImpl });
      results[i] = classify(urls[i], r);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, urls.length) }, worker));

  const counts = { ok: 0, dead: 0, soft: 0 };
  for (const r of results) counts[r.category] += 1;
  return {
    ok: counts.dead === 0,
    code: counts.dead > 0 ? 2 : 0,
    totalQuestions: all.length,
    uniqueUrls: urls.length,
    counts,
    results,
  };
}

export async function runAuditSources(opts = {}) {
  const summary = await auditSources(opts);

  if (opts.json) {
    console.log(JSON.stringify(summary, null, 2));
    return summary.code;
  }

  console.log('\n  ' + c.bold('Auditing source URLs') + ' ' + c.gray('(' + summary.uniqueUrls + ' unique across ' + summary.totalQuestions + ' questions)'));
  console.log(hr());

  for (const r of summary.results) {
    if (r.category === 'dead') console.log('  ' + c.red('DEAD ' + r.status) + '  ' + r.url);
    else if (r.category === 'soft') console.log('  ' + c.yellow('skipped') + '  ' + c.gray(r.url) + ' ' + c.gray(r.error));
  }

  console.log(hr());
  console.log('  ' + c.green(summary.counts.ok + ' ok') + ' · ' + (summary.counts.dead ? c.red(summary.counts.dead + ' dead') : '0 dead') + ' · ' + (summary.counts.soft ? c.yellow(summary.counts.soft + ' skipped') : '0 skipped'));

  if (summary.counts.dead > 0) {
    console.log(c.red('\n  ✗ Some sources are dead (404/410) — fix or replace them.\n'));
    return 2;
  }
  if (summary.counts.soft > 0) {
    console.log(c.gray('\n  Some checks were inconclusive (403/429/5xx/network) — soft, not a failure.\n'));
    return 0;
  }
  console.log(c.green('\n  ✓ All sources reachable.\n'));
  return 0;
}
