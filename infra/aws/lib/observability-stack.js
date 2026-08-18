// ObservabilityStack (#82 Slice B) — operational baseline for one environment.
//
// Implements docs/architecture/aws-observability-baseline.md §§8-10, 15. It composes metrics and
// notifications; it never takes ownership of a workload. The stack that owns a workload owns its log
// emission (ApiStack owns both log groups), so every reference below is an EXPLICIT construct passed
// in by the app — not a name assembled by convention, which would silently point at nothing after a
// rename and leave a dashboard of empty widgets.
//
// TWO INVARIANTS CARRY THE WHOLE NOTIFICATION PATH, and both are asserted offline in both
// directions because a failure in either is SILENT:
//
//   1. the composite alarm references EXACTLY the six baseline alarms — a dropped one is a gap
//      nobody is paged for;
//   2. the composite is the ONLY resource with an SNS alarm action — a second publisher duplicates
//      every page until operators start ignoring them.
//
// WHAT THIS STACK DELIBERATELY DOES NOT DO: no subscription endpoint (operator configuration, never
// committed), no budget (blocked on the `Project` cost-allocation tag being activated and proven to
// isolate this project), no Application Signals / X-Ray / OTEL / Synthetics, no custom
// high-cardinality metrics, and no output carrying an ARN, account id, endpoint or subscription.
const { Stack, CfnOutput, Duration, RemovalPolicy, Aws, ArnFormat } = require('aws-cdk-lib');
const cloudwatch = require('aws-cdk-lib/aws-cloudwatch');
const cwActions = require('aws-cdk-lib/aws-cloudwatch-actions');
const dynamodb = require('aws-cdk-lib/aws-dynamodb');
const iam = require('aws-cdk-lib/aws-iam');
const kms = require('aws-cdk-lib/aws-kms');
const logs = require('aws-cdk-lib/aws-logs');
const sns = require('aws-cdk-lib/aws-sns');
const { resolveEnvironment, getContext } = require('./context');
const { applyFoundationTags } = require('./tags');

const GITHUB_OIDC_HOST = 'token.actions.githubusercontent.com';

/**
 * The read-only actions the #70 observability gate may hold on `Resource: "*"`.
 *
 * These CloudWatch/Logs describe-and-get operations do not support resource-level authorization, so
 * they need a wildcard resource — which is exactly why they live in ONE isolated statement holding
 * nothing else. A test fails if any action is ever added here, because with a wildcard resource
 * every addition is account-wide rather than environment-scoped.
 *
 * SNS reads are deliberately absent: they DO support resource-level authorization and are scoped to
 * this environment's topic in a separate statement.
 */
const GATE_WILDCARD_ACTIONS = [
  'logs:DescribeLogGroups',
  'logs:DescribeQueryDefinitions',
  'cloudwatch:DescribeAlarms',
  'cloudwatch:GetMetricData',
];

/**
 * `cloudwatch:GetDashboard` DOES support resource-level authorization, so it does not belong in the
 * wildcard statement: there it would let the gate read every dashboard in the account. It is scoped
 * to this environment's dashboard ARN instead (Codex review, #82 Slice B).
 */
const GATE_DASHBOARD_ACTIONS = ['cloudwatch:GetDashboard'];

/**
 * The DynamoDB operations watched by the SystemErrors alarm — exactly the operations the adapter
 * issues and the runtime role is granted (`api-stack.js`). One constant, shared by the alarm and by
 * the dashboard panel, so the page and the graph explaining it can never drift apart.
 */
const DYNAMO_ALARMED_OPERATIONS = [
  dynamodb.Operation.GET_ITEM,
  dynamodb.Operation.PUT_ITEM,
  dynamodb.Operation.QUERY,
  dynamodb.Operation.UPDATE_ITEM,
  dynamodb.Operation.DELETE_ITEM,
  // #75: smoke-scoped writes go through a transaction, and `TransactWriteItems` IS a DynamoDB
  // metric Operation dimension. Leaving it out made the release-blocking alarm blind to server-side
  // failures on exactly the newest write path.
  dynamodb.Operation.TRANSACT_WRITE_ITEMS,
];

