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
];

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
};
