// Static invariants for .github/workflows/deploy-pilot.yml (#70 Slice A).
//
// The property that matters is an ORDERING: nothing that can deploy may start before the preflight
// has passed and a human has approved. A workflow file cannot be unit-tested by running it, so the
// invariants are asserted on the text — dependency-free, like the #73 workflow tests.
//
// The checks are a PURE function over supplied text. That is the point: the real file can be proven
// to satisfy them AND mutations can be proven to break them, in the same run. Asserting only against
// the file on disk is how a guard ends up measuring whatever happens to be there — the #70 preflight
// contract already had to be rewritten once for exactly that reason.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const WORKFLOW = join(here, '..', '.github', 'workflows', 'deploy-pilot.yml');
const raw = readFileSync(WORKFLOW, 'utf8');

/**
 * Split a workflow into its top-level jobs.
 *
 * Jobs are the two-space keys under `jobs:`. Parsing by indentation rather than with a YAML library
 * keeps this dependency-free and, more usefully, keeps it honest: it sees the file the way a
 * reviewer reading the diff does.
 */
function jobsOf(text) {
  const start = text.indexOf('\njobs:');
  if (start < 0) return [];
  const body = text.slice(start + '\njobs:'.length);

  // Split before every two-space job key. The lookahead requires the key to be followed by a
  // newline, which is what makes it a job header rather than a nested `key: value`. An earlier
  // version anchored with `$` and no `m` flag, so it never split at all: every job collapsed into
  // one chunk, and a deploying job inherited the preflight's `environment:` — the invariants read
  // as satisfied while the property was broken. Any check that partitions text has to be shown
  // partitioning it, which is what the job-count assertion below is for.
  const chunks = body.split(/\n(?=  [A-Za-z_][\w-]*:[ \t]*(?:\r?\n))/);
  return chunks
    .map((chunk) => {
      const header = chunk.split('\n').find((l) => /^ {2}[A-Za-z_][\w-]*:[ \t]*$/.test(l));
      if (!header) return null;
      return { name: header.trim().replace(/:$/, ''), text: chunk };
    })
    .filter(Boolean);
}

/**
 * Strip full-line YAML comments.
 *
 * Without this the checks read their own documentation: this file explains that Slice A runs no
 * `cdk deploy`, and a naive scan sees that sentence as a deploy. A comment describing a command is
 * not the command — and the inverse mistake is worse, because a job whose only mention of deploying
 * is a comment would be treated as a deploying job and demand gates it does not need.
 */
function stripComments(text) {
  return text
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');
}

/** Does this job body actually run something that deploys? */
function isDeploying(jobText) {
  const code = stripComments(jobText);
  return /\bcdk\s+deploy\b/.test(code) || /\bopennextjs-cloudflare\s+deploy\b/.test(code) || /\bwrangler\s+deploy\b/.test(code);
}

/**
 * Every ordering and gating rule, evaluated on SUPPLIED text.
 * @returns {string[]} one message per violation; empty means the workflow holds.
 */
export function workflowOrderingErrors(text) {
  const errors = [];
  const jobs = jobsOf(text);
  if (jobs.length === 0) return ['no jobs could be parsed from the workflow'];

  const preflight = jobs.find((j) => j.name === 'preflight');
  if (!preflight) errors.push('there is no `preflight` job');

  // The trigger. A push/schedule trigger would let a merge spend money unattended.
  const header = text.slice(0, text.indexOf('\njobs:'));
  if (!/^on:\n\s+workflow_dispatch:/m.test(header)) errors.push('the lane must be triggered by workflow_dispatch');
  for (const forbidden of ['push:', 'schedule:', 'pull_request:', 'pull_request_target:']) {
    if (new RegExp(`^\\s{2}${forbidden.replace(':', ':')}`, 'm').test(header)) {
      errors.push(`the lane must not be triggered by ${forbidden.replace(':', '')}`);
    }
  }

  for (const job of jobs) {
    if (!isDeploying(job.text)) continue;
    // A deploying job must wait for the preflight...
    const needs = /\n\s{4}needs:\s*(.+)/.exec(job.text);
    if (!needs || !/\bpreflight\b/.test(needs[1])) {
      errors.push(`job "${job.name}" can deploy but does not list preflight in needs:`);
    }
    // ...and must sit behind an Environment, which is where the human approval lives.
    if (!/\n\s{4}environment:/.test(job.text)) {
      errors.push(`job "${job.name}" can deploy but is not bound to a GitHub Environment`);
    }
    // A failed preflight must stop it. `continue-on-error` on the preflight job, or an `if:` that
    // ignores the dependency result, would make `needs:` decorative.
    if (/\n\s{4}if:\s*.*always\(\)/.test(job.text)) {
      errors.push(`job "${job.name}" runs with always(), which ignores a failed preflight`);
    }
  }

  if (preflight) {
    if (/continue-on-error:\s*true/.test(preflight.text)) errors.push('the preflight job must not continue-on-error');
    if (!/deploy-preflight\.js/.test(preflight.text)) errors.push('the preflight job must run the preflight evaluator');
    if (!/\n\s{4}environment:/.test(preflight.text)) errors.push('the preflight job must be bound to a GitHub Environment');
  }

  // No account id, and no literal role ARN, in a tracked file.
  if (/\b\d{12}\b/.test(text)) errors.push('the workflow contains a literal 12-digit account id');
  if (/arn:aws:iam::\d/.test(text)) errors.push('the workflow contains a literal IAM ARN');

  return errors;
}

test('the deploy lane satisfies every ordering and gating invariant', () => {
  assert.deepEqual(workflowOrderingErrors(raw), []);
});

