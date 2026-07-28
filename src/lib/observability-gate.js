// Release gates O1 and O2 (#82 Slice C) — the pure decision layer.
//
// Everything here is a total function over observations. No AWS call, no clock, no process exit:
// the command layer collects observations and this module decides. That split is what lets the
// negative controls be real — "traffic was never observed" and "the alarm is in ALARM" are ordinary
// inputs here, so a test can prove the gate blocks without any live deployment.
//
// TWO RULES SHAPE ALL OF IT:
//
// 1. FAIL CLOSED. An observation that is missing, malformed, unparseable or simply unknown is a
//    failure, never a pass. A release gate that treats "I could not tell" as "fine" is worse than
//    no gate, because it manufactures confidence.
// 2. LOGICAL OUTPUT ONLY. Verdicts carry names and states — never ARNs, account ids, endpoints,
//    metric dimensions, request counts or log content. The gate reports whether traffic was
//    OBSERVED, never how much: a request count is learner activity, and release evidence is not a
//    place to accumulate it.

/** Environments this gate will evaluate. Anything else fails closed rather than guessing a base. */
export const ENVIRONMENTS = ['dev', 'pilot'];

/** Retention the baseline pins per environment (§5). A drifted retention is a real finding. */
export const EXPECTED_RETENTION_DAYS = { dev: 7, pilot: 30 };

/** The six native alarms, by logical suffix. Order is irrelevant; membership is exact. */
export const ALARM_SUFFIXES = [
  'api-5xx',
  'lambda-errors',
  'lambda-throttles',
  'lambda-p95-duration',
  'dynamodb-system-errors',
  'dynamodb-throttling',
];

/** The five saved queries, by logical suffix. */
export const QUERY_SUFFIXES = [
  '1-recent-server-failures',
  '2-errors-by-code-and-route',
  '3-latency-percentiles-by-route',
  '4-lambda-timeout-and-cold-start',
  '5-api-to-lambda-correlation',
];

/** O2 polls for at most this long before declaring the traffic evidence absent. */
export const O2_MAX_POLL_MS = 10 * 60 * 1000;

/**
 * The furthest back an O2 smoke window may start.
 *
 * Without this, `--since` from a previous release would let YESTERDAY's traffic satisfy today's
 * gate: the metric query would return datapoints, the alarms would read OK, and the gate would pass
 * a deploy that no request ever reached. The window must be anchored to this run, so it may not
 * begin before the poll budget plus a margin for the caller's own setup.
 */
export const O2_MAX_WINDOW_AGE_MS = O2_MAX_POLL_MS + 5 * 60 * 1000;

/**
 * The release barrier: the first whole minute at or after `ms`.
 *
 * The caller waits for this instant before the first smoke, so that CloudWatch's rounding of
 * `StartTime` down to the minute cannot pull earlier traffic into the window. Already-aligned
 * inputs advance to the NEXT minute, because a barrier equal to "right now" gives the previous
 * deployment's in-flight requests the same timestamp bucket.
 */
export function nextMinuteBarrier(ms) {
  return Math.floor(ms / 60_000) * 60_000 + 60_000;
}

/** Alarm states AWS can report. Anything outside this set is unknown, and unknown fails. */
const KNOWN_ALARM_STATES = ['OK', 'ALARM', 'INSUFFICIENT_DATA'];

export class GateError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'GateError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new GateError(code, message);
}

/** Resolve every logical name the gates read. Physical ids are never derived here. */
export function resourceNames(environment) {
  if (!ENVIRONMENTS.includes(environment)) {
    fail('ENVIRONMENT_UNSUPPORTED', `environment must be one of ${ENVIRONMENTS.join('|')}; got "${String(environment)}"`);
  }
  const base = `cba-study-coach-${environment}`;
  return {
    environment,
    base,
    applicationLogGroup: `/aws/lambda/${base}-bff`,
    accessLogGroup: `/aws/apigateway/${base}-bff`,
    dashboard: `${base}-operational`,
    topic: `${base}-operational-alerts`,
    compositeAlarm: `${base}-operational-health`,
    alarms: ALARM_SUFFIXES.map((s) => `${base}-${s}`),
    queries: QUERY_SUFFIXES.map((s) => `${base}/${s}`),
    retentionDays: EXPECTED_RETENTION_DAYS[environment],
  };
}

