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
