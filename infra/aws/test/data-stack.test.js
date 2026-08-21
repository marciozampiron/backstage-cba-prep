// DataStack synth guarantees (#77 Stage C): on-demand + encrypted always; pilot durable
// (PITR + deletion protection + RETAIN) vs dev disposable (explicitly encoded); GSI for
// learner-scoped listing; naming/tags; ZERO IAM resources (grants belong to #78); no literal
// account id. Credential-free — pure synth assertions.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { App } = require('aws-cdk-lib');
const { Template } = require('aws-cdk-lib/assertions');
const { DataStack } = require('../lib/data-stack');

function synth(environment) {
  const app = new App({ context: { environment } });
  const stack = new DataStack(app, 'DataStack', {
    stackName: `cba-study-coach-${environment}-data`,
  });
  return Template.fromStack(stack);
}

function tableOf(template) {
  const tables = template.findResources('AWS::DynamoDB::Table');
  const entries = Object.entries(tables);
  assert.equal(entries.length, 1, 'exactly one table');
  return entries[0][1];
}

test('table is on-demand and encrypted in every environment', () => {
  for (const env of ['dev', 'pilot']) {
    const t = tableOf(synth(env));
    assert.equal(t.Properties.BillingMode, 'PAY_PER_REQUEST');
    assert.equal(t.Properties.SSESpecification.SSEEnabled, true);
    assert.equal(t.Properties.TableName, `cba-study-coach-${env}-simulation`);
  }
});

test('key schema and the learner GSI match the adapter access patterns', () => {
  const t = tableOf(synth('pilot'));
  assert.deepEqual(t.Properties.KeySchema, [
    { AttributeName: 'pk', KeyType: 'HASH' },
    { AttributeName: 'sk', KeyType: 'RANGE' },
  ]);
  const gsi = t.Properties.GlobalSecondaryIndexes;
  assert.equal(gsi.length, 1);
  assert.equal(gsi[0].IndexName, 'gsi1');
  assert.deepEqual(gsi[0].KeySchema, [
    { AttributeName: 'gsi1pk', KeyType: 'HASH' },
    { AttributeName: 'gsi1sk', KeyType: 'RANGE' },
  ]);
  assert.equal(gsi[0].Projection.ProjectionType, 'ALL');
});

test('pilot is durable: PITR + deletion protection + RETAIN', () => {
  const t = tableOf(synth('pilot'));
  assert.equal(t.Properties.PointInTimeRecoverySpecification.PointInTimeRecoveryEnabled, true);
  assert.equal(t.Properties.DeletionProtectionEnabled, true);
  assert.equal(t.DeletionPolicy, 'Retain');
  assert.equal(t.UpdateReplacePolicy, 'Retain');
});

test('dev is explicitly disposable: no PITR, no deletion protection, DESTROY', () => {
  const t = tableOf(synth('dev'));
  assert.equal(t.Properties.PointInTimeRecoverySpecification.PointInTimeRecoveryEnabled, false);
  assert.equal(t.Properties.DeletionProtectionEnabled, false);
  assert.equal(t.DeletionPolicy, 'Delete');
});

test('foundation tags are applied with the environment', () => {
  const t = tableOf(synth('dev'));
  const tags = Object.fromEntries(t.Properties.Tags.map((x) => [x.Key, x.Value]));
  assert.equal(tags.Project, 'CBAStudyCoach');
  assert.equal(tags.Environment, 'dev');
  assert.equal(tags.ManagedBy, 'CDK');
});

test('the stack creates ZERO IAM resources and no wildcard anywhere (grants are #78)', () => {
  for (const env of ['dev', 'pilot']) {
    const template = synth(env);
    template.resourceCountIs('AWS::IAM::Role', 0);
    template.resourceCountIs('AWS::IAM::Policy', 0);
    template.resourceCountIs('AWS::IAM::ManagedPolicy', 0);
    const flat = JSON.stringify(template.toJSON());
    assert.ok(!flat.includes('"Action":"*"') && !flat.includes('"Resource":"*"'), 'no wildcards');
  }
});

test('no literal 12-digit account id in the synthesized template', () => {
  const flat = JSON.stringify(synth('pilot').toJSON());
  assert.ok(!/\b\d{12}\b/.test(flat), 'pseudo parameters only');
});

test('the table has TTL for the #75 run tombstones', () => {
  for (const env of ['dev', 'pilot']) {
    const table = tableOf(synth(env));
    // Completed run tombstones keep ownership alive so a cleanup replay stays deterministic, and
    // ownership is learner data — bounded retention is required (SEC-DATA-01).
    assert.deepEqual(table.Properties.TimeToLiveSpecification, { AttributeName: 'ttl', Enabled: true }, env);
  }
});

test('#90: the rate-window rows expire on the SAME attribute the table\'s TTL reads', async () => {
  // The review reproduction: the adapter stamped `expiresAt` while the table's TTL reads `ttl`,
  // so every (learner, operation, minute) left a permanent row — retention and cost growth with
  // no bound (SEC-DATA-01/SYS-T05). This confronts the two PHYSICAL names directly: the ESM
  // adapter's exported attribute against the synthesized TimeToLiveSpecification, per
  // environment. Renaming either side alone goes red here.
  const { RATE_TTL_ATTRIBUTE } = await import('../../../services/bff/src/dynamodb-repository.js');
  for (const env of ['dev', 'pilot']) {
    const table = Object.values(synth(env).findResources('AWS::DynamoDB::Table'))[0];
    assert.deepEqual(
      table.Properties.TimeToLiveSpecification,
      { AttributeName: RATE_TTL_ATTRIBUTE, Enabled: true },
      `${env}: the adapter writes what TTL deletes`,
    );
  }
});