/* ============================ redaction ====================================================== */

const ARN_RE = /\barn:[a-z0-9-]*:/i;
const ACCOUNT_RE = /\b\d{12}\b/;
const URL_RE = /\bhttps?:\/\//i;

/**
 * Refuse to emit anything that looks like a physical identifier.
 *
 * This runs over the FINAL verdict rather than at each call site, because the failure it prevents is
 * one of accumulation: any single message looks harmless, and the leak appears when a future check
 * interpolates a topic ARN into its detail string. Called on the way out, it cannot be forgotten.
 */
export function assertLogicalOnly(verdict) {
  const text = JSON.stringify(verdict);
  if (ARN_RE.test(text)) fail('OUTPUT_CONTAINS_ARN', 'the gate verdict must not contain an ARN');
  if (ACCOUNT_RE.test(text)) fail('OUTPUT_CONTAINS_ACCOUNT_ID', 'the gate verdict must not contain an account id');
  if (URL_RE.test(text)) fail('OUTPUT_CONTAINS_URL', 'the gate verdict must not contain an endpoint');
  return verdict;
}

/* ============================ O1: structural ================================================= */

const check = (id, ok, detail) => ({ id, ok, detail });

/**
 * O1 — the resources the notification path depends on exist, and are shaped as reviewed.
 *
 * `observed` is what the command layer read through the gate role's read-only permissions:
 *   logGroups           [{ name, retentionDays }]
 *   queryDefinitionNames [string]
 *   dashboardExists     boolean
 *   topicExists         boolean
 *   alarms              [{ name, treatMissingData, type }]
 *   subscriptions       [{ confirmed: boolean }]  — pilot only; dev may omit it
 *
 * WHAT O1 DELIBERATELY DOES NOT CHECK: the baseline also lists "structured logging and the
 * access-log allowlist are configured". The read-only gate role holds no `lambda:GetFunctionConfiguration`
 * and no `apigateway:GET`, and widening it for a gate check would trade a much larger standing
 * permission for a property that is already pinned at synth time by the ApiStack tests. That check
 * therefore stays offline, and O1 verifies the log GROUPS — existence and retention — which is what
 * the role can actually see. See baseline §15.
 */
