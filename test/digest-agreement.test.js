/**
 * The two `framedBundleDigest` implementations — ESM in src/lib/authority-policy.js and the
 * CommonJS twin in infra/aws/lib/deploy-preflight.js — must produce IDENTICAL digests forever:
 * the ESM one frames governance evidence, the CJS one frames the manifest the cloud gate names,
 * and a silent fork between them would let the same bytes carry two "canonical" digests (§6b has
 * exactly one). Spec §9's rule applies: a mirrored implementation is valid only while a check
 * proves the mirror and the original agree.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { framedBundleDigest } from '../src/lib/authority-policy.js';

const require = createRequire(import.meta.url);
const { framedBundleDigestCjs, manifestBundleDigest } = require('../infra/aws/lib/deploy-preflight.js');
const { deepSortKeys } = require('../infra/aws/bin/deploy-release.js');

test('the ESM and CJS bundle framings agree on every fixture, multibyte included', () => {
  const fixtures = [
    { producer: 'zamp', name: 'a.md', mediaType: 'text/markdown', content: 'hello' },
    { producer: 'cba-release-binding', name: 'binding-manifest', mediaType: 'application/json', content: '{"a":1}' },
    { producer: 'zamp', name: 'multi', mediaType: 'text/plain', content: 'exatamente três bytes por caractere: ……… — ✓' },
    { producer: 'p', name: 'empty', mediaType: 'application/octet-stream', content: '' },
    { producer: 'p', name: 'buffer', mediaType: 'application/octet-stream', content: Buffer.from([0, 1, 2, 255]) },
  ];
  for (const f of fixtures) {
    assert.equal(framedBundleDigestCjs(f), framedBundleDigest(f), f.name);
  }
  // …and each envelope field is inside the digested bytes for BOTH: change one, both move together.
  const base = fixtures[1];
  for (const variant of [
    { ...base, producer: 'other' },
    { ...base, name: 'other-name' },
    { ...base, mediaType: 'text/plain' },
    { ...base, content: '{"a":2}' },
  ]) {
    assert.notEqual(framedBundleDigestCjs(variant), framedBundleDigestCjs(base));
    assert.equal(framedBundleDigestCjs(variant), framedBundleDigest(variant));
  }
});

test('the manifest digest is a property of CONTENT, not of key order or writer whitespace', () => {
  const manifest = { releaseSha: 'a'.repeat(40), environment: 'dev', region: 'us-east-1', target: { service: 'aws', stacks: ['B', 'A'] }, assemblyDigest: 'c'.repeat(64) };
  const permuted = { assemblyDigest: 'c'.repeat(64), target: { stacks: ['B', 'A'], service: 'aws' }, region: 'us-east-1', environment: 'dev', releaseSha: 'a'.repeat(40) };
  assert.equal(manifestBundleDigest(manifest, deepSortKeys), manifestBundleDigest(permuted, deepSortKeys));
  // Content changes move it — the ARRAY order is content, not serialization.
  assert.notEqual(
    manifestBundleDigest({ ...manifest, target: { service: 'aws', stacks: ['A', 'B'] } }, deepSortKeys),
    manifestBundleDigest(manifest, deepSortKeys),
  );
  assert.notEqual(manifestBundleDigest({ ...manifest, environment: 'pilot' }, deepSortKeys), manifestBundleDigest(manifest, deepSortKeys));
});
