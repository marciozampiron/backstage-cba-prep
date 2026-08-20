// Adversarial controls for the #70 deploy preflight.
//
// Every test is OFFLINE. The evaluator is pure and the collector takes an injected runner, so no
// test reaches AWS, spends anything, or needs a deployed environment.
//
// The shape is deliberate. A gate is only worth what its REFUSALS are worth, so each condition is
// attacked from every direction that would make it silently pass — a default that survived, an
// override carrying the placeholder, a probe that errored, a prefix that exists but was never
// supplied. A positive control sits beside each, so "it always fails" cannot masquerade as safety.
//
// Two whole sections attack things other than the verdict: the OUTPUT (a preflight runs in CI and
// its output lands in a public log — Codex reproduced role-ARN and credential-shaped material in an
// earlier version), and the BINDING (a preflight that only exits zero proves SOME configuration was
// valid, not that a deploy uses it — the digest and the verify-manifest command are what close
// that, so both are attacked here too).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  PROBE,
  CODES,
  PREFIX_MAX,
  RESERVED_WORDS,
  PreflightError,
  describeFailure,
  isReservedPlaceholder,
  resolveAuthUrls,
  evaluatePreflight,
} = require('../lib/deploy-preflight');
const { runDeployPreflight, runVerifyManifest, contextDigest, BOUND_CONTEXT_KEYS, MANIFEST_VERSION, MANIFEST_TARGET_SERVICE } = require('../bin/deploy-preflight');
const { runDeployRelease } = require('../bin/deploy-release');
const { DEFAULT_AUTH_URLS, DEPLOY_CONTEXT_KEYS } = require('../lib/context');

const CDK_JSON = path.join(__dirname, '..', 'cdk.json');
const SHA = 'a'.repeat(40);
const ACCOUNT = '1'.repeat(12);

/** A context that satisfies both conditions, so each test can break exactly one thing. */
const goodContext = (over = {}) => ({
  authCallbackUrls: '["https://app.example.com/auth/callback"]',
  authLogoutUrls: '["https://app.example.com/"]',
  authDomainPrefix: 'cba-study-coach-pilot-7f3d',
  ...over,
});

const goodProbe = (over = {}) => ({ status: PROBE.AVAILABLE, region: 'us-east-1', ...over });

const run = (over = {}, probeOver = {}) =>
  evaluatePreflight({ environment: 'pilot', context: goodContext(over), domainProbe: goodProbe(probeOver) });

const codesFor = (result, id) => result.checks.find((c) => c.id === id).failures.map((f) => f.code);

/**
 * A stub AWS CLI that dispatches on the service, like the real one. The collector makes exactly two
 * kinds of call — `sts get-caller-identity` and `cognito-idp describe-user-pool-domain` — and each
 * side is controllable independently.
 */
const stubAws = ({ account = ACCOUNT, stsStatus = 0, stsStderr = '', domainBody = {}, domainStatus = 0, domainStderr = '' } = {}) =>
  (args) =>
    args[0] === 'sts'
      ? { status: stsStatus, stdout: JSON.stringify({ Account: account }), stderr: stsStderr }
      : { status: domainStatus, stdout: JSON.stringify(domainBody), stderr: domainStderr };

/**
 * A deterministic fake cloud assembly, shaped like the real one: the cloud manifest, templates,
 * an asset manifest and a Lambda bundle under `asset.<hash>/`. Round 5 is why the shape matters —
 * a digest that covered only the root templates bound almost nothing CDK actually consumes.
 */
const ASSEMBLY_FILES = {
  'manifest.json': '{"version":"36.0.0","artifacts":{"ApiStack":{"type":"aws:cloudformation:stack"}}}',
  'DataStack.template.json': '{"Resources":{"Table":{"Type":"AWS::DynamoDB::Table"}}}',
  'IdentityStack.template.json': '{"Resources":{"Pool":{"Type":"AWS::Cognito::UserPool"}}}',
  'ApiStack.assets.json': '{"version":"36.0.0","files":{"abc123":{"source":{"path":"asset.abc123"}}}}',
  'asset.abc123/index.mjs': 'export const handler = async () => ({ statusCode: 200 });',
};

/** Writes nested paths; a value of {symlink: target} plants a symlink instead of a file. */
function withDir(files, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cba-asm-'));
  try {
    for (const [name, body] of Object.entries(files)) {
      const dest = path.join(dir, name);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      if (body && typeof body === 'object' && body.symlink) fs.symlinkSync(body.symlink, dest);
      else fs.writeFileSync(dest, body);
    }
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const cliArgs = (over = []) => [
  '--environment', 'pilot',
  '--release-sha', SHA,
  '--region', 'us-east-1',
  '-c', 'authCallbackUrls=["https://app.example.com/auth/callback"]',
  '-c', 'authLogoutUrls=["https://app.example.com/"]',
  '-c', 'authDomainPrefix=cba-study-coach-pilot-7f3d',
  ...over,
];

/* ================= POSITIVE CONTROL ============================================================ */

test('POSITIVE CONTROL: a fully supplied, confirmed configuration passes both conditions', () => {
  const result = run();
  assert.equal(result.ok, true, JSON.stringify(result.messages));
  assert.deepEqual(result.failures, []);
});

/* ================= PREFLIGHT-1 ================================================================= */

test('PREFLIGHT-1 refuses the committed pilot default — the placeholder survived', () => {
  const result = evaluatePreflight({ environment: 'pilot', context: {}, domainProbe: goodProbe() });
  assert.equal(result.ok, false);
  assert.deepEqual(codesFor(result, 'PREFLIGHT-1'), ['PLACEHOLDER_FROM_DEFAULT', 'PLACEHOLDER_FROM_DEFAULT']);
});

test('PREFLIGHT-1 distinguishes a forgotten override from an override that carries the placeholder', () => {
  const result = run({ authCallbackUrls: '["https://pilot.invalid/auth/callback"]' });
  assert.deepEqual(codesFor(result, 'PREFLIGHT-1'), ['PLACEHOLDER_FROM_OVERRIDE']);
});

test('PREFLIGHT-1 reads the EFFECTIVE value, so a misspelled context key does not fool it', () => {
  const result = evaluatePreflight({
    environment: 'pilot',
    context: { authCallbackUrl: '["https://app.example.com/auth/callback"]', authLogoutUrls: '["https://app.example.com/"]', authDomainPrefix: 'cba-study-coach-pilot-7f3d' },
    domainProbe: goodProbe(),
  });
  assert.deepEqual(codesFor(result, 'PREFLIGHT-1'), ['PLACEHOLDER_FROM_DEFAULT']);
});

test('PREFLIGHT-1 decides on the hostname, not on a substring of the URL', () => {
  assert.equal(isReservedPlaceholder('https://app.example.com/theme.invalid.css'), false);
  assert.equal(isReservedPlaceholder('https://pilot.invalid.attacker.example/auth/callback'), false);
  assert.equal(isReservedPlaceholder('https://pilot.invalid/auth/callback'), true);
  assert.equal(isReservedPlaceholder('https://invalid/auth/callback'), true);
  assert.equal(isReservedPlaceholder('https://DEEP.SUB.INVALID/x'), true);
  assert.equal(run({ authCallbackUrls: '["https://app.example.com/theme.invalid.css"]' }).ok, true);
});

test('PREFLIGHT-1 turns an unsynthesizable configuration into a coded refusal, not a crash', () => {
  for (const [bad, code] of [
    ['https://app.example.com/auth/callback', 'AUTH_URLS_NOT_JSON'],
    ['{"a":1}', 'AUTH_URLS_NOT_ARRAY'],
    ['[]', 'AUTH_URLS_EMPTY'],
    ['[7]', 'AUTH_URLS_NOT_STRING'],
    ['[" https://app.example.com/x "]', 'AUTH_URLS_WHITESPACE'],
    ['["https://*.example.com/auth/callback"]', 'AUTH_URLS_WILDCARD'],
    ['["not-a-url"]', 'AUTH_URLS_NOT_ABSOLUTE'],
    ['["https://app.example.com/auth/callback#x"]', 'AUTH_URLS_FRAGMENT'],
    ['["https://u:p@app.example.com/auth/callback"]', 'AUTH_URLS_CREDENTIALS'],
    ['["http://app.example.com/auth/callback"]', 'AUTH_URLS_NOT_HTTPS'],
  ]) {
    const result = run({ authCallbackUrls: bad });
    assert.equal(result.ok, false, code);
    assert.deepEqual(codesFor(result, 'PREFLIGHT-1'), [code], `${bad} -> ${code}`);
  }
});

test('PREFLIGHT-1 accepts the dev default, which is localhost rather than a placeholder', () => {
  const result = evaluatePreflight({ environment: 'dev', context: { authDomainPrefix: 'cba-study-coach-dev-7f3d' }, domainProbe: goodProbe() });
  assert.deepEqual(codesFor(result, 'PREFLIGHT-1'), []);
});

/* ================= PREFLIGHT-2 ================================================================= */

test('PREFLIGHT-2 refuses a prefix that was never supplied, even though a value always exists', () => {
  const context = goodContext();
  delete context.authDomainPrefix;
  const result = evaluatePreflight({ environment: 'pilot', context, domainProbe: goodProbe() });
  assert.ok(codesFor(result, 'PREFLIGHT-2').includes('PREFIX_NOT_SUPPLIED'));
});

test('PREFLIGHT-2 fails closed on every probe outcome that is not a confirmation', () => {
  for (const [probe, code] of [
    [{ status: PROBE.NOT_CHECKED }, 'PROBE_NOT_RUN'],
    [{ status: PROBE.ERROR }, 'PROBE_FAILED'],
    [{ status: PROBE.TAKEN_BY_OTHER }, 'PROBE_TAKEN'],
    [{ status: PROBE.TAKEN_BY_EXPECTED_POOL }, 'PROBE_OWNERSHIP_UNVERIFIED'],
    [{ status: PROBE.AVAILABLE, region: null }, 'PROBE_NO_REGION'],
    [{ status: 'SOMETHING_ELSE' }, 'PROBE_NOT_RUN'],
  ]) {
    const result = run({}, probe);
    assert.equal(result.ok, false, code);
    assert.ok(codesFor(result, 'PREFLIGHT-2').includes(code), `${JSON.stringify(probe)} -> ${code}`);
  }
});

test('PREFLIGHT-2 accepts a redeploy onto OUR domain only when ownership was actually verified', () => {
  assert.equal(run({}, { status: PROBE.TAKEN_BY_EXPECTED_POOL, ownershipVerified: true }).ok, true);
  assert.equal(run({}, { status: PROBE.TAKEN_BY_EXPECTED_POOL, ownershipVerified: false }).ok, false);
});

test('PREFLIGHT-2 refuses prefixes Cognito itself would reject, before a deploy discovers it', () => {
  for (const [prefix, code] of [
    ['CBA-Study-Coach', 'PREFIX_SHAPE_INVALID'],
    ['-cba-pilot', 'PREFIX_SHAPE_INVALID'],
    ['cba-pilot-', 'PREFIX_SHAPE_INVALID'],
    ['cba--pilot', 'PREFIX_SHAPE_INVALID'],
    ['cba_pilot', 'PREFIX_SHAPE_INVALID'],
    ['a'.repeat(PREFIX_MAX + 1), 'PREFIX_TOO_LONG'],
    ['', 'PREFIX_NOT_STRING'],
    [42, 'PREFIX_NOT_STRING'],
    [null, 'PREFIX_NOT_STRING'],
    [['x'], 'PREFIX_NOT_STRING'],
  ]) {
    const result = run({ authDomainPrefix: prefix });
    assert.equal(result.ok, false, String(prefix));
    assert.ok(codesFor(result, 'PREFLIGHT-2').includes(code), `${String(prefix)} -> ${code}`);
  }
  for (const word of RESERVED_WORDS) {
    assert.ok(codesFor(run({ authDomainPrefix: `cba-${word}-pilot` }), 'PREFLIGHT-2').includes('PREFIX_RESERVED_WORD'), word);
  }
});

/* ================= both conditions together ==================================================== */

test('both conditions are always evaluated — one run reports every reason it refused', () => {
  const context = goodContext({ authCallbackUrls: '["https://pilot.invalid/auth/callback"]' });
  delete context.authDomainPrefix;
  const result = evaluatePreflight({ environment: 'pilot', context, domainProbe: { status: PROBE.ERROR } });
  assert.ok(result.failures.some((f) => f.check === 'PREFLIGHT-1'));
  assert.ok(result.failures.some((f) => f.check === 'PREFLIGHT-2'));
});

test('the evaluator refuses an unknown environment instead of guessing a posture', () => {
  for (const env of ['production', 'staging', '', undefined, null, 'PILOT']) {
    assert.throws(() => evaluatePreflight({ environment: env, context: goodContext(), domainProbe: goodProbe() }), PreflightError, String(env));
  }
});

test('resolveAuthUrls returns the same defaults the stack uses — one definition, not two', () => {
  const resolved = resolveAuthUrls({}, 'pilot');
  assert.deepEqual(resolved.callback.urls, DEFAULT_AUTH_URLS.pilot.callback);
  assert.deepEqual(resolved.logout.urls, DEFAULT_AUTH_URLS.pilot.logout);
});

/* ================= THE BINDING ================================================================= */
//
// A preflight that exits zero proves SOME configuration was valid. The digest is what makes it
// prove THIS one — so the digest must move whenever anything a deploy could silently change moves.

test('the context digest binds region and account identity, not just the context', () => {
  const base = { releaseSha: SHA, environment: 'pilot', region: 'us-east-1', accountId: ACCOUNT, context: goodContext() };
  const d = contextDigest(base);

  // Same values, different insertion order -> same digest, so a deploy can reproduce it.
  const reordered = {
    ...base,
    context: {
      authDomainPrefix: goodContext().authDomainPrefix,
      authLogoutUrls: goodContext().authLogoutUrls,
      authCallbackUrls: goodContext().authCallbackUrls,
    },
  };
  assert.equal(contextDigest(reordered), d);

  // Round 2's reproduction: us-east-1 and us-west-2 produced the SAME digest, although Cognito
  // domain uniqueness and deploy targets are regional. And two accounts must never share one.
  assert.notEqual(contextDigest({ ...base, region: 'us-west-2' }), d, 'region must be bound');
  assert.notEqual(contextDigest({ ...base, accountId: '2'.repeat(12) }), d, 'account identity must be bound');
  assert.notEqual(contextDigest({ ...base, releaseSha: 'b'.repeat(40) }), d, 'the release must be bound');
  assert.notEqual(contextDigest({ ...base, environment: 'dev' }), d, 'the environment must be bound');
  for (const over of [
    { authCallbackUrls: '["https://other.example.com/auth/callback"]' },
    { authLogoutUrls: '["https://other.example.com/"]' },
    { authDomainPrefix: 'cba-study-coach-pilot-0000' },
  ]) {
    assert.notEqual(contextDigest({ ...base, context: goodContext(over) }), d, JSON.stringify(over));
  }

  // Unbound context does NOT move the digest: binding unrelated keys would make it brittle without
  // making a deploy safer.
  assert.equal(contextDigest({ ...base, context: goodContext({ someOtherKey: 'x' }) }), d);
});

test('the digest binds EVERY deploy-sensitive context key — the round-4 pair included', () => {
  // With only the three auth keys bound, changing githubTrustSub or corsAllowedOrigins produced
  // the exact same digest: IAM trust and CORS could drift under a manifest that still verified.
  const base = { releaseSha: SHA, environment: 'pilot', region: 'us-east-1', accountId: ACCOUNT, context: goodContext() };
  const d = contextDigest(base);
  // `githubOidcProviderArn` left this list with the contract (#111 round 3): no stack consumes
  // it anymore — the gate role takes the foundation's REQUIRED reference — so there is nothing
  // for the digest to bind, and binding an unconsumed key would be exactly the "declared but
  // dead" entry the discovery test below forbids.
  for (const over of [
    { githubTrustSub: 'repo:attacker/fork:ref:refs/heads/main' },
    { corsAllowedOrigins: '["https://attacker.example"]' },
    { githubRepo: 'attacker/fork' },
    { bedrockStandardInferenceProfileId: 'us.other-model-v9:0' },
    { bedrockRoutedModelArns: '["arn:aws:bedrock:us-east-1::foundation-model/other"]' },
  ]) {
    assert.notEqual(contextDigest({ ...base, context: goodContext(over) }), d, JSON.stringify(over));
  }
});

test('every context key the stacks consume is in the closed deploy contract', () => {
  // Discovery, not enumeration: scan the stack sources for context reads, so a NEW key cannot be
  // consumed without joining the contract the manifest binds.
  const libDir = path.join(__dirname, '..', 'lib');
  const found = new Set();
  for (const f of fs.readdirSync(libDir).filter((n) => n.endsWith('.js'))) {
    const src = fs.readFileSync(path.join(libDir, f), 'utf8');
    // \s* crosses line breaks (#111 F1 round 2): the old single-line pattern silently missed
    // multi-line reads and leaned on reads that no longer exist; the strict bidirectional
    // scanner later in this file remains the authority — this is the early sanity pass.
    for (const m of src.matchAll(/(?:\bctx|getContext)\(\s*(?:(?:this\.)?node\s*,\s*)?'([^']+)'/g)) found.add(m[1]);
  }
  found.delete('environment'); // bound separately in the digest
  assert.ok(found.size >= 10, 'the discovery scan must actually find the known keys');
  for (const key of found) {
    assert.ok(DEPLOY_CONTEXT_KEYS.includes(key), `context key "${key}" must join the closed deploy contract`);
  }
});

test('the manifest carries the closed schema, the region, the assembly digest, and never a raw account id', () => {
  const manifest = capturedManifest();
  assert.deepEqual(Object.keys(manifest).sort(), ['assemblyDigest', 'boundContextKeys', 'contextDigest', 'environment', 'issue', 'preflight', 'region', 'releaseSha', 'target', 'version']);
  assert.equal(manifest.version, MANIFEST_VERSION);
  assert.equal(manifest.releaseSha, SHA);
  assert.equal(manifest.environment, 'pilot');
  assert.equal(manifest.region, 'us-east-1');
  assert.deepEqual(manifest.target, { service: MANIFEST_TARGET_SERVICE, stacks: ['ApiStack', 'DataStack', 'IdentityStack', 'ObservabilityStack'] });
  assert.match(manifest.contextDigest, /^[0-9a-f]{64}$/);
  assert.match(manifest.assemblyDigest, /^[0-9a-f]{64}$/);
  assert.deepEqual(manifest.boundContextKeys, [...BOUND_CONTEXT_KEYS].sort());
  assert.equal(JSON.stringify(manifest).includes(ACCOUNT), false, 'the account id lives inside the digest, never in clear text');
});

test('a manifest cannot be requested without an assembly, and the assembly digest tracks content', () => {
  // --manifest-out without --assembly is a usage error: a manifest binding no deployable content is
  // exactly the round-4 hole — a verified deploy of whatever files happened to be on disk.
  assert.equal(runDeployPreflight([...cliArgs(), '--manifest-out', '/tmp/x.json'], { run: stubAws(), cdkJsonPath: CDK_JSON, env: {} }).exit, 2);

  const a = capturedManifest();
  const b = withDir({ ...ASSEMBLY_FILES, 'IdentityStack.template.json': '{"Resources":{"Pool":{"Type":"AWS::Cognito::UserPool","Props":1}}}' }, (asm) => {
    const written = [];
    runDeployPreflight([...cliArgs(), '--assembly', asm, '--manifest-out', '/x'], { run: stubAws(), cdkJsonPath: CDK_JSON, env: {}, writeFile: (p, d) => written.push(d) });
    return JSON.parse(written[0]);
  });
  assert.notEqual(a.assemblyDigest, b.assemblyDigest, 'a changed template must change the assembly digest');

  // An unreadable or empty assembly is a refusal, not a manifest without the field.
  const empty = withDir({}, (asm) =>
    runDeployPreflight([...cliArgs(), '--assembly', asm, '--manifest-out', '/x'], { run: stubAws(), cdkJsonPath: CDK_JSON, env: {}, writeFile: () => assert.fail('no manifest may be written') }),
  );
  assert.equal(empty.exit, 1);
  assert.match(empty.output, /ASSEMBLY_UNREADABLE/);
});

test('the manifest is written only on a pass — a refused configuration leaves no token behind', () => {
  withDir(ASSEMBLY_FILES, (asm) => {
    const written = [];
    const refused = runDeployPreflight(
      ['--environment', 'pilot', '--release-sha', SHA, '--region', 'us-east-1', '--assembly', asm, '--manifest-out', '/tmp/x.json'],
      { run: stubAws(), cdkJsonPath: CDK_JSON, env: {}, writeFile: (p, d) => written.push(d) },
    );
    assert.equal(refused.exit, 1);
    assert.equal(written.length, 0);
    assert.equal(refused.manifest, null);
  });
});

test('an unresolved target account is a refusal, not a pass with a hole in the digest', () => {
  const r = runDeployPreflight(cliArgs(), { run: stubAws({ stsStatus: 254 }), cdkJsonPath: CDK_JSON, env: {} });
  assert.equal(r.exit, 1);
  assert.match(r.output, /ACCOUNT_UNRESOLVED/);
  assert.equal(r.manifest, null);
});

/* ================= verify-manifest ============================================================= */

/** Run a real passing preflight against the shared fake assembly and capture the manifest. */
function capturedManifest() {
  return withDir(ASSEMBLY_FILES, (asm) => {
    const written = [];
    const r = runDeployPreflight([...cliArgs(), '--assembly', asm, '--manifest-out', '/tmp/never-used.json'], {
      run: stubAws(),
      cdkJsonPath: CDK_JSON,
      env: {},
      writeFile: (p, data) => written.push(data),
    });
    assert.equal(r.exit, 0, r.output);
    return JSON.parse(written[0]);
  });
}

function withManifest(manifestOrText, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cba-manifest-'));
  try {
    const p = path.join(dir, 'manifest.json');
    fs.writeFileSync(p, typeof manifestOrText === 'string' ? manifestOrText : JSON.stringify(manifestOrText));
    return fn(p);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('verify-manifest accepts the exact manifest and refuses every identity mismatch', () => {
  const manifest = capturedManifest();

  withManifest(manifest, (p) => {
    const ok = runVerifyManifest(['--manifest', p, '--environment', 'pilot', '--release-sha', SHA, '--expect-digest', manifest.contextDigest], {});
    assert.equal(ok.exit, 0, ok.output);
  });

  const cases = [
    [['--environment', 'dev', '--release-sha', SHA], /MANIFEST_ENVIRONMENT_MISMATCH/],
    [['--environment', 'pilot', '--release-sha', 'b'.repeat(40)], /MANIFEST_RELEASE_MISMATCH/],
    [['--environment', 'pilot', '--release-sha', SHA, '--expect-digest', '0'.repeat(64)], /MANIFEST_DIGEST_MISMATCH/],
  ];
  for (const [args, expected] of cases) {
    withManifest(manifest, (p) => {
      const r = runVerifyManifest(['--manifest', p, ...args], {});
      assert.equal(r.exit, 1, JSON.stringify(args));
      assert.match(r.output, expected);
    });
  }

  // The schema is closed: an extra key, a wrong version and non-JSON are all MALFORMED, and a
  // missing file is UNREADABLE — never a pass.
  withManifest({ ...manifest, extra: 1 }, (p) => {
    assert.match(runVerifyManifest(['--manifest', p, '--environment', 'pilot', '--release-sha', SHA], {}).output, /MANIFEST_MALFORMED/);
  });
  withManifest({ ...manifest, version: 1 }, (p) => {
    assert.match(runVerifyManifest(['--manifest', p, '--environment', 'pilot', '--release-sha', SHA], {}).output, /MANIFEST_MALFORMED/);
  });
  withManifest('not json', (p) => {
    assert.match(runVerifyManifest(['--manifest', p, '--environment', 'pilot', '--release-sha', SHA], {}).output, /MANIFEST_MALFORMED/);
  });
  const missing = runVerifyManifest(['--manifest', '/nonexistent/m.json', '--environment', 'pilot', '--release-sha', SHA], {});
  assert.equal(missing.exit, 1);
  assert.match(missing.output, /MANIFEST_UNREADABLE/);
});

test('the NESTED manifest schema is closed too — the exact round-3 forgeries are refused', () => {
  // Both of these VERIFIED CLEANLY before this test existed: the old shape check stopped at
  // `Array.isArray(boundContextKeys)` and never looked inside `preflight` at all. A manifest exists
  // only because both conditions passed, so a nested claim that says otherwise is a forgery.
  const manifest = capturedManifest();
  const verify = (p) => runVerifyManifest(['--manifest', p, '--environment', 'pilot', '--release-sha', SHA], {});

  for (const [label, tampered] of [
    ['boundContextKeys emptied', { ...manifest, boundContextKeys: [] }],
    ['boundContextKeys narrowed', { ...manifest, boundContextKeys: ['authDomainPrefix'] }],
    ['a preflight claimed as failed', { ...manifest, preflight: { PREFLIGHT_1: 'fail', PREFLIGHT_2: 'pass' } }],
    ['an additional preflight claim', { ...manifest, preflight: { PREFLIGHT_1: 'pass', PREFLIGHT_2: 'pass', PREFLIGHT_3: 'pass' } }],
    ['a missing preflight claim', { ...manifest, preflight: { PREFLIGHT_1: 'pass' } }],
    ['the target service rewritten', { ...manifest, target: { ...manifest.target, service: 'cloudflare' } }],
    ['an extra target key', { ...manifest, target: { ...manifest.target, extra: true } }],
    // The stack SET is part of the closed shape (Slice B1 review): a widened, narrowed, reordered
    // or absent set is a forgery — `--all` semantics cannot be smuggled back in through the data.
    ['the stack set widened with SecurityStack', { ...manifest, target: { ...manifest.target, stacks: [...manifest.target.stacks, 'SecurityStack'] } }],
    ['the stack set widened with a future stack', { ...manifest, target: { ...manifest.target, stacks: [...manifest.target.stacks, 'AiOrchestrationStack'] } }],
    ['the stack set narrowed', { ...manifest, target: { ...manifest.target, stacks: manifest.target.stacks.slice(1) } }],
    ['the stack set reordered', { ...manifest, target: { ...manifest.target, stacks: [...manifest.target.stacks].reverse() } }],
    ['the stack set emptied', { ...manifest, target: { ...manifest.target, stacks: [] } }],
    ['the stack set removed', { ...manifest, target: { service: manifest.target.service } }],
    ['the assembly digest removed', (() => { const { assemblyDigest: _, ...rest } = manifest; return rest; })()],
    ['a malformed assembly digest', { ...manifest, assemblyDigest: 'zz' }],
  ]) {
    withManifest(tampered, (p) => {
      const r = verify(p);
      assert.equal(r.exit, 1, label);
      assert.match(r.output, /MANIFEST_MALFORMED/, label);
    });
  }
});

test('verify-manifest --recompute recomputes from the effective values, and every drift refuses', () => {
  const manifest = capturedManifest();
  const recomputeArgs = (p, over = []) => [
    '--manifest', p, '--environment', 'pilot', '--release-sha', SHA, '--recompute', '--region', 'us-east-1',
    '-c', 'authCallbackUrls=["https://app.example.com/auth/callback"]',
    '-c', 'authLogoutUrls=["https://app.example.com/"]',
    '-c', 'authDomainPrefix=cba-study-coach-pilot-7f3d',
    ...over,
  ];

  withManifest(manifest, (p) => {
    // Same values, same account -> the digest reproduces and the verification passes.
    const ok = runVerifyManifest(recomputeArgs(p), { run: stubAws(), cdkJsonPath: CDK_JSON });
    assert.equal(ok.exit, 0, ok.output);

    // Region drift: the deploy targets a different region than the one validated.
    const region = runVerifyManifest(recomputeArgs(p).map((a) => (a === 'us-east-1' ? 'us-west-2' : a)), { run: stubAws(), cdkJsonPath: CDK_JSON });
    assert.equal(region.exit, 1);
    assert.match(region.output, /MANIFEST_REGION_MISMATCH/);

    // Account drift: the credentials resolve to a different account than the one validated.
    const account = runVerifyManifest(recomputeArgs(p), { run: stubAws({ account: '2'.repeat(12) }), cdkJsonPath: CDK_JSON });
    assert.equal(account.exit, 1);
    assert.match(account.output, /MANIFEST_RECOMPUTE_MISMATCH/);

    // Context drift: the deploy would use a different bound value than the one validated.
    const context = runVerifyManifest(recomputeArgs(p, ['-c', 'authDomainPrefix=cba-study-coach-pilot-0000']), { run: stubAws(), cdkJsonPath: CDK_JSON });
    assert.equal(context.exit, 1);
    assert.match(context.output, /MANIFEST_RECOMPUTE_MISMATCH/);

    // No account, no verification.
    const noAccount = runVerifyManifest(recomputeArgs(p), { run: stubAws({ stsStatus: 254 }), cdkJsonPath: CDK_JSON });
    assert.equal(noAccount.exit, 1);
    assert.match(noAccount.output, /ACCOUNT_UNRESOLVED/);
  });

  // Recompute without a region is a usage error, kept distinguishable from a refusal.
  withManifest(manifest, (p) => {
    assert.equal(runVerifyManifest(['--manifest', p, '--environment', 'pilot', '--release-sha', SHA, '--recompute'], {}).exit, 2);
  });
});

/* ================= NON-LEAKAGE ================================================================= */

/** Values that must never survive into any output, whatever path they entered by. */
const POISON = {
  accountId: '9'.repeat(12),
  roleArn: `arn:aws:iam::${'9'.repeat(12)}:role/cba-deploy`,
  poolId: 'us-east-1_SecretPool',
  endpoint: 'https://internal-billing.corp.example/auth/callback',
  credential: 'AKIA' + 'Z'.repeat(16),
  token: 'ghp_' + 'x'.repeat(36),
};

const assertClean = (text, label) => {
  for (const [name, value] of Object.entries(POISON)) {
    assert.equal(String(text).includes(value), false, `${label} leaked ${name}`);
  }
};

test('every failure code renders without touching a supplied value', () => {
  for (const code of Object.keys(CODES)) {
    const rendered = describeFailure({ code, field: 'authDomainPrefix' });
    assert.match(rendered, new RegExp(`\\[${code}\\]$`));
    assertClean(rendered, code);
  }
  assert.throws(() => describeFailure({ code: 'NOT_A_CODE', field: 'x' }), PreflightError);
});

test('a refused run never echoes the URLs, the prefix or the pool id it was given', () => {
  const { output, exit } = runDeployPreflight(
    [
      '--environment', 'pilot', '--release-sha', SHA, '--region', 'us-east-1',
      '-c', `authCallbackUrls=["${POISON.endpoint}#frag"]`,
      '-c', `authLogoutUrls=["https://u:${POISON.credential}@app.example.com/"]`,
      '-c', `authDomainPrefix=${POISON.accountId}_BAD`,
    ],
    { run: stubAws(), cdkJsonPath: CDK_JSON, env: { CBA_EXPECTED_USER_POOL_ID: POISON.poolId } },
  );
  assert.equal(exit, 1);
  assertClean(output, 'refusal output');
  assert.match(output, /authCallbackUrls/);
  assert.match(output, /authDomainPrefix/);
  assert.match(output, /\[[A-Z_]+\]/);
});

test('AWS stderr never reaches the output — from either call', () => {
  const probeErr = runDeployPreflight(cliArgs(), {
    run: stubAws({ domainStatus: 254, domainStderr: `AccessDenied: User ${POISON.roleArn} is not authorized` }),
    cdkJsonPath: CDK_JSON,
    env: {},
  });
  assert.equal(probeErr.exit, 1);
  assertClean(probeErr.output, 'probe error output');
  assert.match(probeErr.output, /PROBE_FAILED/);

  const stsErr = runDeployPreflight(cliArgs(), {
    run: stubAws({ stsStatus: 254, stsStderr: `AccessDenied: ${POISON.roleArn}` }),
    cdkJsonPath: CDK_JSON,
    env: {},
  });
  assert.equal(stsErr.exit, 1);
  assertClean(stsErr.output, 'sts error output');
});

test("another tenant's user pool id never reaches the output", () => {
  const { output, exit } = runDeployPreflight(cliArgs(), {
    run: stubAws({ domainBody: { DomainDescription: { UserPoolId: POISON.poolId } } }),
    cdkJsonPath: CDK_JSON,
    env: {},
  });
  assert.equal(exit, 1);
  assertClean(output, 'taken-domain output');
  assert.match(output, /PROBE_TAKEN/);
});

test('a poisoned account id stays inside the digest — output and manifest are both clean', () => {
  withDir(ASSEMBLY_FILES, (asm) => {
    const written = [];
    const r = runDeployPreflight([...cliArgs(), '--assembly', asm, '--manifest-out', '/tmp/x.json'], {
      run: stubAws({ account: POISON.accountId }),
      cdkJsonPath: CDK_JSON,
      env: {},
      writeFile: (p, d) => written.push(d),
    });
    assert.equal(r.exit, 0, r.output);
    assertClean(r.output, 'pass output');
    assertClean(written[0], 'manifest');
  });
});

test('an unrecognised argument is refused without echoing it — argv can hold a mistyped secret', () => {
  for (const runner of [
    () => runDeployPreflight([`--${POISON.token}`], { cdkJsonPath: CDK_JSON, env: {} }),
    () => runVerifyManifest([`--${POISON.token}`], {}),
  ]) {
    const { output, exit } = runner();
    assert.equal(exit, 2);
    assertClean(output, 'usage error');
  }
});

test('the JSON output carries codes and fields only, never values', () => {
  const { output } = runDeployPreflight(
    ['--environment', 'pilot', '--release-sha', SHA, '--region', 'us-east-1', '--json', '-c', `authDomainPrefix=${POISON.accountId}`],
    { run: stubAws(), cdkJsonPath: CDK_JSON, env: {} },
  );
  assertClean(output, 'json output');
  const parsed = JSON.parse(output);
  assert.equal(parsed.ok, false);
  for (const f of parsed.failures) assert.deepEqual(Object.keys(f).sort(), ['check', 'code', 'field']);
});

/* ================= the collector, with no AWS anywhere it should not reach ===================== */

test('the expected pool id is read from the environment, never from an argument', () => {
  assert.equal(runDeployPreflight([...cliArgs(), '--expected-user-pool-id', 'us-east-1_X'], { cdkJsonPath: CDK_JSON, env: {} }).exit, 2);

  const adopted = runDeployPreflight(cliArgs(), {
    run: stubAws({ domainBody: { DomainDescription: { UserPoolId: 'us-east-1_Ours' } } }),
    cdkJsonPath: CDK_JSON,
    env: { CBA_EXPECTED_USER_POOL_ID: 'us-east-1_Ours' },
  });
  assert.equal(adopted.exit, 0, adopted.output);

  const notOurs = runDeployPreflight(cliArgs(), {
    run: stubAws({ domainBody: { DomainDescription: { UserPoolId: 'us-east-1_Ours' } } }),
    cdkJsonPath: CDK_JSON,
    env: {},
  });
  assert.equal(notOurs.exit, 1, 'without trusted state, an existing domain is not ours');
});

test('a release SHA is required, and only a full 40-hex one is accepted', () => {
  for (const bad of [
    [],
    ['--environment', 'pilot'],
    ['--environment', 'pilot', '--release-sha', 'abc'],
    ['--environment', 'pilot', '--release-sha', 'A'.repeat(40)],
    ['--environment', 'pilot', '--release-sha', 'main'],
  ]) {
    assert.equal(runDeployPreflight(bad, { cdkJsonPath: CDK_JSON, env: {} }).exit, 2, JSON.stringify(bad));
  }
});

test('exactly two read-only AWS calls, in order, both bounded — and neither mutates', () => {
  const calls = [];
  runDeployPreflight(cliArgs(), {
    run: (args, o) => {
      calls.push({ args, o });
      return stubAws()(args, o);
    },
    cdkJsonPath: CDK_JSON,
    env: {},
  });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].args.slice(0, 2), ['sts', 'get-caller-identity']);
  assert.deepEqual(calls[1].args.slice(0, 2), ['cognito-idp', 'describe-user-pool-domain']);
  for (const { args, o } of calls) {
    assert.ok(o.timeoutMs > 0, 'every call must be time-bounded');
    // Structural, not by substring: `--output` contains "put", so a substring sweep both flags a
    // harmless flag and misses a mutating operation that avoids the listed words.
    const operation = args[1];
    for (const verb of ['create-', 'update-', 'delete-', 'put-', 'set-', 'add-', 'remove-', 'start-', 'stop-', 'admin-']) {
      assert.equal(operation.startsWith(verb), false, `${operation} mutates`);
    }
  }
});

test('the probe is never attempted without a region or without a prefix', () => {
  const noRegion = [];
  const r1 = runDeployPreflight(
    ['--environment', 'pilot', '--release-sha', SHA, '-c', 'authDomainPrefix=cba-x'],
    { run: (args, o) => { noRegion.push(args[0]); return stubAws()(args, o); }, cdkJsonPath: CDK_JSON, env: {} },
  );
  assert.equal(r1.exit, 1);
  assert.equal(noRegion.includes('cognito-idp'), false, 'no region, no cognito call');

  const noPrefix = [];
  const r2 = runDeployPreflight(
    ['--environment', 'pilot', '--release-sha', SHA, '--region', 'us-east-1'],
    { run: (args, o) => { noPrefix.push(args[0]); return stubAws()(args, o); }, cdkJsonPath: CDK_JSON, env: {} },
  );
  assert.equal(r2.exit, 1);
  assert.equal(noPrefix.includes('cognito-idp'), false, 'no prefix, no cognito call');
});

test('--skip-probe makes NO AWS call at all, and fails by design', () => {
  const { exit, output } = runDeployPreflight([...cliArgs(), '--skip-probe'], {
    run: () => assert.fail('--skip-probe must not call AWS'),
    cdkJsonPath: CDK_JSON,
    env: {},
  });
  assert.equal(exit, 1);
  assert.match(output, /PROBE_NOT_RUN/);
  assert.match(output, /ACCOUNT_UNRESOLVED/);
});

test('a committed cdk.json value counts as explicitly supplied; the in-code fallback does not', () => {
  const base = ['--environment', 'pilot', '--release-sha', SHA, '--region', 'us-east-1', '-c', 'authCallbackUrls=["https://app.example.com/auth/callback"]', '-c', 'authLogoutUrls=["https://app.example.com/"]'];
  const withCommitted = runDeployPreflight(base, {
    run: stubAws(),
    cdkJsonPath: path.join(__dirname, 'fixtures', 'cdk-with-prefix.json'),
    env: {},
  });
  assert.equal(withCommitted.exit, 0, withCommitted.output);

  const withoutCommitted = runDeployPreflight(base, { run: stubAws(), cdkJsonPath: CDK_JSON, env: {} });
  assert.equal(withoutCommitted.exit, 1);
  assert.match(withoutCommitted.output, /PREFIX_NOT_SUPPLIED/);
});

/* ================= deploy-release: the binding BY CONSTRUCTION ================================= */
//
// Rounds 3 and 4 proved workflow choreography cannot bind: separate verify and deploy commands
// admit a different context, different credentials, a different target, a different WORKING TREE
// and a different REGION between them. The entrypoint closes each hole structurally, and these
// tests attack every seam it has.

const happyGit = (sha = SHA) => (args) =>
  args[0] === 'rev-parse' ? { status: 0, stdout: `${sha}\n` } : { status: 0, stdout: '' };

const releaseArgs = (manifestPath, asm, over = []) => [
  '--manifest', manifestPath,
  '--environment', 'pilot',
  '--release-sha', SHA,
  '--region', 'us-east-1',
  '--assembly', asm,
  '-c', 'authCallbackUrls=["https://app.example.com/auth/callback"]',
  '-c', 'authLogoutUrls=["https://app.example.com/"]',
  '-c', 'authDomainPrefix=cba-study-coach-pilot-7f3d',
  ...over,
];

/** Manifest + matching assembly on disk, handed to `fn(manifestPath, asmDir, manifest)`. */
function withRelease(fn, { assemblyFiles = ASSEMBLY_FILES } = {}) {
  const manifest = capturedManifest();
  return withDir(assemblyFiles, (asm) => withManifest(manifest, (p) => fn(p, asm, manifest)));
}

/** The tests' frozen clock: every gate window is bounded, so `now` is always injected. */
const GATE_NOW = Date.parse('2026-08-02T12:00:00Z');

/* ---- round-4 harness: the plan IS the change sets ------------------------------------------- */
const { planDigestOf, entryDigestOf, canonicalChangeSet, setReviewedStackNames } = require('../bin/deploy-release');

// Round 11: review material renders a stack name only when THIS deploy computed it, so the
// direct-call controls declare the same names the entrypoint would.
setReviewedStackNames(['IdentityStack', 'DataStack', 'ApiStack', 'ObservabilityStack'].map((id) => `cba-study-coach-pilot-${id.replace(/Stack$/, '').toLowerCase()}`));

/** The reviewed execution order and this (pilot) manifest's CloudFormation stack names. */
const ORDERED_IDS = ['IdentityStack', 'DataStack', 'ApiStack', 'ObservabilityStack'];
const PILOT_STACK_NAMES = ORDERED_IDS.map((id) => `cba-study-coach-pilot-${id.replace(/Stack$/, '').toLowerCase()}`);

/** One fake describe-change-set body per stack — poisonable and overridable per test. The
 * change-set ARN carries a compliant per-stack UUID (round 15: the positional contract demands
 * changeSet/<name>/<uuid>, so the stack identity lives in the uuid's final group). */
const CS_UUID = (stackName) => `00000000-0000-0000-0000-${String(PILOT_STACK_NAMES.indexOf(stackName) + 1).padStart(12, '0')}`;
const CS_ARN = (stackName) => `arn:aws:cloudformation:us-east-1:${ACCOUNT}:changeSet/cba-70-abcdef123456/${CS_UUID(stackName)}`;
const describedFor = (stackName, over = {}) => ({
  ChangeSetId: CS_ARN(stackName),
  Status: 'CREATE_COMPLETE',
  ExecutionStatus: 'AVAILABLE',
  // ROUND 18: the live tier answers with a deployment configuration on every change set, and the
  // lane refuses a plan that does not state one. A fixture without it would describe a response
  // AWS does not send, and would prove the lane works on a shape it will never see.
  DeploymentConfig: { Mode: 'STANDARD', DisableRollback: false },
  Changes: [{ Type: 'Resource', ResourceChange: { Action: 'Modify', LogicalResourceId: 'BffFunction', ResourceType: 'AWS::Lambda::Function' } }],
  ...over,
});
const fullDescribes = (over = {}) =>
  Object.fromEntries(PILOT_STACK_NAMES.map((n) => [n, describedFor(n, over[n] || {})]));

/** The digest EXACTLY as production computes it: canonical entries over UNREDACTED describes. */
const digestOf = (describes) =>
  planDigestOf(ORDERED_IDS.map((id, i) => canonicalChangeSet(id, PILOT_STACK_NAMES[i], describes[PILOT_STACK_NAMES[i]])));

/** A cloud stub covering sts (identity + assume-role) and cloudformation (describe/execute/poll).
 * Records every call; `onCall` may intercept and return a response. */
function cloudRun({ describes = fullDescribes(), account = ACCOUNT, stackStatus = 'UPDATE_COMPLETE', onCall } = {}) {
  const calls = [];
  const fn = (args, opts) => {
    calls.push({ args, opts });
    if (onCall) {
      const intercepted = onCall(args, calls);
      if (intercepted) return intercepted;
    }
    if (args[0] === 'sts' && args[1] === 'get-caller-identity') return { status: 0, stdout: JSON.stringify({ Account: account }), stderr: '' };
    if (args[0] === 'sts' && args[1] === 'assume-role') {
      return { status: 0, stdout: JSON.stringify({ Credentials: { AccessKeyId: 'ASIATESTKEY', SecretAccessKey: 'secret', SessionToken: 'token' } }), stderr: '' };
    }
    if (args[0] === 'cloudformation' && args[1] === 'describe-change-set') {
      const stackName = args[args.indexOf('--stack-name') + 1];
      const body = describes[stackName];
      if (!body) return { status: 254, stdout: '', stderr: 'ChangeSetNotFound' };
      return { status: 0, stdout: JSON.stringify(body), stderr: '' };
    }
    if (args[0] === 'cloudformation' && args[1] === 'execute-change-set') return { status: 0, stdout: '', stderr: '' };
    if (args[0] === 'cloudformation' && args[1] === 'delete-change-set') return { status: 0, stdout: '', stderr: '' };
    if (args[0] === 'cloudformation' && args[1] === 'describe-stacks') return { status: 0, stdout: JSON.stringify({ Stacks: [{ StackStatus: stackStatus }] }), stderr: '' };
    return stubAws()(args, opts);
  };
  fn.calls = calls;
  fn.of = (verb) => calls.filter((c) => c.args[1] === verb);
  return fn;
}

/** A valid deploy-mode cloud gate for THIS manifest: bounded window around GATE_NOW, a decision
 * id, and the digest of the default fake change sets. */
const { manifestBundleDigest } = require('../lib/deploy-preflight');
const { deepSortKeys: sortForDigest } = require('../bin/deploy-release');

const gateFor = (manifest, over = {}) =>
  JSON.stringify({
    issue: 70,
    environment: manifest.environment,
    releaseSha: manifest.releaseSha,
    manifestDigest: manifestBundleDigest(manifest, sortForDigest),
    mode: 'deploy',
    decisionId: 'zamp-2026-08-02.b1-deploy-01',
    approvedAt: '2026-08-02T11:50:00Z',
    expiresAt: '2026-08-02T12:30:00Z',
    planDigest: digestOf(fullDescribes()),
    stacks: [...ORDERED_IDS],
    absentEntryDigests: null,
    ...over,
  });

/** Prepare-child executor that succeeds; deploy mode spawns no cdk child at all. */
const happyExec = () => ({ status: 0, stdout: '', stderr: '' });

/** Options shared by every happy deploy-mode invocation. */
const deployOpts = (manifest, over = {}) => ({
  run: cloudRun(),
  git: happyGit(),
  cdkJsonPath: CDK_JSON,
  env: { CBA_CLOUD_GATE: gateFor(manifest) },
  now: () => GATE_NOW,
  sleep: () => {},
  exec: () => assert.fail('deploy mode spawns no cdk child — the plan was prepared under plan_only'),
  ...over,
});

test('plan_only PREPARES the closed change sets from the SNAPSHOT; deploy EXECUTES exactly them', () => {
  // Part A — plan_only: the ONE moment change sets may be created. The cdk child prepares (never
  // executes) one named change set per stack, from the private snapshot, in the reviewed
  // dependency order, with --exclusively — never --all, never SecurityStack.
  withRelease((p, asm, manifest) => {
    const prepares = [];
    const run = cloudRun();
    const r = runDeployRelease(releaseArgs(p, asm), {
      run,
      git: happyGit(),
      cdkJsonPath: CDK_JSON,
      env: { PATH: '/usr/bin', AWS_REGION: 'us-west-2', AWS_DEFAULT_REGION: 'us-west-2', CDK_DEFAULT_REGION: 'us-west-2', CBA_CLOUD_GATE: gateFor(manifest, { mode: 'plan_only', planDigest: null }) },
      now: () => GATE_NOW,
      sleep: () => {},
      exec: (args, childEnv) => {
        prepares.push({ args, childEnv });
        // ROUND-5 REPRO (check/use): mutate the ORIGINAL assembly while the child runs. The
        // snapshot the child was handed must still carry the verified digest.
        fs.writeFileSync(path.join(asm, 'asset.abc123', 'index.mjs'), 'export const handler = () => "evil";');
        const snapDigest = require('../bin/deploy-preflight').assemblyDigest(args[args.indexOf('--app') + 1]);
        prepares[prepares.length - 1].snapDigest = snapDigest.digest;
        return { status: 0, stdout: '', stderr: '' };
      },
    });
    assert.equal(r.exit, 0, r.output);
    assert.equal(r.executed, false, 'plan_only performs no effect');
    assert.equal(prepares.length, 1, 'exactly one prepare child');
    const { args, childEnv } = prepares[0];
    assert.deepEqual(args.slice(0, 3), ['cdk', 'deploy', '--method=prepare-change-set']);
    assert.deepEqual(args.slice(3, 5), ['--change-set-name', `cba-70-${manifest.releaseSha.slice(0, 12)}`]);
    assert.deepEqual(args.slice(5, 10), ['--exclusively', ...ORDERED_IDS], 'the reviewed EXECUTION order, closed');
    assert.equal(args.includes('--all'), false, '--all must never reach a child');
    assert.equal(args.includes('SecurityStack'), false, 'the foundation is outside the release blast radius');
    const appPath = args[args.indexOf('--app') + 1];
    assert.notEqual(appPath, asm, 'the original assembly path must never be reopened by the child');
    assert.equal(childEnv.AWS_REGION, 'us-east-1');
    assert.equal(childEnv.AWS_DEFAULT_REGION, 'us-east-1');
    assert.equal(childEnv.CDK_DEFAULT_REGION, 'us-east-1');
    assert.equal(childEnv.PATH, '/usr/bin', 'the rest of the environment passes through');
    assert.equal(prepares[0].snapDigest, manifest.assemblyDigest, 'the prepared snapshot carries the verified digest even after the original was mutated');
    assert.match(r.output, /PLAN_DIGEST [0-9a-f]{64}/);
    // The change sets were described under the ASSUMED tier deploy role, never executed.
    const assume = run.of('assume-role');
    assert.equal(assume.length, 1);
    assert.match(assume[0].args[assume[0].args.indexOf('--role-arn') + 1], /cdk-cbarpil-deploy-role/, "this tier's qualifier, nobody else's");
    assert.equal(run.of('describe-change-set').length, 4);
    assert.equal(run.of('execute-change-set').length, 0, 'plan_only executes NOTHING');
  });

  // Part B — deploy: NO cdk child at all. The reviewed change sets are re-described, the digest
  // must match the gate, and exactly those change-set ids execute, in order, under the assumed
  // role with the verified region imposed.
  withRelease((p, asm, manifest) => {
    const run = cloudRun();
    const r = runDeployRelease(releaseArgs(p, asm), deployOpts(manifest, { run }));
    assert.equal(r.exit, 0, r.output);
    assert.equal(r.executed, true);
    const executes = run.of('execute-change-set');
    assert.deepEqual(
      executes.map((c) => c.args[c.args.indexOf('--change-set-name') + 1]),
      PILOT_STACK_NAMES.map(CS_ARN),
      'exactly the reviewed change-set ids, in the reviewed order',
    );
    for (const call of [...executes, ...run.of('describe-change-set')]) {
      assert.equal(call.opts?.env?.AWS_ACCESS_KEY_ID, 'ASIATESTKEY', 'CloudFormation calls run under the assumed tier role');
      assert.equal(call.opts?.env?.AWS_REGION, 'us-east-1', 'the verified region is imposed on the AWS CLI too');
    }
    assert.match(r.output, /matched the gate; decision zamp-2026-08-02\.b1-deploy-01/);
  });
});

test('ROUND-5 REPRO: every deploy-relevant file is bound — asset bytes, asset manifest and cloud manifest', () => {
  // Each of these mutations left the OLD digest unchanged, because it hashed only the root
  // templates: different BFF Lambda bytes could deploy under the reviewed assembly identity.
  for (const [label, over] of [
    ['the Lambda bundle bytes', { 'asset.abc123/index.mjs': 'export const handler = () => fetch("https://attacker.example");' }],
    ['the asset manifest', { 'ApiStack.assets.json': '{"version":"36.0.0","files":{"abc123":{"source":{"path":"asset.evil"}}}}' }],
    ['the cloud manifest', { 'manifest.json': '{"version":"36.0.0","artifacts":{}}' }],
    ['an added file', { 'asset.abc123/extra.mjs': 'export const smuggled = 1;' }],
  ]) {
    withRelease(
      (p2, asm) => {
        const r = runDeployRelease(releaseArgs(p2, asm), {
          run: stubAws(),
          git: happyGit(),
          cdkJsonPath: CDK_JSON,
          exec: () => assert.fail(`a drifted assembly (${label}) must never reach a deploy`),
        });
        assert.equal(r.exit, 1, label);
        assert.match(r.output, /ASSEMBLY_DIGEST_MISMATCH/, label);
      },
      { assemblyFiles: { ...ASSEMBLY_FILES, ...over } },
    );
  }

  // A REMOVED file changes the digest too.
  const withoutAsset = { ...ASSEMBLY_FILES };
  delete withoutAsset['asset.abc123/index.mjs'];
  withRelease(
    (p2, asm) => {
      const r = runDeployRelease(releaseArgs(p2, asm), { run: stubAws(), git: happyGit(), cdkJsonPath: CDK_JSON, exec: () => assert.fail('must not exec') });
      assert.equal(r.exit, 1);
      assert.match(r.output, /ASSEMBLY_DIGEST_MISMATCH/);
    },
    { assemblyFiles: withoutAsset },
  );

  // A symlink inside the assembly is refused outright — it is a path for content to escape the digest.
  withRelease(
    (p2, asm) => {
      const r = runDeployRelease(releaseArgs(p2, asm), { run: stubAws(), git: happyGit(), cdkJsonPath: CDK_JSON, exec: () => assert.fail('must not exec') });
      assert.equal(r.exit, 1);
      assert.match(r.output, /ASSEMBLY_UNSAFE_ENTRY/);
    },
    { assemblyFiles: { ...ASSEMBLY_FILES, 'asset.abc123/link.mjs': { symlink: '/etc/hostname' } } },
  );
});

test('the context contract cannot be read around — tryGetContext is confined and keys are literal', () => {
  // ROUND-5 REPRO: `this.node.tryGetContext('newDeployTarget')` produced no discovered key under
  // the old scanner. Three fences now: the scanner sees tryGetContext too (proven on a planted
  // source), direct tryGetContext is forbidden outside the central helper, and getContext refuses
  // unlisted keys at runtime, so an unbound read fails synth loudly.
  const scan = (src) => {
    // The ONE sanctioned non-literal shape is the forwarding wrapper definition itself:
    //   const ctx = (key, fallback) => getContext(this.node, key, fallback);
    // Everything else must name its key as a literal, or it cannot join the discovery set.
    const withoutWrapper = src.replaceAll('const ctx = (key, fallback) => getContext(this.node, key, fallback);', '');
    const keys = [];
    const nonLiteral = [];
    for (const m of withoutWrapper.matchAll(/(?:\bctx|getContext|tryGetContext)\(\s*(?:this\.node\s*,\s*|node\s*,\s*)?('([^']+)'|[^)'\s][^),]*)/g)) {
      if (m[2] !== undefined) keys.push(m[2]);
      else nonLiteral.push(m[1]);
    }
    return { keys, nonLiteral };
  };

  // The scanner DOES see the native-API bypass and non-literal keys — proven, not assumed.
  assert.deepEqual(scan("this.node.tryGetContext('newDeployTarget')").keys, ['newDeployTarget']);
  assert.equal(scan('getContext(this.node, someVariable)').nonLiteral.length, 1);

  const libDir = path.join(__dirname, '..', 'lib');
  const discovered = new Set();
  for (const f of fs.readdirSync(libDir).filter((n) => n.endsWith('.js'))) {
    const src = fs.readFileSync(path.join(libDir, f), 'utf8');
    if (f !== 'context.js') {
      assert.equal(src.includes('tryGetContext'), false, `${f} must go through the central getContext helper`);
      const { keys, nonLiteral } = scan(src);
      assert.deepEqual(nonLiteral, [], `${f} must use literal context keys`);
      for (const k of keys) discovered.add(k);
    }
  }
  for (const f of fs.readdirSync(path.join(__dirname, '..', 'bin')).filter((n) => n.endsWith('.js'))) {
    assert.equal(fs.readFileSync(path.join(__dirname, '..', 'bin', f), 'utf8').includes('tryGetContext'), false, `bin/${f} must not read context directly`);
  }
  discovered.delete('environment');

  // BOTH directions: everything consumed is declared, and everything declared is consumed — a
  // declared-but-dead key is an entry an attacker could activate without the digest noticing.
  for (const k of discovered) assert.ok(DEPLOY_CONTEXT_KEYS.includes(k), `context key "${k}" must join the closed deploy contract`);
  for (const k of DEPLOY_CONTEXT_KEYS) assert.ok(discovered.has(k), `declared key "${k}" is consumed by no stack`);

  // Runtime refusal, as defense in depth: an unlisted key fails synth loudly.
  const { getContext } = require('../lib/context');
  const fakeNode = { tryGetContext: () => undefined };
  assert.throws(() => getContext(fakeNode, 'newDeployTarget', 'x'), /outside the closed deploy contract/);
  assert.equal(getContext(fakeNode, 'githubRepo', 'fallback'), 'fallback');
});

