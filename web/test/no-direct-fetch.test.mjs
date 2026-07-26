// Static guard (#69 Slice C review): learner UI code must never call fetch() directly — every
// API request goes through lib/client-api.js apiFetch (which owns the bearer and, via #67, the
// runtime BFF base URL). Multiline calls are covered because the scan is source-wide, not
// line-based. Comments are stripped first so prose never trips the rule.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// The ONLY files allowed to call fetch(): the API wrapper itself and the auth layer's own
// /auth/config bootstrap (web-served runtime config, not a learner API call).
const FETCH_OWNERS = new Set(['lib/client-api.js', 'lib/auth.js']);

function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

function* jsFiles(dir) {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry !== 'node_modules') yield* jsFiles(full);
    } else if (entry.endsWith('.js')) {
      yield full;
    }
  }
}

test('no learner file calls fetch() directly — apiFetch is the single door', () => {
  const offenders = [];
  for (const dir of ['app', 'lib']) {
    for (const file of jsFiles(path.join(WEB, dir))) {
      const rel = path.relative(WEB, file);
      if (FETCH_OWNERS.has(rel)) continue;
      const code = stripComments(readFileSync(file, 'utf8'));
      if (/(?<![a-zA-Z0-9_.])fetch\s*\(/.test(code)) offenders.push(rel);
    }
  }
  assert.deepEqual(offenders, [], 'direct fetch() outside the allowed owners');
});

test('the fetch owners are still the ones we think they are', () => {
  const api = stripComments(readFileSync(path.join(WEB, 'lib/client-api.js'), 'utf8'));
  assert.ok(/fetch\s*\(/.test(api), 'client-api.js performs the real fetch');
  const auth = stripComments(readFileSync(path.join(WEB, 'lib/auth.js'), 'utf8'));
  assert.ok(auth.includes("fetch('/auth/config')"), 'auth.js only bootstraps /auth/config');
  assert.ok(!auth.includes("fetch('/api"), 'auth.js never calls learner APIs directly');
});
