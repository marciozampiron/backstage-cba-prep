// Adversarial controls for the #70 deploy preflight.
//
// Every test is OFFLINE. The evaluator is pure and the collector takes an injected runner, so no
// test reaches AWS, spends anything, or needs a deployed environment.
//
// The shape of these tests is deliberate: a gate is only worth what its REFUSALS are worth, so each
// condition is attacked from every direction that would make it silently pass — a default that
// survived, an override that carries the placeholder, a probe that errored, a prefix that exists but
// was never supplied. A positive control sits beside each so "it always fails" cannot masquerade as
// safety.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const {
  PROBE,
  PREFIX_MAX,
  RESERVED_WORDS,
  PreflightError,
  isReservedPlaceholder,
  resolveAuthUrls,
  evaluatePreflight,
} = require('../lib/deploy-preflight');
const { runDeployPreflight } = require('../bin/deploy-preflight');
const { DEFAULT_AUTH_URLS, defaultAuthDomainPrefix } = require('../lib/context');

const CDK_JSON = path.join(__dirname, '..', 'cdk.json');

/** A context that satisfies both conditions, so each test can break exactly one thing. */
const goodContext = (over = {}) => ({
  authCallbackUrls: '["https://app.example.com/auth/callback"]',
  authLogoutUrls: '["https://app.example.com/"]',
  authDomainPrefix: 'cba-study-coach-pilot-7f3d',
  ...over,
});

const goodProbe = (over = {}) => ({ status: PROBE.AVAILABLE, prefix: 'cba-study-coach-pilot-7f3d', region: 'us-east-1', ...over });

const run = (over = {}, probeOver = {}) =>
  evaluatePreflight({ environment: 'pilot', context: goodContext(over), domainProbe: goodProbe(probeOver) });

const failuresFor = (result, id) => result.checks.find((c) => c.id === id).failures;

/* ================= POSITIVE CONTROL ============================================================ */

test('POSITIVE CONTROL: a fully supplied, confirmed configuration passes both conditions', () => {
  const result = run();
  assert.equal(result.ok, true, JSON.stringify(result.failures));
  assert.deepEqual(result.failures, []);
});

/* ================= PREFLIGHT-1 ================================================================= */

test('PREFLIGHT-1 refuses the committed pilot default — the placeholder survived', () => {
  // No override at all: exactly the state the repository ships in.
  const result = evaluatePreflight({ environment: 'pilot', context: {}, domainProbe: goodProbe() });
  const f = failuresFor(result, 'PREFLIGHT-1');
  assert.equal(result.ok, false);
  assert.equal(f.length, 2, 'both callback and logout must be reported');
  assert.match(f.join('\n'), /authCallbackUrls/);
  assert.match(f.join('\n'), /authLogoutUrls/);
  assert.match(f.join('\n'), /no override was supplied/);
});

test('PREFLIGHT-1 refuses an override that itself carries the placeholder, and says so differently', () => {
  const result = run({ authCallbackUrls: '["https://pilot.invalid/auth/callback"]' });
  const f = failuresFor(result, 'PREFLIGHT-1');
  assert.equal(result.ok, false);
  assert.equal(f.length, 1);
  assert.match(f[0], /supplied explicitly/);
  // The two cases must not be conflated: "you forgot" and "you supplied the placeholder" are
  // different operator mistakes with different fixes.
  assert.equal(/no override was supplied/.test(f[0]), false);
});

test('PREFLIGHT-1 reads the EFFECTIVE value, so a misspelled context key does not fool it', () => {
  // `authCallbackUrl` (singular) is not the key the stack reads. The override never applies, the
  // default survives, and the preflight must see the default rather than the intent.
  const result = evaluatePreflight({
    environment: 'pilot',
    context: { authCallbackUrl: '["https://app.example.com/auth/callback"]', authLogoutUrls: '["https://app.example.com/"]', authDomainPrefix: 'cba-study-coach-pilot-7f3d' },
    domainProbe: goodProbe(),
  });
  assert.equal(result.ok, false);
  assert.match(failuresFor(result, 'PREFLIGHT-1').join('\n'), /authCallbackUrls .*placeholder/s);
});

