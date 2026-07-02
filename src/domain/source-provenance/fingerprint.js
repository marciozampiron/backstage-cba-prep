import { createHash } from 'node:crypto';

const REVIEW_FIELDS = [
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

function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortValue(value[key])]));
}

// Stable fingerprint of the fields that determine a reviewed question. If any
// of these change, a prior semantic review becomes stale.
export function reviewFingerprint(question) {
  const payload = {};
  for (const field of REVIEW_FIELDS) {
    if (question[field] !== undefined) payload[field] = sortValue(question[field]);
  }
  return payload;
}

export function questionContentHash(question) {
  return createHash('sha256').update(JSON.stringify(reviewFingerprint(question))).digest('hex');
}

export function questionFingerprint(question) {
  return questionContentHash(question);
}