/** SNS reads for O1, scoped to the exact environment topic. */
const GATE_TOPIC_ACTIONS = ['sns:GetTopicAttributes', 'sns:ListSubscriptionsByTopic'];

/**
 * The six baseline alarms, in canonical order (baseline §9).
 *
 * These keys are what the composite rule and the tests refer to, so changing one is a visible,
 * reviewed act rather than a rename that quietly drops an alarm out of the composite.
 */
const ALARM_KEYS = [
  'ApiServerErrors',
  'LambdaErrors',
  'LambdaThrottles',
  'LambdaHighDuration',
  'DynamoSystemErrors',
  'DynamoThrottling',
];

/** Every alarm evaluates a five-minute window; the pilot has too little traffic for anything finer. */
const PERIOD = Duration.minutes(5);

/**
 * The Lambda timeout is 15 seconds, so p95 >= 12s warns BEFORE the hard timeout rather than
 * reporting it afterwards. A pilot default to be tuned from observed traffic — but never weakened
 * silently, because it is a release gate.
 */
const DURATION_P95_THRESHOLD_MS = 12_000;

class ObservabilityStack extends Stack {
  constructor(scope, id, props = {}) {
    super(scope, id, props);

    const environment = resolveEnvironment(this.node);
    const ctx = (key, fallback) => getContext(this.node, key, fallback);

    // --- explicit cross-stack references --------------------------------------------------------
    // A missing reference fails SYNTH. A stack that synthesises without the workload it is meant to
    // watch is worse than no stack at all: it deploys, looks present to the structural gate, and
    // observes nothing.
    const { httpApi, bffFunction, bffLogGroup, accessLogGroup, table, githubOidcProviderArn } = props;
    for (const [name, value] of Object.entries({ httpApi, bffFunction, bffLogGroup, accessLogGroup, table, githubOidcProviderArn })) {
      if (!value) {
        throw new Error(
          `ObservabilityStack requires an explicit "${name}" reference. Alarms, dashboard and ` +
            'queries must point at the real workload constructs; synthesising without them would ' +
            'deploy an observability baseline that observes nothing.',
        );
      }
    }

    const base = `cba-study-coach-${environment}`;

    // --- notification path: customer-managed key + encrypted topic -------------------------------
    // The AWS-managed `alias/aws/sns` key is NOT sufficient: its policy cannot be extended to let
    // CloudWatch use it, so alarms would fail to publish — with no alarm-state change to show for it.
    const alertKey = new kms.Key(this, 'OperationalAlertKey', {
      alias: `alias/${base}-operational-alerts`,
      description: `CBA Study Coach ${environment}: encrypts the operational alert topic (#82).`,
      enableKeyRotation: true,
      removalPolicy: environment === 'pilot' ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
    });

    const alertTopic = new sns.Topic(this, 'OperationalAlertTopic', {
      topicName: `${base}-operational-alerts`,
      displayName: `CBA Study Coach ${environment} operational alerts`,
      masterKey: alertKey,
    });

    // Every alarm this stack creates is named `cba-study-coach-<env>-*`, so this prefix scopes
    // publication to THIS environment's alarms rather than to every alarm in the account.
    const alarmArnPrefix = this.formatArn({
      service: 'cloudwatch',
      resource: 'alarm',
      resourceName: `${base}-*`,
      arnFormat: ArnFormat.COLON_RESOURCE_NAME,
    });

    // CloudWatch may publish, only CloudWatch, and only for this account's alarms in this
    // environment. `aws:SourceAccount` closes the confused-deputy shape where another account's
    // CloudWatch is talked into publishing here.
    alertTopic.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: 'AllowCloudWatchAlarmsToPublish',
        effect: iam.Effect.ALLOW,
        principals: [new iam.ServicePrincipal('cloudwatch.amazonaws.com')],
        actions: ['sns:Publish'],
        resources: [alertTopic.topicArn],
        conditions: {
          StringEquals: { 'aws:SourceAccount': Aws.ACCOUNT_ID },
          ArnLike: { 'aws:SourceArn': alarmArnPrefix },
        },
      }),
    );

    // Exact actions, not `kms:GenerateDataKey*`. The wildcard form would also grant
    // GenerateDataKeyWithoutPlaintext and GenerateDataKeyPair, neither of which SNS server-side
    // encryption needs. The baseline's live notification-path proof is what validates that this
    // narrower pair is sufficient in practice — it is the one failure mode that no offline test and
    // no alarm state can reveal.
    alertKey.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: 'AllowCloudWatchAlarmsToUseKeyForSns',
        effect: iam.Effect.ALLOW,
        principals: [new iam.ServicePrincipal('cloudwatch.amazonaws.com')],
        actions: ['kms:Decrypt', 'kms:GenerateDataKey'],
        resources: ['*'], // a key policy always addresses the key it is attached to
        conditions: {
          StringEquals: { 'aws:SourceAccount': Aws.ACCOUNT_ID },
        },
      }),
    );

    // --- the six baseline alarms ----------------------------------------------------------------
    // None carries an alarm action: they are the diagnostic source, and the composite below is the
    // single notification. Every one treats missing data as NOT_BREACHING, because before traffic
    // begins "no data" is the expected state and would otherwise page the operator on day one for a
    // system that is merely idle.
    const alarmDefaults = {
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
    };

    const alarms = {
      ApiServerErrors: new cloudwatch.Alarm(this, 'ApiServerErrorsAlarm', {
        ...alarmDefaults,
        alarmName: `${base}-api-5xx`,
        alarmDescription: 'HTTP API returned a server error (5xx). Release-blocking.',
        metric: httpApi.metricServerError({ period: PERIOD, statistic: 'Sum' }),
        threshold: 1,
      }),
      LambdaErrors: new cloudwatch.Alarm(this, 'LambdaErrorsAlarm', {
        ...alarmDefaults,
        alarmName: `${base}-lambda-errors`,
        alarmDescription: 'BFF Lambda reported an invocation error. Release-blocking.',
        metric: bffFunction.metricErrors({ period: PERIOD, statistic: 'Sum' }),
        threshold: 1,
      }),
      LambdaThrottles: new cloudwatch.Alarm(this, 'LambdaThrottlesAlarm', {
        ...alarmDefaults,
        alarmName: `${base}-lambda-throttles`,
        alarmDescription: 'BFF Lambda was throttled: the concurrency ceiling was reached. Release-blocking.',
        metric: bffFunction.metricThrottles({ period: PERIOD, statistic: 'Sum' }),
        threshold: 1,
      }),
      LambdaHighDuration: new cloudwatch.Alarm(this, 'LambdaHighDurationAlarm', {
        ...alarmDefaults,
        alarmName: `${base}-lambda-p95-duration`,
        alarmDescription: 'BFF Lambda p95 duration approached the 15s timeout. Release-blocking.',
        metric: bffFunction.metricDuration({ period: PERIOD, statistic: 'p95' }),
        threshold: DURATION_P95_THRESHOLD_MS,
      }),
      DynamoSystemErrors: new cloudwatch.Alarm(this, 'DynamoSystemErrorsAlarm', {
        ...alarmDefaults,
        alarmName: `${base}-dynamodb-system-errors`,
        alarmDescription: 'DynamoDB returned a server-side error. Release-blocking.',
        metric: table.metricSystemErrorsForOperations({
          operations: DYNAMO_ALARMED_OPERATIONS,
          period: PERIOD,
        }),
        threshold: 1,
      }),
      // Table-level throttle EVENTS (dimension TableName only), summed across read and write. The
      // per-operation `ThrottledRequests` metric needs an Operation dimension and would miss
      // throttles on any operation not enumerated.
      DynamoThrottling: new cloudwatch.Alarm(this, 'DynamoThrottlingAlarm', {
        ...alarmDefaults,
        alarmName: `${base}-dynamodb-throttling`,
        alarmDescription: 'DynamoDB throttled a read or a write. Release-blocking.',
        metric: new cloudwatch.MathExpression({
          expression: 'readThrottles + writeThrottles',
          label: 'DynamoDB throttle events',
          period: PERIOD,
          usingMetrics: {
            readThrottles: new cloudwatch.Metric({
              namespace: 'AWS/DynamoDB',
              metricName: 'ReadThrottleEvents',
              dimensionsMap: { TableName: table.tableName },
              statistic: 'Sum',
              period: PERIOD,
            }),
            writeThrottles: new cloudwatch.Metric({
              namespace: 'AWS/DynamoDB',
              metricName: 'WriteThrottleEvents',
              dimensionsMap: { TableName: table.tableName },
              statistic: 'Sum',
              period: PERIOD,
            }),
          },
        }),
        threshold: 1,
      }),
    };

    // Order-independent proof that the object above still holds exactly the canonical set. Without
    // it, adding a seventh alarm here and forgetting the composite would synthesise and deploy.
    const declared = Object.keys(alarms).sort().join(',');
    if (declared !== [...ALARM_KEYS].sort().join(',')) {
      throw new Error(
        `ObservabilityStack must declare exactly the six baseline alarms [${ALARM_KEYS.join(', ')}]; ` +
          `got [${Object.keys(alarms).join(', ')}].`,
      );
    }

    // --- the single notification: OperationalHealth ----------------------------------------------
    // One incident often trips several symptoms at once. Aggregating first and notifying once is
    // what keeps an operator page meaningful — and it is why the composite is the only publisher.
    const operationalHealth = new cloudwatch.CompositeAlarm(this, 'OperationalHealthAlarm', {
      compositeAlarmName: `${base}-operational-health`,
      alarmDescription:
        'Aggregate health across the six baseline alarms. The only SNS publisher; individual alarms stay diagnostic.',
      alarmRule: cloudwatch.AlarmRule.anyOf(
        ...ALARM_KEYS.map((key) => cloudwatch.AlarmRule.fromAlarm(alarms[key], cloudwatch.AlarmState.ALARM)),
      ),
    });
    operationalHealth.addAlarmAction(new cwActions.SnsAction(alertTopic));

    // --- dashboard (baseline §8): five rows on a 24-column layout ---------------------------------
    const dashboard = new cloudwatch.Dashboard(this, 'OperationalDashboard', {
      dashboardName: `${base}-operational`,
      defaultInterval: Duration.hours(8),
    });

    dashboard.addWidgets(
      new cloudwatch.Row(
        new cloudwatch.AlarmStatusWidget({
          title: '1 - Service health',
          width: 24,
          height: 4,
          alarms: [operationalHealth, ...ALARM_KEYS.map((key) => alarms[key])],
        }),
      ),
    );

    dashboard.addWidgets(
      new cloudwatch.Row(
        new cloudwatch.GraphWidget({
          title: '2 - HTTP API requests',
          width: 12,
          height: 6,
          left: [
            httpApi.metricCount({ period: PERIOD, statistic: 'Sum' }),
            // Generic 4xx is dashboard telemetry, not a release gate: auth challenges and learner
            // input errors are normal traffic and would make a noisy, ignored alarm.
            httpApi.metricClientError({ period: PERIOD, statistic: 'Sum' }),
            httpApi.metricServerError({ period: PERIOD, statistic: 'Sum' }),
          ],
        }),
        new cloudwatch.GraphWidget({
          title: '2 - HTTP API latency',
          width: 12,
          height: 6,
          left: [
            httpApi.metricLatency({ period: PERIOD, statistic: 'p50' }),
            httpApi.metricLatency({ period: PERIOD, statistic: 'p95' }),
            httpApi.metricLatency({ period: PERIOD, statistic: 'p99' }),
            httpApi.metricIntegrationLatency({ period: PERIOD, statistic: 'p95' }),
          ],
        }),
      ),
    );

    dashboard.addWidgets(
      new cloudwatch.Row(
        new cloudwatch.GraphWidget({
          title: '3 - Lambda BFF throughput',
          width: 12,
          height: 6,
          left: [
            bffFunction.metricInvocations({ period: PERIOD, statistic: 'Sum' }),
            bffFunction.metricErrors({ period: PERIOD, statistic: 'Sum' }),
            bffFunction.metricThrottles({ period: PERIOD, statistic: 'Sum' }),
          ],
        }),
        new cloudwatch.GraphWidget({
          title: '3 - Lambda BFF duration and concurrency',
          width: 12,
          height: 6,
          left: [bffFunction.metricDuration({ period: PERIOD, statistic: 'p95' })],
          right: [
            new cloudwatch.Metric({
              namespace: 'AWS/Lambda',
              metricName: 'ConcurrentExecutions',
              dimensionsMap: { FunctionName: bffFunction.functionName },
              statistic: 'Maximum',
              period: PERIOD,
            }),
          ],
        }),
      ),
    );

    dashboard.addWidgets(
      new cloudwatch.Row(
        new cloudwatch.GraphWidget({
          title: '4 - DynamoDB capacity and latency',
          width: 12,
          height: 6,
          left: [
            table.metricConsumedReadCapacityUnits({ period: PERIOD, statistic: 'Sum' }),
            table.metricConsumedWriteCapacityUnits({ period: PERIOD, statistic: 'Sum' }),
          ],
          right: [
            table.metricSuccessfulRequestLatency({
              period: PERIOD,
              statistic: 'p95',
              dimensionsMap: { TableName: table.tableName, Operation: 'Query' },
            }),
          ],
        }),
        new cloudwatch.GraphWidget({
          title: '4 - DynamoDB throttling and system errors',
          width: 12,
          height: 6,
          left: [
            new cloudwatch.Metric({
              namespace: 'AWS/DynamoDB',
              metricName: 'ReadThrottleEvents',
              dimensionsMap: { TableName: table.tableName },
              statistic: 'Sum',
              period: PERIOD,
            }),
            new cloudwatch.Metric({
              namespace: 'AWS/DynamoDB',
              metricName: 'WriteThrottleEvents',
              dimensionsMap: { TableName: table.tableName },
              statistic: 'Sum',
              period: PERIOD,
            }),
          ],
          // The panel is titled "system errors" and must actually show them: SystemErrors is the
          // metric the release-blocking alarm watches, so the dashboard has to explain a page.
          right: [
            table.metricSystemErrorsForOperations({ operations: DYNAMO_ALARMED_OPERATIONS, period: PERIOD }),
          ],
        }),
      ),
    );

    // Row 5 reads the application log group directly. Every projected field is on the Slice A
    // telemetry allowlist: no learner identity, no bodies, no headers, no exam content.
    dashboard.addWidgets(
      new cloudwatch.Row(
        new cloudwatch.LogQueryWidget({
          title: '5 - Investigation: recent server failures',
          width: 8,
          height: 6,
          logGroupNames: [bffLogGroup.logGroupName],
          queryString: QUERY_RECENT_FAILURES,
        }),
        new cloudwatch.LogQueryWidget({
          title: '5 - Investigation: errors by errorCode and routeKey',
          width: 8,
          height: 6,
          logGroupNames: [bffLogGroup.logGroupName],
          queryString: QUERY_ERRORS_BY_CODE,
        }),
        // Baseline §8 row 5 asks for slow routes as well; without it the row shows what failed but
        // not what is degrading, which is the earlier signal.
        new cloudwatch.LogQueryWidget({
          title: '5 - Investigation: slow routes',
          width: 8,
          height: 6,
          logGroupNames: [bffLogGroup.logGroupName],
          queryString: QUERY_LATENCY_BY_ROUTE,
        }),
      ),
    );

    // --- versioned Logs Insights queries (baseline §10) -------------------------------------------
    // Row-limited and allowlist-only: investigation tools, not a durable learner-data export path.
    // See the query-text block below for why the TIME window is not — and cannot be — set here.
    const savedQueries = [
      { id: 'RecentServerFailures', name: `${base}/1-recent-server-failures`, groups: [bffLogGroup], query: QUERY_RECENT_FAILURES },
      { id: 'ErrorsByCodeAndRoute', name: `${base}/2-errors-by-code-and-route`, groups: [bffLogGroup], query: QUERY_ERRORS_BY_CODE },
      { id: 'LatencyByRoute', name: `${base}/3-latency-percentiles-by-route`, groups: [bffLogGroup], query: QUERY_LATENCY_BY_ROUTE },
      { id: 'LambdaPlatformHealth', name: `${base}/4-lambda-timeout-and-cold-start`, groups: [bffLogGroup], query: QUERY_LAMBDA_PLATFORM },
      { id: 'ApiToLambdaCorrelation', name: `${base}/5-api-to-lambda-correlation`, groups: [bffLogGroup, accessLogGroup], query: QUERY_CORRELATION },
    ];
    for (const q of savedQueries) {
      new logs.CfnQueryDefinition(this, `${q.id}Query`, {
        name: q.name,
        logGroupNames: q.groups.map((group) => group.logGroupName),
        queryString: q.query,
      });
    }

    // --- #70 observability gate role (read-only) --------------------------------------------------
    // The account-global OIDC PROVIDER stays owned by SecurityStack; this stack IMPORTS it by ARN and
    // never creates a second one. Two providers for the same issuer is a deploy-time conflict, and
    // an account-level identity boundary should have exactly one owner.
    //
    // `props.githubOidcProviderArn` is SecurityStack's own reference — REQUIRED, like every other
    // cross-stack reference above (#111 round 3). It is what makes the dependency real:
    // reconstructing the ARN from pseudo parameters synthesises fine and creates NO dependency, so
    // in a clean account the role could be created before the provider exists and the deploy would
    // fail (or worse, succeed against a provider someone else created). The context override and
    // the pseudo-parameter fallback are BOTH gone: a `-c githubOidcProviderArn=...` used to take
    // priority over the foundation's reference, letting ambient context re-aim the gate role's
    // trust anchor at a foreign provider while `GithubOidc` stayed in the foundation — an
    // incoherent assembly. The key left the deploy contract entirely.
    const providerArn = githubOidcProviderArn;
    const githubRepo = ctx('githubRepo', 'marciozampiron/backstage-cba-prep');

    // Trust is exact on all three axes: this repository, the GitHub Environment matching this
    // deployment tier, and the STS audience. A `ref:` subject would let any branch assume the role;
    // an `environment:` subject means the role is reachable only from a job GitHub has already gated
    // on that environment's protection rules.
    const gateRole = new iam.Role(this, 'ObservabilityGateRole', {
      roleName: `${base}-gha-observability-gate`,
      description:
        'GitHub Actions O1/O2 observability gate: read-only CloudWatch/Logs/SNS describes. No deploy, no write, no log-content read.',
      maxSessionDuration: Duration.hours(1),
      assumedBy: new iam.WebIdentityPrincipal(providerArn, {
        StringEquals: {
          [`${GITHUB_OIDC_HOST}:aud`]: 'sts.amazonaws.com',
          [`${GITHUB_OIDC_HOST}:sub`]: `repo:${githubRepo}:environment:${environment}`,
        },
      }),
    });

    // ONE isolated wildcard-resource statement, holding nothing but the four describe/get actions.
    // Those APIs do not support resource-level authorization; everything that does is scoped below.
    gateRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'ReadOnlyObservabilityDescribes',
        effect: iam.Effect.ALLOW,
        actions: [...GATE_WILDCARD_ACTIONS],
        resources: ['*'],
      }),
    );

    // CloudWatch dashboards support resource-level authorization too, so the gate reads exactly this
    // environment's dashboard. Dashboard ARNs are region-less, which is why `region` is emptied.
    gateRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'ReadOnlyEnvironmentDashboard',
        effect: iam.Effect.ALLOW,
        actions: [...GATE_DASHBOARD_ACTIONS],
        resources: [dashboard.dashboardArn],
      }),
    );

    // SNS supports resource-level authorization, so the gate reads exactly this topic — not every
    // topic in the account.
    gateRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'ReadOnlyEnvironmentTopic',
        effect: iam.Effect.ALLOW,
        actions: [...GATE_TOPIC_ACTIONS],
        resources: [alertTopic.topicArn],
      }),
    );

    applyFoundationTags(this, environment);

    // --- outputs: logical names only ---------------------------------------------------------------
    // No ARN, account id, endpoint, subscription or secret. #70 resolves physical identifiers with
    // its own read-only session; a template output is a durable, widely-readable disclosure.
    new CfnOutput(this, 'OperationalDashboardName', {
      value: dashboard.dashboardName,
      description: 'Dashboard name for the #70 O1 structural gate.',
    });
    new CfnOutput(this, 'OperationalAlertTopicName', {
      value: alertTopic.topicName,
      description: 'Operational alert topic name. Subscriptions are operator-managed and never committed.',
    });
    new CfnOutput(this, 'OperationalHealthAlarmName', {
      value: operationalHealth.alarmName,
      description: 'Aggregate alarm name; the sole SNS publisher for this environment.',
    });
    new CfnOutput(this, 'ObservabilityGateRoleName', {
      value: gateRole.roleName,
      description: 'Read-only gate role NAME (not ARN) for the #70 observability job.',
    });

    this.alarms = alarms;
    this.operationalHealth = operationalHealth;
    this.alertTopic = alertTopic;
    this.alertKey = alertKey;
    this.dashboard = dashboard;
    this.gateRole = gateRole;
  }
}

