// Security stack (#53): encodes the #54 IAM/OIDC model from
// docs/architecture/aws-bootstrap-and-oidc.md — the GitHub OIDC identity provider and the
// blueprint-refresh Bedrock role. That doc's policy JSON is the source of truth; this stack must
// reproduce it. Synth is credential-free: account/region resolve to CloudFormation pseudo
// parameters, so no real account id ever appears in the repo or the synthesized template.
const { Stack, ArnFormat, CfnOutput } = require('aws-cdk-lib');
const iam = require('aws-cdk-lib/aws-iam');
const { getContext, parseArnList, RELEASE_BOOTSTRAP_QUALIFIERS } = require('./context');
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
    // Current pilot value: Amazon Nova Pro (#72) — Claude Sonnet 5 stays a non-blocking follow-up
    // via AWS Sales. NOTE: the permissions boundary and this role's inline policy are
    // model-specific — switching models requires new config/context PLUS a new default version of
    // the operator-managed boundary AND a SecurityStack redeploy (each human-gated).
    const inferenceProfileId = ctx('bedrockStandardInferenceProfileId', 'us.amazon.nova-pro-v1:0');
    // Routed foundation-model ARNs for the profile above. PLACEHOLDERS: enumerate the real ones
    // with `aws bedrock get-inference-profile` at bootstrap/deploy time (aws-bootstrap-and-oidc.md
    // §2) and pass them via context as a JSON array. Granting only the profile ARN fails at invoke.
    // parseArnList tolerates both the in-code array default and a `-c ...='[...]'` JSON string.
    const routedModelArns = parseArnList(
      ctx('bedrockRoutedModelArns', [
        'arn:aws:bedrock:us-east-1::foundation-model/amazon.nova-pro-v1:0',
        'arn:aws:bedrock:us-east-2::foundation-model/amazon.nova-pro-v1:0',
        'arn:aws:bedrock:us-west-2::foundation-model/amazon.nova-pro-v1:0',
      ]),
      'bedrockRoutedModelArns',
    );

    // --- GitHub OIDC identity provider (create or import) -------------------------------------
    // Native AWS::IAM::OIDCProvider (L1) — NOT iam.OpenIdConnectProvider, whose custom resource
    // would drag a plumbing Lambda + role into the template and force the CloudFormation
    // execution role to hold iam:PassRole + lambda:* (an indirect-escalation chain; #66 review).
    // ThumbprintList is omitted on purpose: IAM retrieves the thumbprint automatically and
    // validates the GitHub IdP against AWS's trusted CA store (aws-bootstrap-and-oidc.md §1).
    const providerArn = existingProviderArn
      || new iam.CfnOIDCProvider(this, 'GithubOidc', {
        url: GITHUB_OIDC_URL,
        clientIdList: ['sts.amazonaws.com'],
      }).attrArn;

    // Published so roles in other stacks consume THIS provider instead of reconstructing its ARN
    // from pseudo parameters. A reconstructed ARN synthesises fine and creates no dependency, so in
    // a clean account the role could be created before the provider exists (#82 Slice B review).
    this.githubOidcProviderArn = providerArn;

    // --- Blueprint-refresh Bedrock role (least privilege) --------------------------------------
    // Inference-profile ARN is account/region-scoped -> pseudo params keep the template id-free.
    const inferenceProfileArn = this.formatArn({
      service: 'bedrock',
      resource: 'inference-profile',
      resourceName: inferenceProfileId,
      arnFormat: ArnFormat.SLASH_RESOURCE_NAME,
    });

    // Operator-managed permissions boundary (#66): created OUTSIDE CloudFormation by the human
    // operator; it caps the role at bedrock:InvokeModel on the standard-tier profile + routed
    // models. The scoped CloudFormation execution policy pins iam:CreateRole to exactly this
    // boundary ARN and explicitly denies boundary tampering, so the CFN execution can never
    // mint a role broader than the boundary allows. Pseudo-param default keeps the template
    // id-free; override with -c bedrockRefreshBoundaryArn=... if the operator names it otherwise.
    const boundaryArn = ctx(
      'bedrockRefreshBoundaryArn',
      `arn:${this.partition}:iam::${this.account}:policy/cba-study-coach-pilot-boundary-bedrock-refresh`,
    );

    const role = new iam.Role(this, 'BedrockRefreshRole', {
      roleName: 'cba-study-coach-gha-bedrock-refresh',
      description:
        'GitHub Actions blueprint-refresh: Bedrock Converse (bedrock:InvokeModel) on the standard-tier inference profile only. No data-plane, deploy, or write permissions.',
      permissionsBoundary: iam.ManagedPolicy.fromManagedPolicyArn(this, 'BedrockRefreshBoundary', boundaryArn),
      assumedBy: new iam.WebIdentityPrincipal(providerArn, {
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

    // --- GitHub Actions deploy role (#70 Slice B1) ---------------------------------------------
    // The deployment authority the release lane assumes via OIDC — publish its ARN as the
    // Environment-scoped secret AWS_DEPLOY_ROLE_ARN (canonical name, security-rules.md §6 /
    // design §3). Trust is pinned to the GitHub ENVIRONMENT subject, not a branch: only a run
    // that passed the Environment's protection rules can mint a token with this sub. Least
    // privilege is structural: the role itself can ONLY assume the three CDK bootstrap roles
    // (deploy, file-publishing, lookup — no image-publishing: this app builds no container
    // assets), so its ceiling is whatever the #66-scoped bootstrap execution allows, and the
    // operator-managed boundary (bootstrap/policies/gha-deploy-boundary.template.json) caps it
    // at exactly that even if this inline policy ever widens. The scoped CloudFormation exec
    // policy pins iam:CreateRole for this role name to that boundary and denies boundary
    // tampering, mirroring the BedrockRefreshRole pattern above.
    const environment = ctx('environment', 'pilot');
    const deployBoundaryArn = ctx(
      'ghaDeployBoundaryArn',
      `arn:${this.partition}:iam::${this.account}:policy/cba-study-coach-boundary-gha-deploy-${environment}`,
    );
    // THIS TIER'S release bootstrap roles (per-environment qualifier, lib/context.js): the dev
    // deploy role can assume only cdk-cbardev-* — it cannot execute a pilot change, and neither
    // tier can reach the #66 SecurityStack bootstrap (hnb659fds) at all.
    const releaseQualifier = RELEASE_BOOTSTRAP_QUALIFIERS[environment];
    const cdkBootstrapRoleArn = (name) =>
      `arn:${this.partition}:iam::${this.account}:role/cdk-${releaseQualifier}-${name}-role-${this.account}-${this.region}`;

    const deployRole = new iam.Role(this, 'GithubDeployRole', {
      roleName: `cba-study-coach-gha-deploy-${environment}`,
      description:
        'GitHub Actions release lane (#70): assumes the CDK bootstrap roles to deploy the closed environment stack set through bin/deploy-release.js. No direct service permissions.',
      permissionsBoundary: iam.ManagedPolicy.fromManagedPolicyArn(this, 'GhaDeployBoundary', deployBoundaryArn),
      assumedBy: new iam.WebIdentityPrincipal(providerArn, {
        StringEquals: {
          [`${GITHUB_OIDC_HOST}:aud`]: 'sts.amazonaws.com',
          [`${GITHUB_OIDC_HOST}:sub`]: `repo:${githubRepo}:environment:${environment}`,
        },
      }),
    });

    deployRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'AssumeCdkBootstrapRolesOnly',
        actions: ['sts:AssumeRole'],
        resources: [
          cdkBootstrapRoleArn('deploy'),
          cdkBootstrapRoleArn('file-publishing'),
          cdkBootstrapRoleArn('lookup'),
        ],
      }),
    );

    // --- Conventions + outputs -----------------------------------------------------------------
    applyFoundationTags(this, environment);

    new CfnOutput(this, 'BedrockRefreshRoleArn', {
      value: role.roleArn,
      description: 'Publish as the GitHub secret AWS_BEDROCK_REFRESH_ROLE_ARN',
    });
    new CfnOutput(this, 'GithubOidcProviderArn', {
      value: providerArn,
      description: 'Account-global GitHub OIDC provider (reuse via -c githubOidcProviderArn=...)',
    });
    new CfnOutput(this, 'GithubDeployRoleArn', {
      value: deployRole.roleArn,
      description: `Publish as the ${environment} Environment secret AWS_DEPLOY_ROLE_ARN`,
    });
  }
}

module.exports = { SecurityStack };
