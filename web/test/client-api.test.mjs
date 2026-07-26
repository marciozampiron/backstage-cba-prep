// apiFetch regressions (#67 base URL + #69 bearer): the real url-building, bearer attachment and
// contract-path allowlist, with the session/config/fetch seams injected. Fully offline.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApiFetch } from '../lib/client-api.js';

function harness({ token = null, bffBaseUrl = null } = {}) {
  const calls = [];
  const apiFetch = createApiFetch({
    getToken: async () => token,
    getConfig: async () => ({ mode: token ? 'cognito' : 'dev', bffBaseUrl }),
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return { ok: true, status: 200 };
    },
  });
  return { apiFetch, calls };
}

/* ---------------- local: same-origin ---------------- */

test('local (null base) calls the same-origin contract path', async () => {
  const { apiFetch, calls } = harness();
  await apiFetch('/api/dashboard');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '/api/dashboard');
  assert.equal(calls[0].init.headers.authorization, undefined, 'no session, no bearer');
});

/* ---------------- deployed: absolute BFF origin ---------------- */

test('deployed base is prefixed, producing an absolute API Gateway URL', async () => {
  const { apiFetch, calls } = harness({ bffBaseUrl: 'https://bff.pilot.example.test' });
  await apiFetch('/api/dashboard');
  assert.equal(calls[0].url, 'https://bff.pilot.example.test/api/dashboard');
});

test('the bearer is preserved on deployed calls and merges with caller headers', async () => {
  const { apiFetch, calls } = harness({ token: 'tok-123', bffBaseUrl: 'https://bff.pilot.example.test' });
  await apiFetch('/api/me', { method: 'PUT', headers: { 'content-type': 'application/json' } });
  assert.equal(calls[0].url, 'https://bff.pilot.example.test/api/me');
  assert.equal(calls[0].init.headers.authorization, 'Bearer tok-123');
  assert.equal(calls[0].init.headers['content-type'], 'application/json');
  assert.equal(calls[0].init.method, 'PUT');
});

test('the query string survives both locally and deployed', async () => {
  const local = harness();
  await local.apiFetch('/api/attempts/att_1/missed?limit=60&cursor=abc');
  assert.equal(local.calls[0].url, '/api/attempts/att_1/missed?limit=60&cursor=abc');

  const deployed = harness({ bffBaseUrl: 'https://bff.dev.example.test' });
  await deployed.apiFetch('/api/mock-exams/mock_1?index=3');
  assert.equal(deployed.calls[0].url, 'https://bff.dev.example.test/api/mock-exams/mock_1?index=3');
});

/* ---------------- only contract paths ---------------- */

test('non-contract paths are refused before any request is made', async () => {
  const { apiFetch, calls } = harness({ bffBaseUrl: 'https://bff.pilot.example.test' });
  const refused = [
    'https://evil.example.test/steal', // absolute URL
    'http://evil.example.test/steal',
    '//evil.example.test/steal', // protocol-relative authority
    '/auth/config', // web-served config, not the learner API
    '/apiary/x', // no greedy prefix match
    '/api../x', // no greedy prefix match either
    '/api/../../etc/passwd', // literal traversal (URL normalizes it out of /api)
    '/api/..', // literal traversal to the root
    'api/dashboard', // relative
    '', // empty
    '/', // root
  ];
  for (const path of refused) {
    await assert.rejects(() => apiFetch(path), /only accepts contract paths under \/api/, `"${path}" must be refused`);
  }
  assert.equal(calls.length, 0, 'nothing may reach the network');
});

test('percent-encoded traversal is refused — including case and separator variations', async () => {
  const { apiFetch, calls } = harness({ bffBaseUrl: 'https://bff.pilot.example.test' });
  const refused = [
    '/api/%2e%2e/etc',
    '/api/%2E%2E/etc', // upper-case encoding
    '/api/%2e%2E/etc', // mixed case
    '/api/attempts/%2e%2e/%2e%2e/admin',
    '/api/%2e%2e%2fadmin', // encoded separator
    '/api/x%2f..%2f..%2fadmin',
    '/api%2f..%2fadmin', // encoded separator right after the prefix
    '/api/%252e%252e/etc', // double-encoded
    '/api/%2e%2e/%2e%2e/', // trailing form
    '/api/%', // malformed encoding
  ];
  for (const path of refused) {
    await assert.rejects(
      () => apiFetch(path),
      /only accepts contract paths under \/api/,
      `"${path}" must be refused`,
    );
  }
  assert.equal(calls.length, 0, 'zero fetchImpl calls for every encoded-traversal attempt');
});

