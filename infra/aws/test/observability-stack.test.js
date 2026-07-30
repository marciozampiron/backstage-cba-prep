// ObservabilityStack synth guarantees (#82 Slice B). Credential-free: pure synth assertions.
//
// The notification path is the reason this file is adversarial rather than descriptive. Two of its
// failure modes are SILENT — an alarm dropped from the composite pages nobody, and a second SNS
// publisher pages everybody twice until the pages get ignored — so every invariant here is written
// as a checker function that is run TWICE: once against the real template, where it must pass, and
// once against a deliberately mutated copy, where it must fail. A guard that has never been seen to
// fail is not evidence of anything.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { App } = require('aws-cdk-lib');
const { Template } = require('aws-cdk-lib/assertions');
const { DataStack } = require('../lib/data-stack');
const { IdentityStack } = require('../lib/identity-stack');
const { ApiStack } = require('../lib/api-stack');
const {
  ObservabilityStack,
  ALARM_KEYS,
  GATE_WILDCARD_ACTIONS,
  GATE_DASHBOARD_ACTIONS,
  GATE_TOPIC_ACTIONS,
  DYNAMO_ALARMED_OPERATIONS,
  DURATION_P95_THRESHOLD_MS,
} = require('../lib/observability-stack');

/** Build the real workload stacks and the observability stack over them. */
function build(environment = 'pilot', overrides = {}) {
  const app = new App({ context: { environment } });
  const base = `cba-study-coach-${environment}`;
  const identity = new IdentityStack(app, 'IdentityStack', { stackName: `${base}-identity` });
  const data = new DataStack(app, 'DataStack', { stackName: `${base}-data` });
  const api = new ApiStack(app, 'ApiStack', {
    stackName: `${base}-api`,
    table: data.table,
    userPool: identity.userPool,
    userPoolClient: identity.userPoolClient,
    userPoolDomain: identity.userPoolDomain,
  });
  const stack = new ObservabilityStack(app, 'ObservabilityStack', {
    stackName: `${base}-observability`,
    httpApi: api.httpApi,
    bffFunction: api.bffFunction,
    bffLogGroup: api.bffLogGroup,
    accessLogGroup: api.accessLogGroup,
    table: data.table,
    ...overrides,
  });
  return { app, stack, api, data };
}

function synth(environment = 'pilot') {
  return Template.fromStack(build(environment).stack).toJSON();
}

const resourcesOfType = (tpl, type) =>
  Object.entries(tpl.Resources).filter(([, r]) => r.Type === type);

/* ================= structure ================================================================== */

test('synthesises the baseline resource set in both environments', () => {
  for (const env of ['dev', 'pilot']) {
    const tpl = synth(env);
    assert.equal(resourcesOfType(tpl, 'AWS::CloudWatch::Alarm').length, 6, `${env}: exactly six alarms`);
    assert.equal(resourcesOfType(tpl, 'AWS::CloudWatch::CompositeAlarm').length, 1, `${env}: one composite`);
    assert.equal(resourcesOfType(tpl, 'AWS::CloudWatch::Dashboard').length, 1, `${env}: one dashboard`);
    assert.equal(resourcesOfType(tpl, 'AWS::Logs::QueryDefinition').length, 5, `${env}: five saved queries`);
    assert.equal(resourcesOfType(tpl, 'AWS::SNS::Topic').length, 1, `${env}: one topic`);
    assert.equal(resourcesOfType(tpl, 'AWS::KMS::Key').length, 1, `${env}: one customer-managed key`);
    // The budget is blocked on the `Project` cost-allocation tag being activated and proven to
    // isolate this project; an account-wide budget under the application name would be misleading.
    assert.equal(resourcesOfType(tpl, 'AWS::Budgets::Budget').length, 0, `${env}: no budget yet`);
    // No subscription: endpoints are operator configuration and must never be committed.
    assert.equal(resourcesOfType(tpl, 'AWS::SNS::Subscription').length, 0, `${env}: no subscription`);
  }
});

test('every alarm treats missing data as notBreaching and carries no action', () => {
  for (const env of ['dev', 'pilot']) {
    for (const [id, alarm] of resourcesOfType(synth(env), 'AWS::CloudWatch::Alarm')) {
      // Before traffic begins, "no data" is the expected state; breaching on it would page the
      // operator on day one for a system that is merely idle.
      assert.equal(alarm.Properties.TreatMissingData, 'notBreaching', `${env}/${id}`);
      assert.deepEqual(alarm.Properties.AlarmActions ?? [], [], `${env}/${id} must stay diagnostic`);
      assert.deepEqual(alarm.Properties.OKActions ?? [], [], `${env}/${id}`);
      assert.deepEqual(alarm.Properties.InsufficientDataActions ?? [], [], `${env}/${id}`);
    }
  }
});

test('alarm names, thresholds and metrics match the baseline', () => {
  const tpl = synth('pilot');
  const byName = Object.fromEntries(
    resourcesOfType(tpl, 'AWS::CloudWatch::Alarm').map(([, a]) => [a.Properties.AlarmName, a.Properties]),
  );
  const base = 'cba-study-coach-pilot';
  assert.deepEqual(Object.keys(byName).sort(), [
    `${base}-api-5xx`,
    `${base}-dynamodb-system-errors`,
    `${base}-dynamodb-throttling`,
    `${base}-lambda-errors`,
    `${base}-lambda-p95-duration`,
    `${base}-lambda-throttles`,
  ]);

  assert.equal(byName[`${base}-api-5xx`].MetricName, '5xx');
  assert.equal(byName[`${base}-api-5xx`].Namespace, 'AWS/ApiGateway');
  assert.equal(byName[`${base}-lambda-errors`].MetricName, 'Errors');
  assert.equal(byName[`${base}-lambda-throttles`].MetricName, 'Throttles');

  // The Lambda timeout is 15s, so p95 >= 12s warns BEFORE the hard timeout instead of reporting it.
  const duration = byName[`${base}-lambda-p95-duration`];
  assert.equal(duration.MetricName, 'Duration');
  assert.equal(duration.ExtendedStatistic, 'p95');
  assert.equal(duration.Threshold, DURATION_P95_THRESHOLD_MS);
  assert.ok(DURATION_P95_THRESHOLD_MS < 15_000, 'the duration alarm must fire before the hard timeout');

  for (const name of [`${base}-api-5xx`, `${base}-lambda-errors`, `${base}-lambda-throttles`]) {
    assert.equal(byName[name].Threshold, 1, `${name} fires on the first occurrence`);
    assert.equal(byName[name].Period, 300, `${name} uses the five-minute window`);
  }
});

