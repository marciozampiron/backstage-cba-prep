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
