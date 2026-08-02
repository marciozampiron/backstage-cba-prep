// The RELEASE execution authority (#70 Slice B1 round 3): the deployable stacks synthesize
// against their own bootstrap qualifier (cbarel), and the versioned cfn-exec-release policy is
// what that bootstrap's CloudFormation execution role may do. These tests keep three promises:
// the policy COVERS what the four templates actually create (a lane that passes review and then
// fails on the first real deploy is a broken deliverable); the policy grants NOTHING outside the
// enumerated services and name scopes; and every wildcard is a NAMED, justified exception, not a
// convenience.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { App } = require('aws-cdk-lib');
const { Template } = require('aws-cdk-lib/assertions');
const { buildStacks, RELEASE_BOOTSTRAP_QUALIFIER } = require('../lib/app');
const { DEPLOYABLE_STACK_IDS } = require('../lib/context');

const POLICIES_DIR = join(__dirname, '..', 'bootstrap', 'policies');
const releaseExec = JSON.parse(readFileSync(join(POLICIES_DIR, 'cfn-exec-release.template.json'), 'utf8'));
const runtimeBoundary = JSON.parse(readFileSync(join(POLICIES_DIR, 'runtime-boundary.template.json'), 'utf8'));

const asArray = (v) => (Array.isArray(v) ? v : [v]);
const allowActions = (doc) => doc.Statement.filter((s) => s.Effect === 'Allow').flatMap((s) => asArray(s.Action));

/** Synthesize the real app once per tier and hand back {stackId: template}. */
function synthDeployables(environment) {
  const app = new App({ context: { environment } });
  const stacks = buildStacks(app);
  const byId = { ApiStack: stacks.api, DataStack: stacks.data, IdentityStack: stacks.identity, ObservabilityStack: stacks.observability };
  return Object.fromEntries(DEPLOYABLE_STACK_IDS.map((id) => [id, Template.fromStack(byId[id])]));
}

test('every resource type the deployable stacks create maps to a service the release exec policy grants', () => {
  // Discovery, not enumeration: the resource types come from the REAL synthesized templates, and
  // the closed map below is the review surface. A new resource type fails HERE first — it must
  // join the map AND the policy through review before any template can carry it to a deploy.
  const TYPE_TO_SERVICE = {
    'AWS::ApiGatewayV2::Api': 'apigateway',
    'AWS::ApiGatewayV2::Authorizer': 'apigateway',
    'AWS::ApiGatewayV2::Integration': 'apigateway',
    'AWS::ApiGatewayV2::Route': 'apigateway',
    'AWS::ApiGatewayV2::Stage': 'apigateway',
    'AWS::CDK::Metadata': null, // synthesizer bookkeeping; CloudFormation needs no grant for it
    'AWS::CloudWatch::Alarm': 'cloudwatch',
    'AWS::CloudWatch::CompositeAlarm': 'cloudwatch',
    'AWS::CloudWatch::Dashboard': 'cloudwatch',
    'AWS::Cognito::UserPool': 'cognito-idp',
    'AWS::Cognito::UserPoolClient': 'cognito-idp',
    'AWS::Cognito::UserPoolDomain': 'cognito-idp',
    'AWS::Cognito::UserPoolGroup': 'cognito-idp',
    'AWS::Cognito::UserPoolUICustomizationAttachment': 'cognito-idp',
    'AWS::DynamoDB::Table': 'dynamodb',
    'AWS::IAM::Policy': 'iam',
    'AWS::IAM::Role': 'iam',
    'AWS::KMS::Alias': 'kms',
    'AWS::KMS::Key': 'kms',
    'AWS::Lambda::Function': 'lambda',
    'AWS::Lambda::Permission': 'lambda',
    'AWS::Logs::LogGroup': 'logs',
    'AWS::Logs::QueryDefinition': 'logs',
    'AWS::SNS::Topic': 'sns',
    'AWS::SNS::TopicPolicy': 'sns',
  };
  const granted = allowActions(releaseExec);
  for (const environment of ['dev', 'pilot']) {
    const templates = synthDeployables(environment);
    for (const [stackId, template] of Object.entries(templates)) {
      for (const resource of Object.values(template.toJSON().Resources ?? {})) {
        assert.ok(
          Object.hasOwn(TYPE_TO_SERVICE, resource.Type),
          `${stackId} (${environment}) creates ${resource.Type}, which is not in the reviewed type map — classify it and extend cfn-exec-release through review`,
        );
        const service = TYPE_TO_SERVICE[resource.Type];
        if (service === null) continue;
        assert.ok(
          granted.some((a) => a.startsWith(`${service}:`)),
          `cfn-exec-release grants nothing for ${service} but ${stackId} creates ${resource.Type} — the lane would fail at its first real deploy`,
        );
      }
    }
  }
});

