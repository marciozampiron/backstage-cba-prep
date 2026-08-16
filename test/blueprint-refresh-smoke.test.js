// The smoke_only contract (#111/#117): wiring assertions on the workflow, and BEHAVIORAL proofs
// that EXECUTE scripts/standard-smoke.sh with a fake `aws` on PATH — refusals are proven by
// running them, not by grepping for their messages (Codex, round 3).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WF = parse(fs.readFileSync(path.join(ROOT, '.github/workflows/blueprint-refresh.yml'), 'utf8'));
const smokeJob = WF.jobs.smoke;
const SCRIPT = path.join(ROOT, 'scripts/standard-smoke.sh');

/* ── wiring ── */

test('smoke_only wiring: closed input, SHA binding BEFORE OIDC, minimal permissions, refresh barred', () => {
  const inputs = (WF.on ?? WF[true]).workflow_dispatch.inputs;
  assert.equal(inputs.smoke_only.type, 'boolean');
  assert.equal(inputs.smoke_only.default, false);
  assert.ok(inputs.authorized_sha, 'authorized_sha input exists');
  assert.ok(inputs.spend_decision_id, 'spend_decision_id input exists');
  assert.match(smokeJob.if, /smoke_only == 'true'/);
  assert.deepEqual(smokeJob.permissions, { contents: 'read', 'id-token': 'write', actions: 'read' }); // actions:read = the anti-replay ledger, nothing more
  const names = smokeJob.steps.map((s) => s.name ?? s.uses);
  const gateIdx = names.findIndex((n) => /Fail closed before OIDC/.test(n));
  const oidcIdx = names.findIndex((n) => /Configure AWS credentials|configure-aws-credentials/.test(String(n)));
  assert.ok(gateIdx >= 0 && oidcIdx > gateIdx, 'the SHA-binding gate runs BEFORE OIDC credentials');
  const gate = smokeJob.steps[gateIdx].run;
  assert.match(gate, /\^\[0-9a-f\]\{40\}\$/, 'authorized_sha must be full 40-hex');
  assert.match(gate, /"\$AUTHORIZED_SHA" = "\$GITHUB_SHA"/, 'the run must BE the authorized commit');
  assert.match(gate, /zamp-\[a-z0-9\]\[a-z0-9\._-\]\{0,79\}/, 'the decision id has a CLOSED grammar in the gate');
  const smoke = smokeJob.steps[smokeJob.steps.length - 1];
  assert.equal(smoke.run.trim(), 'bash scripts/standard-smoke.sh', 'the LAST step runs the testable script file');
  assert.equal(smoke.env.AWS_MAX_ATTEMPTS, '1');
  assert.match(WF.jobs.refresh.if, /smoke_only != 'true'/, 'the refresh job is barred at job level');
});

/* ── behavioral harness: a fake aws records every converse and answers per scenario ── */

const GOOD_ARN = 'arn:aws:iam::111122223333:role/cba-study-coach-gha-bedrock-refresh';
function runSmoke({ callerAccount = '111122223333', callerRole = 'cba-study-coach-gha-bedrock-refresh', model = 'us.anthropic.claude-sonnet-5', stopReason = 'end_turn', converseExit = 0, spendId = 'zamp-smoke-01',
  approvedAt = new Date(Date.now() - 60_000).toISOString().replace(/\.\d+Z/, 'Z'),
  expiresAt = new Date(Date.now() + 30 * 60_000).toISOString().replace(/\.\d+Z/, 'Z') } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cba-smoke-'));
  const calls = path.join(dir, 'converse-calls');
  const stsCalls = path.join(dir, 'sts-calls');
  fs.writeFileSync(calls, '');
  fs.writeFileSync(stsCalls, '');
  const fakeAws = `#!/usr/bin/env bash
if [ "$1" = "sts" ]; then
  echo x >> '${stsCalls}'
  printf '{"Arn":"arn:aws:sts::${callerAccount}:assumed-role/${callerRole}/gha","Account":"${callerAccount}"}'
  exit 0
fi
if [ "$1" = "bedrock-runtime" ] && [ "$2" = "converse" ]; then
  echo x >> '${calls}'
  [ ${converseExit} -ne 0 ] && exit ${converseExit}
  printf '${stopReason}'
  exit 0
fi
echo "unexpected aws $*" >&2; exit 90
`;
  fs.writeFileSync(path.join(dir, 'aws'), fakeAws, { mode: 0o755 });
  let out = '';
  let code = 0;
  try {
    out = execFileSync('bash', [SCRIPT], {
      encoding: 'utf8',
      env: {
        PATH: `${dir}:${process.env.PATH}`,
        AWS_BEDROCK_REFRESH_ROLE_ARN: GOOD_ARN,
        BEDROCK_MODEL_STANDARD: model,
        AWS_REGION: 'us-east-1',
        AUTHORIZED_SHA: 'a'.repeat(40),
        SPEND_DECISION_ID: spendId,
        APPROVED_AT: approvedAt,
        EXPIRES_AT: expiresAt,
      },
    });
  } catch (e) {
    out = `${e.stdout ?? ''}${e.stderr ?? ''}`;
    code = e.status ?? 1;
  }
  const converseCalls = fs.readFileSync(calls, 'utf8').split('\n').filter(Boolean).length;
  const sts = fs.readFileSync(stsCalls, 'utf8').split('\n').filter(Boolean).length;
  fs.rmSync(dir, { recursive: true, force: true });
  return { out, code, converseCalls, sts };
}