/* ================= INVARIANT 1: the composite covers exactly the six ========================== */

/**
 * Every alarm in the template must appear in the composite rule, and the rule must reference nothing
 * else. Both directions matter: a missing alarm is a silent gap, and an extra reference means the
 * rule no longer describes the baseline.
 */
function assertCompositeCoversExactlyTheBaseline(tpl) {
  const alarms = resourcesOfType(tpl, 'AWS::CloudWatch::Alarm');
  const composites = resourcesOfType(tpl, 'AWS::CloudWatch::CompositeAlarm');
  if (composites.length !== 1) throw new Error(`expected exactly one composite alarm, found ${composites.length}`);
  if (alarms.length !== ALARM_KEYS.length) {
    throw new Error(`expected ${ALARM_KEYS.length} baseline alarms, found ${alarms.length}`);
  }

  const rule = JSON.stringify(composites[0][1].Properties.AlarmRule);
  const referenced = new Set((rule.match(/"([A-Za-z0-9]+)","Arn"/g) ?? []).map((m) => m.split('"')[1]));
  const declared = new Set(alarms.map(([id]) => id));

  const missing = [...declared].filter((id) => !referenced.has(id));
  if (missing.length) throw new Error(`composite does not reference: ${missing.join(', ')}`);
  const extra = [...referenced].filter((id) => !declared.has(id));
  if (extra.length) throw new Error(`composite references unknown alarms: ${extra.join(', ')}`);
}

test('the composite references exactly the six baseline alarms', () => {
  for (const env of ['dev', 'pilot']) {
    assert.doesNotThrow(() => assertCompositeCoversExactlyTheBaseline(synth(env)), env);
  }
});

test('NEGATIVE: dropping any one alarm from the composite fails the invariant', () => {
  // One at a time, so the assertion is proven for each alarm rather than for "some alarm".
  const tpl = synth('pilot');
  const ids = resourcesOfType(tpl, 'AWS::CloudWatch::Alarm').map(([id]) => id);
  assert.equal(ids.length, 6);

  for (const dropped of ids) {
    const mutated = JSON.parse(JSON.stringify(tpl));
    const composite = resourcesOfType(mutated, 'AWS::CloudWatch::CompositeAlarm')[0][1];
    // The rule is an Fn::Join over literal fragments and GetAtt references. Dropping the reference
    // for exactly one alarm is the realistic shape of this mistake: a rule edited by hand, or an
    // alarm removed from the list the rule is generated from.
    const join = composite.Properties.AlarmRule['Fn::Join'][1];
    composite.Properties.AlarmRule['Fn::Join'][1] = join.filter(
      (part) => !(part && part['Fn::GetAtt'] && part['Fn::GetAtt'][0] === dropped),
    );
    assert.equal(
      JSON.stringify(composite.Properties.AlarmRule).includes(`"${dropped}"`),
      false,
      `the mutation must actually remove ${dropped}`,
    );
    assert.throws(
      () => assertCompositeCoversExactlyTheBaseline(mutated),
      /composite does not reference/,
      `dropping ${dropped} must fail`,
    );
  }
});

test('NEGATIVE: removing an alarm resource entirely fails the invariant', () => {
  const tpl = synth('pilot');
  const [victim] = resourcesOfType(tpl, 'AWS::CloudWatch::Alarm')[0];
  const mutated = JSON.parse(JSON.stringify(tpl));
  delete mutated.Resources[victim];
  assert.throws(() => assertCompositeCoversExactlyTheBaseline(mutated), /expected 6 baseline alarms, found 5/);
});

/* ================= INVARIANT 2: exactly one SNS publisher ==================================== */

/**
 * The composite must be the only resource carrying an SNS alarm action, AND that action must target
 * this stack's own topic. Proving only that "one composite has some action" would accept a composite
 * pointing at a topic in another account — the alarm still looks wired, and the page goes elsewhere.
 */
function assertSingleSnsPublisher(tpl) {
  const publishers = [];
  for (const [id, r] of Object.entries(tpl.Resources)) {
    if (!/^AWS::CloudWatch::(Composite)?Alarm$/.test(r.Type)) continue;
    const actions = [
      ...(r.Properties.AlarmActions ?? []),
      ...(r.Properties.OKActions ?? []),
      ...(r.Properties.InsufficientDataActions ?? []),
    ];
    if (actions.length) publishers.push({ id, type: r.Type, count: actions.length });
  }
  if (publishers.length !== 1) {
    throw new Error(`expected exactly one SNS publisher, found ${publishers.length}: ${publishers.map((p) => p.id).join(', ')}`);
  }
  if (publishers[0].type !== 'AWS::CloudWatch::CompositeAlarm') {
    throw new Error(`the sole publisher must be the composite alarm, found ${publishers[0].type}`);
  }

  const topics = resourcesOfType(tpl, 'AWS::SNS::Topic');
  if (topics.length !== 1) throw new Error(`expected exactly one alert topic, found ${topics.length}`);
  const expected = JSON.stringify([{ Ref: topics[0][0] }]);
  const actual = JSON.stringify(tpl.Resources[publishers[0].id].Properties.AlarmActions ?? []);
  if (actual !== expected) {
    throw new Error(`the composite must publish to exactly this stack's topic; expected ${expected}, got ${actual}`);
  }
}

test('the composite is the only SNS publisher and targets this stack topic', () => {
  for (const env of ['dev', 'pilot']) {
    assert.doesNotThrow(() => assertSingleSnsPublisher(synth(env)), env);
  }
});

test('NEGATIVE: retargeting or padding the composite action fails', () => {
  const tpl = synth('pilot');
  const compositeId = resourcesOfType(tpl, 'AWS::CloudWatch::CompositeAlarm')[0][0];
  const topicRef = { Ref: resourcesOfType(tpl, 'AWS::SNS::Topic')[0][0] };

  const mutations = {
    'a foreign topic ARN': [{ 'Fn::Sub': 'arn:aws:sns:us-east-2:111122223333:someone-elses-topic' }],
    'a literal ARN string': ['arn:aws:sns:us-east-2:111122223333:someone-elses-topic'],
    // The real topic is still there, so a "contains our topic" assertion would pass while every
    // page is also copied somewhere else.
    'this topic plus an extra target': [topicRef, { 'Fn::Sub': 'arn:aws:sns:us-east-2:111122223333:extra' }],
    'no target at all': [],
  };

  for (const [label, actions] of Object.entries(mutations)) {
    const mutated = JSON.parse(JSON.stringify(tpl));
    mutated.Resources[compositeId].Properties.AlarmActions = actions;
    assert.throws(
      () => assertSingleSnsPublisher(mutated),
      /must publish to exactly this stack's topic|expected exactly one SNS publisher/,
      `${label} must fail`,
    );
  }
});

