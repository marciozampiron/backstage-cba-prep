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
const { buildStacks, RELEASE_BOOTSTRAP_QUALIFIERS } = require('../lib/app');
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

test('the release exec policy grants ONLY the enumerated services, with tier-scoped resources', () => {
  const ALLOWED_SERVICES = ['apigateway', 'cloudwatch', 'cognito-idp', 'dynamodb', 'iam', 'kms', 'lambda', 'logs', 's3', 'sns', 'ssm'];
  for (const action of allowActions(releaseExec)) {
    const service = action.split(':')[0];
    assert.ok(ALLOWED_SERVICES.includes(service), `service "${service}" is outside the enumerated set`);
    assert.equal(action.includes('*'), false, `wildcard action "${action}" is banned in an Allow`);
  }
  assert.equal(JSON.stringify(releaseExec).includes('AdministratorAccess'), false, 'no managed admin policy, ever');
  // Every scoped resource names OUR prefixes — and the template is PER ENVIRONMENT (round 4):
  // one rendering per tier, so a rendered dev policy contains not one pilot resource.
  for (const stmt of releaseExec.Statement.filter((s) => s.Effect === 'Allow')) {
    for (const resource of asArray(stmt.Resource)) {
      if (resource === '*') continue; // policed by the justified-wildcard test
      assert.match(
        resource,
        /cba-study-coach-ENVIRONMENT_PLACEHOLDER-|cdk-bootstrap\/QUALIFIER_PLACEHOLDER\/|cdk-QUALIFIER_PLACEHOLDER-|:userpool\/\*$|:key\/\*$|:\/apis|:\/tags\/\*$/,
        `resource "${resource}" is scoped to nothing this tier owns`,
      );
    }
  }
  // Rendered per tier, nothing leaks across: the dev rendering names no pilot resource and no
  // pilot qualifier, and vice versa; every placeholder renders.
  for (const [env, qualifier, other, otherQ] of [['dev', 'cbardev', 'pilot', 'cbarpil'], ['pilot', 'cbarpil', 'dev', 'cbardev']]) {
    const rendered = JSON.stringify(releaseExec)
      .replaceAll('ACCOUNT_ID_PLACEHOLDER', '111122223333')
      .replaceAll('ENVIRONMENT_PLACEHOLDER', env)
      .replaceAll('QUALIFIER_PLACEHOLDER', qualifier);
    assert.equal(rendered.includes('PLACEHOLDER'), false, 'every placeholder renders');
    assert.equal(rendered.includes(`cba-study-coach-${other}-`), false, `${env} authority must not name ${other} resources`);
    assert.equal(rendered.includes(otherQ), false, `${env} authority must not name the ${other} bootstrap`);
  }
});

