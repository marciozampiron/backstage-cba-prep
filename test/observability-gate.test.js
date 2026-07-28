// Release gates O1 and O2 (#82 Slice C).
//
// Every AWS call is injected. The invoker is a SPY: when a test expects the gate NOT to reach a
// service, it asserts the call was never made, rather than asserting on a result that happened to
// be right. No test contacts a remote, deploys, reads a log, or changes an alarm.
//
// The gates fail closed, so most of this file is negative controls. A release gate that has only
// ever been seen to pass is indistinguishable from one that always passes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runObservabilityGate, EXIT } from '../src/commands/observability-gate.js';
import { AWS_CALL_TIMEOUT_MS, readMetricSum, withCliBounds } from '../src/commands/observability-gate.js';
import {
  ALARM_SUFFIXES,
  GateError,
  nextMinuteBarrier,
  O2_MAX_POLL_MS,
  O2_MAX_WINDOW_AGE_MS,
  O2_SCOPE_NOTE,
  QUERY_SUFFIXES,
  assertLogicalOnly,
  assertSmokeWindow,
  evaluateAlarmStates,
  evaluateO1,
  evaluateO2Round,
  evaluateTrafficEvidence,
  resourceNames,
} from '../src/lib/observability-gate.js';

/* ============================ fixtures ======================================================= */

const ACCOUNT = '111122223333';
const API_ID = 'abc123xyz';

/** A fully healthy environment, as the AWS CLI would describe it. Tests mutate copies of this. */
function healthy(environment = 'pilot') {
  const names = resourceNames(environment);
  return {
    logGroups: [
      { name: names.applicationLogGroup, retentionDays: names.retentionDays },
      { name: names.accessLogGroup, retentionDays: names.retentionDays },
    ],
    queryDefinitionNames: [...names.queries],
    dashboardExists: true,
    topicExists: true,
    alarms: [
      ...names.alarms.map((name) => ({ name, treatMissingData: 'notBreaching', type: 'MetricAlarm' })),
      { name: names.compositeAlarm, type: 'CompositeAlarm' },
    ],
    subscriptions: [{ confirmed: true }],
  };
}

/**
 * An AWS CLI stub. `overrides` maps "service subcommand" to a payload or to a thrown exit code.
 * Records every call so a test can assert on what was NOT called.
 */
function fakeAws(overrides = {}) {
  const calls = [];
  const invoke = (args) => {
    calls.push(args);
    const key = `${args[0]} ${args[1]}`;
    const handler = Object.hasOwn(overrides, key) ? overrides[key] : DEFAULTS[key];
    if (handler === undefined) return { code: 1, stdout: '', stderr: `unstubbed: ${key}` };
    const value = typeof handler === 'function' ? handler(args, calls.length) : handler;
    if (value === null) return { code: 254, stdout: '', stderr: 'ResourceNotFound' };
    if (typeof value === 'string') return { code: 0, stdout: value, stderr: '' };
    return { code: 0, stdout: JSON.stringify(value), stderr: '' };
  };
  invoke.calls = calls;
  invoke.called = (service, sub) => calls.some((a) => a[0] === service && a[1] === sub);
  return invoke;
}

const names = resourceNames('pilot');

const DEFAULTS = {
  'sts get-caller-identity': { Account: ACCOUNT, Arn: `arn:aws:sts::${ACCOUNT}:assumed-role/gate/session` },
  'logs describe-log-groups': (args) => {
    const prefix = args[args.indexOf('--log-group-name-prefix') + 1];
    return { logGroups: [{ logGroupName: prefix, retentionInDays: 30 }] };
  },
  'logs describe-query-definitions': { queryDefinitions: names.queries.map((name) => ({ name })) },
  'cloudwatch get-dashboard': { DashboardBody: '{}' },
  'sns get-topic-attributes': { Attributes: {} },
  'sns list-subscriptions-by-topic': { Subscriptions: [{ SubscriptionArn: `arn:aws:sns:us-east-2:${ACCOUNT}:t:sub` }] },
  'cloudwatch describe-alarms': {
    MetricAlarms: names.alarms.map((AlarmName) => ({ AlarmName, TreatMissingData: 'notBreaching', StateValue: 'OK' })),
    CompositeAlarms: [{ AlarmName: names.compositeAlarm, StateValue: 'OK' }],
  },
  'cloudwatch get-metric-data': {
    MetricDataResults: [
      { Id: 'api', StatusCode: 'Complete', Values: [3, 4] },
      { Id: 'lambda', StatusCode: 'Complete', Values: [7] },
    ],
  },
};

const ENV = { AWS_REGION: 'us-east-2' };
const silent = () => {};

/* ============================ names ========================================================== */

test('logical names derive from the environment and nothing else', () => {
  const dev = resourceNames('dev');
  assert.equal(dev.base, 'cba-study-coach-dev');
  assert.equal(dev.applicationLogGroup, '/aws/lambda/cba-study-coach-dev-bff');
  assert.equal(dev.accessLogGroup, '/aws/apigateway/cba-study-coach-dev-bff');
  assert.equal(dev.dashboard, 'cba-study-coach-dev-operational');
  assert.equal(dev.topic, 'cba-study-coach-dev-operational-alerts');
  assert.equal(dev.compositeAlarm, 'cba-study-coach-dev-operational-health');
  assert.equal(dev.retentionDays, 7);
  assert.equal(resourceNames('pilot').retentionDays, 30);
  assert.equal(dev.alarms.length, ALARM_SUFFIXES.length);
  assert.equal(dev.queries.length, QUERY_SUFFIXES.length);
});