test('NEGATIVE: giving any second alarm an SNS action fails the invariant', () => {
  const tpl = synth('pilot');
  const topicRef = { Ref: resourcesOfType(tpl, 'AWS::SNS::Topic')[0][0] };

  for (const [id] of resourcesOfType(tpl, 'AWS::CloudWatch::Alarm')) {
    for (const field of ['AlarmActions', 'OKActions', 'InsufficientDataActions']) {
      const mutated = JSON.parse(JSON.stringify(tpl));
      mutated.Resources[id].Properties[field] = [topicRef];
      assert.throws(
        () => assertSingleSnsPublisher(mutated),
        /expected exactly one SNS publisher, found 2/,
        `${id}.${field} must fail`,
      );
    }
  }
});

/* ================= IAM: the read-only gate ==================================================== */

function gatePolicyStatements(tpl) {
  const policies = resourcesOfType(tpl, 'AWS::IAM::Policy');
  if (policies.length !== 1) throw new Error(`expected exactly one IAM policy, found ${policies.length}`);
  return policies[0][1].Properties.PolicyDocument.Statement;
}

/**
 * The single wildcard-resource statement must contain the four describe/get actions and NOTHING
 * else. With `Resource: "*"`, every added action is account-wide rather than environment-scoped.
 */
function assertWildcardStatementIsExact(tpl) {
  const wildcard = gatePolicyStatements(tpl).filter((s) => {
    const r = Array.isArray(s.Resource) ? s.Resource : [s.Resource];
    return r.includes('*');
  });
  if (wildcard.length !== 1) {
    throw new Error(`exactly one statement may use Resource "*", found ${wildcard.length}`);
  }
  const actions = [...(Array.isArray(wildcard[0].Action) ? wildcard[0].Action : [wildcard[0].Action])].sort();
  const expected = [...GATE_WILDCARD_ACTIONS].sort();
  if (JSON.stringify(actions) !== JSON.stringify(expected)) {
    throw new Error(`the wildcard statement must hold exactly [${expected.join(', ')}]; got [${actions.join(', ')}]`);
  }
  if (wildcard[0].Effect !== 'Allow') throw new Error('the wildcard statement must be an Allow');
}

test('the wildcard statement holds only actions that cannot be resource-scoped', () => {
  for (const env of ['dev', 'pilot']) {
    assert.doesNotThrow(() => assertWildcardStatementIsExact(synth(env)), env);
  }
  // Named explicitly, so a silent edit to the constant is visible in the diff of this test too.
  assert.deepEqual([...GATE_WILDCARD_ACTIONS].sort(), [
    'cloudwatch:DescribeAlarms',
    'cloudwatch:GetMetricData',
    'logs:DescribeLogGroups',
    'logs:DescribeQueryDefinitions',
  ]);
  // GetDashboard DOES support resource-level authorization, so it must not be in the wildcard set —
  // there it would have read every dashboard in the account.
  assert.equal(GATE_WILDCARD_ACTIONS.includes('cloudwatch:GetDashboard'), false);
  assert.deepEqual(GATE_DASHBOARD_ACTIONS, ['cloudwatch:GetDashboard']);
});

test('GetDashboard is scoped to this environment dashboard, not to "*"', () => {
  for (const env of ['dev', 'pilot']) {
    const tpl = synth(env);
    const dashboardStatements = gatePolicyStatements(tpl).filter(
      (st) => [].concat(st.Action ?? []).includes('cloudwatch:GetDashboard'),
    );
    assert.equal(dashboardStatements.length, 1, `${env}: one dashboard statement`);
    assert.deepEqual(dashboardStatements[0].Action, 'cloudwatch:GetDashboard');
    const resource = JSON.stringify(dashboardStatements[0].Resource);
    assert.equal(resource.includes('"*"'), false, `${env}: must not be a wildcard`);
    assert.match(resource, new RegExp(`dashboard/cba-study-coach-${env}-operational`), env);
  }
});

test('NEGATIVE: expanding the read-only action set fails', () => {
  const tpl = synth('pilot');
  // Each of these is plausible in review and each is a real widening: query execution, log-content
  // read, subscription enumeration account-wide, and an obvious wildcard.
  for (const added of [
    'logs:StartQuery',
    'logs:GetLogEvents',
    'logs:FilterLogEvents',
    'sns:ListSubscriptions',
    'cloudwatch:SetAlarmState',
    'cloudwatch:*',
    'logs:*',
  ]) {
    const mutated = JSON.parse(JSON.stringify(tpl));
    const stmt = mutated.Resources[resourcesOfType(mutated, 'AWS::IAM::Policy')[0][0]].Properties.PolicyDocument.Statement.find(
      (s) => (Array.isArray(s.Resource) ? s.Resource : [s.Resource]).includes('*'),
    );
    stmt.Action = [...stmt.Action, added];
    assert.throws(() => assertWildcardStatementIsExact(mutated), /must hold exactly/, `adding ${added} must fail`);
  }
});

test('NEGATIVE: adding a second wildcard-resource statement fails', () => {
  const tpl = synth('pilot');
  const mutated = JSON.parse(JSON.stringify(tpl));
  const doc = mutated.Resources[resourcesOfType(mutated, 'AWS::IAM::Policy')[0][0]].Properties.PolicyDocument;
  doc.Statement.push({ Effect: 'Allow', Action: ['logs:GetLogEvents'], Resource: '*' });
  assert.throws(() => assertWildcardStatementIsExact(mutated), /exactly one statement may use Resource "\*", found 2/);
});

test('SNS reads are scoped to the environment topic, never to "*"', () => {
  const tpl = synth('pilot');
  const topicStatements = gatePolicyStatements(tpl).filter((s) => {
    const actions = Array.isArray(s.Action) ? s.Action : [s.Action];
    return actions.some((a) => a.startsWith('sns:'));
  });
  assert.equal(topicStatements.length, 1, 'one SNS statement');
  assert.deepEqual([...topicStatements[0].Action].sort(), [...GATE_TOPIC_ACTIONS].sort());
  const resource = topicStatements[0].Resource;
  assert.equal(Array.isArray(resource) ? resource.length : 1, 1);
  const asJson = JSON.stringify(resource);
  assert.equal(asJson.includes('"*"'), false, 'the topic must be referenced, not a wildcard');
  assert.match(asJson, /Ref|Fn::GetAtt/, 'the topic is referenced by construct, not a literal ARN');
});

