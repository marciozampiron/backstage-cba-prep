// Stack assembly for the CDK app (#77 review fix): the stack-name base derives from the
// `environment` context — NEVER a hardcoded tier — so `-c environment=dev` produces
// cba-study-coach-dev-* stacks and can no longer update a pilot stack by accident.
// Extracted from bin/cba-pilot.js so tests can assert the REAL app wiring.
const { DefaultStackSynthesizer } = require('aws-cdk-lib');
const iam = require('aws-cdk-lib/aws-iam');
const { resolveEnvironment, getContext, RELEASE_BOOTSTRAP_QUALIFIERS, stackNameFor } = require('./context');
const { SecurityStack } = require('./security-stack');
const { IdentityStack } = require('./identity-stack');
const { DataStack } = require('./data-stack');
const { ApiStack } = require('./api-stack');
const { AiOrchestrationStack } = require('./ai-orchestration-stack');
const { ObservabilityStack } = require('./observability-stack');

// THE RELEASE BOOTSTRAPS (#70 Slice B1 rounds 3–4). The DEPLOYABLE stacks synthesize against
// their tier's OWN CDK bootstrap qualifier (round 4: one PER ENVIRONMENT — dev authority must
// reach only dev), so a release executes through that tier's CloudFormation execution role —
// whose versioned policy (bootstrap/policies/cfn-exec-release.template.json, rendered per
// environment) enumerates exactly what the four environment templates create — while the
// SecurityStack keeps the default qualifier and the #66-scoped execution policy that can create
// NOTHING but its reviewed artifacts. One execution role per blast radius; none can perform
// another's job. The qualifiers are REVIEWED CONSTANTS in lib/context.js, never context values.

// Every role a RELEASE creates carries the operator-managed runtime permissions boundary — the
// TIER'S boundary (round 4: per environment, like everything else in the release chain): the
// release execution role may only create boundary-capped roles (cfn-exec-release pins
// iam:CreateRole to this boundary), so a template edit cannot mint runtime authority beyond the
// reviewed ceiling — dynamodb/logs on this tier's data, read-only telemetry, nothing else.
function applyRuntimeBoundary(stack, environment) {
  const node = stack.node;
  const arn = getContext(node, 'runtimeBoundaryArn', `arn:${stack.partition}:iam::${stack.account}:policy/cba-study-coach-boundary-runtime-${environment}`);
  iam.PermissionsBoundary.of(stack).apply(iam.ManagedPolicy.fromManagedPolicyArn(stack, 'CbaRuntimeBoundary', arn));
  return stack;
}

function buildStacks(app) {
  const environment = resolveEnvironment(app.node);
  const base = `cba-study-coach-${environment}`;
  const releaseSynthesizer = () => new DefaultStackSynthesizer({ qualifier: RELEASE_BOOTSTRAP_QUALIFIERS[environment] });

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
      const identity = applyRuntimeBoundary(new IdentityStack(app, 'IdentityStack', { stackName: stackNameFor(environment, 'IdentityStack'), synthesizer: releaseSynthesizer() }), environment);
      const data = applyRuntimeBoundary(new DataStack(app, 'DataStack', { stackName: stackNameFor(environment, 'DataStack'), synthesizer: releaseSynthesizer() }), environment);
      const api = new ApiStack(app, 'ApiStack', {
        stackName: stackNameFor(environment, 'ApiStack'),
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
        stackName: stackNameFor(environment, 'ObservabilityStack'),
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
      applyRuntimeBoundary(api, environment);
      applyRuntimeBoundary(observability, environment);
      return { identity, data, api, observability };
    })(),
    aiOrchestration: new AiOrchestrationStack(app, 'AiOrchestrationStack', {
      stackName: `${base}-ai-orchestration`,
    }),
  };
}

module.exports = { buildStacks, RELEASE_BOOTSTRAP_QUALIFIERS };
