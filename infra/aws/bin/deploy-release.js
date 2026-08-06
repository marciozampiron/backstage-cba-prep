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
    if (!base) base = body;
    changes.push(...(body.Changes || []));
    token = typeof body.NextToken === 'string' && body.NextToken !== '' ? body.NextToken : null;
    if (!token) {
      // The assembled description: every page's changes, no cursor left to follow.
      const { NextToken: _consumed, ...rest } = base;
      return { described: { ...rest, Changes: changes } };
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

/** STRUCTURED PSEUDONYMIZATION for review material (rounds 5-6). Pure redaction made two
 * principals indistinguishable, and an 8-hex fingerprint made them distinguishable but not
 * CLASSIFIABLE — Zamp could see that two hashes differed, never that one was the expected deploy
 * role and the other an attacker's. Review material now preserves the SAFE STRUCTURE — service,
 * region, resource type and resource path stay verbatim (role names in this project are public
 * repository content; the path is exactly what a human classifies by) — and pseudonymizes only
 * the ACCOUNT-identifying material, at 128 bits (32 hex — no feasible collision surface).
 * Stated limit: a 12-digit account space is enumerable offline against any unkeyed derivation;
 * this pseudonym prevents disclosure in logs (the same posture as mask-aws-account-id), it is
 * not cryptographic secrecy for the account id. */
function pseudonym(value) {
  return crypto.createHash('sha256').update(`cba-pseudonym:${value}`, 'utf8').digest('hex').slice(0, 32);
}

/** TYPE-AWARE rendering rules (round 7). A generic first-label rule reproduced the round-5
 * defect for ENDPOINTS: `cba-study-coach-pilot.workers.dev` and `evil.workers.dev` both became
 * opaque hashes, when the first label IS the identity Zamp reviews for the approved workers.dev
 * origin, the Cognito callbacks and CORS. And a generic "paths are public structure" rule leaked
 * the other way: KMS key UUIDs, API Gateway api ids, stack ids and URL query values are NOT
 * repository-public. So the renderer decides BY TYPE:
 *   - DECISION-BEARING hostnames render VERBATIM, from a reviewed suffix list (workers.dev — the
 *     approved pilot origin family; amazoncognito.com — the project-chosen auth domain;
 *     localhost). An UNKNOWN hostname renders as [unexpected-host#…] — visibly classifiable as
 *     something no reviewed decision produced.
 *   - GENERATED labels are pseudonymized inside known service domains (execute-api api ids).
 *   - URL query strings and fragments are stripped to [query-redacted] — tokens live there.
 *   - ARN resource parts are public for the services whose names THIS PROJECT chooses (iam,
 *     lambda, dynamodb, sns, logs, cloudwatch, s3, kms aliases, cloudformation stack NAMES) and
 *     pseudonymized where AWS generates them (kms key UUIDs, apigateway ids, cognito pool ids,
 *     cloudformation stack/changeset UUIDs). An UNKNOWN service's resource is pseudonymized
 *     whole — unknown is not proven public.
 */
const DECISION_BEARING_HOST_SUFFIXES = ['.workers.dev', '.amazoncognito.com'];
const UUID_SHAPE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g;
const UUID_EXACT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The names THIS PROJECT chose, as ANCHORED grammars — a whole segment, never a substring. */
const PROJECT_TOKEN = '(?:cba-study-coach|cdk-cbardev|cdk-cbarpil)-[A-Za-z0-9-]+';
const PROJECT_TOKEN_EXACT = new RegExp(`^${PROJECT_TOKEN}$`);

/** URL paths a reviewed decision produces: the committed auth callback/logout shapes, the Cognito
 * hosted-UI endpoints and the API stage roots. Any OTHER path is data, not reviewed structure —
 * round 9: a secret can live in a path segment as easily as in a query value. */
const REVIEWED_URL_PATHS = new Set(['', '/', '/auth/callback', '/login', '/logout', '/oauth2/authorize', '/oauth2/token', '/prod', '/$default']);

/* ================= ROUND 12: SANITIZATION BY POSITION, NOT BY KEY NAME =======================
 *
 * Round 11 chose a value's treatment from its KEY NAME, at any depth. Parsed content therefore
 * recovered trust by naming itself: `BeforeValue` holding `{"Key":"supersecret","Arn":"arn:…"}`
 * rendered `supersecret` and a role path, because `Key` and `Arn` are schema names SOMEWHERE.
 *
 * A field is now authorized by its POSITION in the DescribeChangeSet schema below — the same
 * name at a different path is a different field, and a name inside parsed content is not a field
 * at all. Two consequences, both deliberate:
 *
 *   1. `BeforeValue`, `AfterValue`, `BeforeContext`, `AfterContext` and every other content
 *      carrier are OPAQUE: one deterministic marker for the whole blob, never parsed and never
 *      walked, so no internal name can reach a validator. Equal blobs render equal markers, so
 *      "this value changed" stays visible. What is LOST is reading the callback URLs out of a
 *      property value — and that control was never here: PREFLIGHT-1 validates the exact auth
 *      URLs (no wildcards, no placeholders) and the manifest's contextDigest binds them to the
 *      release, so the origins are reviewed BEFORE a change set exists, not read back out of one.
 *
 *   2. A field the schema does not describe REFUSES THE PLAN (CHANGE_SET_SCHEMA_UNKNOWN) instead
 *      of rendering as an opaque key. An unreviewed field can change what an approval means —
 *      `DeploymentMode: REVERT_DRIFT` is exactly such a field — so the lane stops and a human
 *      extends this schema through review. Brittle on purpose: the alternative is authorizing
 *      semantics nobody read.
 */
const OPAQUE = { kind: 'opaque' };
const BOOLEAN = { kind: 'boolean' };
const NUMBER = { kind: 'number' };
const REFERENCE = { kind: 'reference' };
const IDENTIFIER = { kind: 'identifier' };
const RESOURCE_TYPE = { kind: 'resourceType' };
const vocab = (...values) => ({ kind: 'vocabulary', values });
const list = (items) => ({ kind: 'list', items });
const object = (fields) => ({ kind: 'object', fields });

const CHANGE_SET_SCHEMA = object({
  // ---- identity and lineage -------------------------------------------------------------------
  ChangeSetName: { kind: 'changeSetName' },
  ChangeSetId: REFERENCE,
  StackId: REFERENCE,
  StackName: { kind: 'stackName' },
  ParentChangeSetId: REFERENCE,
  RootChangeSetId: REFERENCE,
  CreationTime: { kind: 'instant' },
  Description: OPAQUE,
  // ---- executable semantics -------------------------------------------------------------------
  Status: vocab('CREATE_PENDING', 'CREATE_IN_PROGRESS', 'CREATE_COMPLETE', 'DELETE_PENDING', 'DELETE_IN_PROGRESS', 'DELETE_COMPLETE', 'DELETE_FAILED', 'FAILED'),
  StatusReason: OPAQUE,
  ExecutionStatus: vocab('UNAVAILABLE', 'AVAILABLE', 'EXECUTE_IN_PROGRESS', 'EXECUTE_COMPLETE', 'EXECUTE_FAILED', 'OBSOLETE'),
  OnStackFailure: vocab('DO_NOTHING', 'ROLLBACK', 'DELETE'),
  Capabilities: list(vocab('CAPABILITY_IAM', 'CAPABILITY_NAMED_IAM', 'CAPABILITY_AUTO_EXPAND')),
  IncludeNestedStacks: BOOLEAN,
  ImportExistingResources: BOOLEAN,
  // Round 12: both fields decide how CloudFormation INTERPRETS the change set, so both are named
  // vocabularies — REVERT_DRIFT must be distinguishable from a standard deployment at sight.
  DeploymentMode: vocab('STANDARD', 'REVERT_DRIFT'),
  StackDriftStatus: vocab('DRIFTED', 'IN_SYNC', 'UNKNOWN', 'NOT_CHECKED'),
  NotificationARNs: list(REFERENCE),
  RollbackConfiguration: object({
    RollbackTriggers: list(object({ Arn: REFERENCE, Type: RESOURCE_TYPE })),
    MonitoringTimeInMinutes: NUMBER,
  }),
  Parameters: list(object({
    ParameterKey: IDENTIFIER,
    ParameterValue: OPAQUE,
    UsePreviousValue: BOOLEAN,
    ResolvedValue: OPAQUE,
  })),
  Tags: list(object({ Key: IDENTIFIER, Value: OPAQUE })),
  // ---- the resource changes -------------------------------------------------------------------
  Changes: list(object({
    Type: vocab('Resource'),
    HookInvocationCount: NUMBER,
    ResourceChange: object({
      Action: vocab('Add', 'Modify', 'Remove', 'Import', 'Dynamic'),
      PolicyAction: vocab('Delete', 'Retain', 'Snapshot', 'ReplaceAndDelete', 'ReplaceAndRetain', 'ReplaceAndSnapshot'),
      LogicalResourceId: IDENTIFIER,
      PhysicalResourceId: OPAQUE,
      ResourceType: RESOURCE_TYPE,
      Replacement: vocab('True', 'False', 'Conditional'),
      Scope: list(vocab('Properties', 'Metadata', 'CreationPolicy', 'UpdatePolicy', 'DeletionPolicy', 'UpdateReplacePolicy', 'Tags')),
      ChangeSetId: REFERENCE,
      ModuleInfo: object({ TypeHierarchy: OPAQUE, LogicalIdHierarchy: OPAQUE }),
      BeforeContext: OPAQUE,
      AfterContext: OPAQUE,
      Details: list(object({
        Evaluation: vocab('Static', 'Dynamic'),
        ChangeSource: vocab('ResourceReference', 'ParameterReference', 'ResourceAttribute', 'DirectModification', 'Automatic'),
        CausingEntity: REFERENCE,
        Target: object({
          Attribute: vocab('Properties', 'Metadata', 'CreationPolicy', 'UpdatePolicy', 'DeletionPolicy', 'UpdateReplacePolicy', 'Tags'),
          Name: IDENTIFIER,
          RequiresRecreation: vocab('Never', 'Conditionally', 'Always'),
          AttributeChangeType: vocab('Add', 'Remove', 'Modify'),
          Path: OPAQUE,
          BeforeValue: OPAQUE,
          AfterValue: OPAQUE,
        }),
      })),
    }),
  })),
});

/** CloudFormation stamps this; ours is `cba-70-<12 hex of the release>`. */
const CHANGE_SET_NAME_EXACT = /^cba-70-[0-9a-f]{12}$/;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const IDENTIFIER_EXACT = /^[A-Za-z][A-Za-z0-9]{0,254}$/;
const RESOURCE_TYPE_EXACT = /^[A-Za-z0-9]+::[A-Za-z0-9]+::[A-Za-z0-9]+$/;

/** The stack names THIS deploy computes — the validator for every stack-name position. A name is
 * authorized because the release BUILT it, never because it looks like ours. */
let REVIEWED_STACK_NAMES = new Set();
function setReviewedStackNames(names) {
  REVIEWED_STACK_NAMES = new Set(names);
}

/** Every path in `value` the schema does not describe. A non-empty result refuses the plan. */
function schemaUnknownPaths(value, node = CHANGE_SET_SCHEMA, path = '$') {
  const out = [];
  if (!node) return [path];
  if (node.kind === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return out;
    for (const [key, entry] of Object.entries(value)) {
      const child = Object.hasOwn(node.fields, key) ? node.fields[key] : null;
      if (!child) {
        out.push(`${path}.${key}`);
        continue;
      }
      out.push(...schemaUnknownPaths(entry, child, `${path}.${key}`));
    }
    return out;
  }
  if (node.kind === 'list') {
    if (!Array.isArray(value)) return out;
    value.forEach((entry, i) => out.push(...schemaUnknownPaths(entry, node.items, `${path}[${i}]`)));
    return out;
  }
  return out; // leaf: the value is validated at render time, never trusted by name
}

/** Render `value` at its schema POSITION. Anything a position marks opaque — or any value its
 * position's validator rejects — becomes a deterministic marker. */
function sanitizeBySchema(value, node = CHANGE_SET_SCHEMA) {
  const marker = () => `[value#${pseudonym(typeof value === 'string' ? value : JSON.stringify(value) ?? String(value))}]`;
  if (value === null || value === undefined) return value;
  if (!node) return marker();
  switch (node.kind) {
    case 'object': {
      if (typeof value !== 'object' || Array.isArray(value)) return marker();
      const out = {};
      for (const [key, entry] of Object.entries(value)) {
        // A key the position does not declare cannot render — and the plan already refused.
        if (!Object.hasOwn(node.fields, key)) {
          out[`[key#${pseudonym(key)}]`] = marker.call(null);
          continue;
        }
        out[key] = sanitizeBySchema(entry, node.fields[key]);
      }
      return out;
    }
    case 'list':
      return Array.isArray(value) ? value.map((entry) => sanitizeBySchema(entry, node.items)) : marker();
    case 'boolean':
      return typeof value === 'boolean' ? value : marker();
    case 'number':
      return typeof value === 'number' ? value : marker();
    case 'vocabulary':
      return typeof value === 'string' && node.values.includes(value) ? value : marker();
    case 'identifier':
      return typeof value === 'string' && IDENTIFIER_EXACT.test(value) ? value : marker();
    case 'resourceType':
      return typeof value === 'string' && RESOURCE_TYPE_EXACT.test(value) ? value : marker();
    case 'stackName':
      return typeof value === 'string' && REVIEWED_STACK_NAMES.has(value) ? value : marker();
    case 'changeSetName':
      return typeof value === 'string' && CHANGE_SET_NAME_EXACT.test(value) ? value : marker();
    case 'instant':
      return typeof value === 'string' && ISO_INSTANT.test(value) ? value : marker();
    case 'reference':
      if (typeof value !== 'string') return marker();
      if (/^arn:/.test(value)) return renderResidual(renderArn(value));
      if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(value)) return renderResidual(renderUrl(value));
      return IDENTIFIER_EXACT.test(value) ? value : marker();
    case 'opaque':
    default:
      return marker();
  }
}