/** The account-root principal, as CloudFormation renders it. Compared structurally, not by substring. */
const ACCOUNT_ROOT_PRINCIPAL = {
  AWS: { 'Fn::Join': ['', ['arn:', { Ref: 'AWS::Partition' }, ':iam::', { Ref: 'AWS::AccountId' }, ':root']] },
};

const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** The only principal allowed to use the key or publish to the topic. Matched whole, never by substring. */
const CLOUDWATCH_PRINCIPAL = { Service: 'cloudwatch.amazonaws.com' };

/**
 * The ONE permitted wildcard action, matched on its exact whole shape.
 *
 * `kms.Key` always emits an account-root administration statement, and AWS documents that removing
 * it produces a key nobody can manage or recover — the statement is what lets IAM policies delegate
 * key use at all, so without it the key is inert as well as unrecoverable. It is therefore allowed,
 * but only as EXACTLY this statement: any extra principal, condition or resource alongside the root
 * makes it a different grant wearing the same shape, and must not be waved through.
 */
function isKmsRootAdministration(resourceType, statement) {
  if (resourceType !== 'AWS::KMS::Key') return false;
  return (
    statement.Effect === 'Allow'
    && statement.Action === 'kms:*'
    && statement.Resource === '*'
    && statement.Condition === undefined
    && eq(statement.Principal, ACCOUNT_ROOT_PRINCIPAL)
  );
}

function assertNoWildcardActions(tpl) {
  let rootAdminStatements = 0;
  for (const [id, r] of Object.entries(tpl.Resources)) {
    const docs = [];
    if (r.Type === 'AWS::IAM::Policy' || r.Type === 'AWS::IAM::ManagedPolicy') docs.push(r.Properties.PolicyDocument);
    if (r.Type === 'AWS::IAM::Role') {
      docs.push(r.Properties.AssumeRolePolicyDocument);
      for (const p of r.Properties.Policies ?? []) docs.push(p.PolicyDocument);
    }
    if (r.Type === 'AWS::KMS::Key') docs.push(r.Properties.KeyPolicy);
    if (r.Type === 'AWS::SNS::TopicPolicy') docs.push(r.Properties.PolicyDocument);
    for (const doc of docs.filter(Boolean)) {
      for (const s of doc.Statement ?? []) {
        if (isKmsRootAdministration(r.Type, s)) {
          rootAdminStatements += 1;
          continue;
        }
        for (const action of [].concat(s.Action ?? [])) {
          if (typeof action === 'string' && action.includes('*')) {
            throw new Error(`${id} grants wildcard action "${action}"`);
          }
        }
      }
    }
  }
  if (rootAdminStatements !== 1) {
    throw new Error(`exactly one KMS root-administration statement is permitted, found ${rootAdminStatements}`);
  }
}

/**
 * Beyond the root statement, the key policy must hold exactly ONE grant, to exactly the CloudWatch
 * service principal, with exactly the two actions and the account condition. Counting statements is
 * what stops a second principal being added beside a correct one and passing on the strength of its
 * neighbour.
 */
function assertKmsGrantsAreExact(tpl) {
  const [id, key] = resourcesOfType(tpl, 'AWS::KMS::Key')[0];
  const statements = key.Properties.KeyPolicy.Statement;
  const grants = statements.filter((st) => !isKmsRootAdministration('AWS::KMS::Key', st));
  if (grants.length !== 1) {
    throw new Error(`${id}: expected exactly one non-root key grant, found ${grants.length}`);
  }
  const [grant] = grants;
  if (!eq(grant.Principal, CLOUDWATCH_PRINCIPAL)) {
    throw new Error(`${id}: the only key grant must be to the CloudWatch service principal alone, got ${JSON.stringify(grant.Principal)}`);
  }
  if (!eq([...grant.Action].sort(), ['kms:Decrypt', 'kms:GenerateDataKey'])) {
    throw new Error(`${id}: key grant actions must be exactly kms:Decrypt + kms:GenerateDataKey, got ${JSON.stringify(grant.Action)}`);
  }
  if (grant.Effect !== 'Allow') throw new Error(`${id}: key grant must be an Allow`);
  if (!eq(grant.Condition, { StringEquals: { 'aws:SourceAccount': { Ref: 'AWS::AccountId' } } })) {
    throw new Error(`${id}: key grant must be conditioned on exactly aws:SourceAccount, got ${JSON.stringify(grant.Condition)}`);
  }
}

test('the key policy holds exactly the root statement and one exact CloudWatch grant', () => {
  for (const env of ['dev', 'pilot']) {
    assert.doesNotThrow(() => assertKmsGrantsAreExact(synth(env)), env);
  }
});

test('NEGATIVE: mixed or additional KMS principals fail', () => {
  const tpl = synth('pilot');
  const keyId = resourcesOfType(tpl, 'AWS::KMS::Key')[0][0];
  const grantIndex = tpl.Resources[keyId].Properties.KeyPolicy.Statement.findIndex(
    (st) => !isKmsRootAdministration('AWS::KMS::Key', st),
  );

  const mutations = {
    // The grant stays correct-looking, but a second principal now rides along inside it.
    'a foreign account mixed into the CloudWatch grant': (m) => {
      m.Resources[keyId].Properties.KeyPolicy.Statement[grantIndex].Principal = {
        Service: 'cloudwatch.amazonaws.com',
        AWS: 'arn:aws:iam::111122223333:root',
      };
    },
    'a second service mixed into the CloudWatch grant': (m) => {
      m.Resources[keyId].Properties.KeyPolicy.Statement[grantIndex].Principal = {
        Service: ['cloudwatch.amazonaws.com', 'events.amazonaws.com'],
      };
    },
    // A correct CloudWatch grant PLUS an extra statement — the shape that passes a "some statement
    // is correct" test.
    'an additional principal in its own statement': (m) => {
      m.Resources[keyId].Properties.KeyPolicy.Statement.push({
        Effect: 'Allow',
        Principal: { Service: 'events.amazonaws.com' },
        Action: ['kms:Decrypt', 'kms:GenerateDataKey'],
        Resource: '*',
        Condition: { StringEquals: { 'aws:SourceAccount': { Ref: 'AWS::AccountId' } } },
      });
    },
    'the account condition dropped': (m) => {
      delete m.Resources[keyId].Properties.KeyPolicy.Statement[grantIndex].Condition;
    },
    'the actions widened to GenerateDataKey*': (m) => {
      m.Resources[keyId].Properties.KeyPolicy.Statement[grantIndex].Action = ['kms:Decrypt', 'kms:GenerateDataKey*'];
    },
    'a root statement carrying an extra condition': (m) => {
      const root = m.Resources[keyId].Properties.KeyPolicy.Statement.find((st) => st.Action === 'kms:*');
      root.Condition = { StringEquals: { 'aws:PrincipalOrgID': 'o-example' } };
    },
    'a root-shaped statement for a foreign account': (m) => {
      m.Resources[keyId].Properties.KeyPolicy.Statement.push({
        Effect: 'Allow',
        Principal: { AWS: 'arn:aws:iam::111122223333:root' },
        Action: 'kms:*',
        Resource: '*',
      });
    },
  };

  for (const [label, mutate] of Object.entries(mutations)) {
    const mutated = JSON.parse(JSON.stringify(tpl));
    mutate(mutated);
    // Each mutation must be caught by at least one of the two guards.
    let caught = false;
    for (const guard of [assertKmsGrantsAreExact, assertNoWildcardActions]) {
      try {
        guard(mutated);
      } catch {
        caught = true;
      }
    }
    assert.equal(caught, true, `${label} must fail`);
  }
});

