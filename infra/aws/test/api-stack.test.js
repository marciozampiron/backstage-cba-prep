// ApiStack synth guarantees (#78): explicit routes only, minimal DynamoDB IAM, fail-closed auth
// env, reproducible bundling, CORS seam rules, dev/pilot separation, invalid env fails.
// Templates are cached per environment — each Template.fromStack(api) runs the real esbuild
// bundling, so we do it once per env.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { App } = require('aws-cdk-lib');
const { Template } = require('aws-cdk-lib/assertions');
const { buildStacks } = require('../lib/app');
const { ApiStack } = require('../lib/api-stack');

const cache = {};
function apiTemplate(env, extraContext = {}) {
  const key = env + JSON.stringify(extraContext);
  if (!cache[key]) {
    const stacks = buildStacks(new App({ context: { environment: env, ...extraContext } }));
    cache[key] = Template.fromStack(stacks.api);
  }
  return cache[key];
}

const EXPECTED_ROUTES = [
  'GET /api/readiness',
  'GET /api/me',
  'PUT /api/me',
  'GET /api/dashboard',
  'GET /api/practice/options',
  'POST /api/practice-sessions',
  'GET /api/practice-sessions/{id}/next',
  'POST /api/practice-sessions/{id}/answers',
  'POST /api/mock-exams',
  'GET /api/mock-exams/{id}',
  'POST /api/mock-exams/{id}/answers',
  'POST /api/mock-exams/{id}/submit',
  'GET /api/attempts/{id}/results',
  'GET /api/attempts/{id}/missed',
  'POST /api/coach/message',
].sort();

test('function: node22 runtime, fail-closed auth env, dynamodb-only runtime config', () => {
  const t = apiTemplate('pilot');
  const fn = Object.values(t.findResources('AWS::Lambda::Function'))[0];
  assert.equal(fn.Properties.Runtime, 'nodejs22.x');
  assert.equal(fn.Properties.Handler, 'index.handler');
  assert.equal(fn.Properties.FunctionName, 'cba-study-coach-pilot-bff');
  const env = fn.Properties.Environment.Variables;
  assert.equal(env.CBA_RUNTIME_ENV, 'pilot');
  assert.equal(env.CBA_WEB_STORE, 'dynamodb');
  assert.equal(env.CBA_WEB_AUTH, 'cognito', 'no dev auth in a deployable runtime — fail closed until #69');
  assert.equal(env.CBA_CONTENT_DIR, '/var/task/content');
  // #69 Slice B: OIDC userInfo base — composed from references (tokens), never a literal.
  assert.ok(env.COGNITO_DOMAIN, 'COGNITO_DOMAIN must be wired for profile enrichment');
  assert.ok(
    JSON.stringify(env.COGNITO_DOMAIN).includes('amazoncognito.com'),
    'COGNITO_DOMAIN is the hosted Cognito OIDC base',
  );
  assert.ok(typeof env.CBA_WEB_TABLE === 'object', 'table name flows by reference, never hardcoded');
  // Bundled asset (reproducible via the bff lockfile) — not inline code.
  assert.ok(fn.Properties.Code.S3Key, 'code must be a bundled asset');
});

test('routes: EXACTLY the implemented contract surface, no $default catch-all', () => {
  const t = apiTemplate('pilot');
  const keys = Object.values(t.findResources('AWS::ApiGatewayV2::Route'))
    .map((r) => r.Properties.RouteKey)
    .sort();
  assert.deepEqual(keys, EXPECTED_ROUTES);
  assert.ok(!keys.some((k) => k.includes('$default')), 'no catch-all surface');
});

test('IAM: exactly item-CRUD on the table ARN and Query on the gsi1 index ARN — nothing wider', () => {
  const t = apiTemplate('pilot');
  const statements = Object.values(t.findResources('AWS::IAM::Policy')).flatMap(
    (p) => p.Properties.PolicyDocument.Statement,
  );
  const dynamo = statements.filter((s) => JSON.stringify(s.Action).includes('dynamodb'));
  assert.equal(dynamo.length, 2, 'exactly two dynamodb statements');
  const crud = dynamo.find((s) => s.Sid === 'ItemCrudOnExactTable');
  assert.deepEqual(
    [...crud.Action].sort(),
    ['dynamodb:DeleteItem', 'dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem'],
  );
  const query = dynamo.find((s) => s.Sid === 'QueryOnExactGsi1Only');
  assert.equal(query.Action, 'dynamodb:Query');
  assert.ok(JSON.stringify(query.Resource).includes('/index/gsi1'), 'Query scoped to the exact index');
  const flat = JSON.stringify(t.toJSON());
  assert.ok(!flat.includes('dynamodb:Scan') && !flat.includes('dynamodb:Batch'), 'no Scan/Batch');
  assert.ok(!flat.includes('"Action":"*"') && !flat.includes('"Action":["*"]'), 'no wildcard action');
  assert.ok(!/\b\d{12}\b/.test(flat), 'no literal account id');
});

