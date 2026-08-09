#!/usr/bin/env node
// The ONE sanctioned deployment entrypoint (#70 Slice A) — verification and deployment bound BY
// CONSTRUCTION, not by workflow choreography.
//
// Round 3 of the Codex review proved that choreography cannot bind: with verification and
// deployment as separate commands, a job could verify a safe context and then deploy a different
// one, verify under one set of credentials and deploy under another, or verify an AWS manifest and
// then deploy an unrelated Cloudflare target. Each passed the workflow invariants, because a
// textual ordering rule can only see that two commands exist — never that they used the same
// values.
//
// This entrypoint closes those holes STRUCTURALLY, in one process:
//
//   * The deploy arguments are DERIVED from the very context object that was verified. There is no
//     interface through which the deploy can receive different values: the `-c` flags handed to the
//     CDK child are read out of the same in-memory object whose digest was just compared.
//   * The account is resolved TWICE — once for the digest comparison and once immediately before
//     the child process is spawned. A credential swap between the two refuses with ACCOUNT_CHANGED.
//     What remains is the in-process window between the second resolution and the spawn, which no
//     userland check can close; it is disclosed here rather than papered over.
//   * The manifest names its service (`aws-cdk`), and this entrypoint deploys nothing else — there
//     is no code path that invokes wrangler or opennextjs. A Cloudflare deploy requires its own
//     manifest shape and its own bound entrypoint, in a later slice. The workflow invariants allow
//     ONLY a closed set of step shapes, so this file is the only way anything deploys at all.
//   * The RELEASE is bound to the working tree and to the deployable content, not just to an
//     argument. Round 4 reproduced a deploy that verified a manifest naming one SHA while HEAD was
//     another: the entrypoint requires `git rev-parse HEAD` to equal the manifest's release, the
//     worktree to be clean, and the assembly's digest to equal the manifest's.
//   * The assembly is deployed from a PRIVATE SNAPSHOT, not the original path. Round 5 proved two
//     holes at once: the old digest covered only the root templates (mutating a Lambda bundle under
//     `asset.<hash>/` left it unchanged), and the original directory stayed mutable between the
//     check and CDK reading it. Now the assembly is copied — recursively, every regular file,
//     symlinks refused — into a fresh private directory; the digest is computed FROM THE SNAPSHOT;
//     and `--app` points at the snapshot. The original path is never reopened after verification.
//   * The REGION the manifest binds is imposed on the child: AWS_REGION, AWS_DEFAULT_REGION and
//     CDK_DEFAULT_REGION are all overridden with the verified value, so an ambient region pointing
//     somewhere else cannot redirect the deploy inside the same account.
//   * The EFFECT is a closed stack set, never `--all` (Slice B1 review). The manifest names
//     exactly the DEPLOYABLE stacks from lib/context.js and the child gets them with
//     `--exclusively` — so the account-global SecurityStack, the deferred AiOrchestrationStack,
//     and any stack anyone adds tomorrow are structurally outside a release's blast radius.
//   * The HUMAN CLOUD GATE binds the run to a reviewed plan (Slice B1 rounds 2-4). CBA_CLOUD_GATE
//     must name this exact release and assembly digest inside a bounded window; `plan_only`
//     PREPARES named CloudFormation change sets and puts their digest on the record while
//     refusing the effect; `deploy` NAMES that digest and EXECUTES exactly those change sets —
//     an id is immutable, so a recreated or drifted plan refuses as PLAN_CHANGED, and
//     CloudFormation itself refuses a change set whose stack moved after preparation.
//   * Everything the CDK children print is CAPTURED and sanitized by shape — ARNs, URLs, Cognito
//     pool ids, 12-digit account runs — because `Outputs:` and `Stack ARN:` would otherwise hand
//     the BFF endpoint, the identity pool and the account structure to any log reader.
//
// Slice A established and adversarially tested this binding before anything deployed; Slice B1 is
// the first lane that calls it, for the dev tier only.
//
// EXIT CODES  0 = deployed (child exit propagated) · 1 = refused · 2 = usage error.
const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { describeFailure, PreflightError } = require('../lib/deploy-preflight');
const { RELEASE_BOOTSTRAP_QUALIFIERS, DEPLOYMENT_EXECUTION_ORDER, DEPLOYMENT_PLAN_GROUPS, stackNameFor } = require('../lib/context');
const {
  contextDigest,
  assemblyDigest,
  walkAssembly,
  loadContext,
  resolveAccountId,
  validManifestShape,
  parseContextPair,
  defaultRun,
  MANIFEST_TARGET_SERVICE,
} = require('./deploy-preflight');

const EXIT = { OK: 0, REFUSED: 1, USAGE: 2 };

function parseArgs(argv) {
  const out = { context: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-c' || a === '--context') parseContextPair(out, argv[++i]);
    else if (a === '--manifest') out.manifest = argv[++i];
    else if (a === '--environment') out.environment = argv[++i];
    else if (a === '--release-sha') out.releaseSha = argv[++i];
    else if (a === '--region') out.region = argv[++i];
    else if (a === '--assembly') out.assembly = argv[++i];
    else if (a === '--artifact-out') out.artifactOut = argv[++i];
    else if (a === '--help' || a === '-h') out.help = true;
    // The offending token is not echoed: argv can hold a mistyped secret.
    else throw new PreflightError('unrecognised argument');
  }
  return out;
}

function usage() {
  return [
    'deploy-release — the only sanctioned deployment entrypoint (#70)',
    '',
    '  --manifest <path>       required; the manifest the preflight emitted',
    '  --environment <env>     required; must equal the manifest',
    '  --release-sha <40-hex>  required; must equal the manifest',
    '  --region <aws-region>   required; must equal the manifest',
    '  --assembly <dir>        required; the synthesized cdk.out whose digest the manifest binds',
    '  --artifact-out <file>   optional; write the closed evidence record (SPEC-RUN-007) — requires CORRELATION_ID',
    '  -c key=value            the effective context (repeatable) — the SAME values the',
    '                          preflight validated; the digest is recomputed from them',
    '',
    'It verifies the manifest digest against the effective values and the resolved account and',
    'requires CBA_CLOUD_GATE (the human cloud gate) to name this exact release and assembly.',
    'plan_only prepares one named change set per stack and puts PLAN_DIGEST on the record;',
    'deploy re-describes those exact change sets, requires the digest the gate names, resolves',
    'the account and re-checks the window immediately before EACH execution, and executes',
    'exactly the reviewed change sets. Raw `cdk deploy` invocations are forbidden by the',
    'workflow invariants; this entrypoint is the only path to a deployment.',
  ].join('\n');
}

/** Default executor: the CDK child, output CAPTURED — never inherited. Round 11: captured child
 * text is never reproduced at all; only a stable code, a byte count and a digest are recorded.
 * The env is supplied by the caller with the verified region imposed — never ambient as-is. */
function defaultExec(args, env) {
  const res = spawnSync('npx', args, { encoding: 'utf8', env, maxBuffer: 64 * 1024 * 1024 });
  return { status: res.status === null ? 1 : res.status, stdout: res.stdout || '', stderr: res.stderr || '' };
}

/**
 * ROUND 11: UNSTRUCTURED CHILD TEXT IS NEVER ECHOED.
 *
 * A second, shape-based scanner used to sanitize the prepare child's stdout/stderr — a different
 * policy from the plan renderer's, and a weaker one: it left `postgres://user:secret@host/db`
 * intact on the refusal path, straight into a persistent CI log. There is now ONE policy, and
 * for arbitrary child text it is silence: the run records a stable exit code, the byte count and
 * a digest, so the operator can correlate the failure with the runner's own protected logs
 * without the release lane reproducing a single byte of it.
 */
function childEvidence(child) {
  // ROUND 12: the streams are FRAMED, not concatenated — (stdout "ab", stderr "c") and
  // (stdout "a", stderr "bc") produced the same digest before, so evidence could not be
  // correlated unambiguously with the runner's own logs. Canonical JSON supplies the framing.
  const stdout = child.stdout || '';
  const stderr = child.stderr || '';
  const digest = crypto.createHash('sha256').update(JSON.stringify({ status: child.status, stdout, stderr }), 'utf8').digest('hex');
  return `child not echoed — exit=${child.status} stdout=${Buffer.byteLength(stdout, 'utf8')}B stderr=${Buffer.byteLength(stderr, 'utf8')}B sha256=${digest}`;
}

/** The closed shape of Zamp's cloud-execution gate (v2, round 3). Exactly these keys. */
const CLOUD_GATE_KEYS = ['approvedAt', 'assemblyDigest', 'decisionId', 'environment', 'expiresAt', 'issue', 'mode', 'planDigest', 'releaseSha', 'stacks'];
const CLOUD_GATE_MODES = ['plan_only', 'deploy'];

/** STRICT RFC3339, UTC only, whole seconds. `Date.parse` alone accepted `2099-01-01` and a
 * space-separated datetime — formats a human would not notice granting a century of authority. */
const STRICT_RFC3339_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

/** Format AND calendar (round 4): `Date.parse` silently normalizes 2026-02-30 into March — a
 * calendar-invalid instant is not a stricter format, it is a DIFFERENT date than the human
 * wrote. The canonical round-trip refuses anything the calendar itself would rewrite. */
function strictUtcInstant(v) {
  if (typeof v !== 'string' || !STRICT_RFC3339_UTC.test(v)) return false;
  const ms = Date.parse(v);
  return !Number.isNaN(ms) && new Date(ms).toISOString() === v.replace('Z', '.000Z');
}

/** A gate authorizes a WINDOW, never a standing state: at most one hour approvedAt -> expiresAt. */
const CLOUD_GATE_MAX_TTL_MS = 60 * 60 * 1000;