function renderHost(host) {
  const lower = host.toLowerCase();
  if (lower === 'localhost' || lower === '127.0.0.1') return host;
  if (DECISION_BEARING_HOST_SUFFIXES.some((suffix) => lower.endsWith(suffix))) return host;
  // Exact family, explicit parts: the generated api id pseudonymizes, the service suffix stays.
  const generated = lower.match(/^([a-z0-9-]+)\.(execute-api\.[a-z0-9-]+\.amazonaws\.com)$/);
  if (generated) return `[api#${pseudonym(generated[1])}].${generated[2]}`;
  // Round 8: NO blanket for *.amazonaws.com — a bucket-style or ELB-style host name is not
  // proven public by its suffix. Anything outside the exact families above is unexpected.
  return `[unexpected-host#${pseudonym(lower)}]`;
}

/** Round 9: URLs are FIELDS, not text. Any scheme reaches this classifier; only http(s) with a
 * reviewed host renders structurally; paths render ONLY when a reviewed decision produces that
 * exact shape; credentials never render; an unparseable candidate never falls back to raw text. */
function renderUrl(candidate) {
  let url;
  try {
    url = new URL(candidate);
  } catch {
    return `[unparseable-url#${pseudonym(candidate)}]`;
  }
  if (url.username || url.password) {
    return `[credentialed-url#${pseudonym(candidate)}]`;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return `[url#${pseudonym(candidate)}]`; // an unknown scheme is not proven public
  }
  const port = url.port ? `:${url.port}` : '';
  const path = REVIEWED_URL_PATHS.has(url.pathname) ? url.pathname : `/[path#${pseudonym(url.pathname)}]`;
  const suffix = url.search || url.hash ? '?[query-redacted]' : '';
  return `${url.protocol}//${renderHost(url.hostname)}${port}${path}${suffix}`;
}