test('NEGATIVE: an unsupported environment is refused, never guessed', () => {
  for (const bad of ['staging', 'prod', '', null, undefined, 'DEV']) {
    assert.throws(() => resourceNames(bad), (e) => e instanceof GateError && e.code === 'ENVIRONMENT_UNSUPPORTED');
  }
});

/* ============================ O1 ============================================================= */

test('O1 passes on a fully healthy environment', () => {
  for (const env of ['dev', 'pilot']) {
    const verdict = evaluateO1(healthy(env), env);
    assert.equal(verdict.ok, true, `${env}: ${JSON.stringify(verdict.checks.filter((c) => !c.ok))}`);
  }
});

test('NEGATIVE: each structural defect blocks O1 on its own', () => {
  const cases = {
    'missing application log group': (o) => { o.logGroups = o.logGroups.filter((g) => !g.name.includes('/aws/lambda/')); },
    'missing access log group': (o) => { o.logGroups = o.logGroups.filter((g) => !g.name.includes('/aws/apigateway/')); },
    // Never-expiring retention is the CDK default when a group is adopted rather than declared, and
    // it is exactly what the baseline forbids — so it must fail, not merely warn.
    'never-expiring retention': (o) => { o.logGroups[0].retentionDays = undefined; },
    'drifted retention': (o) => { o.logGroups[0].retentionDays = 90; },
    'missing dashboard': (o) => { o.dashboardExists = false; },
    'one missing saved query': (o) => { o.queryDefinitionNames = o.queryDefinitionNames.slice(1); },
    'missing topic': (o) => { o.topicExists = false; },
    'one missing alarm': (o) => { o.alarms = o.alarms.slice(1); },
    'missing composite': (o) => { o.alarms = o.alarms.filter((a) => a.type !== 'CompositeAlarm'); },
    'one alarm breaching on missing data': (o) => { o.alarms[0].treatMissingData = 'breaching'; },
    'unset missing-data posture': (o) => { delete o.alarms[0].treatMissingData; },
    'no confirmed subscription': (o) => { o.subscriptions = [{ confirmed: false }]; },
    'no subscription at all': (o) => { o.subscriptions = []; },
    'subscriptions unreadable': (o) => { o.subscriptions = null; },
    'alarms unobservable': (o) => { o.alarms = null; },
    'log groups unobservable': (o) => { o.logGroups = null; },
    'queries unobservable': (o) => { o.queryDefinitionNames = null; },
  };
  for (const [label, mutate] of Object.entries(cases)) {
    const observed = healthy('pilot');
    mutate(observed);
    assert.equal(evaluateO1(observed, 'pilot').ok, false, `${label} must block O1`);
  }
});

test('NEGATIVE: the alarm RESOURCE TYPE is checked, not only the name', () => {
  // A metric alarm named `…-operational-health` satisfies a name-only test while the aggregation
  // and the sole-notification topology are simply absent — the composite is what carries the SNS
  // action, so nothing would page and O1 would still be green.
  const cases = {
    'composite reported as a MetricAlarm': (o) => {
      o.alarms.find((a) => a.type === 'CompositeAlarm').type = 'MetricAlarm';
    },
    'composite with no type at all': (o) => {
      delete o.alarms.find((a) => a.type === 'CompositeAlarm').type;
    },
    'a native alarm reported as a CompositeAlarm': (o) => { o.alarms[0].type = 'CompositeAlarm'; },
    'a native alarm with no type': (o) => { delete o.alarms[0].type; },
    // Mixed: the counts are right and every name is present, but the topology is inverted.
    'native and composite types swapped': (o) => {
      o.alarms[0].type = 'CompositeAlarm';
      o.alarms.find((a) => a.name.endsWith('-operational-health')).type = 'MetricAlarm';
    },
  };
  for (const [label, mutate] of Object.entries(cases)) {
    const observed = healthy('pilot');
    mutate(observed);
    assert.equal(evaluateO1(observed, 'pilot').ok, false, `${label} must block O1`);
  }
});

test('the subscription requirement applies to pilot only', () => {
  // dev is not an on-call environment; requiring a confirmed endpoint there would push operators
  // toward subscribing a personal address to a throwaway stack.
  const dev = healthy('dev');
  delete dev.subscriptions;
  assert.equal(evaluateO1(dev, 'dev').ok, true);
  assert.equal(evaluateO1(dev, 'dev').checks.some((c) => c.id === 'notification-subscription'), false);

  const pilot = healthy('pilot');
  delete pilot.subscriptions;
  assert.equal(evaluateO1(pilot, 'pilot').ok, false);
});

