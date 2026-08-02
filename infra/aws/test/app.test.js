// Real-app wiring test (#77 review fix): stack names must derive from the `environment` context,
// keeping dev and pilot stacks physically separate — `-c environment=dev` can never address a
// pilot stack.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { App } = require('aws-cdk-lib');
const { buildStacks } = require('../lib/app');

test('default environment is pilot and every stack carries the pilot base name', () => {
  const stacks = buildStacks(new App());
  assert.equal(stacks.environment, 'pilot');
  assert.equal(stacks.security.stackName, 'cba-study-coach-pilot-security');
  assert.equal(stacks.data.stackName, 'cba-study-coach-pilot-data');
  assert.equal(stacks.observability.stackName, 'cba-study-coach-pilot-observability');
});

test('environment=dev renames EVERY stack to the dev base — no pilot name leaks', () => {
  const stacks = buildStacks(new App({ context: { environment: 'dev' } }));
  assert.equal(stacks.environment, 'dev');
  for (const key of ['security', 'identity', 'data', 'api', 'aiOrchestration', 'observability']) {
    assert.match(stacks[key].stackName, /^cba-study-coach-dev-/, `${key} must use the dev base`);
    assert.ok(!stacks[key].stackName.includes('pilot'), `${key} must not reference pilot`);
  }
  assert.equal(stacks.data.stackName, 'cba-study-coach-dev-data');
});

test('the dev data table itself is dev-named and disposable through the real app', () => {
  const { Template } = require('aws-cdk-lib/assertions');
  const stacks = buildStacks(new App({ context: { environment: 'dev' } }));
  const t = Template.fromStack(stacks.data);
  const table = Object.values(t.findResources('AWS::DynamoDB::Table'))[0];
  assert.equal(table.Properties.TableName, 'cba-study-coach-dev-simulation');
  assert.equal(table.DeletionPolicy, 'Delete');
});

test('every stack the app constructs is CLASSIFIED — deployable or excluded, never unclassified', () => {
  // Discovery, not enumeration (#70 Slice B1 review): `--all` was replaced by the closed
  // DEPLOYABLE set the manifest names, so a stack that joins the app WITHOUT joining the
  // classification would either silently ride into the deploy effect (under --all) or silently
  // never deploy (under the closed set). Both are review bypasses; this test refuses them.
  const { Stack } = require('aws-cdk-lib');
  const { DEPLOYABLE_STACK_IDS, EXCLUDED_STACK_IDS } = require('../lib/context');
  const app = new App({ context: { environment: 'dev' } });
  buildStacks(app);
  const constructed = app.node.children.filter((c) => c instanceof Stack).map((c) => c.node.id).sort();
  const classified = [...DEPLOYABLE_STACK_IDS, ...EXCLUDED_STACK_IDS].sort();
  assert.deepEqual(constructed, classified, 'the app and the classification must agree exactly — add new stacks to ONE list, through review');
  // The two lists are disjoint, and the exclusions are exactly the stated ones: the account-global
  // foundation and the deferred placeholder. A deployable SecurityStack would put the OIDC
  // provider and the GitHub roles inside every release's blast radius.
  assert.equal(DEPLOYABLE_STACK_IDS.filter((id) => EXCLUDED_STACK_IDS.includes(id)).length, 0);
  assert.deepEqual([...EXCLUDED_STACK_IDS], ['AiOrchestrationStack', 'SecurityStack']);
  assert.equal(DEPLOYABLE_STACK_IDS.includes('SecurityStack'), false);
  // The classification is FROZEN — a test-time mutation cannot widen the deploy effect.
  assert.throws(() => { DEPLOYABLE_STACK_IDS.push('SecurityStack'); }, TypeError);
});

test('invalid environments FAIL SYNTH: production, typo, empty — app path', () => {
  for (const bad of ['production', 'pilto', '']) {
    assert.throws(
      () => buildStacks(new App({ context: { environment: bad } })),
      /must be one of dev\|pilot/,
      `environment="${bad}" must be rejected`,
    );
  }
});

test('invalid environments FAIL SYNTH: direct DataStack construction too', () => {
  const { DataStack } = require('../lib/data-stack');
  for (const bad of ['production', 'stg', '']) {
    assert.throws(
      () => new DataStack(new App({ context: { environment: bad } }), 'DataStack', {}),
      /must be one of dev\|pilot/,
      `direct DataStack with environment="${bad}" must be rejected`,
    );
  }
});
