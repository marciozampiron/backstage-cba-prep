/**
 * Conformance-harness probe (NOT part of the root battery: the test glob is test/*.test.js).
 * bin/spec-conform.mjs is proven against these three shapes: a named test that passes, a named
 * test that fails, and — by omission — a named test that does not exist.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

test('conform probe: this test passes', () => {
  assert.equal(1 + 1, 2);
});

test('conform probe: this test fails', () => {
  assert.equal(1 + 1, 3, 'deliberately red: the harness must see a real failure');
});