export function evaluateO1(observed = {}, environment) {
  const names = resourceNames(environment);
  const checks = [];

  // --- log groups: present, and with the retention the baseline pins ---
  const groups = Array.isArray(observed.logGroups) ? observed.logGroups : null;
  if (!groups) {
    checks.push(check('log-groups', false, 'log group observations are missing'));
  } else {
    for (const [label, expectedName] of [
      ['application', names.applicationLogGroup],
      ['access', names.accessLogGroup],
    ]) {
      const found = groups.find((g) => g && g.name === expectedName);
      if (!found) {
        checks.push(check(`log-group-${label}`, false, `${expectedName} does not exist`));
      } else if (found.retentionDays !== names.retentionDays) {
        // `undefined` here is the never-expiring default, which the baseline forbids outright.
        const actual = found.retentionDays === undefined || found.retentionDays === null
          ? 'never expires'
          : `${found.retentionDays} days`;
        checks.push(check(
          `log-group-${label}`,
          false,
          `${expectedName} retention is ${actual}, expected ${names.retentionDays} days`,
        ));
      } else {
        checks.push(check(`log-group-${label}`, true, `${expectedName} at ${names.retentionDays} days`));
      }
    }
  }

  // --- dashboard and saved queries ---
  checks.push(check('dashboard', observed.dashboardExists === true, observed.dashboardExists === true
    ? `${names.dashboard} exists`
    : `${names.dashboard} does not exist`));

  const queryNames = Array.isArray(observed.queryDefinitionNames) ? observed.queryDefinitionNames : null;
  if (!queryNames) {
    checks.push(check('saved-queries', false, 'saved-query observations are missing'));
  } else {
    const missing = names.queries.filter((q) => !queryNames.includes(q));
    checks.push(check('saved-queries', missing.length === 0, missing.length === 0
      ? `all ${names.queries.length} saved queries exist`
      : `missing saved queries: ${missing.join(', ')}`));
  }

  // --- topic ---
  checks.push(check('alert-topic', observed.topicExists === true, observed.topicExists === true
    ? `${names.topic} exists`
    : `${names.topic} does not exist`));

  // --- alarms: the exact set, the composite, and the missing-data posture ---
  const alarms = Array.isArray(observed.alarms) ? observed.alarms : null;
  if (!alarms) {
    checks.push(check('alarm-set', false, 'alarm observations are missing'));
    checks.push(check('composite-alarm', false, 'alarm observations are missing'));
    checks.push(check('treat-missing-data', false, 'alarm observations are missing'));
  } else {
    const byName = new Map(alarms.filter((a) => a && typeof a.name === 'string').map((a) => [a.name, a]));

    // The RESOURCE TYPE is part of the check, not decoration. A metric alarm named
    // `…-operational-health` satisfies a name-only test while the aggregation and the
    // sole-notification topology are simply absent — the composite is what carries the SNS action,
    // so without it nothing pages at all and O1 would still be green.
    const missing = names.alarms.filter((n) => !byName.has(n));
    const wrongType = names.alarms
      .map((n) => byName.get(n))
      .filter(Boolean)
      .filter((a) => a.type !== 'MetricAlarm')
      .map((a) => `${a.name}=${a.type ?? 'unknown'}`);
    checks.push(check('alarm-set', missing.length === 0 && wrongType.length === 0,
      missing.length
        ? `missing alarms: ${missing.join(', ')}`
        : wrongType.length
          ? `wrong resource type: ${wrongType.join(', ')}`
          : `all ${names.alarms.length} native alarms exist as metric alarms`));

    const composite = byName.get(names.compositeAlarm);
    const compositeOk = Boolean(composite) && composite.type === 'CompositeAlarm';
    checks.push(check('composite-alarm', compositeOk,
      !composite
        ? `${names.compositeAlarm} does not exist`
        : compositeOk
          ? `${names.compositeAlarm} exists as a composite alarm`
          : `${names.compositeAlarm} is a ${composite.type ?? 'unknown'}, not a CompositeAlarm`));

    // Only the native alarms carry TreatMissingData; a composite has no such attribute.
    const wrongPosture = names.alarms
      .map((n) => byName.get(n))
      .filter(Boolean)
      .filter((a) => String(a.treatMissingData).toLowerCase() !== 'notbreaching')
      .map((a) => `${a.name}=${a.treatMissingData ?? 'unset'}`);
    const posturePossible = missing.length === 0;
    checks.push(check('treat-missing-data', posturePossible && wrongPosture.length === 0,
      !posturePossible
        ? 'cannot verify the missing-data posture while alarms are missing'
        : wrongPosture.length === 0
          ? 'every native alarm treats missing data as notBreaching'
          : `wrong missing-data posture: ${wrongPosture.join(', ')}`));
  }

  // --- pilot must have a confirmed subscription; without one the topic pages nobody ---
  if (environment === 'pilot') {
    const subs = Array.isArray(observed.subscriptions) ? observed.subscriptions : null;
    if (!subs) {
      checks.push(check('notification-subscription', false, 'subscription observations are missing'));
    } else {
      const confirmed = subs.filter((s) => s && s.confirmed === true).length;
      checks.push(check('notification-subscription', confirmed > 0, confirmed > 0
        ? `${confirmed} confirmed subscription(s)`
        : 'no confirmed subscription — alarms would page nobody'));
    }
  }

  return assertLogicalOnly({
    gate: 'O1',
    environment,
    ok: checks.every((c) => c.ok),
    checks,
  });
}

/* ============================ O2: deployed telemetry ========================================= */