test('EXECUTED: divergent account, divergent role and divergent model each refuse with ZERO Converse calls', () => {
  const acct = runSmoke({ callerAccount: '999988887777' });
  assert.notEqual(acct.code, 0);
  assert.match(acct.out, /caller account diverges/);
  assert.equal(acct.converseCalls, 0, 'divergent account: zero paid calls');
  const role = runSmoke({ callerRole: 'some-other-role' });
  assert.notEqual(role.code, 0);
  assert.match(role.out, /identity is not the refresh role/);
  assert.ok(!/111122223333/.test(role.out), 'the account is never printed');
  assert.equal(role.converseCalls, 0, 'divergent role: zero paid calls');
  const model = runSmoke({ model: 'us.anthropic.claude-opus-5' });
  assert.notEqual(model.code, 0);
  assert.match(model.out, /diverges from the approved standard profile/);
  assert.equal(model.converseCalls, 0, 'divergent model: zero paid calls');
});

test('EXECUTED: a non-end_turn stopReason is a RED run — after exactly one attempt', () => {
  const r = runSmoke({ stopReason: 'max_tokens' });
  assert.notEqual(r.code, 0);
  assert.match(r.out, /stopReason=max_tokens is not end_turn/);
  assert.equal(r.converseCalls, 1);
});

test('EXECUTED: a failing Converse makes exactly ONE attempt — never a second', () => {
  const r = runSmoke({ converseExit: 254 });
  assert.notEqual(r.code, 0);
  assert.equal(r.converseCalls, 1, 'set -e stops after the single failed attempt');
});

test('EXECUTED: every invalid spend_decision_id refuses BEFORE any AWS call — zero STS, zero Converse, nothing echoed', () => {
  const evil = [
    ['', 'empty'],
    ['zamp-ok\nFORGED_EVIDENCE=1', 'newline injection'],
    ['zamp ok', 'space'],
    ['zamp-ok\u0001', 'control character'],
    ['evil-decision', 'wrong prefix'],
    ['zamp-' + 'a'.repeat(90), 'over-length'],
  ];
  for (const [id, label] of evil) {
    const r = runSmoke({ spendId: id });
    assert.notEqual(r.code, 0, `${label} must be red`);
    assert.equal(r.sts, 0, `${label}: zero STS calls`);
    assert.equal(r.converseCalls, 0, `${label}: zero Converse calls`);
    assert.match(r.out, /fails the closed grammar/, label);
    assert.ok(!r.out.includes('FORGED_EVIDENCE') && !r.out.includes('evil-decision'), `${label}: no input-controlled value in the output`);
  }
});

test('EXECUTED: success is exactly one attempt with the complete masked evidence', () => {
  const r = runSmoke({});
  assert.equal(r.code, 0, r.out);
  assert.equal(r.converseCalls, 1);
  for (const line of ['SMOKE EVIDENCE', 'identity=arn:aws:sts::ACCOUNT:assumed-role/cba-study-coach-gha-bedrock-refresh/gha (refresh role confirmed, account matched)', 'region=us-east-1', 'model=us.anthropic.claude-sonnet-5', 'stopReason=end_turn', 'attempts=1', `authorized_sha=${'a'.repeat(40)}`, 'spend_decision=zamp-smoke-01']) {
    assert.ok(r.out.includes(line), `evidence line: ${line}`);
  }
  assert.ok(!/111122223333/.test(r.out), 'no raw account digits anywhere');
  assert.equal((r.out.match(/^spend_decision=/gm) ?? []).length, 1, 'exactly ONE canonical spend_decision line');
  assert.equal((r.out.match(/^authorized_sha=/gm) ?? []).length, 1, 'exactly ONE canonical authorized_sha line');
});


