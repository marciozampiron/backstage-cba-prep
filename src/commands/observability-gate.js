// `observability-gate` — the #70 release gates O1 and O2 (#82 Slice C).
//
// This layer only COLLECTS. Every verdict is decided by `src/lib/observability-gate.js`, which is a
// pure function over observations, so the negative controls are ordinary unit tests rather than
// something that needs a deployed environment to exercise.
//
// The AWS calls go through the AWS CLI rather than the SDK, matching `bedrock-check`: the root
// package stays dependency-free, and the invoker is injectable so no test ever reaches a remote.
//
// PERMISSIONS. Every call below is inside the read-only gate role's surface (baseline §15):
// logs:DescribeLogGroups, logs:DescribeQueryDefinitions, cloudwatch:GetDashboard,
// cloudwatch:DescribeAlarms, cloudwatch:GetMetricData, sns:GetTopicAttributes,
// sns:ListSubscriptionsByTopic. `sts:GetCallerIdentity` is also called, and does NOT widen the role
// — it is not permission-gated by IAM and cannot be denied to any principal. Nothing here writes,
// executes a Logs Insights query, reads log content, mutates an alarm state or touches a
// subscription.
import { spawnSync } from 'node:child_process';
import { c, hr } from '../lib/ui.js';
import {
  ENVIRONMENTS,
  GateError,
  O2_MAX_POLL_MS,
  assertSmokeWindow,
  evaluateO1,
  evaluateO2Round,
  resourceNames,
} from '../lib/observability-gate.js';

export const EXIT = { OK: 0, GATE_FAILED: 1, USAGE: 2 };

const CMD = 'observability-gate';

/** Hard ceiling on any single AWS call, so one hung socket cannot outlive the poll budget. */
export const AWS_CALL_TIMEOUT_MS = 60_000;

/**
 * Bound every call at the CLI level as well as the process level.
 *
 * `--cli-connect-timeout`/`--cli-read-timeout` matter because both are configurable to zero, which
 * means "block indefinitely" — a gate that inherits that from an operator's config has no wall-clock
 * bound at all, whatever its own deadline says. The pager and the auto-prompt are disabled because
 * either will wait for a terminal that CI does not have.
 */
export function withCliBounds(args) {
  return [...args, '--cli-connect-timeout', '5', '--cli-read-timeout', '30', '--no-cli-pager'];
}

/** Default invoker. Injected in tests; never constructed there. */
function defaultAws(args) {
  const res = spawnSync('aws', withCliBounds(args), {
    encoding: 'utf8',
    timeout: AWS_CALL_TIMEOUT_MS,
    killSignal: 'SIGKILL',
    env: { ...process.env, AWS_PAGER: '', AWS_CLI_AUTO_PROMPT: 'off' },
  });
  // A killed or un-spawnable process has no exit status. Reporting it as a plain non-zero exit is
  // right: every caller here treats that as "could not see", which fails closed.
  if (res.error || res.signal) {
    return {
      code: 1,
      stdout: '',
      stderr: res.error ? String(res.error.message) : `aws terminated by ${res.signal}`,
    };
  }
  return {
    code: res.status == null ? 1 : res.status,
    stdout: res.stdout || '',
    stderr: res.stderr || '',
  };
}

function printRefusal(code, message, log) {
  log(`\n  ${c.red('REFUSED')} ${c.bold(CMD)}  ${c.gray(code)}`);
  log(`  ${message}\n`);
}

/**
 * Run one AWS call and parse its JSON.
 *
 * `allowFailure` exists for existence probes — `get-dashboard` on a missing dashboard is a non-zero
 * exit, and that is an ANSWER, not an error. Everything else fails closed: a call that did not
 * succeed leaves the gate unable to see, which is never a pass.
 */
function awsJson(aws, args, { allowFailure = false } = {}) {
  const res = aws([...args, '--output', 'json']);
  if (res.code !== 0) {
    if (allowFailure) return null;
    throw new GateError('AWS_CALL_FAILED', `aws ${args[0]} ${args[1]} failed (exit ${res.code})`);
  }
  if (!res.stdout.trim()) return {};
  try {
    return JSON.parse(res.stdout);
  } catch {
    throw new GateError('AWS_OUTPUT_UNPARSEABLE', `aws ${args[0]} ${args[1]} returned output this gate cannot parse`);
  }
}

/**
 * Resolve the partition, account and region needed to address the SNS topic.
 *
 * These are physical identifiers. They are held in memory to build one ARN and are never written to
 * the verdict, the summary or any log line — `assertLogicalOnly` refuses a verdict containing them.
 */
