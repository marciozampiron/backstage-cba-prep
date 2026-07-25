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
// Bundling (reproducible): NodejsFunction + local esbuild; the two @aws-sdk packages are
// installed into the asset from services/bff/package-lock.json (pinned devDeps), and the exam
// content (spec/blueprint.json + questions/) is copied into the bundle, addressed via
// CBA_CONTENT_DIR — the Lambda never reads the repository at runtime.
const path = require('node:path');
const { Stack, Duration, CfnOutput } = require('aws-cdk-lib');
const lambda = require('aws-cdk-lib/aws-lambda');
const { NodejsFunction, OutputFormat } = require('aws-cdk-lib/aws-lambda-nodejs');
const apigwv2 = require('aws-cdk-lib/aws-apigatewayv2');
const { HttpLambdaIntegration } = require('aws-cdk-lib/aws-apigatewayv2-integrations');
const iam = require('aws-cdk-lib/aws-iam');
const { getContext, resolveEnvironment } = require('./context');
const { applyFoundationTags } = require('./tags');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const BFF_DIR = path.join(REPO_ROOT, 'services', 'bff');

// The implemented learner contract surface (#76/#77) + readiness — EXPLICIT, nothing else.
const ROUTES = [
  ['GET', '/api/readiness'],
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
  // props: { table: dynamodb.Table } — the EXPLICIT DataStack reference (#77 decision: the data
  // stack creates zero IAM; this stack owns the runtime role's scoped grants).
  constructor(scope, id, props = {}) {
    super(scope, id, props);
    const environment = resolveEnvironment(this.node, props.environment || 'pilot');
    const { table } = props;
    if (!table) throw new Error('ApiStack requires the DataStack table (explicit reference).');
    applyFoundationTags(this, environment);

    const fn = new NodejsFunction(this, 'BffFunction', {
      functionName: `cba-study-coach-${environment}-bff`,
      runtime: lambda.Runtime.NODEJS_22_X,
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
              allowMethods: [apigwv2.CorsHttpMethod.GET, apigwv2.CorsHttpMethod.POST],
              allowHeaders: ['content-type', 'authorization'],
              allowCredentials: true,
              maxAge: Duration.minutes(10),
            },
          }
        : {}),
    });

    const integration = new HttpLambdaIntegration('BffIntegration', fn);
    for (const [method, routePath] of ROUTES) {
      this.httpApi.addRoutes({
        path: routePath,
        methods: [apigwv2.HttpMethod[method]],
        integration,
      });
    }

    new CfnOutput(this, 'BffApiEndpoint', {
      value: this.httpApi.apiEndpoint,
      description: 'Publish as BASE_URL for the environment (#56 smokes).',
    });
  }
}

module.exports = { ApiStack };
