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
// And a whole section attacks the OUTPUT rather than the verdict: a preflight runs in CI and its
// output lands in a public log. Codex's Slice A review reproduced role-ARN and credential-shaped
// material in this command's output, so leakage is now tested as adversarially as the logic.
const test = require('node:test');
const assert = require('node:assert/strict');
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
const { runDeployPreflight, contextDigest, BOUND_CONTEXT_KEYS } = require('../bin/deploy-preflight');
const { DEFAULT_AUTH_URLS } = require('../lib/context');

const CDK_JSON = path.join(__dirname, '..', 'cdk.json');
const SHA = 'a'.repeat(40);

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
  // Two different operator mistakes with two different fixes; conflating them costs a deploy cycle.
  const result = run({ authCallbackUrls: '["https://pilot.invalid/auth/callback"]' });
  assert.deepEqual(codesFor(result, 'PREFLIGHT-1'), ['PLACEHOLDER_FROM_OVERRIDE']);
});

test('PREFLIGHT-1 reads the EFFECTIVE value, so a misspelled context key does not fool it', () => {
  // `authCallbackUrl` (singular) is not the key the stack reads: the override never applies and the
  // default survives, which is indistinguishable from "no override" unless the resolved value is read.
  const result = evaluatePreflight({
    environment: 'pilot',
    context: { authCallbackUrl: '["https://app.example.com/auth/callback"]', authLogoutUrls: '["https://app.example.com/"]', authDomainPrefix: 'cba-study-coach-pilot-7f3d' },
    domainProbe: goodProbe(),
  });
  assert.deepEqual(codesFor(result, 'PREFLIGHT-1'), ['PLACEHOLDER_FROM_DEFAULT']);
});

test('PREFLIGHT-1 decides on the hostname, not on a substring of the URL', () => {
  assert.equal(isReservedPlaceholder('https://app.example.com/theme.invalid.css'), false);
  // A live host that merely starts with the placeholder label is a REAL origin — a substring rule
  // would wave it through as "obviously the placeholder".
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

/* ================= NON-LEAKAGE ================================================================= */
//
// Everything below attacks the OUTPUT. A refusal must say WHICH field and WHY, and nothing else.

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
    { run: () => ({ status: 0, stdout: '{}', stderr: '' }), cdkJsonPath: CDK_JSON, env: { CBA_EXPECTED_USER_POOL_ID: POISON.poolId } },
  );
  assert.equal(exit, 1);
  assertClean(output, 'refusal output');
  // It still has to be USEFUL: field names and codes are what an operator acts on.
  assert.match(output, /authCallbackUrls/);
  assert.match(output, /authDomainPrefix/);
  assert.match(output, /\[[A-Z_]+\]/);
});

test('AWS stderr never reaches the output — it can carry an account id or an ARN', () => {
  const { output, exit } = runDeployPreflight(cliArgs(), {
    run: () => ({ status: 254, stdout: '', stderr: `AccessDenied: User ${POISON.roleArn} is not authorized` }),
    cdkJsonPath: CDK_JSON,
    env: {},
  });
  assert.equal(exit, 1);
  assertClean(output, 'probe error output');
  assert.match(output, /PROBE_FAILED/);
});

test("another tenant's user pool id never reaches the output", () => {
  const { output, exit } = runDeployPreflight(cliArgs(), {
    run: () => ({ status: 0, stdout: JSON.stringify({ DomainDescription: { UserPoolId: POISON.poolId } }), stderr: '' }),
    cdkJsonPath: CDK_JSON,
    env: {},
  });
  assert.equal(exit, 1);
  assertClean(output, 'taken-domain output');
  assert.match(output, /PROBE_TAKEN/);
});

test('an unrecognised argument is refused without echoing it — argv can hold a mistyped secret', () => {
  const { output, exit } = runDeployPreflight([`--${POISON.token}`], { cdkJsonPath: CDK_JSON, env: {} });
  assert.equal(exit, 2);
  assertClean(output, 'usage error');
});

