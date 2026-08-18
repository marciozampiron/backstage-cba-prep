// Pure context helpers for the CDK app — no CDK imports, so they unit-test offline.

function getContext(node, key, fallback) {
  // Runtime refusal, as defense in depth behind the discovery test (#70 round 5): a stack that
  // reads a key outside the closed contract fails SYNTH loudly, instead of quietly consuming
  // configuration the deploy manifest never bound. `tryGetContext` is called nowhere else — a
  // test forbids it outside this file — so this is the one door a context value can enter by.
  if (!READABLE_CONTEXT_KEYS.has(key)) {
    throw new Error(
      `context key "${key}" is outside the closed deploy contract (DEPLOY_CONTEXT_KEYS in lib/context.js). ` +
        'Add it to the contract so the #70 manifest binds it — an unbound key is configuration a deploy can drift on.',
    );
  }
  const value = node.tryGetContext(key);
  return value === undefined ? fallback : value;
}

// Deployment tiers are a CLOSED set (#77 review): `-c environment=production` (or a typo, or an
// empty value) must FAIL SYNTH instead of silently minting a new stack family with the
// non-durable dev posture (no PITR, no deletion protection, DeletionPolicy=Delete).
const VALID_ENVIRONMENTS = ['dev', 'pilot'];

// Committed Cognito callback/logout defaults (#69), and the domain-prefix default they travel with.
//
// These live HERE, not inside `identity-stack.js`, because #70's deploy preflight has to evaluate
// the exact values the stack will deploy. A preflight with its own copy of the defaults can pass
// while the stack synthesizes something else — the check would be measuring itself. One definition,
// two readers.
//
// `.invalid` is the RFC 2606 reserved TLD: the pilot default can never resolve by accident, and
// PREFLIGHT-1 refuses to deploy while it survives into the effective configuration.
const DEFAULT_AUTH_URLS = {
  dev: {
    callback: ['http://localhost:3000/auth/callback'],
    logout: ['http://localhost:3000/'],
  },
  pilot: {
    callback: ['https://pilot.invalid/auth/callback'],
    logout: ['https://pilot.invalid/'],
  },
};

// The fallback the stack applies when `authDomainPrefix` is absent. PREFLIGHT-2 exists BECAUSE this
// fallback is silent: an unsupplied prefix is indistinguishable from a deliberate one at synth time.
function defaultAuthDomainPrefix(environment) {
  return `cba-study-coach-${environment}`;
}

// THE CLOSED DEPLOY-CONTEXT CONTRACT (#70 round 4).
//
// Every context key any stack consumes, except `environment` (bound separately in the manifest
// digest). The #70 preflight manifest binds ALL of these: the first version bound only the three
// auth keys, and changing `githubTrustSub` or `corsAllowedOrigins` produced the exact same digest —
// which means a deploy could alter IAM trust or CORS without invalidating the manifest that
// authorized it. A discovery test scans the stack sources for context reads and refuses any key
// that is not on this list, so a new key cannot be consumed without joining the contract.
const DEPLOY_CONTEXT_KEYS = [
  'authCallbackUrls',
  'authDomainPrefix',
  'authLogoutUrls',
  'bedrockRefreshBoundaryArn',
  'bedrockRoutedModelArns',
  'bedrockStandardInferenceProfileId',
  'corsAllowedOrigins',
  'githubOidcProviderArn',
  'githubRepo',
  'githubTrustSub',
  'runtimeBoundaryArn',
];

// THE CLOSED DEPLOY EFFECT (#70 Slice B1 review). `cdk deploy --all` deploys whatever the app
// happens to contain — which today includes the account-global SecurityStack (OIDC provider,
// GitHub roles) and the deferred AiOrchestrationStack, and tomorrow includes whatever stack
// anyone adds. The manifest therefore names the EXACT stack set a release deploys, and the
// entrypoint passes exactly that set with `--exclusively`. Every stack the app constructs must be
// classified here — a discovery test refuses an unclassified stack, so a new stack can neither
// ride into the deploy effect nor silently fall out of it without joining a list through review.
// [SPEC-DEPLOY-015]
const DEPLOYABLE_STACK_IDS = Object.freeze(['ApiStack', 'DataStack', 'IdentityStack', 'ObservabilityStack']);
// Excluded each for a stated reason — not "not yet": SecurityStack is the account-global
// foundation (OIDC provider + GitHub roles), deployed only by the human operator under the #66
// scoped bootstrap; AiOrchestrationStack is a deferred placeholder with no reviewed deployment
// decision behind it.
// [SPEC-DEPLOY-015]
const EXCLUDED_STACK_IDS = Object.freeze(['AiOrchestrationStack', 'SecurityStack']);

