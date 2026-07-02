import fs from 'node:fs';
import path from 'node:path';
import { DOMAINS, domainByKey, allocate } from './blueprint.js';
import { QUESTIONS_DIR } from './paths.js';
import {
  prepareQuestionsForAppend,
  sampleQuestions,
  shuffle,
  validateQuestionBank,
} from '../application/question-bank.js';
import { validateQuestion as validateDomainQuestion } from '../domain/exam-content/question-validation.js';

export { shuffle };

export function fileForDomain(key) {
  return path.join(QUESTIONS_DIR, key + '.json');
}

// Load every domain file. Never throws: parse/read problems are returned as errors.
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
        errors.push(d.key + '.json is not a JSON array');
        arr = [];
      }
    } catch (err) {
      errors.push('Cannot read/parse ' + d.key + '.json: ' + err.message);
      arr = [];
    }
    for (const q of arr) if (q && typeof q === 'object') q._domainKey = d.key;
    byDomain[d.key] = arr;
    all.push(...arr);
  }
  return { all, byDomain, errors };
}

// Pick count questions. With { domainKey } it draws from one domain; otherwise it
// spreads across domains by the blueprint budget and fills any shortfall from the rest.
export function sample(count, { domainKey } = {}) {
  const { byDomain } = loadBank();
  return sampleQuestions(byDomain, DOMAINS, allocate(count), count, { domainKey });
}

// Validate a single question object against the schema rules. Returns an array of error strings.
export function validateQuestion(q, domainKey, seen) {
  return validateDomainQuestion(q, domainByKey(domainKey), seen, { domainKey });
}

export function validateBank() {
  const { byDomain, errors } = loadBank();
  return validateQuestionBank(byDomain, DOMAINS, { loadErrors: errors });
}

// Append validated questions to a domain file, auto-numbering ids sequentially.
export function appendQuestions(domainKey, questions) {
  const domain = domainByKey(domainKey);
  if (!domain) throw new Error('unknown domain: ' + domainKey);
  const file = fileForDomain(domainKey);
  const existing = JSON.parse(fs.readFileSync(file, 'utf8'));
  const added = prepareQuestionsForAppend(domain, existing, questions);
  fs.writeFileSync(file, JSON.stringify([...existing, ...added], null, 2) + '\n');
  return added;
}
