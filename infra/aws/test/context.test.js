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