test('ROUND-4 REPRO 1: a manifest naming a release the worktree is NOT at is refused before exec', () => {
  withRelease((p, asm) => {
    const r = runDeployRelease(releaseArgs(p, asm), {
      run: stubAws(),
      git: happyGit('b'.repeat(40)), // HEAD is a different commit than the manifest's release
      cdkJsonPath: CDK_JSON,
      exec: () => assert.fail('a mismatched HEAD must never reach a deploy'),
    });
    assert.equal(r.exit, 1);
    assert.match(r.output, /RELEASE_HEAD_MISMATCH/);
  });
});

test('a dirty worktree is refused — the deploy must run from exactly the release commit', () => {
  withRelease((p, asm) => {
    const r = runDeployRelease(releaseArgs(p, asm), {
      run: stubAws(),
      git: (args) => (args[0] === 'rev-parse' ? { status: 0, stdout: `${SHA}\n` } : { status: 0, stdout: ' M infra/aws/lib/api-stack.js\n' }),
      cdkJsonPath: CDK_JSON,
      exec: () => assert.fail('a dirty worktree must never reach a deploy'),
    });
    assert.equal(r.exit, 1);
    assert.match(r.output, /WORKTREE_DIRTY/);
  });
});

test('an assembly that drifted from the digested one is refused — templates are the deployable content', () => {
  withRelease(
    (p, asm) => {
      const r = runDeployRelease(releaseArgs(p, asm), {
        run: stubAws(),
        git: happyGit(),
        cdkJsonPath: CDK_JSON,
        exec: () => assert.fail('a drifted assembly must never reach a deploy'),
      });
      assert.equal(r.exit, 1);
      assert.match(r.output, /ASSEMBLY_DIGEST_MISMATCH/);
    },
    { assemblyFiles: { ...ASSEMBLY_FILES, 'IdentityStack.template.json': '{"Resources":{"Pool":{"Type":"AWS::Cognito::UserPool","Evil":1}}}' } },
  );

  // And an unreadable or empty assembly is a refusal of its own.
  withRelease(
    (p, asm) => {
      const r = runDeployRelease(releaseArgs(p, asm), { run: stubAws(), git: happyGit(), cdkJsonPath: CDK_JSON, exec: () => assert.fail('must not exec') });
      assert.equal(r.exit, 1);
      assert.match(r.output, /ASSEMBLY_UNREADABLE/);
    },
    { assemblyFiles: {} },
  );
});

test('ROUND-3 REPRO 1: verify a safe context, deploy a different one — refused before any exec', () => {
  withRelease((p, asm) => {
    const r = runDeployRelease(releaseArgs(p, asm, ['-c', 'authDomainPrefix=cba-study-coach-pilot-evil']), {
      run: stubAws(),
      git: happyGit(),
      cdkJsonPath: CDK_JSON,
      exec: () => assert.fail('a mismatched context must never reach the deploy'),
    });
    assert.equal(r.exit, 1);
    assert.match(r.output, /MANIFEST_RECOMPUTE_MISMATCH/);
  });
});

test('ROUND-3 REPRO 2: credentials swapped between verification and deploy — refused before any exec', () => {
  withRelease((p, asm) => {
    let stsCalls = 0;
    const r = runDeployRelease(releaseArgs(p, asm), {
      run: (args, o) => {
        if (args[0] === 'sts') {
          stsCalls += 1;
          const account = stsCalls === 1 ? ACCOUNT : '2'.repeat(12);
          return { status: 0, stdout: JSON.stringify({ Account: account }), stderr: '' };
        }
        return stubAws()(args, o);
      },
      git: happyGit(),
      cdkJsonPath: CDK_JSON,
      exec: () => assert.fail('a swapped account must never reach the deploy'),
    });
    assert.equal(r.exit, 1);
    assert.equal(stsCalls, 2, 'the account is resolved at verification AND immediately before the effect');
    assert.match(r.output, /ACCOUNT_CHANGED/);
  });
});

test('ROUND-3 REPRO 3: an AWS manifest cannot drive any other target — structurally', () => {
  const manifest = capturedManifest();
  withDir(ASSEMBLY_FILES, (asm) => {
    withManifest({ ...manifest, target: { service: 'cloudflare' } }, (p) => {
      const r = runDeployRelease(releaseArgs(p, asm), {
        run: stubAws(),
        git: happyGit(),
        cdkJsonPath: CDK_JSON,
        exec: () => assert.fail('a foreign target must never reach a deploy'),
      });
      assert.equal(r.exit, 1);
      assert.match(r.output, /MANIFEST_MALFORMED/);
    });
  });
  const source = fs.readFileSync(path.join(__dirname, '..', 'bin', 'deploy-release.js'), 'utf8');
  assert.equal(/wrangler|opennextjs/.test(source.replace(/\/\/[^\n]*/g, '')), false, 'no foreign deploy path exists outside comments');
});