function resolveCallerContext(aws, env) {
  const identity = awsJson(aws, ['sts', 'get-caller-identity']);
  const account = identity && identity.Account;
  const arn = identity && identity.Arn;
  if (!account || !arn) throw new GateError('CALLER_IDENTITY_UNAVAILABLE', 'could not resolve the calling identity');
  const partition = String(arn).split(':')[1] || 'aws';
  const region = env.AWS_REGION || env.AWS_DEFAULT_REGION;
  if (!region) {
    throw new GateError('REGION_UNSET', 'set AWS_REGION so the gate can address environment resources');
  }
  return { account, partition, region };
}

const topicArn = (ctx, name) => `arn:${ctx.partition}:sns:${ctx.region}:${ctx.account}:${name}`;

/* ============================ O1 collection ================================================== */

function collectO1(aws, names, ctx, environment) {
  const observed = {};

  const logGroups = [];
  for (const name of [names.applicationLogGroup, names.accessLogGroup]) {
    const out = awsJson(aws, ['logs', 'describe-log-groups', '--log-group-name-prefix', name]);
    const match = (out.logGroups || []).find((g) => g.logGroupName === name);
    if (match) logGroups.push({ name, retentionDays: match.retentionInDays });
  }
  observed.logGroups = logGroups;

  const queries = awsJson(aws, [
    'logs', 'describe-query-definitions',
    '--query-definition-name-prefix', `${names.base}/`,
  ]);
  observed.queryDefinitionNames = (queries.queryDefinitions || []).map((q) => q.name);

  // A missing dashboard exits non-zero; that is the observation, not a collection failure.
  const dashboard = awsJson(aws, ['cloudwatch', 'get-dashboard', '--dashboard-name', names.dashboard], { allowFailure: true });
  observed.dashboardExists = dashboard !== null;

  const arn = topicArn(ctx, names.topic);
  const topic = awsJson(aws, ['sns', 'get-topic-attributes', '--topic-arn', arn], { allowFailure: true });
  observed.topicExists = topic !== null;

  const alarms = awsJson(aws, [
    'cloudwatch', 'describe-alarms',
    '--alarm-names', ...names.alarms, names.compositeAlarm,
    '--alarm-types', 'MetricAlarm', 'CompositeAlarm',
  ]);
  observed.alarms = [
    ...(alarms.MetricAlarms || []).map((a) => ({
      name: a.AlarmName,
      treatMissingData: a.TreatMissingData,
      type: 'MetricAlarm',
    })),
    ...(alarms.CompositeAlarms || []).map((a) => ({ name: a.AlarmName, type: 'CompositeAlarm' })),
  ];

  if (environment === 'pilot') {
    // Only pilot must page a human. Without a CONFIRMED subscription the topic is a black hole:
    // every policy can be correct and the notification still reaches nobody.
    const subs = awsJson(aws, ['sns', 'list-subscriptions-by-topic', '--topic-arn', arn], { allowFailure: true });
    observed.subscriptions = subs === null
      ? null
      : (subs.Subscriptions || []).map((s) => ({
        confirmed: typeof s.SubscriptionArn === 'string' && s.SubscriptionArn.startsWith('arn:'),
      }));
  }

  return observed;
}

/* ============================ O2 collection ================================================== */

/**
 * Sum `Count` for the HTTP API and `Invocations` for the BFF Lambda over the bounded window.
 *
 * The API id is not derivable from the environment name and the gate role cannot read it (no
 * `apigateway:GET`, deliberately), so #70 supplies it from its own deploy output. It is a physical
 * identifier: it is used to build the metric dimension and never appears in the verdict.
 */
function collectTraffic(aws, { apiId, functionName, startIso, endIso }) {
  const queries = [
    {
      Id: 'api',
      MetricStat: {
        Metric: { Namespace: 'AWS/ApiGateway', MetricName: 'Count', Dimensions: [{ Name: 'ApiId', Value: apiId }] },
        Period: 60,
        Stat: 'Sum',
      },
      ReturnData: true,
    },
    {
      Id: 'lambda',
      MetricStat: {
        Metric: { Namespace: 'AWS/Lambda', MetricName: 'Invocations', Dimensions: [{ Name: 'FunctionName', Value: functionName }] },
        Period: 60,
        Stat: 'Sum',
      },
      ReturnData: true,
    },
  ];

  const out = awsJson(aws, [
    'cloudwatch', 'get-metric-data',
    '--metric-data-queries', JSON.stringify(queries),
    '--start-time', startIso,
    '--end-time', endIso,
  ]);

  return {
    apiCount: readMetricSum(out, 'api'),
    lambdaInvocations: readMetricSum(out, 'lambda'),
  };
}

