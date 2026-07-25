// CBA_RUNTIME_ENV fail-fast rules (#77 Stage A): deployed tiers can never silently fall back to
// local persistence, and the tier is never inferred from NODE_ENV or ambient AWS variables.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveRuntimeConfig } from '../src/config.js';

test('local defaults to the file store', () => {
  const c = resolveRuntimeConfig({});
  assert.deepEqual(c, { runtimeEnv: 'local', store: 'file', table: null, dataDir: null });
});

test('local permits memory and honors the data dir', () => {
  const c = resolveRuntimeConfig({ CBA_WEB_STORE: 'memory', CBA_WEB_DATA_DIR: '/tmp/x' });
  assert.equal(c.store, 'memory');
  const f = resolveRuntimeConfig({ CBA_WEB_STORE: 'file', CBA_WEB_DATA_DIR: '/tmp/x' });
  assert.equal(f.dataDir, '/tmp/x');
});

test('local REJECTS dynamodb (deployed tiers must be explicit)', () => {
  assert.throws(() => resolveRuntimeConfig({ CBA_WEB_STORE: 'dynamodb' }), /not a local store/);
});

test('unknown CBA_RUNTIME_ENV fails loudly', () => {
  assert.throws(() => resolveRuntimeConfig({ CBA_RUNTIME_ENV: 'staging' }), /must be one of/);
});

for (const tier of ['dev', 'pilot']) {
  test(`${tier} requires CBA_WEB_STORE=dynamodb (missing store fails)`, () => {
    assert.throws(
      () => resolveRuntimeConfig({ CBA_RUNTIME_ENV: tier }),
      /requires CBA_WEB_STORE=dynamodb/,
    );
  });

  test(`${tier} rejects local-only stores (no silent fallback)`, () => {
    for (const store of ['memory', 'file']) {
      assert.throws(
        () => resolveRuntimeConfig({ CBA_RUNTIME_ENV: tier, CBA_WEB_STORE: store }),
        /requires CBA_WEB_STORE=dynamodb/,
      );
    }
  });

  test(`${tier} requires CBA_WEB_TABLE`, () => {
    assert.throws(
      () => resolveRuntimeConfig({ CBA_RUNTIME_ENV: tier, CBA_WEB_STORE: 'dynamodb' }),
      /requires CBA_WEB_TABLE/,
    );
  });

  test(`${tier} resolves with dynamodb + table`, () => {
    const c = resolveRuntimeConfig({
      CBA_RUNTIME_ENV: tier,
      CBA_WEB_STORE: 'dynamodb',
      CBA_WEB_TABLE: 'logical-table',
    });
    assert.deepEqual(c, { runtimeEnv: tier, store: 'dynamodb', table: 'logical-table', dataDir: null });
  });
}

test('NODE_ENV and ambient AWS variables are ignored for tier resolution', () => {
  const c = resolveRuntimeConfig({ NODE_ENV: 'production', AWS_REGION: 'us-east-1', AWS_EXECUTION_ENV: 'AWS_Lambda_nodejs22.x' });
  assert.equal(c.runtimeEnv, 'local');
});
