// API stack (#78 — promoted from the #53 placeholder).
// Publishes the provider-neutral Web BFF: ONE Node.js Lambda running the shared
// `handleApiRequest` boundary via the #78 transport adapter, behind an API Gateway HTTP API with
// EXPLICIT routes only (no $default catch-all — the surface is exactly the implemented learner
// contract plus readiness). Zero business rules live here.
//
// Security posture:
//   - Auth FAILS CLOSED until #69: CBA_WEB_AUTH=cognito is set explicitly; the identity port has
//     no Cognito adapter yet, so every authenticated route refuses — dev auth is never available
//     in a deployable runtime. /api/readiness stays public and logical-only by design.
//   - DynamoDB IAM is hand-rolled to the MINIMUM the #77 adapter uses: item CRUD on the exact
//     table ARN and Query on the exact gsi1 index ARN. No Scan, no Batch*, no wildcards — and
//     deliberately NOT table.grantReadWriteData(), which is broader.
//   - CORS is only a SEAM for #69: no configuration by default; `-c corsAllowedOrigins=[...]`
//     enables exact origins with credentials. "*" is rejected outright.
//
// Observability (#82 Slice A): this stack OWNS its log emission — an explicit Lambda log group and
// an explicit API Gateway access-log group, both with environment retention (dev 7 days / pilot 30
// days) and an allowlisted access-log format. Alarms, dashboard, SNS/KMS and the O1/O2 gates are
// NOT here; they belong to the ObservabilityStack in a later slice.
//
// LOG-GROUP ADOPTION (decide BEFORE the first deploy): a Lambda whose log group is created
// implicitly by the runtime owns `/aws/lambda/<function>` with never-expiring retention. Declaring
// it explicitly here means CloudFormation will try to CREATE that exact name. For an environment
// that has never been deployed (today: dev and pilot both — only the SecurityStack exists) this is
// a plain create and needs no migration. If an environment is ever deployed before this ships, the
// existing group must be imported/adopted (or deleted while unused) first, or the stack update
// fails with "resource already exists". The current answer is recorded in the #82 handoff.
//
// Bundling (reproducible): NodejsFunction + local esbuild; the two @aws-sdk packages are
// installed into the asset from services/bff/package-lock.json (pinned devDeps), and the exam
// content (spec/blueprint.json + questions/) is copied into the bundle, addressed via
// CBA_CONTENT_DIR — the Lambda never reads the repository at runtime.
const path = require('node:path');
const { Stack, Duration, RemovalPolicy, CfnOutput } = require('aws-cdk-lib');
const lambda = require('aws-cdk-lib/aws-lambda');
const logs = require('aws-cdk-lib/aws-logs');
const { NodejsFunction, OutputFormat } = require('aws-cdk-lib/aws-lambda-nodejs');
const apigwv2 = require('aws-cdk-lib/aws-apigatewayv2');
const { HttpLambdaIntegration } = require('aws-cdk-lib/aws-apigatewayv2-integrations');
const { HttpJwtAuthorizer } = require('aws-cdk-lib/aws-apigatewayv2-authorizers');
const iam = require('aws-cdk-lib/aws-iam');
const { getContext, resolveEnvironment } = require('./context');
const { applyFoundationTags } = require('./tags');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const BFF_DIR = path.join(REPO_ROOT, 'services', 'bff');

// The implemented learner contract surface (#76/#77) + readiness — EXPLICIT, nothing else.
// Every route is protected by the Cognito JWT authorizer (#69) EXCEPT the ones listed in
// PUBLIC_ROUTES: readiness is public and logical-only by contract (#47).
const ROUTES = [
  ['GET', '/api/readiness'],
  ['GET', '/api/me'],
  ['PUT', '/api/me'],
  ['GET', '/api/dashboard'],
  ['GET', '/api/practice/options'],
  ['POST', '/api/practice-sessions'],
  ['GET', '/api/practice-sessions/{id}/next'],
  ['POST', '/api/practice-sessions/{id}/answers'],
  ['POST', '/api/mock-exams'],
  ['GET', '/api/mock-exams/{id}'],
  ['POST', '/api/mock-exams/{id}/answers'],
  ['POST', '/api/mock-exams/{id}/submit'],
  ['GET', '/api/attempts/{id}/results'],
  ['GET', '/api/attempts/{id}/missed'],
  ['POST', '/api/coach/message'],
];