/**
 * Validate the bounded smoke window before it is ever used to query metrics.
 *
 * Three bounds, three different failures.
 *
 * MINUTE ALIGNMENT is the subtle one, and passing the timestamp to CloudWatch does not achieve it.
 * `GetMetricData` ROUNDS `StartTime` DOWN to the whole minute, so a window declared at 12:32:34
 * is actually queried from 12:32:00. A request that reached the PREVIOUS deployment at 12:32:10
 * then lands inside the window: both traffic checks are satisfied, every alarm is `OK`, and O2
 * promotes a release the smokes never reached. The gate cannot detect that after the fact — the
 * datapoint is indistinguishable from a legitimate one — so the window must be aligned before the
 * smokes run. The caller waits for the next whole minute, records that instant as the release
 * barrier, and only then starts the first smoke; a start that is not minute-aligned is refused
 * rather than quietly widened by the rounding.
 */
export function assertSmokeWindow({ startMs, nowMs }) {
  if (!Number.isFinite(startMs)) fail('WINDOW_START_INVALID', 'the smoke-window start is not a valid timestamp');
  if (!Number.isFinite(nowMs)) fail('WINDOW_NOW_INVALID', 'the current time is not a valid timestamp');
  if (startMs > nowMs) fail('WINDOW_IN_FUTURE', 'the smoke-window start is in the future');
  if (startMs % 60_000 !== 0) {
    fail(
      'WINDOW_NOT_MINUTE_ALIGNED',
      `the smoke window must start on a whole minute; got ${new Date(startMs).toISOString()}. `
      + 'CloudWatch rounds StartTime down to the minute, so an unaligned window silently includes '
      + `traffic from before it — use ${new Date(nextMinuteBarrier(startMs)).toISOString()}, wait for `
      + 'that instant, and only then start the first smoke.',
    );
  }
  const age = nowMs - startMs;
  if (age > O2_MAX_WINDOW_AGE_MS) {
    fail(
      'WINDOW_STALE',
      `the smoke window began ${Math.round(age / 60000)} minutes ago; O2 evidence must be anchored to this run `
      + `(max ${Math.round(O2_MAX_WINDOW_AGE_MS / 60000)} minutes). Capture the window immediately before the first smoke.`,
    );
  }
  return { startMs, nowMs, ageMs: age };
}

/**
 * Did the bounded window contain the minimum traffic evidence?
 *
 * `sums` is `{ apiCount, lambdaInvocations }` — the SUM statistic over the window. Both must be at
 * least one. The numbers do not leave this function: the verdict says observed or not.
 */
export function evaluateTrafficEvidence(sums = {}) {
  const read = (v) => (Number.isFinite(v) ? v : null);
  const apiCount = read(sums.apiCount);
  const lambdaInvocations = read(sums.lambdaInvocations);

  const apiOk = apiCount !== null && apiCount >= 1;
  const lambdaOk = lambdaInvocations !== null && lambdaInvocations >= 1;

  return {
    observed: apiOk && lambdaOk,
    api: apiOk,
    lambda: lambdaOk,
    // Deliberately no counts: a request count is learner activity, and this value is written into
    // release evidence that outlives the run.
    detail: apiOk && lambdaOk
      ? 'requests reached the deployed API and Lambda'
      : `no telemetry from ${[!apiOk && 'the API', !lambdaOk && 'the Lambda'].filter(Boolean).join(' or ')}`,
  };
}

/**
 * Classify the alarm states. Returns the verdict AND whether it must block immediately.
 *
 * The distinction matters: `ALARM` is a decision — the deployment is unhealthy now, and waiting out
 * the remaining poll budget only delays the same answer. `INSUFFICIENT_DATA` may still resolve as
 * metrics arrive, so it blocks only at the deadline.
 */
