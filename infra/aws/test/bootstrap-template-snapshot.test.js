// The lockfile-CDK ↔ committed-snapshot agreement (#111 r3-F1), proven CREDENTIAL-FREE in CI.
//
// The operator script (scripts/provision-release-bootstrap.sh) deploys the COMMITTED snapshot
// directly through CloudFormation and never executes cdk/npx under privileged credentials — so
// the proof that the pinned toolchain still agrees with the reviewed snapshot lives HERE, where
// the lockfile's own CDK is installed and no credential exists. If a lockfile bump changes the
// bootstrap template, this test goes red and the snapshot must be regenerated THROUGH REVIEW
// (its digest is pinned in test/provision-release-bootstrap.test.js).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const INFRA = path.resolve(__dirname, '..');
const SNAPSHOT = path.join(INFRA, 'bootstrap', 'cdk-bootstrap-template.yaml');

test('the pinned CDK still generates EXACTLY the committed bootstrap snapshot', () => {
  const lockVersion = JSON.parse(fs.readFileSync(path.join(INFRA, 'package-lock.json'), 'utf8'))
    .packages['node_modules/aws-cdk'].version;
  const got = execFileSync('npx', ['--no-install', 'cdk', '--version'], { cwd: INFRA, encoding: 'utf8' });
  assert.ok(got.startsWith(lockVersion), `local CDK ${got.trim()} must be the lockfile's ${lockVersion}`);

  const generated = execFileSync('npx', ['--no-install', 'cdk', 'bootstrap', '--show-template'], {
    cwd: INFRA, encoding: 'utf8', timeout: 120_000,
  });
  const snapshot = fs.readFileSync(SNAPSHOT, 'utf8');
  // The snapshot is stored with a single trailing newline (git's whitespace hygiene); the CDK
  // emits a trailing blank line — trailing-newline normalization only, every other byte exact.
  assert.equal(generated.replace(/\n+$/, '\n'), snapshot.replace(/\n+$/, '\n'),
    'the generated template diverged from the reviewed snapshot — regenerate it THROUGH REVIEW');
});
