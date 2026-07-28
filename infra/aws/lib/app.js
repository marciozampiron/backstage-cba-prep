// Stack assembly for the CDK app (#77 review fix): the stack-name base derives from the
// `environment` context — NEVER a hardcoded tier — so `-c environment=dev` produces
// cba-study-coach-dev-* stacks and can no longer update a pilot stack by accident.
// Extracted from bin/cba-pilot.js so tests can assert the REAL app wiring.
const { resolveEnvironment } = require('./context');
const { SecurityStack } = require('./security-stack');
const { IdentityStack } = require('./identity-stack');
const { DataStack } = require('./data-stack');
const { ApiStack } = require('./api-stack');
const { AiOrchestrationStack } = require('./ai-orchestration-stack');
const { ObservabilityStack } = require('./observability-stack');

function buildStacks(app) {
  const environment = resolveEnvironment(app.node);
  const base = `cba-study-coach-${environment}`;

  return {
    environment,
    security: new SecurityStack(app, 'SecurityStack', {
      stackName: `${base}-security`,
      description:
        'CBA Study Coach pilot security: GitHub OIDC provider + blueprint-refresh Bedrock role (#53/#54). Synth-only in CI; deploys are human-gated.',
    }),
    ...(function () {
      // Explicit references (#77/#69 decisions): DataStack owns the table, IdentityStack owns
      // the Cognito pool + SPA client, ApiStack owns the runtime role's scoped grants AND the
      // JWT authorizer that trusts the pool.
      const identity = new IdentityStack(app, 'IdentityStack', { stackName: `${base}-identity` });
      const data = new DataStack(app, 'DataStack', { stackName: `${base}-data` });
      const api = new ApiStack(app, 'ApiStack', {
        stackName: `${base}-api`,
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
        httpApi: api.httpApi,
        bffFunction: api.bffFunction,
        bffLogGroup: api.bffLogGroup,
        accessLogGroup: api.accessLogGroup,
        table: data.table,
      });
      return { identity, data, api, observability };
    })(),
    aiOrchestration: new AiOrchestrationStack(app, 'AiOrchestrationStack', {
      stackName: `${base}-ai-orchestration`,
    }),
  };
}

module.exports = { buildStacks };
