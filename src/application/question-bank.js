import { OPTION_KEYS, validateQuestion } from '../domain/exam-content/question-validation.js';

export function shuffle(items, random = Math.random) {
  const r = items.slice();
  for (let i = r.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [r[i], r[j]] = [r[j], r[i]];
  }
  return r;
}

export function sampleQuestions(byDomain, domains, allocation, count, { domainKey } = {}) {
  if (domainKey) return shuffle(byDomain[domainKey] || []).slice(0, count);

  const picked = [];
  const leftovers = [];
  for (const domain of domains) {
    const pool = shuffle(byDomain[domain.key] || []);
    const n = Math.min(allocation[domain.key] || 0, pool.length);
    picked.push(...pool.slice(0, n));
    leftovers.push(...pool.slice(n));
  }
  if (picked.length < count) picked.push(...shuffle(leftovers).slice(0, count - picked.length));
  return shuffle(picked).slice(0, count);
}

export function validateQuestionBank(byDomain, domains, { loadErrors = [] } = {}) {
  const all = [...loadErrors];
  const seen = new Set();
  const answerCounts = Object.fromEntries(OPTION_KEYS.map((k) => [k, 0]));
  let count = 0;

  for (const domain of domains) {
    const domainQuestions = byDomain[domain.key] || [];
    for (let i = 0; i < domainQuestions.length; i++) {
      const q = domainQuestions[i];
      count += 1;
      all.push(...validateQuestion(q, domain, seen, { domainKey: domain.key }));
      if (OPTION_KEYS.includes(q?.answer)) answerCounts[q.answer] += 1;

      const expectedId = domain.prefix + '-' + String(i + 1).padStart(3, '0');
      if (q?.id && q.id !== expectedId) all.push(q.id + ': expected sequential id ' + expectedId + ' at position ' + (i + 1) + ' in ' + domain.key + '.json');
    }
  }

  if (count >= OPTION_KEYS.length * 3) {
    const max = Math.max(...Object.values(answerCounts));
    const min = Math.min(...Object.values(answerCounts));
    if (min === 0 || max - min > Math.ceil(count * 0.35)) {
      all.push('answer distribution is too skewed: ' + OPTION_KEYS.map((k) => k + ':' + answerCounts[k]).join(' '));
    }
  }

  return { errors: all, count };
}

export function prepareQuestionsForAppend(domain, existing, questions) {
  let maxSeq = 0;
  for (const q of existing) {
    const m = /^[a-z]+-(\d{3})$/.exec(q.id || '');
    if (m) maxSeq = Math.max(maxSeq, Number(m[1]));
  }

  const added = [];
  for (const q of questions) {
    maxSeq += 1;
    const id = domain.prefix + '-' + String(maxSeq).padStart(3, '0');
    const withId = { id, domain: domain.name, ...q };
    withId.id = id;
    withId.domain = domain.name;
    added.push(withId);
  }
  return added;
}
