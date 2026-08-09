/**
 * The spec registry under its own laws (spec/spec-anchored-development.md §4, §5, §6a, §6c).
 *
 * The first test IS the CI wiring §10 asks for: it validates the real registry against the real
 * spec document, so any divergence fails the root battery with exit 1 — no workflow edit needed.
 * Every law is then proven by mutation: a registry the law should refuse is refused by name.
 * The conformance harness is proven against a SCRIPTED runner and against a real fixture file,
 * including the case node would silently bless: a named test that no longer exists.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadSpecSources, validateSpecRegistry, parseSpecTables, runConformance,
  SpecRegistryError, REGISTRY_PATH, SPEC_PATH,
} from '../src/lib/spec-registry.js';
import { framedTextDigest } from '../src/lib/authority-policy.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCES = loadSpecSources({ root: ROOT });
const REGISTRY = JSON.parse(SOURCES.registryRaw);

/** Mutate a deep copy of the registry (and optionally the spec text), expect a named refusal. */
function expectRejected(mutate, expected) {
  const registry = structuredClone(REGISTRY);
  let specMd = SOURCES.specMd;
  const setSpec = (next) => { specMd = next; };
  mutate(registry, setSpec);
  assert.throws(
    () => validateSpecRegistry({ registryRaw: JSON.stringify(registry), specMd, fileExists: SOURCES.fileExists }),
    (err) => {
      assert.ok(err instanceof SpecRegistryError, `expected SpecRegistryError, got ${err}`);
      assert.match(err.message, expected, `unexpected reason: ${err.message}`);
      return true;
    },
  );
}

const entry = (registry, id) => registry.entries.find((e) => e.id === id);

test('CI WIRING: the real registry validates against the real spec document', () => {
  const registry = validateSpecRegistry(SOURCES);
  assert.equal(registry.entries.length, 56);
  const counts = { PROPOSED: 0, ACTIVE: 0, RETIRED: 0 };
  for (const e of registry.entries) counts[e.status] += 1;
  // Everything stays PROPOSED until an activation commit satisfies its own predicates (§4);
  // the one RETIRED id is the before-activation absorption the lifecycle defines.
  assert.deepEqual(counts, { PROPOSED: 55, ACTIVE: 0, RETIRED: 1 });
  const retired = registry.entries.find((e) => e.status === 'RETIRED');
  assert.equal(retired.id, 'SPEC-DEPLOY-020');
  assert.equal(retired.supersededBy, 'SPEC-DEPLOY-019');
  assert.equal(entry(registry, 'SPEC-DEPLOY-019').supersedes, 'SPEC-DEPLOY-002');
  // …and SPEC-DEPLOY-002 is NOT yet retired: that happens in -019's activation commit, not now.
  assert.equal(entry(registry, 'SPEC-DEPLOY-002').status, 'PROPOSED');
  assert.equal(entry(registry, 'SPEC-DEPLOY-002').supersededBy, null);
});

test('CI WIRING: conformance runs clean with zero ACTIVE ids and says so', () => {
  const report = runConformance(validateSpecRegistry(SOURCES));
  assert.deepEqual(report, { activeCount: 0, results: [], ok: true });
});

test('the id law: format, uniqueness, and never-reused ids', () => {
  expectRejected((r) => { entry(r, 'SPEC-GOV-001').id = 'SPEC-GOV-1'; }, /does not match/);
  expectRejected((r) => { entry(r, 'SPEC-GOV-001').id = 'SPEC-NEW-001'; }, /does not match/);
  expectRejected((r) => { entry(r, 'SPEC-GOV-002').id = 'SPEC-GOV-001'; }, /appears twice; ids are never reused/);
});

test('the schema is closed: unknown and missing keys are refused', () => {
  expectRejected((r) => { entry(r, 'SPEC-GOV-001').extra = true; }, /extra: \[extra\]/);
  expectRejected((r) => { delete entry(r, 'SPEC-GOV-001').mutationEvidence; }, /missing: \[mutationEvidence\]/);
  expectRejected((r) => { r.entries[0].anchors[0].line = 12; }, /anchor.*extra: \[line\]/);
});

