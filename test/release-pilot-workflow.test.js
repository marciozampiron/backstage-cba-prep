// Static invariants for .github/workflows/release-pilot.yml (#70 Slice A).
//
// The properties that matter are structural and cannot be unit-tested by running the lane: an
// immutable release identity, no direct-to-pilot path, no caller-supplied deploy targets, and a
// deploy that is bound to the configuration a preflight actually validated.
//
// The checks are a PURE function over supplied text, so the real file can be proven to satisfy them
// AND mutations can be proven to break them in the same run. The first version of this file asserted
// only against disk and shipped three defects because of it — one of which (a job parser that never
// split the file) made every per-job rule vacuously true while the property was broken.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const WORKFLOW = join(here, '..', '.github', 'workflows', 'release-pilot.yml');
const raw = readFileSync(WORKFLOW, 'utf8');

/** Strip full-line YAML comments: a comment describing a command is not the command. */
function stripComments(text) {
  return text
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');
}

/**
 * Split a workflow into its top-level jobs.
 *
 * The lookahead requires the two-space key to be followed by a newline, which is what makes it a job
 * header rather than a nested `key: value`. An earlier version anchored with `$` and no `m` flag, so
 * it never split at all — every job collapsed into one chunk and inherited its neighbours' gates.
 * The job-name assertion below exists so that failure mode cannot return silently.
 */
export function jobsOf(text) {
  const start = text.indexOf('\njobs:');
  if (start < 0) return [];
  const body = text.slice(start + '\njobs:'.length);
  return body
    .split(/\n(?=  [A-Za-z_][\w-]*:[ \t]*(?:\r?\n))/)
    .map((chunk) => {
      const header = chunk.split('\n').find((l) => /^ {2}[A-Za-z_][\w-]*:[ \t]*$/.test(l));
      return header ? { name: header.trim().replace(/:$/, ''), text: chunk } : null;
    })
    .filter(Boolean);
}

/** Does this job body actually run something that deploys? */
function isDeploying(jobText) {
  const code = stripComments(jobText);
  return /\bcdk\s+deploy\b/.test(code) || /\bopennextjs-cloudflare\s+deploy\b/.test(code) || /\bwrangler\s+deploy\b/.test(code);
}

/**
 * Every structural rule, evaluated on SUPPLIED text.
 * @returns {string[]} one message per violation; empty means the workflow holds.
 */