test('PREFLIGHT-1 decides on the hostname, not on a substring of the URL', () => {
  // A path segment containing ".invalid" is not the reserved TLD and must not be flagged...
  assert.equal(isReservedPlaceholder('https://app.example.com/theme.invalid.css'), false);
  // ...and a live host that merely starts with the placeholder label is a REAL origin, which a
  // substring rule would have waved through as "obviously the placeholder".
  assert.equal(isReservedPlaceholder('https://pilot.invalid.attacker.example/auth/callback'), false);
  assert.equal(isReservedPlaceholder('https://pilot.invalid/auth/callback'), true);
  assert.equal(isReservedPlaceholder('https://invalid/auth/callback'), true);
  assert.equal(isReservedPlaceholder('https://DEEP.SUB.INVALID/x'), true, 'the TLD test is case-insensitive');

  const passes = run({ authCallbackUrls: '["https://app.example.com/theme.invalid.css"]' });
  assert.equal(passes.ok, true, 'a path containing .invalid must not fail the gate');
});

test('PREFLIGHT-1 turns an unsynthesizable configuration into a refusal, not a crash', () => {
  for (const [label, bad] of [
    ['wildcard', '["https://*.example.com/auth/callback"]'],
    ['plain http on a non-loopback host', '["http://app.example.com/auth/callback"]'],
    ['fragment', '["https://app.example.com/auth/callback#x"]'],
    ['embedded credentials', '["https://u:p@app.example.com/auth/callback"]'],
    ['not JSON', 'https://app.example.com/auth/callback'],
    ['empty list', '[]'],
  ]) {
    const result = run({ authCallbackUrls: bad });
    assert.equal(result.ok, false, `${label} must refuse`);
    assert.match(failuresFor(result, 'PREFLIGHT-1').join('\n'), /would fail synth/, label);
  }
});

test('PREFLIGHT-1 accepts the dev default, which is localhost rather than a placeholder', () => {
  const result = evaluatePreflight({
    environment: 'dev',
    context: { authDomainPrefix: 'cba-study-coach-dev-7f3d' },
    domainProbe: goodProbe(),
  });
  assert.deepEqual(failuresFor(result, 'PREFLIGHT-1'), []);
  assert.equal(result.ok, true);
});

/* ================= PREFLIGHT-2 ================================================================= */

test('PREFLIGHT-2 refuses a prefix that was never supplied, even though a value always exists', () => {
  // This is the condition's whole reason to exist: the stack's fallback means `authDomainPrefix`
  // is never empty at synth time, so checking the VALUE proves nothing. The KEY is the signal.
  const context = goodContext();
  delete context.authDomainPrefix;
  const result = evaluatePreflight({ environment: 'pilot', context, domainProbe: goodProbe() });
  assert.equal(result.ok, false);
  const f = failuresFor(result, 'PREFLIGHT-2').join('\n');
  assert.match(f, /was not supplied/);
  assert.match(f, new RegExp(defaultAuthDomainPrefix('pilot')), 'the report must name the fallback it refused');
});

test('PREFLIGHT-2 refuses when the probe was not run — an unanswered question is not a confirmation', () => {
  const result = run({}, { status: PROBE.NOT_CHECKED });
  assert.equal(result.ok, false);
  assert.match(failuresFor(result, 'PREFLIGHT-2').join('\n'), /was not run/);
});

test('PREFLIGHT-2 refuses when the probe errored, and never reads an error as availability', () => {
  const result = run({}, { status: PROBE.ERROR, detail: 'AccessDeniedException' });
  assert.equal(result.ok, false);
  const f = failuresFor(result, 'PREFLIGHT-2').join('\n');
  assert.match(f, /probe failed/);
  assert.match(f, /AccessDeniedException/);
});

test('PREFLIGHT-2 refuses a prefix already taken by somebody else', () => {
  const result = run({}, { status: PROBE.TAKEN_BY_OTHER, detail: 'the prefix is registered to a different user pool' });
  assert.equal(result.ok, false);
  assert.match(failuresFor(result, 'PREFLIGHT-2').join('\n'), /already taken in us-east-1/);
});