test('the digest law: normativeSha256 is recomputed, never trusted', () => {
  // Editing the text without re-digesting refuses…
  expectRejected((r) => { entry(r, 'SPEC-GOV-001').normativeText += ' — amended'; }, /does not match the §6b text-framed digest/);
  // …and so does a raw sha256 of the text, the round-9 lesson applied to the registry.
  expectRejected((r) => {
    const e = entry(r, 'SPEC-GOV-001');
    e.normativeSha256 = 'a'.repeat(64);
  }, /§6b text-framed digest/);
  // The framing binds the ID as subject: the same sentence under another id digests differently.
  const e = REGISTRY.entries[0];
  assert.notEqual(framedTextDigest('SPEC-GOV-999', e.normativeText), e.normativeSha256);
});

test('the table-agreement law fails in BOTH directions', () => {
  // Registry says something the table does not…
  expectRejected((r, setSpec) => {
    const e = entry(r, 'SPEC-GOV-001');
    e.normativeText = 'a quietly different sentence';
    e.normativeSha256 = framedTextDigest(e.id, e.normativeText);
  }, /normative text disagrees/);
  // …status drift is drift…
  expectRejected((r) => { entry(r, 'SPEC-GOV-001').status = 'ACTIVE'; }, /status disagrees|ACTIVE with no test anchor/);
  // …a registry id the tables never defined…
  expectRejected((r) => {
    const clone = structuredClone(entry(r, 'SPEC-GOV-001'));
    clone.id = 'SPEC-GOV-099';
    clone.normativeSha256 = framedTextDigest(clone.id, clone.normativeText);
    r.entries.push(clone);
  }, /in the registry but not in the spec tables/);
  // …and a table row the registry dropped.
  expectRejected((r) => {
    r.entries = r.entries.filter((e) => e.id !== 'SPEC-GOV-001');
  }, /in the spec tables but not in the registry/);
});

test('the lifecycle law: what ACTIVE must carry, what RETIRED must name', () => {
  const activate = (r, id) => {
    const e = entry(r, id);
    e.status = 'ACTIVE';
    // keep the table agreeing so the ACTIVATION laws are what refuses, not table drift
    return e;
  };
  // ACTIVE with a file-only test ref refuses: §5 requires the exact tests.
  expectRejected((r, setSpec) => {
    const e = activate(r, 'SPEC-DEPLOY-001');
    setSpec(SOURCES.specMd.replace('| SPEC-DEPLOY-001 | PROPOSED |', '| SPEC-DEPLOY-001 | ACTIVE |'));
    assert.ok(e.tests.length > 0);
  }, /ACTIVE but a test names only a file/);
  // ACTIVE with prose mutation evidence refuses: §6c is a closed record.
  expectRejected((r, setSpec) => {
    const e = activate(r, 'SPEC-DEPLOY-001');
    setSpec(SOURCES.specMd.replace('| SPEC-DEPLOY-001 | PROPOSED |', '| SPEC-DEPLOY-001 | ACTIVE |'));
    e.tests = e.tests.map((t) => ({ ...t, title: 'some exact test name' }));
  }, /mutationEvidence must be an object|closed key set/);
  // ACTIVE with no anchors refuses.
  expectRejected((r, setSpec) => {
    const e = activate(r, 'SPEC-DEPLOY-019');
    setSpec(SOURCES.specMd.replace(
      '| SPEC-DEPLOY-019 | PROPOSED (supersedes -002 on activation; absorbs -020) |',
      '| SPEC-DEPLOY-019 | ACTIVE (supersedes -002 on activation; absorbs -020) |',
    ));
  }, /ACTIVE with no code anchor/);
  // RETIRED without a successor refuses: retirement is never a quiet delete (§4).
  expectRejected((r) => { entry(r, 'SPEC-DEPLOY-020').supersededBy = null; }, /RETIRED without supersededBy/);
  // A dangling supersession refuses in either field.
  expectRejected((r) => { entry(r, 'SPEC-DEPLOY-020').supersededBy = 'SPEC-DEPLOY-099'; }, /references unregistered id/);
  expectRejected((r) => { entry(r, 'SPEC-DEPLOY-019').supersedes = 'SPEC-DEPLOY-098'; }, /references unregistered id/);
  expectRejected((r) => { entry(r, 'SPEC-DEPLOY-019').supersedes = 'SPEC-DEPLOY-019'; }, /cannot reference itself/);
});