test('no policy anywhere grants a wildcard action', () => {
  for (const env of ['dev', 'pilot']) {
    assert.doesNotThrow(() => assertNoWildcardActions(synth(env)), env);
  }
});

test('NEGATIVE: a wildcard action in any policy fails', () => {
  const tpl = synth('pilot');
  for (const [type, mutate] of [
    ['role trust', (m) => {
      const [id] = resourcesOfType(m, 'AWS::IAM::Role')[0];
      m.Resources[id].Properties.AssumeRolePolicyDocument.Statement[0].Action = 'sts:*';
    }],
    // A `kms:*` grant to anything other than the account root — here a service principal — must
    // fail, so the root-administration exception cannot be used as a doorway.
    ['key policy to a service principal', (m) => {
      const [id] = resourcesOfType(m, 'AWS::KMS::Key')[0];
      m.Resources[id].Properties.KeyPolicy.Statement.push({
        Effect: 'Allow',
        Principal: { Service: 'cloudwatch.amazonaws.com' },
        Action: 'kms:*',
        Resource: '*',
      });
    }],
    ['a second root-administration statement', (m) => {
      const [id] = resourcesOfType(m, 'AWS::KMS::Key')[0];
      const [root] = m.Resources[id].Properties.KeyPolicy.Statement;
      m.Resources[id].Properties.KeyPolicy.Statement.push(JSON.parse(JSON.stringify(root)));
    }],
    ['topic policy', (m) => {
      const [id] = resourcesOfType(m, 'AWS::SNS::TopicPolicy')[0];
      m.Resources[id].Properties.PolicyDocument.Statement.push({ Effect: 'Allow', Action: 'sns:*', Resource: '*' });
    }],
  ]) {
    const mutated = JSON.parse(JSON.stringify(tpl));
    mutate(mutated);
    assert.throws(
      () => assertNoWildcardActions(mutated),
      /grants wildcard action|exactly one KMS root-administration statement/,
      `${type} must fail`,
    );
  }
});

/* ================= the notification path: key and topic policies ============================== */

test('the KMS key is customer-managed with rotation, and grants exact actions to CloudWatch only', () => {
  for (const env of ['dev', 'pilot']) {
    const tpl = synth(env);
    const [, key] = resourcesOfType(tpl, 'AWS::KMS::Key')[0];
    assert.equal(key.Properties.EnableKeyRotation, true, `${env}: rotation`);

    // Structural equality, never a substring: `includes('cloudwatch.amazonaws.com')` also matches
    // `{Service: ['cloudwatch.amazonaws.com', 'events.amazonaws.com']}` and
    // `evil-cloudwatch.amazonaws.com.attacker.net`, so presence would have been read as exclusivity.
    const cw = key.Properties.KeyPolicy.Statement.filter(
      (s) => eq(s.Principal, CLOUDWATCH_PRINCIPAL),
    );
    assert.equal(cw.length, 1, `${env}: exactly one CloudWatch statement`);
    // Exact pair, not `kms:GenerateDataKey*` — the wildcard form would also grant
    // GenerateDataKeyWithoutPlaintext and GenerateDataKeyPair, which SNS encryption does not need.
    assert.deepEqual([...cw[0].Action].sort(), ['kms:Decrypt', 'kms:GenerateDataKey']);
    assert.equal(JSON.stringify(cw[0].Action).includes('GenerateDataKey*'), false);
    assert.deepEqual(cw[0].Condition.StringEquals['aws:SourceAccount'], { Ref: 'AWS::AccountId' });
  }
});

test('the topic policy admits only CloudWatch, this account, and this environment alarm prefix', () => {
  for (const env of ['dev', 'pilot']) {
    const tpl = synth(env);
    const [, policy] = resourcesOfType(tpl, 'AWS::SNS::TopicPolicy')[0];
    const publish = policy.Properties.PolicyDocument.Statement.filter(
      (s) => [].concat(s.Action ?? []).includes('sns:Publish'),
    );
    assert.equal(publish.length, 1, `${env}: one publish statement`);
    assert.deepEqual(publish[0].Principal, CLOUDWATCH_PRINCIPAL);
    assert.deepEqual(publish[0].Condition.StringEquals['aws:SourceAccount'], { Ref: 'AWS::AccountId' });

    // The alarm ARN prefix scopes publication to THIS environment's alarms, not every alarm in the
    // account — which is what stops another project's alarm from paging this operator.
    const sourceArn = JSON.stringify(publish[0].Condition.ArnLike['aws:SourceArn']);
    assert.match(sourceArn, /cloudwatch/);
    assert.match(sourceArn, new RegExp(`cba-study-coach-${env}-\\*`));
  }
});

