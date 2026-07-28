// Identity stack (#69 Slice A — promoted from the #53 placeholder).
// The trusted-principal foundation for the deployed BFF: ONE environment-scoped Cognito User
// Pool plus a PUBLIC, PKCE-READY SPA client (authorization code grant only, NO client secret —
// a browser app cannot keep one). The API Gateway JWT authorizer wired by the ApiStack validates tokens
// against this pool; claim -> neutral-principal mapping is the #69 Slice B adapter's job and
// NEVER lives in CDK code.
//
// Security posture (issue #69 kickoff, binding):
//   - Public client, `generateSecret: false`; hosted OAuth endpoints serve ONLY the
//     authorization-code flow — implicit grant OFF and every direct auth flow (SRP, password,
//     custom) explicitly disabled, so the template synthesizes exactly
//     ExplicitAuthFlows=[ALLOW_REFRESH_TOKEN_AUTH]. The infrastructure is PKCE-READY: PKCE
//     itself is executed by the SPA (code_verifier/code_challenge S256) and is proven in
//     Slice C — nothing in this template can demonstrate it.
//   - Callback/logout URLs are EXACT configuration values (context `authCallbackUrls` /
//     `authLogoutUrls`, validated: https-only except localhost, wildcards forbidden). The
//     committed defaults are localhost (dev) and a `.invalid` placeholder (pilot) that #70
//     replaces at deploy time with the real Cloudflare origin (#67 owns that value).
//   - Self sign-up DISABLED: the pilot is invite-only; users are created by an operator action
//     (human-gated, out of scope here).
//   - Environment posture mirrors the DataStack: pilot durable (deletion protection + RETAIN),
//     dev disposable.
// No account ids, ARNs, tokens, or secrets are committed or synthesized into tracked files.
const { Stack, Duration, RemovalPolicy, CfnOutput } = require('aws-cdk-lib');
const cognito = require('aws-cdk-lib/aws-cognito');
const { getContext, parseExactUrlList, resolveEnvironment } = require('./context');
const { applyFoundationTags } = require('./tags');

// Deploy-time overrides (#70): -c 'authCallbackUrls=["https://<real-frontend>/auth/callback"]'.
// `.invalid` is the RFC 2606 reserved TLD — the pilot default can never resolve by accident.
const DEFAULT_URLS = {
  dev: {
    callback: ['http://localhost:3000/auth/callback'],
    logout: ['http://localhost:3000/'],
  },
  pilot: {
    callback: ['https://pilot.invalid/auth/callback'],
    logout: ['https://pilot.invalid/'],
  },
};

class IdentityStack extends Stack {
  constructor(scope, id, props = {}) {
    super(scope, id, props);
    const environment = resolveEnvironment(this.node, props.environment || 'pilot');
    const durable = environment === 'pilot';
    applyFoundationTags(this, environment);

    const callbackUrls = parseExactUrlList(
      getContext(this.node, 'authCallbackUrls', DEFAULT_URLS[environment].callback),
      'authCallbackUrls',
    );
    const logoutUrls = parseExactUrlList(
      getContext(this.node, 'authLogoutUrls', DEFAULT_URLS[environment].logout),
      'authLogoutUrls',
    );

    this.userPool = new cognito.UserPool(this, 'LearnerUserPool', {
      userPoolName: `cba-study-coach-${environment}-users`,
      selfSignUpEnabled: false,
      signInAliases: { email: true },
      autoVerify: { email: true },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      passwordPolicy: {
        minLength: 12,
        requireLowercase: true,
        requireUppercase: true,
        requireDigits: true,
        requireSymbols: true,
      },
      deletionProtection: durable,
      removalPolicy: durable ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
    });

    // Hosted OAuth endpoints need a domain; the prefix is configuration (globally unique per
    // region). No custom domain/certificate in the pilot, and the CLASSIC hosted UI is pinned —
    // the newer managed login tier is a paid feature the pilot does not need.
    this.userPoolDomain = this.userPool.addDomain('LearnerAuthDomain', {
      cognitoDomain: {
        domainPrefix: getContext(this.node, 'authDomainPrefix', `cba-study-coach-${environment}`),
      },
      managedLoginVersion: cognito.ManagedLoginVersion.CLASSIC_HOSTED_UI,
    });

    // --- #75 smoke capability -------------------------------------------------------------------
    // The group whose members may operate smoke runs. It exists HERE because the BFF reads it from
    // the validated `cognito:groups` claim, and a capability the platform never provisions is a
    // 403 waiting for #70 to invent an untracked step.
    //
    // The group is created; MEMBERSHIP IS NOT. Adding the dedicated smoke learners is a human-gated
    // operator action, done once per environment — precisely so the deploy workflow never needs a
    // Cognito admin permission. No `AWS::Cognito::UserPoolUserToGroupAttachment` belongs here.
    this.smokeGroup = new cognito.CfnUserPoolGroup(this, 'SmokeOperators', {
      userPoolId: this.userPool.userPoolId,
      groupName: 'cba-smoke',
      description: 'Deployed-smoke operators (#75). Membership is assigned by a human operator, never by CI.',
      precedence: 10,
    });

    this.userPoolClient = this.userPool.addClient('WebSpaClient', {
      userPoolClientName: `cba-study-coach-${environment}-web`,
      generateSecret: false,
      preventUserExistenceErrors: true,
      // Every DIRECT auth flow is explicitly OFF — omitting authFlows would let Cognito default
      // to ALLOW_USER_SRP_AUTH + ALLOW_CUSTOM_AUTH, contradicting "authorization code only".
      // Refresh-token auth is the single remaining explicit flow (session renewal).
      authFlows: {
        userSrp: false,
        userPassword: false,
        adminUserPassword: false,
        custom: false,
      },
      oAuth: {
        flows: { authorizationCodeGrant: true },
        scopes: [cognito.OAuthScope.OPENID, cognito.OAuthScope.EMAIL, cognito.OAuthScope.PROFILE],
        callbackUrls,
        logoutUrls,
      },
      accessTokenValidity: Duration.minutes(60),
      idTokenValidity: Duration.minutes(60),
      refreshTokenValidity: Duration.days(30),
    });

    // Programmatically-created clients get NO hosted-UI branding by default and the login pages
    // are not served until a customization exists — attach the (default-CSS) customization
    // explicitly so the classic hosted UI is actually usable. Requires the domain to exist.
    const uiCustomization = new cognito.CfnUserPoolUICustomizationAttachment(this, 'HostedUiBranding', {
      userPoolId: this.userPool.userPoolId,
      clientId: this.userPoolClient.userPoolClientId,
      css: '.label-customizable { font-weight: 400; }',
    });
    uiCustomization.node.addDependency(this.userPoolDomain);

    // Config names per pilot-environment-contract.md §3 (#47) — ids are configuration, not
    // secrets; no ARN/account output.
    new CfnOutput(this, 'CognitoUserPoolId', {
      value: this.userPool.userPoolId,
      description: 'Publish as COGNITO_USER_POOL_ID for the environment (configuration, not secret).',
    });
    new CfnOutput(this, 'CognitoClientId', {
      value: this.userPoolClient.userPoolClientId,
      description: 'Publish as COGNITO_CLIENT_ID for the environment (configuration, not secret).',
    });
  }
}

module.exports = { IdentityStack };