test('the JSON output carries codes and fields only, never values', () => {
  const { output } = runDeployPreflight(
    ['--environment', 'pilot', '--release-sha', SHA, '--region', 'us-east-1', '--json', '-c', `authDomainPrefix=${POISON.accountId}`],
    { run: () => ({ status: 0, stdout: '{}', stderr: '' }), cdkJsonPath: CDK_JSON, env: {} },
  );
  assertClean(output, 'json output');
  const parsed = JSON.parse(output);
  assert.equal(parsed.ok, false);
  for (const f of parsed.failures) assert.deepEqual(Object.keys(f).sort(), ['check', 'code', 'field']);
});

/* ================= the collector, with no AWS anywhere ========================================= */

test('the expected pool id is read from the environment, never from an argument', () => {
  // A caller who can name "our" pool can redefine which existing domain a deploy adopts.
  assert.equal(runDeployPreflight([...cliArgs(), '--expected-user-pool-id', 'us-east-1_X'], { cdkJsonPath: CDK_JSON, env: {} }).exit, 2);

  const adopted = runDeployPreflight(cliArgs(), {
    run: () => ({ status: 0, stdout: JSON.stringify({ DomainDescription: { UserPoolId: 'us-east-1_Ours' } }), stderr: '' }),
    cdkJsonPath: CDK_JSON,
    env: { CBA_EXPECTED_USER_POOL_ID: 'us-east-1_Ours' },
  });
  assert.equal(adopted.exit, 0, adopted.output);

  const notOurs = runDeployPreflight(cliArgs(), {
    run: () => ({ status: 0, stdout: JSON.stringify({ DomainDescription: { UserPoolId: 'us-east-1_Ours' } }), stderr: '' }),
    cdkJsonPath: CDK_JSON,
    env: {},
  });
  assert.equal(notOurs.exit, 1, 'without trusted state, an existing domain is not ours');
});

test('a release SHA is required, and only a full 40-hex one is accepted', () => {
  for (const bad of [[], ['--environment', 'pilot'], ['--environment', 'pilot', '--release-sha', 'abc'], ['--environment', 'pilot', '--release-sha', 'A'.repeat(40)], ['--environment', 'pilot', '--release-sha', 'main']]) {
    assert.equal(runDeployPreflight(bad, { cdkJsonPath: CDK_JSON, env: {} }).exit, 2, JSON.stringify(bad));
  }
});

test('the manifest is written only on a pass, and binds the release, environment and context', () => {
  const written = [];
  const writeFile = (p, data) => written.push({ p, data });

  const refused = runDeployPreflight(
    ['--environment', 'pilot', '--release-sha', SHA, '--region', 'us-east-1', '--manifest-out', '/tmp/x.json'],
    { run: () => ({ status: 0, stdout: '{}', stderr: '' }), cdkJsonPath: CDK_JSON, env: {}, writeFile },
  );
  assert.equal(refused.exit, 1);
  assert.equal(written.length, 0, 'a manifest for a refused configuration must not exist');
  assert.equal(refused.manifest, null);

  const passed = runDeployPreflight([...cliArgs(), '--manifest-out', '/tmp/x.json'], {
    run: () => ({ status: 0, stdout: '{}', stderr: '' }),
    cdkJsonPath: CDK_JSON,
    env: {},
    writeFile,
  });
  assert.equal(passed.exit, 0, passed.output);
  assert.equal(written.length, 1);
  const manifest = JSON.parse(written[0].data);
  assert.equal(manifest.releaseSha, SHA);
  assert.equal(manifest.environment, 'pilot');
  assert.match(manifest.contextDigest, /^[0-9a-f]{64}$/);
  assert.deepEqual(manifest.boundContextKeys, [...BOUND_CONTEXT_KEYS].sort());
  assertClean(written[0].data, 'manifest');
});

test('the context digest changes when any bound value changes, and is order-independent', () => {
  const base = { releaseSha: SHA, environment: 'pilot', context: goodContext() };
  const d = contextDigest(base);

  // Same values, different insertion order -> same digest, so a deploy can reproduce it.
  const reordered = { ...base, context: { authDomainPrefix: goodContext().authDomainPrefix, authLogoutUrls: goodContext().authLogoutUrls, authCallbackUrls: goodContext().authCallbackUrls } };
  assert.equal(contextDigest(reordered), d);

  // Any bound change -> different digest. This is what stops a deploy from using other values.
  for (const over of [
    { authCallbackUrls: '["https://other.example.com/auth/callback"]' },
    { authLogoutUrls: '["https://other.example.com/"]' },
    { authDomainPrefix: 'cba-study-coach-pilot-0000' },
  ]) {
    assert.notEqual(contextDigest({ ...base, context: goodContext(over) }), d, JSON.stringify(over));
  }
  assert.notEqual(contextDigest({ ...base, releaseSha: 'b'.repeat(40) }), d, 'the release is bound too');
  assert.notEqual(contextDigest({ ...base, environment: 'dev' }), d, 'the environment is bound too');

  // Unbound context does NOT move the digest: binding unrelated keys would make it brittle without
  // making the deploy safer.
  assert.equal(contextDigest({ ...base, context: goodContext({ someOtherKey: 'x' }) }), d);
});