test('NEGATIVE: an unrelated publisher on the topic policy is detectable', () => {
  const tpl = synth('pilot');
  const [id] = resourcesOfType(tpl, 'AWS::SNS::TopicPolicy')[0];

  function assertOnlyCloudWatchPublishes(t) {
    const doc = t.Resources[id].Properties.PolicyDocument;
    for (const s of doc.Statement) {
      if (![].concat(s.Action ?? []).some((a) => a === 'sns:Publish')) continue;
      // Exact shape, not substring presence. A statement can name CloudWatch AND something else,
      // and a lookalike host can embed the real one; either would have satisfied a `includes` test
      // while granting publication to a principal nobody reviewed.
      if (!eq(s.Principal, CLOUDWATCH_PRINCIPAL)) {
        throw new Error(`unrelated publisher on the alert topic: ${JSON.stringify(s.Principal ?? {})}`);
      }
      if (!s.Condition?.StringEquals?.['aws:SourceAccount']) {
        throw new Error('a publish statement without aws:SourceAccount allows the confused-deputy shape');
      }
    }
  }

  assert.doesNotThrow(() => assertOnlyCloudWatchPublishes(tpl));

  for (const [label, principal] of [
    ['another service', { Service: 'events.amazonaws.com' }],
    ['any principal', '*'],
    ['a foreign account', { AWS: 'arn:aws:iam::111122223333:root' }],
    // MIXED principals: each of these CONTAINS `cloudwatch.amazonaws.com`, so each passed the old
    // substring check while granting publication to a second principal as well.
    ['CloudWatch plus another service', { Service: ['cloudwatch.amazonaws.com', 'events.amazonaws.com'] }],
    ['CloudWatch plus an AWS principal', {
      Service: 'cloudwatch.amazonaws.com',
      AWS: 'arn:aws:iam::111122223333:root',
    }],
    // And a lookalike host that merely embeds the real service name.
    ['a lookalike service host', { Service: 'evil-cloudwatch.amazonaws.com.attacker.net' }],
  ]) {
    const mutated = JSON.parse(JSON.stringify(tpl));
    mutated.Resources[id].Properties.PolicyDocument.Statement.push({
      Effect: 'Allow',
      Principal: principal,
      Action: 'sns:Publish',
      Resource: '*',
      Condition: { StringEquals: { 'aws:SourceAccount': { Ref: 'AWS::AccountId' } } },
    });
    assert.throws(() => assertOnlyCloudWatchPublishes(mutated), /unrelated publisher/, label);
  }

  // The last three shapes above all CONTAIN the allowed service name and were therefore accepted by
  // the presence test this guard used to perform. They are rejected structurally now. Note that the
  // proof is the rejection itself: re-running a substring check here to demonstrate the old
  // behaviour would reintroduce the same unsafe host test the scanner flags.
  for (const principal of [
    { Service: ['cloudwatch.amazonaws.com', 'events.amazonaws.com'] },
    { Service: 'cloudwatch.amazonaws.com', AWS: 'arn:aws:iam::111122223333:root' },
    { Service: 'evil-cloudwatch.amazonaws.com.attacker.net' },
  ]) {
    assert.equal(eq(principal, CLOUDWATCH_PRINCIPAL), false, JSON.stringify(principal));
  }

  // And a CloudWatch statement that drops the account condition is caught too.
  const noCondition = JSON.parse(JSON.stringify(tpl));
  noCondition.Resources[id].Properties.PolicyDocument.Statement.push({
    Effect: 'Allow',
    Principal: { Service: 'cloudwatch.amazonaws.com' },
    Action: 'sns:Publish',
    Resource: '*',
  });
  assert.throws(() => assertOnlyCloudWatchPublishes(noCondition), /without aws:SourceAccount/);
});

/* ================= trust: exact repository, environment and audience ========================= */

test('the gate role trusts exactly this repository, GitHub Environment and audience', () => {
  for (const env of ['dev', 'pilot']) {
    const tpl = synth(env);
    const [, role] = resourcesOfType(tpl, 'AWS::IAM::Role')[0];
    const trust = role.Properties.AssumeRolePolicyDocument.Statement;
    assert.equal(trust.length, 1, `${env}: one trust statement`);
    assert.deepEqual(trust[0].Action, 'sts:AssumeRoleWithWebIdentity');

    const conditions = trust[0].Condition.StringEquals;
    assert.equal(conditions['token.actions.githubusercontent.com:aud'], 'sts.amazonaws.com');
    // `environment:` and not `ref:` — a ref subject would let any branch assume the role, while an
    // environment subject is only reachable from a job GitHub already gated on that environment.
    assert.equal(
      conditions['token.actions.githubusercontent.com:sub'],
      `repo:marciozampiron/backstage-cba-prep:environment:${env}`,
    );
    assert.equal(JSON.stringify(conditions).includes('*'), false, 'no wildcard in the trust subject');
    // StringLike would admit prefixes; the baseline requires exactness.
    assert.equal(trust[0].Condition.StringLike, undefined, 'trust must be StringEquals only');
  }
});

test('the OIDC provider is imported, never created a second time', () => {
  for (const env of ['dev', 'pilot']) {
    const tpl = synth(env);
    // The account-global provider is SecurityStack's. A second one for the same issuer is a
    // deploy-time conflict and splits ownership of an account-level identity boundary.
    assert.equal(resourcesOfType(tpl, 'AWS::IAM::OIDCProvider').length, 0, `${env}`);
    assert.equal(resourcesOfType(tpl, 'Custom::AWSCDKOpenIdConnectProvider').length, 0, `${env}`);
    const [, role] = resourcesOfType(tpl, 'AWS::IAM::Role')[0];
    assert.match(
      JSON.stringify(role.Properties.AssumeRolePolicyDocument.Statement[0].Principal),
      /oidc-provider\/token\.actions\.githubusercontent\.com/,
    );
  }
});

test('the gate role holds no deploy, write or log-content-read permission', () => {
  const forbidden = [
    /^cloudformation:/, /^iam:/, /^sts:AssumeRole$/, /^lambda:(Update|Create|Delete|Invoke)/,
    /^dynamodb:(Put|Update|Delete|Scan|Query|GetItem|BatchWrite)/, /^kms:(Decrypt|Encrypt|GenerateDataKey)/,
    /^logs:(StartQuery|GetQueryResults|GetLogEvents|FilterLogEvents|GetLogRecord|CreateLogGroup|PutLogEvents|PutRetentionPolicy)/,
    /^cloudwatch:(SetAlarmState|PutMetricAlarm|DeleteAlarms|PutDashboard|DeleteDashboards)/,
    /^sns:(Subscribe|Unsubscribe|Publish|SetTopicAttributes|DeleteTopic|ConfirmSubscription)/,
    /^s3:/, /^ec2:/, /^secretsmanager:/, /^ssm:/,
  ];
  for (const env of ['dev', 'pilot']) {
    for (const s of gatePolicyStatements(synth(env))) {
      for (const action of [].concat(s.Action ?? [])) {
        for (const re of forbidden) {
          assert.equal(re.test(action), false, `${env}: gate role must not hold ${action}`);
        }
      }
    }
  }
});