test('deploy-release refuses identity mismatches and a failing child honestly', () => {
  withRelease((p, asm) => {
    for (const [flag, value, expected] of [
      ['--environment', 'dev', /MANIFEST_ENVIRONMENT_MISMATCH/],
      ['--release-sha', 'b'.repeat(40), /MANIFEST_RELEASE_MISMATCH/],
      ['--region', 'us-west-2', /MANIFEST_REGION_MISMATCH/],
    ]) {
      const args = releaseArgs(p, asm);
      args[args.indexOf(flag) + 1] = value;
      // The release-sha mismatch also trips the HEAD binding; both are refusals, either suffices.
      const r = runDeployRelease(args, { run: stubAws(), git: happyGit(), cdkJsonPath: CDK_JSON, exec: () => assert.fail('must not exec') });
      assert.equal(r.exit, 1, flag);
      assert.match(r.output, expected, flag);
    }

    const noAccount = runDeployRelease(releaseArgs(p, asm), { run: stubAws({ stsStatus: 254 }), git: happyGit(), cdkJsonPath: CDK_JSON, exec: () => assert.fail('must not exec') });
    assert.equal(noAccount.exit, 1);
    assert.match(noAccount.output, /ACCOUNT_UNRESOLVED/);

    // A refused EXECUTION is honest, never a deployed release: CloudFormation refuses a change
    // set whose stack moved after preparation, and that refusal surfaces as EXECUTE_FAILED with
    // the partial record — the round-4 stale-execution shape.
    const run = cloudRun({ onCall: (args) => (args[1] === 'execute-change-set' ? { status: 254, stdout: '', stderr: 'ChangeSet is stale; the stack was modified' } : null) });
    const staleExec = runDeployRelease(releaseArgs(p, asm), deployOpts(capturedManifest(), { run }));
    assert.equal(staleExec.exit, 1, 'a refused execution must not read as a deployed release');
    assert.equal(staleExec.executed, false);
    assert.match(staleExec.output, /EXECUTE_FAILED/);
    assert.match(staleExec.output, /Executed before the failure: none/);
    assert.equal(run.of('execute-change-set').length, 1, 'the refusal stops the sequence');
  });
});

test('the cloud gate is required, closed, bound and expiring — every broken form refuses before any child', () => {
  withRelease((p, asm, manifest) => {
    const attempt = (gateValue, opts = {}) =>
      runDeployRelease(releaseArgs(p, asm), {
        run: stubAws(),
        git: happyGit(),
        cdkJsonPath: CDK_JSON,
        env: gateValue === undefined ? {} : { CBA_CLOUD_GATE: gateValue },
        now: () => GATE_NOW,
        exec: () => assert.fail('a run without a valid gate must never spawn a child'),
        ...opts,
      });

    // Absence, in every trivial disguise, is MISSING — never a default.
    for (const [label, value] of [['unset', undefined], ['empty', ''], ['whitespace', '   ']]) {
      const r = attempt(value);
      assert.equal(r.exit, 1, label);
      assert.match(r.output, /CLOUD_GATE_MISSING/, label);
    }

    // The shape is CLOSED: exactly the nine keys, issue 70, a known mode, a decision id, STRICT
    // RFC3339 UTC instants, and a plan digest matching the mode. `Date.parse` alone accepted
    // `2099-01-01` and a space-separated datetime — the exact round-3 reproductions refuse here.
    const good = JSON.parse(gateFor(manifest));
    for (const [label, mangled] of [
      ['not JSON', 'not json'],
      ['an array', '[]'],
      ['an extra key', JSON.stringify({ ...good, extra: 1 })],
      ['a missing key', JSON.stringify((() => { const { mode: _, ...rest } = good; return rest; })())],
      ['a foreign issue', JSON.stringify({ ...good, issue: 71 })],
      ['an unknown mode', JSON.stringify({ ...good, mode: 'deploy_all' })],
      ['a non-string expiry', JSON.stringify({ ...good, expiresAt: 9999999999 })],
      ['an unparseable expiry', JSON.stringify({ ...good, expiresAt: 'sometime soon' })],
      ['a date-only expiry (round-3 repro)', JSON.stringify({ ...good, expiresAt: '2099-01-01' })],
      ['a space-separated expiry (round-3 repro)', JSON.stringify({ ...good, expiresAt: '2026-08-02 12:30:00' })],
      ['an offset expiry — UTC Z only', JSON.stringify({ ...good, expiresAt: '2026-08-02T12:30:00+00:00' })],
      ['a date-only approval', JSON.stringify({ ...good, approvedAt: '2026-08-02' })],
      ['a missing decision id', JSON.stringify({ ...good, decisionId: '' })],
      ['a malformed decision id', JSON.stringify({ ...good, decisionId: 'a b c' })],
      ['a deploy gate with no plan digest', JSON.stringify({ ...good, planDigest: null })],
      ['a deploy gate with a malformed plan digest', JSON.stringify({ ...good, planDigest: 'zz' })],
      ['a plan_only gate naming a plan', JSON.stringify({ ...good, mode: 'plan_only' })],
      ['the retired diff_only mode', JSON.stringify({ ...good, mode: 'diff_only' })],
      // F5 (round 4): Date.parse silently normalizes calendar-invalid instants into other dates.
      ['a calendar-invalid day (2026-02-30)', JSON.stringify({ ...good, expiresAt: '2026-02-30T12:10:00Z' })],
      ['a calendar-invalid month', JSON.stringify({ ...good, expiresAt: '2026-13-01T12:10:00Z' })],
      ['a calendar-invalid approval (April 31st)', JSON.stringify({ ...good, approvedAt: '2026-04-31T11:50:00Z' })],
      ['fractional seconds (whole seconds only)', JSON.stringify({ ...good, expiresAt: '2026-08-02T12:30:00.500Z' })],
    ]) {
      const r = attempt(mangled);
      assert.equal(r.exit, 1, label);
      assert.match(r.output, /CLOUD_GATE_MALFORMED/, label);
    }

    // The gate binds by VALUE: another release, another environment or another assembly is a
    // re-aim, and a re-aimed authorization authorizes nothing.
    for (const [label, over] of [
      ['another release', { releaseSha: 'b'.repeat(40) }],
      ['another environment', { environment: 'dev' }],
      ['another manifest', { manifestDigest: '0'.repeat(64) }],
    ]) {
      const r = attempt(gateFor(manifest, over));
      assert.equal(r.exit, 1, label);
      assert.match(r.output, /CLOUD_GATE_MISMATCH/, label);
    }

    // SLICE I4 (SPEC-DEPLOY-019): the RETIRED schema's key is now an UNKNOWN key — a gate
    // written to the -002 shape (assemblyDigest) is malformed, not merely mismatched, so a
    // stale authoring template cannot half-work.
    {
      const old = JSON.parse(gateFor(manifest));
      delete old.manifestDigest;
      old.assemblyDigest = manifest.assemblyDigest;
      const r = attempt(JSON.stringify(old));
      assert.equal(r.exit, 1);
      assert.match(r.output, /CLOUD_GATE_MALFORMED/);
    }

    // SLICE I5: abandon must NAME the declined plan — a null planDigest is malformed per §8a.
    {
      const r = attempt(gateFor(manifest, { mode: 'abandon', planDigest: null }));
      assert.equal(r.exit, 1);
      assert.match(r.output, /CLOUD_GATE_MALFORMED/);
    }
    // SLICE I5: the run's name must mean what happened — a dispatched lane passes its mode, and
    // an incoherent gate refuses by name before any change-set API call.
    for (const [dispatch, gateMode] of [['abandon', 'deploy'], ['abandon', 'plan_only'], ['dev_only', 'abandon']]) {
      const calls = [];
      const inner = stubAws();
      const r = attempt(gateFor(manifest, { mode: gateMode, planDigest: gateMode === 'plan_only' ? null : JSON.parse(gateFor(manifest)).planDigest }), {
        env: { CBA_CLOUD_GATE: gateFor(manifest, { mode: gateMode, planDigest: gateMode === 'plan_only' ? null : JSON.parse(gateFor(manifest)).planDigest }), DISPATCH_MODE: dispatch },
        run: (args, o) => { calls.push(args[1] ?? args[0]); return inner(args, o); },
      });
      assert.equal(r.exit, 1, `${dispatch} vs ${gateMode}`);
      assert.match(r.output, /MODE_MISMATCH/, `${dispatch} vs ${gateMode}`);
      assert.ok(!calls.some((c) => String(c).includes('change-set')), 'no change-set API may be touched');
    }

    // The window, against the INJECTED clock — a gate is a decision with a bounded life, never a
    // standing authorization. An old gate REPRESENTED on a later run is the same refusal.
    const expired = attempt(gateFor(manifest), { now: () => Date.parse('2026-08-02T12:30:00Z') });
    assert.equal(expired.exit, 1);
    assert.match(expired.output, /CLOUD_GATE_EXPIRED/);
    const yesterdays = attempt(gateFor(manifest, { approvedAt: '2026-08-01T11:50:00Z', expiresAt: '2026-08-01T12:30:00Z' }));
    assert.equal(yesterdays.exit, 1, 'a stale gate re-presented the next day authorizes nothing');
    assert.match(yesterdays.output, /CLOUD_GATE_EXPIRED/);
    const future = attempt(gateFor(manifest, { approvedAt: '2026-08-02T12:10:00Z', expiresAt: '2026-08-02T12:40:00Z' }));
    assert.equal(future.exit, 1);
    assert.match(future.output, /CLOUD_GATE_NOT_YET_VALID/);
    // TTL ceiling: a century, a two-hour window, and an inverted window are each refused — the
    // 2099-style standing authorization the review reproduced can no longer be expressed.
    for (const [label, over] of [
      ['a century', { expiresAt: '2099-01-01T00:00:00Z' }],
      ['two hours', { expiresAt: '2026-08-02T13:51:00Z' }],
      ['inverted', { expiresAt: '2026-08-02T11:00:00Z' }],
    ]) {
      const r = attempt(gateFor(manifest, over));
      assert.equal(r.exit, 1, label);
      assert.match(r.output, /CLOUD_GATE_TTL_EXCEEDED/, label);
    }
    const stillOpen = attempt(gateFor(manifest), { run: cloudRun(), sleep: () => {}, now: () => Date.parse('2026-08-02T12:29:59Z') });
    assert.equal(stillOpen.exit, 0, stillOpen.output);
  });
});

test('plan_only puts the change sets on the record and deploys NOTHING', () => {
  withRelease((p, asm, manifest) => {
    const run = cloudRun();
    const r = runDeployRelease(releaseArgs(p, asm), {
      run,
      git: happyGit(),
      cdkJsonPath: CDK_JSON,
      env: { CBA_CLOUD_GATE: gateFor(manifest, { mode: 'plan_only', planDigest: null }) },
      now: () => GATE_NOW,
      sleep: () => {},
      exec: happyExec,
    });
    assert.equal(r.exit, 0, r.output);
    assert.equal(r.executed, false, 'a plan_only run performs no effect');
    assert.equal(run.of('execute-change-set').length, 0, 'no change set may execute');
    assert.match(r.output, /PLAN ONLY/);
    assert.match(r.output, /PLAN_DIGEST [0-9a-f]{64}/);
    assert.match(r.output, /BffFunction/, 'the plan rendering is on the record for review');
    const digest = r.output.match(/PLAN_DIGEST ([0-9a-f]{64})/)[1];
    assert.equal(digest, digestOf(fullDescribes()), 'the recorded digest is the digest of the UNREDACTED canonical describes');
  });
});

test('a failing prepare child refuses the run — no change sets, no plan, no effect', () => {
  withRelease((p, asm, manifest) => {
    const run = cloudRun();
    const r = runDeployRelease(releaseArgs(p, asm), {
      run,
      git: happyGit(),
      cdkJsonPath: CDK_JSON,
      env: { CBA_CLOUD_GATE: gateFor(manifest, { mode: 'plan_only', planDigest: null }) },
      now: () => GATE_NOW,
      sleep: () => {},
      exec: () => ({ status: 1, stdout: '', stderr: 'prepare exploded' }),
    });
    assert.equal(r.exit, 1);
    assert.match(r.output, /PLAN_PREPARE_FAILED/);
    assert.equal(run.of('assume-role').length, 0, 'no role is assumed for a plan that failed to prepare');
    assert.equal(run.of('execute-change-set').length, 0);
  });
});

test('SPEC-DEPLOY-009: strict RFC3339 UTC instants — invalid calendar, offsets and non-canonical forms refuse; the canonical instant passes', () => {
  withRelease((p, asm, manifest) => {
    const attempt = (over) =>
      runDeployRelease(releaseArgs(p, asm), {
        run: stubAws(),
        git: happyGit(),
        cdkJsonPath: CDK_JSON,
        env: { CBA_CLOUD_GATE: gateFor(manifest, over) },
        now: () => GATE_NOW,
        exec: () => assert.fail('a malformed instant must never spawn a child'),
      });
    // The adversarial matrix of the batch-2 activation (Codex): every non-canonical form of an
    // instant is CLOUD_GATE_MALFORMED — never parsed leniently, never normalized.
    for (const [label, value] of [
      ['invalid calendar date', '2026-02-30T10:00:00Z'],
      ['offset instead of Z', '2026-08-02T11:50:00+00:00'],
      ['negative offset', '2026-08-02T08:50:00-03:00'],
      ['fractional seconds', '2026-08-02T11:50:00.000Z'],
      ['unpadded month-day', '2026-8-2T11:50:00Z'],
      ['space separator', '2026-08-02 11:50:00Z'],
      ['no timezone at all', '2026-08-02T11:50:00'],
      ['lowercase z', '2026-08-02T11:50:00z'],
    ]) {
      const r = attempt({ approvedAt: value });
      assert.equal(r.exit, 1, label);
      assert.match(r.output, /CLOUD_GATE_MALFORMED/, label);
    }
    // …and the canonical instant is the ONE accepted form: the default gate reaches past the
    // gate check entirely (its failure, if any, is not the gate's shape).
    const ok = attempt({});
    assert.ok(!/CLOUD_GATE_MALFORMED/.test(ok.output), 'the canonical UTC instant must pass the shape check');
  });
});

test('SPEC-DEPLOY-010: the window law — approvedAt inclusive, expiresAt exclusive, the one-hour TTL ceiling exact', () => {
  withRelease((p, asm, manifest) => {
    const attempt = (over, nowIso) =>
      runDeployRelease(releaseArgs(p, asm), {
        run: stubAws(),
        git: happyGit(),
        cdkJsonPath: CDK_JSON,
        env: { CBA_CLOUD_GATE: gateFor(manifest, over) },
        now: () => Date.parse(nowIso),
        exec: () => assert.fail('a lapsed or premature window must never spawn a child'),
      });
    // now == approvedAt is INSIDE the window (inclusive start)…
    const atStart = attempt({}, '2026-08-02T11:50:00Z');
    assert.ok(!/CLOUD_GATE_EXPIRED|CLOUD_GATE_NOT_YET_VALID/.test(atStart.output), 'now == approvedAt is authorized');
    // …now < approvedAt is not yet valid…
    const early = attempt({}, '2026-08-02T11:49:59Z');
    assert.equal(early.exit, 1);
    assert.match(early.output, /CLOUD_GATE_NOT_YET_VALID/);
    // …and now == expiresAt is OUTSIDE (exclusive end): a window is a half-open interval.
    const atEnd = attempt({}, '2026-08-02T12:30:00Z');
    assert.equal(atEnd.exit, 1);
    assert.match(atEnd.output, /CLOUD_GATE_EXPIRED/);
    // TTL of exactly one hour is the ceiling — accepted…
    const exactHour = attempt({ approvedAt: '2026-08-02T11:50:00Z', expiresAt: '2026-08-02T12:50:00Z' }, '2026-08-02T12:00:00Z');
    assert.ok(!/CLOUD_GATE_MALFORMED|CLOUD_GATE_TTL/.test(exactHour.output), 'exactly 1h TTL is legal');
    // …one second beyond is refused.
    const overHour = attempt({ approvedAt: '2026-08-02T11:50:00Z', expiresAt: '2026-08-02T12:50:01Z' }, '2026-08-02T12:00:00Z');
    assert.equal(overHour.exit, 1);
    assert.match(overHour.output, /CLOUD_GATE_MALFORMED|CLOUD_GATE_TTL/);
  });
});

test('SPEC-DEPLOY-019: the closed gate schema — absent and unknown keys, wrong types, per-mode nullability and incompatible effects refuse', () => {
  withRelease((p, asm, manifest) => {
    const attempt = (gateValue, envOver = {}) =>
      runDeployRelease(releaseArgs(p, asm), {
        run: stubAws(),
        git: happyGit(),
        cdkJsonPath: CDK_JSON,
        env: { CBA_CLOUD_GATE: gateValue, ...envOver },
        now: () => GATE_NOW,
        exec: () => assert.fail('a malformed gate must never spawn a child'),
      });
    const base = JSON.parse(gateFor(manifest));
    // Absent key: each of the eleven, removed one at a time, refuses.
    for (const key of Object.keys(base)) {
      const broken = { ...base };
      delete broken[key];
      const r = attempt(JSON.stringify(broken));
      assert.equal(r.exit, 1, `absent ${key}`);
      assert.match(r.output, /CLOUD_GATE_MALFORMED/, `absent ${key}`);
    }
    // Unknown key refuses — the schema is a sorted key-set equality, not a subset check.
    const extra = attempt(JSON.stringify({ ...base, note: 'x' }));
    assert.match(extra.output, /CLOUD_GATE_MALFORMED/);
    // Wrong type refuses.
    const wrongType = attempt(JSON.stringify({ ...base, issue: '70' }));
    assert.match(wrongType.output, /CLOUD_GATE_MALFORMED/);
    // Per-mode nullability: plan_only with a plan digest, and deploy without one, both refuse.
    const planWithDigest = attempt(gateFor(manifest, { mode: 'plan_only' }));
    assert.match(planWithDigest.output, /CLOUD_GATE_MALFORMED/);
    const deployNoDigest = attempt(gateFor(manifest, { planDigest: null }));
    assert.match(deployNoDigest.output, /CLOUD_GATE_MALFORMED/);
    // Mode outside the enum refuses.
    const badMode = attempt(gateFor(manifest, { mode: 'cleanup' }));
    assert.match(badMode.output, /CLOUD_GATE_MALFORMED/);
    // Incompatible effect: a run dispatched as abandon carrying a deploy-mode gate refuses by
    // name — the mode/effect binding half of the law.
    const mismatched = attempt(gateFor(manifest), { DISPATCH_MODE: 'abandon' });
    assert.equal(mismatched.exit, 1);
    assert.match(mismatched.output, /MODE_MISMATCH/);
  });
});

test('ROUND-4 REPRO: the deploy executes ONLY the change sets the gate names — drift refuses as PLAN_CHANGED', () => {
  withRelease((p, asm, manifest) => {
    // Run 1 — plan_only over live state A: the change sets and their digest go on the record.
    const describesA = fullDescribes();
    const reviewed = runDeployRelease(releaseArgs(p, asm), {
      run: cloudRun({ describes: describesA }),
      git: happyGit(),
      cdkJsonPath: CDK_JSON,
      env: { CBA_CLOUD_GATE: gateFor(manifest, { mode: 'plan_only', planDigest: null }) },
      now: () => GATE_NOW,
      sleep: () => {},
      exec: happyExec,
    });
    assert.equal(reviewed.exit, 0, reviewed.output);
    const namedDigest = reviewed.output.match(/PLAN_DIGEST ([0-9a-f]{64})/)[1];
    assert.equal(namedDigest, digestOf(describesA));

    // Run 2 — deploy naming that digest, but the change sets were RECREATED (new immutable ids):
    // same shapes, different world. Nothing executes.
    const describesB = fullDescribes();
    for (const name of PILOT_STACK_NAMES) describesB[name].ChangeSetId = describesB[name].ChangeSetId.replace(/[0-9a-f]{12}$/, 'aaaaaaaaaaaa');
    const run = cloudRun({ describes: describesB });
    const r = runDeployRelease(releaseArgs(p, asm), deployOpts(manifest, { run, env: { CBA_CLOUD_GATE: gateFor(manifest, { planDigest: namedDigest }) } }));
    assert.equal(r.exit, 1);
    assert.match(r.output, /PLAN_CHANGED/);
    assert.equal(run.of('execute-change-set').length, 0, 'a drifted plan must never execute');

    // Re-reviewed — a fresh plan_only over the new world, a gate naming ITS digest — executes.
    const rerun = cloudRun({ describes: describesB });
    const rereviewed = runDeployRelease(releaseArgs(p, asm), deployOpts(manifest, { run: rerun, env: { CBA_CLOUD_GATE: gateFor(manifest, { planDigest: digestOf(describesB) }) } }));
    assert.equal(rereviewed.exit, 0, rereviewed.output);
    assert.equal(rerun.of('execute-change-set').length, 4);
  });
});

test('ROUND-4/5 REPRO: principals cannot collide in the digest AND stay visibly distinguishable in review', () => {
  // Round 4: two plans differing only in an ARN principal sanitized to the same text and the
  // same SHA-256 — the digest now covers the UNREDACTED canonical describes. Round 5: pure
  // redaction ALSO made them indistinguishable to the human — the rendering now fingerprints
  // every identifier, so Zamp SEES that two principals differ (and can recognize a known one by
  // its stable fingerprint) while the log never carries the identifier itself.
  const principal = (arn) => fullDescribes({
    [PILOT_STACK_NAMES[0]]: {
      Changes: [{ Type: 'Resource', ResourceChange: { Action: 'Modify', LogicalResourceId: 'Pool', ResourceType: 'AWS::Cognito::UserPool', Details: [{ Target: { Attribute: 'Properties', Name: 'AdminCreateUserConfig' }, CausingEntity: arn }] } }],
    },
  });
  // Round 6: the expected deploy role versus an attacker's role — Zamp must be able to CLASSIFY
  // them, not merely tell two opaque hashes apart. Structure stays verbatim (service, region,
  // resource path — repository-public names); only the ACCOUNT is pseudonymized, at 128 bits.
  const expectedRole = `arn:aws:iam::${ACCOUNT}:role/cba-study-coach-gha-deploy-dev`;
  const attackerRole = `arn:aws:iam::${ACCOUNT}:role/evil-admin`;
  const planA = principal(expectedRole);
  const planB = principal(attackerRole);
  assert.notEqual(digestOf(planA), digestOf(planB), 'different principals MUST produce different plan digests');
  const { renderPlan } = require('../bin/deploy-release');
  const render = (d) => renderPlan(ORDERED_IDS.map((id, i) => canonicalChangeSet(id, PILOT_STACK_NAMES[i], d[PILOT_STACK_NAMES[i]])));
  assert.notEqual(render(planA), render(planB), 'different principals MUST render distinguishably');
  assert.match(render(planA), /arn:aws:iam::\[account-redacted\]:role\/cba-study-coach-gha-deploy-dev/, 'the EXPECTED principal is classifiable by its visible path');
  assert.match(render(planB), /arn:aws:iam::\[account-redacted\]:role\/evil-admin/, 'an ATTACKER principal is exposed by its visible path — not hidden behind an opaque hash');
  for (const rendering of [render(planA), render(planB)]) {
    assert.equal(rendering.includes(ACCOUNT), false, 'the rendering never carries the account id');
    assert.match(rendering, /Properties\.AdminCreateUserConfig/, 'the changed property is named — semantics, not just identity');
  }
  // 128-bit pseudonyms: no feasible collision surface, stable across renderings.
  assert.equal(render(planA), render(principal(expectedRole)), 'pseudonyms are stable across renderings');

  // End to end: a gate naming plan A refuses when the world holds plan B.
  withRelease((p, asm, manifest) => {
    const run = cloudRun({ describes: planB });
    const r = runDeployRelease(releaseArgs(p, asm), deployOpts(manifest, { run, env: { CBA_CLOUD_GATE: gateFor(manifest, { planDigest: digestOf(planA) }) } }));
    assert.equal(r.exit, 1);
    assert.match(r.output, /PLAN_CHANGED/);
    assert.equal(run.of('execute-change-set').length, 0);
  });
});

test('ROUND-4 REPRO: the window lapses during the FINAL account resolution — the effect never starts', () => {
  withRelease((p, asm, manifest) => {
    // now() is consumed at the gate check, then per mutation. The third STS resolution is slow:
    // by the time the per-mutation check runs, the window has lapsed. Account FIRST, clock LAST.
    const instants = [Date.parse('2026-08-02T12:00:00Z')];
    const run = cloudRun();
    const r = runDeployRelease(releaseArgs(p, asm), deployOpts(manifest, {
      run,
      now: () => instants.shift() ?? Date.parse('2026-08-02T12:31:00Z'),
    }));
    assert.equal(r.exit, 1);
    assert.match(r.output, /CLOUD_GATE_EXPIRED/);
    assert.match(r.output, /Executed before the window lapsed: none/);
    assert.equal(run.of('execute-change-set').length, 0, 'no mutation may start after the window lapsed');
  });
});

test('the window is re-checked before EVERY mutation — a lapse mid-sequence stops with the honest record', () => {
  withRelease((p, asm, manifest) => {
    // Valid at the gate check and for the first two executions; lapsed before the third.
    const instants = [
      Date.parse('2026-08-02T12:00:00Z'), // gate check
      Date.parse('2026-08-02T12:05:00Z'), // before execute #1
      Date.parse('2026-08-02T12:10:00Z'), // before execute #2
      Date.parse('2026-08-02T12:31:00Z'), // before execute #3 — lapsed
    ];
    const run = cloudRun();
    const r = runDeployRelease(releaseArgs(p, asm), deployOpts(manifest, { run, now: () => instants.shift() ?? Date.parse('2026-08-02T12:31:00Z') }));
    assert.equal(r.exit, 1);
    assert.match(r.output, /CLOUD_GATE_EXPIRED/);
    assert.equal(run.of('execute-change-set').length, 2, 'exactly the in-window executions happened');
    assert.match(r.output, /Executed before the window lapsed: cba-study-coach-pilot-identity, cba-study-coach-pilot-data/);
    assert.match(r.output, /Remaining change sets were NOT executed/);
  });
});

test('the plan is EMITTED before the effect, the account is re-resolved at the mutation boundary, and NO_CHANGES skips', () => {
  withRelease((p, asm, manifest) => {
    const order = [];
    let stsCalls = 0;
    const describes = fullDescribes({
      [PILOT_STACK_NAMES[1]]: { Status: 'FAILED', StatusReason: "The submitted information didn't contain changes." },
    });
    const run = cloudRun({
      describes,
      onCall: (args) => {
        if (args[0] === 'sts' && args[1] === 'get-caller-identity') {
          stsCalls += 1;
          return { status: 0, stdout: JSON.stringify({ Account: ACCOUNT }), stderr: '' };
        }
        if (args[1] === 'execute-change-set') order.push(`execute:${args[args.indexOf('--change-set-name') + 1]}`);
        return null;
      },
    });
    const r = runDeployRelease(releaseArgs(p, asm), deployOpts(manifest, {
      run,
      env: { CBA_CLOUD_GATE: gateFor(manifest, { planDigest: digestOf(describes) }) },
      print: (text) => order.push('print'),
    }));
    assert.equal(r.exit, 0, r.output);
    // Review material exists BEFORE the mutation it authorizes; the NO_CHANGES stack never executes.
    assert.deepEqual(order, ['print', `execute:${CS_ARN('cba-study-coach-pilot-identity')}`, `execute:${CS_ARN('cba-study-coach-pilot-api')}`, `execute:${CS_ARN('cba-study-coach-pilot-observability')}`]);
    assert.equal(stsCalls, 3, 'identity at verification, immediately after, and at the mutation boundary — account FIRST, clock LAST');
  });
});

test('a reviewed plan that no longer EXISTS refuses — expired or deleted change sets are not re-prepared', () => {
  withRelease((p, asm, manifest) => {
    const describes = fullDescribes();
    delete describes[PILOT_STACK_NAMES[2]]; // the ApiStack change set vanished
    const run = cloudRun({ describes });
    const r = runDeployRelease(releaseArgs(p, asm), deployOpts(manifest, { run }));
    assert.equal(r.exit, 1);
    assert.match(r.output, /CHANGE_SET_MISSING/);
    assert.equal(run.of('execute-change-set').length, 0, 'deploy mode NEVER creates change sets — that is plan_only, under review');
  });
});

test('ROUND-5: the gate names a REVIEWED plan group — waves for a fresh tier, and nothing else', () => {
  withRelease((p, asm, manifest) => {
    // Wave 1 (Identity + Data): prepare, describe, digest and execute EXACTLY those two stacks —
    // this is how a fresh tier deploys, wave by wave, each under its own gate, because a change
    // set whose Fn::ImportValue producers are unexecuted cannot even be created.
    const wave1 = ['IdentityStack', 'DataStack'];
    const wave1Names = PILOT_STACK_NAMES.slice(0, 2);
    const wave1Digest = planDigestOf(wave1.map((id, i) => canonicalChangeSet(id, wave1Names[i], fullDescribes()[wave1Names[i]])));
    const prepares = [];
    const run = cloudRun();
    const r = runDeployRelease(releaseArgs(p, asm), {
      run,
      git: happyGit(),
      cdkJsonPath: CDK_JSON,
      env: { CBA_CLOUD_GATE: gateFor(manifest, { mode: 'plan_only', planDigest: null, stacks: wave1 }) },
      now: () => GATE_NOW,
      sleep: () => {},
      exec: (args) => { prepares.push(args); return { status: 0, stdout: '', stderr: '' }; },
    });
    assert.equal(r.exit, 0, r.output);
    assert.deepEqual(prepares[0].slice(5, 8), ['--exclusively', 'IdentityStack', 'DataStack'], 'the prepare covers the WAVE, nothing more');
    assert.equal(run.of('describe-change-set').length, 2, 'only the wave is described');
    assert.match(r.output, new RegExp(`PLAN_DIGEST ${wave1Digest}`), 'the digest covers exactly the wave');

    // And a deploy-mode gate for that wave executes exactly those two change sets.
    const run2 = cloudRun();
    const r2 = runDeployRelease(releaseArgs(p, asm), deployOpts(manifest, {
      run: run2,
      env: { CBA_CLOUD_GATE: gateFor(manifest, { stacks: wave1, planDigest: wave1Digest }) },
    }));
    assert.equal(r2.exit, 0, r2.output);
    assert.deepEqual(
      run2.of('execute-change-set').map((c) => c.args[c.args.indexOf('--change-set-name') + 1]),
      wave1Names.map(CS_ARN),
    );

    // Anything outside the closed group list authorizes nothing: a lone consumer stack, a
    // foundation smuggle, a reordered full set, an empty set.
    for (const [label, stacks] of [
      ['a lone producer subset', ['DataStack']],
      ['a foundation smuggle', ['SecurityStack', 'ApiStack']],
      ['a reordered full set', ['ObservabilityStack', 'ApiStack', 'DataStack', 'IdentityStack']],
      ['an empty set', []],
      ['a non-array', 'IdentityStack'],
    ]) {
      const bad = runDeployRelease(releaseArgs(p, asm), deployOpts(manifest, {
        run: cloudRun(),
        env: { CBA_CLOUD_GATE: gateFor(manifest, { mode: 'plan_only', planDigest: null, stacks }) },
        exec: () => assert.fail(`${label} must never reach a prepare`),
      }));
      assert.equal(bad.exit, 1, label);
      assert.match(bad.output, /CLOUD_GATE_STACKS_INVALID/, label);
    }
  });
});