test('the release exec policy grants ONLY the enumerated services, with name-scoped resources', () => {
  const ALLOWED_SERVICES = ['apigateway', 'cloudwatch', 'cognito-idp', 'dynamodb', 'iam', 'kms', 'lambda', 'logs', 's3', 'sns', 'ssm'];
  for (const action of allowActions(releaseExec)) {
    const service = action.split(':')[0];
    assert.ok(ALLOWED_SERVICES.includes(service), `service "${service}" is outside the enumerated set`);
    assert.equal(action.includes('*'), false, `wildcard action "${action}" is banned in an Allow`);
  }
  assert.equal(JSON.stringify(releaseExec).includes('AdministratorAccess'), false, 'no managed admin policy, ever');
  // Every scoped resource names OUR prefixes: the app's stack families, the release bootstrap's
  // own artifacts, or the account-scoped generated-id families justified below.
  for (const stmt of releaseExec.Statement.filter((s) => s.Effect === 'Allow')) {
    for (const resource of asArray(stmt.Resource)) {
      if (resource === '*') continue; // policed by the justified-wildcard test
      assert.match(
        resource,
        /cba-study-coach-|cdk-bootstrap\/cbarel\/|cdk-cbarel-|:userpool\/\*$|:key\/\*$|:\/apis|:\/tags\/\*$/,
        `resource "${resource}" is scoped to nothing this app owns`,
      );
    }
  }
});

test('every wildcard in the release exec policy is a NAMED justified exception', () => {
  // Resource "*" appears ONLY where AWS offers no ARN to scope to: creating a Cognito pool or a
  // KMS key (no ARN exists before the resource does) and Logs query definitions/describes (no
  // scoping ARN in the action model). Anything else with "*" is a review failure by name.
  const starStatements = releaseExec.Statement.filter(
    (s) => s.Effect === 'Allow' && asArray(s.Resource).includes('*'),
  ).map((s) => s.Sid).sort();
  assert.deepEqual(starStatements, [
    'CognitoCreatePoolHasNoArnBeforeItExists',
    'KmsCreateKeyHasNoArnBeforeItExists',
    'LogsQueryDefinitionsCarryNoScopingArn',
  ]);
  // And those statements hold only their stated actions — a wildcard exception must not grow.
  const byId = Object.fromEntries(releaseExec.Statement.map((s) => [s.Sid, s]));
  assert.deepEqual(asArray(byId.CognitoCreatePoolHasNoArnBeforeItExists.Action), ['cognito-idp:CreateUserPool']);
  assert.deepEqual(asArray(byId.KmsCreateKeyHasNoArnBeforeItExists.Action), ['kms:CreateKey']);
  assert.deepEqual(asArray(byId.LogsQueryDefinitionsCarryNoScopingArn.Action).sort(), [
    'logs:DeleteQueryDefinition',
    'logs:DescribeLogGroups',
    'logs:DescribeQueryDefinitions',
    'logs:PutQueryDefinition',
  ]);
  // Wildcard ACTIONS exist only inside the explicit deny that fences the GitHub and foundation
  // roles off from the release execution role entirely.
  for (const stmt of releaseExec.Statement) {
    for (const action of asArray(stmt.Action)) {
      if (action.includes('*')) {
        assert.equal(stmt.Effect, 'Deny', `wildcard action "${action}" outside an explicit Deny`);
        assert.equal(stmt.Sid, 'DenyTouchingGithubAndFoundationRoles');
      }
    }
  }
});

test('release-created IAM authority is pinned: boundary-conditioned CreateRole, service-conditioned PassRole, fenced denies', () => {
  const byId = Object.fromEntries(releaseExec.Statement.map((s) => [s.Sid, s]));
  const createRole = byId.CreateRuntimeRolesOnlyWithPinnedBoundary;
  assert.equal(
    createRole.Condition?.StringEquals?.['iam:PermissionsBoundary'],
    'arn:aws:iam::ACCOUNT_ID_PLACEHOLDER:policy/cba-study-coach-boundary-runtime',
    'every role a release creates carries the runtime boundary',
  );
  for (const resource of asArray(createRole.Resource)) {
    assert.match(resource, /:role\/cba-study-coach-(dev|pilot)-\*$/, 'runtime roles live under the tier prefixes only');
  }
  const passRole = byId.PassRuntimeRolesToLambdaOnly;
  assert.equal(passRole.Condition?.StringEquals?.['iam:PassedToService'], 'lambda.amazonaws.com');
  const attach = byId.AttachOnlyTheLambdaBasicExecutionManagedPolicy;
  assert.equal(
    attach.Condition?.ArnEquals?.['iam:PolicyARN'],
    'arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole',
    'attachment is pinned to the one reviewed managed policy',
  );
  // The tier prefixes CANNOT reach the GitHub roles (cba-study-coach-gha-*) — and the explicit
  // deny fences them and the foundation bootstrap off even if a future edit widens a prefix.
  const fence = byId.DenyTouchingGithubAndFoundationRoles;
  assert.equal(fence.Effect, 'Deny');
  assert.ok(asArray(fence.Resource).some((r) => r.endsWith(':role/cba-study-coach-gha-*')));
  assert.ok(asArray(fence.Resource).some((r) => r.endsWith(':role/cdk-hnb659fds-*')));
  assert.ok(byId.DenyBoundaryDetachOrSwapOnRuntimeRoles, 'boundary detach/swap stays explicitly denied');
  assert.ok(byId.DenyRuntimeBoundaryPolicyMutation, 'runtime-boundary mutation stays explicitly denied');
});