/* ================= dashboard and saved queries =============================================== */

test('the dashboard has the five baseline rows and no learner content', () => {
  for (const env of ['dev', 'pilot']) {
    const tpl = synth(env);
    const [, dash] = resourcesOfType(tpl, 'AWS::CloudWatch::Dashboard')[0];
    const body = JSON.stringify(dash.Properties.DashboardBody);
    for (const row of ['1 - Service health', '2 - HTTP API', '3 - Lambda BFF', '4 - DynamoDB', '5 - Investigation']) {
      assert.ok(body.includes(row), `${env}: row "${row}"`);
    }
    // The dashboard must not leak learner or exam content, nor an environment URL.
    for (const forbidden of ['authorization', 'cookie', 'email', 'answer', 'explanation', 'questionText', 'jwt', 'https://']) {
      assert.equal(body.toLowerCase().includes(forbidden.toLowerCase()), false, `${env}: "${forbidden}"`);
    }
  }
});

test('each dashboard row shows the metrics its title claims', () => {
  for (const env of ['dev', 'pilot']) {
    const [, dash] = resourcesOfType(synth(env), 'AWS::CloudWatch::Dashboard')[0];
    // The body is a Fn::Join of literal fragments and refs; the metric names are in the literals.
    const body = JSON.stringify(dash.Properties.DashboardBody);
    const widgets = JSON.parse(
      JSON.stringify(dash.Properties.DashboardBody['Fn::Join'][1].filter((f) => typeof f === 'string').join('')),
    );

    for (const metric of [
      'Count', '4xx', '5xx', 'Latency', 'IntegrationLatency',            // row 2
      'Invocations', 'Errors', 'Throttles', 'Duration', 'ConcurrentExecutions', // row 3
      'ConsumedReadCapacityUnits', 'ConsumedWriteCapacityUnits', 'SuccessfulRequestLatency',
      'ReadThrottleEvents', 'WriteThrottleEvents',
      // The panel is titled "throttling and system errors" — it must actually plot SystemErrors,
      // which is the metric the release-blocking alarm watches.
      'SystemErrors',
    ]) {
      assert.ok(widgets.includes(metric), `${env}: dashboard must plot ${metric}`);
    }

    // Row 5 must carry all three investigation views the baseline names, slow routes included.
    for (const title of [
      '5 - Investigation: recent server failures',
      '5 - Investigation: errors by errorCode and routeKey',
      '5 - Investigation: slow routes',
    ]) {
      assert.ok(body.includes(title), `${env}: ${title}`);
    }
  }
});

test('the SystemErrors alarm covers exactly the operations the adapter issues', () => {
  // Not a subset: an operation the runtime performs but the alarm ignores is an unmonitored failure
  // path, and one the runtime cannot perform is a metric that will never report.
  // `TransactWriteItems` is a real Operation dimension — an earlier version of this test filtered
  // it out on the mistaken belief that it was not, which left the release-blocking alarm blind to
  // failures on the transactional write path.
  assert.deepEqual([...DYNAMO_ALARMED_OPERATIONS].sort(), [
    'DeleteItem', 'GetItem', 'PutItem', 'Query', 'TransactWriteItems', 'UpdateItem',
  ]);

  const alarm = resourcesOfType(synth('pilot'), 'AWS::CloudWatch::Alarm')
    .map(([, a]) => a.Properties)
    .find((a) => a.AlarmName.endsWith('-dynamodb-system-errors'));
  const operations = (alarm.Metrics ?? [])
    .flatMap((m) => m.MetricStat?.Metric?.Dimensions ?? [])
    .filter((d) => d.Name === 'Operation')
    .map((d) => d.Value)
    .sort();
  assert.deepEqual(operations, ['DeleteItem', 'GetItem', 'PutItem', 'Query', 'TransactWriteItems', 'UpdateItem']);

  // And the IAM grant the runtime actually holds is the same set — read from the real ApiStack.
  const apiTpl = Template.fromStack(build('pilot').api).toJSON();
  const granted = Object.values(apiTpl.Resources)
    .filter((r) => r.Type === 'AWS::IAM::Policy')
    .flatMap((r) => r.Properties.PolicyDocument.Statement)
    .flatMap((st) => [].concat(st.Action ?? []))
    .filter((a) => a.startsWith('dynamodb:'))
    .map((a) => a.replace('dynamodb:', ''))
    .sort();
  // The alarm's operation set and the IAM grant must stay aligned: an operation the runtime can
  // issue but the alarm ignores is an unmonitored failure path, and the reverse is a metric that
  // will never report.
  assert.deepEqual(granted, ['DeleteItem', 'GetItem', 'PutItem', 'Query', 'TransactWriteItems', 'UpdateItem']);
});

test('saved queries cap the rows returned; the execution scan range is set by the caller', () => {
  // The Slice A telemetry allowlist plus the Lambda runtime's own REPORT fields. Anything else in a
  // projection would defeat the field allowlist at query time.
  const ALLOWED = new Set([
    '@timestamp', '@duration', '@billedDuration', '@initDuration', '@maxMemoryUsed', '@type',
    'requestId', 'routeKey', 'statusCode', 'errorCode', 'durationMs',
  ]);
  for (const env of ['dev', 'pilot']) {
    const queries = resourcesOfType(synth(env), 'AWS::Logs::QueryDefinition');
    assert.equal(queries.length, 5, `${env}: five queries`);
    for (const [id, q] of queries) {
      const text = q.Properties.QueryString;
      // `| limit N` caps ROWS RETURNED. QL filters (including `@timestamp` ones) narrow results but
      // still run over what the execution scanned; only startTime/endTime on StartQuery set that
      // range. This assertion therefore claims only the row cap; the bounded execution window is
      // #70's, and the gate role deliberately holds no logs:StartQuery (asserted separately).
      assert.match(text, /\|\s*limit\s+\d+/, `${env}/${id} must cap the rows returned`);
      // `@message` returns the whole event and would bypass the field allowlist entirely.
      assert.equal(text.includes('@message'), false, `${env}/${id} must not project @message`);
      const fieldsLine = text.split('\n')[0];
      assert.match(fieldsLine, /^fields /, `${env}/${id} starts with a fields projection`);
      for (const field of fieldsLine.replace(/^fields /, '').split(',').map((f) => f.trim())) {
        assert.ok(ALLOWED.has(field), `${env}/${id} projects non-allowlisted field "${field}"`);
      }
    }
  }
});

