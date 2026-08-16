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
  assert.deepEqual(smokeJob.permissions, { contents: 'read', 'id-token': 'write' });
  const names = smokeJob.steps.map((s) => s.name ?? s.uses);
  const gateIdx = names.findIndex((n) => /Fail closed before OIDC/.test(n));
  const oidcIdx = names.findIndex((n) => /Configure AWS credentials|configure-aws-credentials/.test(String(n)));
  assert.ok(gateIdx >= 0 && oidcIdx > gateIdx, 'the SHA-binding gate runs BEFORE OIDC credentials');
  const gate = smokeJob.steps[gateIdx].run;
  assert.match(gate, /\^\[0-9a-f\]\{40\}\$/, 'authorized_sha must be full 40-hex');
  assert.match(gate, /"\$AUTHORIZED_SHA" = "\$GITHUB_SHA"/, 'the run must BE the authorized commit');
  assert.match(gate, /SPEND_DECISION_ID" \]/, 'the decision id is required');
  const smoke = smokeJob.steps[smokeJob.steps.length - 1];
  assert.equal(smoke.run.trim(), 'bash scripts/standard-smoke.sh', 'the LAST step runs the testable script file');
  assert.equal(smoke.env.AWS_MAX_ATTEMPTS, '1');
  assert.match(WF.jobs.refresh.if, /smoke_only != 'true'/, 'the refresh job is barred at job level');
});

/* ── behavioral harness: a fake aws records every converse and answers per scenario ── */

const GOOD_ARN = 'arn:aws:iam::111122223333:role/cba-study-coach-gha-bedrock-refresh';
function runSmoke({ callerAccount = '111122223333', callerRole = 'cba-study-coach-gha-bedrock-refresh', model = 'us.anthropic.claude-sonnet-5', stopReason = 'end_turn', converseExit = 0 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cba-smoke-'));
  const calls = path.join(dir, 'converse-calls');
  fs.writeFileSync(calls, '');
  const fakeAws = `#!/usr/bin/env bash
if [ "$1" = "sts" ]; then
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
        SPEND_DECISION_ID: 'zamp-smoke-01',
      },
    });
  } catch (e) {
    out = `${e.stdout ?? ''}${e.stderr ?? ''}`;
    code = e.status ?? 1;
  }
  const converseCalls = fs.readFileSync(calls, 'utf8').split('\n').filter(Boolean).length;
  fs.rmSync(dir, { recursive: true, force: true });
  return { out, code, converseCalls };
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

test('EXECUTED: success is exactly one attempt with the complete masked evidence', () => {
  const r = runSmoke({});
  assert.equal(r.code, 0, r.out);
  assert.equal(r.converseCalls, 1);
  for (const line of ['SMOKE EVIDENCE', 'identity=arn:aws:sts::ACCOUNT:assumed-role/cba-study-coach-gha-bedrock-refresh/gha (refresh role confirmed, account matched)', 'region=us-east-1', 'model=us.anthropic.claude-sonnet-5', 'stopReason=end_turn', 'attempts=1', `authorized_sha=${'a'.repeat(40)}`, 'spend_decision=zamp-smoke-01']) {
    assert.ok(r.out.includes(line), `evidence line: ${line}`);
  }
  assert.ok(!/111122223333/.test(r.out), 'no raw account digits anywhere');
});