test('the runtime boundary is a data-plane ceiling: own-prefix writes, read-only telemetry, nothing else', () => {
  assert.equal(runtimeBoundary.Version, '2012-10-17');
  assert.equal(releaseExec.Version, '2012-10-17');
  const WRITE_SERVICES = ['dynamodb', 'logs', 'sns'];
  for (const stmt of runtimeBoundary.Statement) {
    assert.equal(stmt.Effect, 'Allow', 'a boundary is a ceiling — pure allowlist');
    for (const action of asArray(stmt.Action)) {
      assert.equal(action.includes('*'), false, `wildcard action "${action}" is banned`);
    }
    for (const resource of asArray(stmt.Resource)) {
      if (resource === '*') {
        // The one unscoped statement is read-only telemetry (CloudWatch metrics/alarm describes
        // offer no resource scoping) — every action in it must be a read.
        for (const action of asArray(stmt.Action)) {
          assert.match(action, /:(Describe|Get)[A-Za-z]*$/, `unscoped "${action}" must be read-only`);
        }
      } else {
        assert.match(resource, /cba-study-coach-(dev|pilot)-\*/, `boundary resource "${resource}" must stay inside the tier prefixes`);
      }
    }
    for (const action of asArray(stmt.Action)) {
      const service = action.split(':')[0];
      if (!/(Describe|Get|List)/.test(action)) {
        assert.ok(WRITE_SERVICES.includes(service), `write action "${action}" is outside the runtime data plane`);
      }
    }
  }
  assert.equal(JSON.stringify(runtimeBoundary).includes('iam:'), false, 'no identity authority at runtime, ever');
  assert.equal(JSON.stringify(runtimeBoundary).includes('sts:'), false, 'no role acquisition at runtime, ever');
});

test('the deployable stacks synthesize against the RELEASE bootstrap; the foundation keeps its own', () => {
  assert.equal(RELEASE_BOOTSTRAP_QUALIFIER, 'cbarel');
  const app = new App({ context: { environment: 'dev' } });
  const stacks = buildStacks(app);
  for (const [id, stack] of [['ApiStack', stacks.api], ['DataStack', stacks.data], ['IdentityStack', stacks.identity], ['ObservabilityStack', stacks.observability]]) {
    const flat = JSON.stringify(Template.fromStack(stack).toJSON());
    assert.ok(flat.includes('/cdk-bootstrap/cbarel/version'), `${id} must check the RELEASE bootstrap version`);
    assert.equal(flat.includes('hnb659fds'), false, `${id} must not reference the foundation bootstrap`);
  }
  const securityFlat = JSON.stringify(Template.fromStack(stacks.security).toJSON());
  assert.ok(securityFlat.includes('/cdk-bootstrap/hnb659fds/version'), 'SecurityStack stays on the #66 foundation bootstrap');
  // The foundation EXECUTES only through its own bootstrap. (The deploy role's inline policy
  // legitimately NAMES the cdk-cbarel-* roles it may assume — that is authority to drive
  // releases, not an execution path for the SecurityStack itself.)
  assert.equal(securityFlat.includes('/cdk-bootstrap/cbarel/version'), false, 'the foundation cannot execute through the release bootstrap');
});

test('every role a release creates carries the runtime permissions boundary — in the real templates', () => {
  for (const environment of ['dev', 'pilot']) {
    const templates = synthDeployables(environment);
    let rolesSeen = 0;
    for (const [stackId, template] of Object.entries(templates)) {
      for (const [logicalId, role] of Object.entries(template.findResources('AWS::IAM::Role'))) {
        rolesSeen += 1;
        const boundary = JSON.stringify(role.Properties.PermissionsBoundary ?? '');
        assert.match(
          boundary,
          /cba-study-coach-boundary-runtime/,
          `${stackId}/${logicalId} (${environment}) must carry the runtime boundary — cfn-exec-release refuses to create it otherwise`,
        );
      }
    }
    assert.ok(rolesSeen >= 2, 'the discovery must actually see the runtime and gate roles');
  }
});

test('no real 12-digit account id in the release bootstrap templates', () => {
  for (const file of ['cfn-exec-release.template.json', 'runtime-boundary.template.json']) {
    const raw = readFileSync(join(POLICIES_DIR, file), 'utf8');
    assert.ok(!/\b\d{12}\b/.test(raw), `${file}: only ACCOUNT_ID_PLACEHOLDER allowed`);
    assert.ok(raw.includes('ACCOUNT_ID_PLACEHOLDER'), `${file}: placeholder expected`);
  }
});
