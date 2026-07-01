// The exam blueprint (domain model) is data, loaded from spec/blueprint.json.
// Regenerate it from the official page with `node bin/cli.js blueprint --from <url>`.
import fs from 'node:fs';
import path from 'node:path';
import { SPEC_DIR } from './paths.js';

const data = JSON.parse(fs.readFileSync(path.join(SPEC_DIR, 'blueprint.json'), 'utf8'));

export const EXAM = data.exam;
export const DOMAINS = data.domains;
export const PREFIXES = DOMAINS.map((d) => d.prefix);

export function domainByKey(key) {
  return DOMAINS.find((d) => d.key === key) || null;
}
export function domainByName(name) {
  return DOMAINS.find((d) => d.name === name) || null;
}
export function domainByPrefix(prefix) {
  return DOMAINS.find((d) => d.prefix === prefix) || null;
}

// Resolve a user-supplied domain token (key, prefix, or partial name) to a domain.
export function resolveDomain(token) {
  if (!token) return null;
  const t = String(token).toLowerCase();
  return (
    DOMAINS.find((d) => d.key === t) ||
    DOMAINS.find((d) => d.prefix === t) ||
    DOMAINS.find((d) => d.name.toLowerCase().includes(t)) ||
    null
  );
}

// Split `total` questions across domains proportionally to the 60-question budget,
// using largest-remainder rounding so the parts sum exactly to `total`.
export function allocate(total) {
  const rows = DOMAINS.map((d) => {
    const exact = (d.target * total) / EXAM.totalQuestions;
    return { key: d.key, floor: Math.floor(exact), rem: exact - Math.floor(exact) };
  });
  let left = total - rows.reduce((s, r) => s + r.floor, 0);
  rows.sort((a, b) => b.rem - a.rem);
  for (let i = 0; i < rows.length && left > 0; i++, left--) rows[i].floor++;
  const out = {};
  for (const r of rows) out[r.key] = r.floor;
  return out;
}
