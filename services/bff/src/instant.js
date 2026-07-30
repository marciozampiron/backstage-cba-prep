// One strict timestamp parser, shared by the application and every repository adapter (#75).
//
// `Date.parse` is not a validator. It accepts `"2099"`, `"07/28/2099"`, `"Jul 28 2099"` and a pile
// of locale and legacy formats, so a corrupted or hand-edited retention field could parse into a
// valid FUTURE horizon — extending write eligibility or ownership instead of being refused. A
// retention bound that can be widened by malforming it is not a bound.
//
// Only the representation this repository writes is accepted: RFC3339 in UTC, seconds required,
// milliseconds optional, `Z` only. Everything else is `null`, and every caller treats `null` as
// expired rather than as "no deadline".

const CANONICAL = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d{1,3})?Z$/;

/**
 * Parse a canonical UTC instant to epoch milliseconds, or `null`.
 *
 * The round-trip check is what rejects an invalid calendar date: `Date.UTC` happily normalises
 * `2026-02-31` into March, so a value that parses is not necessarily a value that was written.
 *
 * @param {unknown} value
 * @returns {number|null}
 */
export function parseInstant(value) {
  if (typeof value !== 'string') return null;
  const m = CANONICAL.exec(value);
  if (!m) return null;

  const [, y, mo, d, h, mi, s, frac] = m;
  const year = Number(y);
  const month = Number(mo);
  const day = Number(d);
  const hour = Number(h);
  const minute = Number(mi);
  const second = Number(s);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  if (hour > 23 || minute > 59 || second > 59) return null;

  const ms = frac ? Number(`0${frac}`) * 1000 : 0;
  const epoch = Date.UTC(year, month - 1, day, hour, minute, second, Math.round(ms));
  if (!Number.isFinite(epoch)) return null;

  // Normalisation would have silently moved an impossible date (2026-02-31 -> 2026-03-03).
  const back = new Date(epoch);
  if (back.getUTCFullYear() !== year || back.getUTCMonth() !== month - 1 || back.getUTCDate() !== day) {
    return null;
  }
  return epoch;
}

/** Canonical rendering, so what is written is exactly what `parseInstant` accepts. */
export function toInstant(ms) {
  return new Date(ms).toISOString();
}