/** decisionId names Zamp's one decision, for the audit trail and the EVENTS record. */
const DECISION_ID = /^[A-Za-z0-9._-]{8,64}$/;

/** SPEC-LANE-006: the closed correlation grammar — evidence binds to a decision, never a window. */
const CORRELATION_ID_RE = /^cba-70-[0-9a-f]{32}$/;

/**
 * ROUND I3-3: the evidence record travels between jobs as a GitHub job output, and that channel
 * has a documented 1 MB per-job bound, estimated in UTF-16 code units. A record that exceeds the
 * channel does not get truncated — the RUN refuses, because evidence that cannot arrive complete
 * must not be the thing a human reviews. The cap is HALF the platform bound: a margin, not a
 * guess. JavaScript string .length IS UTF-16 code units, so the measurement is the channel's own.
 */
const EVIDENCE_MAX_UTF16 = 450_000;

/**
 * The transport guarantee, as a pure function: a record that fits passes untouched; a record
 * whose rendering pushes past the cap loses the rendering AND says so by code; a record that
 * still cannot fit drops its variable-length lists too. The fixed core (schema, ids, digests,
 * outcome) always fits — every field has a closed grammar with a known bound.
 */
function boundedEvidence(record, cap) {
  const fits = (r) => JSON.stringify(r, null, 2).length <= cap;
  if (fits(record)) return record;
  const withoutRendering = { ...record, rendering: null, refusals: [...record.refusals, 'EVIDENCE_RENDERING_OMITTED'] };
  if (fits(withoutRendering)) return withoutRendering;
  return { ...withoutRendering, changeSets: [], stacks: [], refusals: [...withoutRendering.refusals, 'EVIDENCE_CHANNEL_OVERFLOW'] };
}

/**
 * Validate the human cloud-execution gate against the VERIFIED manifest.
 *
 * The GitHub Environment answers WHO may run the lane; it cannot bind the run to a reviewed plan.
 * This gate does: the human sets CBA_CLOUD_GATE (an Environment variable, writable only through
 * repository settings) naming the exact release, the exact assembly digest, the decision, a mode,
 * and a bounded window (approvedAt -> expiresAt, strict RFC3339 UTC, at most one hour). `plan_only`
 * prepares the named change sets and puts their digest on the record while refusing the effect;
 * `deploy` additionally names the PLAN it authorizes (`planDigest`), so an effect executes only
 * the exact change sets whose unredacted canonical describes the human reviewed. A missing,
 * malformed, mismatched, premature or expired gate refuses before any child process runs —
 * absence of authorization is a refusal, never a default. The gate CANNOT name the GitHub run id
 * (it is set before dispatch, when no run exists); the binding is the decision plus the short
 * window plus the plan digest, and a reused gate that meets all three executes only the exact
 * reviewed plan — anything else refuses as PLAN_CHANGED.
 *
 * @returns {{gate: object} | {failures: Array<{check:string, code:string, field:string}>}}
 */
function checkCloudGate(raw, manifest, now) {
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    return { failures: [{ check: 'GATE', code: 'CLOUD_GATE_MISSING', field: 'cloudGate' }] };
  }
  let gate = null;
  try {
    gate = JSON.parse(raw);
  } catch {
    return { failures: [{ check: 'GATE', code: 'CLOUD_GATE_MALFORMED', field: 'cloudGate' }] };
  }
  const malformed =
    !gate || typeof gate !== 'object' || Array.isArray(gate)
    || JSON.stringify(Object.keys(gate).sort()) !== JSON.stringify(CLOUD_GATE_KEYS)
    || gate.issue !== 70
    || !CLOUD_GATE_MODES.includes(gate.mode)
    || typeof gate.decisionId !== 'string' || !DECISION_ID.test(gate.decisionId)
    || !strictUtcInstant(gate.approvedAt)
    || !strictUtcInstant(gate.expiresAt)
    // plan_only authorizes no effect, so it names no plan; deploy must name exactly one.
    || (gate.mode === 'plan_only' && gate.planDigest !== null)
    || (gate.mode === 'deploy' && !(typeof gate.planDigest === 'string' && /^[0-9a-f]{64}$/.test(gate.planDigest)));
  if (malformed) {
    return { failures: [{ check: 'GATE', code: 'CLOUD_GATE_MALFORMED', field: 'cloudGate' }] };
  }
  // Round 5: the gate names WHICH reviewed plan group it authorizes. A fresh tier cannot even
  // CREATE a change set whose Fn::ImportValue producers are unexecuted, so first deployments run
  // wave by wave — each wave planned, reviewed and executed under its own gate — and steady
  // state uses the full group. Anything outside the closed list authorizes nothing.
  if (!DEPLOYMENT_PLAN_GROUPS.some((group) => JSON.stringify(group) === JSON.stringify(gate.stacks))) {
    return { failures: [{ check: 'GATE', code: 'CLOUD_GATE_STACKS_INVALID', field: 'stacks' }] };
  }
  const failures = [];
  for (const key of ['environment', 'releaseSha', 'assemblyDigest']) {
    if (gate[key] !== manifest[key]) failures.push({ check: 'GATE', code: 'CLOUD_GATE_MISMATCH', field: key });
  }
  const approved = Date.parse(gate.approvedAt);
  const expires = Date.parse(gate.expiresAt);
  if (expires <= approved || expires - approved > CLOUD_GATE_MAX_TTL_MS) {
    failures.push({ check: 'GATE', code: 'CLOUD_GATE_TTL_EXCEEDED', field: 'expiresAt' });
  }
  if (approved > now) {
    failures.push({ check: 'GATE', code: 'CLOUD_GATE_NOT_YET_VALID', field: 'approvedAt' });
  }
  if (expires <= now) {
    failures.push({ check: 'GATE', code: 'CLOUD_GATE_EXPIRED', field: 'expiresAt' });
  }
  return failures.length > 0 ? { failures } : { gate };
}

/**
 * THE PLAN IS A SET OF NAMED, IMMUTABLE CHANGE SETS (round 4) — not a diff rendering.
 *
 * Round 3 bound the gate to a `cdk diff` text, and the review broke it twice: `cdk deploy`
 * created a NEW change set over possibly different live state (drift after the diff executed
 * unreviewed), and the digest was computed AFTER sanitization — two plans differing only in an
 * ARN principal produced the same redacted text and the same SHA-256. Now the plan IS the
 * CloudFormation change sets: plan_only PREPARES one named change set per stack and digests the
 * canonical UNREDACTED describe output — change-set ids, full change details, principals and
 * all; the deploy-mode gate NAMES that digest; and the deploy run re-describes the SAME change
 * sets (an id is immutable — a recreated set has a new id and refuses as PLAN_CHANGED) and
 * EXECUTES exactly them. CloudFormation itself refuses to execute a change set whose stack moved
 * after preparation, so post-review drift dies in the service, not in a text comparison.
 * Sanitized output is presentation only; nothing is digested after redaction.
 */
function deepSortKeys(value) {
  if (Array.isArray(value)) return value.map(deepSortKeys);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = deepSortKeys(value[key]);
    return out;
  }
  return value;
}

function planDigestOf(planEntries) {
  return crypto.createHash('sha256').update(JSON.stringify(deepSortKeys(planEntries)), 'utf8').digest('hex');
}

/** One canonical entry per stack, from the UNREDACTED describe-change-set output. */
function canonicalChangeSet(stackId, stackName, described) {
  const noChanges =
    described.Status === 'FAILED'
    && /didn't contain changes|No updates are to be performed/i.test(described.StatusReason || '');
  // ROUND 11: the canonical entry carries the COMPLETE description, not a chosen subset. The
  // executable semantics of a change set live OUTSIDE `Changes` — Capabilities (what IAM the
  // execution may create), OnStackFailure (DELETE can destroy the stack after a failed create),
  // RollbackConfiguration, NotificationARNs, Tags, Parameters, ImportExistingResources,
  // IncludeNestedStacks — and a digest that ignored them let two materially different
  // authorizations produce identical bytes and identical review material.
  return {
    stackId,
    stackName,
    changeSetId: described.ChangeSetId,
    status: noChanges ? 'NO_CHANGES' : described.Status,
    executionStatus: described.ExecutionStatus,
    changes: described.Changes || [],
    describe: described,
  };
}

/** Assume one of THIS TIER'S cdk bootstrap roles; the ambient GitHub role can do nothing else. */
function assumeBootstrapRole(run, { account, region, qualifier, name, session }) {
  const arn = `arn:aws:iam::${account}:role/cdk-${qualifier}-${name}-role-${account}-${region}`;
  const res = run(['sts', 'assume-role', '--role-arn', arn, '--role-session-name', session, '--output', 'json', '--no-cli-pager'], { timeoutMs: 30_000 });
  if (!res || res.status !== 0) return null;
  try {
    const c = JSON.parse(res.stdout || '{}').Credentials;
    if (!c || !c.AccessKeyId || !c.SecretAccessKey || !c.SessionToken) return null;
    return { AWS_ACCESS_KEY_ID: c.AccessKeyId, AWS_SECRET_ACCESS_KEY: c.SecretAccessKey, AWS_SESSION_TOKEN: c.SessionToken };
  } catch {
    return null;
  }
}

/** Describe one named change set. `{missing: true}` when it does not exist; `{error}` otherwise. */
const CHANGE_SET_PAGE_LIMIT = 40;