/** Round 9: per-service resource grammars, ANCHORED — the grammar names exactly which segment is
 * project-owned identity and pseudonymizes every other segment (aliases, streams, sessions,
 * groups, generated ids). A resource whose COMPLETE shape a branch does not recognize fails
 * CLOSED to a whole-resource pseudonym — including inside known services. */
function renderArnResource(service, resource) {
  const whole = () => `[resource#${pseudonym(resource)}]`;
  if (service === 'iam') {
    // Principal material stays classifiable (the round-6 contract) — but only in its exact shape.
    return /^(role|policy|user|group|instance-profile|oidc-provider|saml-provider|server-certificate)\/[!-~]+$/.test(resource) ? resource : whole();
  }
  if (service === 'sts') {
    const assumed = resource.match(/^(assumed-role\/[^/]+)\/([^/]+)$/);
    return assumed ? `${assumed[1]}/[session#${pseudonym(assumed[2])}]` : whole();
  }
  if (service === 'kms') {
    if (new RegExp(`^alias/${PROJECT_TOKEN}$`).test(resource)) return resource;
    if (/^alias\/[^/]+$/.test(resource)) return `alias/[alias#${pseudonym(resource.slice(6))}]`;
    if (/^key\/[^/]+$/.test(resource)) return `key/[key#${pseudonym(resource.slice(4))}]`;
    return whole();
  }
  if (service === 'cognito-idp') {
    const pool = resource.match(/^userpool\/([a-z]{2}-[a-z]+-\d)_([A-Za-z0-9]+)(\/.+)?$/);
    if (!pool) return whole();
    const trailing = pool[3] ? `/[path#${pseudonym(pool[3].slice(1))}]` : '';
    return `userpool/${pool[1]}_[pool#${pseudonym(pool[2])}]${trailing}`;
  }
  if (service === 'cloudformation') {
    // ROUND 10: the COMPLETE grammar, anchored end to end. The round-9 form pseudonymized the
    // UUID and then accepted whatever trailed it, so `stack/name/<uuid>/extra` leaked `extra`.
    const withId = resource.match(/^(stack|changeSet)\/([^/]+)\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/);
    const nameOnly = resource.match(/^(stack|changeSet)\/([^/]+)$/);
    const m = withId || nameOnly;
    if (!m) return whole();
    const reviewedName = PROJECT_TOKEN_EXACT.test(m[2]) || /^cba-70-[0-9a-f]{12}$/.test(m[2]);
    const name = reviewedName ? m[2] : `[name#${pseudonym(m[2])}]`;
    return withId ? `${m[1]}/${name}/[id#${pseudonym(m[3])}]` : `${m[1]}/${name}`;
  }
  if (service === 'apigateway') {
    // The COMPLETE v2 grammar or nothing: /apis[/{id}[/{collection}[/{id}]]] with the reviewed
    // collections, or /tags/{arn}. A v1 path (restapis/…) or any unrecognized shape fails closed.
    if (resource === '/apis' || resource === '/tags/*') return resource;
    const tags = resource.match(/^\/tags\/(.+)$/);
    if (tags) return `/tags/[arn#${pseudonym(tags[1])}]`;
    const m = resource.match(/^\/apis\/([^/]+)(?:\/(routes|integrations|authorizers|deployments|models|stages|cors)(?:\/([^/]+))?)?$/);
    if (!m) return whole();
    const apiId = m[1] === '*' ? '*' : `[id#${pseudonym(m[1])}]`;
    if (!m[2]) return `/apis/${apiId}`;
    if (!m[3]) return `/apis/${apiId}/${m[2]}`;
    const childId = m[3] === '*' ? '*' : `[id#${pseudonym(m[3])}]`;
    return `/apis/${apiId}/${m[2]}/${childId}`;
  }
  if (service === 's3') {
    const slash = resource.indexOf('/');
    const bucket = slash === -1 ? resource : resource.slice(0, slash);
    const bucketOk = /^(cdk-cbardev-assets|cdk-cbarpil-assets|cba-study-coach)-[a-z0-9.-]+$/.test(bucket);
    const renderedBucket = bucketOk ? bucket : `[bucket#${pseudonym(bucket)}]`;
    return slash === -1 ? renderedBucket : `${renderedBucket}/[key#${pseudonym(resource.slice(slash + 1))}]`;
  }
  if (service === 'ssm') {
    return /^parameter\/cdk-bootstrap\/(cbardev|cbarpil)\/version$/.test(resource) ? resource : whole();
  }
  if (service === 'lambda') {
    const m = resource.match(new RegExp(`^function:(${PROJECT_TOKEN})(?::(.+))?$`));
    if (!m) return whole();
    return m[2] === undefined ? resource : `function:${m[1]}:[qualifier#${pseudonym(m[2])}]`;
  }
  if (service === 'dynamodb') {
    const m = resource.match(new RegExp(`^table/(${PROJECT_TOKEN})(?:/(index|stream)/(.+))?$`));
    if (!m) return whole();
    return m[2] === undefined ? resource : `table/${m[1]}/${m[2]}/[id#${pseudonym(m[3])}]`;
  }
  if (service === 'sns') {
    return PROJECT_TOKEN_EXACT.test(resource) ? resource : whole();
  }
  if (service === 'logs') {
    const m = resource.match(new RegExp(`^log-group:((?:/aws/[a-z0-9-]+/)?${PROJECT_TOKEN})(?::\\*)?(?::log-stream:(.+))?$`));
    if (!m) return whole();
    return m[2] === undefined ? resource : `log-group:${m[1]}:log-stream:[stream#${pseudonym(m[2])}]`;
  }
  if (service === 'cloudwatch') {
    return new RegExp(`^(alarm:|dashboard/)${PROJECT_TOKEN}$`).test(resource) ? resource : whole();
  }
  return whole(); // an unknown service is not proven public
}