test('ROUND-5: an UNAVAILABLE change set never receives a reviewable digest — in either mode', () => {
  withRelease((p, asm, manifest) => {
    const describes = fullDescribes({
      [PILOT_STACK_NAMES[2]]: { ExecutionStatus: 'OBSOLETE' },
    });
    // plan_only refuses: an obsolete set must be re-prepared, not put on the record.
    const planned = runDeployRelease(releaseArgs(p, asm), {
      run: cloudRun({ describes }),
      git: happyGit(),
      cdkJsonPath: CDK_JSON,
      env: { CBA_CLOUD_GATE: gateFor(manifest, { mode: 'plan_only', planDigest: null }) },
      now: () => GATE_NOW,
      sleep: () => {},
      exec: happyExec,
    });
    assert.equal(planned.exit, 1);
    assert.match(planned.output, /CHANGE_SET_UNAVAILABLE/);
    assert.equal(planned.output.includes('PLAN_DIGEST'), false, 'no digest may exist for an unexecutable plan');
    // deploy refuses BEFORE the digest comparison could even bless it.
    const run = cloudRun({ describes });
    const deployed = runDeployRelease(releaseArgs(p, asm), deployOpts(manifest, { run, env: { CBA_CLOUD_GATE: gateFor(manifest, { planDigest: digestOf(describes) }) } }));
    assert.equal(deployed.exit, 1);
    assert.match(deployed.output, /CHANGE_SET_UNAVAILABLE/);
    assert.equal(run.of('execute-change-set').length, 0);
  });
});

test('ROUND-5: property values are RETRIEVED and the semantics render reviewably', () => {
  withRelease((p, asm, manifest) => {
    const describes = fullDescribes({
      [PILOT_STACK_NAMES[0]]: {
        Changes: [{
          Type: 'Resource',
          ResourceChange: {
            Action: 'Modify',
            LogicalResourceId: 'BffFunction',
            ResourceType: 'AWS::Lambda::Function',
            Replacement: 'False',
            Details: [{ Target: { Attribute: 'Properties', Name: 'MemorySize', RequiresRecreation: 'Never', BeforeValue: '512', AfterValue: '1024' } }],
          },
        }],
      },
    });
    const run = cloudRun({ describes });
    const r = runDeployRelease(releaseArgs(p, asm), {
      run,
      git: happyGit(),
      cdkJsonPath: CDK_JSON,
      env: { CBA_CLOUD_GATE: gateFor(manifest, { mode: 'plan_only', planDigest: null }) },
      now: () => GATE_NOW,
      sleep: () => {},
      exec: happyExec,
    });
    assert.equal(r.exit, 0, r.output);
    // The describes asked CloudFormation for the property values — without the flag there is
    // nothing semantic to review, only an opaque change-set id.
    for (const call of run.of('describe-change-set')) {
      assert.ok(call.args.includes('--include-property-values'), 'property values must be retrieved');
    }
    assert.match(r.output, /Properties\.MemorySize/, 'the changed property is named');
    // Round 13: BeforeValue/AfterValue are content, and a deterministic marker over content is an
    // offline guessing oracle. The DELTA is computed in memory and stated as a flag; both values
    // render as the same constant redaction, so nothing derived from them is published.
    assert.match(r.output, /value: changed \(before \[redacted\], after \[redacted\]\)/, 'the delta is stated without publishing the values');
  });
});

test('ROUND-7: endpoint identities are classifiable — the expected origin and an attacker origin read in clear', () => {
  const { fingerprintSanitize } = require('../bin/deploy-release');
  // The first label of a workers.dev host IS the decision Zamp reviews (the approved pilot
  // origin, the Cognito callbacks, CORS). Both origins must read VERBATIM — visibly different
  // identities, not two opaque hashes reproducing the round-5 defect for endpoints.
  const expected = fingerprintSanitize('CallbackURLs: https://cba-study-coach-pilot.workers.dev/auth/callback');
  const attacker = fingerprintSanitize('CallbackURLs: https://evil.workers.dev/auth/callback');
  assert.match(expected, /https:\/\/cba-study-coach-pilot\.workers\.dev\/auth\/callback/, 'the EXPECTED origin reads in clear');
  assert.match(attacker, /https:\/\/evil\.workers\.dev\/auth\/callback/, 'an ATTACKER origin is exposed in clear — classifiable at sight');
  assert.notEqual(expected, attacker);
  // The project-chosen Cognito auth domain is decision-bearing too.
  assert.match(
    fingerprintSanitize('https://cba-study-coach-dev.auth.us-east-1.amazoncognito.com/login'),
    /cba-study-coach-dev\.auth\.us-east-1\.amazoncognito\.com/,
  );
  // A hostname NO reviewed decision produced is visibly classifiable as unexpected — never
  // rendered verbatim (it may itself be an exfiltration vector), never silently hash-blended.
  const unknown = fingerprintSanitize('https://exfil.attacker.example/collect');
  assert.match(unknown, /\[unexpected-host-redacted\]/);
  assert.equal(unknown.includes('attacker.example'), false);
  // Generated execute-api labels stay pseudonymized — the service domain stays legible.
  const api = fingerprintSanitize('https://ab12cd34.execute-api.us-east-1.amazonaws.com/prod');
  assert.equal(api.includes('ab12cd34'), false);
  assert.match(api, /\[api-id-redacted\]\.execute-api\.us-east-1\.amazonaws\.com\/prod/);
});

test('ROUND-7: generated identifiers and query values never render — names this project chose always do', () => {
  const { fingerprintSanitize } = require('../bin/deploy-release');
  // KMS key UUIDs are generated, not repository-public.
  const kms = fingerprintSanitize(`arn:aws:kms:us-east-1:${ACCOUNT}:key/12345678-1234-1234-1234-1234567890ab`);
  assert.equal(kms.includes('12345678-1234-1234-1234-1234567890ab'), false, 'a key UUID must never render');
  assert.match(kms, /key\/\[key-id-redacted\]/);
  // API Gateway api ids are generated.
  const api = fingerprintSanitize('arn:aws:apigateway:us-east-1::/apis/a1b2c3d4/routes/xyz9876');
  assert.equal(api.includes('a1b2c3d4'), false, 'an api id must never render');
  assert.equal(api.includes('xyz9876'), false, 'a route id must never render');
  // CloudFormation stack ids are generated; the stack NAME is project-chosen and must stay.
  const cfn = fingerprintSanitize(`arn:aws:cloudformation:us-east-1:${ACCOUNT}:stack/cba-study-coach-dev-api/deadbeef-1234-1234-1234-abcdefabcdef`);
  assert.equal(cfn.includes('deadbeef-1234-1234-1234-abcdefabcdef'), false, 'a stack id must never render');
  assert.match(cfn, /stack\/cba-study-coach-dev-api\/\[id-redacted\]/, 'the project-chosen stack name stays classifiable');
  // URL query values carry tokens — stripped, with the stripping visible. (Round 9 also
  // pseudonymizes the unreviewed /reset path: secrets ride path segments as easily.)
  const url = fingerprintSanitize('https://x.workers.dev/reset?token=secret-value');
  assert.equal(url.includes('secret-value'), false, 'a query token must never render');
  assert.match(url, /\/\[path-redacted\]\?\[query-redacted\]/);
  // A free-standing UUID (outside any ARN) is generated material too.
  assert.equal(fingerprintSanitize('key id 12345678-1234-1234-1234-1234567890ab').includes('1234567890ab'), false);
  // And an UNKNOWN service's resource is pseudonymized whole — unknown is not proven public.
  const foreign = fingerprintSanitize(`arn:aws:someservice:us-east-1:${ACCOUNT}:widget/private-name`);
  assert.equal(foreign.includes('private-name'), false);
  assert.match(foreign, /\[resource-redacted\]/);
  // IAM role paths remain verbatim — that is the round-6 contract, unchanged.
  assert.match(fingerprintSanitize(`arn:aws:iam::${ACCOUNT}:role/evil-admin`), /role\/evil-admin/);
});

test('ROUND-8: no suffix allowlist — service membership proves nothing, format rules decide', () => {
  const { fingerprintSanitize } = require('../bin/deploy-release');
  // The exact round-8 reproductions, in order. A bucket-style or ELB-style amazonaws host is
  // not proven public by its suffix — outside the exact reviewed families, hosts are unexpected.
  const bucketHost = fingerprintSanitize('https://secret-bucket.s3.us-east-1.amazonaws.com/obj');
  assert.equal(bucketHost.includes('secret-bucket'), false, 'a bucket-style host must never render');
  assert.match(bucketHost, /\[unexpected-host-redacted\]/);
  const elbHost = fingerprintSanitize('https://generated-id.elb.us-east-1.amazonaws.com/health');
  assert.equal(elbHost.includes('generated-id'), false, 'an ELB-style host must never render');
  // S3 object keys are content hashes and internal paths — never public, whoever owns the
  // bucket; foreign bucket NAMES are not public either. The project asset bucket stays legible.
  const foreignObject = fingerprintSanitize('arn:aws:s3:::private-bucket/asset-secret-hash');
  assert.equal(foreignObject.includes('private-bucket'), false);
  assert.equal(foreignObject.includes('asset-secret-hash'), false);
  assert.match(foreignObject, /\[bucket-redacted\]\/\[object-key-redacted\]/);
  const ownAsset = fingerprintSanitize(`arn:aws:s3:::cdk-cbardev-assets-${ACCOUNT}-us-east-1/abc123hash.zip`);
  assert.match(ownAsset, /cdk-cbardev-assets-\[account-redacted\]-us-east-1/, 'the project asset bucket stays classifiable');
  assert.equal(ownAsset.includes(ACCOUNT), false, 'the account inside it does not');
  assert.equal(ownAsset.includes('abc123hash'), false, 'object keys never render, even ours');
  // SSM parameter paths are not public by default — exactly the bootstrap-version parameters are.
  const privateParam = fingerprintSanitize(`arn:aws:ssm:us-east-1:${ACCOUNT}:parameter/prod/private/name`);
  assert.equal(privateParam.includes('prod/private/name'), false, 'a parameter path must never render');
  assert.match(
    fingerprintSanitize(`arn:aws:ssm:us-east-1:${ACCOUNT}:parameter/cdk-bootstrap/cbardev/version`),
    /parameter\/cdk-bootstrap\/cbardev\/version/,
    'the reviewed bootstrap parameter stays legible',
  );
  // STS: the ROLE path is principal material and stays; the caller-chosen session never renders.
  const sts = fingerprintSanitize(`arn:aws:sts::${ACCOUNT}:assumed-role/cba-study-coach-gha-deploy-dev/covert-session-name`);
  assert.match(sts, /assumed-role\/cba-study-coach-gha-deploy-dev\/\[session-redacted\]/);
  assert.equal(sts.includes('covert-session-name'), false);
  // Data-plane services: project-named resources stay; anything else pseudonymizes whole.
  assert.match(fingerprintSanitize(`arn:aws:lambda:us-east-1:${ACCOUNT}:function:cba-study-coach-dev-bff`), /function:cba-study-coach-dev-bff/);
  assert.equal(fingerprintSanitize(`arn:aws:lambda:us-east-1:${ACCOUNT}:function:foreign-fn`).includes('foreign-fn'), false);
});

test('ROUND-8: URLs go through the STRUCTURED parser — credentials, IPv6 and ports cannot ride past it', () => {
  const { fingerprintSanitize } = require('../bin/deploy-release');
  // Userinfo: credentials NEVER appear — the whole URL becomes a classifiable marker.
  const credentialed = fingerprintSanitize('https://user:supersecret@evil.example/collect');
  assert.equal(credentialed.includes('supersecret'), false, 'a password must never render');
  assert.equal(credentialed.includes('evil.example'), false);
  assert.match(credentialed, /\[credentialed-url-redacted\]/);
  // IPv6 literal with a token: the ad hoc regex never matched it and printed everything.
  const ipv6 = fingerprintSanitize('https://[2001:db8::1]/?token=secret');
  assert.equal(ipv6.includes('secret'), false, 'the token must never render');
  assert.equal(ipv6.includes('2001:db8'), false, 'an IP-literal host is not decision-bearing');
  assert.match(ipv6, /\[unexpected-host-redacted\]\/\?\[query-redacted\]/);
  // Ports survive as structure; query still strips; the decision-bearing host stays — and the
  // round-9 contract pseudonymizes the unreviewed path too: secrets ride path segments.
  assert.match(fingerprintSanitize('https://x.workers.dev:8443/reset?token=s'), /https:\/\/x\.workers\.dev:8443\/\[path-redacted\]\?\[query-redacted\]/);
  // Fragments are query-class material.
  assert.match(fingerprintSanitize('https://x.workers.dev/page#access_token=abc'), /\?\[query-redacted\]/);
  assert.equal(fingerprintSanitize('https://x.workers.dev/page#access_token=abc').includes('access_token'), false);
});

test('ROUND-9: values are classified as FIELDS — no outer scanner decides what the parsers see', () => {
  const { fingerprintSanitize } = require('../bin/deploy-release');
  // 1. Any scheme reaches the classifier: the round-8 scanner recognized only http(s), and a
  // postgres URL with credentials sailed past it whole.
  const pg = fingerprintSanitize('postgres://user:supersecret@db.internal/cba');
  assert.equal(pg.includes('supersecret'), false, 'credentials in a non-http URL must never render');
  assert.equal(pg.includes('db.internal'), false);
  assert.match(pg, /\[credentialed-url-redacted\]/);
  // 2. A backslash cannot cut the candidate and strand the query outside it: the token goes to
  // the WHATWG parser whole (which treats \ as / in special schemes) — the token never renders.
  const backslash = fingerprintSanitize('https://evil.example\\?token=supersecret');
  assert.equal(backslash.includes('supersecret'), false, 'a backslash-smuggled query must never render');
  // 3-4. Paths are DATA unless a reviewed decision produces that exact shape — under an
  // unexpected host AND under the approved workers.dev origin alike.
  const foreignPath = fingerprintSanitize('https://evil.example/reset/supersecret-token');
  assert.equal(foreignPath.includes('supersecret-token'), false, 'a path secret must never render');
  const ownPath = fingerprintSanitize('https://cba-study-coach-pilot.workers.dev/reset/supersecret-token');
  assert.equal(ownPath.includes('supersecret-token'), false, 'an approved host does not bless an unreviewed path');
  assert.match(ownPath, /https:\/\/cba-study-coach-pilot\.workers\.dev\/\[path-redacted\]/, 'the host stays classifiable; the path does not leak');
  // The reviewed shapes still read in clear.
  assert.match(fingerprintSanitize('https://cba-study-coach-pilot.workers.dev/auth/callback'), /\/auth\/callback$/);
});

test('ROUND-9: anchored per-service grammars — one project-named segment never blesses the rest', () => {
  const { fingerprintSanitize } = require('../bin/deploy-release');
  // 5. A Lambda ALIAS is caller-chosen data riding behind the project-named function.
  const lambda = fingerprintSanitize(`arn:aws:lambda:us-east-1:${ACCOUNT}:function:cba-study-coach-dev-bff:covert-alias`);
  assert.equal(lambda.includes('covert-alias'), false, 'a lambda alias must never render');
  assert.match(lambda, /function:cba-study-coach-dev-bff:\[qualifier-redacted\]/, 'the project-owned identity segment stays');
  // 6. A LOG STREAM is generated material behind the project-named group.
  const logs = fingerprintSanitize(`arn:aws:logs:us-east-1:${ACCOUNT}:log-group:/aws/lambda/cba-study-coach-dev-bff:log-stream:generated-secret-stream`);
  assert.equal(logs.includes('generated-secret-stream'), false, 'a log stream must never render');
  assert.match(logs, /log-group:\/aws\/lambda\/cba-study-coach-dev-bff:log-stream:\[stream-redacted\]/);
  // 7. A Cognito GROUP behind the pool id is unreviewed trailing material.
  const cognito = fingerprintSanitize(`arn:aws:cognito-idp:us-east-1:${ACCOUNT}:userpool/us-east-1_ABCdef123/group/covert-group`);
  assert.equal(cognito.includes('covert-group'), false, 'a cognito group must never render');
  assert.match(cognito, /userpool\/us-east-1_\[pool-id-redacted\]\/\[path-redacted\]/);
  // 8. An API Gateway V1 path is outside the reviewed v2 grammar — the whole resource fails
  // closed, exactly like every known-service branch whose complete shape does not match.
  const v1 = fingerprintSanitize('arn:aws:apigateway:us-east-1::/restapis/abc123/deployments/xyz');
  assert.equal(v1.includes('restapis'), false, 'a v1 path is not proven public');
  assert.match(v1, /\[resource-redacted\]/);
  // Fail-closed inside known services: a cognito shape the grammar does not recognize, and a
  // foreign lambda resource, each pseudonymize WHOLE — never return the original.
  const badPool = fingerprintSanitize(`arn:aws:cognito-idp:us-east-1:${ACCOUNT}:identityprovider/covert-idp`);
  assert.equal(badPool.includes('covert-idp'), false);
  const badLambda = fingerprintSanitize(`arn:aws:lambda:us-east-1:${ACCOUNT}:layer:covert-layer:3`);
  assert.equal(badLambda.includes('covert-layer'), false);
  // The account embedded in a verbatim-blessed segment still pseudonymizes: residual passes run
  // over classifier output too.
  const bucket = fingerprintSanitize(`arn:aws:s3:::cdk-cbardev-assets-${ACCOUNT}-us-east-1/key.zip`);
  assert.equal(bucket.includes(ACCOUNT), false, 'the account inside a bucket name must never render');
  assert.match(bucket, /cdk-cbardev-assets-\[account-redacted\]-us-east-1\/\[object-key-redacted\]/);
});

test('ROUND-10: renderPlan carries the COMPLETE change — destructive policy is visible, no field selected away', () => {
  const { renderPlan } = require('../bin/deploy-release');
  const withPolicy = (policyAction) => [canonicalChangeSet('DataStack', PILOT_STACK_NAMES[1], describedFor(PILOT_STACK_NAMES[1], {
    Changes: [{
      Type: 'Resource',
      ResourceChange: {
        Action: 'Modify',
        PolicyAction: policyAction,
        Scope: ['Properties'],
        LogicalResourceId: 'Table',
        PhysicalResourceId: 'cba-study-coach-pilot-simulation',
        ResourceType: 'AWS::DynamoDB::Table',
        ChangeSetId: `arn:aws:cloudformation:us-east-1:${ACCOUNT}:changeSet/cba-70-abcdef123456/11111111-2222-3333-4444-555555555555`,
        ModuleInfo: { TypeHierarchy: 'AWS::Module', LogicalIdHierarchy: 'Mod' },
        Details: [{ Target: { Attribute: 'Properties', Name: 'BillingMode' }, Evaluation: 'Static', ChangeSource: 'DirectModification' }],
      },
    }],
  }))];
  // The exact round-10 reproduction: two plans differing ONLY in the destructive policy must
  // render differently, and each must NAME the policy it authorizes.
  const retain = renderPlan(withPolicy('Retain'));
  const del = renderPlan(withPolicy('Delete'));
  assert.notEqual(retain, del, 'a different destructive policy must change the review material');
  assert.match(retain, /\[policy: Retain\]/);
  assert.match(del, /\[policy: Delete\]/);
  // Every officially defined field the round-9 summary dropped now reaches the human, because
  // the WHOLE ResourceChange renders — no hand-picked subset to fall behind the API.
  for (const field of ['PolicyAction', 'Scope', 'PhysicalResourceId', 'ChangeSetId', 'ModuleInfo', 'Evaluation', 'ChangeSource', 'Details', 'LogicalResourceId', 'ResourceType']) {
    assert.ok(del.includes(field), `${field} must appear in the review material`);
  }
  assert.match(del, /full change set \(sanitized\)/);
  // ROUND 13 replaces the obsolete round-10 control: a field nobody reviewed no longer becomes
  // an opaque key the material carries — it REFUSES, and renderPlan says so by path, because an
  // unreviewed field can change what an approval means.
  const future = renderPlan([canonicalChangeSet('DataStack', PILOT_STACK_NAMES[1], describedFor(PILOT_STACK_NAMES[1], {
    Changes: [{ Type: 'Resource', ResourceChange: { Action: 'Add', LogicalResourceId: 'X', ResourceType: 'AWS::DynamoDB::Table', SomeFutureField: 'Retain' } }],
  }))]);
  assert.match(future, /NOT RENDERED/, 'an unreviewed field must refuse, never render');
  assert.match(future, /\$\.Changes\[0\]\.ResourceChange\.SomeFutureField: field is not in the reviewed schema/);
});

test('ROUND-10: strings fail CLOSED — serialized JSON, map keys and punctuation-wrapped values cannot leak', () => {
  const { renderPlan, fingerprintSanitize } = require('../bin/deploy-release');
  const SECRET = 'supersecret';
  const credentialed = `https://user:${SECRET}@evil.example/private`;
  const entries = [canonicalChangeSet('ApiStack', PILOT_STACK_NAMES[2], describedFor(PILOT_STACK_NAMES[2], {
    Changes: [{
      Type: 'Resource',
      ResourceChange: {
        Action: 'Modify',
        LogicalResourceId: 'Fn',
        ResourceType: 'AWS::Lambda::Function',
        Details: [{
          Target: {
            Attribute: 'Properties',
            Name: 'Environment',
            // BeforeValue/AfterValue are STRINGS in the AWS contract — a serialized object hides
            // structure from a value walker unless it is parsed and walked.
            BeforeValue: JSON.stringify({ endpoint: credentialed }),
            AfterValue: JSON.stringify({ [credentialed]: 'x' }),
          },
        }],
        // A sensitive URL used as a KEY, and one wrapped in punctuation inside a value.
        BeforeContext: JSON.stringify({ [credentialed]: { note: `endpoint=(${credentialed})` } }),
        AfterContext: `endpoint=(${credentialed})`,
      },
    }],
  }))];
  const rendered = renderPlan(entries);
  assert.equal(rendered.includes(SECRET), false, 'no secret may survive anywhere in the material');
  assert.equal(rendered.includes('evil.example'), false);
  // Rounds 12-13: a content carrier renders as ONE constant redaction — the credentialed URL,
  // the key it hid behind and the punctuation around it vanish together, and the redaction is
  // not derived from the value, so it cannot be tested offline against candidates.
  assert.match(rendered, /value: changed \(before \[redacted\], after \[redacted\]\)/);
  // Directly, too: as a bare value, as a key, and wrapped in punctuation.
  assert.equal(fingerprintSanitize(`endpoint=(${credentialed})`).includes(SECRET), false, 'punctuation must not hide a URL from the classifier');
  assert.equal(fingerprintSanitize(JSON.stringify({ [credentialed]: 1 })).includes(SECRET), false);
  // An unparseable context is not proven safe: it goes through the fail-closed scalar rules.
  assert.equal(fingerprintSanitize(`{"broken": "${credentialed}"`).includes(SECRET), false);
  // ROUND 13: an unknown scalar is a CONSTANT redaction. The round-10/11 markers were
  // sha256(prefix + value) — a published, deterministic derivation of the very value they hid,
  // testable offline against candidates. Two different unknown values now render IDENTICALLY;
  // where the human needs the delta, renderPlan states `changed` from the raw values in memory.
  const a = fingerprintSanitize('some-unknown-value');
  assert.equal(a, '[redacted]');
  assert.equal(a, fingerprintSanitize('other-unknown-value'), 'no derivation of a value is published');
  const { createHash } = require('node:crypto');
  const oracle = createHash('sha256').update('cba-pseudonym:supersecret', 'utf8').digest('hex').slice(0, 32);
  assert.equal(fingerprintSanitize('supersecret').includes(oracle), false, 'the reproduced oracle must not appear');
  // ROUND 11 retires the round-10 free-form allowance: in a FREE position nothing renders,
  // because a format proves nothing about content. The very same values read in clear when they
  // sit in their KNOWN FIELD and pass that field's validator — field, then value, never shape.
  const free = fingerprintSanitize('AWS::Lambda::Function Modify Retain 512 us-east-1 cba-study-coach-dev-bff');
  for (const word of ['AWS::Lambda::Function', 'Modify', 'Retain', '512', 'cba-study-coach-dev-bff']) {
    assert.equal(free.includes(word), false, `"${word}" must not render in a free position`);
  }
  const { sanitizeBySchema: bySchema, CHANGE_SET_SCHEMA } = require('../bin/deploy-release');
  const change = (rc) => bySchema({ Changes: [{ Type: 'Resource', ResourceChange: rc }] }, CHANGE_SET_SCHEMA).Changes[0].ResourceChange;
  assert.deepEqual(
    change({ Action: 'Modify', PolicyAction: 'Retain', ResourceType: 'AWS::Lambda::Function', LogicalResourceId: 'BffFunction' }),
    { Action: 'Modify', PolicyAction: 'Retain', ResourceType: 'AWS::Lambda::Function', LogicalResourceId: 'BffFunction' },
  );
  // And a value outside its position's vocabulary is a marker even in the right position.
  assert.match(change({ Action: 'Exfiltrate' }).Action, /^\[redacted\]$/);

  // ROUND 12 retires the round-10 walk: a parsed blob let its own internal NAMES claim schema
  // trust, so content carriers are opaque now — one deterministic marker for the whole value,
  // never parsed. Reading callback URLs out of a property value is no longer how origins are
  // reviewed: PREFLIGHT-1 validates the exact auth URLs and the manifest's contextDigest binds
  // them to the release, BEFORE any change set exists.
  const { sanitizeBySchema } = require('../bin/deploy-release');
  const target = { kind: 'object', fields: { BeforeValue: { kind: 'opaque' }, AfterValue: { kind: 'opaque' } } };
  const escapedApproved = '{"endpoint":"https:\\/\\/cba-study-coach-pilot.workers.dev\\/auth\\/callback"}';
  const opaqueApproved = sanitizeBySchema({ BeforeValue: escapedApproved }, target).BeforeValue;
  assert.match(opaqueApproved, /^\[redacted\]$/, 'a content carrier renders as one marker, never parsed');
  const escapedCredentialed = `{"endpoint":"https:\\/\\/user:${SECRET}@evil.example\\/x"}`;
  const opaqueSecret = sanitizeBySchema({ AfterValue: escapedCredentialed }, target).AfterValue;
  assert.equal(opaqueSecret.includes(SECRET), false);
  // ROUND 13: the two render IDENTICALLY, on purpose — a value-derived marker was an offline
  // guessing oracle. Whether the value moved is stated as a flag computed in memory instead.
  assert.equal(opaqueApproved, opaqueSecret, 'content carriers share one constant redaction');
});

test('ROUND-10: the CloudFormation ARN grammar is complete — an extra suffix fails closed', () => {
  const { fingerprintSanitize } = require('../bin/deploy-release');
  const uuid = '11111111-2222-3333-4444-555555555555';
  // The reviewed shape: stack/<project-chosen name>/<generated id>.
  const exact = fingerprintSanitize(`arn:aws:cloudformation:us-east-1:${ACCOUNT}:stack/cba-study-coach-dev-api/${uuid}`);
  assert.match(exact, /stack\/cba-study-coach-dev-api\/\[id-redacted\]/);
  // Round 10: anything trailing the id used to survive because the check merely looked for an
  // emitted [id# marker. The complete grammar refuses the whole resource instead.
  const suffixed = fingerprintSanitize(`arn:aws:cloudformation:us-east-1:${ACCOUNT}:stack/cba-study-coach-dev-api/${uuid}/covert-suffix`);
  assert.equal(suffixed.includes('covert-suffix'), false, 'a trailing segment must never render');
  assert.match(suffixed, /\[resource-redacted\]/);
  // A foreign stack name pseudonymizes; a nested-but-unsupported shape fails closed.
  assert.equal(fingerprintSanitize(`arn:aws:cloudformation:us-east-1:${ACCOUNT}:stack/foreign-stack/${uuid}`).includes('foreign-stack'), false);
  assert.match(fingerprintSanitize(`arn:aws:cloudformation:us-east-1:${ACCOUNT}:stackset/x/y/z`), /\[resource-redacted\]/);
});

test('ROUND-11: the change set\'s executable semantics are in the digest AND named in the material', () => {
  const { renderPlan } = require('../bin/deploy-release');
  const base = (over) => describedFor(PILOT_STACK_NAMES[1], {
    Parameters: [{ ParameterKey: 'AuthDomainPrefix', ParameterValue: 'super-secret-prefix' }],
    ...over,
  });
  // The exact round-11 reproduction: two plans whose ONLY difference lives outside `Changes`.
  const planA = base({ Capabilities: ['CAPABILITY_NAMED_IAM'], OnStackFailure: 'DELETE', NotificationARNs: [`arn:aws:sns:us-east-1:${ACCOUNT}:cba-study-coach-pilot-operational-alerts`], Tags: [{ Key: 'Project', Value: 'CBAStudyCoach' }] });
  const planB = base({ OnStackFailure: 'ROLLBACK', RollbackConfiguration: { MonitoringTimeInMinutes: 15, RollbackTriggers: [{ Arn: `arn:aws:cloudwatch:us-east-1:${ACCOUNT}:alarm:cba-study-coach-pilot-api-5xx`, Type: 'AWS::CloudWatch::Alarm' }] }, Tags: [{ Key: 'Project', Value: 'Other' }] });
  const entryA = canonicalChangeSet('DataStack', PILOT_STACK_NAMES[1], planA);
  const entryB = canonicalChangeSet('DataStack', PILOT_STACK_NAMES[1], planB);
  assert.notEqual(planDigestOf([entryA]), planDigestOf([entryB]), 'capabilities, failure behaviour, rollback and tags MUST bind the gate');
  const renderedA = renderPlan([entryA]);
  const renderedB = renderPlan([entryB]);
  assert.notEqual(renderedA, renderedB, 'and they must be visible to the human, not only to the digest');
  // Named explicitly — a reader must not have to infer DELETE-on-failure from a resource diff.
  assert.match(renderedA, /on-failure: DELETE/);
  assert.match(renderedA, /capabilities: CAPABILITY_NAMED_IAM/);
  assert.match(renderedB, /on-failure: ROLLBACK/);
  assert.match(renderedB, /rollback: monitoring 15 min/);
  assert.match(renderedA, /notifications: arn:aws:sns:[^\n]*cba-study-coach-pilot-operational-alerts/);
  assert.match(renderedB, /triggers .*alarm:cba-study-coach-pilot-api-5xx/);
  // Parameter NAMES are schema and read in clear; parameter VALUES are content and never do.
  assert.match(renderedA, /parameters: AuthDomainPrefix=\[redacted\]/);
  assert.equal(renderedA.includes('super-secret-prefix'), false);
  // Tag values are content too — the KEY is schema, the value is not.
  assert.equal(renderedA.includes('CBAStudyCoach'), false, 'a tag value is content, whatever it says');
  assert.match(renderedA, /tags: Project=\[redacted\]/);
});