test('the gate role cannot execute a query, so it cannot bypass the execution-time window', () => {
  for (const env of ['dev', 'pilot']) {
    const actions = gatePolicyStatements(synth(env)).flatMap((st) => [].concat(st.Action ?? []));
    for (const forbidden of ['logs:StartQuery', 'logs:GetQueryResults', 'logs:StopQuery']) {
      assert.equal(actions.includes(forbidden), false, `${env}: ${forbidden}`);
    }
  }
});

test('saved query names are environment-scoped and the correlation query spans both log groups', () => {
  const queries = resourcesOfType(synth('pilot'), 'AWS::Logs::QueryDefinition');
  const names = queries.map(([, q]) => q.Properties.Name).sort();
  assert.deepEqual(names, [
    'cba-study-coach-pilot/1-recent-server-failures',
    'cba-study-coach-pilot/2-errors-by-code-and-route',
    'cba-study-coach-pilot/3-latency-percentiles-by-route',
    'cba-study-coach-pilot/4-lambda-timeout-and-cold-start',
    'cba-study-coach-pilot/5-api-to-lambda-correlation',
  ]);
  // Correlation only works if the access log and the application log are queried together.
  const correlation = queries.find(([, q]) => q.Properties.Name.endsWith('5-api-to-lambda-correlation'))[1];
  assert.equal(correlation.Properties.LogGroupNames.length, 2);
});

/* ================= outputs, naming and tags =================================================== */

test('outputs are logical names only — no ARN, account id, endpoint or subscription', () => {
  for (const env of ['dev', 'pilot']) {
    const tpl = synth(env);
    const outputs = Object.entries(tpl.Outputs ?? {});
    assert.equal(outputs.length, 4, `${env}: four outputs`);
    for (const [name, out] of outputs) {
      const value = JSON.stringify(out.Value);
      assert.equal(/arn:/i.test(value), false, `${env}/${name} must not expose an ARN`);
      assert.equal(/Fn::GetAtt[^]*Arn/.test(value), false, `${env}/${name} must not expose an ARN`);
      assert.equal(/AWS::AccountId/.test(value), false, `${env}/${name} must not expose the account id`);
      assert.equal(/https?:\/\//.test(value), false, `${env}/${name} must not expose an endpoint`);
    }
    assert.deepEqual(outputs.map(([n]) => n).sort(), [
      'ObservabilityGateRoleName',
      'OperationalAlertTopicName',
      'OperationalDashboardName',
      'OperationalHealthAlarmName',
    ]);
  }
});

test('resources are environment-scoped and carry the foundation tags', () => {
  for (const env of ['dev', 'pilot']) {
    const tpl = synth(env);
    const [, topic] = resourcesOfType(tpl, 'AWS::SNS::Topic')[0];
    assert.equal(topic.Properties.TopicName, `cba-study-coach-${env}-operational-alerts`);
    const tags = Object.fromEntries((topic.Properties.Tags ?? []).map((t) => [t.Key, t.Value]));
    assert.equal(tags.Project, 'CBAStudyCoach');
    assert.equal(tags.Environment, env);
    assert.equal(tags.ManagedBy, 'CDK');
  }
  // dev is disposable, pilot durable — the key must survive a pilot stack deletion or the alert
  // history and the encrypted topic become unrecoverable.
  assert.equal(resourcesOfType(synth('pilot'), 'AWS::KMS::Key')[0][1].DeletionPolicy, 'Retain');
  assert.equal(resourcesOfType(synth('dev'), 'AWS::KMS::Key')[0][1].DeletionPolicy, 'Delete');
});

test('no literal account id appears in the template', () => {
  for (const env of ['dev', 'pilot']) {
    assert.equal(/\b\d{12}\b/.test(JSON.stringify(synth(env))), false, env);
  }
});

/* ================= synth-time refusals ======================================================== */

test('NEGATIVE: a missing stack reference fails synth', () => {
  for (const missing of ['httpApi', 'bffFunction', 'bffLogGroup', 'accessLogGroup', 'table']) {
    assert.throws(
      () => build('pilot', { [missing]: undefined }),
      new RegExp(`requires an explicit "${missing}" reference`),
      `${missing} must be required`,
    );
  }
});

test('NEGATIVE: an unsupported environment fails synth', () => {
  for (const env of ['staging', 'production', 'prod', '']) {
    assert.throws(() => build(env), /context "environment" must be one of dev\|pilot/, env);
  }
});

test('the gate role consumes the SecurityStack provider and depends on that stack', () => {
  const { buildStacks } = require('../lib/app');
  const app = new App({ context: { environment: 'pilot' } });
  const stacks = buildStacks(app);

  // An explicit stack dependency, so ordering holds even when an operator supplies an existing
  // provider ARN by context (which produces no CloudFormation reference on its own).
  assert.ok(
    stacks.observability.dependencies.includes(stacks.security),
    'ObservabilityStack must depend on SecurityStack',
  );

  const assembly = app.synth();
  const artifact = assembly.getStackArtifact(stacks.observability.artifactId);
  assert.ok(
    artifact.dependencies.some((d) => d.id === stacks.security.artifactId),
    'the synthesized assembly must order SecurityStack before ObservabilityStack',
  );

  // And the trust actually consumes that provider rather than a reconstructed ARN.
  const principal = JSON.stringify(
    artifact.template.Resources[
      Object.keys(artifact.template.Resources).find((k) => artifact.template.Resources[k].Type === 'AWS::IAM::Role')
    ].Properties.AssumeRolePolicyDocument.Statement[0].Principal,
  );
  assert.match(principal, /Fn::ImportValue/, 'the provider must be imported from SecurityStack');
});

test('the app wires the observability stack to the real workload constructs', () => {
  // Guards the wiring itself: alarms that point at a different function would synthesise happily.
  const { buildStacks } = require('../lib/app');
  const app = new App({ context: { environment: 'dev' } });
  const stacks = buildStacks(app);
  assert.ok(stacks.observability, 'the app must build an ObservabilityStack');
  const tpl = Template.fromStack(stacks.observability).toJSON();
  assert.equal(resourcesOfType(tpl, 'AWS::CloudWatch::Alarm').length, 6);
  assert.equal(resourcesOfType(tpl, 'AWS::CloudWatch::CompositeAlarm').length, 1);
  assert.doesNotThrow(() => assertCompositeCoversExactlyTheBaseline(tpl));
  assert.doesNotThrow(() => assertSingleSnsPublisher(tpl));
  assert.doesNotThrow(() => assertWildcardStatementIsExact(tpl));
});
