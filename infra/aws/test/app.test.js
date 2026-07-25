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