test('anchors and governed paths must exist in the tree being linted', () => {
  expectRejected((r) => { entry(r, 'SPEC-DEPLOY-001').anchors[0].file = 'infra/aws/bin/nope.js'; }, /anchor file does not exist/);
  expectRejected((r) => { entry(r, 'SPEC-DEPLOY-001').tests[0].file = 'infra/aws/test/nope.test.js'; }, /test file does not exist/);
  expectRejected((r) => { entry(r, 'SPEC-DEPLOY-001').governedPaths = ['no/such/path.js']; }, /governed path does not exist/);
});

test('loadSpecSources refuses a moving target for --commit', () => {
  for (const bad of ['HEAD', 'main', 'd'.repeat(39), 'D'.repeat(40)]) {
    assert.throws(() => loadSpecSources({ commit: bad }), /full lowercase 40-character SHA/);
  }
});

test('the conformance harness: pass, fail, and the silently-missing test', () => {
  // A scripted registry with one ACTIVE id pointing at the real fixture file.
  const fixtureFile = 'test/fixtures/conform-probe.js';
  const scripted = (title) => ({
    entries: [{
      id: 'SPEC-GOV-001',
      status: 'ACTIVE',
      tests: [{ file: fixtureFile, title }],
    }],
  });
  // The real default runner, against the real fixture: the passing test passes…
  const pass = runConformance(scripted('conform probe: this test passes'));
  assert.equal(pass.ok, true);
  assert.equal(pass.results.length, 1);
  // …the failing test fails with the run's own evidence…
  const failRun = runConformance(scripted('conform probe: this test fails'));
  assert.equal(failRun.ok, false);
  assert.equal(failRun.results[0].reason, 'CONFORM_TEST_FAILED');
  // …and a test that DOES NOT EXIST is a failure, not a silent pass — node exits 0 when the
  // pattern matches nothing, which is exactly the drift conformance exists to catch.
  const missing = runConformance(scripted('conform probe: no such test'));
  assert.equal(missing.ok, false);
  assert.equal(missing.results[0].reason, 'CONFORM_TEST_NOT_FOUND');
});

test('the conformance runner is injectable and reports per named test', () => {
  const calls = [];
  const registry = {
    entries: [
      { id: 'SPEC-A-001', status: 'ACTIVE', tests: [{ file: 'a.test.js', title: 't1' }, { file: 'b.test.js', title: 't2' }] },
      { id: 'SPEC-A-002', status: 'PROPOSED', tests: [{ file: 'c.test.js', title: 'never-run' }] },
    ],
  };
  const report = runConformance(registry, {
    runTests: (file, title) => {
      calls.push([file, title]);
      return title === 't2' ? { ok: false, reason: 'CONFORM_TEST_FAILED' } : { ok: true };
    },
  });
  // PROPOSED ids are never executed: CI enforces ACTIVE only (§4).
  assert.deepEqual(calls, [['a.test.js', 't1'], ['b.test.js', 't2']]);
  assert.equal(report.ok, false);
  assert.equal(report.activeCount, 1);
});

test('parseSpecTables reads exactly the SPEC rows, statuses parsed from the leading token', () => {
  const rows = parseSpecTables(SOURCES.specMd);
  assert.equal(rows.length, 56);
  assert.ok(rows.every((r) => /^SPEC-(GOV|AUDIT|RUN|DEPLOY|LANE|IAM)-[0-9]{3}$/.test(r.id)));
  const d20 = rows.find((r) => r.id === 'SPEC-DEPLOY-020');
  assert.equal(d20.status, 'RETIRED');
});

test('POSITIVE CONTROL: the registry file on disk is byte-identical to what validation read', () => {
  // The registry of record is the FILE — a validation that read something else proves nothing.
  assert.equal(SOURCES.registryRaw, fs.readFileSync(path.join(ROOT, REGISTRY_PATH), 'utf8'));
  assert.equal(SOURCES.specMd, fs.readFileSync(path.join(ROOT, SPEC_PATH), 'utf8'));
});