test('a refused path does not even trigger a session or config lookup', async () => {
  let sessionLookups = 0;
  let configLookups = 0;
  const calls = [];
  const apiFetch = createApiFetch({
    getToken: async () => {
      sessionLookups += 1;
      return null;
    },
    getConfig: async () => {
      configLookups += 1;
      return { bffBaseUrl: null };
    },
    fetchImpl: async (url) => {
      calls.push(url);
      return { ok: true };
    },
  });
  await assert.rejects(() => apiFetch('/api/%2e%2e/etc'));
  assert.deepEqual({ sessionLookups, configLookups, calls: calls.length }, {
    sessionLookups: 0,
    configLookups: 0,
    calls: 0,
  });
});

/* ---------------- deeply encoded traversal: fail closed on non-convergence ---------------- */

/** Re-encode every '%' N times, so N+1 decode passes are needed to reach the literal form. */
function encodePercentTimes(value, times) {
  let out = value;
  for (let i = 0; i < times; i += 1) out = out.replaceAll('%', '%25');
  return out;
}

test('deeply encoded traversal is refused, and nothing is consulted or called', async () => {
  // Programmatic, not hand-written: start from the traversal segment and re-encode '%' six times,
  // which needs more decode passes than the validator allows. A validator that returned the
  // partially decoded value would judge a string that is NOT what a server would resolve.
  const payload = encodePercentTimes('%2e%2e', 6);
  const path = `/api/${payload}/etc`;
  assert.ok(payload.startsWith('%2525'), 'sanity: the payload really is deeply encoded');
  assert.ok(!payload.includes('..'), 'sanity: no literal traversal is visible');

  let sessionLookups = 0;
  let configLookups = 0;
  const calls = [];
  const apiFetch = createApiFetch({
    getToken: async () => {
      sessionLookups += 1;
      return 'tok';
    },
    getConfig: async () => {
      configLookups += 1;
      return { bffBaseUrl: 'https://bff.pilot.example.test' };
    },
    fetchImpl: async (url) => {
      calls.push(url);
      return { ok: true };
    },
  });

  await assert.rejects(() => apiFetch(path), /only accepts contract paths under \/api/);
  assert.deepEqual(
    { sessionLookups, configLookups, calls: calls.length },
    { sessionLookups: 0, configLookups: 0, calls: 0 },
    'no fetch, no session lookup, no config lookup',
  );
});

test('every encoding depth from 1 to 8 is refused', async () => {
  const { apiFetch, calls } = harness({ bffBaseUrl: 'https://bff.pilot.example.test' });
  for (let depth = 1; depth <= 8; depth += 1) {
    const path = `/api/${encodePercentTimes('%2e%2e', depth)}/etc`;
    await assert.rejects(
      () => apiFetch(path),
      /only accepts contract paths under \/api/,
      `depth ${depth} must be refused`,
    );
  }
  assert.equal(calls.length, 0, 'zero fetchImpl calls across every depth');
});

test('harmless normalizable paths are accepted and normalized', async () => {
  const { apiFetch, calls } = harness();
  await apiFetch('/api/./dashboard');
  await apiFetch('/api/practice/../dashboard');
  assert.deepEqual(
    calls.map((c) => c.url),
    ['/api/dashboard', '/api/dashboard'],
    'both still resolve under /api, so they are legal — and the normalized form is sent',
  );
});

test('bare /api and normal contract paths are accepted', async () => {
  const { apiFetch, calls } = harness();
  await apiFetch('/api');
  await apiFetch('/api/practice/options');
  await apiFetch('/api/practice-sessions/ps_1/next');
  assert.deepEqual(
    calls.map((c) => c.url),
    ['/api', '/api/practice/options', '/api/practice-sessions/ps_1/next'],
  );
});

test('a session-layer failure surfaces instead of degrading to an unauthenticated call', async () => {
  const calls = [];
  const apiFetch = createApiFetch({
    getToken: async () => {
      throw new Error('session layer broken');
    },
    getConfig: async () => ({ bffBaseUrl: null }),
    fetchImpl: async (url) => {
      calls.push(url);
      return { ok: true };
    },
  });
  await assert.rejects(() => apiFetch('/api/dashboard'), /session layer broken/);
  assert.equal(calls.length, 0);
});
