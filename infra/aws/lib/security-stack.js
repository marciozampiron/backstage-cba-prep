// Security stack (#53): encodes the #54 IAM/OIDC model from
// docs/architecture/aws-bootstrap-and-oidc.md — the GitHub OIDC identity provider and the
// blueprint-refresh Bedrock role. That doc's policy JSON is the source of truth; this stack must
// reproduce it. Synth is credential-free: account/region resolve to CloudFormation pseudo
// parameters, so no real account id ever appears in the repo or the synthesized template.
const { Stack, ArnFormat, CfnOutput } = require('aws-cdk-lib');
const iam = require('aws-cdk-lib/aws-iam');
const { getContext, parseArnList } = require('./context');
const { applyFoundationTags } = require('./tags');

const GITHUB_OIDC_HOST = 'token.actions.githubusercontent.com';
const GITHUB_OIDC_URL = `https://${GITHUB_OIDC_HOST}`;

class SecurityStack extends Stack {
  constructor(scope, id, props = {}) {
    super(scope, id, props);

    const ctx = (key, fallback) => getContext(this.node, key, fallback);

    // --- Parameters (CDK context; override with `cdk synth -c key=value`) ---------------------
    const githubRepo = ctx('githubRepo', 'marciozampiron/backstage-cba-prep');
    // Trust subject: repo/main for bootstrap; switch to `repo:<repo>:environment:ai-batch` when
    // the ai-batch GitHub Environment hardening lands (see aws-bootstrap-and-oidc.md §2).
    const githubTrustSub = ctx('githubTrustSub', `repo:${githubRepo}:ref:refs/heads/main`);
    // Reuse an existing account-global provider by ARN, or create one when empty.
    const existingProviderArn = ctx('githubOidcProviderArn', '');
    // Standard-tier cross-region inference profile (a model id is configuration, not a secret).
    const inferenceProfileId = ctx('bedrockStandardInferenceProfileId', 'us.anthropic.claude-sonnet-5');
    // Routed foundation-model ARNs for the profile above. PLACEHOLDERS: enumerate the real ones
    // with `aws bedrock get-inference-profile` at bootstrap/deploy time (aws-bootstrap-and-oidc.md
    // §2) and pass them via context as a JSON array. Granting only the profile ARN fails at invoke.
    // parseArnList tolerates both the in-code array default and a `-c ...='[...]'` JSON string.
    const routedModelArns = parseArnList(
      ctx('bedrockRoutedModelArns', [
        'arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-sonnet-5',
        'arn:aws:bedrock:us-east-2::foundation-model/anthropic.claude-sonnet-5',
        'arn:aws:bedrock:us-west-2::foundation-model/anthropic.claude-sonnet-5',
      ]),
      'bedrockRoutedModelArns',
    );

    // --- GitHub OIDC identity provider (create or import) -------------------------------------
    const provider = existingProviderArn
      ? iam.OpenIdConnectProvider.fromOpenIdConnectProviderArn(this, 'GithubOidc', existingProviderArn)
      : new iam.OpenIdConnectProvider(this, 'GithubOidc', {
          url: GITHUB_OIDC_URL,
          clientIds: ['sts.amazonaws.com'],
          // No thumbprints on purpose: IAM retrieves them automatically and validates the GitHub
          // IdP against AWS's trusted CA store (see aws-bootstrap-and-oidc.md §1).
        });

    // --- Blueprint-refresh Bedrock role (least privilege) --------------------------------------
    // Inference-profile ARN is account/region-scoped -> pseudo params keep the template id-free.
    const inferenceProfileArn = this.formatArn({
      service: 'bedrock',
      resource: 'inference-profile',
      resourceName: inferenceProfileId,
      arnFormat: ArnFormat.SLASH_RESOURCE_NAME,
    });

    const role = new iam.Role(this, 'BedrockRefreshRole', {
      roleName: 'cba-study-coach-gha-bedrock-refresh',
      description:
        'GitHub Actions blueprint-refresh: Bedrock Converse (bedrock:InvokeModel) on the standard-tier inference profile only. No data-plane, deploy, or write permissions.',
      assumedBy: new iam.WebIdentityPrincipal(provider.openIdConnectProviderArn, {
        StringEquals: {
          [`${GITHUB_OIDC_HOST}:aud`]: 'sts.amazonaws.com',
          [`${GITHUB_OIDC_HOST}:sub`]: githubTrustSub,
        },
      }),
    });

    role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'InvokeStandardTierViaInferenceProfile',
        actions: ['bedrock:InvokeModel'], // Converse is authorized by InvokeModel (non-streaming)
        resources: [inferenceProfileArn, ...routedModelArns],
      }),
    );

    // --- Conventions + outputs -----------------------------------------------------------------
    applyFoundationTags(this, ctx('environment', 'pilot'));

    new CfnOutput(this, 'BedrockRefreshRoleArn', {
      value: role.roleArn,
      description: 'Publish as the GitHub secret AWS_BEDROCK_REFRESH_ROLE_ARN',
    });
    new CfnOutput(this, 'GithubOidcProviderArn', {
      value: provider.openIdConnectProviderArn,
      description: 'Account-global GitHub OIDC provider (reuse via -c githubOidcProviderArn=...)',
    });
  }
}

module.exports = { SecurityStack };