export function releaseLaneErrors(text) {
  const errors = [];
  const code = stripComments(text);
  const jobs = jobsOf(text);
  if (jobs.length === 0) return ['no jobs could be parsed from the workflow'];
  const header = code.slice(0, code.indexOf('\njobs:'));

  // ---- release identity -------------------------------------------------------------------
  if (!/^\s{6}release_sha:/m.test(header)) errors.push('there is no release_sha input');
  if (!/^\s{6}mode:/m.test(header)) errors.push('there is no mode input');
  for (const [pattern, message] of [
    [/^\s{6}environment:/m, 'environment must not be an operator-facing input — mode selects the path'],
    [/^\s{6}\w*(callback|logout|url|urls)\w*:/im, 'deploy targets must not be caller inputs; they resolve from Environment configuration'],
    [/^\s{6}expected_user_pool_id:/m, 'the expected user pool id must not be caller-supplied'],
  ]) {
    if (pattern.test(header)) errors.push(message);
  }
  if (!/options:\n\s+- dev_only\n\s+- dev_then_pilot/.test(header)) errors.push('mode must offer exactly dev_only and dev_then_pilot');

  // ---- trigger ----------------------------------------------------------------------------
  if (!/^on:\n\s+workflow_dispatch:/m.test(header)) errors.push('the lane must be triggered by workflow_dispatch');
  for (const forbidden of ['push', 'schedule', 'pull_request', 'pull_request_target']) {
    if (new RegExp(`^\\s{2}${forbidden}:`, 'm').test(header)) errors.push(`the lane must not be triggered by ${forbidden}`);
  }

  // ---- every checkout is pinned to the release --------------------------------------------
  // An unpinned checkout uses the triggering ref, and a manual run can select any branch — the
  // reviewed release and the deployed tree would differ with nothing to show for it.
  const checkouts = code.split(/\n(?=      - uses: actions\/checkout)/).filter((c) => /uses: actions\/checkout/.test(c));
  for (const chunk of checkouts) {
    const block = chunk.slice(0, chunk.indexOf('\n      - ', 10) + 1 || undefined);
    if (!/ref: \$\{\{ (inputs\.release_sha|needs\.global-preflight\.outputs\.release_sha) \}\}/.test(block)) {
      errors.push('a checkout is not pinned to the release SHA');
    }
    if (!/persist-credentials: false/.test(block)) errors.push('a checkout persists credentials');
  }

  // ---- the release identity job -----------------------------------------------------------
  const identity = jobs.find((j) => j.name === 'global-preflight');
  if (!identity) errors.push('there is no global-preflight job');
  else {
    if (!/merge-base --is-ancestor/.test(identity.text)) errors.push('global-preflight does not verify ancestry from main');
    if (!/-ne 40/.test(identity.text)) errors.push('global-preflight does not require a full 40-character SHA');
    // It must not be able to read environment configuration at all.
    if (/\n\s{4}environment:/.test(identity.text)) errors.push('global-preflight must not bind an Environment');
  }

  // ---- per-job gating ---------------------------------------------------------------------
  for (const job of jobs) {
    if (job.name === 'global-preflight') continue;
    const needs = /\n\s{4}needs:\s*(.+)/.exec(job.text);
    if (!needs) {
      errors.push(`job "${job.name}" declares no needs:`);
      continue;
    }
    // A dependency alone is not a gate: by default a job runs when its dependencies did not FAIL,
    // and any `if:` at all replaces that default. `always()` is the obvious hole; `!cancelled()` is
    // the quiet one, because it reads like caution while letting a failed dependency through.
    const ifExpr = /\n\s{4}if:\s*(.+)/.exec(job.text);
    if (!ifExpr) errors.push(`job "${job.name}" has no explicit success condition`);
    else {
      if (!/result == 'success'/.test(ifExpr[1])) {
        errors.push(`job "${job.name}" does not require a dependency result of 'success'`);
      }
      for (const hole of ['always()', '!cancelled()', 'cancelled()']) {
        if (ifExpr[1].includes(hole)) errors.push(`job "${job.name}" uses ${hole}, which ignores a failed dependency`);
      }
    }
    if (/continue-on-error:\s*true/.test(job.text)) errors.push(`job "${job.name}" is continue-on-error`);
  }

  // ---- no direct-to-pilot path ------------------------------------------------------------
  for (const name of ['pilot-preflight', 'pilot-stage']) {
    const job = jobs.find((j) => j.name === name);
    if (!job) {
      errors.push(`there is no ${name} job`);
      continue;
    }
    if (!/\n\s{4}needs:[^\n]*dev-stage/.test(job.text)) errors.push(`${name} does not depend on the dev stage`);
    if (!/\n\s{4}environment: pilot/.test(job.text)) errors.push(`${name} is not bound to the pilot Environment`);
  }
  const pilotPreflight = jobs.find((j) => j.name === 'pilot-preflight');
  if (pilotPreflight && !/inputs\.mode == 'dev_then_pilot'/.test(pilotPreflight.text)) {
    errors.push('pilot-preflight is reachable without the operator asking for promotion');
  }

  // ---- deploying jobs are bound to a validated manifest ------------------------------------
  for (const job of jobs) {
    if (!isDeploying(job.text)) continue;
    if (!/\n\s{4}environment:/.test(job.text)) errors.push(`job "${job.name}" can deploy but binds no Environment`);
    if (!/context_digest/.test(job.text)) {
      errors.push(`job "${job.name}" can deploy but is not bound to the preflight's validated context digest`);
    }
    if (!/\n\s{4}needs:[^\n]*preflight/.test(job.text)) errors.push(`job "${job.name}" can deploy without a preflight dependency`);
  }

  // ---- secrets and identifiers -------------------------------------------------------------
  if (!/role-to-assume: \$\{\{ secrets\./.test(code)) errors.push('the deploy role ARN must come from a secret, not a variable');
  if (!/mask-aws-account-id: true/.test(code)) errors.push('account-id masking must be enabled');
  if (/\b\d{12}\b/.test(code)) errors.push('the workflow contains a literal 12-digit account id');
  if (/arn:aws:iam::\d/.test(code)) errors.push('the workflow contains a literal IAM ARN');

  return errors;
}

test('the release lane satisfies every structural invariant', () => {
  assert.deepEqual(releaseLaneErrors(raw), []);
});

test('the job parser actually partitions the file — the rules are per-job, not per-file', () => {
  const jobs = jobsOf(raw);
  assert.deepEqual(jobs.map((j) => j.name), ['global-preflight', 'dev-preflight', 'dev-stage', 'pilot-preflight', 'pilot-stage']);
  assert.equal(/\n\s{4}needs:/.test(jobs[0].text), false, 'global-preflight must not carry a neighbour’s needs:');
  assert.equal(/\n\s{4}environment:/.test(jobs[0].text), false, 'global-preflight must not carry a neighbour’s environment:');
});

test('POSITIVE CONTROL: release identity cannot be weakened', () => {
  const rejects = (m, why) => assert.notDeepEqual(releaseLaneErrors(m), [], `must be rejected: ${why}`);

  rejects(raw.replaceAll('release_sha', 'release_ref'), 'no release_sha input');
  rejects(raw.replace('          if ! git merge-base --is-ancestor "$RELEASE_SHA" origin/main; then', '          if false; then'), 'ancestry no longer verified');
  rejects(raw.replace('if [ "${#RELEASE_SHA}" -ne 40 ]; then', 'if false; then'), 'abbreviated SHAs accepted');
  rejects(raw.replaceAll('          ref: ${{ inputs.release_sha }}\n', '').replaceAll('          ref: ${{ needs.global-preflight.outputs.release_sha }}\n', ''), 'checkout unpinned');
  rejects(raw.replaceAll('persist-credentials: false\n', ''), 'checkout persists credentials');
  rejects(raw.replace('  global-preflight:\n    name: Release identity (shape and ancestry)\n    runs-on: ubuntu-latest\n', '  global-preflight:\n    name: Release identity (shape and ancestry)\n    runs-on: ubuntu-latest\n    environment: dev\n'), 'the identity job can read environment config');
});

test('POSITIVE CONTROL: no operator input may reintroduce a deploy target or a direct pilot path', () => {
  const rejects = (m, why) => assert.notDeepEqual(releaseLaneErrors(m), [], `must be rejected: ${why}`);

  rejects(raw.replace('      mode:', '      environment:\n        description: x\n        required: true\n        type: string\n      mode:'), 'an environment input');
  rejects(raw.replace('      mode:', '      auth_callback_urls:\n        description: x\n        required: true\n        type: string\n      mode:'), 'a caller-supplied URL input');
  rejects(raw.replace('      mode:', '      expected_user_pool_id:\n        description: x\n        required: false\n        type: string\n      mode:'), 'a caller-supplied pool id');
  rejects(raw.replace("if: needs.dev-stage.result == 'success' && inputs.mode == 'dev_then_pilot'", "if: needs.global-preflight.result == 'success'"), 'pilot reachable without a green dev stage');
  rejects(raw.replace(/\n    needs: \[global-preflight, dev-preflight, dev-stage\]/, '\n    needs: [global-preflight]'), 'pilot-preflight detached from the dev stage');
  rejects(raw.replace('on:\n  workflow_dispatch:', 'on:\n  push:\n    branches: [main]\n  workflow_dispatch:'), 'an automatic trigger');
});

test('POSITIVE CONTROL: a dependency that is not required to SUCCEED is rejected', () => {
  const rejects = (m, why) => assert.notDeepEqual(releaseLaneErrors(m), [], `must be rejected: ${why}`);

  // `!cancelled()` is the finding that mattered: it reads like caution and lets a FAILED preflight
  // through, because any `if:` replaces the default "skip when a dependency failed".
  rejects(raw.replace("if: needs.dev-preflight.result == 'success'", 'if: !cancelled()'), '!cancelled() on the dev stage');
  rejects(raw.replace("if: needs.dev-preflight.result == 'success'", 'if: always()'), 'always() on the dev stage');
  rejects(raw.replace("    if: needs.dev-preflight.result == 'success'\n", ''), 'no explicit success condition');
  rejects(raw.replace('  dev-stage:\n    name: Dev stage (not implemented in Slice A)\n', '  dev-stage:\n    name: Dev stage\n    continue-on-error: true\n'), 'continue-on-error on a stage');
});

test('POSITIVE CONTROL: a deploy that is not bound to the validated context is rejected', () => {
  const rejects = (m, why) => assert.notDeepEqual(releaseLaneErrors(m), [], `must be rejected: ${why}`);

  // The exact bypass from the Slice A review: a later slice writes `cdk deploy --all` without the
  // validated `-c` values, so the preflight approved a configuration the deploy never uses.
  const unbound = raw.replace(
    /      - name: Slice A stops here\n        env:\n          CONTEXT_DIGEST: \$\{\{ needs\.dev-preflight\.outputs\.context_digest \}\}\n        run: \|[\s\S]*?(?=\n  pilot-preflight:)/,
    '      - name: Deploy\n        run: |\n          cdk deploy --all\n',
  );
  rejects(unbound, 'a deploy that never reads the context digest');

  const noEnv = unbound.replace(/\n    environment: dev\n    permissions:\n      contents: read\n      id-token: write\n    steps:\n      - name: Deploy/, '\n    permissions:\n      contents: read\n      id-token: write\n    steps:\n      - name: Deploy');
  rejects(noEnv, 'a deploying job with no Environment');
});

test('POSITIVE CONTROL: credentials and identifiers cannot be loosened', () => {
  const rejects = (m, why) => assert.notDeepEqual(releaseLaneErrors(m), [], `must be rejected: ${why}`);

  rejects(raw.replaceAll('secrets.AWS_DEPLOY_PREFLIGHT_ROLE_ARN', 'vars.AWS_DEPLOY_PREFLIGHT_ROLE_ARN'), 'the role ARN moved to a variable');
  rejects(raw.replaceAll('          mask-aws-account-id: true\n', ''), 'account-id masking removed');
  // Assembled, never written out: a literal here would be the very thing the rule forbids.
  rejects(raw.replace('${{ secrets.AWS_DEPLOY_PREFLIGHT_ROLE_ARN }}', `arn:aws:iam::${'9'.repeat(12)}:role/x`), 'a literal IAM ARN');
});

test('Slice A deploys nothing: no deploy command exists in the lane yet', () => {
  const code = stripComments(raw);
  assert.equal(/\bcdk\s+deploy\b/.test(code), false);
  assert.equal(/\bopennextjs-cloudflare\s+deploy\b/.test(code), false);
  assert.equal(/\bwrangler\s+deploy\b/.test(code), false);
});

test('the human gate is DECLARED but not yet real, and the file says so', () => {
  // As of 2026-07-31 the repository has zero configured Environments, so naming one here creates no
  // protection rule. Asserting the disclosure keeps a future reader from mistaking the binding for
  // the control — and the day the Environments exist, this comment is what gets updated with the
  // evidence rather than quietly forgotten.
  assert.match(raw, /THE HUMAN GATE IS NOT YET REAL/);
  assert.match(raw, /ZERO configured GitHub/);
  assert.match(raw, /treated as ungated, and no deploy slice may be approved/);
});