test('dev environment renames the function and runtime tier', () => {
  const t = apiTemplate('dev');
  const fn = Object.values(t.findResources('AWS::Lambda::Function'))[0];
  assert.equal(fn.Properties.FunctionName, 'cba-study-coach-dev-bff');
  assert.equal(fn.Properties.Environment.Variables.CBA_RUNTIME_ENV, 'dev');
});

test('CORS: absent by default; exact origins with credentials when configured; "*" rejected', () => {
  const bare = apiTemplate('pilot');
  const apiBare = Object.values(bare.findResources('AWS::ApiGatewayV2::Api'))[0];
  assert.equal(apiBare.Properties.CorsConfiguration, undefined, 'no CORS until #69 configures it');

  const withCors = apiTemplate('dev', { corsAllowedOrigins: '["https://dev.example.test"]' });
  const api = Object.values(withCors.findResources('AWS::ApiGatewayV2::Api'))[0];
  assert.deepEqual(api.Properties.CorsConfiguration.AllowOrigins, ['https://dev.example.test']);
  assert.equal(api.Properties.CorsConfiguration.AllowCredentials, true);

  assert.throws(
    () => buildStacks(new App({ context: { environment: 'dev', corsAllowedOrigins: '["*"]' } })),
    /"\*" is forbidden/,
  );
});

test('NEGATIVE: the CORS list holds at most one stable origin, and never a preview (#67 Stage B)', () => {
  const reject = (origins, pattern) => assert.throws(
    () => buildStacks(new App({ context: { environment: 'dev', corsAllowedOrigins: JSON.stringify(origins) } })),
    pattern,
    JSON.stringify(origins),
  );

  // The count rule is what enforces the preview policy. Ephemeral previews validate UI only and
  // are never allow-listed (pilot-environment-contract §1); with a maximum of one, a per-change
  // preview URL cannot be APPENDED — it can only replace the stable origin, which is a visible
  // edit rather than an accumulation nobody notices.
  reject(
    ['https://dev.example.test', 'https://preview-abc123.example.test'],
    /at most ONE stable origin/,
  );
  reject(
    ['https://a.example.test', 'https://b.example.test', 'https://c.example.test'],
    /at most ONE stable origin/,
  );

  // Cloudflare Pages preview hosts are unmistakably ephemeral, and this project does not use Pages
  // at all — such an origin here is a mistake, not a decision.
  reject(['https://abc123.cba-study-coach.pages.dev'], /ephemeral preview origin/);

  // Shape rules, so a malformed entry cannot become a permissive one.
  reject(['http://dev.example.test'], /must use https/);
  reject(['https://dev.example.test/app'], /origins only/);
  reject(['https://dev.example.test?x=1'], /origins only/);
  reject(['dev.example.test'], /absolute origins/);

  // The single stable origin still works, and is still exact.
  const ok = apiTemplate('dev', { corsAllowedOrigins: '["https://dev.example.test"]' });
  const api = Object.values(ok.findResources('AWS::ApiGatewayV2::Api'))[0];
  assert.deepEqual(api.Properties.CorsConfiguration.AllowOrigins, ['https://dev.example.test']);
});

test('invalid environment and missing table both fail construction', () => {
  assert.throws(
    () => new ApiStack(new App({ context: { environment: 'production' } }), 'ApiStack', {}),
    /must be one of dev\|pilot/,
  );
  assert.throws(
    () => new ApiStack(new App({ context: { environment: 'dev' } }), 'ApiStack', {}),
    /requires the DataStack table/,
  );
});

/* ---------------- #82 Slice A: workload-owned telemetry ---------------- */

test('log groups: EXPLICIT Lambda and API access groups with environment retention', () => {
  const t = apiTemplate('pilot');
  const groups = Object.values(t.findResources('AWS::Logs::LogGroup'));
  assert.equal(groups.length, 2, 'exactly the application group and the access group');

  const byName = Object.fromEntries(groups.map((g) => [g.Properties.LogGroupName, g]));
  const app = byName['/aws/lambda/cba-study-coach-pilot-bff'];
  const access = byName['/aws/apigateway/cba-study-coach-pilot-bff'];
  assert.ok(app, 'the Lambda group is explicit — not the implicit never-expiring one');
  assert.ok(access, 'API Gateway access logs go to their own group');
  for (const group of [app, access]) {
    assert.equal(group.Properties.RetentionInDays, 30, 'pilot retains 30 days');
    assert.equal(group.DeletionPolicy, 'Retain', 'pilot logs survive a stack delete');
    assert.notEqual(group.Properties.RetentionInDays, undefined, 'never indefinite');
  }
});

