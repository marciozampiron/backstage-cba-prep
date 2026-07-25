// Static invariants for .github/workflows/blueprint-refresh.yml (#73).
// The workflow's safety properties (spend gate, plumbing-test isolation, no-diff success,
// credential handling) are asserted here so a regression fails root CI on both Node majors.
// Dependency-free on purpose: the checks parse the raw YAML text, not a YAML object model.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const raw = readFileSync(
  join(here, '..', '.github', 'workflows', 'blueprint-refresh.yml'),
  'utf8',
);

// Split the job's steps: each starts with 6 spaces, "- ", at the top of a step mapping.
const stepChunks = raw.split(/\n(?= {6}- )/);
const step = (nameFragment) => {
  const found = stepChunks.filter((c) => c.includes(nameFragment));
  assert.equal(found.length, 1, `exactly one step matching "${nameFragment}"`);
  return found[0];
};

test('checkout does not persist credentials (Authorization-collision guard)', () => {
  const checkout = step('actions/checkout@');
  assert.match(checkout, /persist-credentials:\s*false/);
});

test('pr_plumbing_test sets skip=true so every AWS/Bedrock step is skipped', () => {
  const gate = step('Check Bedrock refresh gate');
  const plumbingBranch = gate.slice(
    gate.indexOf('"$PR_PLUMBING_TEST" = "true"'),
    gate.indexOf('exit 0'),
  );
  assert.match(plumbingBranch, /skip=true/, 'plumbing mode must set skip=true');
  assert.match(plumbingBranch, /plumbing=true/, 'plumbing mode must set plumbing=true');
});

test('AWS credentials, install, generation, and bank check all depend on skip != true', () => {
  for (const name of [
    'Configure AWS credentials for Bedrock',
    'Install dependencies',
    'Regenerate the domain from the source page',
    'Check the bank against the (possibly) new domain',
  ]) {
    const s = step(name);
    assert.match(
      s,
      /if:\s*steps\.gate\.outputs\.skip != 'true'/,
      `${name} must be gated on skip != 'true'`,
    );
    assert.ok(
      !s.includes("plumbing == 'true'"),
      `${name} must NOT have a plumbing escape hatch`,
    );
  }
});

test('the PR step requires a detected diff (changed == true)', () => {
  const pr = step('Open a PR if the domain changed');
  assert.match(pr, /steps\.diff\.outputs\.changed == 'true'/);
});

test('no-diff is an explicit successful outcome in the detect step', () => {
  const diff = step('Detect a tracked change');
  assert.match(diff, /changed=false/);
  assert.match(diff, /completed successfully/);
});

test('the plumbing test writes only the synthetic self-test file', () => {
  const synthetic = step('Write a synthetic change');
  assert.match(synthetic, /if:\s*steps\.gate\.outputs\.plumbing == 'true'/);
  const writes = synthetic.match(/(?:>|>>)\s*\S+/g) ?? [];
  assert.deepEqual(
    writes,
    ['> .github/blueprint-refresh-selftest.txt'],
    'the only redirect target must be the synthetic self-test file',
  );
});

test('the PR finalizer uses the supported create-pull-request major (v8)', () => {
  const pr = step('Open a PR if the domain changed');
  assert.match(pr, /peter-evans\/create-pull-request@v8\b/);
  assert.ok(!raw.includes('create-pull-request@v6'), 'the old v6 pin must be gone');
});
