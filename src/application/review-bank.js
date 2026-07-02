import {
  buildReviewReport,
  nextReviewCandidate,
  recordReviewDecision,
} from '../domain/authoring-review/review-ledger.js';

export function createReviewReport(questions, ledger, { domainKey } = {}) {
  const filtered = domainKey ? questions.filter((question) => question._domainKey === domainKey) : questions;
  return buildReviewReport(filtered, ledger);
}

export function findNextReviewCandidate(questions, ledger, { domainKey } = {}) {
  return nextReviewCandidate(questions, ledger, { domainKey });
}

export function applyReviewDecision(ledger, question, decision, opts = {}) {
  return recordReviewDecision(ledger, question, decision, opts);
}