test('ROUND-11: DescribeChangeSet pagination is consumed, or the plan refuses', () => {
  withRelease((p, asm, manifest) => {
    // A change set whose description spans three pages: every page's changes must reach the
    // plan, and the assembled body must carry no cursor.
    const pages = new Map();
    const run = cloudRun({
      onCall: (args) => {
        if (args[1] !== 'describe-change-set') return null;
        const stackName = args[args.indexOf('--stack-name') + 1];
        const token = args.includes('--next-token') ? args[args.indexOf('--next-token') + 1] : null;
        const seen = (pages.get(stackName) ?? 0) + 1;
        pages.set(stackName, seen);
        const body = describedFor(stackName, {
          Changes: [{ Type: 'Resource', ResourceChange: { Action: 'Modify', LogicalResourceId: `R${seen}`, ResourceType: 'AWS::DynamoDB::Table' } }],
        });
        if (token === null) return { status: 0, stdout: JSON.stringify({ ...body, NextToken: 'page2' }), stderr: '' };
        if (token === 'page2') return { status: 0, stdout: JSON.stringify({ ...body, NextToken: 'page3' }), stderr: '' };
        return { status: 0, stdout: JSON.stringify(body), stderr: '' };
      },
    });
    const r = runDeployRelease(releaseArgs(p, asm), {
      run,
      git: happyGit(),
      cdkJsonPath: CDK_JSON,
      env: { CBA_CLOUD_GATE: gateFor(manifest, { mode: 'plan_only', planDigest: null }) },
      now: () => GATE_NOW,
      sleep: () => {},
      exec: happyExec,
    });
    assert.equal(r.exit, 0, r.output);
    assert.equal(run.of('describe-change-set').length, 12, 'three pages per stack, four stacks');
    assert.match(r.output, /R1/);
    assert.match(r.output, /R3/, 'the LAST page reaches the material — a partial plan is not the plan');
    assert.equal(r.output.includes('NextToken'), false, 'no cursor survives into the reviewed body');
  });

  // A description that never stops paginating authorizes nothing.
  withRelease((p, asm, manifest) => {
    const run = cloudRun({
      onCall: (args) => {
        if (args[1] !== 'describe-change-set') return null;
        const stackName = args[args.indexOf('--stack-name') + 1];
        return { status: 0, stdout: JSON.stringify({ ...describedFor(stackName), NextToken: 'always-more' }), stderr: '' };
      },
    });
    const r = runDeployRelease(releaseArgs(p, asm), deployOpts(manifest, { run }));
    assert.equal(r.exit, 1);
    assert.match(r.output, /CHANGE_SET_PAGINATION_UNCONSUMED/);
    assert.equal(run.of('execute-change-set').length, 0);
  });
});

test('ROUND-11: the fail-open formats are closed — numbers, keys, identifiers, project prefixes', () => {
  const { fingerprintSanitize, sanitizeBySchema, CHANGE_SET_SCHEMA } = require('../bin/deploy-release');
  const walk = (v) => sanitizeBySchema(v, CHANGE_SET_SCHEMA);
  const rc = (r) => walk({ Changes: [{ Type: 'Resource', ResourceChange: r }] }).Changes[0].ResourceChange;
  // The five round-11 reproductions, each verbatim before.
  assert.match(fingerprintSanitize('111122223333'), /^\[redacted\]$/, 'an account id is a numeric string');
  assert.match(fingerprintSanitize('123456'), /^\[redacted\]$/, 'a numeric string proves nothing');
  assert.match(Object.keys(walk({ supersecret: 'x' }))[0], /^\[key-redacted\]$/, 'a key outside the position is content');
  assert.match(rc({ PhysicalResourceId: 'supersecret' }).PhysicalResourceId, /^\[redacted\]$/, 'a physical id is generated or arbitrary');
  // A physical id is pseudonymized WHOLE — including when it takes the shape of an ARN, which
  // the ARN grammar would otherwise render segment by segment. The field decides, not the shape:
  // CloudFormation fills this from the resource, and no grammar bound to it is worth the
  // assumption unless it is bound to the ResourceType as well.
  const arnPhysical = rc({ PhysicalResourceId: `arn:aws:sns:us-east-1:${ACCOUNT}:cba-study-coach-pilot-operational-alerts` }).PhysicalResourceId;
  assert.match(arnPhysical, /^\[redacted\]$/, 'an ARN-shaped physical id must not ride the ARN grammar');
  assert.equal(arnPhysical.includes('operational-alerts'), false);
  assert.match(fingerprintSanitize('cba-study-coach-supersecret'), /^\[redacted\]$/, 'our prefix does not bless an arbitrary suffix');
  // Only REAL JSON numbers stay numbers; the string form does not.
  assert.equal(walk({ Changes: [{ HookInvocationCount: 3 }] }).Changes[0].HookInvocationCount, 3);
  assert.match(walk({ Changes: [{ HookInvocationCount: '3' }] }).Changes[0].HookInvocationCount, /^\[redacted\]$/);
  // A stack name renders only when THIS deploy computed it — not because it looks like ours.
  assert.equal(walk({ StackName: PILOT_STACK_NAMES[0] }).StackName, PILOT_STACK_NAMES[0]);
  assert.match(walk({ StackName: 'cba-study-coach-pilot-impostor' }).StackName, /^\[redacted\]$/);
});

test('ROUND-12: parsed content cannot claim schema trust by naming itself', () => {
  const { renderPlan } = require('../bin/deploy-release');
  const SECRET = 'supersecret';
  // The exact round-12 reproduction: content carriers holding the very key names the schema
  // trusts SOMEWHERE — Key, Name, ParameterKey, LogicalResourceId, Arn. Position decides now,
  // and inside a content carrier there is no position to claim.
  const hostile = JSON.stringify({
    Key: SECRET,
    Name: SECRET,
    ParameterKey: SECRET,
    LogicalResourceId: SECRET,
    Arn: `arn:aws:iam::${ACCOUNT}:role/covert-admin`,
    Capabilities: ['CAPABILITY_NAMED_IAM'],
  });
  const entry = canonicalChangeSet('ApiStack', PILOT_STACK_NAMES[2], describedFor(PILOT_STACK_NAMES[2], {
    Changes: [{
      Type: 'Resource',
      ResourceChange: {
        Action: 'Modify',
        LogicalResourceId: 'Fn',
        ResourceType: 'AWS::Lambda::Function',
        BeforeContext: hostile,
        AfterContext: hostile,
        Details: [{ Target: { Attribute: 'Properties', Name: 'Environment', BeforeValue: hostile, AfterValue: hostile } }],
      },
    }],
  }));
  const rendered = renderPlan([entry]);
  assert.equal(rendered.includes(SECRET), false, 'a schema NAME inside content must not render its value');
  assert.equal(rendered.includes('covert-admin'), false, 'an internal Arn must not reach the ARN grammar');
  assert.equal(rendered.includes('CAPABILITY_NAMED_IAM'), false, 'nor may content claim the change set\'s own vocabulary');
  // Each carrier is ONE constant redaction — no parsing, so no internal name to trust, and no
  // derivation of the content to test offline.
  assert.match(rendered, /value: (un)?changed \(before \[redacted\], after \[redacted\]\)/);
  // The SAME names still read in clear at their real positions, so the material stays reviewable.
  assert.match(rendered, /Modify {2}AWS::Lambda::Function {2}Fn/);
  assert.match(rendered, /Properties\.Environment/);
});

test('ROUND-12: interpretation-changing fields are named — deployment mode and drift', () => {
  const { renderPlan } = require('../bin/deploy-release');
  const withMode = (over) => canonicalChangeSet('DataStack', PILOT_STACK_NAMES[1], describedFor(PILOT_STACK_NAMES[1], over));
  const revert = withMode({ DeploymentMode: 'REVERT_DRIFT', StackDriftStatus: 'DRIFTED' });
  const inSync = withMode({ StackDriftStatus: 'IN_SYNC' });
  assert.notEqual(planDigestOf([revert]), planDigestOf([inSync]), 'mode and drift bind the gate');
  const renderedRevert = renderPlan([revert]);
  assert.match(renderedRevert, /deployment-mode: REVERT_DRIFT/, 'REVERT_DRIFT must be distinguishable at sight');
  assert.match(renderedRevert, /drift: DRIFTED/);
  assert.match(renderPlan([inSync]), /deployment-mode: unspecified {3}drift: IN_SYNC/);
  // ROUND 13: `REVERT_DRIFT` is the ONLY documented value — the round-12 schema invented
  // `STANDARD`. A mode outside the contract REFUSES the plan; it is not rendered as a marker.
  const invented = renderPlan([withMode({ DeploymentMode: 'STANDARD' })]);
  assert.match(invented, /NOT RENDERED/);
  assert.match(invented, /\$\.DeploymentMode: value is outside the reviewed contract/);
});

test('ROUND-12: a field the reviewed schema does not describe REFUSES the plan', () => {
  withRelease((p, asm, manifest) => {
    // A service-level field nobody reviewed can change what an approval means. The lane stops
    // and a human extends the schema — it never becomes an opaque key the material hides.
    const describes = fullDescribes();
    describes[PILOT_STACK_NAMES[2]] = { ...describes[PILOT_STACK_NAMES[2]], SomeNewSemantic: 'REVERT_EVERYTHING' };
    const run = cloudRun({ describes });
    const r = runDeployRelease(releaseArgs(p, asm), deployOpts(manifest, { run }));
    assert.equal(r.exit, 1);
    assert.match(r.output, /CHANGE_SET_SCHEMA_UNKNOWN/);
    assert.equal(run.of('execute-change-set').length, 0, 'nothing executes under an unreviewed schema');
  });
  // The refusal reaches nested positions too — depth is not a hiding place.
  const { validateChangeSet } = require('../bin/deploy-release');
  assert.deepEqual(validateChangeSet(describedFor(PILOT_STACK_NAMES[0])), [], 'the reviewed shape passes');
  assert.deepEqual(
    validateChangeSet({ Changes: [{ Type: 'Resource', ResourceChange: { Action: 'Modify', Details: [{ Target: { Attribute: 'Properties', Sneaky: 'x' } }] } }] }),
    ['$.Changes[0].ResourceChange.Details[0].Target.Sneaky: field is not in the reviewed schema'],
  );
});

test('ROUND-12: child evidence FRAMES the streams — concatenation collisions are gone', () => {
  const { childEvidence } = require('../bin/deploy-release');
  // The exact reproduction: same concatenation, different streams.
  const a = childEvidence({ status: 1, stdout: 'ab', stderr: 'c' });
  const b = childEvidence({ status: 1, stdout: 'a', stderr: 'bc' });
  assert.notEqual(a, b, 'the stream boundary must be part of the evidence');
  // The DIGEST itself must carry the framing — not only the byte counts printed beside it, or a
  // reader comparing digests across runs would still see two different failures as one.
  const digestOf = (evidence) => evidence.match(/sha256=([0-9a-f]{64})/)[1];
  assert.notEqual(digestOf(a), digestOf(b), 'the digest must distinguish the streams, not just their sizes');
  // The framing is visible, not only digested — an operator correlates by stream sizes too.
  assert.match(a, /stdout=2B stderr=1B/);
  assert.match(b, /stdout=1B stderr=2B/);
  // And the exit code is framed as well: same bytes, different status, different digest.
  assert.notEqual(childEvidence({ status: 1, stdout: 'x', stderr: '' }), childEvidence({ status: 2, stdout: 'x', stderr: '' }));
});

/** A change set exercising EVERY member of the current DescribeChangeSet contract, drift-aware
 * ones included, transcribed from the CloudFormation API reference. It is the fixture that keeps
 * the reviewed schema honest: if the schema drifts from the documented API, this refuses. */
const FULL_API_DESCRIBE = (stackName) => ({
  ChangeSetName: 'cba-70-abcdef123456',
  ChangeSetId: `arn:aws:cloudformation:us-east-1:${ACCOUNT}:changeSet/cba-70-abcdef123456/11111111-2222-3333-4444-555555555555`,
  StackId: `arn:aws:cloudformation:us-east-1:${ACCOUNT}:stack/${stackName}/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee`,
  StackName: stackName,
  ParentChangeSetId: `arn:aws:cloudformation:us-east-1:${ACCOUNT}:changeSet/parent/22222222-3333-4444-5555-666666666666`,
  RootChangeSetId: `arn:aws:cloudformation:us-east-1:${ACCOUNT}:changeSet/root/33333333-4444-5555-6666-777777777777`,
  CreationTime: '2026-08-07T10:00:00.000000+00:00',
  Description: 'a description CloudFormation echoes back',
  Status: 'CREATE_COMPLETE',
  StatusReason: 'because',
  ExecutionStatus: 'AVAILABLE',
  OnStackFailure: 'ROLLBACK',
  Capabilities: ['CAPABILITY_IAM', 'CAPABILITY_NAMED_IAM', 'CAPABILITY_AUTO_EXPAND'],
  IncludeNestedStacks: true,
  ImportExistingResources: false,
  DeploymentMode: 'REVERT_DRIFT',
  StackDriftStatus: 'DRIFTED',
  NotificationARNs: [`arn:aws:sns:us-east-1:${ACCOUNT}:cba-study-coach-pilot-operational-alerts`],
  RollbackConfiguration: {
    MonitoringTimeInMinutes: 15,
    RollbackTriggers: [{ Arn: `arn:aws:cloudwatch:us-east-1:${ACCOUNT}:alarm:cba-study-coach-pilot-api-5xx`, Type: 'AWS::CloudWatch::Alarm' }],
  },
  Parameters: [{ ParameterKey: 'AuthDomainPrefix', ParameterValue: 'secret-value', UsePreviousValue: false, ResolvedValue: 'resolved-secret' }],
  Tags: [{ Key: 'Project', Value: 'CBAStudyCoach' }, { Key: 'aws:cloudformation:stack-name', Value: stackName }],
  Changes: [{
    Type: 'Resource',
    HookInvocationCount: 2,
    ResourceChange: {
      Action: 'SyncWithActual',
      PolicyAction: 'ReplaceAndSnapshot',
      LogicalResourceId: 'BffFunction',
      PhysicalResourceId: 'cba-study-coach-pilot-bff',
      ResourceType: 'AWS::Lambda::Function',
      Replacement: 'Conditional',
      Scope: ['Properties', 'Tags'],
      ChangeSetId: `arn:aws:cloudformation:us-east-1:${ACCOUNT}:changeSet/nested/44444444-5555-6666-7777-888888888888`,
      ModuleInfo: { TypeHierarchy: 'AWS::First::Example::MODULE', LogicalIdHierarchy: 'ModuleLogicalId' },
      BeforeContext: '{"Properties":{"MemorySize":512}}',
      AfterContext: '{"Properties":{"MemorySize":1024}}',
      PreviousDeploymentContext: '{"Properties":{"MemorySize":256}}',
      ResourceDriftStatus: 'MODIFIED',
      ResourceDriftIgnoredAttributes: [{ Path: '/Properties/WriteOnly', Reason: 'WRITE_ONLY_PROPERTY' }, { Path: '/Properties/Managed', Reason: 'MANAGED_BY_AWS' }],
      Details: [{
        Evaluation: 'Static',
        ChangeSource: 'NoModification',
        CausingEntity: `arn:aws:iam::${ACCOUNT}:role/cba-study-coach-gha-deploy-pilot`,
        Target: {
          Attribute: 'Properties',
          Name: 'MemorySize',
          RequiresRecreation: 'Conditionally',
          AttributeChangeType: 'SyncWithActual',
          Path: '/Properties/MemorySize',
          BeforeValue: '512',
          AfterValue: '1024',
          BeforeValueFrom: 'ACTUAL_STATE',
          AfterValueFrom: 'TEMPLATE',
          Drift: { ActualValue: '512', PreviousValue: '256', DriftDetectionTimestamp: '2026-08-07T09:00:00.000000+00:00' },
        },
      }],
    },
  }],
});

test('ROUND-13: the reviewed schema matches the documented API — a full drift-aware response validates and renders', () => {
  const { renderPlan, validateChangeSet } = require('../bin/deploy-release');
  const body = FULL_API_DESCRIBE(PILOT_STACK_NAMES[2]);
  assert.deepEqual(validateChangeSet(body), [], 'every documented member must be in the reviewed schema');
  const rendered = renderPlan([canonicalChangeSet('ApiStack', PILOT_STACK_NAMES[2], body)]);
  assert.equal(rendered.includes('NOT RENDERED'), false);
  // The drift-aware semantics are NAMED, not inferred.
  assert.match(rendered, /deployment-mode: REVERT_DRIFT {3}drift: DRIFTED/);
  assert.match(rendered, /SyncWithActual {2}AWS::Lambda::Function {2}BffFunction/);
  assert.match(rendered, /\[resource-drift: MODIFIED\]/);
  assert.match(rendered, /\[SyncWithActual\]/);
  assert.match(rendered, /before from ACTUAL_STATE, after from TEMPLATE/);
  assert.match(rendered, /drift: actual differs from previous deployment/);
  assert.match(rendered, /drift ignored: \[redacted\] \(WRITE_ONLY_PROPERTY\)/);
  assert.match(rendered, /value: changed \(before \[redacted\], after \[redacted\]\)/);
  // And content never rides along: parameter values, contexts and physical ids stay redacted.
  for (const secret of ['secret-value', 'resolved-secret', 'MemorySize":512', 'a description CloudFormation echoes back', 'because']) {
    assert.equal(rendered.includes(secret), false, `${secret} must not render`);
  }
});

test('ROUND-13: validation is structural — wrong types and out-of-contract enums refuse, not just unknown names', () => {
  const { validateChangeSet, renderPlan } = require('../bin/deploy-release');
  // The exact round-13 reproductions: both produced `unknown: []` before.
  assert.deepEqual(validateChangeSet({ Changes: 'not-an-array' }), ['$.Changes: expected a list']);
  assert.deepEqual(
    validateChangeSet({ Changes: [{ Type: 'Resource', ResourceChange: { Action: 'SOMETHING_NEW' } }] }),
    ['$.Changes[0].ResourceChange.Action: value is outside the reviewed contract'],
  );
  // Types are checked at every kind of position.
  assert.deepEqual(validateChangeSet({ IncludeNestedStacks: 'true' }), ['$.IncludeNestedStacks: value does not satisfy the boolean contract']);
  assert.deepEqual(validateChangeSet({ RollbackConfiguration: { MonitoringTimeInMinutes: '15' } }), ['$.RollbackConfiguration.MonitoringTimeInMinutes: value does not satisfy the integer contract']);
  assert.deepEqual(validateChangeSet({ RollbackConfiguration: [] }), ['$.RollbackConfiguration: expected an object']);
  assert.deepEqual(validateChangeSet({ CreationTime: 'yesterday' }), ['$.CreationTime: value does not satisfy the instant contract']);
  // A violation NEVER reports the value — only the path and the reason.
  assert.equal(validateChangeSet({ Description: 'x', StatusReason: 'y', Changes: [{ Type: 'NotAType' }] })[0].includes('NotAType'), false);

  // End to end: the plan refuses before any digest exists, and renderPlan refuses on its own.
  withRelease((p, asm, manifest) => {
    const describes = fullDescribes();
    describes[PILOT_STACK_NAMES[0]] = { ...describes[PILOT_STACK_NAMES[0]], Changes: 'not-an-array' };
    const run = cloudRun({ describes });
    const r = runDeployRelease(releaseArgs(p, asm), deployOpts(manifest, { run }));
    assert.equal(r.exit, 1);
    assert.match(r.output, /CHANGE_SET_SCHEMA_UNKNOWN/);
    assert.equal(run.of('execute-change-set').length, 0);
  });
  const rendered = renderPlan([canonicalChangeSet('DataStack', PILOT_STACK_NAMES[1], { ...describedFor(PILOT_STACK_NAMES[1]), Changes: 'not-an-array' })]);
  assert.match(rendered, /NOT RENDERED/, 'renderPlan validates what it is handed, it does not trust the caller');
  assert.match(rendered, /\$\.Changes: expected a list/);
});