test('EXECUTED: an expired, premature, inverted or over-TTL decision refuses with ZERO AWS calls', () => {
  const past = (min) => new Date(Date.now() - min * 60_000).toISOString().replace(/\.\d+Z/, 'Z');
  const future = (min) => new Date(Date.now() + min * 60_000).toISOString().replace(/\.\d+Z/, 'Z');
  const cases = [
    [{ approvedAt: past(120), expiresAt: past(60) }, /decision expired/, 'expired'],
    [{ approvedAt: future(10), expiresAt: future(40) }, /not yet valid/, 'premature'],
    [{ approvedAt: future(10), expiresAt: past(10) }, /inverted or empty/, 'inverted'],
    [{ approvedAt: past(1), expiresAt: future(120) }, /TTL exceeds one hour/, 'over-TTL'],
    [{ approvedAt: '2026-08-16 08:00:00Z', expiresAt: future(10) }, /strict UTC Z/, 'malformed'],
  ];
  for (const [over, re, label] of cases) {
    const r = runSmoke(over);
    assert.notEqual(r.code, 0, label);
    assert.match(r.out, re, label);
    assert.equal(r.sts, 0, `${label}: zero STS`);
    assert.equal(r.converseCalls, 0, `${label}: zero Converse`);
  }
});

/* ── anti-replay: executed with a fake gh serving the run ledger ── */

const ANTIREPLAY = path.join(ROOT, 'scripts/smoke-antireplay.sh');
const SHA_A = 'a'.repeat(40);
const SELF = { id: 424242, display_title: 'smoke zamp-smoke-01', run_attempt: 1, head_sha: SHA_A, event: 'workflow_dispatch' };
function runAntiReplay({ runs, totalCount = null, ghExit = 0, ghHang = 0, ledgerTimeout = null, ghBody = null, decision = 'zamp-smoke-01', repo = 'marciozampiron/backstage-cba-prep', attempt = '1', sha = SHA_A } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cba-ar-'));
  const list = runs ?? [SELF];
  const body = ghBody ?? JSON.stringify({ total_count: totalCount ?? list.length, workflow_runs: list });
  fs.writeFileSync(path.join(dir, 'gh'), `#!/usr/bin/env bash
[ ${ghHang} -ne 0 ] && sleep 30
[ ${ghExit} -ne 0 ] && exit ${ghExit}
printf '%s' '${body.replace(/'/g, "'\\''")}'
`, { mode: 0o755 });
  let out = ''; let code = 0;
  try {
    out = execFileSync('bash', [ANTIREPLAY], { encoding: 'utf8', env: { PATH: `${dir}:${process.env.PATH}`, SPEND_DECISION_ID: decision, GITHUB_RUN_ID: '424242', GITHUB_RUN_ATTEMPT: attempt, GITHUB_REPOSITORY: repo, AUTHORIZED_SHA: sha, ...(ledgerTimeout ? { LEDGER_TIMEOUT_SECONDS: ledgerTimeout } : {}) } });
  } catch (e) { out = `${e.stdout ?? ''}${e.stderr ?? ''}`; code = e.status ?? 1; }
  fs.rmSync(dir, { recursive: true, force: true });
  return { out, code };
}
const priorRun = (over = {}) => ({ id: 111, display_title: 'smoke zamp-smoke-01', run_attempt: 1, head_sha: SHA_A, event: 'workflow_dispatch', ...over });

test('EXECUTED anti-replay v2: attempt 1 with a complete ledger and this run as its ONLY witness is eligible', () => {
  const r = runAntiReplay({});
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /eligible/);
});

test('EXECUTED anti-replay v2: a RERUN refuses before anything — attempt != 1, missing or non-canonical', () => {
  for (const attempt of ['2', '10', '', '01', 'x']) {
    const r = runAntiReplay({ attempt });
    assert.notEqual(r.code, 0, `attempt=${JSON.stringify(attempt)}`);
    assert.match(r.out, /rerun detected|GITHUB_RUN_ATTEMPT is missing or non-canonical/, `attempt=${JSON.stringify(attempt)}`);
  }
});

test('EXECUTED anti-replay v2: ANY prior run with the decision refuses — whatever its outcome', () => {
  for (const status of [{}, { run_attempt: 2 }, { head_sha: 'b'.repeat(40) }]) {
    const r = runAntiReplay({ runs: [SELF, priorRun(status)], totalCount: 2 });
    assert.notEqual(r.code, 0);
    assert.match(r.out, /consumable ONCE, whatever its outcome/);
  }
});