test('PREFLIGHT-2 accepts a redeploy onto OUR domain, but only with the expected pool named', () => {
  const ours = run({}, { status: PROBE.TAKEN_BY_EXPECTED_POOL, expectedUserPoolId: 'us-east-1_AbCdEf' });
  assert.equal(ours.ok, true, JSON.stringify(ours.failures));

  // Without the expected id, "ours" is an assertion nobody verified.
  const unverified = run({}, { status: PROBE.TAKEN_BY_EXPECTED_POOL });
  assert.equal(unverified.ok, false);
  assert.match(failuresFor(unverified, 'PREFLIGHT-2').join('\n'), /cannot be distinguished/);
});

test('PREFLIGHT-2 refuses a probe with no region — "unique" is meaningless without one', () => {
  for (const status of [PROBE.AVAILABLE, PROBE.TAKEN_BY_EXPECTED_POOL]) {
    const result = run({}, { status, region: null, expectedUserPoolId: 'us-east-1_AbCdEf' });
    assert.equal(result.ok, false, status);
    assert.match(failuresFor(result, 'PREFLIGHT-2').join('\n'), /no region/, status);
  }
});

test('PREFLIGHT-2 refuses prefixes Cognito itself would reject, before the deploy discovers it', () => {
  const cases = [
    ['UPPERCASE', 'CBA-Study-Coach', /not a valid Cognito domain prefix/],
    ['leading hyphen', '-cba-pilot', /not a valid Cognito domain prefix/],
    ['trailing hyphen', 'cba-pilot-', /not a valid Cognito domain prefix/],
    ['double hyphen', 'cba--pilot', /not a valid Cognito domain prefix/],
    ['underscore', 'cba_pilot', /not a valid Cognito domain prefix/],
    ['too long', 'a'.repeat(PREFIX_MAX + 1), /at most 63/],
    ['whitespace', ' cba-pilot ', /whitespace|not a valid/],
    ['empty', '', /non-empty string/],
  ];
  for (const [label, prefix, expected] of cases) {
    const result = run({ authDomainPrefix: prefix });
    assert.equal(result.ok, false, label);
    assert.match(failuresFor(result, 'PREFLIGHT-2').join('\n'), expected, label);
  }
  for (const word of RESERVED_WORDS) {
    const result = run({ authDomainPrefix: `cba-${word}-pilot` });
    assert.equal(result.ok, false, word);
    assert.match(failuresFor(result, 'PREFLIGHT-2').join('\n'), new RegExp(`reserved word "${word}"`), word);
  }
});

test('a non-string prefix is refused rather than coerced', () => {
  for (const bad of [42, true, null, ['x'], { a: 1 }]) {
    const result = run({ authDomainPrefix: bad });
    assert.equal(result.ok, false, JSON.stringify(bad));
    assert.match(failuresFor(result, 'PREFLIGHT-2').join('\n'), /non-empty string|not a valid/, JSON.stringify(bad));
  }
});

/* ================= both conditions together ==================================================== */

test('both conditions are always evaluated — one run reports every reason it refused', () => {
  // An operator must not have to fix one thing, wait for a lane, and discover the next.
  const context = goodContext({ authCallbackUrls: '["https://pilot.invalid/auth/callback"]' });
  delete context.authDomainPrefix;
  const result = evaluatePreflight({ environment: 'pilot', context, domainProbe: { status: PROBE.ERROR } });
  assert.equal(result.ok, false);
  assert.equal(result.checks.length, 2);
  assert.ok(result.failures.some((f) => f.startsWith('PREFLIGHT-1:')));
  assert.ok(result.failures.some((f) => f.startsWith('PREFLIGHT-2:')));
});

test('the evaluator refuses an unknown environment instead of guessing a default posture', () => {
  for (const env of ['production', 'staging', '', undefined, null, 'PILOT']) {
    assert.throws(() => evaluatePreflight({ environment: env, context: goodContext(), domainProbe: goodProbe() }), PreflightError, String(env));
  }
});

test('the evaluator refuses a context that is not a plain object', () => {
  for (const bad of [null, [], 'authDomainPrefix=x', 7]) {
    assert.throws(() => evaluatePreflight({ environment: 'pilot', context: bad, domainProbe: goodProbe() }), PreflightError, JSON.stringify(bad));
  }
});