test('O1 reads every environment resource through permitted calls only', async () => {
  const aws = fakeAws();
  const code = await runObservabilityGate({ gate: 'o1', environment: 'pilot', aws, env: ENV, log: silent, json: true });
  assert.equal(code, EXIT.OK);

  const used = new Set(aws.calls.map((a) => `${a[0]} ${a[1]}`));
  assert.deepEqual([...used].sort(), [
    'cloudwatch describe-alarms',
    'cloudwatch get-dashboard',
    'logs describe-log-groups',
    'logs describe-query-definitions',
    'sns get-topic-attributes',
    'sns list-subscriptions-by-topic',
    'sts get-caller-identity',
  ]);

  // Nothing that writes, executes a query, reads log content or mutates state.
  for (const forbidden of [
    'logs start-query', 'logs get-query-results', 'logs get-log-events', 'logs filter-log-events',
    'cloudwatch set-alarm-state', 'cloudwatch put-metric-alarm', 'cloudwatch put-dashboard',
    'sns subscribe', 'sns publish', 'cloudformation deploy', 'cloudformation describe-stacks',
    'lambda invoke', 'lambda get-function-configuration', 'apigatewayv2 get-api',
  ]) {
    const [service, sub] = forbidden.split(' ');
    assert.equal(aws.called(service, sub), false, `O1 must never call ${forbidden}`);
  }
});

test('NEGATIVE: an AWS call that fails outright blocks O1 rather than passing it', async () => {
  const aws = fakeAws({ 'cloudwatch describe-alarms': () => { throw new Error('unreachable'); } });
  await assert.rejects(
    () => runObservabilityGate({ gate: 'o1', environment: 'pilot', aws, env: ENV, log: silent }),
    /unreachable/,
  );

  // A CLI that exits non-zero on a required call is a collection failure, not an observation.
  const noQueries = fakeAws({ 'logs describe-query-definitions': () => ({ code: 255 }) });
  const stub = (args) => {
    noQueries.calls.push(args);
    if (args[0] === 'logs' && args[1] === 'describe-query-definitions') return { code: 255, stdout: '', stderr: 'denied' };
    return fakeAws()(args);
  };
  stub.calls = noQueries.calls;
  const code = await runObservabilityGate({ gate: 'o1', environment: 'pilot', aws: stub, env: ENV, log: silent });
  assert.equal(code, EXIT.GATE_FAILED);
});

test('NEGATIVE: unparseable AWS output blocks rather than being read as empty', async () => {
  const aws = fakeAws({ 'logs describe-query-definitions': 'not json at all' });
  const code = await runObservabilityGate({ gate: 'o1', environment: 'pilot', aws, env: ENV, log: silent });
  assert.equal(code, EXIT.GATE_FAILED);
});

test('NEGATIVE: O1 refuses when the region is unset', async () => {
  const code = await runObservabilityGate({ gate: 'o1', environment: 'pilot', aws: fakeAws(), env: {}, log: silent });
  assert.equal(code, EXIT.GATE_FAILED);
});

/* ============================ the smoke window =============================================== */

test('the smoke window must be bounded and anchored to this run', () => {
  // A whole minute, so these cases exercise the age bounds rather than the alignment rule.
  const now = Math.floor(1_800_000_000_000 / 60_000) * 60_000;
  assert.doesNotThrow(() => assertSmokeWindow({ startMs: now - 60_000, nowMs: now }));

  // A window from a previous release would let YESTERDAY's traffic satisfy TODAY's gate: the metric
  // query returns datapoints, the alarms read OK, and a deploy nothing reached goes green.
  // Whole-minute offsets, so these cases exercise the age bounds and not the alignment rule.
  assert.throws(
    () => assertSmokeWindow({ startMs: now - O2_MAX_WINDOW_AGE_MS - 60_000, nowMs: now }),
    (e) => e.code === 'WINDOW_STALE',
  );
  assert.throws(() => assertSmokeWindow({ startMs: now + 60_000, nowMs: now }), (e) => e.code === 'WINDOW_IN_FUTURE');
  assert.throws(() => assertSmokeWindow({ startMs: NaN, nowMs: now }), (e) => e.code === 'WINDOW_START_INVALID');
});

test('the smoke window must start on a whole minute', () => {
  // CloudWatch rounds StartTime DOWN to the minute. A window declared at 12:32:34 is queried from
  // 12:32:00, so a request that reached the PREVIOUS deployment at 12:32:10 lands inside it: both
  // traffic checks pass, every alarm is OK, and O2 promotes a release the smokes never reached.
  // Passing the unrounded timestamp to CloudWatch does not prevent that — only refusing the
  // unaligned window does, because after the fact the stale datapoint is indistinguishable from a
  // legitimate one.
  const unaligned = Date.parse('2026-07-28T12:32:34Z');
  const nowMs = Date.parse('2026-07-28T12:33:10Z');
  assert.throws(
    () => assertSmokeWindow({ startMs: unaligned, nowMs }),
    (e) => e.code === 'WINDOW_NOT_MINUTE_ALIGNED',
  );

  const aligned = Date.parse('2026-07-28T12:33:00Z');
  assert.doesNotThrow(() => assertSmokeWindow({ startMs: aligned, nowMs }));

  // The barrier always advances: a barrier equal to "right now" would share a timestamp bucket with
  // the previous deployment's in-flight requests.
  assert.equal(nextMinuteBarrier(unaligned), Date.parse('2026-07-28T12:33:00Z'));
  assert.equal(nextMinuteBarrier(aligned), Date.parse('2026-07-28T12:34:00Z'));
  assert.equal(nextMinuteBarrier(aligned) % 60_000, 0);
});

