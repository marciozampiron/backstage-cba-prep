// #111 wave-2 postmortem — the PREVENTIVE tag audit (Codex item D, mandatory before the retry).
//
// The wave-2 execution failed on `apigateway:TagResource`: CloudFormation evaluates the NOMINAL
// tag action when it creates a tagged resource, and a grant that models only the service's
// generic verbs — or that conditions the tag action on aws:ResourceTag, unmatchable on a
// resource that does not exist yet — refuses at the first real deploy and nowhere earlier.
//
// This audit closes the class, not the instance: it synthesizes ApiStack and ObservabilityStack
// for BOTH tiers, takes every resource that actually carries tags, models the exact create-time
// tagging call CloudFormation performs for that type (action, concrete ARN shape, request-tag
// context), and evaluates it against the CANONICAL execution document with a small, strict IAM
// evaluator — Deny wins, unknown operators throw, unknown tagged types fail loudly. Negatives
// prove the confinement is real: a wrong project, a cross-tier environment, an extra tag key and
// a foreign ARN must all fail to gain the tag action.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { join } = require('node:path');
const { App } = require('aws-cdk-lib');
const { Template } = require('aws-cdk-lib/assertions');
const { buildStacks } = require('../lib/app');

const ACCOUNT = '1'.repeat(12);
const CANONICAL = join(__dirname, '..', 'bootstrap', 'policies', 'cfn-exec-release.template.json');

function policyFor(environment) {
  const text = fs.readFileSync(CANONICAL, 'utf8')
    .replaceAll('ACCOUNT_ID_PLACEHOLDER', ACCOUNT)
    .replaceAll('ENVIRONMENT_PLACEHOLDER', environment);
  return JSON.parse(text);
}

