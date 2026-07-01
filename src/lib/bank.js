import fs from 'node:fs';
import path from 'node:path';
import { DOMAINS, domainByKey, allocate } from './blueprint.js';
import { QUESTIONS_DIR } from './paths.js';

const DIFFICULTIES = ['easy', 'medium', 'hard'];
const OPTION_KEYS = ['A', 'B', 'C', 'D'];

export function fileForDomain(key) {
  return path.join(QUESTIONS_DIR, `${key}.json`);
}

// Load every domain file. Never throws: parse/read problems are returned as `errors`.
export function loadBank() {
  const byDomain = {};
  const all = [];
  const errors = [];
  for (const d of DOMAINS) {
    const file = fileForDomain(d.key);
    let arr = [];
    try {
      arr = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!Array.isArray(arr)) {
        errors.push(`${d.key}.json is not a JSON array`);
        arr = [];
      }
    } catch (err) {
      errors.push(`Cannot read/parse ${d.key}.json: ${err.message}`);
      arr = [];
    }
    for (const q of arr) if (q && typeof q === 'object') q._domainKey = d.key;
    byDomain[d.key] = arr;
    all.push(...arr);
  }
  return { all, byDomain, errors };
}

export function shuffle(items) {
  const r = items.slice();
  for (let i = r.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [r[i], r[j]] = [r[j], r[i]];
  }
  return r;
}

// Pick `count` questions. With { domainKey } it draws from one domain; otherwise it
// spreads across domains by the blueprint budget and fills any shortfall from the rest.
export function sample(count, { domainKey } = {}) {
  const { byDomain } = loadBank();
  if (domainKey) return shuffle(byDomain[domainKey] || []).slice(0, count);

  const alloc = allocate(count);
  const picked = [];
  const leftovers = [];
  for (const d of DOMAINS) {
    const pool = shuffle(byDomain[d.key] || []);
    const n = Math.min(alloc[d.key] || 0, pool.length);
    picked.push(...pool.slice(0, n));
    leftovers.push(...pool.slice(n));
  }
  if (picked.length < count) picked.push(...shuffle(leftovers).slice(0, count - picked.length));
  return shuffle(picked).slice(0, count);
}

// Validate a single question object against the schema rules. Returns an array of error strings.
export function validateQuestion(q, domainKey, seen) {
  const errs = [];
  const d = domainByKey(domainKey);
  const id = q && q.id;
  const label = typeof id === 'string' ? id : JSON.stringify(id);

  if (typeof id !== 'string' || !/^(dw|infra|cat|cust)-\d{3}$/.test(id)) {
    errs.push(`${label}: id must match <prefix>-NNN (dw|infra|cat|cust)`);
  } else {
    if (d && !id.startsWith(`${d.prefix}-`)) errs.push(`${id}: id prefix should be "${d.prefix}" in ${domainKey}.json`);
    if (seen) {
      if (seen.has(id)) errs.push(`${id}: duplicate id`);
      seen.add(id);
    }
  }
  if (d && q.domain !== d.name) errs.push(`${label}: domain should be "${d.name}", got ${JSON.stringify(q.domain)}`);
  if (!q.competency) errs.push(`${label}: missing competency`);
  else if (d && !d.competencies.includes(q.competency)) errs.push(`${label}: competency not in blueprint: ${JSON.stringify(q.competency)}`);
  if (!DIFFICULTIES.includes(q.difficulty)) errs.push(`${label}: difficulty must be easy|medium|hard`);
  if (typeof q.question !== 'string' || q.question.trim().length < 10) errs.push(`${label}: question missing or too short`);

  const opts = q.options || {};
  for (const k of OPTION_KEYS) if (typeof opts[k] !== 'string' || !opts[k].trim()) errs.push(`${label}: missing/empty option ${k}`);
  const extra = Object.keys(opts).filter((k) => !OPTION_KEYS.includes(k));
  if (extra.length) errs.push(`${label}: unexpected option keys: ${extra.join(', ')}`);

  if (!OPTION_KEYS.includes(q.answer)) errs.push(`${label}: answer must be one of A|B|C|D`);
  if (typeof q.explanation !== 'string' || q.explanation.trim().length < 10) errs.push(`${label}: explanation missing or too short`);
  if (typeof q.source !== 'string' || !/^https?:\/\//.test(q.source)) errs.push(`${label}: source must be an http(s) URL`);
  return errs;
}

export function validateBank() {
  const { byDomain, errors } = loadBank();
  const all = [...errors];
  const seen = new Set();
  let count = 0;
  for (const d of DOMAINS) {
    for (const q of byDomain[d.key] || []) {
      count += 1;
      all.push(...validateQuestion(q, d.key, seen));
    }
  }
  return { errors: all, count };
}

// Append validated questions to a domain file, auto-numbering ids sequentially.
export function appendQuestions(domainKey, questions) {
  const d = domainByKey(domainKey);
  if (!d) throw new Error(`unknown domain: ${domainKey}`);
  const file = fileForDomain(domainKey);
  const existing = JSON.parse(fs.readFileSync(file, 'utf8'));
  let maxSeq = 0;
  for (const q of existing) {
    const m = /^[a-z]+-(\d{3})$/.exec(q.id || '');
    if (m) maxSeq = Math.max(maxSeq, Number(m[1]));
  }
  const added = [];
  for (const q of questions) {
    maxSeq += 1;
    const withId = { id: `${d.prefix}-${String(maxSeq).padStart(3, '0')}`, domain: d.name, ...q };
    withId.id = `${d.prefix}-${String(maxSeq).padStart(3, '0')}`; // enforce id even if model supplied one
    withId.domain = d.name;
    added.push(withId);
  }
  fs.writeFileSync(file, `${JSON.stringify([...existing, ...added], null, 2)}\n`);
  return added;
}