// --- query text -----------------------------------------------------------------------------------
// Every projected field below is on the Slice A telemetry allowlist. There is deliberately no
// `@message` projection: it would return the whole event and defeat the field allowlist, and these
// are investigation tools rather than an export path.
//
// TWO DIFFERENT BOUNDS, and only one of them lives here. `| limit N` caps the ROWS RETURNED. Query
// text can narrow results further — Logs Insights QL does support `@timestamp` filtering with
// `now()` and the datetime functions — but those are filters over what the execution ALREADY
// scanned. Only `startTime`/`endTime` on the StartQuery call define the scan range, and that range
// is the cost and exposure boundary. So no saved query can carry its own scan bound, and reading
// `limit` or a `@timestamp` filter as one would be a false assurance about both.
// Enforcing an explicit bounded window at execution belongs to whoever runs these queries: #70 for
// the release gates, and the console operator otherwise. Slice B ships no query runner.

const QUERY_RECENT_FAILURES = [
  'fields @timestamp, requestId, routeKey, statusCode, errorCode, durationMs',
  '| filter statusCode >= 500',
  '| sort @timestamp desc',
  '| limit 100',
].join('\n');

const QUERY_ERRORS_BY_CODE = [
  'fields @timestamp, errorCode, routeKey',
  '| filter statusCode >= 500',
  '| stats count(*) as failures by errorCode, routeKey, bin(5m)',
  '| sort failures desc',
  '| limit 100',
].join('\n');