/**
 * Read one metric's sum, refusing anything that is not a complete answer.
 *
 * `MetricDataResult` carries a `StatusCode`, and a `PartialData` or `InternalError` result STILL
 * CARRIES VALUES. Summing those values is how a gate reports healthy traffic from a response that
 * told it the data was incomplete — the numbers look ordinary and nothing in the verdict hints that
 * CloudWatch qualified them. Any status other than `Complete`, any message at either level, a
 * residual `NextToken`, a duplicated or missing id, or a value that is not a finite non-negative
 * number is a refusal, not a smaller number.
 */
export function readMetricSum(out, id) {
  if (!out || typeof out !== 'object') {
    throw new GateError('METRIC_RESPONSE_INVALID', 'the metric response could not be read');
  }
  if (Array.isArray(out.Messages) && out.Messages.length) {
    // Global messages describe the QUERY, e.g. MaxMetricsExceeded — the results may be truncated.
    throw new GateError('METRIC_RESPONSE_MESSAGES', 'the metric response carried query-level messages, so the results may be incomplete');
  }
  if (out.NextToken) {
    throw new GateError('METRIC_RESPONSE_PAGINATED', 'the metric response was paginated, so the sums this gate computed would be partial');
  }

  const results = (Array.isArray(out.MetricDataResults) ? out.MetricDataResults : []).filter((r) => r && r.Id === id);
  if (results.length === 0) throw new GateError('METRIC_RESULT_MISSING', `the metric response contained no result for "${id}"`);
  if (results.length > 1) throw new GateError('METRIC_RESULT_DUPLICATED', `the metric response contained ${results.length} results for "${id}"`);

  const [result] = results;
  if (result.StatusCode !== 'Complete') {
    throw new GateError(
      'METRIC_RESULT_INCOMPLETE',
      `the "${id}" metric result reported StatusCode=${result.StatusCode ?? 'unset'}; only Complete is evidence`,
    );
  }
  if (Array.isArray(result.Messages) && result.Messages.length) {
    throw new GateError('METRIC_RESULT_MESSAGES', `the "${id}" metric result carried messages, so its values are qualified`);
  }
  if (!Array.isArray(result.Values)) {
    throw new GateError('METRIC_RESULT_MALFORMED', `the "${id}" metric result carried no values array`);
  }
  if (result.Timestamps !== undefined) {
    if (!Array.isArray(result.Timestamps) || result.Timestamps.length !== result.Values.length) {
      throw new GateError('METRIC_RESULT_MALFORMED', `the "${id}" metric result has mismatched timestamps and values`);
    }
    for (const t of result.Timestamps) {
      const parsed = typeof t === 'number' ? t * 1000 : Date.parse(String(t));
      if (!Number.isFinite(parsed)) {
        throw new GateError('METRIC_RESULT_MALFORMED', `the "${id}" metric result has an unparseable timestamp`);
      }
    }
  }

  let total = 0;
  for (const v of result.Values) {
    if (!Number.isFinite(v) || v < 0) {
      throw new GateError('METRIC_RESULT_MALFORMED', `the "${id}" metric result has a value this gate will not sum`);
    }
    total += v;
  }
  return total;
}

function collectAlarmStates(aws, names) {
  const out = awsJson(aws, [
    'cloudwatch', 'describe-alarms',
    '--alarm-names', ...names.alarms, names.compositeAlarm,
    '--alarm-types', 'MetricAlarm', 'CompositeAlarm',
  ]);
  return [
    ...(out.MetricAlarms || []).map((a) => ({ name: a.AlarmName, state: a.StateValue })),
    ...(out.CompositeAlarms || []).map((a) => ({ name: a.AlarmName, state: a.StateValue })),
  ];
}

/* ============================ printing ======================================================= */

function printVerdict(verdict, log) {
  const head = verdict.ok ? c.green(`${verdict.gate} PASSED`) : c.red(`${verdict.gate} BLOCKED`);
  log(`\n  ${head}  ${c.gray(verdict.environment)}`);
  log(hr());
  for (const item of verdict.checks || []) {
    log(`  ${item.ok ? c.green('✓') : c.red('✗')} ${item.id.padEnd(26)} ${c.gray(item.detail)}`);
  }
  if (verdict.gate === 'O2') {
    log(`  ${verdict.trafficObserved ? c.green('✓') : c.red('✗')} ${'traffic-evidence'.padEnd(26)} ${c.gray(verdict.detail)}`);
    for (const a of verdict.alarms || []) {
      log(`  ${a.state === 'OK' ? c.green('✓') : c.red('✗')} ${a.name.padEnd(40)} ${c.gray(a.state)}`);
    }
  }
  log(hr());
  if (verdict.note) log(`  ${c.yellow('note')} ${c.gray(verdict.note)}`);
  log('');
}

