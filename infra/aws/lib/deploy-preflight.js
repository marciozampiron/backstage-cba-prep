// Deploy preflight (#70 Slice A) — PREFLIGHT-1 and PREFLIGHT-2, as PURE evaluation.
//
// #69 registered two binding conditions against #70 and then closed. They are recorded in
// `.agent-handoff/active/70-cloudflare-aws-deploy-pipeline.md` and implemented here.
//
// WHY THIS FILE HAS NO I/O. Every verdict is a function of observations, exactly like
// `src/lib/observability-gate.js`: the adversarial controls are ordinary unit tests, and no test
// needs an AWS account, a network or a deployed environment to exercise a refusal.
//
// WHY IT MUST RUN BEFORE `cdk deploy` AND NOT AFTER. Both conditions guard resources that are
// expensive or impossible to walk back. A Cognito hosted-UI domain is created early in the
// IdentityStack deployment; by the time a post-hoc check notices the prefix was wrong, the domain
// exists, and a callback URL pointing at `.invalid` means every sign-in in that environment is
// broken with real users already routed to it.
//
// WHY NOTHING HERE ECHOES A VALUE. A preflight runs in CI, and its output lands in a public log, a
// job summary and possibly a paste. Environment configuration is exactly the material that must not
// travel that way: an endpoint URL names internal infrastructure, and a mistyped variable can carry
// credential-shaped text into a field that was expected to hold a URL. So every failure is a CODE
// plus a FIELD NAME from a closed vocabulary. `describeFailure` renders them; there is no path from
// a supplied value to the output. Codex's Slice A review reproduced role-ARN and credential-shaped
// material in this command's output, which is what these codes replace.
const { DEFAULT_AUTH_URLS, defaultAuthDomainPrefix, parseExactUrlList, VALID_ENVIRONMENTS } = require('./context');
const crypto = require('node:crypto');

/** The RFC 2606 reserved TLD the committed pilot placeholder uses. */
const RESERVED_TLD = 'invalid';

/**
 * Cognito hosted-UI domain prefix rules, as Cognito itself enforces them.
 *
 * Checked here so a malformed prefix fails in seconds instead of mid-stack, after the User Pool and
 * its client already exist. Cognito additionally rejects any prefix containing `aws`, `amazon` or
 * `cognito`; that is not a style rule, it is a hard API refusal.
 */
const PREFIX_SHAPE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const PREFIX_MAX = 63;
const RESERVED_WORDS = ['aws', 'amazon', 'cognito'];

/** Probe outcomes the collector may report. Anything else is treated as unusable. */
const PROBE = {
  AVAILABLE: 'AVAILABLE',
  TAKEN_BY_OTHER: 'TAKEN_BY_OTHER',
  TAKEN_BY_EXPECTED_POOL: 'TAKEN_BY_EXPECTED_POOL',
  ERROR: 'ERROR',
  NOT_CHECKED: 'NOT_CHECKED',
};

/**
 * The closed failure vocabulary. Adding a code is a deliberate act; there is no free-text path.
 *
 * Each entry maps to a sentence that names WHAT is wrong and WHICH field, never the value.
 */