test('resolveAuthUrls returns the same defaults the stack uses — one definition, not two', () => {
  const resolved = resolveAuthUrls({}, 'pilot');
  assert.deepEqual(resolved.callback.urls, DEFAULT_AUTH_URLS.pilot.callback);
  assert.deepEqual(resolved.logout.urls, DEFAULT_AUTH_URLS.pilot.logout);
  assert.equal(resolved.callback.supplied, false);
});

/* ================= the collector, with no AWS anywhere ========================================= */

test('the collector exits non-zero when a condition refuses, which is what stops the lane', () => {
  const { exit, result } = runDeployPreflight(
    ['--environment', 'pilot', '--region', 'us-east-1'],
    { run: () => assert.fail('no probe should run without a prefix'), cdkJsonPath: CDK_JSON },
  );
  assert.equal(exit, 1);
  assert.equal(result.ok, false);
});

test('the collector exits zero only when both conditions pass', () => {
  const { exit, output } = runDeployPreflight(
    [
      '--environment', 'pilot',
      '--region', 'us-east-1',
      '-c', 'authCallbackUrls=["https://app.example.com/auth/callback"]',
      '-c', 'authLogoutUrls=["https://app.example.com/"]',
      '-c', 'authDomainPrefix=cba-study-coach-pilot-7f3d',
    ],
    { run: () => ({ status: 0, stdout: '{}', stderr: '' }), cdkJsonPath: CDK_JSON },
  );
  assert.equal(exit, 0, output);
  assert.match(output, /Deploy may proceed/);
});

test('an empty DomainDescription means AVAILABLE, and a failed call means ERROR — never the reverse', () => {
  const base = [
    '--environment', 'pilot', '--region', 'us-east-1',
    '-c', 'authCallbackUrls=["https://app.example.com/auth/callback"]',
    '-c', 'authLogoutUrls=["https://app.example.com/"]',
    '-c', 'authDomainPrefix=cba-study-coach-pilot-7f3d',
  ];

  const available = runDeployPreflight(base, { run: () => ({ status: 0, stdout: '{"DomainDescription":{}}', stderr: '' }), cdkJsonPath: CDK_JSON });
  assert.equal(available.exit, 0);

  const denied = runDeployPreflight(base, { run: () => ({ status: 254, stdout: '', stderr: 'AccessDeniedException: not authorized' }), cdkJsonPath: CDK_JSON });
  assert.equal(denied.exit, 1, 'a denied call must never be read as availability');
  assert.match(denied.output, /probe failed/);

  const garbage = runDeployPreflight(base, { run: () => ({ status: 0, stdout: 'not json', stderr: '' }), cdkJsonPath: CDK_JSON });
  assert.equal(garbage.exit, 1);

  const taken = runDeployPreflight(base, {
    run: () => ({ status: 0, stdout: '{"DomainDescription":{"UserPoolId":"us-east-1_Other"}}', stderr: '' }),
    cdkJsonPath: CDK_JSON,
  });
  assert.equal(taken.exit, 1);
  assert.match(taken.output, /already taken/);
  assert.equal(/us-east-1_Other/.test(taken.output), false, "another tenant's pool id must not be echoed");

  const ours = runDeployPreflight([...base, '--expected-user-pool-id', 'us-east-1_Ours'], {
    run: () => ({ status: 0, stdout: '{"DomainDescription":{"UserPoolId":"us-east-1_Ours"}}', stderr: '' }),
    cdkJsonPath: CDK_JSON,
  });
  assert.equal(ours.exit, 0, ours.output);
});

test('--skip-probe fails PREFLIGHT-2 by design: skipping the question is not answering it', () => {
  const { exit, output } = runDeployPreflight(
    [
      '--environment', 'pilot', '--skip-probe',
      '-c', 'authCallbackUrls=["https://app.example.com/auth/callback"]',
      '-c', 'authLogoutUrls=["https://app.example.com/"]',
      '-c', 'authDomainPrefix=cba-study-coach-pilot-7f3d',
    ],
    { run: () => assert.fail('--skip-probe must not call AWS'), cdkJsonPath: CDK_JSON },
  );
  assert.equal(exit, 1);
  assert.match(output, /was not run/);
});