test('log groups: dev is 7 days and disposable', () => {
  const t = apiTemplate('dev');
  const groups = Object.values(t.findResources('AWS::Logs::LogGroup'));
  assert.equal(groups.length, 2);
  for (const group of groups) {
    assert.equal(group.Properties.RetentionInDays, 7);
    assert.equal(group.DeletionPolicy, 'Delete');
    assert.match(group.Properties.LogGroupName, /cba-study-coach-dev-bff$/);
  }
});

test('the function writes to the EXPLICIT group, so no implicit group is created', () => {
  const t = apiTemplate('pilot');
  const fn = Object.values(t.findResources('AWS::Lambda::Function'))[0];
  assert.ok(fn.Properties.LoggingConfig?.LogGroup?.Ref, 'LoggingConfig references the CDK group');
});

test('access log format is the ALLOWLIST — no path, query, headers, bodies, IP or user-agent', () => {
  const t = apiTemplate('pilot');
  const stage = Object.values(t.findResources('AWS::ApiGatewayV2::Stage'))[0];
  const settings = stage.Properties.AccessLogSettings;
  assert.ok(settings, 'the default stage has access logging enabled');
  const format = JSON.parse(settings.Format);
  assert.deepEqual(Object.keys(format).sort(), [
    'integrationStatus',
    'requestId',
    'responseLatency',
    'routeKey',
    'status',
  ]);
  // $context.requestId is the canonical correlation id the BFF copies into its completion event.
  assert.equal(format.requestId, '$context.requestId');
  for (const forbidden of ['$context.path', '$context.identity.sourceIp', '$context.identity.userAgent',
    '$context.authorizer', '$context.requestBody', '$context.responseBody', '$context.domainName']) {
    assert.ok(!settings.Format.includes(forbidden), `${forbidden} must not be logged`);
  }
});

test('no learner/exam/credential material and no wildcard telemetry IAM in the template', () => {
  const flat = JSON.stringify(apiTemplate('pilot').toJSON());
  // Learner/exam material must never be configured anywhere in the stack. ("Authorization" alone
  // is NOT checked here: `AuthorizationType` is CDK's own route property — the header itself is
  // covered by the access-log format assertion above.)
  for (const forbidden of ['x-cba-learner', 'correctOption', 'cba_learner', 'explanation']) {
    assert.ok(!flat.includes(forbidden), `${forbidden} must not appear in the template`);
  }
  assert.ok(!/\$context\.authorizer|authorization["']?\s*:\s*["']\$context/i.test(flat), 'no auth material logged');
  // Slice A adds no observability IAM at all: alarms/dashboard/SNS belong to a later slice.
  assert.ok(!/cloudwatch:PutMetricData|logs:\*|cloudwatch:\*/.test(flat), 'no broad telemetry IAM');
  assert.equal(
    Object.keys(apiTemplate('pilot').findResources('AWS::CloudWatch::Alarm')).length,
    0,
    'alarms belong to the ObservabilityStack, not to Slice A',
  );
});

/* ---------------- #69 Slice A: trusted principal boundary ---------------- */

test('authorizer: exactly one JWT authorizer reading the Authorization header', () => {
  const t = apiTemplate('pilot');
  const authorizers = Object.values(t.findResources('AWS::ApiGatewayV2::Authorizer'));
  assert.equal(authorizers.length, 1);
  assert.equal(authorizers[0].Properties.AuthorizerType, 'JWT');
  assert.deepEqual(authorizers[0].Properties.IdentitySource, ['$request.header.Authorization']);
  const cfg = authorizers[0].Properties.JwtConfiguration;
  assert.ok(cfg.Issuer, 'issuer wired from the IdentityStack pool');
  assert.equal(cfg.Audience.length, 1, 'audience is exactly the SPA client id');
});

test('routes: EVERY route requires the JWT authorizer except public readiness', () => {
  const t = apiTemplate('pilot');
  const routes = Object.values(t.findResources('AWS::ApiGatewayV2::Route'));
  assert.equal(routes.length, 15, 'authorizer wiring must not add or drop routes');
  for (const route of routes) {
    const key = route.Properties.RouteKey;
    if (key === 'GET /api/readiness') {
      assert.notEqual(route.Properties.AuthorizationType, 'JWT', 'readiness stays public (#47)');
      assert.equal(route.Properties.AuthorizerId, undefined);
    } else {
      assert.equal(route.Properties.AuthorizationType, 'JWT', `${key} must fail closed`);
      assert.ok(route.Properties.AuthorizerId, `${key} must reference the authorizer`);
    }
  }
});

test('missing identity references fail construction (no authorizer-less authenticated surface)', () => {
  const app = new App({ context: { environment: 'dev' } });
  assert.throws(
    () => new ApiStack(app, 'ApiStack', { table: { tableArn: 'arn:fake', tableName: 'fake' } }),
    /requires the IdentityStack userPool/,
  );
});