/** An exact ARN token, parsed by FIELDS: arn:partition:service:region:account:resource. A token
 * that does not parse as an ARN never falls back to raw text. */
function renderArn(token) {
  const m = token.match(/^(arn):([a-zA-Z0-9-]*):([a-zA-Z0-9-]*):([a-zA-Z0-9-]*):(\d{12}|):(.+)$/);
  if (!m) return `[arn#${pseudonym(token)}]`;
  const acct = m[5] === '' ? '' : `[acct#${pseudonym(m[5])}]`;
  return `${m[1]}:${m[2]}:${m[3]}:${m[4]}:${acct}:${renderArnResource(m[3], m[6])}`;
}

/** Residual passes for identifying material embedded INSIDE classifier output — an account id
 * inside a kept bucket name, a UUID inside a kept path. The digit pass is hex-fenced so it can
 * never rewrite the inside of an already-emitted pseudonym. */
function renderResidual(token) {
  return token
    .replace(/\b([a-z]{2}-[a-z]+-\d)_([A-Za-z0-9]{5,})\b/g, (m, region, id) => `${region}_[pool#${pseudonym(id)}]`)
    .replace(UUID_SHAPE, (m) => `[id#${pseudonym(m)}]`)
    .replace(/(?<![0-9a-fA-F#])\d{12}(?![0-9a-fA-F])/g, (m) => `[acct#${pseudonym(m)}]`);
}

/** A free-position word. ROUND 11: there is no format allowance — a numeric string, a project
 * prefix and an identifier shape each proved nothing about the content behind them. Free text is
 * pseudonymized, always; KNOWN FIELDS with VALIDATED values never reach here. (URL and ARN spans
 * are lifted out before this runs — see sanitizeScalarString.) */
function renderFreeWord(word) {
  return `[value#${pseudonym(word)}]`;
}

/** URL and ARN spans, recognized ANYWHERE in a string — round 10: the round-9 classifier split on
 * whitespace and matched only at a token's start, so `endpoint=(https://user:secret@host/p)`
 * never reached the URL parser. Terminators exclude the punctuation that wraps values. */
const URL_OR_ARN_SPAN = /(?:[a-zA-Z][a-zA-Z0-9+.-]*:\/\/(?:\[[0-9a-fA-F:.]+\])?[^\s"'`\\<>()[\]{},;]*)|(?:arn:[^\s"'`\\<>()[\]{},;]+)/g;
/** A word run inside free text: everything between structural punctuation and whitespace. `:`
 * stays INSIDE a run so `AWS::Lambda::Function` is one recognizable form — a colon-joined run
 * that is not a reviewed form (`key:secret`) becomes a single marker, which is the safe side. */
const FREE_WORD_RUN = /[^\s"'`\\<>()[\]{},;=|]+/g;

/** Sanitize an arbitrary string: classify every URL/ARN span wherever it sits, fail-close every
 * remaining word run. Structural punctuation survives so the material stays readable. */
function sanitizeScalarString(text) {
  const source = String(text);
  let out = '';
  let last = 0;
  for (const match of source.matchAll(URL_OR_ARN_SPAN)) {
    out += source.slice(last, match.index).replace(FREE_WORD_RUN, renderFreeWord);
    const token = match[0];
    out += renderResidual(token.startsWith('arn:') ? renderArn(token) : renderUrl(token));
    last = match.index + token.length;
  }
  out += source.slice(last).replace(FREE_WORD_RUN, renderFreeWord);
  return out;
}

/** The public name kept for the existing call sites and controls. */
const fingerprintSanitize = (text) => (text ? sanitizeScalarString(text) : '');

/** The sanitized, presentation-only rendering of a plan. Nothing here is ever digested.
 *
 * Round 11: the material carries the change set's EXECUTABLE SEMANTICS, not only its resource
 * changes. `Capabilities` says what IAM the execution may create; `OnStackFailure: DELETE` can
 * destroy the stack after a failed create; `RollbackConfiguration`, `NotificationARNs`, `Tags`,
 * `Parameters`, nested-stack and import flags each change what an approval means — and two plans
 * differing only in those rendered identically before. Each stack now shows them explicitly and
 * then the WHOLE sanitized DescribeChangeSet response as canonical JSON, so nothing is selected
 * away and a field CloudFormation adds later arrives on its own. Parameter VALUES stay
 * pseudonymized: a parameter name is schema, its value is content. */
function renderPlan(planEntries) {
  const lines = [];
  const list = (values) => (Array.isArray(values) && values.length > 0 ? values.join(', ') : 'none');
  for (const rawEntry of planEntries) {
    const stackName = sanitizeBySchema(String(rawEntry.stackName ?? ''), { kind: 'stackName' });
    const status = sanitizeBySchema(String(rawEntry.status ?? ''), { kind: 'vocabulary', values: ['CREATE_COMPLETE', 'NO_CHANGES', 'FAILED'] });
    const describe = sanitizeBySchema(rawEntry.describe ?? { Changes: rawEntry.changes ?? [] });
    const changes = describe.Changes ?? [];
    lines.push(`  ${stackName} — ${status}${status === 'NO_CHANGES' ? '' : ` (${changes.length} change${changes.length === 1 ? '' : 's'})`}`);
    // The executable semantics, named — never inferred from the resource diff.
    lines.push(`      execution: ${describe.ExecutionStatus ?? 'unknown'}   on-failure: ${describe.OnStackFailure ?? 'unspecified'}   nested-stacks: ${describe.IncludeNestedStacks ?? 'unspecified'}   import-existing: ${describe.ImportExistingResources ?? 'unspecified'}`);
    // Round 12: both decide how CloudFormation INTERPRETS this change set, so both are named.
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
    for (const change of changes) {
      const rc = change.ResourceChange || {};
      const flags = [
        rc.Replacement === 'True' ? '[REPLACEMENT]' : '',
        rc.PolicyAction ? `[policy: ${rc.PolicyAction}]` : '',
        Array.isArray(rc.Scope) && rc.Scope.length > 0 ? `[scope: ${rc.Scope.join(',')}]` : '',
      ].filter(Boolean).join('  ');
      lines.push(`    ${rc.Action || '?'}  ${rc.ResourceType || '?'}  ${rc.LogicalResourceId || '?'}${flags ? `  ${flags}` : ''}`);
      for (const detail of rc.Details || []) {
        const target = detail.Target || {};
        const attr = target.Attribute === 'Properties' && target.Name ? `Properties.${target.Name}` : (target.Attribute || '?');
        lines.push(`      ~ ${attr}${detail.CausingEntity ? `  (caused by ${detail.CausingEntity})` : ''}${target.RequiresRecreation && target.RequiresRecreation !== 'Never' ? `  [recreation: ${target.RequiresRecreation}]` : ''}`);
        if (target.BeforeValue !== undefined) lines.push(`        before: ${JSON.stringify(target.BeforeValue)}`);
        if (target.AfterValue !== undefined) lines.push(`        after:  ${JSON.stringify(target.AfterValue)}`);
      }
    }
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
function runDeployRelease(argv, { run = defaultRun, exec = defaultExec, git = defaultGit, cdkJsonPath = path.join(__dirname, '..', 'cdk.json'), readFile = fs.readFileSync, env = process.env, tmpBase = os.tmpdir(), now = () => Date.now(), print = (text) => process.stdout.write(text), sleep = defaultSleep } = {}) {
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

  const failures = [];
  const refuse = () => {
    const lines = [`deploy-release — environment ${opts.environment}`, '  FAIL  BINDING'];
    for (const f of failures) lines.push(`          ${describeFailure(f)}`);
    lines.push('', 'REFUSED. Nothing was deployed.');
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
      const unknown = schemaUnknownPaths(described.described);
      if (unknown.length > 0) {
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
      if (!waitForStack(run, cfnEnv, entry.stackName, { sleep })) {
        failures.push({ check: 'DEPLOY', code: 'STACK_EXECUTION_FAILED', field: entry.stackId });
        const refused = refuse();
        return { ...refused, output: `${refused.output}\nExecuted before the failure: ${[...executed, entry.stackName].join(', ')}. Remaining change sets were NOT executed.` };
      }
      executed.push(entry.stackName);
    }
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

module.exports = { runDeployRelease, childEvidence, setReviewedStackNames, fingerprintSanitize, sanitizeBySchema, schemaUnknownPaths, CHANGE_SET_SCHEMA, checkCloudGate, planDigestOf, canonicalChangeSet, deepSortKeys, renderPlan, strictUtcInstant, CLOUD_GATE_KEYS, CLOUD_GATE_MODES, CLOUD_GATE_MAX_TTL_MS, EXIT };

if (require.main === module) {
  const { exit, output } = runDeployRelease(process.argv.slice(2));
  process.stdout.write(`${output}\n`);
  process.exit(exit);
}