test('NEGATIVE: an unaligned window is refused before any metric call', async () => {
  const aws = fakeAws();
  const code = await runObservabilityGate({
    gate: 'o2', environment: 'pilot', apiId: API_ID,
    since: '2026-07-28T12:32:34Z',
    aws, env: ENV, now: () => Date.parse('2026-07-28T12:33:10Z'), log: silent, json: true,
  });
  assert.equal(code, EXIT.GATE_FAILED);
  assert.equal(aws.calls.length, 0, 'it must refuse before reaching AWS at all');
});

/* ============================ O2: traffic evidence =========================================== */

test('traffic evidence requires BOTH the API and the Lambda', () => {
  assert.equal(evaluateTrafficEvidence({ apiCount: 1, lambdaInvocations: 1 }).observed, true);
  assert.equal(evaluateTrafficEvidence({ apiCount: 5, lambdaInvocations: 9 }).observed, true);

  for (const sums of [
    { apiCount: 0, lambdaInvocations: 1 },
    { apiCount: 1, lambdaInvocations: 0 },
    { apiCount: 0, lambdaInvocations: 0 },
    { apiCount: null, lambdaInvocations: 1 },   // metric absent entirely
    { apiCount: 1 },                            // Lambda never reported
    {},
  ]) {
    assert.equal(evaluateTrafficEvidence(sums).observed, false, JSON.stringify(sums));
  }
});

test('the verdict says whether traffic was observed, never how much', () => {
  const evidence = evaluateTrafficEvidence({ apiCount: 4217, lambdaInvocations: 4217 });
  assert.equal(evidence.observed, true);
  // A request count is learner activity, and release evidence outlives the run that produced it.
  assert.equal(JSON.stringify(evidence).includes('4217'), false);
});

/* ============================ O2: metric-result integrity =================================== */

const completeResult = (id, values) => ({ Id: id, StatusCode: 'Complete', Values: values });

test('a complete metric result is summed', () => {
  const out = { MetricDataResults: [completeResult('api', [1, 2, 3])] };
  assert.equal(readMetricSum(out, 'api'), 6);
  assert.equal(readMetricSum({ MetricDataResults: [completeResult('api', [])] }, 'api'), 0);
});

test('NEGATIVE: a qualified metric result is refused, not summed', () => {
  // Each of these carries POSITIVE VALUES. Summing them is how a gate reports healthy traffic from
  // a response that told it the data was incomplete: the numbers look ordinary and nothing in the
  // verdict hints that CloudWatch qualified them.
  const cases = {
    PartialData: { MetricDataResults: [{ Id: 'api', StatusCode: 'PartialData', Values: [9] }] },
    InternalError: { MetricDataResults: [{ Id: 'api', StatusCode: 'InternalError', Values: [9] }] },
    Forbidden: { MetricDataResults: [{ Id: 'api', StatusCode: 'Forbidden', Values: [9] }] },
    'status unset': { MetricDataResults: [{ Id: 'api', Values: [9] }] },
    'result messages': { MetricDataResults: [{ Id: 'api', StatusCode: 'Complete', Values: [9], Messages: [{ Code: 'x' }] }] },
    'query-level messages': {
      MetricDataResults: [completeResult('api', [9])],
      Messages: [{ Code: 'MaxMetricsExceeded', Value: 'truncated' }],
    },
    'residual NextToken': { MetricDataResults: [completeResult('api', [9])], NextToken: 'more' },
    'missing result': { MetricDataResults: [completeResult('lambda', [9])] },
    'duplicated result': { MetricDataResults: [completeResult('api', [9]), completeResult('api', [9])] },
    'no results array': {},
    'values not an array': { MetricDataResults: [{ Id: 'api', StatusCode: 'Complete', Values: 9 }] },
    'a non-finite value': { MetricDataResults: [completeResult('api', [9, Number.NaN])] },
    'a negative value': { MetricDataResults: [completeResult('api', [9, -1])] },
    'mismatched timestamps': {
      MetricDataResults: [{ Id: 'api', StatusCode: 'Complete', Values: [9], Timestamps: [] }],
    },
    'an unparseable timestamp': {
      MetricDataResults: [{ Id: 'api', StatusCode: 'Complete', Values: [9], Timestamps: ['not a date'] }],
    },
  };
  for (const [label, out] of Object.entries(cases)) {
    assert.throws(() => readMetricSum(out, 'api'), (e) => e instanceof GateError, `${label} must be refused`);
  }
});