test('ROUND-13: redaction is CONSTANT — no published derivation of any observed value', () => {
  const { fingerprintSanitize, renderPlan, REDACT } = require('../bin/deploy-release');
  const { createHash } = require('node:crypto');
  // The exact reproduction: the round-12 marker for `supersecret` was sha256("cba-pseudonym:…").
  const oracle = createHash('sha256').update('cba-pseudonym:supersecret', 'utf8').digest('hex').slice(0, 32);
  const body = describedFor(PILOT_STACK_NAMES[1], {
    Parameters: [{ ParameterKey: 'Secret', ParameterValue: 'supersecret' }],
    Tags: [{ Key: 'Project', Value: 'supersecret' }],
    Changes: [{ Type: 'Resource', ResourceChange: { Action: 'Modify', LogicalResourceId: 'T', ResourceType: 'AWS::DynamoDB::Table', PhysicalResourceId: 'supersecret', BeforeContext: 'supersecret' } }],
  });
  const rendered = renderPlan([canonicalChangeSet('DataStack', PILOT_STACK_NAMES[1], body)]);
  assert.equal(rendered.includes('supersecret'), false);
  assert.equal(rendered.includes(oracle), false, 'the reproduced oracle must not appear');
  // No hex-shaped token of ANY length that could be a derivation is emitted by the redactor.
  assert.equal(/#[0-9a-f]{8,}\]/.test(rendered), false, 'no value-derived marker may survive anywhere');
  // Every redaction is one of the reviewed CONSTANTS.
  for (const marker of rendered.match(/\[[a-z-]+\]/g) ?? []) {
    assert.ok(Object.values(REDACT).includes(marker), `${marker} must be a reviewed constant`);
  }
  // Two different secrets render identically — that IS the property: no candidate test exists.
  assert.equal(fingerprintSanitize('supersecret'), fingerprintSanitize('anothersecret'));
});

test('ROUND-14: null is a state, opaque is a string, integers carry their documented bounds', () => {
  const { validateChangeSet } = require('../bin/deploy-release');
  // The exact round-14 reproductions — every one produced `violations: []` before.
  assert.deepEqual(validateChangeSet({ Changes: null }), ['$.Changes: null is not a documented state for this field']);
  assert.deepEqual(
    validateChangeSet({ Changes: [{ Type: 'Resource', ResourceChange: { Action: null, Details: null } }] }),
    ['$.Changes[0].ResourceChange.Action: null is not a documented state for this field', '$.Changes[0].ResourceChange.Details: null is not a documented state for this field'],
  );
  assert.deepEqual(
    validateChangeSet({ Parameters: [{ ParameterKey: 'X', ParameterValue: { secret: 'x' } }] }),
    ['$.Parameters[0].ParameterValue: expected a scalar'],
    'an object smuggled where the contract says string is malformed, not deeper content',
  );
  assert.deepEqual(validateChangeSet({ RollbackConfiguration: { MonitoringTimeInMinutes: -1.5 } }), ['$.RollbackConfiguration.MonitoringTimeInMinutes: value does not satisfy the integer contract']);
  assert.deepEqual(validateChangeSet({ Changes: [{ Type: 'Resource', HookInvocationCount: 0.5 }] }), ['$.Changes[0].HookInvocationCount: value does not satisfy the integer contract']);
  // The documented bounds, exactly: 0..180 and 1..100; and non-string opaque forms all refuse.
  assert.equal(validateChangeSet({ RollbackConfiguration: { MonitoringTimeInMinutes: 181 } }).length, 1);
  assert.equal(validateChangeSet({ RollbackConfiguration: { MonitoringTimeInMinutes: 0 } }).length, 0);
  assert.equal(validateChangeSet({ Changes: [{ Type: 'Resource', HookInvocationCount: 0 }] }).length, 1);
  assert.equal(validateChangeSet({ Changes: [{ Type: 'Resource', HookInvocationCount: 100 }] }).length, 0);
  for (const bad of [42, true, ['x']]) {
    assert.equal(validateChangeSet({ Description: bad }).length, 1, `opaque must be a string, got ${JSON.stringify(bad)}`);
  }
  // The ONE documented nullable: HookInvocationCount ("is either null … or contains the number").
  assert.deepEqual(validateChangeSet({ Changes: [{ Type: 'Resource', HookInvocationCount: null }] }), []);

  // END TO END: a page whose Changes is null must refuse BEFORE the digest — the pagination
  // merge normalizes null into [], so the raw page is what carries the evidence.
  withRelease((p, asm, manifest) => {
    const run = cloudRun({
      onCall: (args) => {
        if (args[1] !== 'describe-change-set') return null;
        const stackName = args[args.indexOf('--stack-name') + 1];
        return { status: 0, stdout: JSON.stringify({ ...describedFor(stackName), Changes: null }), stderr: '' };
      },
    });
    const r = runDeployRelease(releaseArgs(p, asm), deployOpts(manifest, { run }));
    assert.equal(r.exit, 1);
    assert.match(r.output, /CHANGE_SET_SCHEMA_UNKNOWN/);
    assert.equal(r.output.includes('PLAN_DIGEST'), false, 'no digest may exist for a malformed response');
    assert.equal(run.of('execute-change-set').length, 0);
  });
});

/* ============================ ROUND 18: the FIRST live dev response ===========================
 * The first plan_only against the dev tier refused with CHANGE_SET_SCHEMA_UNKNOWN, and both
 * causes were real: six members arrive as an explicit `null`, and `DeploymentConfig` is a new,
 * SEMANTIC member. These tests are that response — not a paraphrase of it — plus the lane policy
 * that decides what a deployment configuration may say before any digest exists.
 */

/** The dev tier's ACTUAL DescribeChangeSet body, member for member, with the account and the
 * generated ids neutralized and nothing else changed. A fixture that "looked live" would prove
 * the lane works on a shape AWS never sends. */
const LIVE_DESCRIBE = (stackName, over = {}) => ({
  Changes: [
    { Type: 'Resource', ResourceChange: { Action: 'Add', LogicalResourceId: 'CDKMetadata', ResourceType: 'AWS::CDK::Metadata', Scope: [], Details: [] } },
    { Type: 'Resource', ResourceChange: { Action: 'Add', LogicalResourceId: 'StudyTable', ResourceType: 'AWS::DynamoDB::Table', Scope: [], Details: [] } },
  ],
  ChangeSetName: 'cba-70-abcdef123456',
  ChangeSetId: CS_ARN(stackName),
  StackId: `arn:aws:cloudformation:us-east-1:${ACCOUNT}:stack/${stackName}/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee`,
  StackName: stackName,
  Description: 'CDK Changeset for execution 04f1af7e-d012-436a-a40a-b22092899478',
  Parameters: [{ ParameterKey: 'BootstrapVersion', ParameterValue: '/cdk-bootstrap/cbardev/version', ResolvedValue: '32' }],
  CreationTime: '2026-08-20T12:56:47.555000+00:00',
  ExecutionStatus: 'AVAILABLE',
  Status: 'CREATE_COMPLETE',
  StatusReason: null,
  NotificationARNs: [],
  Capabilities: ['CAPABILITY_IAM', 'CAPABILITY_NAMED_IAM', 'CAPABILITY_AUTO_EXPAND'],
  Tags: [{ Key: 'Project', Value: 'CBAStudyCoach' }],
  ParentChangeSetId: null,
  IncludeNestedStacks: true,
  RootChangeSetId: null,
  OnStackFailure: null,
  ImportExistingResources: false,
  StackDriftStatus: null,
  DeploymentMode: null,
  DeploymentConfig: { Mode: 'STANDARD', DisableRollback: false },
  ...over,
});

/** The six positions the live tier answers with an explicit `null`. */
const LIVE_NULLS = ['StatusReason', 'ParentChangeSetId', 'RootChangeSetId', 'OnStackFailure', 'StackDriftStatus', 'DeploymentMode'];

test('ROUND-18: the LIVE response the refusal was collected from is what the reviewed schema describes', () => {
  const { validateChangeSet, deploymentConfigRefusal } = require('../bin/deploy-release');
  assert.deepEqual(validateChangeSet(LIVE_DESCRIBE(PILOT_STACK_NAMES[1])), [], 'the response AWS actually sent must pass, member for member');
  assert.equal(deploymentConfigRefusal(LIVE_DESCRIBE(PILOT_STACK_NAMES[1])), null, 'STANDARD with rollback enabled is what this lane approves');

  // The whole plan, end to end, on the live shape: it plans, it digests, and it renders.
  withRelease((p, asm, manifest) => {
    const describes = Object.fromEntries(PILOT_STACK_NAMES.map((n) => [n, LIVE_DESCRIBE(n)]));
    const run = cloudRun({ describes });
    const r = runDeployRelease(releaseArgs(p, asm), deployOpts(manifest, {
      run,
      env: { CBA_CLOUD_GATE: gateFor(manifest, { planDigest: digestOf(describes) }) },
    }));
    assert.equal(r.exit, 0, r.output);
    assert.equal(run.of('execute-change-set').length, 4, 'the reviewed plan executes');
  });
});

test('ROUND-18: each live null passes at its OWN position only — nullability is never global', () => {
  const { validateChangeSet } = require('../bin/deploy-release');
  for (const field of LIVE_NULLS) {
    assert.deepEqual(validateChangeSet({ [field]: null }), [], `${field} is documented nullable`);
  }
  // Every OTHER position still refuses an explicit null: the six are marked one by one, and a
  // seventh null is still a malformed response. `null` never became "absent" anywhere.
  const stillRefusing = [
    'ChangeSetName', 'ChangeSetId', 'StackId', 'StackName', 'CreationTime', 'Description', 'NextToken',
    'Status', 'ExecutionStatus', 'Capabilities', 'IncludeNestedStacks', 'ImportExistingResources',
    'NotificationARNs', 'RollbackConfiguration', 'Parameters', 'Tags', 'Changes', 'DeploymentConfig',
  ];
  for (const field of stillRefusing) {
    assert.deepEqual(validateChangeSet({ [field]: null }), [`$.${field}: null is not a documented state for this field`], `${field} must not accept null`);
  }
  assert.deepEqual(validateChangeSet({ DeploymentConfig: { Mode: null, DisableRollback: false } }), ['$.DeploymentConfig.Mode: null is not a documented state for this field']);
  assert.deepEqual(validateChangeSet({ DeploymentConfig: { Mode: 'STANDARD', DisableRollback: null } }), ['$.DeploymentConfig.DisableRollback: null is not a documented state for this field']);

  // A nullable position did NOT become a position that accepts anything: when it carries a
  // value, that value still has to satisfy the very same contract it had before.
  assert.deepEqual(validateChangeSet({ StatusReason: { note: 'x' } }), ['$.StatusReason: expected a scalar']);
  assert.deepEqual(validateChangeSet({ ParentChangeSetId: 'not-an-arn' }), ['$.ParentChangeSetId: value does not satisfy the arnReference contract']);
  assert.deepEqual(validateChangeSet({ RootChangeSetId: 'not-an-arn' }), ['$.RootChangeSetId: value does not satisfy the arnReference contract']);
  assert.deepEqual(validateChangeSet({ OnStackFailure: 'MAYBE' }), ['$.OnStackFailure: value is outside the reviewed contract']);
  assert.deepEqual(validateChangeSet({ StackDriftStatus: 'MOSTLY' }), ['$.StackDriftStatus: value is outside the reviewed contract']);
  // The round-12 invention: `STANDARD` is a DeploymentConfig.Mode, it is NOT a DeploymentMode.
  assert.deepEqual(validateChangeSet({ DeploymentMode: 'STANDARD' }), ['$.DeploymentMode: value is outside the reviewed contract']);
  assert.deepEqual(validateChangeSet({ DeploymentMode: 'REVERT_DRIFT' }), []);
});

test('ROUND-18: an explicit null and an absent member are DIFFERENT records and different digests', () => {
  const { entryDigestOf, canonicalChangeSet, renderPlan } = require('../bin/deploy-release');
  const name = PILOT_STACK_NAMES[1];
  for (const field of LIVE_NULLS) {
    const explicitNull = LIVE_DESCRIBE(name);
    const absent = LIVE_DESCRIBE(name);
    delete absent[field];
    const a = canonicalChangeSet('DataStack', name, explicitNull);
    const b = canonicalChangeSet('DataStack', name, absent);
    assert.notEqual(entryDigestOf(a), entryDigestOf(b), `${field}: null and absence must not collide in the digest`);
    assert.match(renderPlan([a]), new RegExp(`"${field}":null`), `${field}: the material must show the null it was sent`);
    assert.equal(renderPlan([b]).includes(`"${field}":`), false, `${field}: an absent member must not be materialized`);
  }
});

test('ROUND-18: DeploymentConfig is SEMANTIC — only STANDARD with rollback enabled is approvable', () => {
  const { deploymentConfigRefusal, DEPLOYMENT_CONFIG_ACCEPTED, validateChangeSet, canonicalChangeSet, entryDigestOf, renderPlan } = require('../bin/deploy-release');
  const name = PILOT_STACK_NAMES[1];
  assert.deepEqual(DEPLOYMENT_CONFIG_ACCEPTED, { Mode: 'STANDARD', DisableRollback: false });

  // STRUCTURE knows both documented modes — the schema describes what AWS may SEND.
  assert.deepEqual(validateChangeSet({ DeploymentConfig: { Mode: 'EXPRESS', DisableRollback: true } }), [], 'both are documented values, so neither is malformed');
  // POLICY accepts one of them — what this lane may APPROVE is narrower, and says so by name.
  assert.equal(deploymentConfigRefusal(LIVE_DESCRIBE(name)), null);
  assert.equal(deploymentConfigRefusal(LIVE_DESCRIBE(name, { DeploymentConfig: { Mode: 'EXPRESS', DisableRollback: false } })), 'CHANGE_SET_DEPLOYMENT_CONFIG_UNSUPPORTED');
  assert.equal(deploymentConfigRefusal(LIVE_DESCRIBE(name, { DeploymentConfig: { Mode: 'STANDARD', DisableRollback: true } })), 'CHANGE_SET_DEPLOYMENT_CONFIG_UNSUPPORTED');
  // ABSENCE is not innocence, at either level.
  const noConfig = LIVE_DESCRIBE(name);
  delete noConfig.DeploymentConfig;
  assert.equal(deploymentConfigRefusal(noConfig), 'CHANGE_SET_DEPLOYMENT_CONFIG_ABSENT');
  assert.equal(deploymentConfigRefusal(LIVE_DESCRIBE(name, { DeploymentConfig: { Mode: 'STANDARD' } })), 'CHANGE_SET_DEPLOYMENT_CONFIG_ABSENT');
  assert.equal(deploymentConfigRefusal(LIVE_DESCRIBE(name, { DeploymentConfig: { DisableRollback: false } })), 'CHANGE_SET_DEPLOYMENT_CONFIG_ABSENT');
  assert.equal(deploymentConfigRefusal({}), 'CHANGE_SET_DEPLOYMENT_CONFIG_ABSENT');
  assert.equal(deploymentConfigRefusal(null), 'CHANGE_SET_DEPLOYMENT_CONFIG_ABSENT');
  // A shape that is not an object at all is absent, never "something".
  for (const shape of [[], 'STANDARD', 7, true]) {
    assert.equal(deploymentConfigRefusal({ DeploymentConfig: shape }), 'CHANGE_SET_DEPLOYMENT_CONFIG_ABSENT', JSON.stringify(shape));
  }

  // The digest MOVES with both members — an approval names one deployment configuration.
  const digest = (over) => entryDigestOf(canonicalChangeSet('DataStack', name, LIVE_DESCRIBE(name, over)));
  const standard = digest({});
  const express = digest({ DeploymentConfig: { Mode: 'EXPRESS', DisableRollback: false } });
  const noRollback = digest({ DeploymentConfig: { Mode: 'STANDARD', DisableRollback: true } });
  assert.equal(new Set([standard, express, noRollback]).size, 3, 'three different authorizations, three different digests');

  // And a human READS both, on their own line, never folded into DeploymentMode above it.
  const rendering = (over) => renderPlan([canonicalChangeSet('DataStack', name, LIVE_DESCRIBE(name, over))]);
  assert.match(rendering({}), /deployment-config: mode STANDARD {3}rollback-on-failure enabled/);
  assert.match(rendering({ DeploymentConfig: { Mode: 'EXPRESS', DisableRollback: false } }), /deployment-config: mode EXPRESS {3}rollback-on-failure enabled/);
  assert.match(rendering({ DeploymentConfig: { Mode: 'STANDARD', DisableRollback: true } }), /deployment-config: mode STANDARD {3}rollback-on-failure DISABLED/);
  assert.match(rendering({}), /deployment-mode: unspecified/, 'the drift member keeps its own line and its own vocabulary');
});

test('ROUND-18: an unapprovable deployment configuration refuses BEFORE any digest exists', () => {
  const CASES = [
    ['EXPRESS mode', { Mode: 'EXPRESS', DisableRollback: false }, /CHANGE_SET_DEPLOYMENT_CONFIG_UNSUPPORTED/],
    ['rollback disabled', { Mode: 'STANDARD', DisableRollback: true }, /CHANGE_SET_DEPLOYMENT_CONFIG_UNSUPPORTED/],
    ['a property absent', { Mode: 'STANDARD' }, /CHANGE_SET_DEPLOYMENT_CONFIG_ABSENT/],
    // These two are MALFORMED, not merely unapprovable — a different fact, a different code.
    ['an undocumented mode', { Mode: 'TURBO', DisableRollback: false }, /CHANGE_SET_SCHEMA_UNKNOWN/],
    ['an extra key', { Mode: 'STANDARD', DisableRollback: false, Sneaky: 'x' }, /CHANGE_SET_SCHEMA_UNKNOWN/],
  ];
  for (const [label, config, expected] of CASES) {
    withRelease((p, asm, manifest) => {
      const describes = fullDescribes();
      describes[PILOT_STACK_NAMES[1]] = describedFor(PILOT_STACK_NAMES[1], { DeploymentConfig: config });
      const run = cloudRun({ describes });
      const r = runDeployRelease(releaseArgs(p, asm), deployOpts(manifest, { run }));
      assert.equal(r.exit, 1, label);
      assert.match(r.output, expected, label);
      assert.equal(r.output.includes('PLAN_DIGEST'), false, `${label}: no digest may exist for a plan this lane cannot approve`);
      assert.equal(run.of('execute-change-set').length, 0, label);
    });
  }
  // The member is absent entirely: the plan states no deployment configuration at all.
  withRelease((p, asm, manifest) => {
    const describes = fullDescribes();
    const stripped = describedFor(PILOT_STACK_NAMES[1]);
    delete stripped.DeploymentConfig;
    describes[PILOT_STACK_NAMES[1]] = stripped;
    const run = cloudRun({ describes });
    const r = runDeployRelease(releaseArgs(p, asm), deployOpts(manifest, { run }));
    assert.equal(r.exit, 1);
    assert.match(r.output, /CHANGE_SET_DEPLOYMENT_CONFIG_ABSENT/);
    assert.equal(run.of('execute-change-set').length, 0);
  });
});

test('ROUND-18: the deployment configuration is judged on EVERY page, not only the assembled body', () => {
  // Review F1 closed the merge for metadata at large, so a page that DISAGREES now refuses as
  // CHANGE_SET_PAGES_DIVERGE. This control is the other half and stays independent of it: pages
  // that agree perfectly on a configuration this lane will not approve are refused by the
  // POLICY, by name, on every page as well as on the body the merge produced.
  withRelease((p, asm, manifest) => {
    const pages = new Map();
    const run = cloudRun({
      onCall: (args) => {
        if (args[1] !== 'describe-change-set') return null;
        const stackName = args[args.indexOf('--stack-name') + 1];
        const seen = (pages.get(stackName) ?? 0) + 1;
        pages.set(stackName, seen);
        const body = describedFor(stackName, { DeploymentConfig: { Mode: 'EXPRESS', DisableRollback: false } });
        if (seen === 1) return { status: 0, stdout: JSON.stringify({ ...body, NextToken: 'page-2' }), stderr: '' };
        return { status: 0, stdout: JSON.stringify(body), stderr: '' };
      },
    });
    const r = runDeployRelease(releaseArgs(p, asm), deployOpts(manifest, { run }));
    assert.equal(r.exit, 1);
    assert.match(r.output, /CHANGE_SET_DEPLOYMENT_CONFIG_UNSUPPORTED/);
    assert.equal(r.output.includes('CHANGE_SET_PAGES_DIVERGE'), false, 'agreeing pages do not diverge — this is the policy speaking');
    assert.equal(r.output.includes('PLAN_DIGEST'), false);
    assert.equal(run.of('execute-change-set').length, 0);
  });
});

test('ROUND-18 (review F2): the execution policy binds APPROVAL and EXECUTION — never deletion', () => {
  // A deployment configuration this lane will not approve is still an exact, already-declined
  // plan. Refusing to DELETE it would strand an executable change set the moment the policy
  // tightened — the opposite of what the abandon lane exists to do. What still binds an abandon
  // is the closed schema and exact digest equality with the gate; nothing else is relaxed.
  const OUTSIDE_POLICY = { Mode: 'EXPRESS', DisableRollback: true };
  const declinedPlan = (config = OUTSIDE_POLICY) => {
    const describes = fullDescribes();
    describes[PILOT_STACK_NAMES[1]] = describedFor(PILOT_STACK_NAMES[1], { DeploymentConfig: config });
    return describes;
  };
  const abandonRun = (p, asm, manifest, artifact, describes, gateOver) => {
    const run = cloudRun({ describes, stackStatus: 'REVIEW_IN_PROGRESS' });
    const r = runDeployRelease([...releaseArgs(p, asm), '--artifact-out', artifact], {
      run,
      git: happyGit(),
      cdkJsonPath: CDK_JSON,
      env: { PATH: '/usr/bin', CORRELATION_ID: CORRELATION, DISPATCH_MODE: 'abandon', CBA_CLOUD_GATE: gateFor(manifest, { mode: 'abandon', ...gateOver }) },
      now: () => GATE_NOW,
      sleep: () => {},
      exec: () => assert.fail('abandon spawns no cdk child'),
    });
    return { r, run };
  };

  // A. Outside the execution policy, but the EXACT plan the gate names: it is deleted.
  withRelease((p, asm, manifest) => {
    withArtifact((artifact) => {
      const describes = declinedPlan();
      const { r, run } = abandonRun(p, asm, manifest, artifact, describes, { planDigest: digestOf(describes) });
      assert.equal(r.exit, 0, r.output);
      assert.equal(run.of('delete-change-set').length, 4, 'a declined plan is deletable whether or not it was approvable');
      assert.equal(run.of('execute-change-set').length, 0, 'an abandon executes nothing, ever');
      assert.equal(r.output.includes('CHANGE_SET_DEPLOYMENT_CONFIG'), false, 'the execution policy has no say here');
    });
  });

  // B. The same configuration, a digest that is not this plan's: PLAN_CHANGED, nothing deleted.
  withRelease((p, asm, manifest) => {
    withArtifact((artifact) => {
      const { r, run } = abandonRun(p, asm, manifest, artifact, declinedPlan(), { planDigest: digestOf(fullDescribes()) });
      assert.equal(r.exit, 1);
      assert.match(r.output, /PLAN_CHANGED/);
      assert.equal(run.of('delete-change-set').length, 0, 'a plan the gate does not name is never deleted');
    });
  });

  // C. The exemption is NARROW: the closed schema still binds an abandon, before any deletion.
  withRelease((p, asm, manifest) => {
    withArtifact((artifact) => {
      const describes = declinedPlan({ Mode: 'STANDARD', DisableRollback: false, Sneaky: 'x' });
      const { r, run } = abandonRun(p, asm, manifest, artifact, describes, { planDigest: digestOf(describes) });
      assert.equal(r.exit, 1);
      assert.match(r.output, /CHANGE_SET_SCHEMA_UNKNOWN/);
      assert.equal(run.of('delete-change-set').length, 0, 'a malformed description authorizes no deletion either');
    });
  });

  // D. And plan_only/deploy still refuse the very configuration abandon may delete.
  withRelease((p, asm, manifest) => {
    const describes = declinedPlan();
    const run = cloudRun({ describes });
    const r = runDeployRelease(releaseArgs(p, asm), deployOpts(manifest, { run, env: { CBA_CLOUD_GATE: gateFor(manifest, { planDigest: digestOf(describes) }) } }));
    assert.equal(r.exit, 1);
    assert.match(r.output, /CHANGE_SET_DEPLOYMENT_CONFIG_UNSUPPORTED/);
    assert.equal(run.of('execute-change-set').length, 0);
  });
});

test('ROUND-18 (review F1): pages that disagree about the change set describe no change set at all', () => {
  // The merge keeps every page's Changes but only the FIRST page's other members. A later page
  // that disagrees was read and then dropped — its semantics never reached the digest, the
  // rendering, or the human. Disagreement is now a named refusal, not a silent discard.
  const DIVERGENCES = [
    ['on-failure behaviour', { OnStackFailure: 'DELETE' }],
    ['a wider capability set', { Capabilities: ['CAPABILITY_NAMED_IAM'] }],
    ['another change set\'s identity', { ChangeSetId: CS_ARN(PILOT_STACK_NAMES[3]) }],
    ['a different stack', { StackId: `arn:aws:cloudformation:us-east-1:${ACCOUNT}:stack/${PILOT_STACK_NAMES[3]}/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee` }],
    ['drift state', { StackDriftStatus: 'DRIFTED' }],
    ['a deployment configuration', { DeploymentConfig: { Mode: 'EXPRESS', DisableRollback: true } }],
    ['nested-stack semantics', { IncludeNestedStacks: false }],
    ['a parameter set', { Parameters: [{ ParameterKey: 'BootstrapVersion', ParameterValue: '/cdk-bootstrap/other/version' }] }],
  ];
  for (const [label, divergence] of DIVERGENCES) {
    withRelease((p, asm, manifest) => {
      const pages = new Map();
      const run = cloudRun({
        onCall: (args) => {
          if (args[1] !== 'describe-change-set') return null;
          const stackName = args[args.indexOf('--stack-name') + 1];
          const seen = (pages.get(stackName) ?? 0) + 1;
          pages.set(stackName, seen);
          const first = { ...describedFor(stackName, { StatusReason: null }), NextToken: 'page-2' };
          if (seen === 1) return { status: 0, stdout: JSON.stringify(first), stderr: '' };
          return { status: 0, stdout: JSON.stringify(describedFor(stackName, { StatusReason: null, ...divergence })), stderr: '' };
        },
      });
      const r = runDeployRelease(releaseArgs(p, asm), deployOpts(manifest, {
        run,
        env: { CBA_CLOUD_GATE: gateFor(manifest, { mode: 'plan_only', planDigest: null }) },
        exec: happyExec,
      }));
      assert.equal(r.exit, 1, label);
      assert.match(r.output, /CHANGE_SET_PAGES_DIVERGE/, label);
      assert.equal(r.output.includes('PLAN_DIGEST'), false, `${label}: no digest may exist for a description that contradicts itself`);
      assert.equal(run.of('execute-change-set').length, 0, label);
    });
  }
});

test('ROUND-18 (review F1): page agreement distinguishes an absent member from an explicitly null one', () => {
  // Round 14 bought that distinction; the page comparison must not spend it. A page that omits
  // a member does NOT agree with a page that states it as null, and vice versa.
  for (const [label, firstPage, secondPage] of [
    ['null then absent', { StatusReason: null }, {}],
    ['absent then null', {}, { StatusReason: null }],
    ['null then absent, drift member', { DeploymentMode: null }, {}],
  ]) {
    withRelease((p, asm, manifest) => {
      const pages = new Map();
      const run = cloudRun({
        onCall: (args) => {
          if (args[1] !== 'describe-change-set') return null;
          const stackName = args[args.indexOf('--stack-name') + 1];
          const seen = (pages.get(stackName) ?? 0) + 1;
          pages.set(stackName, seen);
          const body = describedFor(stackName, seen === 1 ? firstPage : secondPage);
          return { status: 0, stdout: JSON.stringify(seen === 1 ? { ...body, NextToken: 'page-2' } : body), stderr: '' };
        },
      });
      const r = runDeployRelease(releaseArgs(p, asm), deployOpts(manifest, {
        run,
        env: { CBA_CLOUD_GATE: gateFor(manifest, { mode: 'plan_only', planDigest: null }) },
        exec: happyExec,
      }));
      assert.equal(r.exit, 1, label);
      assert.match(r.output, /CHANGE_SET_PAGES_DIVERGE/, label);
      assert.equal(run.of('execute-change-set').length, 0, label);
    });
  }
});

test('ROUND-18 (review F1): pages that AGREE still paginate — key order is not disagreement', () => {
  // The control that proves the check is not a blanket refusal of pagination: two pages whose
  // members are identical but serialized in a different order are the same description.
  withRelease((p, asm, manifest) => {
    const pages = new Map();
    const run = cloudRun({
      onCall: (args) => {
        if (args[1] !== 'describe-change-set') return null;
        const stackName = args[args.indexOf('--stack-name') + 1];
        const seen = (pages.get(stackName) ?? 0) + 1;
        pages.set(stackName, seen);
        const body = describedFor(stackName, {
          StatusReason: null,
          Changes: [{ Type: 'Resource', ResourceChange: { Action: 'Modify', LogicalResourceId: `R${seen}`, ResourceType: 'AWS::DynamoDB::Table' } }],
        });
        // Page two serializes the SAME members with the keys reversed.
        const reordered = Object.fromEntries(Object.entries(body).reverse());
        if (seen === 1) return { status: 0, stdout: JSON.stringify({ ...body, NextToken: 'page-2' }), stderr: '' };
        return { status: 0, stdout: JSON.stringify(reordered), stderr: '' };
      },
    });
    const r = runDeployRelease(releaseArgs(p, asm), deployOpts(manifest, {
      run,
      env: { CBA_CLOUD_GATE: gateFor(manifest, { mode: 'plan_only', planDigest: null }) },
      exec: happyExec,
    }));
    assert.equal(r.exit, 0, r.output);
    assert.match(r.output, /R1/);
    assert.match(r.output, /R2/, 'both pages\' changes reach the material');
  });
});

test('ROUND-14: ARN-typed fields demand strict ARNs — the permissive reference is only CausingEntity', () => {
  const { validateChangeSet, renderPlan } = require('../bin/deploy-release');
  // The exact round-14 reproduction: it validated AND published `supersecret` before.
  const repro = {
    Status: 'CREATE_COMPLETE',
    ExecutionStatus: 'AVAILABLE',
    Changes: [],
    ChangeSetId: 'supersecret',
    StackId: 'supersecret',
    NotificationARNs: ['supersecret'],
  };
  assert.deepEqual(validateChangeSet(repro), [
    '$.ChangeSetId: value does not satisfy the arnReference contract',
    '$.StackId: value does not satisfy the arnReference contract',
    '$.NotificationARNs[0]: value does not satisfy the arnReference contract',
  ]);
  // renderPlan refuses it on its own — the value never reaches the material.
  const rendered = renderPlan([canonicalChangeSet('DataStack', PILOT_STACK_NAMES[1], repro)]);
  assert.match(rendered, /NOT RENDERED/);
  assert.equal(rendered.includes('supersecret'), false);
  // Lineage and trigger ARNs are ARN-typed too.
  assert.equal(validateChangeSet({ ParentChangeSetId: 'not-an-arn' }).length, 1);
  assert.equal(validateChangeSet({ RollbackConfiguration: { RollbackTriggers: [{ Arn: 'not-an-arn', Type: 'AWS::CloudWatch::Alarm' }] } }).length, 1);
  assert.equal(validateChangeSet({ Changes: [{ Type: 'Resource', ResourceChange: { ChangeSetId: 'not-an-arn' } }] }).length, 1);
  // CausingEntity keeps its documented latitude: a parameter or logical name is legitimate.
  assert.deepEqual(validateChangeSet({ Changes: [{ Type: 'Resource', ResourceChange: { Details: [{ CausingEntity: 'KeyPairName' }] } }] }), []);
  // END TO END: the repro refuses before any digest or execution.
  withRelease((p, asm, manifest) => {
    const describes = fullDescribes();
    describes[PILOT_STACK_NAMES[0]] = { ...describes[PILOT_STACK_NAMES[0]], ChangeSetId: 'supersecret' };
    const run = cloudRun({ describes });
    const r = runDeployRelease(releaseArgs(p, asm), deployOpts(manifest, { run }));
    assert.equal(r.exit, 1);
    assert.match(r.output, /CHANGE_SET_SCHEMA_UNKNOWN/);
    assert.equal(r.output.includes('supersecret'), false, 'the value must never surface anywhere in the refusal');
    assert.equal(run.of('execute-change-set').length, 0);
  });
});

test('ROUND-15: a page is validated BEFORE any transformation — non-iterable Changes refuse, never throw', () => {
  const { validateChangeSet } = require('../bin/deploy-release');
  // The exact reproduction: Changes: {} passed the null mask and THREW at the spread, killing
  // the lane outside the fail-closed contract with no structured evidence at all.
  for (const [label, changes] of [['an object', {}], ['a number', 42], ['a boolean', true]]) {
    assert.deepEqual(validateChangeSet({ Changes: changes }), ['$.Changes: expected a list'], label);
    withRelease((p, asm, manifest) => {
      const run = cloudRun({
        onCall: (args) => {
          if (args[1] !== 'describe-change-set') return null;
          const stackName = args[args.indexOf('--stack-name') + 1];
          return { status: 0, stdout: JSON.stringify({ ...describedFor(stackName), Changes: changes }), stderr: '' };
        },
      });
      // A malformed child must produce the STRUCTURED refusal — an uncaught TypeError is a
      // crash, not a refusal, and it leaves no CHANGE_SET_SCHEMA_UNKNOWN evidence behind.
      const r = runDeployRelease(releaseArgs(p, asm), deployOpts(manifest, { run }));
      assert.equal(r.exit, 1, label);
      assert.match(r.output, /CHANGE_SET_SCHEMA_UNKNOWN/, label);
      assert.equal(r.output.includes('PLAN_DIGEST'), false, 'no digest may exist');
      assert.equal(run.of('execute-change-set').length, 0);
    });
  }
});

test('ROUND-15: ARN contracts are POSITIONAL — the right service and resource shape, or refusal', () => {
  const { validateChangeSet } = require('../bin/deploy-release');
  // The five reproductions — every one returned zero violations before.
  for (const [label, body] of [
    ['empty mandatory components', { ChangeSetId: 'arn:::::supersecret' }],
    ['an SNS topic where a change set belongs', { ChangeSetId: `arn:aws:sns:us-east-1:${ACCOUNT}:not-a-change-set` }],
    ['an IAM role where a stack belongs', { StackId: `arn:aws:iam::${ACCOUNT}:role/not-a-stack` }],
    ['an IAM role where an SNS topic belongs', { NotificationARNs: [`arn:aws:iam::${ACCOUNT}:role/not-a-topic`] }],
    ['an S3 bucket where an alarm belongs', { RollbackConfiguration: { RollbackTriggers: [{ Arn: 'arn:aws:s3:::not-an-alarm', Type: 'AWS::CloudWatch::Alarm' }] } }],
  ]) {
    assert.equal(validateChangeSet(body).length, 1, label);
  }
  // The compliant shapes still validate — this contract refuses semantics, not the API.
  assert.deepEqual(validateChangeSet({
    ChangeSetId: `arn:aws:cloudformation:us-east-1:${ACCOUNT}:changeSet/cba-70-abcdef123456/11111111-2222-3333-4444-555555555555`,
    StackId: `arn:aws:cloudformation:us-east-1:${ACCOUNT}:stack/cba-study-coach-pilot-api/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee`,
    NotificationARNs: [`arn:aws:sns:us-east-1:${ACCOUNT}:cba-study-coach-pilot-operational-alerts`],
    RollbackConfiguration: { RollbackTriggers: [{ Arn: `arn:aws:cloudwatch:us-east-1:${ACCOUNT}:alarm:cba-study-coach-pilot-api-5xx`, Type: 'AWS::CloudWatch::Alarm' }] },
  }), []);
  // ENTITY_REFERENCE keeps its latitude ONLY at CausingEntity.
  assert.deepEqual(validateChangeSet({ Changes: [{ Type: 'Resource', ResourceChange: { Details: [{ CausingEntity: 'KeyPairName' }] } }] }), []);
  // END TO END: a wrong-service change-set id refuses before any digest, value surfacing nowhere.
  withRelease((p, asm, manifest) => {
    const describes = fullDescribes();
    describes[PILOT_STACK_NAMES[0]] = { ...describes[PILOT_STACK_NAMES[0]], ChangeSetId: `arn:aws:sns:us-east-1:${ACCOUNT}:supersecret-topic` };
    const run = cloudRun({ describes });
    const r = runDeployRelease(releaseArgs(p, asm), deployOpts(manifest, { run }));
    assert.equal(r.exit, 1);
    assert.match(r.output, /CHANGE_SET_SCHEMA_UNKNOWN/);
    assert.equal(r.output.includes('supersecret-topic'), false);
    assert.equal(run.of('execute-change-set').length, 0);
  });
});

test('ROUND-11: unstructured child text is NEVER echoed — one policy, evidence instead of prose', () => {
  const { childEvidence } = require('../bin/deploy-release');
  const POISONS = [
    'postgres://user:supersecret@db.internal/cba',
    'arn:aws:iam::111122223333:role/cba-study-coach-gha-deploy-dev',
    'https://abc123xyz.execute-api.us-east-1.amazonaws.com/',
    'us-east-1_AbCdEf123',
    '111122223333',
  ];
  // The evidence is a stable code, a byte count and a digest — correlatable with the runner's own
  // protected logs, reproducing not one byte of the child's text.
  const evidence = childEvidence({ status: 1, stdout: POISONS.join('\n'), stderr: POISONS[0] });
  for (const poison of POISONS) assert.equal(evidence.includes(poison), false, poison);
  assert.match(evidence, /child not echoed — exit=1 stdout=\d+B stderr=\d+B sha256=[0-9a-f]{64}/);
  // Deterministic: the same bytes always produce the same digest, different bytes do not.
  assert.equal(evidence, childEvidence({ status: 1, stdout: POISONS.join('\n'), stderr: POISONS[0] }));
  assert.notEqual(evidence, childEvidence({ status: 1, stdout: 'other', stderr: '' }));

  // END TO END on the real PLAN_PREPARE_FAILED path: a prepare child that spews credentials
  // must leave the refusal carrying evidence only — this is the path that reaches CI logs.
  withRelease((p, asm, manifest) => {
    const r = runDeployRelease(releaseArgs(p, asm), {
      run: cloudRun(),
      git: happyGit(),
      cdkJsonPath: CDK_JSON,
      env: { CBA_CLOUD_GATE: gateFor(manifest, { mode: 'plan_only', planDigest: null }) },
      now: () => GATE_NOW,
      sleep: () => {},
      exec: () => ({ status: 1, stdout: `deploying...\n${POISONS.join(' ')}`, stderr: POISONS[0] }),
    });
    assert.equal(r.exit, 1);
    assert.match(r.output, /PLAN_PREPARE_FAILED/);
    for (const poison of POISONS) assert.equal(r.output.includes(poison), false, `${poison} must never reach the refusal output`);
    assert.match(r.output, /child not echoed — exit=1 stdout=\d+B stderr=\d+B sha256=[0-9a-f]{64}/);
    assert.equal(r.output.includes('deploying...'), false, 'not even benign-looking child prose is reproduced');
  });

  // The deploy path has no cdk child at all, so there is nothing else that could echo one.
  const source = fs.readFileSync(path.join(__dirname, '..', 'bin', 'deploy-release.js'), 'utf8');
  assert.equal(/stdout \|\| ''}\\n\$\{[a-z]*\.stderr/.test(source), false, 'no path may compose child text into output');
});

test('deploy-release usage errors are distinguishable and never echo the offending token', () => {
  assert.equal(runDeployRelease([`--${POISON.token}`], {}).exit, 2);
  assertClean(runDeployRelease([`--${POISON.token}`], {}).output, 'deploy-release usage error');
  for (const missing of [
    [],
    ['--manifest', 'x'],
    ['--manifest', 'x', '--environment', 'pilot'],
    ['--manifest', 'x', '--environment', 'pilot', '--release-sha', SHA],
    ['--manifest', 'x', '--environment', 'pilot', '--release-sha', SHA, '--region', 'us-east-1'],
  ]) {
    assert.equal(runDeployRelease(missing, {}).exit, 2, JSON.stringify(missing));
  }
});

test('ROUND-6 REPRO: the digest is injective — the delimiter-collision trees digest differently', () => {
  // Codex built two different trees with the same digest under the old concatenation framing:
  // tree A's single file CONTAINED the delimiter sequence that tree B's two files induced. The
  // canonical form is now a JSON array (every field length-framed by the encoding, content replaced
  // by its fixed-length sha256 plus explicit size), so the pair must differ.
  const NUL = String.fromCharCode(0);
  const { assemblyDigest } = require('../bin/deploy-preflight');
  const dA = withDir({ a: Buffer.from(`A${NUL}b${NUL}F${NUL}B`) }, (d) => assemblyDigest(d).digest);
  const dB = withDir({ a: 'A', b: 'B' }, (d) => assemblyDigest(d).digest);
  assert.notEqual(dA, dB, 'the exact reproduced collision must no longer collide');
});

test('ROUND-6 REPRO: the digest binds the executable bit, normalized git-style', () => {
  const { assemblyDigest } = require('../bin/deploy-preflight');
  withDir({ 'asset.x/run.sh': '#!/bin/sh\necho hi' }, (d) => {
    const plain = assemblyDigest(d).digest;
    fs.chmodSync(path.join(d, 'asset.x/run.sh'), 0o755);
    const exec755 = assemblyDigest(d).digest;
    assert.notEqual(plain, exec755, '0644 -> 0755 must change the digest');
    // Git-style normalization: any owner-executable mode is 0755, so umask noise cannot refuse an
    // honest assembly.
    fs.chmodSync(path.join(d, 'asset.x/run.sh'), 0o700);
    assert.equal(assemblyDigest(d).digest, exec755, '0700 and 0755 normalize identically');
  });
});

test('the snapshot preserves the executable bit, so an honest executable asset deploys', () => {
  withDir({ ...ASSEMBLY_FILES }, (asm) => {
    fs.chmodSync(path.join(asm, 'asset.abc123/index.mjs'), 0o755);
    const written = [];
    const r = runDeployPreflight([...cliArgs(), '--assembly', asm, '--manifest-out', '/x'], {
      run: stubAws(), cdkJsonPath: CDK_JSON, env: {}, writeFile: (p2, d) => written.push(d),
    });
    assert.equal(r.exit, 0, r.output);
    const manifest = JSON.parse(written[0]);
    withManifest(manifest, (mp) => {
      const rel = runDeployRelease(releaseArgs(mp, asm), deployOpts(manifest));
      assert.equal(rel.exit, 0, rel.output);
    });
  });
});

test('ROUND-6 REPRO: snapshots never outlive the run — every refusal path cleans up', () => {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'cba-snap-base-'));
  const assertEmpty = (label) => assert.deepEqual(fs.readdirSync(tmpBase), [], `${label} must leave no snapshot behind`);
  try {
    // Success.
    withRelease((p2, asm, manifest) => {
      const r = runDeployRelease(releaseArgs(p2, asm), deployOpts(manifest, { tmpBase }));
      assert.equal(r.exit, 0, r.output);
      assertEmpty('success');
    });
    // A cloud-gate refusal happens AFTER the snapshot exists — it must clean up too.
    withRelease((p2, asm) => {
      runDeployRelease(releaseArgs(p2, asm), { run: stubAws(), git: happyGit(), cdkJsonPath: CDK_JSON, env: {}, tmpBase, exec: () => assert.fail('must not exec') });
      assertEmpty('a missing-gate refusal');
    });
    // Digest mismatch.
    withRelease(
      (p2, asm) => {
        runDeployRelease(releaseArgs(p2, asm), { run: stubAws(), git: happyGit(), cdkJsonPath: CDK_JSON, env: {}, tmpBase, exec: () => assert.fail('must not exec') });
        assertEmpty('an assembly-digest refusal');
      },
      { assemblyFiles: { ...ASSEMBLY_FILES, 'manifest.json': '{"version":"36.0.0","artifacts":{"X":1}}' } },
    );
    // Account unresolved, context drift, account swap, failing child.
    withRelease((p2, asm) => {
      runDeployRelease(releaseArgs(p2, asm), { run: stubAws({ stsStatus: 254 }), git: happyGit(), cdkJsonPath: CDK_JSON, env: {}, tmpBase, exec: () => assert.fail('must not exec') });
      assertEmpty('an account-resolution refusal');

      runDeployRelease(releaseArgs(p2, asm, ['-c', 'authDomainPrefix=cba-study-coach-pilot-evil']), { run: stubAws(), git: happyGit(), cdkJsonPath: CDK_JSON, env: {}, tmpBase, exec: () => assert.fail('must not exec') });
      assertEmpty('a context-recompute refusal');

      let stsCalls = 0;
      runDeployRelease(releaseArgs(p2, asm), {
        run: (args, o) => {
          if (args[0] === 'sts') {
            stsCalls += 1;
            return { status: 0, stdout: JSON.stringify({ Account: stsCalls === 1 ? ACCOUNT : '2'.repeat(12) }), stderr: '' };
          }
          return stubAws()(args, o);
        },
        git: happyGit(), cdkJsonPath: CDK_JSON, env: {}, tmpBase, exec: () => assert.fail('must not exec'),
      });
      assertEmpty('an account-swap refusal');

      runDeployRelease(releaseArgs(p2, asm), deployOpts(capturedManifest(), {
        tmpBase,
        run: cloudRun({ onCall: (args) => (args[1] === 'execute-change-set' ? { status: 254, stdout: '', stderr: 'stale' } : null) }),
      }));
      assertEmpty('a refused execution');
    });
  } finally {
    fs.rmSync(tmpBase, { recursive: true, force: true });
  }
});

