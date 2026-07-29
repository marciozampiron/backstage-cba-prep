// The strict timestamp parser (#75). `Date.parse` is not a validator, and retention depends on one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseInstant, toInstant } from '../src/instant.js';

test('the canonical representation round-trips', () => {
  for (const iso of [
    '2026-07-28T00:00:00Z',
    '2026-07-28T12:34:56Z',
    '2026-07-28T12:34:56.789Z',
    '2028-02-29T00:00:00Z', // a real leap day (2026 is not a leap year)
  ]) {
    const ms = parseInstant(iso);
    assert.ok(ms !== null, iso);
    assert.equal(parseInstant(toInstant(ms)), ms, iso);
  }
});

test('NEGATIVE: everything Date.parse would have widened is refused', () => {
  // Each of these parses to a valid FUTURE instant under Date.parse. A corrupted or hand-edited
  // retention field would then EXTEND write eligibility or ownership instead of being refused —
  // a bound that can be widened by malforming it is not a bound.
  for (const widening of ['2099', '07/28/2099', 'Jul 28 2099', '2099-07-28', '2099-07-28T00:00:00']) {
    assert.notEqual(Date.parse(widening), Number.NaN, `${widening} parses under Date.parse`);
    assert.equal(parseInstant(widening), null, `${widening} must be refused`);
  }
});

test('NEGATIVE: non-canonical, impossible and non-string values are refused', () => {
  for (const bad of [
    '', ' 2026-07-28T00:00:00Z', '2026-07-28T00:00:00Z ', '2026-07-28T00:00:00',
    '2026-07-28T00:00:00+00:00', '2026-07-28T00:00:00-03:00', '2026-07-28t00:00:00z',
    '2026-13-01T00:00:00Z', '2026-02-31T00:00:00Z', '2026-00-10T00:00:00Z',
    '2026-07-28T24:00:00Z', '2026-07-28T00:60:00Z', '2026-07-28T00:00:60Z',
    '2026-02-29T00:00:00Z', // 2026 is not a leap year
    '2025-02-29T00:00:00Z',
    null, undefined, 42, {}, [], Number.NaN, Infinity,
  ]) {
    assert.equal(parseInstant(bad), null, JSON.stringify(bad));
  }
});
