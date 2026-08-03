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
  for (const over of [
    { githubTrustSub: 'repo:attacker/fork:ref:refs/heads/main' },
    { corsAllowedOrigins: '["https://attacker.example"]' },
    { githubOidcProviderArn: `arn:aws:iam::${'1'.repeat(12)}:oidc-provider/other` },
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
    for (const m of src.matchAll(/(?:\bctx|getContext)\((?:this\.node, )?'([^']+)'/g)) found.add(m[1]);
  }
  found.delete('environment'); // bound separately in the digest
  assert.ok(found.size >= 9, 'the discovery scan must actually find the known keys');
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
const { sanitizeChildOutput, planDigestOf, canonicalChangeSet } = require('../bin/deploy-release');

/** The reviewed execution order and this (pilot) manifest's CloudFormation stack names. */
const ORDERED_IDS = ['IdentityStack', 'DataStack', 'ApiStack', 'ObservabilityStack'];
const PILOT_STACK_NAMES = ORDERED_IDS.map((id) => `cba-study-coach-pilot-${id.replace(/Stack$/, '').toLowerCase()}`);

/** One fake describe-change-set body per stack — poisonable and overridable per test. */
const describedFor = (stackName, over = {}) => ({
  ChangeSetId: `arn:aws:cloudformation:us-east-1:${ACCOUNT}:changeSet/cba-70/${stackName}`,
  Status: 'CREATE_COMPLETE',
  ExecutionStatus: 'AVAILABLE',
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
    if (args[0] === 'cloudformation' && args[1] === 'describe-stacks') return { status: 0, stdout: JSON.stringify({ Stacks: [{ StackStatus: stackStatus }] }), stderr: '' };
    return stubAws()(args, opts);
  };
  fn.calls = calls;
  fn.of = (verb) => calls.filter((c) => c.args[1] === verb);
  return fn;
}

/** A valid deploy-mode cloud gate for THIS manifest: bounded window around GATE_NOW, a decision
 * id, and the digest of the default fake change sets. */
const gateFor = (manifest, over = {}) =>
  JSON.stringify({
    issue: 70,
    environment: manifest.environment,
    releaseSha: manifest.releaseSha,
    assemblyDigest: manifest.assemblyDigest,
    mode: 'deploy',
    decisionId: 'zamp-2026-08-02.b1-deploy-01',
    approvedAt: '2026-08-02T11:50:00Z',
    expiresAt: '2026-08-02T12:30:00Z',
    planDigest: digestOf(fullDescribes()),
    stacks: [...ORDERED_IDS],
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
      PILOT_STACK_NAMES.map((n) => `arn:aws:cloudformation:us-east-1:${ACCOUNT}:changeSet/cba-70/${n}`),
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
      ['another assembly', { assemblyDigest: '0'.repeat(64) }],
    ]) {
      const r = attempt(gateFor(manifest, over));
      assert.equal(r.exit, 1, label);
      assert.match(r.output, /CLOUD_GATE_MISMATCH/, label);
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
    for (const name of PILOT_STACK_NAMES) describesB[name].ChangeSetId = `${describesB[name].ChangeSetId}/recreated`;
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
  assert.match(render(planA), /arn:aws:iam::\[acct#[0-9a-f]{32}\]:role\/cba-study-coach-gha-deploy-dev/, 'the EXPECTED principal is classifiable by its visible path');
  assert.match(render(planB), /arn:aws:iam::\[acct#[0-9a-f]{32}\]:role\/evil-admin/, 'an ATTACKER principal is exposed by its visible path — not hidden behind an opaque hash');
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
        if (args[1] === 'execute-change-set') order.push(`execute:${args[args.indexOf('--change-set-name') + 1].split('/').pop()}`);
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
    assert.deepEqual(order, ['print', 'execute:cba-study-coach-pilot-identity', 'execute:cba-study-coach-pilot-api', 'execute:cba-study-coach-pilot-observability']);
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
      run2.of('execute-change-set').map((c) => c.args[c.args.indexOf('--change-set-name') + 1].split('/').pop()),
      wave1Names,
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
    assert.match(r.output, /before: "512"/, 'the before value is visible');
    assert.match(r.output, /after: {2}"1024"/, 'the after value is visible');
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
  assert.match(unknown, /\[unexpected-host#[0-9a-f]{32}\]/);
  assert.equal(unknown.includes('attacker.example'), false);
  // Generated execute-api labels stay pseudonymized — the service domain stays legible.
  const api = fingerprintSanitize('https://ab12cd34.execute-api.us-east-1.amazonaws.com/prod');
  assert.equal(api.includes('ab12cd34'), false);
  assert.match(api, /\[api#[0-9a-f]{32}\]\.execute-api\.us-east-1\.amazonaws\.com\/prod/);
});

test('ROUND-7: generated identifiers and query values never render — names this project chose always do', () => {
  const { fingerprintSanitize } = require('../bin/deploy-release');
  // KMS key UUIDs are generated, not repository-public.
  const kms = fingerprintSanitize(`arn:aws:kms:us-east-1:${ACCOUNT}:key/12345678-1234-1234-1234-1234567890ab`);
  assert.equal(kms.includes('12345678-1234-1234-1234-1234567890ab'), false, 'a key UUID must never render');
  assert.match(kms, /key\/\[key#[0-9a-f]{32}\]/);
  // API Gateway api ids are generated.
  const api = fingerprintSanitize('arn:aws:apigateway:us-east-1::/apis/a1b2c3d4/routes/xyz9876');
  assert.equal(api.includes('a1b2c3d4'), false, 'an api id must never render');
  assert.equal(api.includes('xyz9876'), false, 'a route id must never render');
  // CloudFormation stack ids are generated; the stack NAME is project-chosen and must stay.
  const cfn = fingerprintSanitize(`arn:aws:cloudformation:us-east-1:${ACCOUNT}:stack/cba-study-coach-dev-api/deadbeef-1234-1234-1234-abcdefabcdef`);
  assert.equal(cfn.includes('deadbeef-1234-1234-1234-abcdefabcdef'), false, 'a stack id must never render');
  assert.match(cfn, /stack\/cba-study-coach-dev-api\/\[id#[0-9a-f]{32}\]/, 'the project-chosen stack name stays classifiable');
  // URL query values carry tokens — stripped, with the stripping visible.
  const url = fingerprintSanitize('https://x.workers.dev/reset?token=secret-value');
  assert.equal(url.includes('secret-value'), false, 'a query token must never render');
  assert.match(url, /\/reset\?\[query-redacted\]/);
  // A free-standing UUID (outside any ARN) is generated material too.
  assert.equal(fingerprintSanitize('key id 12345678-1234-1234-1234-1234567890ab').includes('1234567890ab'), false);
  // And an UNKNOWN service's resource is pseudonymized whole — unknown is not proven public.
  const foreign = fingerprintSanitize(`arn:aws:someservice:us-east-1:${ACCOUNT}:widget/private-name`);
  assert.equal(foreign.includes('private-name'), false);
  assert.match(foreign, /\[resource#[0-9a-f]{32}\]/);
  // IAM role paths remain verbatim — that is the round-6 contract, unchanged.
  assert.match(fingerprintSanitize(`arn:aws:iam::${ACCOUNT}:role/evil-admin`), /role\/evil-admin/);
});

test('poisoned child output cannot leak identifiers — redaction is by shape, not by known value', () => {
  const { sanitizeChildOutput } = require('../bin/deploy-release');
  const POISONS = [
    'arn:aws:cloudformation:us-east-1:111122223333:stack/cba-study-coach-dev-api/deadbeef',
    'arn:aws:iam::111122223333:role/cba-study-coach-gha-deploy-dev',
    'https://abc123xyz.execute-api.us-east-1.amazonaws.com/',
    'us-east-1_AbCdEf123',
    '111122223333',
  ];
  const clean = sanitizeChildOutput(
    `Outputs:\nApiStack.BffEndpoint = ${POISONS[2]}\nIdentityStack.UserPoolId = ${POISONS[3]}\nStack ARN:\n${POISONS[0]}\nrole ${POISONS[1]}\naccount ${POISONS[4]} done\nprogress-line-stays`,
  );
  for (const poison of POISONS) assert.equal(clean.includes(poison), false, poison);
  assert.match(clean, /\[arn-redacted\]/);
  assert.match(clean, /\[url-redacted\]/);
  assert.match(clean, /\[user-pool-redacted\]/);
  assert.match(clean, /\[account-redacted\]/);
  assert.match(clean, /progress-line-stays/, 'sanitization redacts identifiers, not the record of what happened');

  // And end to end: describe output carrying identifiers in its change details renders sanitized
  // — the digest saw the raw bytes, the human-facing record never does.
  withRelease((p, asm, manifest) => {
    const describes = fullDescribes({
      [PILOT_STACK_NAMES[0]]: {
        Changes: [{ Type: 'Resource', ResourceChange: { Action: 'Modify', LogicalResourceId: `Role ${POISONS[1]}`, ResourceType: `Type ${POISONS[4]}` } }],
      },
    });
    const r = runDeployRelease(releaseArgs(p, asm), deployOpts(manifest, {
      run: cloudRun({ describes }),
      env: { CBA_CLOUD_GATE: gateFor(manifest, { planDigest: digestOf(describes) }) },
    }));
    assert.equal(r.exit, 0, r.output);
    for (const poison of POISONS) assert.equal(r.output.includes(poison), false, poison);
  });

  // A failing PREPARE child's output is sanitized too, on the refusal path.
  withRelease((p, asm, manifest) => {
    const r = runDeployRelease(releaseArgs(p, asm), {
      run: cloudRun(),
      git: happyGit(),
      cdkJsonPath: CDK_JSON,
      env: { CBA_CLOUD_GATE: gateFor(manifest, { mode: 'plan_only', planDigest: null }) },
      now: () => GATE_NOW,
      sleep: () => {},
      exec: () => ({ status: 1, stdout: POISONS.join(' '), stderr: POISONS[0] }),
    });
    assert.equal(r.exit, 1);
    for (const poison of POISONS) assert.equal(r.output.includes(poison), false, poison);
  });
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