test('every wildcard is a NAMED exception, and each is confined by the PROJECT AND TIER TAGS', () => {
  // Round 4: "generated id" establishes no ownership. Where AWS offers no ARN to scope to, the
  // statement must instead demand the project + environment tags — on the REQUEST for creation
  // (the resource does not exist yet) and on the RESOURCE for lifecycle. Logs query definitions
  // carry neither ARN nor tags: they stay a named, read-mostly exception.
  const byId = Object.fromEntries(releaseExec.Statement.map((s) => [s.Sid, s]));
  const starStatements = releaseExec.Statement.filter(
    (s) => s.Effect === 'Allow' && asArray(s.Resource).includes('*'),
  ).map((s) => s.Sid).sort();
  assert.deepEqual(starStatements, [
    'CognitoCreateOnlyProjectTaggedPools',
    'KmsCreateOnlyProjectTaggedKeys',
    'LogsQueryDefinitionsCarryNoScopingArn',
  ]);
  const REQUEST_TAGGED = { 'aws:RequestTag/Project': 'CBAStudyCoach', 'aws:RequestTag/Environment': 'ENVIRONMENT_PLACEHOLDER' };
  const RESOURCE_TAGGED = { 'aws:ResourceTag/Project': 'CBAStudyCoach', 'aws:ResourceTag/Environment': 'ENVIRONMENT_PLACEHOLDER' };
  assert.deepEqual(asArray(byId.CognitoCreateOnlyProjectTaggedPools.Action), ['cognito-idp:CreateUserPool']);
  assert.deepEqual(byId.CognitoCreateOnlyProjectTaggedPools.Condition.StringEquals, REQUEST_TAGGED);
  assert.deepEqual(asArray(byId.KmsCreateOnlyProjectTaggedKeys.Action), ['kms:CreateKey']);
  assert.deepEqual(byId.KmsCreateOnlyProjectTaggedKeys.Condition.StringEquals, REQUEST_TAGGED);
  // Lifecycle over generated-id families demands the RESOURCE tags — a foreign pool or key,
  // whoever created it, refuses by tag, not by luck of the id.
  assert.deepEqual(byId.CognitoLifecycleOnlyOnProjectTaggedPools.Condition.StringEquals, RESOURCE_TAGGED);
  assert.deepEqual(byId.KmsKeyLifecycleOnlyOnProjectTaggedKeys.Condition.StringEquals, RESOURCE_TAGGED);
  assert.ok(asArray(byId.KmsKeyLifecycleOnlyOnProjectTaggedKeys.Action).includes('kms:ScheduleKeyDeletion'), 'the destructive KMS actions are exactly the tag-confined ones');
  // API Gateway: creation demands the request tags; sub-resources are UNTAGGABLE in the service
  // model — a NAMED residual (account+region+path scope only), stated for Zamp's risk decision,
  // with account isolation as the recorded alternative.
  assert.deepEqual(byId.ApiGatewayV2CreateOnlyProjectTaggedApis.Condition.StringEquals, REQUEST_TAGGED);
  assert.equal(byId.ApiGatewayV2CreateOnlyProjectTaggedApis.Resource, 'arn:aws:apigateway:us-east-1::/apis');
  assert.ok(byId.ApiGatewayV2SubresourcesNamedResidualUntaggable, 'the residual is NAMED, never implicit');
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
    'arn:aws:iam::ACCOUNT_ID_PLACEHOLDER:policy/cba-study-coach-boundary-runtime-ENVIRONMENT_PLACEHOLDER',
    "every role a release creates carries THIS TIER'S runtime boundary",
  );
  for (const resource of asArray(createRole.Resource)) {
    assert.match(resource, /:role\/cba-study-coach-ENVIRONMENT_PLACEHOLDER-\*$/, "runtime roles live under this tier's prefix only");
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
        assert.match(resource, /cba-study-coach-ENVIRONMENT_PLACEHOLDER-\*/, `boundary resource "${resource}" must stay inside this tier's prefix`);
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

test('each tier synthesizes against ITS OWN release bootstrap; the foundation keeps its own', () => {
  assert.deepEqual(RELEASE_BOOTSTRAP_QUALIFIERS, { dev: 'cbardev', pilot: 'cbarpil' });
  for (const [environment, qualifier, otherQualifier] of [['dev', 'cbardev', 'cbarpil'], ['pilot', 'cbarpil', 'cbardev']]) {
    const app = new App({ context: { environment } });
    const stacks = buildStacks(app);
    for (const [id, stack] of [['ApiStack', stacks.api], ['DataStack', stacks.data], ['IdentityStack', stacks.identity], ['ObservabilityStack', stacks.observability]]) {
      const flat = JSON.stringify(Template.fromStack(stack).toJSON());
      assert.ok(flat.includes(`/cdk-bootstrap/${qualifier}/version`), `${id} (${environment}) must check ITS tier's bootstrap version`);
      assert.equal(flat.includes('hnb659fds'), false, `${id} must not reference the foundation bootstrap`);
      assert.equal(flat.includes(otherQualifier), false, `${id} (${environment}) must not reference the other tier's bootstrap`);
    }
    const securityFlat = JSON.stringify(Template.fromStack(stacks.security).toJSON());
    assert.ok(securityFlat.includes('/cdk-bootstrap/hnb659fds/version'), 'SecurityStack stays on the #66 foundation bootstrap');
    // The foundation EXECUTES only through its own bootstrap. (The deploy role's inline policy
    // legitimately NAMES the cdk-<qualifier>-* roles it may assume — that is authority to drive
    // releases, not an execution path for the SecurityStack itself.)
    assert.equal(securityFlat.includes(`/cdk-bootstrap/${qualifier}/version`), false, 'the foundation cannot execute through a release bootstrap');
  }
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