const CODES = {
  AUTH_URLS_NOT_JSON: 'is not a JSON array — the CDK CLI delivers -c values as strings',
  AUTH_URLS_NOT_ARRAY: 'must be a JSON array of exact URL strings',
  AUTH_URLS_EMPTY: 'is an empty list; at least one exact URL is required',
  AUTH_URLS_NOT_STRING: 'contains a non-string entry',
  AUTH_URLS_WHITESPACE: 'contains an entry with leading or trailing whitespace',
  AUTH_URLS_WILDCARD: 'contains a wildcard; every URL must be exact',
  AUTH_URLS_NOT_ABSOLUTE: 'contains an entry that is not a valid absolute URL',
  AUTH_URLS_FRAGMENT: 'contains a fragment (#...), which Cognito rejects in a redirect URL',
  AUTH_URLS_CREDENTIALS: 'contains embedded credentials (user:pass@), which never belong in a redirect URL',
  AUTH_URLS_NOT_HTTPS: 'contains a non-https entry (http is allowed only for localhost)',
  PLACEHOLDER_FROM_DEFAULT: `still resolves to the reserved .${RESERVED_TLD} placeholder: no override was supplied, so the committed default survived`,
  PLACEHOLDER_FROM_OVERRIDE: `still resolves to the reserved .${RESERVED_TLD} placeholder: it was supplied explicitly, so the override itself carries it`,
  PREFIX_NOT_SUPPLIED: 'was not supplied; the stack would silently fall back to its in-code default, which is indistinguishable from a deliberate choice',
  PREFIX_NOT_STRING: 'must be a non-empty string',
  PREFIX_WHITESPACE: 'has leading or trailing whitespace',
  PREFIX_TOO_LONG: `is longer than the ${PREFIX_MAX} characters Cognito allows`,
  PREFIX_SHAPE_INVALID: 'is not a valid Cognito domain prefix — lowercase letters, digits and single hyphens only, and it may not start or end with a hyphen',
  PREFIX_RESERVED_WORD: 'contains a word Cognito reserves (aws, amazon or cognito)',
  PROBE_NOT_RUN: 'was never confirmed unique: the probe did not run, and an unanswered question is not a confirmation',
  PROBE_FAILED: 'was not confirmed unique: the probe failed and its result is unusable',
  PROBE_NO_REGION: 'cannot be confirmed "unique in the target region" because no region was supplied',
  PROBE_TAKEN: 'is already registered to a different user pool in the target region',
  PROBE_OWNERSHIP_UNVERIFIED: 'was reported as already ours, but no expected user pool id was supplied, so "ours" was never verified',
  // Binding and manifest codes (#70 round 2). The digest covers release, environment, region,
  // target account and every bound context value; these are the ways that binding can break.
  ACCOUNT_UNRESOLVED: 'could not be resolved from the assumed credentials — without the target account identity, the manifest cannot bind a deploy to the account it was validated for',
  MANIFEST_UNREADABLE: 'could not be read',
  MANIFEST_MALFORMED: 'is not a well-formed preflight manifest (closed schema, current version)',
  MANIFEST_ENVIRONMENT_MISMATCH: 'names a different environment than this job runs against',
  MANIFEST_RELEASE_MISMATCH: 'names a different release than the one checked out',
  MANIFEST_REGION_MISMATCH: 'names a different region than the one this run targets',
  MANIFEST_DIGEST_MISMATCH: 'does not carry the digest the preflight reported',
  MANIFEST_RECOMPUTE_MISMATCH: 'digest does not match a recomputation from the values this run would actually use',
  ACCOUNT_CHANGED: 'resolved to a different account immediately before the effect than the one the verification bound — the credentials changed between verification and deploy',
  DEPLOY_TARGET_UNSUPPORTED: 'names a service this entrypoint does not deploy — each service gets its own bound entrypoint, and none exists for this one yet',
  // The release/assembly binding (#70 round 4): a manifest that names a release the working tree is
  // not actually at, or an assembly other than the one that would deploy, authorizes nothing.
  RELEASE_HEAD_MISMATCH: 'does not match the checked-out HEAD — the working tree is not the release this manifest binds',
  WORKTREE_DIRTY: 'is not clean — a deploy must run from exactly the release commit, with nothing added on top',
  ASSEMBLY_UNREADABLE: 'could not be read or contains no files',
  ASSEMBLY_UNSAFE_ENTRY: 'contains a symlink or non-regular entry — an assembly is regular files only, and anything else is a path for content to escape the digest',
  ASSEMBLY_DIGEST_MISMATCH: 'does not match the synthesized assembly this run would deploy',
  // Zamp's cloud-execution gate (#70 Slice B1 review). GitHub Environment protection binds WHO may
  // run the lane; it does not bind the run to a reviewed plan. The gate is a closed JSON value the
  // human sets per release: it names the exact release, the exact assembly digest, a mode
  // (diff_only or deploy) and an expiry — so the effect that executes is the one whose plan was
  // reviewed, and nothing executes on an absent, stale or re-aimed authorization.
  CLOUD_GATE_MISSING: 'is not present — a cloud effect requires the human execution gate (CBA_CLOUD_GATE), and its absence is a refusal, never a default',
  CLOUD_GATE_MALFORMED: 'is not a well-formed cloud-execution gate (closed schema: issue, environment, releaseSha, assemblyDigest, mode, expiresAt)',
  CLOUD_GATE_MISMATCH: 'does not match the verified manifest — the gate authorizes exactly one release, one environment and one assembly, and this is not it',
  CLOUD_GATE_EXPIRED: 'has expired — the gate authorizes a bounded window, and this run is outside it',
  CLOUD_GATE_TTL_EXCEEDED: 'grants a window longer than the maximum — a gate is a short-lived decision, never a standing authorization',
  CLOUD_GATE_NOT_YET_VALID: 'is in the future — a gate whose approval instant has not arrived authorizes nothing yet',
  CLOUD_GATE_STACKS_INVALID: 'names a stack group outside the reviewed plan groups — first deployments run wave by wave (each wave under its own gate), steady state uses the full group, and nothing else is authorizable',
  CHANGE_SET_UNAVAILABLE: 'has a change set that is not AVAILABLE to execute — an obsolete or superseded plan must be re-prepared and re-reviewed, never gated only to fail at execution',
  PLAN_PREPARE_FAILED: 'could not be prepared — the change-set child failed, and without named change sets there is no plan to review or execute',
  BOOTSTRAP_ROLE_UNASSUMABLE: 'could not be assumed — without this tier\'s cdk deploy role there is no way to read or execute the change sets',
  CHANGE_SET_MISSING: 'has no prepared change set under this release\'s name — the reviewed plan does not exist (expired, deleted, or never prepared); run plan_only again',
  CHANGE_SET_UNREADABLE: 'has a change set that could not be described — an unreadable plan authorizes nothing',
  CHANGE_SET_SCHEMA_UNKNOWN: 'has a change set carrying a field the reviewed schema does not describe — an unreviewed field can change what an approval means, so the plan refuses until a human extends the schema',
  CHANGE_SET_PAGINATION_UNCONSUMED: 'has a change set whose description did not finish paginating — a partial plan describes an effect nobody reviewed, so it authorizes nothing',
  CHANGE_SET_FAILED: 'has a change set in a failed state — a plan that CloudFormation itself rejected cannot be reviewed or executed',
  PLAN_CHANGED: 'does not match the plan the gate names — the change sets differ from the reviewed ones (recreated, drifted or edited), and a changed world needs a new review before any effect',
  PLAN_RENDERING_TOO_LARGE: 'produced a rendering whose evidence record cannot cross the job-output channel complete — evidence is never truncated, so the plan refuses; split the wave and plan again',
  MODE_MISMATCH: 'names a gate mode the dispatched lane does not correspond to — a run titled abandon may only delete, and a dev_only run may only plan or deploy; the run name must mean what happened',
  ABANDON_STATE_UNKNOWN:
    'the delete call failed and bounded re-observation could not prove the set absent or present — presence requires an UNBROKEN window of well-formed, identity-matched observations in a standing status from the closed enum, and any deleting or unknown status, malformed response, diverging identity or transport error taints it; recorded as neither deleted nor present; read-only reconciliation of the named set is required before a new decision',
  ABANDON_NOT_A_PREFIX:
    'an absence after the first present entry cannot result from the lane\'s ordered deletion — the observed world is not a state this operation produced; nothing was deleted; re-observe under a new decision',
  ABANDON_DELETE_FAILED: 'refused to delete — CloudFormation returned a state or conflict error, which means the world changed between observation and action; a surprised operation stops, it does not retry',
  EXECUTE_FAILED: 'refused to execute — CloudFormation would not start the reviewed change set (a stack modified after preparation refuses exactly here)',
  STACK_EXECUTION_FAILED: 'did not reach a healthy terminal state — the execution failed or rolled back; the partial record above is the honest state',
};