test('the job parser actually partitions the file — the invariants are per-job, not per-file', () => {
  // Without this, a parser that returns one chunk containing everything makes every per-job rule
  // vacuously true: the deploying job "has" the preflight's environment and needs. That is exactly
  // how the first version of this file passed while the property it claims to guard was broken.
  const jobs = jobsOf(raw);
  assert.deepEqual(jobs.map((j) => j.name), ['preflight', 'deploy']);
  assert.equal(/\n\s{4}needs:/.test(jobs[0].text), false, 'the preflight job must not carry the deploy job’s needs:');
});

test('POSITIVE CONTROL: the invariants reject each way the ordering can be broken', () => {
  const rejects = (mutated, why) => assert.notDeepEqual(workflowOrderingErrors(mutated), [], `must be rejected: ${why}`);

  // A deploying job that never waits for the preflight. This is the mutation that matters: Slice A
  // ships no `cdk deploy`, so without exercising it the rule would be asserted over zero jobs and
  // would pass no matter what a later slice writes.
  const detached = raw.replace(
    /      - name: Slice A stops here\n        run: \|/,
    '      - name: Deploy\n        run: |\n          cdk deploy --all',
  ).replace(/\n    needs: preflight/, '');
  rejects(detached, 'a deploying job with no needs: preflight');

  // Present but behind no human gate. Only the DEPLOY job's environment line is removed — the
  // preflight keeps its own, so this mutation isolates the missing gate on the deploying job.
  const withDeploy = raw.replace(
    /      - name: Slice A stops here\n        run: \|/,
    '      - name: Deploy\n        run: |\n          cdk deploy --all',
  );
  const deployAt = withDeploy.indexOf('\n  deploy:');
  const noEnvironment =
    withDeploy.slice(0, deployAt) +
    withDeploy.slice(deployAt).replace(/\n    environment: \$\{\{ inputs\.environment \}\}/, '');
  rejects(noEnvironment, 'a deploying job with no Environment');

  // A dependency that is ignored at runtime.
  const alwaysRuns = raw
    .replace(/      - name: Slice A stops here\n        run: \|/, '      - name: Deploy\n        run: |\n          cdk deploy --all')
    .replace(/\n    needs: preflight/, '\n    needs: preflight\n    if: always()');
  rejects(alwaysRuns, 'a deploying job guarded by always()');

  // The other two deploy surfaces this lane will grow.
  for (const cmd of ['opennextjs-cloudflare deploy', 'wrangler deploy']) {
    const other = raw
      .replace(/      - name: Slice A stops here\n        run: \|/, `      - name: Deploy\n        run: |\n          ${cmd}`)
      .replace(/\n    needs: preflight/, '');
    rejects(other, `${cmd} without needs: preflight`);
  }

  // The preflight itself, weakened.
  // `replaceAll`, not `replace`: the first mention of the evaluator is in a comment, so a
  // single-shot replacement would mutate the documentation and leave the real invocation in place —
  // a mutation that changes nothing proves nothing.
  rejects(raw.replaceAll('deploy-preflight.js', 'echo-skipped'), 'the preflight no longer runs the evaluator');
  rejects(raw.replace(/    steps:\n      - uses: actions\/checkout@v7/, '    continue-on-error: true\n    steps:\n      - uses: actions/checkout@v7'), 'preflight set to continue-on-error');

  // The trigger.
  rejects(raw.replace('on:\n  workflow_dispatch:', 'on:\n  push:\n    branches: [main]\n  workflow_dispatch:'), 'an automatic push trigger');

  // Committed identifiers.
  // The fake ARN is ASSEMBLED rather than written out: the repository rule is that no account id or
  // IAM ARN appears in a tracked file, and a negative control is still a tracked file. A literal
  // here would be the very thing this assertion exists to forbid.
  const fakeArn = `arn:aws:iam::${'9'.repeat(12)}:role/x`;
  rejects(raw.replace('${{ vars.AWS_DEPLOY_PREFLIGHT_ROLE_ARN }}', fakeArn), 'a literal IAM ARN');
});

test('Slice A deploys nothing: no deploy command exists in the lane yet', () => {
  // Stated as an assertion so that a slice which adds one has to update this line deliberately,
  // rather than discovering later that "Slice A" quietly grew a deploy. Comments are stripped: the
  // file documents what it does NOT do, and that prose must not read as the thing itself.
  const code = stripComments(raw);
  assert.equal(/\bcdk\s+deploy\b/.test(code), false);
  assert.equal(/\bopennextjs-cloudflare\s+deploy\b/.test(code), false);
  assert.equal(/\bwrangler\s+deploy\b/.test(code), false);
});

test('the lane separates environments and never hardcodes one', () => {
  assert.match(raw, /options:\n\s+- dev\n\s+- pilot/, 'both tiers are selectable');
  assert.match(raw, /environment: \$\{\{ inputs\.environment \}\}/, 'the Environment follows the chosen tier');
  assert.match(raw, /concurrency:\n\s+group: deploy-pilot-\$\{\{ inputs\.environment \}\}/, 'concurrency is per environment');
  assert.equal(/environment: pilot\s*$/m.test(raw), false, 'no job may pin an environment literally');
});

test('checkout does not persist credentials, and permissions stay least-privilege', () => {
  assert.match(raw, /persist-credentials: false/);
  assert.match(raw, /^permissions:\n  contents: read$/m, 'the workflow default is read-only');
  assert.equal(/permissions:\s*write-all/.test(raw), false);
  assert.equal(/contents: write/.test(raw), false);
});