test('NEGATIVE: a qualified metric result blocks O2 before any alarm is read', async () => {
  const nowMs = Date.parse('2026-07-28T12:00:00Z');
  const responses = {
    'both results qualified': {
      MetricDataResults: [
        { Id: 'api', StatusCode: 'PartialData', Values: [9] },
        { Id: 'lambda', StatusCode: 'InternalError', Values: [9], Messages: [{ Code: 'InternalError' }] },
      ],
      Messages: [{ Code: 'MaxMetricsExceeded', Value: 'truncated' }],
    },
    'only the API result qualified': {
      MetricDataResults: [
        { Id: 'api', StatusCode: 'PartialData', Values: [9] },
        completeResult('lambda', [9]),
      ],
    },
    'only the Lambda result qualified': {
      MetricDataResults: [
        completeResult('api', [9]),
        { Id: 'lambda', StatusCode: 'Forbidden', Values: [9] },
      ],
    },
    'paginated with positive values': {
      MetricDataResults: [completeResult('api', [9]), completeResult('lambda', [9])],
      NextToken: 'more',
    },
  };
  for (const [label, payload] of Object.entries(responses)) {
    const aws = fakeAws({ 'cloudwatch get-metric-data': payload });
    const code = await runObservabilityGate({
      gate: 'o2', environment: 'pilot', apiId: API_ID, since: since(nowMs),
      aws, env: ENV, now: () => nowMs, log: silent, json: true, timeoutMs: O2_MAX_POLL_MS,
    });
    assert.equal(code, EXIT.GATE_FAILED, `${label} must block`);
    assert.equal(aws.called('cloudwatch', 'describe-alarms'), false, `${label} must block before alarm evaluation`);
  }
});

/* ============================ O2: alarm states =============================================== */

const okStates = (environment = 'pilot') => {
  const n = resourceNames(environment);
  return [...n.alarms, n.compositeAlarm].map((name) => ({ name, state: 'OK' }));
};

test('every required alarm and the composite must be OK', () => {
  const verdict = evaluateAlarmStates(okStates(), 'pilot');
  assert.equal(verdict.ok, true);
  assert.equal(verdict.states.length, ALARM_SUFFIXES.length + 1);
});

test('ALARM blocks immediately; INSUFFICIENT_DATA waits for the deadline', () => {
  const inAlarm = okStates();
  inAlarm[0].state = 'ALARM';
  const alarmVerdict = evaluateAlarmStates(inAlarm, 'pilot');
  assert.equal(alarmVerdict.ok, false);
  // Polling longer cannot make an ALARM acceptable, so the gate decides now.
  assert.equal(alarmVerdict.blocking, true);

  const insufficient = okStates();
  insufficient[0].state = 'INSUFFICIENT_DATA';
  const waiting = evaluateAlarmStates(insufficient, 'pilot');
  assert.equal(waiting.ok, false);
  assert.equal(waiting.blocking, false);
});

test('NEGATIVE: a missing or unrecognised alarm state blocks and does not wait', () => {
  const missing = okStates().slice(1);
  assert.equal(evaluateAlarmStates(missing, 'pilot').blocking, true);

  const weird = okStates();
  weird[0].state = 'PROBABLY_FINE';
  const verdict = evaluateAlarmStates(weird, 'pilot');
  assert.equal(verdict.ok, false);
  assert.equal(verdict.blocking, true);

  assert.equal(evaluateAlarmStates(null, 'pilot').ok, false);
  assert.equal(evaluateAlarmStates(undefined, 'pilot').blocking, true);
});

test('the composite alone is not enough — a green composite with a red member still blocks', () => {
  const states = okStates();
  states.find((s) => s.name.endsWith('-api-5xx')).state = 'ALARM';
  assert.equal(evaluateAlarmStates(states, 'pilot').ok, false);
});

/* ============================ O2: ordering =================================================== */

test('alarms are never evaluated before traffic evidence exists', () => {
  // The failure this prevents: with TreatMissingData=notBreaching, an environment no request ever
  // reached reports every alarm OK. Checking alarms first would pass that deploy.
  const round = evaluateO2Round({
    traffic: { apiCount: 0, lambdaInvocations: 0 },
    alarms: okStates(),
    environment: 'pilot',
    deadlineReached: true,
  });
  assert.equal(round.done, true);
  assert.equal(round.verdict.ok, false);
  assert.equal(round.verdict.reason, 'TRAFFIC_EVIDENCE_ABSENT');
  assert.equal(round.verdict.trafficObserved, false);
  // No alarm verdict is reported at all — there is nothing there to misread as health.
  assert.deepEqual(round.verdict.alarms, []);
});

test('O2 keeps polling while traffic has not yet appeared and the deadline is ahead', () => {
  const round = evaluateO2Round({
    traffic: { apiCount: 0, lambdaInvocations: 0 },
    alarms: null,
    environment: 'pilot',
    deadlineReached: false,
  });
  assert.equal(round.done, false);
  assert.equal(round.verdict, null);
});

test('O2 passes only with traffic evidence AND every alarm OK', () => {
  const round = evaluateO2Round({
    traffic: { apiCount: 2, lambdaInvocations: 2 },
    alarms: okStates(),
    environment: 'pilot',
    deadlineReached: false,
  });
  assert.equal(round.done, true);
  assert.equal(round.verdict.ok, true);
  assert.equal(round.verdict.trafficObserved, true);
  assert.equal(round.verdict.reason, 'HEALTHY');
});