class PreflightError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PreflightError';
  }
}

/** Render a failure without ever touching a supplied value. */
function describeFailure({ code, field }) {
  const text = CODES[code];
  if (!text) throw new PreflightError(`unknown failure code ${code}`);
  return `${field} ${text} [${code}]`;
}

const fail = (code, field) => ({ code, field });

/**
 * Does this URL point at the reserved placeholder TLD?
 *
 * Decided on the parsed HOSTNAME, not on a substring of the raw URL. A substring test is wrong in
 * both directions: `https://app.example.com/x.invalid.css` is a legitimate path, and
 * `https://pilot.invalid.attacker.example` is NOT the reserved TLD — it is a real, resolvable host
 * that a substring rule would wave through as "obviously the placeholder".
 */
function isReservedPlaceholder(url) {
  let host;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  return host === RESERVED_TLD || host.endsWith(`.${RESERVED_TLD}`);
}

/**
 * Classify why a URL list is unusable, WITHOUT echoing it.
 *
 * `parseExactUrlList` is the authority on acceptance — it is the same function the stack calls, so
 * agreement is structural. But its messages embed the offending URL, so its message is never
 * propagated. This classifier re-derives the reason from the values using safe predicates and
 * returns a code.
 */
function classifyUrlList(raw) {
  let list = raw;
  if (typeof raw === 'string') {
    try {
      list = JSON.parse(raw);
    } catch {
      return 'AUTH_URLS_NOT_JSON';
    }
  }
  if (!Array.isArray(list)) return 'AUTH_URLS_NOT_ARRAY';
  if (list.length === 0) return 'AUTH_URLS_EMPTY';
  if (!list.every((x) => typeof x === 'string')) return 'AUTH_URLS_NOT_STRING';
  for (const url of list) {
    if (url !== url.trim()) return 'AUTH_URLS_WHITESPACE';
    if (url.includes('*')) return 'AUTH_URLS_WILDCARD';
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      return 'AUTH_URLS_NOT_ABSOLUTE';
    }
    if (parsed.hash) return 'AUTH_URLS_FRAGMENT';
    if (parsed.username || parsed.password) return 'AUTH_URLS_CREDENTIALS';
    const isLoopback = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1';
    if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && isLoopback)) return 'AUTH_URLS_NOT_HTTPS';
  }
  return 'AUTH_URLS_NOT_ARRAY';
}

