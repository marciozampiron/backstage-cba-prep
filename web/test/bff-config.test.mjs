// Runtime BFF configuration regressions (#67 Stage A): the deployed fail-fast rule, the local
// same-origin default, and URL validation. Fully offline — the resolver is pure.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveBffConfig } from '../lib/bff-config.js';

/* ---------------- local: same-origin default ---------------- */

test('local (or unset) runtime keeps the frontend same-origin when no base URL is set', () => {
  assert.deepEqual(resolveBffConfig({}), { runtimeEnv: 'local', bffBaseUrl: null, sameOrigin: true });
  assert.deepEqual(resolveBffConfig({ CBA_RUNTIME_ENV: 'local' }), {
    runtimeEnv: 'local',
    bffBaseUrl: null,
    sameOrigin: true,
  });
});

test('local may still point at a deployed BFF for debugging', () => {
  const config = resolveBffConfig({
    CBA_RUNTIME_ENV: 'local',
    CBA_BFF_BASE_URL: 'https://bff.dev.example.test',
  });
  assert.deepEqual(config, {
    runtimeEnv: 'local',
    bffBaseUrl: 'https://bff.dev.example.test',
    sameOrigin: false,
  });
});

/* ---------------- deployed: fail fast ---------------- */

test('dev and pilot FAIL FAST when the base URL is missing or empty', () => {
  for (const runtimeEnv of ['dev', 'pilot']) {
    assert.throws(
      () => resolveBffConfig({ CBA_RUNTIME_ENV: runtimeEnv }),
      /requires CBA_BFF_BASE_URL/,
      `${runtimeEnv} must not fall back to same-origin`,
    );
    assert.throws(
      () => resolveBffConfig({ CBA_RUNTIME_ENV: runtimeEnv, CBA_BFF_BASE_URL: '' }),
      /requires CBA_BFF_BASE_URL/,
    );
  }
});

test('dev and pilot resolve a valid base URL and never claim same-origin', () => {
  const config = resolveBffConfig({
    CBA_RUNTIME_ENV: 'pilot',
    CBA_BFF_BASE_URL: 'https://api.pilot.example.test/',
  });
  assert.deepEqual(config, {
    runtimeEnv: 'pilot',
    bffBaseUrl: 'https://api.pilot.example.test', // trailing slash normalised away
    sameOrigin: false,
  });
});

test('an unknown runtime env fails instead of silently degrading', () => {
  assert.throws(
    () => resolveBffConfig({ CBA_RUNTIME_ENV: 'production' }),
    /must be one of local\|dev\|pilot/,
  );
});

/* ---------------- URL validation ---------------- */

test('base URL must be an exact absolute https origin', () => {
  const bad = {
    'not-a-url': /absolute URL/,
    'http://api.example.test': /must use https/,
    'https://*.example.test': /wildcards are forbidden/,
    'https://user:pass@api.example.test': /must not embed credentials/,
    'https://api.example.test/?a=1': /no query string or fragment/,
    'https://api.example.test/#frag': /no query string or fragment/,
    ' https://api.example.test': /whitespace/,
    'https://api.example.test ': /whitespace/,
  };
  for (const [value, pattern] of Object.entries(bad)) {
    assert.throws(
      () => resolveBffConfig({ CBA_RUNTIME_ENV: 'pilot', CBA_BFF_BASE_URL: value }),
      pattern,
      `"${value}" must be rejected`,
    );
  }
});

test('localhost over http is allowed (local debugging only)', () => {
  const config = resolveBffConfig({
    CBA_RUNTIME_ENV: 'local',
    CBA_BFF_BASE_URL: 'http://localhost:3001',
  });
  assert.equal(config.bffBaseUrl, 'http://localhost:3001');
});

/* ---------------- Cloudflare Workers: the tier is mandatory and deployed-only ---------------- */

test('on Workers an ABSENT CBA_RUNTIME_ENV fails — no local default is inherited', () => {
  assert.throws(
    () => resolveBffConfig({}, { onWorkers: true }),
    /CBA_RUNTIME_ENV is required on Cloudflare Workers/,
  );
  // Even with a perfectly good base URL, the tier still has to be stated.
  assert.throws(
    () => resolveBffConfig({ CBA_BFF_BASE_URL: 'https://bff.pilot.example.test' }, { onWorkers: true }),
    /CBA_RUNTIME_ENV is required on Cloudflare Workers/,
  );
});

test('on Workers CBA_RUNTIME_ENV=local is rejected — a Worker is a deployed runtime', () => {
  assert.throws(
    () =>
      resolveBffConfig(
        { CBA_RUNTIME_ENV: 'local', CBA_BFF_BASE_URL: 'https://bff.pilot.example.test' },
        { onWorkers: true },
      ),
    /must be one of dev\|pilot .*"local" is not valid there/s,
  );
});

test('on Workers dev and pilot with a valid base URL resolve normally', () => {
  for (const runtimeEnv of ['dev', 'pilot']) {
    const config = resolveBffConfig(
      { CBA_RUNTIME_ENV: runtimeEnv, CBA_BFF_BASE_URL: 'https://bff.example.test/' },
      { onWorkers: true },
    );
    assert.deepEqual(config, {
      runtimeEnv,
      bffBaseUrl: 'https://bff.example.test',
      sameOrigin: false,
    });
  }
});

test('on Workers a deployed tier WITHOUT a base URL still fails fast', () => {
  assert.throws(
    () => resolveBffConfig({ CBA_RUNTIME_ENV: 'pilot' }, { onWorkers: true }),
    /requires CBA_BFF_BASE_URL/,
  );
});

test('off Workers the local default is still allowed (next dev / next start / tests)', () => {
  assert.deepEqual(resolveBffConfig({}, { onWorkers: false }), {
    runtimeEnv: 'local',
    bffBaseUrl: null,
    sameOrigin: true,
  });
});

/* ---------------- runtime env source: fail closed on Workers ---------------- */

test('getRuntimeEnv returns process.env when not running on Cloudflare Workers', async () => {
  const { getRuntimeEnv } = await import('../lib/bff-config.js');
  process.env.__LEAK_SCAN_PROBE__ = 'present';
  try {
    const env = await getRuntimeEnv();
    assert.equal(env.__LEAK_SCAN_PROBE__, 'present');
  } finally {
    delete process.env.__LEAK_SCAN_PROBE__;
  }
});

test('the Worker binding lookup is NOT wrapped in a catch — deployed fails closed', async () => {
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(new URL('../lib/bff-config.js', import.meta.url), 'utf8');
  const fn = source.slice(source.indexOf('export async function getRuntimeEnv'));
  const body = fn.slice(0, fn.indexOf('\n}\n') + 1);
  assert.ok(body.includes('getCloudflareContext'), 'sanity: the right function was extracted');
  assert.ok(
    !/\bcatch\b/.test(body),
    'a Worker that cannot read its bindings must surface the error, not degrade to local defaults',
  );
});

/* ---------------- the NEXT_PUBLIC_* prohibition is structural ---------------- */

test('the resolver never READS a NEXT_PUBLIC_* variable', async () => {
  const { readFileSync } = await import('node:fs');
  // Strip comments AND string literals: the error message deliberately NAMES the forbidden
  // pattern to teach whoever trips it, so only executable code may be inspected here.
  const code = readFileSync(new URL('../lib/bff-config.js', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/`(?:[^`\\]|\\.)*`/g, '``');
  assert.ok(!code.includes('NEXT_PUBLIC'), 'build-time inlined config is forbidden by contract');
});