function describePlannedChangeSet(run, credEnv, stackName, changeSetName) {
  // ROUND 11: DescribeChangeSet PAGINATES. A first page that carries a NextToken describes only
  // part of the plan, and digesting or reviewing that part would authorize an effect nobody saw.
  // Every page is consumed here and the assembled body carries NO cursor — or the run refuses.
  let base = null;
  const pages = [];
  const changes = [];
  let token = null;
  for (let page = 0; page < CHANGE_SET_PAGE_LIMIT; page += 1) {
    const args = ['cloudformation', 'describe-change-set', '--change-set-name', changeSetName, '--stack-name', stackName, '--include-property-values', '--output', 'json', '--no-cli-pager'];
    if (token) args.push('--next-token', token);
    const res = run(args, { timeoutMs: 30_000, env: credEnv });
    if (!res) return { error: true };
    if (res.status !== 0) {
      return /ChangeSetNotFound|does not exist/i.test(`${res.stderr || ''}${res.stdout || ''}`) ? { missing: true } : { error: true };
    }
    let body;
    try {
      body = JSON.parse(res.stdout);
    } catch {
      return { error: true };
    }
    // ROUNDS 14-15: the page is validated IMMEDIATELY after parsing — before it is stored,
    // before its Changes are spread, before its token is read. Round 15 proved the gap: with
    // the spread first, `Changes: {}` threw a TypeError and killed the lane OUTSIDE the
    // fail-closed contract, producing no CHANGE_SET_SCHEMA_UNKNOWN evidence at all. Only a page
    // the reviewed schema accepts is ever transformed.
    const pageViolations = validateChangeSet(body);
    if (pageViolations.length > 0) return { schemaViolations: pageViolations };
    pages.push(body);
    if (!base) base = body;
    changes.push(...(body.Changes || []));
    token = typeof body.NextToken === 'string' && body.NextToken !== '' ? body.NextToken : null;
    if (!token) {
      // The assembled description: every page's changes, no cursor left to follow.
      const { NextToken: _consumed, ...rest } = base;
      return { described: { ...rest, Changes: changes }, pages };
    }
  }
  return { paginationUnconsumed: true };
}

/** Poll the stack to a terminal status after executing its change set. Injectable sleep. */
function waitForStack(run, credEnv, stackName, { attempts = 120, sleep }) {
  for (let i = 0; i < attempts; i += 1) {
    const res = run(['cloudformation', 'describe-stacks', '--stack-name', stackName, '--output', 'json', '--no-cli-pager'], { timeoutMs: 30_000, env: credEnv });
    if (!res || res.status !== 0) return false;
    let status = null;
    try {
      status = JSON.parse(res.stdout || '{}').Stacks?.[0]?.StackStatus ?? null;
    } catch {
      return false;
    }
    if (status === 'CREATE_COMPLETE' || status === 'UPDATE_COMPLETE') return true;
    if (status === null || /FAILED|ROLLBACK/.test(status)) return false;
    sleep();
  }
  return false;
}

/* ================= ROUND 13: CONSTANT REDACTION, VALIDATED STRUCTURE ==========================
 *
 * Two things changed here, both because the previous design leaked by construction.
 *
 * THE MARKERS WERE AN ORACLE. `[value#<sha256("cba-pseudonym:"+v)>]` is a published, deterministic
 * derivation of the very value it hides: anyone holding the log tests candidates offline, and the
 * review reproduced `supersecret` exactly that way. Determinism bought correlation; correlation
 * was not worth an offline guessing oracle over parameter values, tag values and property blobs.
 * Every redaction is now a CONSTANT class label — no hash of any observed value is published,
 * ever. Where the human genuinely needs to know whether a value moved, `renderPlan` compares the
 * RAW values in memory and prints `changed` / `unchanged`; the values themselves never appear.
 *
 * THE SCHEMA VALIDATED NAMES ONLY. `Changes: "not-an-array"` and `Action: "SOMETHING_NEW"` both
 * passed the unknown-key walk and were quietly turned into markers at render time — so a new
 * action, a new enum member or a changed type could reach a human gate as opaque text. Validation
 * is now structural: unknown key, wrong type AND out-of-contract enum each REFUSE the plan before
 * the digest exists, and `renderPlan` runs the same validator itself rather than trusting its
 * caller to have remembered.
 */
const REDACT = Object.freeze({
  value: '[redacted]',
  key: '[key-redacted]',
  account: '[account-redacted]',
  apiId: '[api-id-redacted]',
  poolId: '[pool-id-redacted]',
  keyId: '[key-id-redacted]',
  id: '[id-redacted]',
  name: '[name-redacted]',
  bucket: '[bucket-redacted]',
  objectKey: '[object-key-redacted]',
  session: '[session-redacted]',
  alias: '[alias-redacted]',
  qualifier: '[qualifier-redacted]',
  stream: '[stream-redacted]',
  resource: '[resource-redacted]',
  arn: '[arn-redacted]',
  host: '[unexpected-host-redacted]',
  credentialedUrl: '[credentialed-url-redacted]',
  unparseableUrl: '[unparseable-url-redacted]',
  url: '[url-redacted]',
  path: '[path-redacted]',
  query: '[query-redacted]',
});

const DECISION_BEARING_HOST_SUFFIXES = ['.workers.dev', '.amazoncognito.com'];
const UUID_SHAPE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g;

/** The names THIS PROJECT chose, as ANCHORED grammars — a whole segment, never a substring. */
const PROJECT_TOKEN = '(?:cba-study-coach|cdk-cbardev|cdk-cbarpil)-[A-Za-z0-9-]+';
const PROJECT_TOKEN_EXACT = new RegExp(`^${PROJECT_TOKEN}$`);

/** URL paths a reviewed decision produces. Any OTHER path is data: a secret rides a path segment
 * as easily as a query value. */
const REVIEWED_URL_PATHS = new Set(['', '/', '/auth/callback', '/login', '/logout', '/oauth2/authorize', '/oauth2/token', '/prod', '/$default']);

function renderHost(host) {
  const lower = host.toLowerCase();
  if (lower === 'localhost' || lower === '127.0.0.1') return host;
  if (DECISION_BEARING_HOST_SUFFIXES.some((suffix) => lower.endsWith(suffix))) return host;
  // Exact family, explicit parts: the generated api id is redacted, the service suffix stays.
  const generated = lower.match(/^([a-z0-9-]+)\.(execute-api\.[a-z0-9-]+\.amazonaws\.com)$/);
  if (generated) return `${REDACT.apiId}.${generated[2]}`;
  // No blanket for *.amazonaws.com — a bucket-style or ELB-style name is not proven public.
  return REDACT.host;
}

/** URLs are FIELDS, not text: any scheme reaches this classifier, credentials never render, an
 * unparseable candidate never falls back to raw text, and a path renders only when a reviewed
 * decision produces that exact shape. */
function renderUrl(candidate) {
  let url;
  try {
    url = new URL(candidate);
  } catch {
    return REDACT.unparseableUrl;
  }
  if (url.username || url.password) return REDACT.credentialedUrl;
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return REDACT.url;
  const port = url.port ? `:${url.port}` : '';
  const path = REVIEWED_URL_PATHS.has(url.pathname) ? url.pathname : `/${REDACT.path}`;
  const suffix = url.search || url.hash ? `?${REDACT.query}` : '';
  return `${url.protocol}//${renderHost(url.hostname)}${port}${path}${suffix}`;
}

/** Per-service ARN grammars, ANCHORED: only the exact project-owned identity segment renders, and
 * a resource whose COMPLETE shape a branch does not recognize fails CLOSED. */
function renderArnResource(service, resource) {
  const whole = () => REDACT.resource;
  if (service === 'iam') {
    return /^(role|policy|user|group|instance-profile|oidc-provider|saml-provider|server-certificate)\/[!-~]+$/.test(resource) ? resource : whole();
  }
  if (service === 'sts') {
    const assumed = resource.match(/^(assumed-role\/[^/]+)\/([^/]+)$/);
    return assumed ? `${assumed[1]}/${REDACT.session}` : whole();
  }
  if (service === 'kms') {
    if (new RegExp(`^alias/${PROJECT_TOKEN}$`).test(resource)) return resource;
    if (/^alias\/[^/]+$/.test(resource)) return `alias/${REDACT.alias}`;
    if (/^key\/[^/]+$/.test(resource)) return `key/${REDACT.keyId}`;
    return whole();
  }
  if (service === 'cognito-idp') {
    const pool = resource.match(/^userpool\/([a-z]{2}-[a-z]+-\d)_([A-Za-z0-9]+)(\/.+)?$/);
    if (!pool) return whole();
    return `userpool/${pool[1]}_${REDACT.poolId}${pool[3] ? `/${REDACT.path}` : ''}`;
  }
  if (service === 'cloudformation') {
    const withId = resource.match(/^(stack|changeSet)\/([^/]+)\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/);
    const nameOnly = resource.match(/^(stack|changeSet)\/([^/]+)$/);
    const m = withId || nameOnly;
    if (!m) return whole();
    const reviewedName = PROJECT_TOKEN_EXACT.test(m[2]) || /^cba-70-[0-9a-f]{12}$/.test(m[2]);
    const name = reviewedName ? m[2] : REDACT.name;
    return withId ? `${m[1]}/${name}/${REDACT.id}` : `${m[1]}/${name}`;
  }
  if (service === 'apigateway') {
    if (resource === '/apis' || resource === '/tags/*') return resource;
    if (/^\/tags\/.+$/.test(resource)) return `/tags/${REDACT.arn}`;
    const m = resource.match(/^\/apis\/([^/]+)(?:\/(routes|integrations|authorizers|deployments|models|stages|cors)(?:\/([^/]+))?)?$/);
    if (!m) return whole();
    const apiId = m[1] === '*' ? '*' : REDACT.apiId;
    if (!m[2]) return `/apis/${apiId}`;
    if (!m[3]) return `/apis/${apiId}/${m[2]}`;
    return `/apis/${apiId}/${m[2]}/${m[3] === '*' ? '*' : REDACT.id}`;
  }
  if (service === 's3') {
    const slash = resource.indexOf('/');
    const bucket = slash === -1 ? resource : resource.slice(0, slash);
    const bucketOk = /^(cdk-cbardev-assets|cdk-cbarpil-assets|cba-study-coach)-[a-z0-9.-]+$/.test(bucket);
    const renderedBucket = bucketOk ? bucket : REDACT.bucket;
    return slash === -1 ? renderedBucket : `${renderedBucket}/${REDACT.objectKey}`;
  }
  if (service === 'ssm') {
    return /^parameter\/cdk-bootstrap\/(cbardev|cbarpil)\/version$/.test(resource) ? resource : whole();
  }
  if (service === 'lambda') {
    const m = resource.match(new RegExp(`^function:(${PROJECT_TOKEN})(?::(.+))?$`));
    if (!m) return whole();
    return m[2] === undefined ? resource : `function:${m[1]}:${REDACT.qualifier}`;
  }
  if (service === 'dynamodb') {
    const m = resource.match(new RegExp(`^table/(${PROJECT_TOKEN})(?:/(index|stream)/(.+))?$`));
    if (!m) return whole();
    return m[2] === undefined ? resource : `table/${m[1]}/${m[2]}/${REDACT.id}`;
  }
  if (service === 'sns') {
    return PROJECT_TOKEN_EXACT.test(resource) ? resource : whole();
  }
  if (service === 'logs') {
    const m = resource.match(new RegExp(`^log-group:((?:/aws/[a-z0-9-]+/)?${PROJECT_TOKEN})(?::\\*)?(?::log-stream:(.+))?$`));
    if (!m) return whole();
    return m[2] === undefined ? resource : `log-group:${m[1]}:log-stream:${REDACT.stream}`;
  }
  if (service === 'cloudwatch') {
    return new RegExp(`^(alarm:|dashboard/)${PROJECT_TOKEN}$`).test(resource) ? resource : whole();
  }
  return whole(); // an unknown service is not proven public
}

