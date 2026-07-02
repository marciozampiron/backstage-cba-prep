import fs from 'node:fs';
import path from 'node:path';
import { SPEC_DIR } from './paths.js';
import { emptyReviewLedger, normalizeReviewLedger } from '../domain/authoring-review/review-ledger.js';

export const REVIEW_LEDGER_FILE = process.env.CBA_REVIEW_LEDGER_FILE || path.join(SPEC_DIR, 'review-ledger.json');

export function loadReviewLedger(file = REVIEW_LEDGER_FILE) {
  try {
    return normalizeReviewLedger(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch (err) {
    if (err.code === 'ENOENT') return emptyReviewLedger();
    throw err;
  }
}

export function saveReviewLedger(ledger, file = REVIEW_LEDGER_FILE) {
  const normalized = normalizeReviewLedger(ledger);
  fs.writeFileSync(file, JSON.stringify(normalized, null, 2) + '\n');
  return normalized;
}