/**
 * Resolve the callback/logout lists exactly as `IdentityStack` will.
 *
 * Same defaults, same parser, so the preflight cannot pass on values the stack would reject.
 */
function resolveAuthUrls(context, environment) {
  const defaults = DEFAULT_AUTH_URLS[environment];
  const out = {};
  for (const [key, contextKey] of [
    ['callback', 'authCallbackUrls'],
    ['logout', 'authLogoutUrls'],
  ]) {
    const supplied = Object.hasOwn(context, contextKey) ? context[contextKey] : undefined;
    const raw = supplied === undefined ? defaults[key] : supplied;
    out[key] = { contextKey, supplied: supplied !== undefined, urls: parseExactUrlList(raw, contextKey) };
  }
  return out;
}

/**
 * PREFLIGHT-1 — refuse while the reserved placeholder survives into the effective configuration.
 *
 * Evaluated on the EFFECTIVE value after context resolution, never on the committed default. An
 * override that silently failed to apply — a typo in the key, a `-c` that never reached the CLI, an
 * environment variable that expanded to empty — looks identical to one that was never attempted.
 */
function evaluatePreflight1({ environment, context }) {
  const failures = [];
  const observed = {};

  for (const [key, contextKey] of [
    ['callback', 'authCallbackUrls'],
    ['logout', 'authLogoutUrls'],
  ]) {
    const supplied = Object.hasOwn(context, contextKey) ? context[contextKey] : undefined;
    const raw = supplied === undefined ? DEFAULT_AUTH_URLS[environment][key] : supplied;

    let urls;
    try {
      urls = parseExactUrlList(raw, contextKey);
    } catch {
      failures.push(fail(classifyUrlList(raw), contextKey));
      observed[key] = { supplied: supplied !== undefined, count: null, usable: false };
      continue;
    }

    const placeholders = urls.filter(isReservedPlaceholder).length;
    if (placeholders > 0) {
      failures.push(fail(supplied === undefined ? 'PLACEHOLDER_FROM_DEFAULT' : 'PLACEHOLDER_FROM_OVERRIDE', contextKey));
    }
    // Counts, never values: enough to tell an operator which field and how much, nothing to leak.
    observed[key] = { supplied: supplied !== undefined, count: urls.length, placeholders, usable: true };
  }

  return { id: 'PREFLIGHT-1', ok: failures.length === 0, failures, observed };
}

/**
 * PREFLIGHT-2 — refuse unless the domain prefix was explicitly supplied AND confirmed unique.
 *
 * BOTH halves are load-bearing and neither implies the other.
 *
 * Explicit supply: `IdentityStack` falls back to `cba-study-coach-<env>`, so a value always exists
 * at synth time and "a prefix is set" proves nothing. Presence of the CONTEXT KEY is the signal.
 *
 * Confirmed uniqueness: hosted-UI prefixes are globally unique per region. An unverified prefix
 * fails during the deployment, after the User Pool and client exist.
 *
 * `TAKEN_BY_EXPECTED_POOL` is the redeploy case and is a PASS — but only when the expected pool id
 * came from trusted environment state. The collector never accepts it from a caller: whoever can
 * name "our" pool can redefine which existing pool a deploy is willing to adopt.
 */