const PUBLIC_ROUTES = new Set(['GET /api/readiness']);

// #82 Slice A: log retention is EXPLICIT per environment — no indefinite application-log
// retention is allowed, and the group must be a real CDK resource so retention and removal
// behaviour are testable before any deploy.
const LOG_RETENTION = {
  dev: logs.RetentionDays.ONE_WEEK, // 7 days
  pilot: logs.RetentionDays.ONE_MONTH, // 30 days
};

// API Gateway access-log ALLOWLIST (`aws-observability-baseline.md` §7). Access logs may carry
// only these fields: correlation id, route key, status, latency and integration status. No path
// with ids, no query string, no headers, no bodies, no source IP, no user-agent.
const ACCESS_LOG_FORMAT = JSON.stringify({
  requestId: '$context.requestId',
  routeKey: '$context.routeKey',
  status: '$context.status',
  responseLatency: '$context.responseLatency',
  integrationStatus: '$context.integrationStatus',
});

function parseCorsOrigins(value) {
  let list = value ?? [];
  if (typeof list === 'string') {
    try {
      list = JSON.parse(list);
    } catch {
      throw new Error('context "corsAllowedOrigins" must be a JSON array of exact origins.');
    }
  }
  if (!Array.isArray(list) || !list.every((o) => typeof o === 'string')) {
    throw new Error('context "corsAllowedOrigins" must be a JSON array of exact origins.');
  }
  if (list.includes('*')) {
    throw new Error('corsAllowedOrigins must be EXACT origins — "*" is forbidden (credentials mode, #69).');
  }
  return list;
}