test('verify-manifest can check the assembly too, and refuses drift', () => {
  withRelease((p, asm, manifest) => {
    const ok = runVerifyManifest(['--manifest', p, '--environment', 'pilot', '--release-sha', SHA, '--assembly', asm], {});
    assert.equal(ok.exit, 0, ok.output);
  });
  withRelease(
    (p, asm) => {
      const r = runVerifyManifest(['--manifest', p, '--environment', 'pilot', '--release-sha', SHA, '--assembly', asm], {});
      assert.equal(r.exit, 1);
      assert.match(r.output, /ASSEMBLY_DIGEST_MISMATCH/);
    },
    { assemblyFiles: { ...ASSEMBLY_FILES, 'DataStack.template.json': '{"Resources":{"Other":1}}' } },
  );
});

// -------------------------------------------------------------------------------------------------
// SLICE I3 — the closed evidence record (SPEC-RUN-007, SPEC-DEPLOY-006/018, SPEC-LANE-006).
// Evidence is an artifact tied to a DECISION: correlation id proven before anything runs, change
// sets by NAME (an id is an ARN and never enters evidence), the honest partial `executed` list on
// every halt, and the refusal codes verbatim.
// -------------------------------------------------------------------------------------------------

const EVIDENCE_KEYS = ['schema', 'correlationId', 'releaseSha', 'environment', 'mode', 'decisionId', 'stacks', 'planDigest', 'changeSets', 'executed', 'abandoned', 'alreadyAbsent', 'reportedStackRecords', 'outcome', 'refusals', 'rendering'];
const CORRELATION = `cba-70-${'a'.repeat(32)}`;