test('the probe is read-only, bounded, and never runs without a region or a prefix', () => {
  const calls = [];
  runDeployPreflight(cliArgs(), {
    run: (args, o) => {
      calls.push({ args, o });
      return { status: 0, stdout: '{}', stderr: '' };
    },
    cdkJsonPath: CDK_JSON,
    env: {},
  });
  assert.equal(calls.length, 1, 'exactly one AWS call');
  const [{ args, o }] = calls;

  // Structural, not by substring: `--output` contains "put", so a substring sweep both flags a
  // harmless flag and misses a mutating operation that happens not to contain a listed word.
  const [service, operation] = args;
  assert.equal(service, 'cognito-idp');
  assert.ok(operation.startsWith('describe-'), operation);
  for (const verb of ['create-', 'update-', 'delete-', 'put-', 'set-', 'add-', 'remove-', 'start-', 'stop-', 'admin-']) {
    assert.equal(operation.startsWith(verb), false, `${operation} mutates`);
  }
  assert.ok(o.timeoutMs > 0, 'the probe must be time-bounded');
  assert.equal(args.filter((a) => !String(a).startsWith('-')).some((a) => ['secretsmanager', 'ssm', 'cloudformation', 'sts'].includes(a)), false);

  // No region, and no prefix, each mean the probe must not be attempted at all.
  const noRegion = runDeployPreflight(
    ['--environment', 'pilot', '--release-sha', SHA, '-c', 'authDomainPrefix=cba-x'],
    { run: () => assert.fail('the probe must not run without a region'), cdkJsonPath: CDK_JSON, env: {} },
  );
  assert.equal(noRegion.exit, 1);
  const noPrefix = runDeployPreflight(
    ['--environment', 'pilot', '--release-sha', SHA, '--region', 'us-east-1'],
    { run: () => assert.fail('the probe must not run without a prefix'), cdkJsonPath: CDK_JSON, env: {} },
  );
  assert.equal(noPrefix.exit, 1);
});

test('--skip-probe fails PREFLIGHT-2 by design: skipping the question is not answering it', () => {
  const { exit, output } = runDeployPreflight([...cliArgs(), '--skip-probe'], {
    run: () => assert.fail('--skip-probe must not call AWS'),
    cdkJsonPath: CDK_JSON,
    env: {},
  });
  assert.equal(exit, 1);
  assert.match(output, /PROBE_NOT_RUN/);
});

test('a committed cdk.json value counts as explicitly supplied; the in-code fallback does not', () => {
  const withCommitted = runDeployPreflight(
    ['--environment', 'pilot', '--release-sha', SHA, '--region', 'us-east-1', '-c', 'authCallbackUrls=["https://app.example.com/auth/callback"]', '-c', 'authLogoutUrls=["https://app.example.com/"]'],
    { run: () => ({ status: 0, stdout: '{}', stderr: '' }), cdkJsonPath: path.join(__dirname, 'fixtures', 'cdk-with-prefix.json'), env: {} },
  );
  assert.equal(withCommitted.exit, 0, withCommitted.output);

  const withoutCommitted = runDeployPreflight(
    ['--environment', 'pilot', '--release-sha', SHA, '--region', 'us-east-1', '-c', 'authCallbackUrls=["https://app.example.com/auth/callback"]', '-c', 'authLogoutUrls=["https://app.example.com/"]'],
    { run: () => ({ status: 0, stdout: '{}', stderr: '' }), cdkJsonPath: CDK_JSON, env: {} },
  );
  assert.equal(withoutCommitted.exit, 1);
  assert.match(withoutCommitted.output, /PREFIX_NOT_SUPPLIED/);
});