/* ------------------------------- the strict mini evaluator ---------------------------------- */
const asArray = (v) => (Array.isArray(v) ? v : [v]);
const globToRegExp = (glob) => new RegExp(`^${glob.split('*').map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);

/** Evaluate ONE condition block against the request context. Unknown operator = throw: an
 * operator this evaluator cannot model must not silently pass an audit that claims coverage. */
function conditionHolds(condition, context) {
  for (const [operator, clauses] of Object.entries(condition ?? {})) {
    for (const [key, expected] of Object.entries(clauses)) {
      const values = asArray(expected);
      const actual = context[key];
      switch (operator) {
        case 'StringEquals':
          if (actual === undefined || !values.includes(actual)) return false;
          break;
        case 'StringEqualsIfExists':
          if (actual !== undefined && !values.includes(actual)) return false;
          break;
        case 'ArnEquals':
          if (actual === undefined || !values.some((v) => globToRegExp(v).test(actual))) return false;
          break;
        case 'StringNotEquals':
          // Deny semantics: the clause HOLDS (and the Deny fires) when the key differs. An
          // ABSENT key differs from every value in IAM's model of this operator.
          if (actual !== undefined && values.includes(actual)) return false;
          break;
        case 'Null': {
          const wantAbsent = String(values[0]) === 'true';
          if (wantAbsent !== (actual === undefined)) return false;
          break;
        }
        case 'ForAllValues:StringEquals': {
          const list = actual === undefined ? [] : asArray(actual);
          if (!list.every((v) => values.includes(v))) return false;
          break;
        }
        case 'ForAnyValue:StringEquals': {
          const list = actual === undefined ? [] : asArray(actual);
          if (!list.some((v) => values.includes(v))) return false;
          break;
        }
        default:
          throw new Error(`tag audit: unmodelled condition operator "${operator}" — extend the evaluator through review`);
      }
    }
  }
  return true;
}

/** allow | deny | implicit-deny for one call, whole-document, Deny wins. */
function evaluate(policy, { action, resource, context = {} }) {
  let allowed = false;
  for (const statement of policy.Statement) {
    const actions = asArray(statement.Action);
    if (!actions.includes(action)) continue;
    if (!asArray(statement.Resource).some((r) => globToRegExp(r).test(resource))) continue;
    if (!conditionHolds(statement.Condition, context)) continue;
    if (statement.Effect === 'Deny') return 'deny';
    allowed = true;
  }
  return allowed ? 'allow' : 'implicit-deny';
}

/* --------------------------- the create-time tagging call per type --------------------------- */
/** Foundation tags as CloudFormation sends them at creation, as request context. */
function requestContext(environment, overrides = {}) {
  const tags = {
    Project: 'CBAStudyCoach',
    Environment: environment,
    ManagedBy: 'CDK',
    CostCenter: 'pilot',
    ...overrides,
  };
  const context = { 'aws:TagKeys': Object.keys(tags) };
  for (const [k, v] of Object.entries(tags)) context[`aws:RequestTag/${k}`] = v;
  return context;
}

/** The call CloudFormation's handler performs to tag a fresh resource of this type. A type that
 * carries tags but has no row here fails the audit loudly — classify it through review. */
const TAGGING_CALLS = {
  'AWS::ApiGatewayV2::Api': (env) => ({ action: 'apigateway:POST', resource: 'arn:aws:apigateway:us-east-1::/apis' }),
  'AWS::ApiGatewayV2::Stage': (env) => ({ action: 'apigateway:TagResource', resource: 'arn:aws:apigateway:us-east-1::/apis/a1b2c3d4e5/stages' }),
  'AWS::Lambda::Function': (env, props) => ({ action: 'lambda:TagResource', resource: `arn:aws:lambda:us-east-1:${ACCOUNT}:function:${props.FunctionName}` }),
  'AWS::Logs::LogGroup': (env, props) => ({ action: 'logs:TagResource', resource: `arn:aws:logs:us-east-1:${ACCOUNT}:log-group:${props.LogGroupName}` }),
  'AWS::IAM::Role': (env) => ({ action: 'iam:TagRole', resource: `arn:aws:iam::${ACCOUNT}:role/cba-study-coach-${env}-api-BffFunctionServiceRole4C91-EXAMPLE` }),
  'AWS::KMS::Key': (env) => ({ action: 'kms:TagResource', resource: `arn:aws:kms:us-east-1:${ACCOUNT}:key/11111111-2222-3333-4444-555555555555` }),
  'AWS::SNS::Topic': (env, props) => ({ action: 'sns:TagResource', resource: `arn:aws:sns:us-east-1:${ACCOUNT}:${props.TopicName}` }),
  'AWS::CloudWatch::Alarm': (env, props) => ({ action: 'cloudwatch:TagResource', resource: `arn:aws:cloudwatch:us-east-1:${ACCOUNT}:alarm:${props.AlarmName}` }),
  // Composite alarms live in the SAME alarm: ARN space and the same statement family.
  'AWS::CloudWatch::CompositeAlarm': (env, props) => ({ action: 'cloudwatch:TagResource', resource: `arn:aws:cloudwatch:us-east-1:${ACCOUNT}:alarm:${props.AlarmName}` }),
  // Dashboards: REGION-LESS ARN space, own-name scoped — the third member of the class this
  // audit caught before it fired (the statement had the verbs and no nominal tag action).
  'AWS::CloudWatch::Dashboard': (env, props) => ({ action: 'cloudwatch:TagResource', resource: `arn:aws:cloudwatch::${ACCOUNT}:dashboard/${props.DashboardName}` }),
};

const templateCache = {};
function stacksFor(env) {
  if (!templateCache[env]) {
    const stacks = buildStacks(new App({ context: { environment: env } }));
    templateCache[env] = {
      api: Template.fromStack(stacks.api).toJSON(),
      observability: Template.fromStack(stacks.observability).toJSON(),
    };
  }
  return templateCache[env];
}

function taggedResourcesOf(templateJson) {
  const out = [];
  for (const [logicalId, resource] of Object.entries(templateJson.Resources ?? {})) {
    const tags = resource.Properties?.Tags;
    if (tags === undefined) continue;
    out.push({ logicalId, type: resource.Type, props: resource.Properties });
  }
  return out;
}

/* --------------------------------------- the audit ------------------------------------------- */

test('every tagged resource of ApiStack and ObservabilityStack gains its create-time tag action, in BOTH tiers', () => {
  for (const env of ['dev', 'pilot']) {
    const policy = policyFor(env);
    const { api, observability } = stacksFor(env);
    const audited = [];
    for (const [stackName, templateJson] of [['api', api], ['observability', observability]]) {
      for (const { logicalId, type, props } of taggedResourcesOf(templateJson)) {
        const call = TAGGING_CALLS[type];
        assert.ok(call, `${env}/${stackName}/${logicalId}: type ${type} carries tags but has no audit row — classify it through review`);
        const { action, resource } = call(env, props);
        const verdict = evaluate(policy, { action, resource, context: requestContext(env) });
        assert.equal(verdict, 'allow', `${env}/${stackName}/${logicalId} (${type}): ${action} on ${resource} must be granted — this is exactly the wave-2 failure class`);
        audited.push(type);
      }
    }
    // The audit is not vacuous, and it covers every service family Codex named for these stacks.
    assert.ok(audited.length >= 8, `${env}: only ${audited.length} tagged resources audited`);
    for (const type of ['AWS::ApiGatewayV2::Stage', 'AWS::Lambda::Function', 'AWS::Logs::LogGroup', 'AWS::IAM::Role']) {
      assert.ok(audited.includes(type), `${env}: the audit must reach ${type}`);
    }
  }
});

test('the confinement is real: wrong project, cross-tier, extra key and foreign ARN all fail', () => {
  const policy = policyFor('dev');
  const stage = { action: 'apigateway:TagResource', resource: 'arn:aws:apigateway:us-east-1::/apis/a1b2c3d4e5/stages' };
  assert.equal(evaluate(policy, { ...stage, context: requestContext('dev') }), 'allow', 'the control');
  assert.notEqual(evaluate(policy, { ...stage, context: requestContext('dev', { Project: 'SomebodyElse' }) }), 'allow', 'a foreign project buys nothing');
  assert.notEqual(evaluate(policy, { ...stage, context: requestContext('pilot') }), 'allow', 'a cross-tier environment buys nothing in dev');
  assert.notEqual(evaluate(policy, { ...stage, context: requestContext('dev', { Sneaky: 'x' }) }), 'allow', 'an extra tag key is outside the closed key set');
  assert.notEqual(
    evaluate(policy, { action: 'apigateway:TagResource', resource: 'arn:aws:apigateway:us-east-1::/apis/a1b2c3d4e5', context: requestContext('dev') }),
    'allow',
    'the grant is the stages collection, not the api root',
  );
  assert.notEqual(
    evaluate(policy, { action: 'apigateway:UntagResource', resource: stage.resource, context: requestContext('dev') }),
    'allow',
    'UntagResource is deliberately NOT granted nominally — removal goes through the governed /tags/* path',
  );
  // KMS, the second member of the class the audit caught before it fired: create-time TagResource
  // is REQUEST-tag confined, and a fresh key's missing ResourceTag can no longer refuse it.
  const key = { action: 'kms:TagResource', resource: `arn:aws:kms:us-east-1:${ACCOUNT}:key/11111111-2222-3333-4444-555555555555` };
  assert.equal(evaluate(policy, { ...key, context: requestContext('dev') }), 'allow');
  assert.notEqual(evaluate(policy, { ...key, context: requestContext('pilot') }), 'allow', 'cross-tier KMS tagging buys nothing');

  // Cross-tier by NAME scoping too, not only by tag: a pilot-named function under the dev policy.
  assert.notEqual(
    evaluate(policy, { action: 'lambda:TagResource', resource: `arn:aws:lambda:us-east-1:${ACCOUNT}:function:cba-study-coach-pilot-bff`, context: requestContext('dev') }),
    'allow',
    'a foreign-tier function name is outside the dev resource scope',
  );
});

test('the documented-versus-real discrepancy is ON RECORD: the nominal action and the verb path coexist', () => {
  // AWS's service-authorization reference maps the API Gateway tags API to generic verbs
  // (POST/PATCH/PUT on /tags/*), but the LIVE wave-2 execution was refused for the NOMINAL
  // apigateway:TagResource on the stages collection. Both statements therefore exist on purpose:
  // the verb path stays (documented model, governed by the tag-removal denies), and the nominal
  // stage statement answers what the service actually evaluates. Removing either regresses a
  // fact this repository PAID to learn.
  const policy = policyFor('dev');
  const sids = policy.Statement.map((s) => s.Sid);
  assert.ok(sids.includes('ApiGatewayV2TagReadAndWriteOnlyOnOwnedResources'), 'the documented verb path stays');
  assert.ok(sids.includes('ApiGatewayV2StageTaggingOnlyWithFoundationTags'), 'the nominal action the live service demanded');
  const nominal = policy.Statement.find((s) => s.Sid === 'ApiGatewayV2StageTaggingOnlyWithFoundationTags');
  assert.deepEqual(asArray(nominal.Action), ['apigateway:TagResource']);
  assert.equal(nominal.Resource, 'arn:aws:apigateway:us-east-1::/apis/*/stages', 'exactly the collection form the live refusal named');
  assert.deepEqual(nominal.Condition['ForAllValues:StringEquals']['aws:TagKeys'], ['Project', 'Environment', 'ManagedBy', 'CostCenter']);
});

test('removing the new statement reproduces the wave-2 failure — the audit would have caught it', () => {
  const policy = policyFor('dev');
  policy.Statement = policy.Statement.filter((s) => s.Sid !== 'ApiGatewayV2StageTaggingOnlyWithFoundationTags');
  const verdict = evaluate(policy, {
    action: 'apigateway:TagResource',
    resource: 'arn:aws:apigateway:us-east-1::/apis/a1b2c3d4e5/stages',
    context: requestContext('dev'),
  });
  assert.notEqual(verdict, 'allow', 'without the statement, the exact live refusal comes back');
  // And the same for the KMS member of the class.
  const kmsPolicy = policyFor('dev');
  for (const s of kmsPolicy.Statement) {
    if (s.Sid === 'KmsCreateOnlyProjectTaggedKeys') s.Action = ['kms:CreateKey'];
  }
  assert.notEqual(
    evaluate(kmsPolicy, { action: 'kms:TagResource', resource: `arn:aws:kms:us-east-1:${ACCOUNT}:key/11111111-2222-3333-4444-555555555555`, context: requestContext('dev') }),
    'allow',
    'a create-only statement without the nominal tag action strands wave 3 exactly as wave 2',
  );
});
