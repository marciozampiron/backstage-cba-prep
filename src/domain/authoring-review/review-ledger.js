import { questionContentHash } from '../source-provenance/fingerprint.js';

export const REVIEW_LEDGER_VERSION = 1;
export const REVIEW_STATUSES = ['unreviewed', 'verified', 'flagged', 'stale'];
export const PERSISTED_REVIEW_STATUSES = ['verified', 'flagged'];

export function emptyReviewLedger() {
  return { version: REVIEW_LEDGER_VERSION, reviews: {} };
}

export function normalizeReviewLedger(ledger) {
  if (!ledger || typeof ledger !== 'object' || Array.isArray(ledger)) return emptyReviewLedger();
  const reviews = ledger.reviews && typeof ledger.reviews === 'object' && !Array.isArray(ledger.reviews) ? ledger.reviews : {};
  return { version: REVIEW_LEDGER_VERSION, reviews: { ...reviews } };
}

export function reviewStateForQuestion(question, ledger) {
  const normalized = normalizeReviewLedger(ledger);
  const hash = questionContentHash(question);
  const entry = normalized.reviews[question.id] || null;
  const base = {
    id: question.id,
    domainKey: question._domainKey || null,
    domain: question.domain,
    competency: question.competency,
    source: question.source,
    hash,
    entry,
  };

  if (!entry) return { ...base, status: 'unreviewed' };
  if (entry.hash !== hash) return { ...base, status: 'stale' };
  if (entry.status === 'verified') return { ...base, status: 'verified' };
  if (entry.status === 'flagged') return { ...base, status: 'flagged', reason: entry.reason || '' };
  return { ...base, status: 'unreviewed' };
}

export function summarizeReviewStates(states) {
  const counts = { verified: 0, unreviewed: 0, stale: 0, flagged: 0 };
  for (const state of states) {
    if (counts[state.status] !== undefined) counts[state.status] += 1;
  }
  return {
    total: states.length,
    counts,
    complete: states.length > 0 && states.every((state) => state.status === 'verified'),
  };
}

export function buildReviewReport(questions, ledger) {
  const states = questions.map((question) => reviewStateForQuestion(question, ledger));
  return { ...summarizeReviewStates(states), states };
}

export function nextReviewCandidate(questions, ledger, { domainKey } = {}) {
  const filtered = domainKey ? questions.filter((question) => question._domainKey === domainKey) : questions;
  const states = filtered.map((question) => ({ question, state: reviewStateForQuestion(question, ledger) }));
  return states.find((item) => item.state.status === 'flagged') || states.find((item) => item.state.status === 'stale') || states.find((item) => item.state.status === 'unreviewed') || null;
}

export function recordReviewDecision(ledger, question, decision, { reason, reviewedAt = new Date().toISOString(), reviewer = 'human' } = {}) {
  if (!PERSISTED_REVIEW_STATUSES.includes(decision)) {
    throw new Error('review decision must be verified or flagged');
  }
  if (decision === 'flagged' && (!reason || !String(reason).trim())) {
    throw new Error('flagged review requires a reason');
  }

  const normalized = normalizeReviewLedger(ledger);
  const entry = {
    status: decision,
    hash: questionContentHash(question),
    reviewedAt,
    reviewer,
    source: question.source,
  };
  if (decision === 'flagged') entry.reason = String(reason).trim();
  normalized.reviews[question.id] = entry;
  return normalized;
}