class ApiStack extends Stack {
  // props: { table, userPool, userPoolClient } — EXPLICIT references (#77 decision: the data
  // stack creates zero IAM, this stack owns the runtime role's scoped grants; #69: the identity
  // stack owns the pool, this stack owns the authorizer that trusts it).
  constructor(scope, id, props = {}) {
    super(scope, id, props);
    const environment = resolveEnvironment(this.node, props.environment || 'pilot');
    const { table, userPool, userPoolClient, userPoolDomain } = props;
    if (!table) throw new Error('ApiStack requires the DataStack table (explicit reference).');
    if (!userPool || !userPoolClient || !userPoolDomain) {
      // Fail closed: without a trusted issuer there is no authorizer, and an authorizer-less
      // authenticated surface must never synthesize; the domain feeds the OIDC userInfo config.
      throw new Error(
        'ApiStack requires the IdentityStack userPool + userPoolClient + userPoolDomain (explicit references).',
      );
    }
    applyFoundationTags(this, environment);

    const durable = environment === 'pilot';
    const retention = LOG_RETENTION[environment];

    // EXPLICIT Lambda log group (#82). Without it the runtime creates the group implicitly with
    // NEVER-EXPIRING retention, which the observability baseline forbids. See the adoption note
    // in the class doc: an already-deployed environment must import this group instead of letting
    // CloudFormation try to create one that already exists.
    this.bffLogGroup = new logs.LogGroup(this, 'BffLogGroup', {
      logGroupName: `/aws/lambda/cba-study-coach-${environment}-bff`,
      retention,
      removalPolicy: durable ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
    });

    // Access logs are a SEPARATE group from the application logs: different producer (the
    // gateway), different content (the allowlist above), same retention policy.
    this.accessLogGroup = new logs.LogGroup(this, 'BffAccessLogGroup', {
      logGroupName: `/aws/apigateway/cba-study-coach-${environment}-bff`,
      retention,
      removalPolicy: durable ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
    });

    const fn = new NodejsFunction(this, 'BffFunction', {
      functionName: `cba-study-coach-${environment}-bff`,
      runtime: lambda.Runtime.NODEJS_22_X,
      logGroup: this.bffLogGroup,
      entry: path.join(BFF_DIR, 'src', 'lambda.js'),
      handler: 'handler',
      memorySize: 512,
      timeout: Duration.seconds(15),
      environment: {
        CBA_RUNTIME_ENV: environment,
        CBA_WEB_STORE: 'dynamodb',
        CBA_WEB_TABLE: table.tableName,
        // Fail closed: no dev identity in a deployable runtime; #69 supplies the adapter.
        CBA_WEB_AUTH: 'cognito',
        // Cognito OIDC base for /oauth2/userInfo (#69 Slice B): composed from stack references —
        // configuration, not a secret, and never a literal in Git.
        COGNITO_DOMAIN: `https://${userPoolDomain.domainName}.auth.${this.region}.amazoncognito.com`,
        CBA_CONTENT_DIR: '/var/task/content',
      },
      depsLockFilePath: path.join(BFF_DIR, 'package-lock.json'),
      bundling: {
        format: OutputFormat.ESM,
        target: 'node22',
        // Reproducible SDK: installed into the asset from the bff lockfile (pinned), never
        // taken from whatever the Lambda runtime happens to provide.
        nodeModules: ['@aws-sdk/client-dynamodb', '@aws-sdk/lib-dynamodb'],
        commandHooks: {
          beforeBundling: () => [],
          beforeInstall: () => [],
          afterBundling: (inputDir, outputDir) => [
            // Paths are quoted: the repo path may contain spaces, and local bundling runs these
            // through a shell.
            `mkdir -p "${outputDir}/content/spec" "${outputDir}/content/questions"`,
            `cp "${REPO_ROOT}/spec/blueprint.json" "${outputDir}/content/spec/blueprint.json"`,
            `cp "${REPO_ROOT}"/questions/*.json "${outputDir}/content/questions/"`,
          ],
        },
      },
    });

    // Minimal DynamoDB grants for the #77 adapter's documented access patterns — NOTHING else.
    fn.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'ItemCrudOnExactTable',
        actions: ['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem', 'dynamodb:DeleteItem'],
        resources: [table.tableArn],
      }),
    );
    fn.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'QueryOnExactGsi1Only',
        actions: ['dynamodb:Query'],
        resources: [`${table.tableArn}/index/gsi1`],
      }),
    );

    const corsOrigins = parseCorsOrigins(getContext(this.node, 'corsAllowedOrigins', []));
    this.httpApi = new apigwv2.HttpApi(this, 'BffHttpApi', {
      apiName: `cba-study-coach-${environment}-bff`,
      ...(corsOrigins.length > 0
        ? {
            corsPreflight: {
              allowOrigins: corsOrigins,
              allowMethods: [apigwv2.CorsHttpMethod.GET, apigwv2.CorsHttpMethod.POST, apigwv2.CorsHttpMethod.PUT],
              allowHeaders: ['content-type', 'authorization'],
              allowCredentials: true,
              maxAge: Duration.minutes(10),
            },
          }
        : {}),
    });

    // Trusted principal boundary (#69): API Gateway validates the JWT (signature, issuer,
    // audience/client_id, expiry) against the environment's Cognito pool BEFORE the Lambda runs.
    // The transport then maps only authorizer-validated claims; token_use=access enforcement and
    // claim -> learner mapping are the Slice B adapter's job.
    const jwtAuthorizer = new HttpJwtAuthorizer('BffJwtAuthorizer', userPool.userPoolProviderUrl, {
      jwtAudience: [userPoolClient.userPoolClientId],
    });

    const integration = new HttpLambdaIntegration('BffIntegration', fn);
    for (const [method, routePath] of ROUTES) {
      const isPublic = PUBLIC_ROUTES.has(`${method} ${routePath}`);
      this.httpApi.addRoutes({
        path: routePath,
        methods: [apigwv2.HttpMethod[method]],
        integration,
        ...(isPublic ? {} : { authorizer: jwtAuthorizer }),
      });
    }

    // Access logging on the default stage: the HTTP API L2 has no access-log property, so this is
    // the documented escape hatch to the underlying CfnStage.
    const defaultStage = this.httpApi.defaultStage.node.defaultChild;
    defaultStage.accessLogSettings = {
      destinationArn: this.accessLogGroup.logGroupArn,
      format: ACCESS_LOG_FORMAT,
    };
    defaultStage.node.addDependency(this.accessLogGroup);

    new CfnOutput(this, 'BffApiEndpoint', {
      value: this.httpApi.apiEndpoint,
      description: 'Publish as BASE_URL for the environment (#56 smokes).',
    });
  }
}

module.exports = { ApiStack };