/** An exact ARN token, parsed by FIELDS. A token that does not parse never falls back to text. */
function renderArn(token) {
  const m = token.match(/^(arn):([a-zA-Z0-9-]*):([a-zA-Z0-9-]*):([a-zA-Z0-9-]*):(\d{12}|):(.+)$/);
  if (!m) return REDACT.arn;
  const acct = m[5] === '' ? '' : REDACT.account;
  return `${m[1]}:${m[2]}:${m[3]}:${m[4]}:${acct}:${renderArnResource(m[3], m[6])}`;
}

/** Identifying material embedded INSIDE classifier output — an account id inside a kept bucket
 * name, a UUID inside a kept path. Constant labels: nothing derived from the value is published. */
function renderResidual(token) {
  return token
    .replace(/\b([a-z]{2}-[a-z]+-\d)_([A-Za-z0-9]{5,})\b/g, (m, region) => `${region}_${REDACT.poolId}`)
    .replace(UUID_SHAPE, () => REDACT.id)
    // No hex fence is needed any more: every emitted label is a constant with no digits in it,
    // so this pass can never rewrite the inside of a redaction it just produced.
    .replace(/(?<!\d)\d{12}(?!\d)/g, () => REDACT.account);
}

/** URL and ARN spans, recognized ANYWHERE in a string, including behind punctuation. */
const URL_OR_ARN_SPAN = /(?:[a-zA-Z][a-zA-Z0-9+.-]*:\/\/(?:\[[0-9a-fA-F:.]+\])?[^\s"'`\\<>()[\]{},;]*)|(?:arn:[^\s"'`\\<>()[\]{},;]+)/g;
/** A word run inside free text. `:` stays INSIDE a run so a colon-joined value is one unit. */
const FREE_WORD_RUN = /[^\s"'`\\<>()[\]{},;=|]+/g;

/** An arbitrary string: classify every URL/ARN span wherever it sits, redact every other word.
 * There is no format allowance — a numeric string is also an account id, an identifier shape is
 * also a secret, and neither proves anything about content. */
function sanitizeScalarString(text) {
  const source = String(text);
  let out = '';
  let last = 0;
  for (const match of source.matchAll(URL_OR_ARN_SPAN)) {
    out += source.slice(last, match.index).replace(FREE_WORD_RUN, () => REDACT.value);
    const token = match[0];
    out += renderResidual(token.startsWith('arn:') ? renderArn(token) : renderUrl(token));
    last = match.index + token.length;
  }
  out += source.slice(last).replace(FREE_WORD_RUN, () => REDACT.value);
  return out;
}

const fingerprintSanitize = (text) => (text ? sanitizeScalarString(text) : '');

/* ---------------------------- the reviewed DescribeChangeSet schema ---------------------------
 *
 * Transcribed from the CloudFormation API reference (DescribeChangeSet, Change, ResourceChange,
 * ResourceChangeDetail, ResourceTargetDefinition, LiveResourceDrift, ResourceDriftIgnoredAttribute,
 * RollbackConfiguration, RollbackTrigger, Parameter, Tag, ModuleInfo), drift-aware members
 * included. A field is authorized by its POSITION here — the same name at another path is another
 * field, and a name inside a content carrier is not a field at all.
 */
/* ROUND 14: the leaf types carry their documented constraints — nothing is generic.
 *   - OPAQUE is an opaque STRING: the content fields are strings in the AWS contract, and an
 *     object smuggled where a string belongs is a malformed response, not deeper content.
 *   - integer(min, max) enforces integrality AND the documented range (MonitoringTimeInMinutes
 *     is 0..180, HookInvocationCount is 1..100 — a 0.5 or a -1.5 is not a number "of that field").
 *   - ARN_REFERENCE is a STRICT ARN: ChangeSetId, StackId, lineage, notification and trigger
 *     ARNs are ARNs in the contract, and a bare string there is malformed. ENTITY_REFERENCE is
 *     only CausingEntity, whose documented semantics genuinely admit a parameter or logical name.
 *   - `null` is NOT an absent member. A field must declare `nullable` to accept it, and the one
 *     position documented as nullable is HookInvocationCount ("is either null, if no Hooks
 *     invoke, or contains the number"). Everywhere else an explicit null is a malformed response.
 */
const OPAQUE = { kind: 'opaque' };
const BOOLEAN = { kind: 'boolean' };
/** A POSITIONAL ARN contract (round 15): the field names WHICH service and WHICH resource shape
 * its ARN must carry — a change-set id is not a stack id is not an SNS topic, and an ARN-shaped
 * string with the wrong semantics is a malformed response, not a reference. Mandatory
 * components are enforced: non-empty partition, the exact service, a non-empty region and a
 * 12-digit account — `arn:::::x` satisfies nothing. */
const arnRef = (service, resource) => ({ kind: 'arnReference', service, resource });
const UUID_TEXT = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const CHANGE_SET_ARN = arnRef('cloudformation', new RegExp(`^changeSet/[a-zA-Z][-a-zA-Z0-9]*/${UUID_TEXT}$`));
const STACK_ARN = arnRef('cloudformation', new RegExp(`^stack/[a-zA-Z][-a-zA-Z0-9]*/${UUID_TEXT}$`));
const SNS_TOPIC_ARN = arnRef('sns', /^[a-zA-Z0-9_-]{1,256}$/);
const CLOUDWATCH_ALARM_ARN = arnRef('cloudwatch', /^alarm:.+$/);
const ENTITY_REFERENCE = { kind: 'entityReference' };
const IDENTIFIER = { kind: 'identifier' };
const RESOURCE_TYPE = { kind: 'resourceType' };
const INSTANT = { kind: 'instant' };
const TAG_KEY = { kind: 'tagKey' };
const integer = (min, max) => ({ kind: 'integer', min, max });
const nullable = (node) => ({ ...node, nullable: true });
const vocab = (...values) => ({ kind: 'vocabulary', values });
const list = (items) => ({ kind: 'list', items });
const object = (fields) => ({ kind: 'object', fields });

const RESOURCE_ATTRIBUTES = ['Properties', 'Metadata', 'CreationPolicy', 'UpdatePolicy', 'DeletionPolicy', 'UpdateReplacePolicy', 'Tags'];

const CHANGE_SET_SCHEMA = object({
  // ---- identity and lineage -------------------------------------------------------------------
  ChangeSetName: { kind: 'changeSetName' },
  ChangeSetId: CHANGE_SET_ARN,
  StackId: STACK_ARN,
  StackName: { kind: 'stackName' },
  ParentChangeSetId: CHANGE_SET_ARN,
  RootChangeSetId: CHANGE_SET_ARN,
  CreationTime: INSTANT,
  Description: OPAQUE,
  NextToken: { kind: 'pageToken' },
  // ---- executable semantics -------------------------------------------------------------------
  Status: vocab('CREATE_PENDING', 'CREATE_IN_PROGRESS', 'CREATE_COMPLETE', 'DELETE_PENDING', 'DELETE_IN_PROGRESS', 'DELETE_COMPLETE', 'DELETE_FAILED', 'FAILED'),
  StatusReason: OPAQUE,
  ExecutionStatus: vocab('UNAVAILABLE', 'AVAILABLE', 'EXECUTE_IN_PROGRESS', 'EXECUTE_COMPLETE', 'EXECUTE_FAILED', 'OBSOLETE'),
  OnStackFailure: vocab('DO_NOTHING', 'ROLLBACK', 'DELETE'),
  Capabilities: list(vocab('CAPABILITY_IAM', 'CAPABILITY_NAMED_IAM', 'CAPABILITY_AUTO_EXPAND')),
  IncludeNestedStacks: BOOLEAN,
  ImportExistingResources: BOOLEAN,
  // Drift-aware members. `REVERT_DRIFT` is the ONLY documented DeploymentMode value — the round-12
  // schema invented `STANDARD`, which would have accepted a mode AWS never sends.
  DeploymentMode: vocab('REVERT_DRIFT'),
  StackDriftStatus: vocab('DRIFTED', 'IN_SYNC', 'UNKNOWN', 'NOT_CHECKED'),
  NotificationARNs: list(SNS_TOPIC_ARN),
  RollbackConfiguration: object({
    RollbackTriggers: list(object({ Arn: CLOUDWATCH_ALARM_ARN, Type: RESOURCE_TYPE })),
    MonitoringTimeInMinutes: integer(0, 180),
  }),
  Parameters: list(object({
    ParameterKey: IDENTIFIER,
    ParameterValue: OPAQUE,
    UsePreviousValue: BOOLEAN,
    ResolvedValue: OPAQUE,
  })),
  Tags: list(object({ Key: TAG_KEY, Value: OPAQUE })),
  // ---- the resource changes -------------------------------------------------------------------
  Changes: list(object({
    Type: vocab('Resource'),
    HookInvocationCount: nullable(integer(1, 100)),
    ResourceChange: object({
      Action: vocab('Add', 'Modify', 'Remove', 'Import', 'Dynamic', 'SyncWithActual'),
      PolicyAction: vocab('Delete', 'Retain', 'Snapshot', 'ReplaceAndDelete', 'ReplaceAndRetain', 'ReplaceAndSnapshot'),
      LogicalResourceId: IDENTIFIER,
      PhysicalResourceId: OPAQUE,
      ResourceType: RESOURCE_TYPE,
      Replacement: vocab('True', 'False', 'Conditional'),
      Scope: list(vocab(...RESOURCE_ATTRIBUTES)),
      ChangeSetId: CHANGE_SET_ARN,
      ModuleInfo: object({ TypeHierarchy: OPAQUE, LogicalIdHierarchy: OPAQUE }),
      BeforeContext: OPAQUE,
      AfterContext: OPAQUE,
      PreviousDeploymentContext: OPAQUE,
      ResourceDriftStatus: vocab('IN_SYNC', 'MODIFIED', 'DELETED', 'NOT_CHECKED', 'UNKNOWN', 'UNSUPPORTED'),
      ResourceDriftIgnoredAttributes: list(object({
        Path: OPAQUE,
        Reason: vocab('MANAGED_BY_AWS', 'WRITE_ONLY_PROPERTY'),
      })),
      Details: list(object({
        Evaluation: vocab('Static', 'Dynamic'),
        ChangeSource: vocab('ResourceReference', 'ParameterReference', 'ResourceAttribute', 'DirectModification', 'Automatic', 'NoModification'),
        CausingEntity: ENTITY_REFERENCE,
        Target: object({
          Attribute: vocab(...RESOURCE_ATTRIBUTES),
          Name: IDENTIFIER,
          RequiresRecreation: vocab('Never', 'Conditionally', 'Always'),
          AttributeChangeType: vocab('Add', 'Remove', 'Modify', 'SyncWithActual'),
          Path: OPAQUE,
          BeforeValue: OPAQUE,
          AfterValue: OPAQUE,
          BeforeValueFrom: vocab('PREVIOUS_DEPLOYMENT_STATE', 'ACTUAL_STATE'),
          AfterValueFrom: vocab('TEMPLATE'),
          Drift: object({
            ActualValue: OPAQUE,
            PreviousValue: OPAQUE,
            DriftDetectionTimestamp: INSTANT,
          }),
        }),
      })),
    }),
  })),
});

const CHANGE_SET_NAME_EXACT = /^cba-70-[0-9a-f]{12}$/;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const IDENTIFIER_EXACT = /^[A-Za-z][A-Za-z0-9]{0,254}$/;
const RESOURCE_TYPE_EXACT = /^[A-Za-z0-9]+::[A-Za-z0-9]+::[A-Za-z0-9]+$/;
/** The AWS tag-key charset. A tag KEY is a label the operator chose; its VALUE stays opaque. */
const TAG_KEY_EXACT = /^[A-Za-z][A-Za-z0-9:._/+ -]{0,127}$/;

/** The stack names THIS deploy computes — the validator for every stack-name position. */
let REVIEWED_STACK_NAMES = new Set();
function setReviewedStackNames(names) {
  REVIEWED_STACK_NAMES = new Set(names);
}

/** Does `value` satisfy the contract at this leaf position? Never reports the value itself. */
function leafSatisfies(value, node) {
  switch (node.kind) {
    case 'boolean': return typeof value === 'boolean';
    case 'integer': return typeof value === 'number' && Number.isInteger(value) && value >= node.min && value <= node.max;
    case 'vocabulary': return typeof value === 'string' && node.values.includes(value);
    case 'identifier': return typeof value === 'string' && IDENTIFIER_EXACT.test(value);
    case 'tagKey': return typeof value === 'string' && TAG_KEY_EXACT.test(value);
    case 'resourceType': return typeof value === 'string' && RESOURCE_TYPE_EXACT.test(value);
    case 'stackName': return typeof value === 'string' && REVIEWED_STACK_NAMES.has(value);
    case 'changeSetName': return typeof value === 'string' && CHANGE_SET_NAME_EXACT.test(value);
    case 'instant': return typeof value === 'string' && ISO_INSTANT.test(value);
    case 'pageToken': return typeof value === 'string' && value.length >= 1 && value.length <= 1024;
    case 'arnReference': {
      if (typeof value !== 'string') return false;
      const m = value.match(/^arn:([a-z][a-z0-9-]*):([a-z0-9-]+):([a-z0-9-]+):(\d{12}):(.+)$/);
      return m !== null && m[2] === node.service && node.resource.test(m[5]);
    }
    case 'entityReference': return typeof value === 'string';
    case 'opaque': return typeof value === 'string'; // content is a STRING in the contract
    default: return false;
  }
}

/**
 * THE single structural validation: unknown keys, wrong types and out-of-contract enums, at every
 * depth. Violations name the PATH and the reason — never the value, which is not proven public.
 */
function validateChangeSet(value, node = CHANGE_SET_SCHEMA, path = '$') {
  const out = [];
  if (value === undefined) return out; // an absent optional member
  if (value === null) {
    // ROUND 14: null is a VALUE, not absence. Only a position the contract documents as
    // nullable may carry it; anywhere else an explicit null is a malformed response.
    return node && node.nullable ? out : [`${path}: null is not a documented state for this field`];
  }
  if (node.kind === 'object') {
    if (typeof value !== 'object' || Array.isArray(value)) return [`${path}: expected an object`];
    for (const [key, entry] of Object.entries(value)) {
      if (!Object.hasOwn(node.fields, key)) {
        out.push(`${path}.${key}: field is not in the reviewed schema`);
        continue;
      }
      out.push(...validateChangeSet(entry, node.fields[key], `${path}.${key}`));
    }
    return out;
  }
  if (node.kind === 'list') {
    if (!Array.isArray(value)) return [`${path}: expected a list`];
    value.forEach((entry, i) => out.push(...validateChangeSet(entry, node.items, `${path}[${i}]`)));
    return out;
  }
  if (typeof value === 'object') return [`${path}: expected a scalar`];
  if (!leafSatisfies(value, node)) {
    out.push(node.kind === 'vocabulary' ? `${path}: value is outside the reviewed contract` : `${path}: value does not satisfy the ${node.kind} contract`);
  }
  return out;
}

/** Render `value` at its schema POSITION. Content positions — and any value its position rejects
 * — become the CONSTANT redaction for their class. */
function sanitizeBySchema(value, node = CHANGE_SET_SCHEMA) {
  if (value === null || value === undefined) return value;
  if (!node) return REDACT.value;
  switch (node.kind) {
    case 'object': {
      if (typeof value !== 'object' || Array.isArray(value)) return REDACT.value;
      const out = {};
      for (const [key, entry] of Object.entries(value)) {
        if (!Object.hasOwn(node.fields, key)) {
          out[REDACT.key] = REDACT.value;
          continue;
        }
        out[key] = sanitizeBySchema(entry, node.fields[key]);
      }
      return out;
    }
    case 'list':
      return Array.isArray(value) ? value.map((entry) => sanitizeBySchema(entry, node.items)) : REDACT.value;
    case 'arnReference':
      // Validation already required THIS position's service and resource shape.
      return leafSatisfies(value, node) ? renderResidual(renderArn(value)) : REDACT.value;
    case 'entityReference':
      if (typeof value !== 'string') return REDACT.value;
      if (/^arn:/.test(value)) return renderResidual(renderArn(value));
      if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(value)) return renderResidual(renderUrl(value));
      return IDENTIFIER_EXACT.test(value) ? value : REDACT.value;
    case 'opaque':
      return REDACT.value;
    default:
      return leafSatisfies(value, node) ? value : REDACT.value;
  }
}

/** The sanitized, presentation-only rendering of a plan. Nothing here is ever digested.
 *
 * Round 13: this function VALIDATES what it is handed — it does not trust a caller to have
 * remembered — and it prints `changed` / `unchanged` computed from the RAW values in memory
 * instead of publishing a derivation of them. A response that violates the reviewed schema is
 * not rendered at all: the material says so and names the offending PATHS, never their values. */
function renderPlan(planEntries) {
  const lines = [];
  const list = (values) => (Array.isArray(values) && values.length > 0 ? values.join(', ') : 'none');
  for (const rawEntry of planEntries) {
    const stackName = sanitizeBySchema(String(rawEntry.stackName ?? ''), { kind: 'stackName' });
    const status = sanitizeBySchema(String(rawEntry.status ?? ''), { kind: 'vocabulary', values: ['CREATE_COMPLETE', 'NO_CHANGES', 'FAILED'] });
    const raw = rawEntry.describe ?? { Changes: rawEntry.changes ?? [] };
    const violations = validateChangeSet(raw);
    if (violations.length > 0) {
      lines.push(`  ${stackName} — ${status}`);
      lines.push('      NOT RENDERED — the response violates the reviewed schema, so it describes semantics nobody reviewed:');
      for (const violation of violations.slice(0, 20)) lines.push(`        ${violation}`);
      if (violations.length > 20) lines.push(`        …and ${violations.length - 20} more`);
      continue;
    }
    const describe = sanitizeBySchema(raw);
    const changes = describe.Changes ?? [];
    const rawChanges = raw.Changes ?? [];
    lines.push(`  ${stackName} — ${status}${status === 'NO_CHANGES' ? '' : ` (${changes.length} change${changes.length === 1 ? '' : 's'})`}`);
    // The executable semantics, named — never inferred from the resource diff.
    lines.push(`      execution: ${describe.ExecutionStatus ?? 'unknown'}   on-failure: ${describe.OnStackFailure ?? 'unspecified'}   nested-stacks: ${describe.IncludeNestedStacks ?? 'unspecified'}   import-existing: ${describe.ImportExistingResources ?? 'unspecified'}`);
    lines.push(`      deployment-mode: ${describe.DeploymentMode ?? 'unspecified'}   drift: ${describe.StackDriftStatus ?? 'unspecified'}`);
    lines.push(`      capabilities: ${list(describe.Capabilities)}`);
    lines.push(`      notifications: ${list(describe.NotificationARNs)}`);
    const rollback = describe.RollbackConfiguration ?? {};
    lines.push(`      rollback: monitoring ${rollback.MonitoringTimeInMinutes ?? 'unspecified'} min, triggers ${list((rollback.RollbackTriggers ?? []).map((t) => `${t.Arn ?? '?'}(${t.Type ?? '?'})`))}`);
    lines.push(`      tags: ${list((describe.Tags ?? []).map((t) => `${t.Key ?? '?'}=${t.Value ?? '?'}`))}`);
    lines.push(`      parameters: ${list((describe.Parameters ?? []).map((p) => `${p.ParameterKey ?? '?'}=${p.ParameterValue ?? p.ResolvedValue ?? '(previous)'}`))}`);
    if (describe.ParentChangeSetId || describe.RootChangeSetId) {
      lines.push(`      nested lineage: parent ${describe.ParentChangeSetId ?? 'none'}, root ${describe.RootChangeSetId ?? 'none'}`);
    }
    changes.forEach((change, changeIndex) => {
      const rc = change.ResourceChange || {};
      const rawRc = rawChanges[changeIndex]?.ResourceChange || {};
      const flags = [
        rc.Replacement === 'True' ? '[REPLACEMENT]' : '',
        rc.PolicyAction ? `[policy: ${rc.PolicyAction}]` : '',
        Array.isArray(rc.Scope) && rc.Scope.length > 0 ? `[scope: ${rc.Scope.join(',')}]` : '',
        rc.ResourceDriftStatus ? `[resource-drift: ${rc.ResourceDriftStatus}]` : '',
      ].filter(Boolean).join('  ');
      lines.push(`    ${rc.Action || '?'}  ${rc.ResourceType || '?'}  ${rc.LogicalResourceId || '?'}${flags ? `  ${flags}` : ''}`);
      (rc.Details || []).forEach((detail, detailIndex) => {
        const target = detail.Target || {};
        const rawTarget = rawRc.Details?.[detailIndex]?.Target || {};
        const attr = target.Attribute === 'Properties' && target.Name ? `Properties.${target.Name}` : (target.Attribute || '?');
        lines.push(`      ~ ${attr}${detail.CausingEntity ? `  (caused by ${detail.CausingEntity})` : ''}${target.RequiresRecreation && target.RequiresRecreation !== 'Never' ? `  [recreation: ${target.RequiresRecreation}]` : ''}${target.AttributeChangeType ? `  [${target.AttributeChangeType}]` : ''}`);
        // ROUND 13: the DELTA is computed in memory from the raw values and stated as a flag;
        // the values themselves are redacted with a constant, so nothing derived from them is
        // published. Where the values came from (drift-aware) is contract vocabulary and shows.
        if (rawTarget.BeforeValue !== undefined || rawTarget.AfterValue !== undefined) {
          const changed = rawTarget.BeforeValue !== rawTarget.AfterValue;
          const from = target.BeforeValueFrom ? ` (before from ${target.BeforeValueFrom}` : '';
          const to = target.AfterValueFrom ? `${from ? ', ' : ' ('}after from ${target.AfterValueFrom}` : '';
          const provenance = from || to ? `${from}${to})` : '';
          lines.push(`        value: ${changed ? 'changed' : 'unchanged'} (before ${target.BeforeValue ?? 'absent'}, after ${target.AfterValue ?? 'absent'})${provenance}`);
        }
        if (target.Drift) {
          const drifted = rawTarget.Drift?.ActualValue !== rawTarget.Drift?.PreviousValue;
          lines.push(`        drift: ${drifted ? 'actual differs from previous deployment' : 'actual matches previous deployment'} (detected ${target.Drift.DriftDetectionTimestamp ?? 'unknown'})`);
        }
      });
      for (const ignored of rc.ResourceDriftIgnoredAttributes ?? []) {
        lines.push(`      drift ignored: ${ignored.Path ?? '?'} (${ignored.Reason ?? '?'})`);
      }
    });
    // The complete change set, canonically ordered — the lines above are a reading aid, this is
    // the material. Sorting keys keeps two renderings of the same plan textually comparable.
    lines.push(`      full change set (sanitized): ${JSON.stringify(deepSortKeys(describe))}`);
  }
  return lines.join('\n');
}

/** Five seconds between stack-status polls; injectable so tests never actually wait. */
function defaultSleep() {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5000);
}

/** Default git reader: injectable, so the HEAD/worktree binding is testable offline. */
function defaultGit(args) {
  const res = spawnSync('git', args, { encoding: 'utf8' });
  return { status: res.status === null ? 1 : res.status, stdout: res.stdout || '' };
}

/**
 * Copy the assembly into a fresh PRIVATE directory and digest the COPY.
 *
 * The digest-then-deploy gap on the original path was a real window: the preflight digested it, the
 * child read it later, and anything running in between could swap a Lambda bundle. Digesting the
 * snapshot closes the gap by construction — whatever was copied is exactly what is digested and
 * exactly what `--app` deploys, and the original is never reopened after this function returns.
 *
 * @returns {{dir: string, digest: string} | {error: string}}
 */
function snapshotAssembly(srcDir, tmpBase = os.tmpdir()) {
  const walked = walkAssembly(srcDir);
  if (walked.error) return walked;
  let dir = null;
  try {
    dir = fs.mkdtempSync(path.join(tmpBase, 'cba-assembly-'));
    for (const f of walked.files) {
      const dest = path.join(dir, f.rel);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(f.abs, dest);
      // Preserve the executable bit: the digest binds it (round 6), and a copy that dropped it
      // would refuse a perfectly honest assembly.
      fs.chmodSync(dest, fs.statSync(f.abs).mode & 0o777);
    }
  } catch {
    // A partial snapshot is not evidence of anything — and it must not outlive the failure.
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
    return { error: 'ASSEMBLY_UNREADABLE' };
  }
  const d = assemblyDigest(dir);
  if (d.error) {
    fs.rmSync(dir, { recursive: true, force: true });
    return d;
  }
  return { dir, digest: d.digest };
}

/**
 * Verify, then deploy the verified values — one process, one context object.
 *
 * @returns {{exit:number, output:string, executed:boolean}}
 */
function runDeployRelease(argv, { run = defaultRun, exec = defaultExec, git = defaultGit, cdkJsonPath = path.join(__dirname, '..', 'cdk.json'), readFile = fs.readFileSync, env = process.env, tmpBase = os.tmpdir(), now = () => Date.now(), print = (text) => process.stdout.write(text), sleep = defaultSleep, evidenceMaxUtf16 = EVIDENCE_MAX_UTF16 } = {}) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    return { exit: EXIT.USAGE, output: `${err.message}\n\n${usage()}`, executed: false };
  }
  if (opts.help) return { exit: EXIT.OK, output: usage(), executed: false };
  for (const [key, label] of [['manifest', '--manifest'], ['environment', '--environment'], ['releaseSha', '--release-sha'], ['region', '--region'], ['assembly', '--assembly']]) {
    if (!opts[key]) return { exit: EXIT.USAGE, output: `${label} is required\n\n${usage()}`, executed: false };
  }

  // SPEC-LANE-006/RUN-007: evidence exists only when it can be TIED to a decision. An artifact
  // request without a well-formed correlation id refuses before anything else runs — unattributable
  // evidence is not evidence, and writing it anyway would invite exactly the timestamp-window
  // guessing the correlation id exists to end.
  let correlationId = null;
  if (opts.artifactOut) {
    correlationId = typeof env.CORRELATION_ID === 'string' ? env.CORRELATION_ID : '';
    if (!CORRELATION_ID_RE.test(correlationId)) {
      return {
        exit: EXIT.REFUSED,
        output: 'deploy-release — CORRELATION_MALFORMED: --artifact-out requires CORRELATION_ID matching cba-70- plus exactly 32 lowercase hex; evidence that cannot be tied to a decision is not evidence.\nREFUSED. Nothing was deployed.',
        executed: false,
      };
    }
  }

  const failures = [];
  // The CLOSED evidence record (SPEC-RUN-007/DEPLOY-018): change sets by NAME (an id is an ARN
  // and never enters evidence — SPEC-DEPLOY-006), the honest partial `executed` list on every
  // halt, and the refusal codes verbatim. Written on EVERY exit after the correlation was proven.
  const evidence = {
    schema: 'cba-release-evidence/1',
    correlationId,
    releaseSha: null,
    environment: opts.environment,
    mode: null,
    decisionId: null,
    stacks: null,
    planDigest: null,
    changeSets: [],
    executed: [],
    outcome: null,
    refusals: [],
    rendering: null,
  };
  const writeEvidence = (outcome) => {
    if (!opts.artifactOut) return;
    evidence.outcome = outcome;
    evidence.refusals = failures.map((f) => f.code);
    // ROUND I3-3: the record is bounded to the TRANSPORT it must survive — never truncated,
    // reshaped by named codes when the cap forces it (the run-level law below refuses first).
    const bounded = boundedEvidence(evidence, evidenceMaxUtf16);
    fs.mkdirSync(path.dirname(opts.artifactOut), { recursive: true });
    fs.writeFileSync(opts.artifactOut, `${JSON.stringify(bounded, null, 2)}\n`);
  };
  const refuse = () => {
    const lines = [`deploy-release — environment ${opts.environment}`, '  FAIL  BINDING'];
    for (const f of failures) lines.push(`          ${describeFailure(f)}`);
    lines.push('', 'REFUSED. Nothing was deployed.');
    writeEvidence('REFUSED');
    return { exit: EXIT.REFUSED, output: lines.join('\n'), executed: false };
  };

  // 1. The manifest, closed all the way down. A tampered nested claim is a forgery, not a variant.
  let manifest = null;
  try {
    const raw = readFile(opts.manifest, 'utf8');
    try {
      manifest = JSON.parse(raw);
    } catch {
      failures.push({ check: 'VERIFY', code: 'MANIFEST_MALFORMED', field: 'manifest' });
    }
  } catch {
    failures.push({ check: 'VERIFY', code: 'MANIFEST_UNREADABLE', field: 'manifest' });
  }
  if (manifest && !validManifestShape(manifest)) {
    failures.push({ check: 'VERIFY', code: 'MANIFEST_MALFORMED', field: 'manifest' });
    manifest = null;
  }
  if (!manifest) return refuse();

  // 2. Identity: this environment, this release, this region, this service.
  if (manifest.environment !== opts.environment) failures.push({ check: 'VERIFY', code: 'MANIFEST_ENVIRONMENT_MISMATCH', field: 'environment' });
  if (manifest.releaseSha !== opts.releaseSha) failures.push({ check: 'VERIFY', code: 'MANIFEST_RELEASE_MISMATCH', field: 'releaseSha' });
  if (manifest.region !== opts.region) failures.push({ check: 'VERIFY', code: 'MANIFEST_REGION_MISMATCH', field: 'region' });
  if (manifest.target.service !== MANIFEST_TARGET_SERVICE) failures.push({ check: 'VERIFY', code: 'DEPLOY_TARGET_UNSUPPORTED', field: 'target' });
  if (failures.length > 0) return refuse();
  evidence.releaseSha = manifest.releaseSha;

  // 2b. The RELEASE, bound to reality. The manifest naming a SHA proves nothing about the files on
  //     disk: round 4 reproduced a verified deploy whose HEAD was a different commit entirely. The
  //     working tree must BE the release, exactly, with nothing on top.
  const head = git(['rev-parse', 'HEAD']);
  if (head.status !== 0 || head.stdout.trim() !== manifest.releaseSha) {
    failures.push({ check: 'VERIFY', code: 'RELEASE_HEAD_MISMATCH', field: 'releaseSha' });
  }
  const status = git(['status', '--porcelain']);
  if (status.status !== 0 || status.stdout.trim() !== '') {
    failures.push({ check: 'VERIFY', code: 'WORKTREE_DIRTY', field: 'worktree' });
  }
  if (failures.length > 0) return refuse();

  // 2c. The ASSEMBLY, snapshotted and bound by digest. The copy happens FIRST and the digest is
  //     computed from the copy, so the value that is compared is the value that deploys — mutating
  //     the original after this point changes nothing the child will read.
  //
  //     From here on, ONE owner: everything below runs inside the try, and the finally removes the
  //     snapshot on every path out — refusals included. Round 6 found snapshots surviving the
  //     account and context refusals, which retains source assets on persistent runners.
  const snapshot = snapshotAssembly(opts.assembly, tmpBase);
  if (snapshot.error) {
    failures.push({ check: 'VERIFY', code: snapshot.error, field: 'assembly' });
    return refuse();
  }
  try {
    if (snapshot.digest !== manifest.assemblyDigest) {
      failures.push({ check: 'VERIFY', code: 'ASSEMBLY_DIGEST_MISMATCH', field: 'assemblyDigest' });
      return refuse();
    }

    // 3. The effective context and the account, digested and compared. THIS context object — not a
    //    copy, not a re-read — is what the deploy arguments are built from below.
    const context = loadContext(opts.context, cdkJsonPath);
    const accountAtVerify = resolveAccountId(run);
    if (!accountAtVerify) {
      failures.push({ check: 'VERIFY', code: 'ACCOUNT_UNRESOLVED', field: 'targetAccount' });
      return refuse();
    }
    const recomputed = contextDigest({
      releaseSha: manifest.releaseSha,
      environment: manifest.environment,
      region: manifest.region,
      accountId: accountAtVerify,
      context,
    });
    if (recomputed !== manifest.contextDigest) {
      failures.push({ check: 'VERIFY', code: 'MANIFEST_RECOMPUTE_MISMATCH', field: 'contextDigest' });
      return refuse();
    }

    // 4. The account again, immediately before the effect. A swap between verification and deploy
    //    is the round-3 reproduction; re-resolving here shrinks the window to this process's own
    //    gap between the check and the spawn, which is disclosed at the top of this file.
    const accountAtDeploy = resolveAccountId(run);
    if (accountAtDeploy !== accountAtVerify) {
      failures.push({ check: 'DEPLOY', code: 'ACCOUNT_CHANGED', field: 'targetAccount' });
      return refuse();
    }

    // 4b. THE HUMAN AUTHORIZATION, now that every binding held and before any child process
    //     exists. The Environment protection answers WHO may run this lane; the cloud gate binds
    //     the RUN to a reviewed plan: Zamp names the exact release, the exact assembly digest, a
    //     mode and an expiry. No gate, no children — absence is a refusal, never a default.
    const gateCheck = checkCloudGate(env.CBA_CLOUD_GATE, manifest, now());
    if (gateCheck.failures) {
      failures.push(...gateCheck.failures);
      return refuse();
    }
    const gate = gateCheck.gate;
    evidence.mode = gate.mode;
    evidence.decisionId = gate.decisionId;
    evidence.stacks = [...gate.stacks];

  // 5. THE PLAN IS THE CHANGE SETS. plan_only PREPARES one named change set per stack from the
  //    verified snapshot and digests the canonical UNREDACTED describes; deploy re-describes the
  //    SAME change sets, requires the digest the gate NAMES, and executes exactly them. `--all`
  //    does not exist here; `--exclusively` pins the prepare to the closed set; the execution
  //    order is the reviewed dependency order, not the alphabetical closed set.
    // Round 5: the GATE names which reviewed plan group this run covers — a dependency wave on a
    // fresh tier (Fn::ImportValue producers must EXECUTE before consumers can even be planned),
    // or the full set in steady state. The group was validated against the closed list; the
    // manifest still bounds it: every named stack is inside the closed deployable set.
    const orderedStacks = DEPLOYMENT_EXECUTION_ORDER.filter((id) => gate.stacks.includes(id) && manifest.target.stacks.includes(id));
    // The ONLY stack names review material may render verbatim: the ones THIS release computed.
    setReviewedStackNames(manifest.target.stacks.map((id) => stackNameFor(manifest.environment, id)));
    const qualifier = RELEASE_BOOTSTRAP_QUALIFIERS[manifest.environment];
    const changeSetName = `cba-70-${manifest.releaseSha.slice(0, 12)}`;
    const childEnv = {
      ...env,
      AWS_REGION: manifest.region,
      AWS_DEFAULT_REGION: manifest.region,
      CDK_DEFAULT_REGION: manifest.region,
    };
    const header = [
      `deploy-release — environment ${manifest.environment}, release ${manifest.releaseSha.slice(0, 12)}`,
      `  PASS  BINDING (digest ${manifest.contextDigest.slice(0, 16)}…, account pinned, plan group: ${orderedStacks.join(' ')})`,
    ];

    // 5a. plan_only: PREPARE the named change sets — the one moment new change sets may be
    //     created. The CDK child publishes assets and creates (never executes) one change set
    //     per stack, all named for this release, all from the verified snapshot.
    if (gate.mode === 'plan_only') {
      const prepare = exec(['cdk', 'deploy', '--method=prepare-change-set', '--change-set-name', changeSetName, '--exclusively', ...orderedStacks, '--require-approval', 'never', '--app', snapshot.dir], childEnv);
      if (prepare.status !== 0) {
        failures.push({ check: 'PLAN', code: 'PLAN_PREPARE_FAILED', field: 'plan' });
        const refused = refuse();
        return { ...refused, output: `${refused.output}\n\n--- prepare child evidence ---\n${childEvidence(prepare)}` };
      }
    }

    // 5b. DESCRIBE the change sets under this tier's assumed deploy role — in BOTH modes. The
    //     canonical entries carry the immutable change-set ids and the full, unredacted change
    //     details; their digest is what a deploy-mode gate names. (Round 4: digesting after
    //     sanitization let two plans differing only in an ARN principal collide.)
    const credEnv = assumeBootstrapRole(run, { account: accountAtVerify, region: manifest.region, qualifier, name: 'deploy', session: `cba-70-${gate.mode}` });
    if (!credEnv) {
      failures.push({ check: 'PLAN', code: 'BOOTSTRAP_ROLE_UNASSUMABLE', field: 'deployRole' });
      return refuse();
    }
    const cfnEnv = { ...credEnv, AWS_REGION: manifest.region, AWS_DEFAULT_REGION: manifest.region };
    const planEntries = [];
    for (const stackId of orderedStacks) {
      const stackName = stackNameFor(manifest.environment, stackId);
      const described = describePlannedChangeSet(run, cfnEnv, stackName, changeSetName);
      if (described.missing) {
        failures.push({ check: 'PLAN', code: 'CHANGE_SET_MISSING', field: stackId });
        continue;
      }
      if (described.schemaViolations) {
        failures.push({ check: 'PLAN', code: 'CHANGE_SET_SCHEMA_UNKNOWN', field: stackId });
        continue;
      }
      if (described.paginationUnconsumed) {
        failures.push({ check: 'PLAN', code: 'CHANGE_SET_PAGINATION_UNCONSUMED', field: stackId });
        continue;
      }
      if (described.error) {
        failures.push({ check: 'PLAN', code: 'CHANGE_SET_UNREADABLE', field: stackId });
        continue;
      }
      // ROUND 12: a field the reviewed schema does not describe REFUSES the plan. An unreviewed
      // field can change what an approval means (DeploymentMode: REVERT_DRIFT is exactly that),
      // so the lane stops and a human extends the schema — never an opaque key nobody reads.
      // ROUNDS 13-14: ONE structural validation — unknown key, wrong type, undeclared null,
      // out-of-contract enum — on every RAW page BEFORE any normalization, then on the assembled
      // body, before any digest exists. A malformed response stops the lane; it can no longer
      // arrive as opaque text (or be normalized into innocence) and still collect a human gate.
      const rawViolations = (described.pages ?? []).flatMap((page) => validateChangeSet(page));
      if (rawViolations.length > 0 || validateChangeSet(described.described).length > 0) {
        failures.push({ check: 'PLAN', code: 'CHANGE_SET_SCHEMA_UNKNOWN', field: stackId });
        continue;
      }
      const entry = canonicalChangeSet(stackId, stackName, described.described);
      if (entry.status !== 'NO_CHANGES' && entry.status !== 'CREATE_COMPLETE') {
        failures.push({ check: 'PLAN', code: 'CHANGE_SET_FAILED', field: stackId });
        continue;
      }
      // Round 5: CREATE_COMPLETE is not enough — an OBSOLETE or otherwise unexecutable change
      // set must never receive a reviewable digest and a human gate only to fail at execution.
      if (entry.status !== 'NO_CHANGES' && entry.executionStatus !== 'AVAILABLE') {
        failures.push({ check: 'PLAN', code: 'CHANGE_SET_UNAVAILABLE', field: stackId });
        continue;
      }
      planEntries.push(entry);
    }
    if (failures.length > 0) return refuse();
    const digestOfPlan = planDigestOf(planEntries);
    evidence.planDigest = digestOfPlan;
    evidence.changeSets = planEntries.map((entry) => ({ stackName: entry.stackName, changeSetName, status: entry.status }));

    // The plan goes on the record BEFORE any effect — review material must exist before the
    // mutation it authorizes. Rendering is sanitized; the digest was not.
    const planBlock = [
      `  PLAN_DIGEST ${digestOfPlan}`,
      '',
      '--- plan (change sets, sanitized rendering) ---',
      renderPlan(planEntries),
      '',
    ].join('\n');
    print([...header, planBlock].join('\n'));

    // 5c. plan_only stops here, successfully: Zamp reviews the rendering, then issues a
    //     deploy-mode gate NAMING this digest. Only these exact change sets can then execute.
    if (gate.mode === 'plan_only') {
      evidence.rendering = renderPlan(planEntries);
      // ROUND I3-3: the transport is proven BEFORE the record becomes review material. A plan
      // whose full record cannot cross the channel REFUSES — the prepared change sets remain
      // (they are removable only under an abandon-mode authorization, exactly like a declined
      // plan), the bounded refusal evidence still travels, and no gate can be issued over a
      // rendering nobody could download complete.
      if (JSON.stringify({ ...evidence, outcome: 'PLAN_PREPARED', refusals: [] }, null, 2).length > evidenceMaxUtf16) {
        failures.push({ check: 'PLAN', code: 'PLAN_RENDERING_TOO_LARGE', field: 'rendering' });
        evidence.rendering = null;
        const refused = refuse();
        return { ...refused, output: `${refused.output}\nThe prepared change sets REMAIN (a refused plan is a declined plan): removing them is the abandon operation under its own authorization. Split the wave and plan again.` };
      }
      writeEvidence('PLAN_PREPARED');
      return {
        exit: EXIT.OK,
        output: [
          ...header,
          `  PLAN_DIGEST ${digestOfPlan}`,
          '  PLAN ONLY — the cloud gate authorizes preparation, not the effect. Nothing was deployed.',
          '',
          '--- plan (change sets, sanitized rendering) ---',
          renderPlan(planEntries),
        ].join('\n'),
        executed: false,
      };
    }

    // 5d. The plan the gate NAMED must be the plan that will execute — same change-set ids, same
    //     unredacted change details. A recreated change set, a drifted describe, or any edit
    //     refuses as PLAN_CHANGED: a changed world needs a new review.
    if (digestOfPlan !== gate.planDigest) {
      failures.push({ check: 'DEPLOY', code: 'PLAN_CHANGED', field: 'planDigest' });
      return refuse();
    }

    // 5e. REVALIDATION AT THE MUTATION BOUNDARY, in the round-4 order: identity FIRST (the STS
    //     round-trip takes real time), then the clock as the LAST operation before EACH
    //     execute — a gate that lapses during the account resolution, or between two stacks,
    //     refuses before the next mutation with the honest partial record.
    const accountAtEffect = resolveAccountId(run);
    if (accountAtEffect !== accountAtVerify) {
      failures.push({ check: 'DEPLOY', code: 'ACCOUNT_CHANGED', field: 'targetAccount' });
      return refuse();
    }
    const executed = [];
    evidence.executed = executed; // shared reference: every halt carries the honest partial list
    for (const entry of planEntries) {
      if (entry.status === 'NO_CHANGES') continue;
      if (Date.parse(gate.expiresAt) <= now()) {
        failures.push({ check: 'DEPLOY', code: 'CLOUD_GATE_EXPIRED', field: 'expiresAt' });
        const refused = refuse();
        return { ...refused, output: `${refused.output}\nExecuted before the window lapsed: ${executed.length === 0 ? 'none' : executed.join(', ')}. Remaining change sets were NOT executed.` };
      }
      const execution = run(['cloudformation', 'execute-change-set', '--change-set-name', entry.changeSetId, '--no-cli-pager'], { timeoutMs: 30_000, env: cfnEnv });
      if (!execution || execution.status !== 0) {
        failures.push({ check: 'DEPLOY', code: 'EXECUTE_FAILED', field: entry.stackId });
        const refused = refuse();
        return { ...refused, output: `${refused.output}\nExecuted before the failure: ${executed.length === 0 ? 'none' : executed.join(', ')}. Remaining change sets were NOT executed.` };
      }
      // ROUND I3-2: the mutation BEGAN the moment execute-change-set was accepted — recording it
      // only after the wait let a STACK_EXECUTION_FAILED artifact say "not executed" about a
      // stack the log said executed. `executed` means accepted-for-execution, and the evidence
      // record shares this array, so every later halt carries this stack.
      executed.push(entry.stackName);
      if (!waitForStack(run, cfnEnv, entry.stackName, { sleep })) {
        failures.push({ check: 'DEPLOY', code: 'STACK_EXECUTION_FAILED', field: entry.stackId });
        const refused = refuse();
        return { ...refused, output: `${refused.output}\nExecuted before the failure: ${executed.join(', ')}. Remaining change sets were NOT executed.` };
      }
    }
    writeEvidence('DEPLOYED');
    return {
      exit: EXIT.OK,
      output: [
        ...header,
        `  PLAN_DIGEST ${digestOfPlan} (matched the gate; decision ${gate.decisionId})`,
        executed.length === 0
          ? 'Every change set reported NO_CHANGES; the environment already IS the reviewed plan.'
          : `Executed the reviewed change sets, in order: ${executed.join(', ')}.`,
      ].join('\n'),
      executed: true,
    };
  } finally {
    fs.rmSync(snapshot.dir, { recursive: true, force: true });
  }
}

module.exports = { runDeployRelease, childEvidence, setReviewedStackNames, fingerprintSanitize, sanitizeBySchema, validateChangeSet, CHANGE_SET_SCHEMA, REDACT, checkCloudGate, planDigestOf, canonicalChangeSet, deepSortKeys, renderPlan, strictUtcInstant, CLOUD_GATE_KEYS, CLOUD_GATE_MODES, CLOUD_GATE_MAX_TTL_MS, EVIDENCE_MAX_UTF16, boundedEvidence, EXIT };

if (require.main === module) {
  const { exit, output } = runDeployRelease(process.argv.slice(2));
  process.stdout.write(`${output}\n`);
  process.exit(exit);
}
