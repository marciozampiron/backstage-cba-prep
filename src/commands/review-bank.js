import { resolveDomain } from '../lib/blueprint.js';
import { loadBank } from '../lib/bank.js';
import { loadReviewLedger, saveReviewLedger, REVIEW_LEDGER_FILE } from '../lib/review-ledger.js';
import { createReviewReport, findNextReviewCandidate, applyReviewDecision } from '../application/review-bank.js';
import { c, hr, ask, closeInput } from '../lib/ui.js';

function formatCounts(counts) {
  return 'verified ' + counts.verified + ' · unreviewed ' + counts.unreviewed + ' · stale ' + counts.stale + ' · flagged ' + counts.flagged;
}

function summarizeForJson(report) {
  return {
    total: report.total,
    counts: report.counts,
    complete: report.complete,
    states: report.states.map((state) => ({
      id: state.id,
      domainKey: state.domainKey,
      status: state.status,
      source: state.source,
      reason: state.reason || state.entry?.reason || undefined,
    })),
  };
}

function printReport(report, { domainKey } = {}) {
  console.log('\n  ' + c.bold('CBA review bank coverage') + (domainKey ? c.gray(' · ' + domainKey) : ''));
  console.log(hr());
  console.log('  ' + formatCounts(report.counts));
  console.log('  Total: ' + report.total + ' question(s)');
  if (report.counts.flagged || report.counts.stale) {
    console.log('\n  ' + c.bold('Needs attention:'));
    for (const state of report.states.filter((item) => item.status === 'flagged' || item.status === 'stale')) {
      const detail = state.status === 'flagged' ? ' · ' + (state.reason || state.entry?.reason || 'no reason') : '';
      console.log('    - ' + state.id + ' ' + c.yellow(state.status) + detail);
    }
  }
  console.log('\n  Ledger: ' + c.gray(REVIEW_LEDGER_FILE));
  console.log('  Next: node bin/cli.js review-bank next' + (domainKey ? ' --domain ' + domainKey : '') + '\n');
}

function printQuestion(question, state) {
  console.log('\n' + hr('═'));
  console.log('  ' + c.bold(question.id) + ' ' + c.gray('· ' + question.domain + ' · ' + question.difficulty));
  console.log('  Status: ' + c.bold(state.status));
  if (state.status === 'flagged' && (state.reason || state.entry?.reason)) console.log('  Reason: ' + c.yellow(state.reason || state.entry.reason));
  console.log(hr());
  console.log('  ' + question.question);
  for (const letter of ['A', 'B', 'C', 'D']) console.log('    ' + c.bold(letter) + '. ' + question.options[letter]);
  console.log('\n  Answer: ' + c.green(question.answer + '. ' + question.options[question.answer]));
  console.log('  Explanation: ' + c.gray(question.explanation));
  console.log('  Source: ' + c.cyan(question.source));
  console.log(hr('═'));
}

async function runNext(questions, ledger, opts) {
  const candidate = findNextReviewCandidate(questions, ledger, { domainKey: opts.domainKey });
  if (!candidate) {
    console.log(c.green('\n  ✓ No pending review items' + (opts.domainKey ? ' for ' + opts.domainKey : '') + '.\n'));
    return 0;
  }

  const { question, state } = candidate;
  if (opts.json) {
    console.log(JSON.stringify({ question, state }, null, 2));
    return 0;
  }

  printQuestion(question, state);
  console.log('  Actions: ' + c.bold('v') + '=verify  ' + c.bold('f') + '=flag  ' + c.bold('s') + '=skip');
  const action = (await ask('  > ')).trim().toLowerCase();
  try {
    if (action === 'v' || action === 'verify') {
      saveReviewLedger(applyReviewDecision(ledger, question, 'verified'));
      console.log(c.green('\n  ✓ Marked ' + question.id + ' as verified.\n'));
      return 0;
    }
    if (action === 'f' || action === 'flag') {
      const reason = (await ask('  reason > ')).trim();
      saveReviewLedger(applyReviewDecision(ledger, question, 'flagged', { reason }));
      console.log(c.yellow('\n  Flagged ' + question.id + '.\n'));
      return 0;
    }
  } catch (err) {
    console.log(c.red('\n  ✗ ' + err.message + '\n'));
    return 1;
  } finally {
    closeInput();
  }

  console.log(c.gray('\n  Skipped. Ledger unchanged.\n'));
  return 0;
}

export async function runReviewBank(opts = {}) {
  const { all } = loadBank();
  const ledger = loadReviewLedger();
  let domainKey = null;
  if (typeof opts.domain === 'string') {
    const domain = resolveDomain(opts.domain);
    if (!domain) {
      console.log(c.red('  Unknown domain "' + opts.domain + '".'));
      return 1;
    }
    domainKey = domain.key;
  }

  if (opts.subcommand === 'next') return runNext(all, ledger, { ...opts, domainKey });

  const report = createReviewReport(all, ledger, { domainKey });
  if (opts.json) {
    console.log(JSON.stringify(summarizeForJson(report), null, 2));
    return 0;
  }
  printReport(report, { domainKey });
  return 0;
}
