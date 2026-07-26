// Static boundary guard (#69 Slice B binding rule): AWS SDK, Cognito endpoints, and bearer
// tokens must NEVER cross into application/domain code. The Cognito surface lives ONLY in the
// infrastructure/transport adapters (cognito-identity.js, dynamodb-repository.js, lambda.js)
// and the composition seam (runtime.js). Comments are stripped before matching so prose about
// the rule never trips the rule.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');

// Application/domain + port files: the neutral side of the line.
const APPLICATION_FILES = ['app.js', 'store.js', 'views.js', 'profile.js', 'bank.js', 'identity.js', 'config.js', 'repository.js'];

const FORBIDDEN = [
  /@aws-sdk/i,
  /amazoncognito/i,
  /oauth2/i,
  /\bBearer\b/,
  /COGNITO_DOMAIN/,
  /from\s+['"]\.\/cognito-identity\.js['"]/,
  // #82: observability stays native (stdout + native metrics). No telemetry SDK may enter the
  // application/port layer — enabling OTEL/Application Signals/X-Ray/ADOT is a separate gate.
  /@opentelemetry/i,
  /\bcloudwatch\b/i,
  /aws-xray/i,
  /aws-embedded-metrics/i,
  /\bADOT\b/,
];

function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

for (const file of APPLICATION_FILES) {
  test(`boundary: ${file} carries no AWS SDK / Cognito endpoint / bearer material`, () => {
    const code = stripComments(readFileSync(path.join(SRC, file), 'utf8'));
    for (const pattern of FORBIDDEN) {
      assert.ok(!pattern.test(code), `${file} must not match ${pattern}`);
    }
  });
}

test('boundary: only the Lambda transport imports the Cognito adapter', () => {
  const lambda = stripComments(readFileSync(path.join(SRC, 'lambda.js'), 'utf8'));
  assert.ok(/from '\.\/cognito-identity\.js'/.test(lambda), 'transport owns the adapter import');
});

test('boundary: telemetry writes to stdout only — no CloudWatch/OTEL/X-Ray SDK anywhere in src', () => {
  const files = readdirSync(SRC).filter((f) => f.endsWith('.js'));
  for (const file of files) {
    const code = stripComments(readFileSync(path.join(SRC, file), 'utf8'));
    for (const pattern of [/@opentelemetry/i, /@aws-sdk\/client-cloudwatch/i, /aws-xray/i, /aws-embedded-metrics/i]) {
      assert.ok(!pattern.test(code), `${file} must not match ${pattern}`);
    }
  }
  const telemetry = stripComments(readFileSync(path.join(SRC, 'telemetry.js'), 'utf8'));
  assert.ok(/console\.log/.test(telemetry), 'the sink is stdout, which CloudWatch Logs ingests natively');
  assert.ok(!/import .* from ['"][^.]/.test(telemetry), 'telemetry has no third-party dependency');
});

test('boundary: application files never mint their own request id', () => {
  // The dispatcher owns the single fallback; a use case creating an id would break correlation.
  for (const file of ['store.js', 'views.js', 'profile.js', 'bank.js']) {
    const code = stripComments(readFileSync(path.join(SRC, file), 'utf8'));
    assert.ok(!/requestId/.test(code), `${file} must not touch requestId`);
  }
});
