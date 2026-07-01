import fs from 'node:fs';
import path from 'node:path';
import { DOMAINS, domainByKey, allocate } from './blueprint.js';
import { QUESTIONS_DIR } from './paths.js';

const DIFFICULTIES = ['easy', 'medium', 'hard'];
const OPTION_KEYS = ['A', 'B', 'C', 'D'];
const QUESTION_KEYS = [
  'id',
  'domain',
  'competency',
  'difficulty',
  'question',
  'options',
  'answer',
  'explanation',
  'source',
  'tags',
];

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

  if (!q || typeof q !== 'object' || Array.isArray(q)) {
    return [`${label}: question must be an object`];
  }

  const extraQuestionKeys = Object.keys(q).filter((k) => !QUESTION_KEYS.includes(k) && !k.startsWith('_'));
  if (extraQuestionKeys.length) errs.push(`${label}: unexpected question keys: ${extraQuestionKeys.join(', ')}`);

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
  if (!opts || typeof opts !== 'object' || Array.isArray(opts)) {
    errs.push(`${label}: options must be an object with A/B/C/D keys`);
  } else {
    for (const k of OPTION_KEYS) if (typeof opts[k] !== 'string' || !opts[k].trim()) errs.push(`${label}: missing/empty option ${k}`);
    const extra = Object.keys(opts).filter((k) => !OPTION_KEYS.includes(k));
    if (extra.length) errs.push(`${label}: unexpected option keys: ${extra.join(', ')}`);

    const normalizedOptions = OPTION_KEYS
      .map((k) => (typeof opts[k] === 'string' ? opts[k].trim().replace(/\s+/g, ' ') : null))
      .filter(Boolean);
    const duplicates = normalizedOptions.filter((option, i) => normalizedOptions.indexOf(option) !== i);
    if (duplicates.length) errs.push(`${label}: duplicate option text: ${[...new Set(duplicates)].join('; ')}`);
  }

  if (!OPTION_KEYS.includes(q.answer)) errs.push(`${label}: answer must be one of A|B|C|D`);
  if (typeof q.explanation !== 'string' || q.explanation.trim().length < 10) errs.push(`${label}: explanation missing or too short`);
  if (typeof q.source !== 'string' || !/^https?:\/\//.test(q.source)) {
    errs.push(`${label}: source must be an http(s) URL`);
  } else {
    try {
      const url = new URL(q.source);
      const officialBackstageDoc = url.origin === 'https://backstage.io' && url.pathname.startsWith('/docs/');
      const officialBlueprint =
        url.origin === 'https://training.linuxfoundation.org' &&
        url.pathname.startsWith('/certification/certified-backstage-associate-cba');
      if (!officialBackstageDoc && !officialBlueprint) {
        errs.push(`${label}: source must be an official Backstage docs or LF CBA blueprint URL`);
      }
    } catch {
      errs.push(`${label}: source must be a valid URL`);
    }
  }
  if (q.tags !== undefined) {
    if (!Array.isArray(q.tags)) errs.push(`${label}: tags must be an array of strings`);
    else {
      for (const [i, tag] of q.tags.entries()) {
        if (typeof tag !== 'string') errs.push(`${label}: tags[${i}] must be a string`);
      }
    }
  }
  return errs;
}

export function validateBank() {
  const { byDomain, errors } = loadBank();
  const all = [...errors];
  const seen = new Set();
  const answerCounts = Object.fromEntries(OPTION_KEYS.map((k) => [k, 0]));
  let count = 0;
  for (const d of DOMAINS) {
    const domainQuestions = byDomain[d.key] || [];
    for (let i = 0; i < domainQuestions.length; i++) {
      const q = domainQuestions[i];
      count += 1;
      all.push(...validateQuestion(q, d.key, seen));
      if (OPTION_KEYS.includes(q?.answer)) answerCounts[q.answer] += 1;

      const expectedId = `${d.prefix}-${String(i + 1).padStart(3, '0')}`;
      if (q?.id && q.id !== expectedId) all.push(`${q.id}: expected sequential id ${expectedId} at position ${i + 1} in ${d.key}.json`);
    }
  }
  if (count >= OPTION_KEYS.length * 3) {
    const max = Math.max(...Object.values(answerCounts));
    const min = Math.min(...Object.values(answerCounts));
    if (min === 0 || max - min > Math.ceil(count * 0.35)) {
      all.push(`answer distribution is too skewed: ${OPTION_KEYS.map((k) => `${k}:${answerCounts[k]}`).join(' ')}`);
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
