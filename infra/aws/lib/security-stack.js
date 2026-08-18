// [SPEC-IAM-001]
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
    // #117 target (Zamp, 2026-08-15): Claude Sonnet 5. The routed FM ARNs below were enumerated
    // read-only via get-inference-profile on the authorized account. NOTE: the permissions
    // boundary and this role's inline policy are model-specific — switching models requires new
    // config/context PLUS a new default version of the operator-managed boundary AND a
    // SecurityStack redeploy (each human-gated; the redeploy for #117 is a SEPARATE step).
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

    // --- GitHub Actions deploy roles (#70 Slice B1; #111 F1: BOTH tiers, ONE foundation) -------
    // The deployment authorities the release lane assumes via OIDC — each published as ITS
    // Environment's secret AWS_DEPLOY_ROLE_ARN (canonical name, security-rules.md §6 / design §3).
    // This stack used to create only the role selected by the `environment` context, which made
    // "synthesize the dev assembly" mean "a second foundation stack" — and a second stack's
    // fixed-name account-globals (the OIDC provider, the refresh role) collide with the deployed
    // ones. Both tier roles are therefore created HERE, in the single physical foundation, and the
    // `environment` context no longer reaches this stack at all: every assembly synthesizes the
    // SAME template (a test pins that invariance).
    //
    // CONSTRUCT IDS ARE LOAD-BEARING. `GithubDeployRole` is the DEPLOYED pilot role's construct id
    // (logical id GithubDeployRoleB0CF66A5 → cba-study-coach-gha-deploy-pilot, observed read-only
    // 2026-08-17); changing it would make CloudFormation REPLACE a live, trusted role. The dev
    // tier gets a NEW id, so the F1 diff is a pure addition — provider, refresh role and pilot
    // role survive untouched (a test pins the deployed logical ids).
    //
    // Trust is pinned to the GitHub ENVIRONMENT subject, not a branch: only a run that passed the
    // Environment's protection rules can mint a token with this sub. Least privilege is
    // structural, per tier: each role can ONLY assume ITS tier's three CDK bootstrap roles
    // (deploy, file-publishing, lookup — no image-publishing: this app builds no container
    // assets), so its ceiling is whatever the #66-scoped bootstrap execution allows, and the
    // TIER'S operator-managed boundary (bootstrap/policies/gha-deploy-boundary.template.json,
    // rendered per environment) caps it at exactly that even if this inline policy ever widens.
    // The scoped CloudFormation exec policy pins iam:CreateRole for BOTH role names to their
    // boundaries (a bootstrap-policies test counts the three grants) and denies boundary
    // tampering, mirroring the BedrockRefreshRole pattern above. The qualifiers keep the tiers
    // apart: dev assumes only cdk-cbardev-*, pilot only cdk-cbarpil-*, and neither tier can reach
    // the #66 SecurityStack bootstrap (hnb659fds) at all.
    const deployBoundaryArns = {
      pilot: ctx(
        'ghaDeployBoundaryArnPilot',
        `arn:${this.partition}:iam::${this.account}:policy/cba-study-coach-boundary-gha-deploy-pilot`,
      ),
      dev: ctx(
        'ghaDeployBoundaryArnDev',
        `arn:${this.partition}:iam::${this.account}:policy/cba-study-coach-boundary-gha-deploy-dev`,
      ),
    };
    const deployRoles = {};
    for (const [tier, ids] of [
      ['pilot', { role: 'GithubDeployRole', boundary: 'GhaDeployBoundary' }],
      ['dev', { role: 'GithubDeployRoleDev', boundary: 'GhaDeployBoundaryDev' }],
    ]) {
      const releaseQualifier = RELEASE_BOOTSTRAP_QUALIFIERS[tier];
      const cdkBootstrapRoleArn = (name) =>
        `arn:${this.partition}:iam::${this.account}:role/cdk-${releaseQualifier}-${name}-role-${this.account}-${this.region}`;

      const deployRole = new iam.Role(this, ids.role, {
        roleName: `cba-study-coach-gha-deploy-${tier}`,
        description:
          'GitHub Actions release lane (#70): assumes the CDK bootstrap roles to deploy the closed environment stack set through bin/deploy-release.js. No direct service permissions.',
        permissionsBoundary: iam.ManagedPolicy.fromManagedPolicyArn(this, ids.boundary, deployBoundaryArns[tier]),
        assumedBy: new iam.WebIdentityPrincipal(providerArn, {
          StringEquals: {
            [`${GITHUB_OIDC_HOST}:aud`]: 'sts.amazonaws.com',
            [`${GITHUB_OIDC_HOST}:sub`]: `repo:${githubRepo}:environment:${tier}`,
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

      deployRoles[tier] = deployRole;
    }

    // --- Conventions + outputs -----------------------------------------------------------------
    // Tag family pinned to the DEPLOYED foundation's values (#111 F1): this physical stack was
    // created under the pilot family and tags reach every resource in it — a tag flip would touch
    // the account-globals in the same update that must otherwise be a pure addition. The
    // foundation is account-global; its Environment tag records history, not tier selection.
    applyFoundationTags(this, 'pilot');

    new CfnOutput(this, 'BedrockRefreshRoleArn', {
      value: role.roleArn,
      description: 'Publish as the GitHub secret AWS_BEDROCK_REFRESH_ROLE_ARN',
    });
    new CfnOutput(this, 'GithubOidcProviderArn', {
      value: providerArn,
      description: 'Account-global GitHub OIDC provider (reuse via -c githubOidcProviderArn=...)',
    });
    // Separate outputs per tier (#111 F1). The pilot one keeps its DEPLOYED output id and text —
    // `${environment}` resolved to "pilot" in the deployed template, so the literal preserves it.
    new CfnOutput(this, 'GithubDeployRoleArn', {
      value: deployRoles.pilot.roleArn,
      description: 'Publish as the pilot Environment secret AWS_DEPLOY_ROLE_ARN',
    });
    new CfnOutput(this, 'GithubDeployRoleDevArn', {
      value: deployRoles.dev.roleArn,
      description: 'Publish as the dev Environment secret AWS_DEPLOY_ROLE_ARN',
    });
  }
}

module.exports = { SecurityStack };