// THE ONE PHYSICAL FOUNDATION (#111 F1). The SecurityStack owns account-global, fixed-name
// resources — the GitHub OIDC provider, the blueprint-refresh role, and BOTH tiers' deploy
// roles — so there is exactly ONE deployed instance, and every assembly (dev or pilot) must
// reference it by this name. The name is historical: the stack was deployed before the dev tier
// existed, and a CloudFormation stack cannot be renamed — a "rename" is a delete-and-recreate of
// everything it owns, including the provider every OIDC trust in the account points at. Reviewed
// constant, never context, for the same reason as the qualifiers below.
const FOUNDATION_STACK_NAME = 'cba-study-coach-pilot-security';

// PER-ENVIRONMENT release bootstraps (#70 Slice B1 round 4). One qualifier — one toolkit stack,
// one set of cdk-<qualifier>-* roles, one execution policy, one deploy-role boundary — PER TIER,
// so dev authority reaches only dev resources and can never execute a pilot change. Reviewed
// constants, never context: a configurable qualifier would let a deploy re-aim itself at a
// differently-privileged bootstrap.
const RELEASE_BOOTSTRAP_QUALIFIERS = Object.freeze({ dev: 'cbardev', pilot: 'cbarpil' });

// The reviewed EXECUTION order for change sets — dependency order, not the alphabetical closed
// set: Api consumes Identity + Data exports, Observability watches Api + Data. Same MEMBERS as
// DEPLOYABLE_STACK_IDS (a test pins the set equality); different, deliberate sequence.
const DEPLOYMENT_EXECUTION_ORDER = Object.freeze(['IdentityStack', 'DataStack', 'ApiStack', 'ObservabilityStack']);

// THE REVIEWED PLAN GROUPS (#70 Slice B1 round 5). A change set for a stack that consumes
// Fn::ImportValue exports cannot even be CREATED while the producer stacks are unexecuted — so a
// fresh tier cannot prepare all four plans at once, and pretending otherwise would fail on the
// first real deployment. The cloud gate therefore names WHICH group it authorizes, from this
// closed list: the three dependency WAVES for a fresh tier (each wave planned, reviewed and
// executed before the next can be planned), and the full set for steady state, where every
// export already exists. A discovery test walks the REAL CDK dependency graph and refuses any
// cross-stack edge that violates the wave order.
// [SPEC-DEPLOY-004]
const DEPLOYMENT_PLAN_GROUPS = Object.freeze([
  Object.freeze(['IdentityStack', 'DataStack']),
  Object.freeze(['ApiStack']),
  Object.freeze(['ObservabilityStack']),
  DEPLOYMENT_EXECUTION_ORDER,
]);

// One source for CloudFormation stack names: the app builds them from these suffixes, and the
// deploy entrypoint reconstructs them to address change sets — a drifted copy would prepare a
// plan for one stack and execute another's.
const STACK_NAME_SUFFIXES = Object.freeze({
  ApiStack: 'api',
  DataStack: 'data',
  IdentityStack: 'identity',
  ObservabilityStack: 'observability',
});

function stackNameFor(environment, stackId) {
  const suffix = STACK_NAME_SUFFIXES[stackId];
  if (!suffix) throw new Error(`stack id "${stackId}" has no reviewed stack-name suffix`);
  return `cba-study-coach-${environment}-${suffix}`;
}

// What `getContext` will read at all: the deploy contract plus the tier selector, nothing else.
const READABLE_CONTEXT_KEYS = new Set([...DEPLOY_CONTEXT_KEYS, 'environment']);

