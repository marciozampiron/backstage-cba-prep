// Finite-state assertions for the coordination surfaces (#106 closeout, round 2).
//
// Round 2 of the closeout review found CURRENT.md simultaneously telling a cold-start agent "may
// advance" and "must not advance": the resolved-prerequisite paragraphs coexisted with the stale
// blocked-state ones. The suite passed, because nothing asserted on these surfaces' STATE.
//
// These are deliberately FINITE assertions on known state transitions — exact phrases in, exact
// phrases out — not another generic prose scanner. Each transition below has exactly one truthful
// side; when a future transition legitimately flips one (a real regression of the Environments, a
// reopened decision), the corresponding line is updated WITH the document, under review, like the
// workflow-disclosure test this mirrors.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel) => readFileSync(join(here, '..', rel), 'utf8');

const CURRENT = read('.agent-handoff/CURRENT.md');
const H70 = read('.agent-handoff/done/70-cloudflare-aws-deploy-pipeline.md');
const D106 = read('.agent-handoff/done/106-dependabot-high-remediation.md');

test('#70 closeout: every canonical surface states the FINAL state — never the active one', () => {
  // Codex (closeout review, MEDIUM): the move alone left CURRENT.md claiming an open issue with
  // owners and an implementation in flight. These are finite refusals of the stale claims and
  // finite requirements of the final ones.
  for (const stale of ['#70 OPEN', 'active/70-cloudflare-aws-deploy-pipeline.md', 'assigned and in implementation']) {
    assert.ok(!CURRENT.includes(stale), `CURRENT.md must not claim: ${stale}`);
  }
  for (const required of ['PR #110', '4bb91ca', 'DELIVERED AND MERGED', 'NO deploy, NO QA']) {
    assert.ok(CURRENT.includes(required), `CURRENT.md must state: ${required}`);
  }
  assert.match(H70, /^# Done:/, 'the done/ handoff opens as Done');
  assert.ok(H70.includes('FINAL STATUS (2026-08-15): DELIVERED AND MERGED'));
  assert.ok(H70.includes('no QA ran'));
  // The newest event leads the log: the closeout block appears before the previously-newest one.
  const events = read('.agent-handoff/EVENTS.md');
  assert.ok(events.indexOf('## 2026-08-15 — #70 delivered, published and merged') < events.indexOf('## 2026-08-09'), 'newest entries go at the top');
  // Live surfaces never point at the removed path (historical logs in EVENTS/done are exempt).
  for (const rel of ['.agent-handoff/CURRENT.md', '.agent-handoff/decisions/70-spec-anchored-design-accepted.md', 'infra/aws/lib/deploy-preflight.js']) {
    assert.ok(!read(rel).includes('.agent-handoff/active/70-cloudflare'), `${rel} must reference done/, not the removed active/ path`);
  }
});

test('CURRENT.md carries exactly the resolved prerequisite state, with no stale contradiction', () => {
  // The stale side. Each of these sentences described the pre-2026-08-02 state; reintroducing any
  // of them puts the cold-start reader back into "must not advance".
  for (const stale of [
    'zero configured GitHub Environments',
    'the lane is ungated',
    'no deploy slice may be approved',
    'it is still open and is Zamp',
    'must be fixed or formally risk-accepted before the pilot GO',
    'custom-domain-vs-`workers.dev` decision',
    // Round 3 of this closeout: the two forms that SURVIVED the first sweep, hiding inside the
    // resolved-side paragraph itself. Exact strings, like every entry here.
    "#67's open decision",
    '#70 owns the account-level half of #67 (custom-domain decision',
  ]) {
    assert.equal(CURRENT.includes(stale), false, `CURRENT.md reintroduces a stale state: "${stale}"`);
  }
  // The resolved side — presence, not absence, so an over-deletion fails too.
  for (const resolved of [
    'the pilot uses the `workers.dev` origin',
    'whose only entry is `main`',
    'requires `marciozampiron` as reviewer',
    '6 HIGH Dependabot alerts are **RESOLVED**',
    'No AWS\nor Cloudflare deployment has happened yet',
    'can_admins_bypass: true',
    'prevent_self_review: false',
  ]) {
    assert.equal(CURRENT.includes(resolved), true, `CURRENT.md lost the resolved state: "${resolved}"`);
  }
});

test('the active #70 handoff agrees: decision closed, highs done, real gates still standing', () => {
  for (const stale of [
    'The open decision: custom domain',
    'The 6 high Dependabot alerts on the default branch must be fixed',
    'The custom-domain decision, since the CORS list',
  ]) {
    assert.equal(H70.includes(stale), false, `active/70 reintroduces a stale state: "${stale}"`);
  }
  for (const resolved of [
    'The origin decision is CLOSED: the pilot uses `workers.dev`',
    '**DECIDED by Zamp: the pilot uses the `workers.dev` origin.**',
    '**COMPLETED** (#106, PR #107',
    'can_admins_bypass: true',
    'prevent_self_review: false',
    'NOT non-bypassable',
  ]) {
    assert.equal(H70.includes(resolved), true, `active/70 lost the resolved state: "${resolved}"`);
  }
  // What must REMAIN open is as load-bearing as what closed: the SNS/KMS proof and the deploy-time
  // preflights are the standing gates, and losing them would overstate the resolution.
  assert.match(H70, /SNS\/KMS notification-path proof above — \*\*still required\*\*/);
  assert.match(H70, /\*\*still enforced at every deploy\*\*/);
});

test('done/106 records the FINAL PR #83 state, prescribing nothing already done', () => {
  assert.equal(D106.includes('recommend Zamp close it without merge'), false, 'the completed action must not stay prescribed');
  assert.match(D106, /CLOSED automatically by Dependabot/);
  assert.match(D106, /not merged, and no\naction remains/);
});