test('EXECUTED anti-replay v2: structural ambiguity ALWAYS refuses — empty, bad page, count drift, self absent/duplicated/divergent', () => {
  const cases = [
    [{ ghBody: '' }, /NO_PAGES|unparseable/, 'empty output'],
    [{ ghBody: '{}' }, /BAD_PAGE/, 'page without fields'],
    [{ ghBody: JSON.stringify({ total_count: 1, workflow_runs: [{ id: 424242 }] }) }, /BAD_RUN_FIELDS/, 'run missing fields'],
    [{ runs: [SELF], totalCount: 0 }, /COUNT_MISMATCH 1\/0/, 'FETCHED > TOTAL'],
    [{ runs: [SELF], totalCount: 5 }, /COUNT_MISMATCH 1\/5/, 'FETCHED < TOTAL'],
    [{ runs: [priorRun()], totalCount: 1 }, /SELF_COUNT 0/, 'current run absent from the ledger'],
    [{ runs: [SELF, { ...SELF }], totalCount: 2 }, /SELF_COUNT 2/, 'current run duplicated'],
    [{ runs: [{ ...SELF, head_sha: 'c'.repeat(40) }] }, /SELF_DIVERGES/, 'current head_sha diverges'],
    [{ runs: [{ ...SELF, event: 'push' }] }, /SELF_DIVERGES/, 'current event diverges'],
    [{ runs: [{ ...SELF, run_attempt: 2 }] }, /SELF_DIVERGES/, 'ledger shows attempt 2 for self'],
    [{ runs: [{ ...SELF, display_title: 'smoke zamp-other' }] }, /SELF_DIVERGES/, 'current title diverges'],
    [{ ghExit: 1 }, /listing failed/, 'API failure'],
    [{ repo: 'someone/else' }, /canonical repository/, 'foreign repo'],
  ];
  for (const [over, re, label] of cases) {
    const r = runAntiReplay(over);
    assert.notEqual(r.code, 0, label);
    assert.match(r.out, re, label);
  }
});

test('anti-replay wiring: ledger check BEFORE OIDC, serialized concurrency by decision, run-name is the ledger key', () => {
  const names = smokeJob.steps.map((s) => s.name ?? s.uses);
  const arIdx = names.findIndex((n) => /Anti-replay/.test(String(n)));
  const oidcIdx = names.findIndex((n) => /Configure AWS credentials/.test(String(n)));
  assert.ok(arIdx >= 0 && oidcIdx > arIdx, 'anti-replay runs BEFORE OIDC (hence before STS/Converse)');
  assert.equal(smokeJob.concurrency['cancel-in-progress'], false);
  assert.match(String(smokeJob.concurrency.group), /spend_decision_id/);
  assert.deepEqual(smokeJob.permissions, { contents: 'read', 'id-token': 'write', actions: 'read' });
  const raw = fs.readFileSync(path.join(ROOT, '.github/workflows/blueprint-refresh.yml'), 'utf8');
  assert.match(raw, /run-name:.*smoke \{0\}.*spend_decision_id/, 'the run-name carries the decision id');
  const inputs = (WF.on ?? WF[true]).workflow_dispatch.inputs;
  assert.ok(inputs.approved_at && inputs.expires_at, 'window inputs exist');
});


test('EXECUTED anti-replay v3: a HUNG ledger refuses by name within the injected deadline — never a wait, never partial output', () => {
  const t0 = Date.now();
  const r = runAntiReplay({ ghHang: 1, ledgerTimeout: '1' });
  const elapsed = Date.now() - t0;
  assert.notEqual(r.code, 0);
  assert.match(r.out, /ledger query timed out after 1s/, 'the timeout is a NAMED refusal');
  assert.ok(!/eligible/.test(r.out), 'partial output is never accepted as a ledger');
  assert.ok(elapsed < 10_000, `finished in ${elapsed}ms — the deadline bites, the job does not hang`);
});

test('anti-replay v3 pins: neither the call deadline nor the job time-box can be removed', () => {
  const script = fs.readFileSync(ANTIREPLAY, 'utf8');
  assert.match(script, /timeout --foreground "\$\{LEDGER_TIMEOUT\}s" gh api/, 'the ledger call runs under an explicit deadline');
  assert.match(script, /LEDGER_TIMEOUT_SECONDS:-60/, '60s default, injectable for tests');
  assert.match(script, /-eq 124/, 'the timeout exit maps to the named refusal');
  assert.equal(smokeJob['timeout-minutes'], 5, 'the smoke job is time-boxed as the second barrier');
});