export function evaluateAlarmStates(observedAlarms, environment) {
  const names = resourceNames(environment);
  const required = [...names.alarms, names.compositeAlarm];
  const list = Array.isArray(observedAlarms) ? observedAlarms : null;
  if (!list) {
    return { ok: false, blocking: true, states: [], detail: 'alarm-state observations are missing' };
  }

  const byName = new Map(list.filter((a) => a && typeof a.name === 'string').map((a) => [a.name, a]));
  const states = required.map((name) => {
    const found = byName.get(name);
    const state = found && KNOWN_ALARM_STATES.includes(found.state) ? found.state : 'UNKNOWN';
    return { name, state };
  });

  const inAlarm = states.filter((s) => s.state === 'ALARM');
  const unknown = states.filter((s) => s.state === 'UNKNOWN');
  const notOk = states.filter((s) => s.state !== 'OK');

  if (inAlarm.length) {
    return {
      ok: false,
      blocking: true, // decided: no amount of further polling makes an ALARM acceptable
      states,
      detail: `in ALARM: ${inAlarm.map((s) => s.name).join(', ')}`,
    };
  }
  if (unknown.length) {
    // A required alarm that is absent, or reporting a state this gate does not recognise, is not a
    // "wait and see": it means the gate cannot see what it was built to see.
    return {
      ok: false,
      blocking: true,
      states,
      detail: `missing or unrecognised alarm state: ${unknown.map((s) => s.name).join(', ')}`,
    };
  }
  return {
    ok: notOk.length === 0,
    blocking: false, // only INSUFFICIENT_DATA remains, which may still settle before the deadline
    states,
    detail: notOk.length === 0
      ? `all ${states.length} alarms OK`
      : `not OK: ${notOk.map((s) => `${s.name}=${s.state}`).join(', ')}`,
  };
}

/**
 * O2 — one poll round. Returns `{ done, verdict }`; the caller loops while `done` is false.
 *
 * The ORDER is the control. Traffic evidence is evaluated first and gates everything after it, so a
 * deployment that no request ever reached can never be waved through by alarms that are quietly OK
 * because nothing has happened yet. `TreatMissingData=notBreaching` is what makes that failure mode
 * plausible rather than theoretical: with no traffic every alarm reads OK.
 */
export function evaluateO2Round({ traffic, alarms, environment, deadlineReached }) {
  const evidence = evaluateTrafficEvidence(traffic);

  if (!evidence.observed) {
    if (!deadlineReached) return { done: false, verdict: null };
    return {
      done: true,
      verdict: assertLogicalOnly({
        gate: 'O2',
        environment,
        ok: false,
        trafficObserved: false,
        reason: 'TRAFFIC_EVIDENCE_ABSENT',
        detail: `${evidence.detail} within the bounded smoke window`,
        alarms: [],
        note: O2_SCOPE_NOTE,
      }),
    };
  }

  const alarmVerdict = evaluateAlarmStates(alarms, environment);

  if (alarmVerdict.ok) {
    return {
      done: true,
      verdict: assertLogicalOnly({
        gate: 'O2',
        environment,
        ok: true,
        trafficObserved: true,
        reason: 'HEALTHY',
        detail: alarmVerdict.detail,
        alarms: alarmVerdict.states,
        note: O2_SCOPE_NOTE,
      }),
    };
  }

  if (!alarmVerdict.blocking && !deadlineReached) return { done: false, verdict: null };

  return {
    done: true,
    verdict: assertLogicalOnly({
      gate: 'O2',
      environment,
      ok: false,
      trafficObserved: true,
      reason: alarmVerdict.blocking ? 'ALARM_STATE_BLOCKING' : 'ALARM_STATE_NOT_OK_AT_DEADLINE',
      detail: alarmVerdict.detail,
      alarms: alarmVerdict.states,
      note: O2_SCOPE_NOTE,
    }),
  };
}

/**
 * Carried in every O2 verdict, including the passing one.
 *
 * A green O2 is exactly the kind of result that gets quoted later as "the release was verified".
 * It was not: `Count >= 1` and `Invocations >= 1` prove that telemetry is flowing from the deployed
 * API and Lambda, not that any particular route works. Attaching the limit to the verdict itself is
 * the only way it survives being copied into a release summary.
 */
export const O2_SCOPE_NOTE =
  'O2 proves telemetry ingestion, not functional route coverage. Traffic evidence shows requests '
  + 'reached the deployed API and Lambda and that metrics are flowing; it does not show that every '
  + 'contract route was exercised. Functional coverage remains the job of the #70 deployed learner '
  + 'smokes, and this verdict must never be read as evidence that the learner loop is correct.';