function evaluatePreflight2({ environment, context, domainProbe }) {
  const failures = [];
  const contextKey = 'authDomainPrefix';
  const supplied = Object.hasOwn(context, contextKey) ? context[contextKey] : undefined;

  if (supplied === undefined) {
    failures.push(fail('PREFIX_NOT_SUPPLIED', contextKey));
  } else if (typeof supplied !== 'string' || supplied.trim() === '') {
    failures.push(fail('PREFIX_NOT_STRING', contextKey));
  } else {
    if (supplied !== supplied.trim()) failures.push(fail('PREFIX_WHITESPACE', contextKey));
    const value = supplied.trim();
    if (value.length > PREFIX_MAX) failures.push(fail('PREFIX_TOO_LONG', contextKey));
    if (!PREFIX_SHAPE.test(value)) failures.push(fail('PREFIX_SHAPE_INVALID', contextKey));
    if (RESERVED_WORDS.some((w) => value.includes(w))) failures.push(fail('PREFIX_RESERVED_WORD', contextKey));
  }

  // Uniqueness is evaluated even when supply failed, so one run reports every reason it refused
  // rather than making an operator discover them one deploy at a time.
  const status = domainProbe?.status ?? PROBE.NOT_CHECKED;
  if (status === PROBE.AVAILABLE) {
    if (!domainProbe.region) failures.push(fail('PROBE_NO_REGION', contextKey));
  } else if (status === PROBE.TAKEN_BY_EXPECTED_POOL) {
    if (!domainProbe.ownershipVerified) failures.push(fail('PROBE_OWNERSHIP_UNVERIFIED', contextKey));
    if (!domainProbe.region) failures.push(fail('PROBE_NO_REGION', contextKey));
  } else if (status === PROBE.TAKEN_BY_OTHER) {
    failures.push(fail('PROBE_TAKEN', contextKey));
  } else if (status === PROBE.ERROR) {
    failures.push(fail('PROBE_FAILED', contextKey));
  } else {
    failures.push(fail('PROBE_NOT_RUN', contextKey));
  }

  return {
    id: 'PREFLIGHT-2',
    ok: failures.length === 0,
    failures,
    // The prefix itself is never reported: it is environment configuration, and this output is a log.
    observed: { supplied: supplied !== undefined, probeStatus: status },
  };
}

/**
 * Run both conditions. Never short-circuits: an operator should see every reason at once.
 *
 * @returns {{ok, environment, checks, failures, messages}}
 */
function evaluatePreflight({ environment, context = {}, domainProbe = null } = {}) {
  if (!VALID_ENVIRONMENTS.includes(environment)) {
    throw new PreflightError(`environment must be one of ${VALID_ENVIRONMENTS.join('|')}`);
  }
  if (context === null || typeof context !== 'object' || Array.isArray(context)) {
    throw new PreflightError('context must be a plain object of resolved CDK context values');
  }

  const checks = [
    evaluatePreflight1({ environment, context }),
    evaluatePreflight2({ environment, context, domainProbe }),
  ];
  const failures = checks.flatMap((c) => c.failures.map((f) => ({ ...f, check: c.id })));
  return {
    ok: checks.every((c) => c.ok),
    environment,
    checks,
    failures,
    messages: failures.map((f) => `${f.check}: ${describeFailure(f)}`),
  };
}

/**
 * §6b `bundle` framing over ONE record — the CommonJS TWIN of `framedBundleDigest` in
 * src/lib/authority-policy.js (ESM, unreachable from this CJS tree). The envelopes MUST agree
 * byte for byte; test/digest-agreement.test.js proves both implementations produce identical
 * digests over shared fixtures, so drift between the twins is a red build, not a latent fork.
 */
function framedBundleDigestCjs({ producer, name, mediaType, content }) {
  const bytes = typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
  const doc = {
    digestKind: 'bundle',
    version: 1,
    producer,
    records: [{
      name,
      mediaType,
      bytes: bytes.length,
      sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    }],
  };
  return crypto.createHash('sha256').update(JSON.stringify(doc), 'utf8').digest('hex');
}

/**
 * The manifest digest the cloud gate names (SPEC-DEPLOY-019, §8a): the §6b bundle digest over
 * the CANONICAL serialization of the complete closed manifest — keys deep-sorted so the digest
 * is a property of the manifest's CONTENT, not of whichever writer serialized it. The envelope
 * is pinned here, once: producer, record name and media type are part of the digested bytes.
 */
// [SPEC-DEPLOY-019]
function manifestBundleDigest(manifest, deepSortKeysFn) {
  return framedBundleDigestCjs({
    producer: 'cba-release-binding',
    name: 'binding-manifest',
    mediaType: 'application/json',
    content: JSON.stringify(deepSortKeysFn(manifest)),
  });
}

module.exports = {
  framedBundleDigestCjs,
  manifestBundleDigest,
  PROBE,
  CODES,
  PREFIX_MAX,
  RESERVED_TLD,
  RESERVED_WORDS,
  PreflightError,
  describeFailure,
  classifyUrlList,
  isReservedPlaceholder,
  resolveAuthUrls,
  evaluatePreflight1,
  evaluatePreflight2,
  evaluatePreflight,
};
