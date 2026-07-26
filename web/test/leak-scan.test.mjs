// Automated proof that the leak scanner actually catches leaks (#67).
//
// A scanner nobody tests is a scanner that silently stops working, so the positive controls are
// executed here instead of being recorded by hand: each case builds a SYNTHETIC .open-next tree,
// runs the real script against it with `--root`, and asserts the exit code. Fully offline — no
// build artifact and no network required.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SCRIPT = path.join(WEB, 'scripts', 'leak-scan.mjs');
const REPO = path.dirname(WEB);

/** A minimal but COMPLETE synthetic Cloudflare artifact: clean unless a leak is planted. */
function synthArtifact({ assets = {}, serverFunctions = {}, cache = {}, omit = [] } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'cba-leak-scan-'));
  const write = (rel, content) => {
    const full = path.join(root, rel);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, content);
  };
  if (!omit.includes('assets')) write('.open-next/assets/_next/static/app.js', 'export const a=1;\n');
  if (!omit.includes('worker.js')) write('.open-next/worker.js', 'export default { fetch(){} };\n');
  if (!omit.includes('server-functions')) {
    write('.open-next/server-functions/default/handler.mjs', 'export const handler=()=>{};\n');
  }
  if (!omit.includes('cache')) write('.open-next/cache/index.html', '<html>ok</html>\n');
  for (const [rel, content] of Object.entries(assets)) write(path.join('.open-next/assets', rel), content);
  for (const [rel, content] of Object.entries(serverFunctions)) {
    write(path.join('.open-next/server-functions', rel), content);
  }
  for (const [rel, content] of Object.entries(cache)) write(path.join('.open-next/cache', rel), content);
  return root;
}

function runScan(root, extraArgs = []) {
  const res = spawnSync(process.execPath, [SCRIPT, '--cloudflare', '--root', root, ...extraArgs], {
    encoding: 'utf8',
  });
  return { code: res.status, out: `${res.stdout}${res.stderr}` };
}

function withArtifact(options, assertions) {
  const root = synthArtifact(options);
  try {
    assertions(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// Synthetic credential shapes, ASSEMBLED AT RUNTIME from fragments: a complete AKIA key literal or
// a 12-digit account-id literal must not exist anywhere in this repository's source, not even in a
// test fixture, so the values only ever exist in memory while the control runs.
const SYNTHETIC = {
  accessKeyId: ['AKIA', 'IOSFODNN', '7EXAMPLE'].join(''),
  accountId: ['1234', '5678', '9012'].join(''),
};
const SYNTHETIC_ARN = `arn:aws:dynamodb:us-east-1:${SYNTHETIC.accountId}:table/x`;

/** One real question from the bank — the leaks planted below use genuine content. */
function realQuestion() {
  const bank = JSON.parse(readFileSync(path.join(REPO, 'questions', 'catalog.json'), 'utf8'));
  const questions = Array.isArray(bank) ? bank : bank.questions;
  return questions.find((q) => typeof q.question === 'string' && q.question.length > 40);
}

/* ---------------- negative control: a clean artifact passes ---------------- */

test('a clean, complete synthetic artifact PASSES', () => {
  withArtifact({}, (root) => {
    const { code, out } = runScan(root);
    assert.equal(code, 0, out);
    assert.match(out, /PASS/);
  });
});

/* ---------------- required artifacts ---------------- */

for (const required of ['assets', 'worker.js', 'server-functions']) {
  test(`--cloudflare FAILS when the critical artifact "${required}" is missing`, () => {
    withArtifact({ omit: [required] }, (root) => {
      const { code, out } = runScan(root);
      assert.equal(code, 1, out);
      assert.match(out, /required artifact\(s\) missing/);
      assert.match(out, new RegExp(required.replace('.', '\\.')));
    });
  });
}

/* ---------------- positive controls: real leaks are caught ---------------- */

test('a verbatim question from the bank in a browser asset FAILS the scan', () => {
  const question = realQuestion();
  withArtifact({ assets: { 'chunks/leak.js': `var q=${JSON.stringify(question.question)};` } }, (root) => {
    const { code, out } = runScan(root);
    assert.equal(code, 1, out);
    assert.match(out, /verbatim question stem/);
  });
});

test('a serialized bank answer field in a browser asset FAILS the scan', () => {
  withArtifact({ assets: { 'chunks/leak.js': 'var q={"answer":"B","explanation":"because"};' } }, (root) => {
    const { code, out } = runScan(root);
    assert.equal(code, 1, out);
    assert.match(out, /question-bank correction field/);
  });
});

test('the AWS SDK inside the Worker bundle FAILS the scan', () => {
  withArtifact(
    { serverFunctions: { 'default/aws.mjs': 'import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";' } },
    (root) => {
      const { code, out } = runScan(root);
      assert.equal(code, 1, out);
      assert.match(out, /AWS SDK DynamoDB client/);
    },
  );
});

test('the in-process BFF simulation store inside the Worker bundle FAILS the scan', () => {
  withArtifact({ serverFunctions: { 'default/bff.mjs': 'export function claimActiveMock(){}' } }, (root) => {
    const { code, out } = runScan(root);
    assert.equal(code, 1, out);
    assert.match(out, /in-process BFF simulation store/);
  });
});

test('a leak in the PRERENDERED CACHE is caught too', () => {
  const question = realQuestion();
  withArtifact({ cache: { 'page.html': `<p>${question.question}</p>` } }, (root) => {
    const { code, out } = runScan(root);
    assert.equal(code, 1, out);
    assert.match(out, /verbatim question stem/);
  });
});

test('credentials and account-bearing ARNs are caught', () => {
  // Sanity: the control is only meaningful if the assembled values really have the shapes the
  // scanner hunts for.
  assert.equal(SYNTHETIC.accessKeyId.length, 20);
  assert.equal(SYNTHETIC.accountId.length, 12);
  withArtifact(
    {
      assets: { 'chunks/k.js': `var k="${SYNTHETIC.accessKeyId}";` },
      serverFunctions: { 'default/a.mjs': `const r="${SYNTHETIC_ARN}";` },
    },
    (root) => {
      const { code, out } = runScan(root);
      assert.equal(code, 1, out);
      assert.match(out, /AWS access key id/);
      assert.match(out, /AWS account id in an ARN/);
    },
  );
});

test('a build-frozen NEXT_PUBLIC_* BFF base URL is caught', () => {
  withArtifact({ assets: { 'chunks/c.js': 'var u=process.env.NEXT_PUBLIC_BFF_BASE_URL;' } }, (root) => {
    const { code, out } = runScan(root);
    assert.equal(code, 1, out);
    assert.match(out, /build-time frozen config/);
  });
});