function withArtifact(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cba-evidence-'));
  try {
    fn(path.join(dir, 'nested', 'evidence.json'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('EVIDENCE: --artifact-out without a well-formed CORRELATION_ID refuses before anything runs', () => {
  withRelease((p, asm, manifest) => {
    withArtifact((artifact) => {
      for (const bad of [undefined, '', 'nope', `cba-70-${'a'.repeat(31)}`, `cba-70-${'A'.repeat(32)}`, ` ${CORRELATION}`]) {
        const r = runDeployRelease([...releaseArgs(p, asm), '--artifact-out', artifact], {
          run: () => assert.fail('no aws call may run'),
          git: () => assert.fail('no git call may run'),
          cdkJsonPath: CDK_JSON,
          env: { PATH: '/usr/bin', ...(bad === undefined ? {} : { CORRELATION_ID: bad }), CBA_CLOUD_GATE: gateFor(manifest, { mode: 'plan_only', planDigest: null }) },
          now: () => GATE_NOW,
          sleep: () => {},
          exec: () => assert.fail('no child may run'),
        });
        assert.notEqual(r.exit, 0, JSON.stringify(bad));
        assert.match(r.output, /CORRELATION_MALFORMED/);
        assert.equal(fs.existsSync(artifact), false, 'unattributable evidence must not be written');
      }
    });
  });
});

test('EVIDENCE: plan_only writes the closed record — decision-bound, name-only, ARN-free', () => {
  withRelease((p, asm, manifest) => {
    withArtifact((artifact) => {
      const r = runDeployRelease([...releaseArgs(p, asm), '--artifact-out', artifact], {
        run: cloudRun(),
        git: happyGit(),
        cdkJsonPath: CDK_JSON,
        env: { PATH: '/usr/bin', CORRELATION_ID: CORRELATION, CBA_CLOUD_GATE: gateFor(manifest, { mode: 'plan_only', planDigest: null }) },
        now: () => GATE_NOW,
        sleep: () => {},
        exec: () => ({ status: 0, stdout: '', stderr: '' }),
      });
      assert.equal(r.exit, 0, r.output);
      const raw = fs.readFileSync(artifact, 'utf8');
      const record = JSON.parse(raw);
      assert.deepEqual(Object.keys(record).sort(), [...EVIDENCE_KEYS].sort(), 'the record is CLOSED');
      assert.equal(record.schema, 'cba-release-evidence/1');
      assert.equal(record.correlationId, CORRELATION);
      assert.equal(record.releaseSha, manifest.releaseSha);
      assert.equal(record.environment, 'pilot');
      assert.equal(record.mode, 'plan_only');
      assert.equal(record.outcome, 'PLAN_PREPARED');
      assert.deepEqual(record.refusals, []);
      assert.deepEqual(record.executed, []);
      assert.match(record.planDigest, /^[0-9a-f]{64}$/);
      const printed = r.output.match(/PLAN_DIGEST ([0-9a-f]{64})/);
      assert.equal(record.planDigest, printed[1], 'the artifact digest IS the printed digest');
      assert.equal(record.changeSets.length, 4);
      for (const entry of record.changeSets) {
        assert.deepEqual(Object.keys(entry).sort(), ['canonicalSha256', 'changeSetName', 'stackName', 'status']);
        assert.match(entry.canonicalSha256, /^[0-9a-f]{64}$/);
        assert.equal(entry.changeSetName, `cba-70-${manifest.releaseSha.slice(0, 12)}`);
      }
      assert.equal(typeof record.rendering, 'string');
      assert.ok(record.rendering.length > 0, 'the rendering travels with the plan evidence');
      // SPEC-DEPLOY-006: no LIVE ARN may enter evidence. The rendering legitimately carries
      // redacted ARN skeletons (reviewed IAM principal paths render verbatim with the account
      // replaced), so the law is: no ARN bearing a REAL 12-digit account anywhere, and outside
      // the rendering no ARN of any shape at all.
      assert.equal(/arn:aws[a-z-]*:[a-z0-9-]*:[a-z0-9-]*:[0-9]{12}:/.test(raw), false, 'no account-bearing ARN may enter evidence');
      const withoutRendering = JSON.stringify({ ...record, rendering: null });
      assert.equal(/\barn:aws/i.test(withoutRendering), false, 'outside the rendering, evidence is ARN-free entirely');
    });
  });
});

test('EVIDENCE: deploy writes DEPLOYED with the executed names; a mid-wave halt records the honest partial', () => {
  // Success: all four executed, by NAME.
  withRelease((p, asm, manifest) => {
    withArtifact((artifact) => {
      const run = cloudRun();
      const r = runDeployRelease([...releaseArgs(p, asm), '--artifact-out', artifact], {
        run,
        git: happyGit(),
        cdkJsonPath: CDK_JSON,
        env: { PATH: '/usr/bin', CORRELATION_ID: CORRELATION, CBA_CLOUD_GATE: gateFor(manifest) },
        now: () => GATE_NOW,
        sleep: () => {},
        exec: () => assert.fail('deploy mode spawns no cdk child'),
      });
      assert.equal(r.exit, 0, r.output);
      const record = JSON.parse(fs.readFileSync(artifact, 'utf8'));
      assert.equal(record.mode, 'deploy');
      assert.equal(record.outcome, 'DEPLOYED');
      assert.equal(record.executed.length, 4);
      assert.ok(record.executed.every((name) => typeof name === 'string' && !/\barn:aws/i.test(name)));
    });
  });
  // Halt after the first execution: REFUSED, the named code, and EXACTLY the executed prefix.
  withRelease((p, asm, manifest) => {
    withArtifact((artifact) => {
      let executes = 0;
      const run = cloudRun({
        onCall: (args) => {
          if (args[1] === 'execute-change-set') {
            executes += 1;
            if (executes === 2) return { status: 254, stdout: '', stderr: 'ChangeSet is stale' };
          }
          return null;
        },
      });
      const r = runDeployRelease([...releaseArgs(p, asm), '--artifact-out', artifact], {
        run,
        git: happyGit(),
        cdkJsonPath: CDK_JSON,
        env: { PATH: '/usr/bin', CORRELATION_ID: CORRELATION, CBA_CLOUD_GATE: gateFor(manifest) },
        now: () => GATE_NOW,
        sleep: () => {},
        exec: () => assert.fail('deploy mode spawns no cdk child'),
      });
      assert.notEqual(r.exit, 0);
      const record = JSON.parse(fs.readFileSync(artifact, 'utf8'));
      assert.equal(record.outcome, 'REFUSED');
      assert.ok(record.refusals.includes('EXECUTE_FAILED'), JSON.stringify(record.refusals));
      assert.equal(record.executed.length, 1, 'the honest partial: exactly what ran before the halt');
    });
  });
});

test('EVIDENCE: without --artifact-out the entrypoint behaves exactly as before and writes nothing', () => {
  withRelease((p, asm, manifest) => {
    withArtifact((artifact) => {
      const r = runDeployRelease(releaseArgs(p, asm), {
        run: cloudRun(),
        git: happyGit(),
        cdkJsonPath: CDK_JSON,
        env: { PATH: '/usr/bin', CBA_CLOUD_GATE: gateFor(manifest, { mode: 'plan_only', planDigest: null }) },
        now: () => GATE_NOW,
        sleep: () => {},
        exec: () => ({ status: 0, stdout: '', stderr: '' }),
      });
      assert.equal(r.exit, 0, r.output);
      assert.equal(fs.existsSync(artifact), false);
    });
  });
});

test('EVIDENCE: a STACK_EXECUTION_FAILED halt records the STARTED mutation — log and artifact agree', () => {
  // ROUND I3-2 (Codex): execute-change-set was ACCEPTED, then the stack failed to stabilize. The
  // artifact must carry that stack in `executed` — a mutation that began is on the record.
  withRelease((p, asm, manifest) => {
    withArtifact((artifact) => {
      let waits = 0;
      const run = cloudRun({
        onCall: (args) => {
          if (args[1] === 'describe-stacks') {
            waits += 1;
            if (waits >= 1) return { status: 0, stdout: JSON.stringify({ Stacks: [{ StackStatus: 'UPDATE_ROLLBACK_COMPLETE' }] }), stderr: '' };
          }
          return null;
        },
      });
      const r = runDeployRelease([...releaseArgs(p, asm), '--artifact-out', artifact], {
        run,
        git: happyGit(),
        cdkJsonPath: CDK_JSON,
        env: { PATH: '/usr/bin', CORRELATION_ID: CORRELATION, CBA_CLOUD_GATE: gateFor(manifest) },
        now: () => GATE_NOW,
        sleep: () => {},
        exec: () => assert.fail('deploy mode spawns no cdk child'),
      });
      assert.notEqual(r.exit, 0);
      assert.match(r.output, /STACK_EXECUTION_FAILED/);
      const record = JSON.parse(fs.readFileSync(artifact, 'utf8'));
      assert.equal(record.outcome, 'REFUSED');
      assert.ok(record.refusals.includes('STACK_EXECUTION_FAILED'));
      assert.equal(record.executed.length, 1, 'the started mutation is ON the record');
      // …and the output names exactly the same set — log and artifact can no longer disagree.
      const printed = r.output.match(/Executed before the failure: ([^.]+)\./);
      assert.deepEqual(printed[1].split(', '), record.executed);
    });
  });
});

// -------------------------------------------------------------------------------------------------
// ROUND I3-3 — the transport is proven, never assumed: job outputs carry a documented ~1MB bound
// (UTF-16 units), so the record is bounded to the channel and an unfittable plan REFUSES.
// -------------------------------------------------------------------------------------------------

const { boundedEvidence, EVIDENCE_MAX_BYTES } = require('../bin/deploy-release');

test('EVIDENCE BOUND: the cap is pinned, and boundedEvidence reshapes by NAMED code, never truncates', () => {
  // ROUND I3-4: bounded in UTF-8 BYTES with margin under the narrowest hop — a single Linux
  // envp entry (MAX_ARG_STRLEN, 128 KiB), where the shell dies with E2BIG before any guard.
  assert.equal(EVIDENCE_MAX_BYTES, 100_000);
  const record = {
    schema: 'cba-release-evidence/1', correlationId: CORRELATION, releaseSha: 'a'.repeat(40),
    environment: 'pilot', mode: 'plan_only', decisionId: 'zamp-1', stacks: ['A', 'B'],
    planDigest: 'b'.repeat(64), changeSets: [{ stackName: 'A', changeSetName: 'c', status: 'CREATE_COMPLETE' }],
    executed: [], outcome: 'PLAN_PREPARED', refusals: [], rendering: 'small',
  };
  // Fits: untouched — same object, no codes invented.
  assert.deepEqual(boundedEvidence(record, 100_000), record);
  // ROUND I3-4: the measure is BYTES, not UTF-16 units — a multi-byte rendering whose unit count
  // fits but whose byte count does not MUST be reshaped (a unit measure undercounts it 3:1).
  {
    const multibyte = { ...record, rendering: '…'.repeat(1_000) }; // 1k units, ~3k utf8 bytes
    const base = Buffer.byteLength(JSON.stringify({ ...record, rendering: '' }, null, 2), 'utf8');
    const cap = base + 2_000; // fits by units (1k), NOT by bytes (~3k)
    const shaped = boundedEvidence(multibyte, cap);
    assert.equal(shaped.rendering, null, 'byte-counted: the multi-byte rendering must be omitted');
    assert.ok(shaped.refusals.includes('EVIDENCE_RENDERING_OMITTED'));
  }
  // The rendering pushes past the cap: it is REMOVED and said so — never sliced.
  const big = { ...record, rendering: 'x'.repeat(5_000) };
  const shaped = boundedEvidence(big, 2_000);
  assert.equal(shaped.rendering, null);
  assert.ok(shaped.refusals.includes('EVIDENCE_RENDERING_OMITTED'));
  assert.ok(JSON.stringify(shaped, null, 2).length <= 2_000);
  assert.ok(!JSON.stringify(shaped).includes('xxx'), 'no fragment of the rendering survives — omitted, not truncated');
  // Pathological caps drop the variable-length lists too, by code — force the third branch by
  // capping just below the without-rendering size.
  const withoutRendering = boundedEvidence(big, 2_000);
  const belowCore = JSON.stringify(withoutRendering, null, 2).length - 1;
  const tiny = boundedEvidence(big, belowCore);
  assert.ok(tiny.refusals.includes('EVIDENCE_CHANNEL_OVERFLOW'));
  assert.deepEqual(tiny.changeSets, []);
  assert.deepEqual(tiny.stacks, []);
});

test('EVIDENCE BOUND: a plan whose record cannot cross the channel REFUSES — sets remain, evidence travels', () => {
  withRelease((p, asm, manifest) => {
    withArtifact((artifact) => {
      const r = runDeployRelease([...releaseArgs(p, asm), '--artifact-out', artifact], {
        run: cloudRun(),
        git: happyGit(),
        cdkJsonPath: CDK_JSON,
        env: { PATH: '/usr/bin', CORRELATION_ID: CORRELATION, CBA_CLOUD_GATE: gateFor(manifest, { mode: 'plan_only', planDigest: null }) },
        now: () => GATE_NOW,
        sleep: () => {},
        exec: () => ({ status: 0, stdout: '', stderr: '' }),
        evidenceMaxBytes: 2_000, // a channel this plan cannot fit
      });
      assert.notEqual(r.exit, 0);
      assert.match(r.output, /PLAN_RENDERING_TOO_LARGE/);
      assert.match(r.output, /change sets REMAIN/, 'the post-effect state is stated, not hidden');
      const record = JSON.parse(fs.readFileSync(artifact, 'utf8'));
      assert.equal(record.outcome, 'REFUSED');
      assert.ok(record.refusals.includes('PLAN_RENDERING_TOO_LARGE'));
      assert.equal(record.rendering, null);
      assert.ok(fs.readFileSync(artifact, 'utf8').length <= 2_000 + 1, 'the refusal evidence itself fits the channel');
    });
  });
  // …and a deploy record — which carries no rendering — still crosses the same narrow channel.
  withRelease((p, asm, manifest) => {
    withArtifact((artifact) => {
      const r = runDeployRelease([...releaseArgs(p, asm), '--artifact-out', artifact], {
        run: cloudRun(),
        git: happyGit(),
        cdkJsonPath: CDK_JSON,
        env: { PATH: '/usr/bin', CORRELATION_ID: CORRELATION, CBA_CLOUD_GATE: gateFor(manifest) },
        now: () => GATE_NOW,
        sleep: () => {},
        exec: () => assert.fail('deploy mode spawns no cdk child'),
        evidenceMaxBytes: 2_000,
      });
      assert.equal(r.exit, 0, r.output);
      const record = JSON.parse(fs.readFileSync(artifact, 'utf8'));
      assert.equal(record.outcome, 'DEPLOYED');
      assert.ok(!record.refusals.includes('EVIDENCE_RENDERING_OMITTED'));
    });
  });
});

test('EVIDENCE BOUND: the normal fixture fits the real cap with a wide margin', () => {
  withRelease((p, asm, manifest) => {
    withArtifact((artifact) => {
      const r = runDeployRelease([...releaseArgs(p, asm), '--artifact-out', artifact], {
        run: cloudRun(),
        git: happyGit(),
        cdkJsonPath: CDK_JSON,
        env: { PATH: '/usr/bin', CORRELATION_ID: CORRELATION, CBA_CLOUD_GATE: gateFor(manifest, { mode: 'plan_only', planDigest: null }) },
        now: () => GATE_NOW,
        sleep: () => {},
        exec: () => ({ status: 0, stdout: '', stderr: '' }),
      });
      assert.equal(r.exit, 0, r.output);
      const bytes = Buffer.byteLength(fs.readFileSync(artifact, 'utf8'), 'utf8');
      assert.ok(bytes < EVIDENCE_MAX_BYTES / 4, `the four-stack record uses ${bytes} bytes — far from the cap`);
    });
  });
});

// -------------------------------------------------------------------------------------------------
// SLICE I5 — the abandon effect (SPEC-RUN-008): delete EXACTLY the declined plan, revalidate at
// every mutation boundary, and REPORT — never delete — the stack records left behind.
// -------------------------------------------------------------------------------------------------

test('ABANDON: deletes exactly the declined change sets, in order, and never touches a stack', () => {
  withRelease((p, asm, manifest) => {
    withArtifact((artifact) => {
      const run = cloudRun({ stackStatus: 'REVIEW_IN_PROGRESS' });
      const r = runDeployRelease([...releaseArgs(p, asm), '--artifact-out', artifact], {
        run,
        git: happyGit(),
        cdkJsonPath: CDK_JSON,
        env: { PATH: '/usr/bin', CORRELATION_ID: CORRELATION, DISPATCH_MODE: 'abandon', CBA_CLOUD_GATE: gateFor(manifest, { mode: 'abandon' }) },
        now: () => GATE_NOW,
        sleep: () => {},
        exec: () => assert.fail('abandon spawns no cdk child — nothing is ever prepared'),
      });
      assert.equal(r.exit, 0, r.output);
      assert.equal(r.executed, false, 'abandon executes nothing');
      // Exactly the four reviewed sets deleted, in the reviewed order, by immutable id.
      const deletions = run.of('delete-change-set');
      assert.equal(deletions.length, 4);
      assert.equal(run.of('execute-change-set').length, 0, 'abandon EXECUTES nothing');
      // No DeleteStack exists in this file at all — the record is REPORTED, not removed.
      assert.equal(run.calls.filter((c) => c.args[1] === 'delete-stack').length, 0);
      const entrypointSource = fs.readFileSync(require.resolve('../bin/deploy-release.js'), 'utf8');
      assert.ok(!entrypointSource.includes('delete-stack'), 'the entrypoint must not even contain the DeleteStack verb');
      // ROUND I8-2: the ACTIVE id's annotation is part of the evidence this test guards.
      assert.ok(entrypointSource.includes('[SPEC-DEPLOY-021]'), 'the abandon block carries its ACTIVE annotation token');
      assert.match(r.output, /REPORTED \(never deleted\)/);
      const record = JSON.parse(fs.readFileSync(artifact, 'utf8'));
      assert.equal(record.outcome, 'ABANDONED');
      assert.equal(record.abandoned.length, 4);
      assert.equal(record.reportedStackRecords.length, 4, 'every REVIEW_IN_PROGRESS record is on the record');
      assert.deepEqual(record.executed, []);
    });
  });
});

test('ABANDON: a drifted plan refuses as PLAN_CHANGED and NOTHING is deleted', () => {
  withRelease((p, asm, manifest) => {
    withArtifact((artifact) => {
      const run = cloudRun();
      const r = runDeployRelease([...releaseArgs(p, asm), '--artifact-out', artifact], {
        run,
        git: happyGit(),
        cdkJsonPath: CDK_JSON,
        env: { PATH: '/usr/bin', CORRELATION_ID: CORRELATION, DISPATCH_MODE: 'abandon', CBA_CLOUD_GATE: gateFor(manifest, { mode: 'abandon', planDigest: 'f'.repeat(64) }) },
        now: () => GATE_NOW,
        sleep: () => {},
        exec: () => assert.fail('abandon spawns no cdk child'),
      });
      assert.notEqual(r.exit, 0);
      assert.match(r.output, /PLAN_CHANGED/);
      assert.equal(run.of('delete-change-set').length, 0, 'a surprised operation deletes nothing');
      const record = JSON.parse(fs.readFileSync(artifact, 'utf8'));
      assert.equal(record.outcome, 'REFUSED');
      assert.deepEqual(record.abandoned, []);
    });
  });
});

test('ABANDON: a state error mid-way stops with the honest partial — never a retry', () => {
  withRelease((p, asm, manifest) => {
    withArtifact((artifact) => {
      let deletions = 0;
      const run = cloudRun({
        stackStatus: 'REVIEW_IN_PROGRESS',
        onCall: (args) => {
          if (args[1] === 'delete-change-set') {
            deletions += 1;
            if (deletions === 2) return { status: 254, stdout: '', stderr: 'InvalidChangeSetStatus' };
          }
          return null;
        },
      });
      const r = runDeployRelease([...releaseArgs(p, asm), '--artifact-out', artifact], {
        run,
        git: happyGit(),
        cdkJsonPath: CDK_JSON,
        env: { PATH: '/usr/bin', CORRELATION_ID: CORRELATION, DISPATCH_MODE: 'abandon', CBA_CLOUD_GATE: gateFor(manifest, { mode: 'abandon' }) },
        now: () => GATE_NOW,
        sleep: () => {},
        exec: () => assert.fail('abandon spawns no cdk child'),
      });
      assert.notEqual(r.exit, 0);
      assert.match(r.output, /ABANDON_DELETE_FAILED/);
      assert.match(r.output, /Abandoned before the failure: [^.]+\./);
      assert.equal(deletions, 2, 'the stop is immediate — no third deletion is attempted');
      const record = JSON.parse(fs.readFileSync(artifact, 'utf8'));
      assert.equal(record.outcome, 'REFUSED');
      assert.equal(record.abandoned.length, 1, 'exactly the sets deleted before the surprise');
      assert.ok(record.refusals.includes('ABANDON_DELETE_FAILED'));
      // ROUND I5-3 (F2): the halt still REPORTS the stack record the deleted prefix left behind.
      assert.deepEqual(record.reportedStackRecords, [record.abandoned[0]], 'a halt after a deletion reports the prefix — never an empty reporting field');
    });
  });
});

test('ABANDON: the window is re-checked before EACH deletion — a lapsed gate stops the remainder', () => {
  withRelease((p, asm, manifest) => {
    withArtifact((artifact) => {
      let clock = Date.parse('2026-08-02T12:00:00Z');
      let deletions = 0;
      const run = cloudRun({
        stackStatus: 'REVIEW_IN_PROGRESS',
        onCall: (args) => {
          if (args[1] === 'delete-change-set') {
            deletions += 1;
            clock = Date.parse('2026-08-02T12:31:00Z'); // the window lapses after the first delete
          }
          return null;
        },
      });
      const r = runDeployRelease([...releaseArgs(p, asm), '--artifact-out', artifact], {
        run,
        git: happyGit(),
        cdkJsonPath: CDK_JSON,
        env: { PATH: '/usr/bin', CORRELATION_ID: CORRELATION, DISPATCH_MODE: 'abandon', CBA_CLOUD_GATE: gateFor(manifest, { mode: 'abandon' }) },
        now: () => clock,
        sleep: () => {},
        exec: () => assert.fail('abandon spawns no cdk child'),
      });
      assert.notEqual(r.exit, 0);
      assert.match(r.output, /CLOUD_GATE_EXPIRED/);
      assert.equal(deletions, 1, 'the lapse is caught before the SECOND deletion');
      const record = JSON.parse(fs.readFileSync(artifact, 'utf8'));
      assert.equal(record.abandoned.length, 1);
      // ROUND I5-3 (F2): the lapse halt still reports the deleted prefix's stack record.
      assert.deepEqual(record.reportedStackRecords, record.abandoned, 'the lapse halt reports the deleted prefix');
    });
  });
});

// ─── ROUND I5-2 ─── the continuation law, the neutral mismatch record, fail-closed reporting ───

test('I5-2: the plan digest is the ROOT over the ordered entry digests — the continuation math', () => {
  const crypto = require('node:crypto');
  const entries = ORDERED_IDS.map((id, i) => canonicalChangeSet(id, PILOT_STACK_NAMES[i], fullDescribes()[PILOT_STACK_NAMES[i]]));
  const root = crypto.createHash('sha256').update(JSON.stringify(entries.map((e) => entryDigestOf(e))), 'utf8').digest('hex');
  assert.equal(planDigestOf(entries), root, 'planDigestOf commits to the LIST of entry digests');
  // Substituting one entry digest moves the root — a recreated set cannot hide in a continuation.
  const forged = entries.map((e) => entryDigestOf(e));
  forged[0] = 'f'.repeat(64);
  assert.notEqual(crypto.createHash('sha256').update(JSON.stringify(forged), 'utf8').digest('hex'), root);
});

test('I5-2 REPRO: success → failure → NEW decision → the remainder is removed safely, records reported', () => {
  withRelease((p, asm, manifest) => {
    // RUN 1: the second deletion fails; exactly one set is gone, the honest partial is recorded.
    let firstEvidence;
    withArtifact((artifact) => {
      let deletions = 0;
      const run = cloudRun({
        stackStatus: 'REVIEW_IN_PROGRESS',
        onCall: (args) => {
          if (args[1] === 'delete-change-set') {
            deletions += 1;
            if (deletions === 2) return { status: 254, stdout: '', stderr: 'InvalidChangeSetStatus' };
          }
          return null;
        },
      });
      const r = runDeployRelease([...releaseArgs(p, asm), '--artifact-out', artifact], {
        run,
        git: happyGit(),
        cdkJsonPath: CDK_JSON,
        env: { PATH: '/usr/bin', CORRELATION_ID: CORRELATION, DISPATCH_MODE: 'abandon', CBA_CLOUD_GATE: gateFor(manifest, { mode: 'abandon' }) },
        now: () => GATE_NOW,
        sleep: () => {},
        exec: () => assert.fail('abandon spawns no cdk child'),
      });
      assert.notEqual(r.exit, 0);
      firstEvidence = JSON.parse(fs.readFileSync(artifact, 'utf8'));
      assert.equal(firstEvidence.abandoned.length, 1);
      assert.match(firstEvidence.changeSets[0].canonicalSha256, /^[0-9a-f]{64}$/, 'the digest a continuation copies is ON the record');
    });
    // RUN 2: a NEW decision carries the deleted prefix's digest from the first run's evidence.
    // The absent set folds into the SAME root; the present remainder is deleted; the stack
    // record the prefix left behind is still REPORTED.
    withArtifact((artifact) => {
      const remaining = { ...fullDescribes() };
      const absentName = PILOT_STACK_NAMES[0];
      delete remaining[absentName]; // the prefix is gone from the cloud — describe says ChangeSetNotFound
      const run = cloudRun({ describes: remaining, stackStatus: 'REVIEW_IN_PROGRESS' });
      const r = runDeployRelease([...releaseArgs(p, asm), '--artifact-out', artifact], {
        run,
        git: happyGit(),
        cdkJsonPath: CDK_JSON,
        env: {
          PATH: '/usr/bin',
          CORRELATION_ID: CORRELATION,
          DISPATCH_MODE: 'abandon',
          CBA_CLOUD_GATE: gateFor(manifest, {
            mode: 'abandon',
            decisionId: 'zamp-2026-08-02.b1-abandon-02',
            absentEntryDigests: [firstEvidence.changeSets[0].canonicalSha256],
          }),
        },
        now: () => GATE_NOW,
        sleep: () => {},
        exec: () => assert.fail('abandon spawns no cdk child'),
      });
      assert.equal(r.exit, 0, r.output);
      assert.equal(run.of('delete-change-set').length, 3, 'exactly the present remainder is deleted');
      const record = JSON.parse(fs.readFileSync(artifact, 'utf8'));
      assert.equal(record.outcome, 'ABANDONED');
      assert.equal(record.abandoned.length, 3);
      assert.deepEqual(record.alreadyAbsent, [absentName], 'the prefix is on the record as already absent');
      assert.equal(record.reportedStackRecords.length, 4, 'the FULL wave is reported — the absent prefix left its stack record too');
      assert.ok(record.reportedStackRecords.includes(absentName));
    });
  });
});

test('I5-3 REPRO: a SECOND interruption is resumable from the newest artifact ALONE — the chain closes', () => {
  withRelease((p, asm, manifest) => {
    const originalRoot = JSON.parse(gateFor(manifest)).planDigest;
    // The runbook's derivation, from ONE artifact only: the original root is its planDigest; the
    // absent digests are the canonicalSha256 of every position already gone (previously absent
    // or deleted by that very run), in the map's group order.
    const nextGateInputs = (record) => ({
      planDigest: record.planDigest,
      absentEntryDigests: record.changeSets
        .filter((e) => e.status === 'ALREADY_ABSENT' || record.abandoned.includes(e.stackName))
        .map((e) => e.canonicalSha256),
    });
    const runAbandon = ({ describes, over, failAtDeletion }) => {
      let out;
      withArtifact((artifact) => {
        let deletions = 0;
        const run = cloudRun({
          describes,
          stackStatus: 'REVIEW_IN_PROGRESS',
          onCall: (args) => {
            if (args[1] === 'delete-change-set') {
              deletions += 1;
              if (deletions === failAtDeletion) return { status: 254, stdout: '', stderr: 'InvalidChangeSetStatus' };
            }
            return null;
          },
        });
        const r = runDeployRelease([...releaseArgs(p, asm), '--artifact-out', artifact], {
          run,
          git: happyGit(),
          cdkJsonPath: CDK_JSON,
          env: { PATH: '/usr/bin', CORRELATION_ID: CORRELATION, DISPATCH_MODE: 'abandon', CBA_CLOUD_GATE: gateFor(manifest, { mode: 'abandon', ...over }) },
          now: () => GATE_NOW,
          sleep: () => {},
          exec: () => assert.fail('abandon spawns no cdk child'),
        });
        out = { r, deletions: run.of('delete-change-set').length, record: JSON.parse(fs.readFileSync(artifact, 'utf8')) };
      });
      return out;
    };
    // RUN 1 (fresh): deletes A, fails at B.
    const run1 = runAbandon({ describes: fullDescribes(), over: {}, failAtDeletion: 2 });
    assert.notEqual(run1.r.exit, 0);
    assert.deepEqual(run1.record.abandoned, [PILOT_STACK_NAMES[0]]);
    // RUN 2 (first continuation, built from artifact 1): A absent; deletes B, fails at C.
    const state2 = { ...fullDescribes() };
    delete state2[PILOT_STACK_NAMES[0]];
    const run2 = runAbandon({
      describes: state2,
      over: { decisionId: 'zamp-2026-08-02.b1-abandon-02', ...nextGateInputs(run1.record) },
      failAtDeletion: 2,
    });
    assert.notEqual(run2.r.exit, 0);
    assert.deepEqual(run2.record.abandoned, [PILOT_STACK_NAMES[1]]);
    assert.deepEqual(run2.record.alreadyAbsent, [PILOT_STACK_NAMES[0]]);
    // F1's discriminating claims, on artifact 2 ALONE: it carries the ORIGINAL root — never the
    // present-subset digest — and the FULL ordered map, the previously-absent position included.
    assert.equal(run2.record.planDigest, originalRoot, 'the continuation artifact carries the ORIGINAL root');
    assert.equal(run2.record.changeSets.length, ORDERED_IDS.length, 'the map covers every position, absent ones included');
    assert.deepEqual(run2.record.changeSets.map((e) => e.stackName), PILOT_STACK_NAMES, 'the map is in group order');
    assert.equal(run2.record.changeSets[0].status, 'ALREADY_ABSENT');
    assert.match(run2.record.changeSets[0].canonicalSha256, /^[0-9a-f]{64}$/);
    // …and the halt reported the WHOLE gone prefix, previously-absent A included (F2).
    assert.deepEqual(run2.record.reportedStackRecords, [PILOT_STACK_NAMES[0], PILOT_STACK_NAMES[1]]);
    // RUN 3 (second continuation, built from artifact 2 ALONE): A and B absent; C and D go.
    const state3 = { ...state2 };
    delete state3[PILOT_STACK_NAMES[1]];
    const run3 = runAbandon({
      describes: state3,
      over: { decisionId: 'zamp-2026-08-02.b1-abandon-03', ...nextGateInputs(run2.record) },
      failAtDeletion: 99,
    });
    assert.equal(run3.r.exit, 0, run3.r.output);
    assert.equal(run3.deletions, 2, 'exactly the remainder is deleted');
    assert.equal(run3.record.outcome, 'ABANDONED');
    assert.deepEqual(run3.record.abandoned, [PILOT_STACK_NAMES[2], PILOT_STACK_NAMES[3]]);
    assert.deepEqual(run3.record.alreadyAbsent, [PILOT_STACK_NAMES[0], PILOT_STACK_NAMES[1]]);
    assert.equal(run3.record.planDigest, originalRoot);
    assert.equal(run3.record.reportedStackRecords.length, 4, 'the FULL wave is reported at the close');
  });
});

test('I5-4 REPRO: a timeout AFTER an accepted deletion reconciles to ABANDONED — and the chain still closes', () => {
  withRelease((p, asm, manifest) => {
    const nextGateInputs = (record) => ({
      planDigest: record.planDigest,
      absentEntryDigests: record.changeSets
        .filter((e) => e.status === 'ALREADY_ABSENT' || record.abandoned.includes(e.stackName))
        .map((e) => e.canonicalSha256),
    });
    let firstRecord;
    withArtifact((artifact) => {
      const describesObj = { ...fullDescribes() };
      let deletions = 0;
      const run = cloudRun({
        describes: describesObj,
        stackStatus: 'REVIEW_IN_PROGRESS',
        onCall: (args) => {
          if (args[1] === 'delete-change-set') {
            deletions += 1;
            if (deletions === 2) {
              // AWS ACCEPTED the deletion… and then the transport died. The set is gone.
              delete describesObj[PILOT_STACK_NAMES[1]];
              return { status: 254, stdout: '', stderr: 'Read timeout on endpoint URL' };
            }
          }
          return null;
        },
      });
      const r = runDeployRelease([...releaseArgs(p, asm), '--artifact-out', artifact], {
        run,
        git: happyGit(),
        cdkJsonPath: CDK_JSON,
        env: { PATH: '/usr/bin', CORRELATION_ID: CORRELATION, DISPATCH_MODE: 'abandon', CBA_CLOUD_GATE: gateFor(manifest, { mode: 'abandon' }) },
        now: () => GATE_NOW,
        sleep: () => {},
        exec: () => assert.fail('abandon spawns no cdk child'),
      });
      assert.notEqual(r.exit, 0, 'the transport surprise still stops the run');
      assert.match(r.output, /PROVABLY ABSENT/);
      firstRecord = JSON.parse(fs.readFileSync(artifact, 'utf8'));
      // The reconciled record: B was deleted, and the artifact SAYS so — no false claim, no gap.
      assert.deepEqual(firstRecord.abandoned, [PILOT_STACK_NAMES[0], PILOT_STACK_NAMES[1]]);
      assert.deepEqual(firstRecord.reportedStackRecords, [PILOT_STACK_NAMES[0], PILOT_STACK_NAMES[1]], 'the reconciled set reports its stack record too');
    });
    // The continuation derived from that artifact ALONE is NOT mechanically blocked.
    withArtifact((artifact) => {
      const remaining = { ...fullDescribes() };
      delete remaining[PILOT_STACK_NAMES[0]];
      delete remaining[PILOT_STACK_NAMES[1]];
      const run = cloudRun({ describes: remaining, stackStatus: 'REVIEW_IN_PROGRESS' });
      const r = runDeployRelease([...releaseArgs(p, asm), '--artifact-out', artifact], {
        run,
        git: happyGit(),
        cdkJsonPath: CDK_JSON,
        env: { PATH: '/usr/bin', CORRELATION_ID: CORRELATION, DISPATCH_MODE: 'abandon', CBA_CLOUD_GATE: gateFor(manifest, { mode: 'abandon', decisionId: 'zamp-2026-08-02.b1-abandon-02', ...nextGateInputs(firstRecord) }) },
        now: () => GATE_NOW,
        sleep: () => {},
        exec: () => assert.fail('abandon spawns no cdk child'),
      });
      assert.equal(r.exit, 0, r.output);
      const record = JSON.parse(fs.readFileSync(artifact, 'utf8'));
      assert.equal(record.outcome, 'ABANDONED');
      assert.deepEqual(record.abandoned, [PILOT_STACK_NAMES[2], PILOT_STACK_NAMES[3]]);
      assert.deepEqual(record.alreadyAbsent, [PILOT_STACK_NAMES[0], PILOT_STACK_NAMES[1]]);
    });
  });
});

test('I5-4 REPRO: a timeout with an INCONCLUSIVE observation claims neither state — ABANDON_STATE_UNKNOWN', () => {
  withRelease((p, asm, manifest) => {
    withArtifact((artifact) => {
      let deletions = 0;
      let failedDelete = false;
      const run = cloudRun({
        stackStatus: 'REVIEW_IN_PROGRESS',
        onCall: (args) => {
          if (args[1] === 'delete-change-set') {
            deletions += 1;
            if (deletions === 2) {
              failedDelete = true;
              return { status: 254, stdout: '', stderr: 'Read timeout on endpoint URL' };
            }
          }
          // After the failed delete, the reconciliation read itself is inconclusive.
          if (failedDelete && args[1] === 'describe-change-set') {
            return { status: 254, stdout: '', stderr: 'Throttling: Rate exceeded' };
          }
          return null;
        },
      });
      const r = runDeployRelease([...releaseArgs(p, asm), '--artifact-out', artifact], {
        run,
        git: happyGit(),
        cdkJsonPath: CDK_JSON,
        env: { PATH: '/usr/bin', CORRELATION_ID: CORRELATION, DISPATCH_MODE: 'abandon', CBA_CLOUD_GATE: gateFor(manifest, { mode: 'abandon' }) },
        now: () => GATE_NOW,
        sleep: () => {},
        exec: () => assert.fail('abandon spawns no cdk child'),
      });
      assert.notEqual(r.exit, 0);
      assert.match(r.output, /ABANDON_STATE_UNKNOWN/);
      assert.match(r.output, /Read-only reconciliation .* is required before a new decision/);
      const record = JSON.parse(fs.readFileSync(artifact, 'utf8'));
      // NEVER a false abandoned: only the set deleted BEFORE the ambiguity is claimed.
      assert.deepEqual(record.abandoned, [PILOT_STACK_NAMES[0]]);
      assert.ok(record.refusals.includes('ABANDON_STATE_UNKNOWN'));
      assert.ok(!record.refusals.includes('ABANDON_DELETE_FAILED'), 'the unknown state is its own name, not a claimed failure');
      assert.deepEqual(record.reportedStackRecords, [PILOT_STACK_NAMES[0]], 'only the PROVEN prefix is reported');
      // Self-sufficiency survives: the unknown set keeps its digest on the map, so once Zamp
      // re-observes read-only, the next decision still derives from THIS artifact alone.
      const unknownEntry = record.changeSets.find((e) => e.stackName === PILOT_STACK_NAMES[1]);
      assert.match(unknownEntry.canonicalSha256, /^[0-9a-f]{64}$/);
    });
  });
});

test('I5-5 REPRO: timeout then a SUSTAINED DELETE_IN_PROGRESS — unknown, never a claimed rejection, and the polling is bounded', () => {
  withRelease((p, asm, manifest) => {
    withArtifact((artifact) => {
      let deletions = 0;
      let failedDelete = false;
      let reconcileReads = 0;
      const run = cloudRun({
        stackStatus: 'REVIEW_IN_PROGRESS',
        onCall: (args) => {
          if (args[1] === 'delete-change-set') {
            deletions += 1;
            if (deletions === 2) {
              failedDelete = true;
              return { status: 254, stdout: '', stderr: 'Read timeout on endpoint URL' };
            }
          }
          if (failedDelete && args[1] === 'describe-change-set') {
            // The accepted deletion is propagating: the describe SUCCEEDS, in a deleting status.
            reconcileReads += 1;
            const stackName = args[args.indexOf('--stack-name') + 1];
            return { status: 0, stdout: JSON.stringify({ ...fullDescribes()[stackName], Status: 'DELETE_IN_PROGRESS' }), stderr: '' };
          }
          return null;
        },
      });
      const r = runDeployRelease([...releaseArgs(p, asm), '--artifact-out', artifact], {
        run,
        git: happyGit(),
        cdkJsonPath: CDK_JSON,
        env: { PATH: '/usr/bin', CORRELATION_ID: CORRELATION, DISPATCH_MODE: 'abandon', CBA_CLOUD_GATE: gateFor(manifest, { mode: 'abandon' }) },
        now: () => GATE_NOW,
        sleep: () => {},
        exec: () => assert.fail('abandon spawns no cdk child'),
      });
      assert.notEqual(r.exit, 0);
      // A status-0 describe in a DELETING state is NOT proof the delete was rejected.
      assert.match(r.output, /ABANDON_STATE_UNKNOWN/);
      assert.equal(reconcileReads, 5, 'the re-observation is BOUNDED — five attempts, then the honest unknown');
      const record = JSON.parse(fs.readFileSync(artifact, 'utf8'));
      assert.deepEqual(record.abandoned, [PILOT_STACK_NAMES[0]], 'never a false abandoned');
      assert.ok(record.refusals.includes('ABANDON_STATE_UNKNOWN'));
      assert.ok(!record.refusals.includes('ABANDON_DELETE_FAILED'), 'a deleting status never claims the delete was rejected');
      const unknownEntry = record.changeSets.find((e) => e.stackName === PILOT_STACK_NAMES[1]);
      assert.match(unknownEntry.canonicalSha256, /^[0-9a-f]{64}$/, 'the digest stays on the map for the post-reconciliation derivation');
    });
  });
});

test('I5-5 REPRO: an initially-PRESENT response that converges to absence reconciles to ABANDONED', () => {
  withRelease((p, asm, manifest) => {
    withArtifact((artifact) => {
      let deletions = 0;
      let failedDelete = false;
      let reconcileReads = 0;
      const run = cloudRun({
        stackStatus: 'REVIEW_IN_PROGRESS',
        onCall: (args) => {
          if (args[1] === 'delete-change-set') {
            deletions += 1;
            if (deletions === 2) {
              failedDelete = true;
              return { status: 254, stdout: '', stderr: 'Read timeout on endpoint URL' };
            }
          }
          if (failedDelete && args[1] === 'describe-change-set') {
            reconcileReads += 1;
            // Two reads still see the set standing — then the accepted deletion lands.
            if (reconcileReads <= 2) return null; // the stub answers with the present fixture
            return { status: 254, stdout: '', stderr: 'ChangeSetNotFound' };
          }
          return null;
        },
      });
      const r = runDeployRelease([...releaseArgs(p, asm), '--artifact-out', artifact], {
        run,
        git: happyGit(),
        cdkJsonPath: CDK_JSON,
        env: { PATH: '/usr/bin', CORRELATION_ID: CORRELATION, DISPATCH_MODE: 'abandon', CBA_CLOUD_GATE: gateFor(manifest, { mode: 'abandon' }) },
        now: () => GATE_NOW,
        sleep: () => {},
        exec: () => assert.fail('abandon spawns no cdk child'),
      });
      assert.notEqual(r.exit, 0, 'the transport surprise still stops the run');
      assert.match(r.output, /PROVABLY ABSENT/);
      assert.equal(reconcileReads, 3, 'absence concludes the moment it is proven — no further polling');
      const record = JSON.parse(fs.readFileSync(artifact, 'utf8'));
      // An early present-looking read did NOT freeze the verdict: the deletion is on the record.
      assert.deepEqual(record.abandoned, [PILOT_STACK_NAMES[0], PILOT_STACK_NAMES[1]]);
      assert.deepEqual(record.reportedStackRecords, [PILOT_STACK_NAMES[0], PILOT_STACK_NAMES[1]]);
      assert.ok(!record.refusals.includes('ABANDON_STATE_UNKNOWN'));
    });
  });
});

test('I5-6 REPRO: a calm FINAL read does not erase the deletion glimpsed mid-window — unknown, never presence', () => {
  withRelease((p, asm, manifest) => {
    withArtifact((artifact) => {
      let deletions = 0;
      let failedDelete = false;
      let reconcileReads = 0;
      const run = cloudRun({
        stackStatus: 'REVIEW_IN_PROGRESS',
        onCall: (args) => {
          if (args[1] === 'delete-change-set') {
            deletions += 1;
            if (deletions === 2) {
              failedDelete = true;
              return { status: 254, stdout: '', stderr: 'Read timeout on endpoint URL' };
            }
          }
          if (failedDelete && args[1] === 'describe-change-set') {
            reconcileReads += 1;
            const stackName = args[args.indexOf('--stack-name') + 1];
            // Codex's exact sequence: deleting, transport error, malformed, deleting… and a
            // final read that looks perfectly calm.
            if (reconcileReads === 1 || reconcileReads === 4) return { status: 0, stdout: JSON.stringify({ ...fullDescribes()[stackName], Status: 'DELETE_IN_PROGRESS' }), stderr: '' };
            if (reconcileReads === 2) return { status: 255, stdout: '', stderr: 'Read timeout on endpoint URL' };
            if (reconcileReads === 3) return { status: 0, stdout: 'this is not json {', stderr: '' };
            return null; // read 5: the untouched fixture — well-formed, identity-matched, CREATE_COMPLETE
          }
          return null;
        },
      });
      const r = runDeployRelease([...releaseArgs(p, asm), '--artifact-out', artifact], {
        run,
        git: happyGit(),
        cdkJsonPath: CDK_JSON,
        env: { PATH: '/usr/bin', CORRELATION_ID: CORRELATION, DISPATCH_MODE: 'abandon', CBA_CLOUD_GATE: gateFor(manifest, { mode: 'abandon' }) },
        now: () => GATE_NOW,
        sleep: () => {},
        exec: () => assert.fail('abandon spawns no cdk child'),
      });
      assert.notEqual(r.exit, 0);
      assert.equal(reconcileReads, 5, 'the whole window is observed');
      assert.match(r.output, /ABANDON_STATE_UNKNOWN/);
      const record = JSON.parse(fs.readFileSync(artifact, 'utf8'));
      assert.deepEqual(record.abandoned, [PILOT_STACK_NAMES[0]], 'never a false abandoned');
      assert.ok(record.refusals.includes('ABANDON_STATE_UNKNOWN'));
      assert.ok(!record.refusals.includes('ABANDON_DELETE_FAILED'), 'the tainted window never claims the delete was rejected');
    });
  });
});

test('I5-6 REPRO: a status outside the documented enum is a fact this code cannot claim — unknown, never presence', () => {
  withRelease((p, asm, manifest) => {
    withArtifact((artifact) => {
      let deletions = 0;
      let failedDelete = false;
      const run = cloudRun({
        stackStatus: 'REVIEW_IN_PROGRESS',
        onCall: (args) => {
          if (args[1] === 'delete-change-set') {
            deletions += 1;
            if (deletions === 2) {
              failedDelete = true;
              return { status: 254, stdout: '', stderr: 'Read timeout on endpoint URL' };
            }
          }
          if (failedDelete && args[1] === 'describe-change-set') {
            // Every read is well-formed and identity-matched — in a status the enum does not
            // contain. A blacklist would call this presence; the allowlist refuses to.
            const stackName = args[args.indexOf('--stack-name') + 1];
            return { status: 0, stdout: JSON.stringify({ ...fullDescribes()[stackName], Status: 'ARCHIVED' }), stderr: '' };
          }
          return null;
        },
      });
      const r = runDeployRelease([...releaseArgs(p, asm), '--artifact-out', artifact], {
        run,
        git: happyGit(),
        cdkJsonPath: CDK_JSON,
        env: { PATH: '/usr/bin', CORRELATION_ID: CORRELATION, DISPATCH_MODE: 'abandon', CBA_CLOUD_GATE: gateFor(manifest, { mode: 'abandon' }) },
        now: () => GATE_NOW,
        sleep: () => {},
        exec: () => assert.fail('abandon spawns no cdk child'),
      });
      assert.notEqual(r.exit, 0);
      assert.match(r.output, /ABANDON_STATE_UNKNOWN/);
      const record = JSON.parse(fs.readFileSync(artifact, 'utf8'));
      assert.deepEqual(record.abandoned, [PILOT_STACK_NAMES[0]], 'never a false abandoned');
      assert.ok(record.refusals.includes('ABANDON_STATE_UNKNOWN'));
      assert.ok(!record.refusals.includes('ABANDON_DELETE_FAILED'));
    });
  });
});

test('I5-3: an absence AFTER the first present entry is a state the lane cannot have produced — refused', () => {
  withRelease((p, asm, manifest) => {
    withArtifact((artifact) => {
      // Only B (the SECOND position) is absent — an ordered deletion can never leave this shape.
      const entries = ORDERED_IDS.map((id, i) => canonicalChangeSet(id, PILOT_STACK_NAMES[i], fullDescribes()[PILOT_STACK_NAMES[i]]));
      const holed = { ...fullDescribes() };
      delete holed[PILOT_STACK_NAMES[1]];
      const run = cloudRun({ describes: holed });
      const r = runDeployRelease([...releaseArgs(p, asm), '--artifact-out', artifact], {
        run,
        git: happyGit(),
        cdkJsonPath: CDK_JSON,
        env: {
          PATH: '/usr/bin',
          CORRELATION_ID: CORRELATION,
          DISPATCH_MODE: 'abandon',
          CBA_CLOUD_GATE: gateFor(manifest, { mode: 'abandon', absentEntryDigests: [entryDigestOf(entries[1])] }),
        },
        now: () => GATE_NOW,
        sleep: () => {},
        exec: () => assert.fail('abandon spawns no cdk child'),
      });
      assert.notEqual(r.exit, 0);
      assert.match(r.output, /ABANDON_NOT_A_PREFIX/);
      assert.equal(run.of('delete-change-set').length, 0, 'even a root that would close deletes NOTHING outside the prefix law');
      const record = JSON.parse(fs.readFileSync(artifact, 'utf8'));
      assert.equal(record.outcome, 'REFUSED');
      assert.deepEqual(record.abandoned, []);
    });
  });
});

test('I5-2: the continuation accepts NO recreated set, NO fresh-gate absence, NO leftover digest', () => {
  withRelease((p, asm, manifest) => {
    const attemptAbandon = (describes, over) => {
      let out;
      withArtifact((artifact) => {
        const run = cloudRun({ describes });
        const r = runDeployRelease([...releaseArgs(p, asm), '--artifact-out', artifact], {
          run,
          git: happyGit(),
          cdkJsonPath: CDK_JSON,
          env: { PATH: '/usr/bin', CORRELATION_ID: CORRELATION, DISPATCH_MODE: 'abandon', CBA_CLOUD_GATE: gateFor(manifest, { mode: 'abandon', ...over }) },
          now: () => GATE_NOW,
          sleep: () => {},
          exec: () => assert.fail('abandon spawns no cdk child'),
        });
        out = { r, deletions: run.of('delete-change-set').length, record: JSON.parse(fs.readFileSync(artifact, 'utf8')) };
      });
      return out;
    };
    const minusFirst = { ...fullDescribes() };
    delete minusFirst[PILOT_STACK_NAMES[0]];
    // A recreated/foreign prefix: the supplied digest does not fold into the reviewed root.
    const forged = attemptAbandon(minusFirst, { absentEntryDigests: ['f'.repeat(64)] });
    assert.notEqual(forged.r.exit, 0);
    assert.match(forged.r.output, /PLAN_CHANGED/);
    assert.equal(forged.deletions, 0, 'a dead root deletes NOTHING');
    // A fresh abandon (no digests) meeting an absent set is not a continuation — it refuses.
    const fresh = attemptAbandon(minusFirst, {});
    assert.notEqual(fresh.r.exit, 0);
    assert.match(fresh.r.output, /CHANGE_SET_MISSING/);
    assert.equal(fresh.deletions, 0);
    // A leftover digest — more absences claimed than found — is the same refusal.
    const entries = ORDERED_IDS.map((id, i) => canonicalChangeSet(id, PILOT_STACK_NAMES[i], fullDescribes()[PILOT_STACK_NAMES[i]]));
    const leftover = attemptAbandon(minusFirst, { absentEntryDigests: [entryDigestOf(entries[0]), entryDigestOf(entries[1])] });
    assert.notEqual(leftover.r.exit, 0);
    assert.match(leftover.r.output, /CHANGE_SET_MISSING/);
    assert.equal(leftover.deletions, 0);
  });
});

test('I5-2: absentEntryDigests is abandon-only — every other shape is malformed', () => {
  withRelease((p, asm, manifest) => {
    const attemptGate = (gate) => {
      let out;
      withArtifact((artifact) => {
        const r = runDeployRelease([...releaseArgs(p, asm), '--artifact-out', artifact], {
          run: cloudRun(),
          git: happyGit(),
          cdkJsonPath: CDK_JSON,
          env: { PATH: '/usr/bin', CORRELATION_ID: CORRELATION, CBA_CLOUD_GATE: gate },
          now: () => GATE_NOW,
          sleep: () => {},
          exec: happyExec,
        });
        out = r;
      });
      return out;
    };
    for (const broken of [
      gateFor(manifest, { absentEntryDigests: ['a'.repeat(64)] }), // deploy mode may not carry it
      gateFor(manifest, { mode: 'abandon', absentEntryDigests: [] }), // empty list is not a continuation
      gateFor(manifest, { mode: 'abandon', absentEntryDigests: ['a'.repeat(64), 'a'.repeat(64)] }), // duplicates
      gateFor(manifest, { mode: 'abandon', absentEntryDigests: ['not-a-digest'] }),
    ]) {
      const r = attemptGate(broken);
      assert.equal(r.exit, 1);
      assert.match(r.output, /CLOUD_GATE_MALFORMED/);
    }
  });
});

test('I5-2: a MODE_MISMATCH refusal publishes under the NEUTRAL name — never the effect the gate claimed', () => {
  withRelease((p, asm, manifest) => {
    withArtifact((artifact) => {
      const r = runDeployRelease([...releaseArgs(p, asm), '--artifact-out', artifact], {
        run: cloudRun(),
        git: happyGit(),
        cdkJsonPath: CDK_JSON,
        env: { PATH: '/usr/bin', CORRELATION_ID: CORRELATION, DISPATCH_MODE: 'abandon', CBA_CLOUD_GATE: gateFor(manifest) },
        now: () => GATE_NOW,
        sleep: () => {},
        exec: () => assert.fail('a mismatched run spawns nothing'),
      });
      assert.notEqual(r.exit, 0);
      assert.match(r.output, /MODE_MISMATCH/);
      const record = JSON.parse(fs.readFileSync(artifact, 'utf8'));
      assert.equal(record.mode, null, 'the gate\'s claimed mode must NOT reach the record — the artifact routes to evidence.json');
      assert.equal(record.outcome, 'REFUSED');
      assert.ok(record.refusals.includes('MODE_MISMATCH'));
    });
  });
});

test('I5-2: an inconclusive describe-stacks reports UNVERIFIABLE — never "no record remains"', () => {
  withRelease((p, asm, manifest) => {
    withArtifact((artifact) => {
      const run = cloudRun({
        onCall: (args) => (args[1] === 'describe-stacks' ? { status: 254, stdout: '', stderr: 'AccessDenied' } : null),
      });
      const r = runDeployRelease([...releaseArgs(p, asm), '--artifact-out', artifact], {
        run,
        git: happyGit(),
        cdkJsonPath: CDK_JSON,
        env: { PATH: '/usr/bin', CORRELATION_ID: CORRELATION, DISPATCH_MODE: 'abandon', CBA_CLOUD_GATE: gateFor(manifest, { mode: 'abandon' }) },
        now: () => GATE_NOW,
        sleep: () => {},
        exec: () => assert.fail('abandon spawns no cdk child'),
      });
      assert.equal(r.exit, 0, r.output);
      const record = JSON.parse(fs.readFileSync(artifact, 'utf8'));
      assert.equal(record.reportedStackRecords.length, 4, 'every query failed — every stack is on the record as unverifiable');
      for (const line of record.reportedStackRecords) assert.match(line, /\(status unverifiable\)$/);
      assert.ok(!r.output.includes('No stack record remains'), 'an unanswered question is never a clean bill');
      assert.match(r.output, /status unverifiable/);
    });
  });
});