test('the probe is never called without a region, and no region is a refusal', () => {
  const { exit, output } = runDeployPreflight(
    [
      '--environment', 'pilot',
      '-c', 'authCallbackUrls=["https://app.example.com/auth/callback"]',
      '-c', 'authLogoutUrls=["https://app.example.com/"]',
      '-c', 'authDomainPrefix=cba-study-coach-pilot-7f3d',
    ],
    { run: () => assert.fail('the probe must not run without a region'), cdkJsonPath: CDK_JSON },
  );
  assert.equal(exit, 1);
  assert.match(output, /no region/);
});

test('the probe call is read-only, bounded, and names the exact domain and region', () => {
  const calls = [];
  runDeployPreflight(
    [
      '--environment', 'pilot', '--region', 'eu-west-1',
      '-c', 'authCallbackUrls=["https://app.example.com/auth/callback"]',
      '-c', 'authLogoutUrls=["https://app.example.com/"]',
      '-c', 'authDomainPrefix=cba-study-coach-pilot-7f3d',
    ],
    {
      run: (args, o) => {
        calls.push({ args, o });
        return { status: 0, stdout: '{}', stderr: '' };
      },
      cdkJsonPath: CDK_JSON,
    },
  );
  assert.equal(calls.length, 1, 'exactly one AWS call');
  const [{ args, o }] = calls;
  assert.deepEqual(args.slice(0, 2), ['cognito-idp', 'describe-user-pool-domain']);
  assert.ok(args.includes('cba-study-coach-pilot-7f3d'));
  assert.ok(args.includes('eu-west-1'));
  assert.ok(o.timeoutMs > 0, 'the probe must be time-bounded');

  // Read-only, asserted STRUCTURALLY on the service and operation rather than by substring. A
  // substring sweep is what a careless version of this test would do, and it is wrong in both
  // directions: `--output` contains "put", so it flags a harmless flag, while a mutating operation
  // that happens not to contain a listed word sails through. The operation name is the fact.
  const [service, operation] = args;
  assert.equal(service, 'cognito-idp');
  assert.ok(operation.startsWith('describe-'), `the operation must be a describe-*, got ${operation}`);
  const MUTATING = ['create-', 'update-', 'delete-', 'put-', 'set-', 'add-', 'remove-', 'start-', 'stop-', 'admin-'];
  assert.equal(MUTATING.some((v) => operation.startsWith(v)), false, `${operation} mutates`);
  // And no other service is contacted — no secret store, no deploy surface.
  assert.equal(args.filter((a) => !String(a).startsWith('-')).some((a) => ['secretsmanager', 'ssm', 'cloudformation', 'sts'].includes(a)), false);
});

test('a committed cdk.json value counts as explicitly supplied; the in-code fallback does not', () => {
  // The condition refuses the SILENT fallback, not the location of a reviewed decision.
  const withCommitted = runDeployPreflight(
    [
      '--environment', 'pilot', '--region', 'us-east-1',
      '-c', 'authCallbackUrls=["https://app.example.com/auth/callback"]',
      '-c', 'authLogoutUrls=["https://app.example.com/"]',
    ],
    {
      run: () => ({ status: 0, stdout: '{}', stderr: '' }),
      cdkJsonPath: path.join(__dirname, 'fixtures', 'cdk-with-prefix.json'),
    },
  );
  assert.equal(withCommitted.exit, 0, withCommitted.output);

  // The real cdk.json carries no prefix, so the same run refuses.
  const withoutCommitted = runDeployPreflight(
    [
      '--environment', 'pilot', '--region', 'us-east-1',
      '-c', 'authCallbackUrls=["https://app.example.com/auth/callback"]',
      '-c', 'authLogoutUrls=["https://app.example.com/"]',
    ],
    { run: () => ({ status: 0, stdout: '{}', stderr: '' }), cdkJsonPath: CDK_JSON },
  );
  assert.equal(withoutCommitted.exit, 1);
  assert.match(withoutCommitted.output, /was not supplied/);
});

test('a usage error exits 2, which is distinguishable from a refusal', () => {
  assert.equal(runDeployPreflight(['--nope'], { cdkJsonPath: CDK_JSON }).exit, 2);
  assert.equal(runDeployPreflight([], { cdkJsonPath: CDK_JSON }).exit, 2);
  assert.equal(runDeployPreflight(['--environment', 'production'], { cdkJsonPath: CDK_JSON }).exit, 2);
});