const QUERY_LATENCY_BY_ROUTE = [
  'fields @timestamp, routeKey, durationMs',
  '| filter ispresent(durationMs)',
  '| stats pct(durationMs, 50) as p50, pct(durationMs, 95) as p95, pct(durationMs, 99) as p99, count(*) as requests by routeKey',
  '| sort p95 desc',
  '| limit 50',
].join('\n');

// Platform REPORT lines are emitted by the Lambda runtime itself, so this query reads `@type` and the
// runtime's own duration fields rather than any application content.
const QUERY_LAMBDA_PLATFORM = [
  'fields @timestamp, @duration, @billedDuration, @initDuration, @maxMemoryUsed',
  '| filter @type = "REPORT"',
  '| stats count(*) as reports, max(@duration) as maxDurationMs, count(@initDuration) as coldStarts by bin(5m)',
  '| sort @timestamp desc',
  '| limit 100',
].join('\n');

// `requestId` is the canonical API Gateway request id, copied unchanged into the BFF completion event
// and error envelope — which is what makes an access-log line and an application event joinable.
const QUERY_CORRELATION = [
  'fields @timestamp, requestId, routeKey, statusCode, durationMs',
  '| filter ispresent(requestId)',
  '| sort @timestamp desc',
  '| limit 200',
].join('\n');

module.exports = {
  ObservabilityStack,
  ALARM_KEYS,
  GATE_WILDCARD_ACTIONS,
  GATE_DASHBOARD_ACTIONS,
  GATE_TOPIC_ACTIONS,
  DYNAMO_ALARMED_OPERATIONS,
  DURATION_P95_THRESHOLD_MS,
};
