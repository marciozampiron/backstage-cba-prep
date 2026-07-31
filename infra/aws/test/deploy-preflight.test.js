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

/** A deterministic fake cloud assembly, shared by producer and consumer tests so digests match. */
const ASSEMBLY_FILES = {
  'DataStack.template.json': '{"Resources":{"Table":{"Type":"AWS::DynamoDB::Table"}}}',
  'IdentityStack.template.json': '{"Resources":{"Pool":{"Type":"AWS::Cognito::UserPool"}}}',
};

function withDir(files, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cba-asm-'));
  try {
    for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), body);
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
  assert.deepEqual(manifest.target, { service: MANIFEST_TARGET_SERVICE });
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
    ['the target service rewritten', { ...manifest, target: { service: 'cloudflare' } }],
    ['an extra target key', { ...manifest, target: { service: MANIFEST_TARGET_SERVICE, extra: true } }],
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

test('deploy-release deploys the VERIFIED ASSEMBLY in the VERIFIED REGION — both by construction', () => {
  withRelease((p, asm) => {
    const execs = [];
    const r = runDeployRelease(releaseArgs(p, asm), {
      run: stubAws(),
      git: happyGit(),
      cdkJsonPath: CDK_JSON,
      env: { PATH: '/usr/bin', AWS_REGION: 'us-west-2', AWS_DEFAULT_REGION: 'us-west-2', CDK_DEFAULT_REGION: 'us-west-2' },
      exec: (args, childEnv) => {
        execs.push({ args, childEnv });
        return { status: 0 };
      },
    });
    assert.equal(r.exit, 0, r.output);
    assert.equal(execs.length, 1, 'exactly one deploy');
    const { args, childEnv } = execs[0];
    // The child deploys the digested assembly via --app — never mutable source, never a -c flag.
    assert.deepEqual(args, ['cdk', 'deploy', '--all', '--require-approval', 'never', '--app', asm]);
    // ROUND-4 REPRO 2 (region): the ambient environment said us-west-2 everywhere; the verified
    // region is imposed on every variable the CDK or the SDK reads.
    assert.equal(childEnv.AWS_REGION, 'us-east-1');
    assert.equal(childEnv.AWS_DEFAULT_REGION, 'us-east-1');
    assert.equal(childEnv.CDK_DEFAULT_REGION, 'us-east-1');
    assert.equal(childEnv.PATH, '/usr/bin', 'the rest of the environment passes through');
  });
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

    const childFails = runDeployRelease(releaseArgs(p, asm), { run: stubAws(), git: happyGit(), cdkJsonPath: CDK_JSON, env: {}, exec: () => ({ status: 3 }) });
    assert.equal(childFails.exit, 1, 'a failing child must not read as a deployed release');
    assert.equal(childFails.executed, true);
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