function resolveEnvironment(node, fallback = 'pilot') {
  const value = getContext(node, 'environment', fallback);
  if (!VALID_ENVIRONMENTS.includes(value)) {
    throw new Error(
      `context "environment" must be one of ${VALID_ENVIRONMENTS.join('|')} — got "${value}". ` +
        'The pilot has exactly two deployed tiers (pilot-environment-contract.md); staging and ' +
        'anything else are not valid stack families.',
    );
  }
  return value;
}

// CDK delivers `-c key=value` as a STRING. Accept a real array (the in-code default) or a
// JSON-array string, and validate it is a non-empty list of ARN strings. This exists because
// spreading a raw string into an IAM policy Resource scatters it character-by-character
// ("-","/","1",...) — a silent, deploy-breaking bug on exactly the override path the runbook
// tells operators to use. Fail synth loudly instead.
function parseArnList(value, contextKey) {
  let list = value;
  if (typeof value === 'string') {
    try {
      list = JSON.parse(value);
    } catch {
      throw new Error(
        `context "${contextKey}" must be a JSON array of ARN strings, ` +
          `e.g. -c '${contextKey}=["arn:aws:bedrock:us-east-1::foundation-model/..."]' (received: ${value})`,
      );
    }
  }
  if (
    !Array.isArray(list) ||
    list.length === 0 ||
    !list.every((x) => typeof x === 'string' && x.startsWith('arn:'))
  ) {
    throw new Error(
      `context "${contextKey}" must be a non-empty array of ARN strings (each starting with "arn:"); received: ${JSON.stringify(list)}`,
    );
  }
  return list;
}

// Exact-URL lists for the Cognito client (#69): callback/logout URLs are configuration values
// that must be EXACT — wildcards are forbidden outright, and only https:// is accepted except
// for localhost during local development. Accepts a real array or a `-c` JSON-array string.
function parseExactUrlList(value, contextKey) {
  let list = value;
  if (typeof value === 'string') {
    try {
      list = JSON.parse(value);
    } catch {
      throw new Error(
        `context "${contextKey}" must be a JSON array of exact URLs, ` +
          `e.g. -c '${contextKey}=["https://app.example.com/auth/callback"]' (received: ${value})`,
      );
    }
  }
  if (!Array.isArray(list) || list.length === 0 || !list.every((x) => typeof x === 'string')) {
    throw new Error(`context "${contextKey}" must be a non-empty array of exact URL strings.`);
  }
  for (const url of list) {
    if (url !== url.trim()) {
      throw new Error(`context "${contextKey}": "${url}" has leading/trailing whitespace — URLs must be exact.`);
    }
    if (url.includes('*')) {
      throw new Error(`context "${contextKey}": wildcards are forbidden — every URL must be exact (got "${url}").`);
    }
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error(`context "${contextKey}": "${url}" is not a valid absolute URL.`);
    }
    // Cognito rejects fragments in callback URLs, and embedded credentials have no business in
    // an OAuth redirect — fail synth instead of failing at deploy/runtime.
    if (parsed.hash) {
      throw new Error(`context "${contextKey}": "${url}" must not contain a fragment (#...).`);
    }
    if (parsed.username || parsed.password) {
      throw new Error(`context "${contextKey}": "${url}" must not embed credentials (user:pass@).`);
    }
    const isLoopback = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1';
    if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && isLoopback)) {
      throw new Error(
        `context "${contextKey}": "${url}" must use https:// (http:// is allowed only for localhost).`,
      );
    }
  }
  return list;
}

module.exports = {
  getContext,
  parseArnList,
  parseExactUrlList,
  resolveEnvironment,
  VALID_ENVIRONMENTS,
  DEFAULT_AUTH_URLS,
  defaultAuthDomainPrefix,
  DEPLOY_CONTEXT_KEYS,
  DEPLOYABLE_STACK_IDS,
  EXCLUDED_STACK_IDS,
  FOUNDATION_STACK_NAME,
  RELEASE_BOOTSTRAP_QUALIFIERS,
  DEPLOYMENT_EXECUTION_ORDER,
  DEPLOYMENT_PLAN_GROUPS,
  STACK_NAME_SUFFIXES,
  stackNameFor,
};
