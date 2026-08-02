// Stack assembly for the CDK app (#77 review fix): the stack-name base derives from the
// `environment` context — NEVER a hardcoded tier — so `-c environment=dev` produces
// cba-study-coach-dev-* stacks and can no longer update a pilot stack by accident.
// Extracted from bin/cba-pilot.js so tests can assert the REAL app wiring.
const { DefaultStackSynthesizer } = require('aws-cdk-lib');
const iam = require('aws-cdk-lib/aws-iam');
const { resolveEnvironment, getContext } = require('./context');
const { SecurityStack } = require('./security-stack');
const { IdentityStack } = require('./identity-stack');
const { DataStack } = require('./data-stack');
const { ApiStack } = require('./api-stack');
const { AiOrchestrationStack } = require('./ai-orchestration-stack');
const { ObservabilityStack } = require('./observability-stack');

// THE RELEASE BOOTSTRAP (#70 Slice B1 round 3). The DEPLOYABLE stacks synthesize against their
// OWN CDK bootstrap qualifier, so a release executes through the release CloudFormation execution
// role — whose versioned policy (bootstrap/policies/cfn-exec-release.template.json) enumerates
// exactly what the four environment templates create — while the SecurityStack keeps the default
// qualifier and the #66-scoped execution policy that can create NOTHING but its reviewed
// artifacts. One execution role per blast radius; neither can perform the other's job. The
// qualifier is a REVIEWED CONSTANT, never context: a configurable qualifier would let a deploy
// re-aim itself at a differently-privileged bootstrap.
const RELEASE_BOOTSTRAP_QUALIFIER = 'cbarel';

// Every role a RELEASE creates carries the operator-managed runtime permissions boundary: the
// release execution role may only create boundary-capped roles (cfn-exec-release pins
// iam:CreateRole to this boundary), so a template edit cannot mint runtime authority beyond the
// reviewed ceiling — dynamodb/logs on cba-study-coach data, read-only telemetry, nothing else.
function applyRuntimeBoundary(stack) {
  const node = stack.node;
  const arn = getContext(node, 'runtimeBoundaryArn', `arn:${stack.partition}:iam::${stack.account}:policy/cba-study-coach-boundary-runtime`);
  iam.PermissionsBoundary.of(stack).apply(iam.ManagedPolicy.fromManagedPolicyArn(stack, 'CbaRuntimeBoundary', arn));
  return stack;
}

function buildStacks(app) {
  const environment = resolveEnvironment(app.node);
  const base = `cba-study-coach-${environment}`;
  const releaseSynthesizer = () => new DefaultStackSynthesizer({ qualifier: RELEASE_BOOTSTRAP_QUALIFIER });

  const security = new SecurityStack(app, 'SecurityStack', {
    stackName: `${base}-security`,
    description:
      'CBA Study Coach pilot security: GitHub OIDC provider + blueprint-refresh Bedrock role (#53/#54). Synth-only in CI; deploys are human-gated.',
  });

  return {
    environment,
    security,
    ...(function () {
      // Explicit references (#77/#69 decisions): DataStack owns the table, IdentityStack owns
      // the Cognito pool + SPA client, ApiStack owns the runtime role's scoped grants AND the
      // JWT authorizer that trusts the pool.
      const identity = applyRuntimeBoundary(new IdentityStack(app, 'IdentityStack', { stackName: `${base}-identity`, synthesizer: releaseSynthesizer() }));
      const data = applyRuntimeBoundary(new DataStack(app, 'DataStack', { stackName: `${base}-data`, synthesizer: releaseSynthesizer() }));
      const api = new ApiStack(app, 'ApiStack', {
        stackName: `${base}-api`,
        synthesizer: releaseSynthesizer(),
        table: data.table,
        userPool: identity.userPool,
        userPoolClient: identity.userPoolClient,
        userPoolDomain: identity.userPoolDomain,
      });
      // #82 Slice B: the ObservabilityStack composes metrics and notifications over resources it
      // does NOT own. Every reference is explicit, so a rename in ApiStack/DataStack breaks synth
      // here instead of silently producing alarms and widgets that watch nothing.
      const observability = new ObservabilityStack(app, 'ObservabilityStack', {
        stackName: `${base}-observability`,
        synthesizer: releaseSynthesizer(),
        httpApi: api.httpApi,
        bffFunction: api.bffFunction,
        bffLogGroup: api.bffLogGroup,
        accessLogGroup: api.accessLogGroup,
        table: data.table,
        // The gate role trusts the provider SecurityStack owns. Passing the reference makes the
        // dependency real instead of implied; the explicit addDependency below covers the case
        // where an operator supplies an already-existing provider ARN by context, which produces
        // no CloudFormation reference and therefore no ordering on its own.
        githubOidcProviderArn: security.githubOidcProviderArn,
      });
      observability.addDependency(security);
      applyRuntimeBoundary(api);
      applyRuntimeBoundary(observability);
      return { identity, data, api, observability };
    })(),
    aiOrchestration: new AiOrchestrationStack(app, 'AiOrchestrationStack', {
      stackName: `${base}-ai-orchestration`,
    }),
  };
}

module.exports = { buildStacks, RELEASE_BOOTSTRAP_QUALIFIER };