/* ============================ entry point ==================================================== */

export async function runObservabilityGate(opts = {}) {
  const log = opts.log || console.log;
  const env = opts.env || process.env;
  const aws = opts.aws || defaultAws;
  const now = opts.now || (() => Date.now());
  const sleep = opts.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));

  const gate = String(opts.gate || '').toUpperCase();
  const environment = opts.environment || env.CBA_ENVIRONMENT;

  if (gate !== 'O1' && gate !== 'O2') {
    printRefusal('GATE_UNKNOWN', 'Pass --gate o1 or --gate o2.', log);
    return EXIT.USAGE;
  }
  if (!ENVIRONMENTS.includes(environment)) {
    printRefusal('ENVIRONMENT_UNSUPPORTED', `Pass --environment ${ENVIRONMENTS.join('|')}.`, log);
    return EXIT.USAGE;
  }

  let names;
  try {
    names = resourceNames(environment);
  } catch (err) {
    printRefusal(err.code || 'UNKNOWN', err.message, log);
    return EXIT.USAGE;
  }

  // Every argument is validated BEFORE the first AWS call. A usage mistake must be refused without
  // reaching a remote at all: a gate that contacts AWS to tell you a flag is missing has already
  // done something on the strength of an invocation it was going to reject.
  let apiId;
  let startMs;
  if (gate === 'O2') {
    apiId = opts.apiId || env.CBA_API_ID;
    if (!apiId) {
      printRefusal(
        'API_ID_MISSING',
        'O2 needs --api-id (or CBA_API_ID). The gate role cannot read it, and #70 has it from the deploy. '
        + 'It is used only to build the metric dimension and never appears in the verdict.',
        log,
      );
      return EXIT.USAGE;
    }
    const since = opts.since || env.CBA_SMOKE_WINDOW_START;
    if (!since) {
      printRefusal(
        'SMOKE_WINDOW_MISSING',
        'O2 needs --since <ISO-8601>, captured immediately BEFORE the first smoke. Without a bounded '
        + 'window the gate cannot tell this release\'s traffic from the previous one\'s.',
        log,
      );
      return EXIT.USAGE;
    }
    startMs = Date.parse(since);
    try {
      assertSmokeWindow({ startMs, nowMs: now() });
    } catch (err) {
      printRefusal(err.code || 'WINDOW_INVALID', err.message, log);
      return EXIT.GATE_FAILED;
    }
  }

  try {
    const ctx = resolveCallerContext(aws, env);

    if (gate === 'O1') {
      const observed = collectO1(aws, names, ctx, environment);
      const verdict = evaluateO1(observed, environment);
      if (opts.json) log(JSON.stringify(verdict, null, 2));
      else printVerdict(verdict, log);
      return verdict.ok ? EXIT.OK : EXIT.GATE_FAILED;
    }

    // --- O2 ---
    const functionName = `${names.base}-bff`;
    const budgetMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : O2_MAX_POLL_MS;
    const intervalMs = Number.isFinite(opts.intervalMs) ? opts.intervalMs : 30_000;
    const deadline = now() + budgetMs;

    for (;;) {
      const roundStart = now();

      const traffic = collectTraffic(aws, {
        apiId,
        functionName,
        startIso: new Date(startMs).toISOString(),
        endIso: new Date(roundStart).toISOString(),
      });

      // Alarm states are only read once traffic evidence exists, so a run with no traffic never
      // reports an alarm verdict at all — there is nothing there to misread as health.
      const alarms = traffic.apiCount >= 1 && traffic.lambdaInvocations >= 1
        ? collectAlarmStates(aws, names)
        : null;

      // The deadline is judged AFTER the remote calls, not before them. Judging it first meant a
      // round that began just inside the budget and then spent minutes in a slow call was still
      // treated as having budget left, so the loop slept and went round again — the documented
      // ten-minute maximum was a lower bound on the real one.
      const deadlineReached = now() >= deadline;

      const { done, verdict } = evaluateO2Round({ traffic, alarms, environment, deadlineReached });
      if (done) {
        if (opts.json) log(JSON.stringify(verdict, null, 2));
        else printVerdict(verdict, log);
        return verdict.ok ? EXIT.OK : EXIT.GATE_FAILED;
      }
      // Never sleep past the budget: the next round has to be able to observe the deadline.
      const remaining = deadline - now();
      await sleep(Math.max(0, Math.min(intervalMs, remaining)));
    }
  } catch (err) {
    if (err instanceof GateError) {
      printRefusal(err.code, err.message, log);
      return EXIT.GATE_FAILED;
    }
    throw err;
  }
}