test('every O2 verdict carries the ingestion-not-coverage limit, including the passing one', () => {
  const passing = evaluateO2Round({
    traffic: { apiCount: 1, lambdaInvocations: 1 },
    alarms: okStates(),
    environment: 'pilot',
    deadlineReached: false,
  }).verdict;
  // A green O2 is exactly the result that gets quoted later as "the release was verified".
  assert.equal(passing.note, O2_SCOPE_NOTE);
  assert.match(passing.note, /not functional route coverage/);
  assert.match(passing.note, /#70 deployed learner smokes/);

  const blocked = evaluateO2Round({
    traffic: { apiCount: 0, lambdaInvocations: 0 },
    alarms: null,
    environment: 'pilot',
    deadlineReached: true,
  }).verdict;
  assert.equal(blocked.note, O2_SCOPE_NOTE);
});

/* ============================ O2: end to end through the command ============================= */

// The gate requires a minute-aligned window, so the helper produces one — and `nowMs` in these
// tests is itself a whole minute.
const since = (nowMs, agoMs = 60_000) => new Date(Math.floor((nowMs - agoMs) / 60_000) * 60_000).toISOString();

test('O2 passes end to end when traffic flows and alarms are OK', async () => {
  const nowMs = Date.parse('2026-07-28T12:00:00Z');
  const aws = fakeAws();
  const code = await runObservabilityGate({
    gate: 'o2', environment: 'pilot', apiId: API_ID, since: since(nowMs),
    aws, env: ENV, now: () => nowMs, log: silent, json: true,
  });
  assert.equal(code, EXIT.OK);
  assert.equal(aws.called('cloudwatch', 'get-metric-data'), true);
  assert.equal(aws.called('cloudwatch', 'describe-alarms'), true);
});

test('NEGATIVE: with no traffic, O2 blocks and never asks about alarms', async () => {
  const nowMs = Date.parse('2026-07-28T12:00:00Z');
  const aws = fakeAws({
    'cloudwatch get-metric-data': {
      MetricDataResults: [
        { Id: 'api', StatusCode: 'Complete', Values: [] },
        { Id: 'lambda', StatusCode: 'Complete', Values: [] },
      ],
    },
  });
  const code = await runObservabilityGate({
    gate: 'o2', environment: 'pilot', apiId: API_ID, since: since(nowMs),
    aws, env: ENV, now: () => nowMs, log: silent, json: true,
    timeoutMs: 0, // deadline already reached: one round, no waiting
  });
  assert.equal(code, EXIT.GATE_FAILED);
  // The spy proves the ordering rather than inferring it from the result.
  assert.equal(aws.called('cloudwatch', 'describe-alarms'), false);
});

test('NEGATIVE: traffic from only one side is not evidence', async () => {
  const nowMs = Date.parse('2026-07-28T12:00:00Z');
  for (const results of [
    [{ Id: 'api', StatusCode: 'Complete', Values: [5] }, { Id: 'lambda', StatusCode: 'Complete', Values: [] }],
    [{ Id: 'api', StatusCode: 'Complete', Values: [] }, { Id: 'lambda', StatusCode: 'Complete', Values: [5] }],
  ]) {
    const aws = fakeAws({ 'cloudwatch get-metric-data': { MetricDataResults: results } });
    const code = await runObservabilityGate({
      gate: 'o2', environment: 'pilot', apiId: API_ID, since: since(nowMs),
      aws, env: ENV, now: () => nowMs, log: silent, json: true, timeoutMs: 0,
    });
    assert.equal(code, EXIT.GATE_FAILED, JSON.stringify(results));
    assert.equal(aws.called('cloudwatch', 'describe-alarms'), false);
  }
});

test('NEGATIVE: an alarm in ALARM blocks O2 even with traffic', async () => {
  const nowMs = Date.parse('2026-07-28T12:00:00Z');
  const alarms = {
    MetricAlarms: names.alarms.map((AlarmName, i) => ({ AlarmName, StateValue: i === 0 ? 'ALARM' : 'OK' })),
    CompositeAlarms: [{ AlarmName: names.compositeAlarm, StateValue: 'ALARM' }],
  };
  const aws = fakeAws({ 'cloudwatch describe-alarms': alarms });
  const code = await runObservabilityGate({
    gate: 'o2', environment: 'pilot', apiId: API_ID, since: since(nowMs),
    aws, env: ENV, now: () => nowMs, log: silent, json: true,
    timeoutMs: O2_MAX_POLL_MS, // budget remaining — it must still decide now
  });
  assert.equal(code, EXIT.GATE_FAILED);
  assert.equal(aws.calls.filter((a) => a[1] === 'get-metric-data').length, 1, 'it must not keep polling after ALARM');
});

test('NEGATIVE: INSUFFICIENT_DATA at the deadline blocks', async () => {
  const nowMs = Date.parse('2026-07-28T12:00:00Z');
  const aws = fakeAws({
    'cloudwatch describe-alarms': {
      MetricAlarms: names.alarms.map((AlarmName, i) => ({ AlarmName, StateValue: i === 0 ? 'INSUFFICIENT_DATA' : 'OK' })),
      CompositeAlarms: [{ AlarmName: names.compositeAlarm, StateValue: 'OK' }],
    },
  });
  const code = await runObservabilityGate({
    gate: 'o2', environment: 'pilot', apiId: API_ID, since: since(nowMs),
    aws, env: ENV, now: () => nowMs, log: silent, json: true, timeoutMs: 0,
  });
  assert.equal(code, EXIT.GATE_FAILED);
});

test('O2 polls again when a transient INSUFFICIENT_DATA settles before the deadline', async () => {
  const start = Date.parse('2026-07-28T12:00:00Z');
  let clock = start;
  let round = 0;
  const aws = fakeAws({
    'cloudwatch describe-alarms': () => {
      round += 1;
      return {
        MetricAlarms: names.alarms.map((AlarmName, i) => ({
          AlarmName,
          StateValue: round === 1 && i === 0 ? 'INSUFFICIENT_DATA' : 'OK',
        })),
        CompositeAlarms: [{ AlarmName: names.compositeAlarm, StateValue: 'OK' }],
      };
    },
  });
  const code = await runObservabilityGate({
    gate: 'o2', environment: 'pilot', apiId: API_ID, since: new Date(start - 60_000).toISOString(),
    aws, env: ENV, log: silent, json: true,
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
    timeoutMs: O2_MAX_POLL_MS,
    intervalMs: 30_000,
  });
  assert.equal(code, EXIT.OK);
  assert.equal(round, 2, 'it must have polled a second time');
});

test('NEGATIVE: O2 refuses a stale smoke window before making any metric call', async () => {
  const nowMs = Date.parse('2026-07-28T12:00:00Z');
  const aws = fakeAws();
  const code = await runObservabilityGate({
    gate: 'o2', environment: 'pilot', apiId: API_ID,
    since: new Date(nowMs - O2_MAX_WINDOW_AGE_MS - 60_000).toISOString(),
    aws, env: ENV, now: () => nowMs, log: silent, json: true,
  });
  assert.equal(code, EXIT.GATE_FAILED);
  assert.equal(aws.called('cloudwatch', 'get-metric-data'), false, 'it must refuse before querying');
});

test('NEGATIVE: O2 refuses without a window or an API id, and never calls AWS', async () => {
  for (const opts of [
    { apiId: API_ID },                                     // no --since
    { since: new Date().toISOString() },                   // no --api-id
  ]) {
    const aws = fakeAws();
    const code = await runObservabilityGate({ gate: 'o2', environment: 'pilot', aws, env: ENV, log: silent, ...opts });
    assert.equal(code, EXIT.USAGE);
    assert.equal(aws.calls.length, 0, 'a usage refusal must not reach AWS');
  }
});

test('O2 reads metrics and alarm states only', async () => {
  const nowMs = Date.parse('2026-07-28T12:00:00Z');
  const aws = fakeAws();
  await runObservabilityGate({
    gate: 'o2', environment: 'pilot', apiId: API_ID, since: since(nowMs),
    aws, env: ENV, now: () => nowMs, log: silent, json: true,
  });
  const used = new Set(aws.calls.map((a) => `${a[0]} ${a[1]}`));
  assert.deepEqual([...used].sort(), [
    'cloudwatch describe-alarms',
    'cloudwatch get-metric-data',
    'sts get-caller-identity',
  ]);
});

test('the metric query is bounded by the declared window', async () => {
  const nowMs = Date.parse('2026-07-28T12:00:00Z');
  const startIso = since(nowMs, 120_000);
  const aws = fakeAws();
  await runObservabilityGate({
    gate: 'o2', environment: 'pilot', apiId: API_ID, since: startIso,
    aws, env: ENV, now: () => nowMs, log: silent, json: true,
  });
  const call = aws.calls.find((a) => a[1] === 'get-metric-data');
  assert.equal(call[call.indexOf('--start-time') + 1], startIso);
  assert.equal(call[call.indexOf('--end-time') + 1], new Date(nowMs).toISOString());
});

/* ============================ wall-clock bounds ============================================== */

test('every AWS call is bounded at the CLI level as well as the process level', () => {
  const args = withCliBounds(['cloudwatch', 'describe-alarms']);
  // Both are configurable to zero — "block indefinitely" — so a gate that inherits an operator's
  // config has no wall-clock bound at all, whatever its own deadline says.
  assert.equal(args[args.indexOf('--cli-connect-timeout') + 1], '5');
  assert.equal(args[args.indexOf('--cli-read-timeout') + 1], '30');
  // The pager waits for a terminal CI does not have.
  assert.ok(args.includes('--no-cli-pager'));
  assert.ok(Number.isFinite(AWS_CALL_TIMEOUT_MS) && AWS_CALL_TIMEOUT_MS > 0);
});

test('a slow call cannot buy the loop another round past the deadline', async () => {
  // The deadline used to be judged BEFORE the remote calls, so a round that began just inside the
  // budget and then spent minutes in a slow call was still treated as having budget left.
  const start = Date.parse('2026-07-28T12:00:00Z');
  let clock = start;
  let rounds = 0;
  const aws = fakeAws({
    'cloudwatch get-metric-data': () => {
      rounds += 1;
      clock += 9 * 60_000; // the call itself burns most of the budget
      return { MetricDataResults: [completeResult('api', []), completeResult('lambda', [])] };
    },
  });
  const slept = [];
  const code = await runObservabilityGate({
    gate: 'o2', environment: 'pilot', apiId: API_ID, since: new Date(start - 60_000).toISOString(),
    aws, env: ENV, log: silent, json: true,
    now: () => clock,
    sleep: async (ms) => { slept.push(ms); clock += ms; },
    timeoutMs: O2_MAX_POLL_MS,
    intervalMs: 30_000,
  });
  assert.equal(code, EXIT.GATE_FAILED);
  assert.equal(rounds, 2, 'the second round must observe the deadline the slow call crossed');
  // And no sleep may run past the remaining budget.
  for (const ms of slept) assert.ok(ms <= O2_MAX_POLL_MS, `slept ${ms}ms`);
  assert.ok(clock - start <= O2_MAX_POLL_MS + 9 * 60_000 + 1, 'the run must not exceed one over-long call plus the budget');
});

test('the loop never sleeps past the remaining budget', async () => {
  const start = Date.parse('2026-07-28T12:00:00Z');
  let clock = start;
  const slept = [];
  await runObservabilityGate({
    gate: 'o2', environment: 'pilot', apiId: API_ID, since: new Date(start - 60_000).toISOString(),
    aws: fakeAws({
      'cloudwatch get-metric-data': { MetricDataResults: [completeResult('api', []), completeResult('lambda', [])] },
    }),
    env: ENV, log: silent, json: true,
    now: () => clock,
    sleep: async (ms) => { slept.push(ms); clock += ms; },
    timeoutMs: 45_000,      // budget shorter than one interval
    intervalMs: 30_000,
  });
  assert.deepEqual(slept, [30_000, 15_000], 'the last sleep must be trimmed to the remaining budget');
  assert.equal(clock - start, 45_000);
});

test('a hanging or un-spawnable invoker fails closed rather than passing', async () => {
  const nowMs = Date.parse('2026-07-28T12:00:00Z');
  // What `defaultAws` reports when spawnSync kills the process on timeout, or cannot start it.
  for (const result of [
    { code: 1, stdout: '', stderr: 'aws terminated by SIGKILL' },
    { code: 1, stdout: '', stderr: 'spawnSync aws ENOENT' },
  ]) {
    const aws = (args) => (args[0] === 'sts' ? DEFAULTS_INVOKER(args) : result);
    const code = await runObservabilityGate({
      gate: 'o1', environment: 'pilot', aws, env: ENV, now: () => nowMs, log: silent, json: true,
    });
    assert.equal(code, EXIT.GATE_FAILED, JSON.stringify(result));
  }
});

const DEFAULTS_INVOKER = fakeAws();

/* ============================ output hygiene ================================================= */

test('a verdict carrying a physical identifier is refused, not printed', () => {
  for (const leak of [
    { gate: 'O1', detail: `arn:aws:sns:us-east-2:${ACCOUNT}:cba-study-coach-pilot-operational-alerts` },
    { gate: 'O1', detail: `account ${ACCOUNT}` },
    { gate: 'O2', detail: 'https://abc123.execute-api.us-east-2.amazonaws.com' },
  ]) {
    assert.throws(() => assertLogicalOnly(leak), (e) => e instanceof GateError && e.code.startsWith('OUTPUT_CONTAINS_'));
  }
  assert.doesNotThrow(() => assertLogicalOnly({ gate: 'O1', detail: 'cba-study-coach-pilot-api-5xx is OK' }));
});

test('no gate output contains an ARN, account id, endpoint or API id', async () => {
  const nowMs = Date.parse('2026-07-28T12:00:00Z');
  for (const opts of [
    { gate: 'o1' },
    { gate: 'o2', apiId: API_ID, since: since(nowMs) },
  ]) {
    const lines = [];
    await runObservabilityGate({
      environment: 'pilot', aws: fakeAws(), env: ENV, now: () => nowMs,
      log: (s) => lines.push(String(s)), json: true, ...opts,
    });
    const text = lines.join('\n');
    assert.ok(text.length > 0, `${opts.gate} produced output`);
    assert.equal(/\barn:/i.test(text), false, `${opts.gate} must not print an ARN`);
    assert.equal(new RegExp(`\\b${ACCOUNT}\\b`).test(text), false, `${opts.gate} must not print the account id`);
    assert.equal(/https?:\/\//.test(text), false, `${opts.gate} must not print an endpoint`);
    // The API id reaches the metric dimension and must stop there.
    assert.equal(text.includes(API_ID), false, `${opts.gate} must not print the API id`);
  }
});

test('the O1 verdict names resources logically, so #70 can act on it', async () => {
  const lines = [];
  await runObservabilityGate({
    gate: 'o1', environment: 'pilot', aws: fakeAws(), env: ENV, log: (s) => lines.push(String(s)), json: true,
  });
  const verdict = JSON.parse(lines.join('\n'));
  assert.equal(verdict.gate, 'O1');
  assert.equal(verdict.ok, true);
  assert.ok(verdict.checks.some((c) => c.id === 'composite-alarm'));
  assert.ok(verdict.checks.some((c) => c.id === 'notification-subscription'));
});
