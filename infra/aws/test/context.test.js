// Offline unit tests for the context helpers — guards the `-c bedrockRoutedModelArns=...` override
// regression (a raw string was spread character-by-character into the IAM policy). No CDK/AWS.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseArnList } = require('../lib/context');

const ARNS = [
  'arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-sonnet-5',
  'arn:aws:bedrock:us-west-2::foundation-model/anthropic.claude-sonnet-5',
];

test('parseArnList passes a real array through', () => {
  assert.deepEqual(parseArnList(ARNS, 'bedrockRoutedModelArns'), ARNS);
});

test('parseArnList parses a JSON-array string (the -c override form)', () => {
  assert.deepEqual(parseArnList(JSON.stringify(ARNS), 'bedrockRoutedModelArns'), ARNS);
});

test('parseArnList rejects a bare ARN string (the char-spread bug)', () => {
  // Before the fix this string would be spread into ["a","r","n",...] — now it throws.
  assert.throws(() => parseArnList(ARNS[0], 'bedrockRoutedModelArns'), /must be a JSON array/);
});

test('parseArnList rejects an empty array', () => {
  assert.throws(() => parseArnList([], 'bedrockRoutedModelArns'), /non-empty array/);
});

test('parseArnList rejects a JSON array of non-ARN strings', () => {
  assert.throws(() => parseArnList('["not-an-arn"]', 'bedrockRoutedModelArns'), /starting with "arn:"/);
});

test('parseArnList rejects a JSON non-array (e.g. an object)', () => {
  assert.throws(() => parseArnList('{"a":1}', 'bedrockRoutedModelArns'), /non-empty array/);
});

/* ---------------- parseExactUrlList (#69) ---------------- */

test('parseExactUrlList accepts arrays and JSON strings of exact https/localhost URLs', () => {
  const { parseExactUrlList } = require('../lib/context');
  assert.deepEqual(parseExactUrlList(['https://a.example/cb'], 'k'), ['https://a.example/cb']);
  assert.deepEqual(parseExactUrlList('["http://localhost:3000/cb"]', 'k'), ['http://localhost:3000/cb']);
});

test('parseExactUrlList rejects wildcards, plain http, invalid URLs and empty lists', () => {
  const { parseExactUrlList } = require('../lib/context');
  assert.throws(() => parseExactUrlList(['https://*.example/cb'], 'k'), /wildcards are forbidden/);
  assert.throws(() => parseExactUrlList(['http://app.example/cb'], 'k'), /must use https/);
  assert.throws(() => parseExactUrlList(['not-a-url'], 'k'), /not a valid absolute URL/);
  assert.throws(() => parseExactUrlList([], 'k'), /non-empty array/);
  assert.throws(() => parseExactUrlList('nope', 'k'), /JSON array of exact URLs/);
});

test('parseExactUrlList rejects fragments, embedded credentials and outer whitespace', () => {
  const { parseExactUrlList } = require('../lib/context');
  // Cognito forbids fragments in callback URLs (user-pool-settings-client-apps).
  assert.throws(() => parseExactUrlList(['https://a.example/cb#frag'], 'k'), /must not contain a fragment/);
  assert.throws(() => parseExactUrlList(['https://user:pass@a.example/cb'], 'k'), /must not embed credentials/);
  assert.throws(() => parseExactUrlList(['https://user@a.example/cb'], 'k'), /must not embed credentials/);
  assert.throws(() => parseExactUrlList([' https://a.example/cb'], 'k'), /whitespace/);
  assert.throws(() => parseExactUrlList(['https://a.example/cb '], 'k'), /whitespace/);
});

/* ---------------- cdk.json feature-flag guards (#69 review) ---------------- */

test('cdk.json pins cross-stack reference strength to "strong" explicitly', () => {
  // The Identity->Api and Data->Api references rely on producer-protecting exports; leaving the
  // default implicit re-introduces the synth warning and invites a silent behavior change when
  // the CDK default flips. Keep the flag EXPLICIT.
  const cdkJson = require('../cdk.json');
  assert.equal(cdkJson.context['@aws-cdk/core:defaultCrossStackReferences'], 'strong');
});

/* ---------------- README ↔ contract agreement (#111 rounds 4-5) ---------------- */

// Shared parser so the guard and its regression exercise the SAME extraction: a table row's first
// cell may combine keys ("`authCallbackUrls` / `authLogoutUrls`") and every key in it counts.
function documentedContextKeys(markdown) {
  const section = markdown.split('## Context parameters')[1]?.split('\n## ')[0];
  assert.ok(section, 'the README must keep its "Context parameters" section');
  const documented = new Set();
  for (const line of section.split('\n')) {
    const m = line.match(/^\|\s*`([^`]+(?:`\s*\/\s*`[^`]+)*)`\s*\|/);
    if (!m) continue;
    for (const key of m[1].split(/`\s*\/\s*`/)) documented.add(key.trim());
  }
  return documented;
}

test('the README context table documents EXACTLY the closed deploy contract', () => {
  // The README round-tripped stale advice once already: it kept teaching the removed
  // `githubOidcProviderArn` override after the code dropped it. Docs that describe a context key
  // the contract does not carry (or omit one it does) misconfigure the next operator — so the
  // table and DEPLOY_CONTEXT_KEYS must agree EXACTLY, in both directions, forever.
  const fs = require('node:fs');
  const path = require('node:path');
  const { DEPLOY_CONTEXT_KEYS } = require('../lib/context');

  const readme = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8');
  const documented = documentedContextKeys(readme);

  // `environment` is operator surface too (round 5): Set.delete RETURNS whether the entry
  // existed, so a missing row fails here by name instead of being silently skipped over.
  assert.ok(
    documented.delete('environment'),
    'the README must document the `environment` tier selector (bound separately in the manifest digest)',
  );

  const contract = [...DEPLOY_CONTEXT_KEYS].sort();
  assert.deepEqual([...documented].sort(), contract,
    'the README context table and DEPLOY_CONTEXT_KEYS must agree exactly — fix whichever side drifted');
});

test('REGRESSION: removing the `environment` row alone is observed — the guard goes red', () => {
  // The round-4 guard deleted `environment` unconditionally, so a README that dropped exactly
  // that row still compared equal. The mutation runs IN MEMORY against the same parser the guard
  // uses; the file on disk is never touched.
  const fs = require('node:fs');
  const path = require('node:path');
  const readme = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8');
  const mutated = readme.split('\n').filter((l) => !/^\|\s*`environment`\s*\|/.test(l)).join('\n');
  assert.notEqual(mutated, readme, 'the mutation must actually remove the `environment` row');
  assert.equal(
    documentedContextKeys(mutated).delete('environment'),
    false,
    'the parser must observe the missing row — the guard asserts on exactly this return value',
  );
});
