#!/usr/bin/env node
// CDK app entry for the CBA Study Coach AWS pilot (#53/#49).
// Env-agnostic on purpose: no `env` is set, so `cdk synth` needs no AWS credentials or account
// lookups; account/region stay as CloudFormation pseudo parameters until a human-gated deploy
// targets a real environment. The security stack has real resources (#54); the rest are
// placeholders that the owning tracks fill (see docs/architecture/aws-iac-foundation.md).
const cdk = require('aws-cdk-lib');
const { SecurityStack } = require('../lib/security-stack');
const { IdentityStack } = require('../lib/identity-stack');
const { DataStack } = require('../lib/data-stack');
const { ApiStack } = require('../lib/api-stack');
const { AiOrchestrationStack } = require('../lib/ai-orchestration-stack');
const { ObservabilityStack } = require('../lib/observability-stack');

const app = new cdk.App();
const base = 'cba-study-coach-pilot';

new SecurityStack(app, 'SecurityStack', {
  stackName: `${base}-security`,
  description:
    'CBA Study Coach pilot security: GitHub OIDC provider + blueprint-refresh Bedrock role (#53/#54). Synth-only in CI; deploys are human-gated.',
});
new IdentityStack(app, 'IdentityStack', { stackName: `${base}-identity` });
new DataStack(app, 'DataStack', { stackName: `${base}-data` });
new ApiStack(app, 'ApiStack', { stackName: `${base}-api` });
new AiOrchestrationStack(app, 'AiOrchestrationStack', { stackName: `${base}-ai-orchestration` });
new ObservabilityStack(app, 'ObservabilityStack', { stackName: `${base}-observability` });

app.synth();
