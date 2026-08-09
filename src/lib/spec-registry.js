/**
 * The SPEC-ID registry: loader, closed-schema validator and lifecycle laws
 * (spec/spec-anchored-development.md §4, §5, §6a, §6c).
 *
 * This is the traceability LINTER's core (SPEC-GOV-002..009 when they activate). It proves the
 * checkable facts and nothing more: the registry parses, ids are unique and well-formed,
 * statuses are legal, the human-readable tables and the registry agree, anchors point at files
 * that exist, and an ACTIVE id carries everything §4 demands of an activation. What prose and
 * code MEAN is the semantic stage's charter, not this file's.
 *
 * Nothing here writes to spec/ (SPEC-GOV-001): every function is read-only over its inputs.
 */
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { framedTextDigest } from './authority-policy.js';

export class SpecRegistryError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SpecRegistryError';
  }
}

const fail = (message) => {
  throw new SpecRegistryError(message);
};

export const REGISTRY_PATH = 'spec/registry.json';
export const SPEC_PATH = 'spec/spec-anchored-development.md';

const ID_RE = /^SPEC-(GOV|AUDIT|RUN|DEPLOY|LANE|IAM)-[0-9]{3}$/;
const STATUSES = ['PROPOSED', 'ACTIVE', 'RETIRED'];
const TOP_KEYS = ['$comment', 'version', 'entries'];
const ENTRY_KEYS = ['id', 'status', 'title', 'normativeText', 'normativeSha256', 'anchors', 'tests', 'checks', 'governedPaths', 'mutationEvidence', 'supersedes', 'supersededBy'];
/** §6c: the closed mutation-evidence record an ACTIVE id must carry. Prose is for PROPOSED only. */
const MUTATION_EVIDENCE_KEYS = ['commit', 'patchSha256', 'command', 'expectedFailure'];
const COMMIT_SHA_RE = /^[0-9a-f]{40}$/;
const SHA256_HEX_RE = /^[0-9a-f]{64}$/;

const isPlainObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

function assertKeys(label, obj, keys) {
  if (!isPlainObject(obj)) fail(`${label} must be an object.`);
  const got = Object.keys(obj).sort();
  const want = [...keys].sort();
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    const extra = got.filter((k) => !want.includes(k));
    const missing = want.filter((k) => !got.includes(k));
    fail(`${label} must have exactly the closed key set (extra: [${extra.join(', ')}]; missing: [${missing.join(', ')}]).`);
  }
}

/**
 * Read the registry and the spec document — from the working tree by default, or from an exact
 * commit with `{ commit }`, which is how the audit runbook's `--commit <sha>` contract is met:
 * two audits of the same SHA read the same bytes whatever the working tree looks like meanwhile.
 */
export function loadSpecSources({ root = process.cwd(), commit = null, git = defaultGit } = {}) {
  if (commit !== null) {
    if (typeof commit !== 'string' || !COMMIT_SHA_RE.test(commit)) {
      fail('commit must be a full lowercase 40-character SHA — a branch name is a moving target.');
    }
    return {
      registryRaw: git('git', ['show', `${commit}:${REGISTRY_PATH}`]),
      specMd: git('git', ['show', `${commit}:${SPEC_PATH}`]),
      fileExists: (rel) => {
        try {
          git('git', ['cat-file', '-e', `${commit}:${rel}`]);
          return true;
        } catch {
          return false;
        }
      },
    };
  }
  return {
    registryRaw: readFileSync(path.join(root, REGISTRY_PATH), 'utf8'),
    specMd: readFileSync(path.join(root, SPEC_PATH), 'utf8'),
    fileExists: (rel) => existsSync(path.join(root, rel)),
  };
}

function defaultGit(cmd, args) {
  return execFileSync(cmd, args, { encoding: 'utf8' });
}

/** The spec's §7a/§7b table rows, as the registry's other half. The table IS the normative text
 * of record, so agreement is exact string equality on the cell — never a normalization. */
export function parseSpecTables(specMd) {
  const rows = [];
  for (const line of specMd.split('\n')) {
    if (!/^\| SPEC-[A-Z]+-[0-9]{3} \|/.test(line)) continue;
    const cells = line.split('|').slice(1, -1).map((c) => c.trim());
    const statusMatch = cells[1].match(/^(PROPOSED|ACTIVE|RETIRED)/);
    if (!statusMatch) fail(`table row for ${cells[0]} has no leading status: ${cells[1]}`);
    rows.push({ id: cells[0], status: statusMatch[1], normativeText: cells[2] });
  }
  return rows;
}

/**
 * Validate the registry: closed schema, id law, lifecycle law, digest law, table agreement and
 * anchor existence. Throws SpecRegistryError naming the first violation; returns the parsed
 * registry when everything holds.
 */
export function validateSpecRegistry({ registryRaw, specMd, fileExists }) {
  let registry;
  try {
    registry = JSON.parse(registryRaw);
  } catch {
    fail('spec/registry.json does not parse.');
  }
  assertKeys('registry', registry, TOP_KEYS);
  if (registry.version !== 1) fail('registry.version must be 1.');
  if (!Array.isArray(registry.$comment) || registry.$comment.some((c) => typeof c !== 'string')) {
    fail('registry.$comment must be an array of strings.');
  }
  if (!Array.isArray(registry.entries) || registry.entries.length === 0) {
    fail('registry.entries must be a non-empty array.');
  }

  const byId = new Map();
  for (const entry of registry.entries) {
    assertKeys(`registry entry ${isPlainObject(entry) ? entry.id : '(not an object)'}`, entry, ENTRY_KEYS);
    const { id } = entry;
    if (typeof id !== 'string' || !ID_RE.test(id)) fail(`registry id ${JSON.stringify(id)} does not match ${ID_RE}.`);
    if (byId.has(id)) fail(`registry id ${id} appears twice; ids are never reused.`);
    byId.set(id, entry);

    if (!STATUSES.includes(entry.status)) fail(`${id}.status must be one of ${STATUSES.join(', ')}.`);
    if (typeof entry.title !== 'string' || entry.title.trim() === '') fail(`${id}.title must be a non-empty string.`);
    if (typeof entry.normativeText !== 'string' || entry.normativeText.trim() === '') {
      fail(`${id}.normativeText must be the exact normative sentence, non-empty.`);
    }
    // §6b: the digest is TEXT-framed with the id as subject — recomputed, never trusted.
    if (entry.normativeSha256 !== framedTextDigest(id, entry.normativeText)) {
      fail(`${id}.normativeSha256 does not match the §6b text-framed digest of its normativeText.`);
    }

    if (!Array.isArray(entry.anchors)) fail(`${id}.anchors must be an array.`);
    for (const anchor of entry.anchors) {
      assertKeys(`${id} anchor`, anchor, ['file', 'symbol']);
      if (typeof anchor.file !== 'string' || anchor.file.trim() === '') fail(`${id} anchor.file must be a path.`);
      if (anchor.symbol !== null && (typeof anchor.symbol !== 'string' || anchor.symbol.trim() === '')) {
        fail(`${id} anchor.symbol must be null or a non-empty string.`);
      }
      if (!fileExists(anchor.file)) fail(`${id} anchor file does not exist: ${anchor.file}`);
    }
    if (!Array.isArray(entry.tests)) fail(`${id}.tests must be an array.`);
    for (const t of entry.tests) {
      assertKeys(`${id} test`, t, ['file', 'title']);
      if (typeof t.file !== 'string' || t.file.trim() === '') fail(`${id} test.file must be a path.`);
      if (t.title !== null && (typeof t.title !== 'string' || t.title.trim() === '')) {
        fail(`${id} test.title must be null (PROPOSED only) or the exact test name.`);
      }
      if (!fileExists(t.file)) fail(`${id} test file does not exist: ${t.file}`);
    }
    if (!Array.isArray(entry.checks)) fail(`${id}.checks must be an array.`);
    for (const check of entry.checks) {
      assertKeys(`${id} check`, check, ['kind', 'ref']);
      if (check.kind !== 'script') fail(`${id} check.kind must be "script".`);
      if (typeof check.ref !== 'string' || !fileExists(check.ref)) fail(`${id} check.ref must be an existing path.`);
    }
    if (!Array.isArray(entry.governedPaths) || entry.governedPaths.some((g) => typeof g !== 'string' || g.trim() === '')) {
      fail(`${id}.governedPaths must be an array of paths.`);
    }
    for (const g of entry.governedPaths) {
      if (!fileExists(g)) fail(`${id} governed path does not exist: ${g}`);
    }

    // §4 + §6c: what an ACTIVE id must carry — the activation contains its conformance.
    if (entry.status === 'ACTIVE') {
      if (entry.anchors.length === 0) fail(`${id} is ACTIVE with no code anchor (SPEC-GOV-006).`);
      if (entry.tests.length === 0) fail(`${id} is ACTIVE with no test anchor (SPEC-GOV-006).`);
      if (entry.tests.some((t) => t.title === null)) {
        fail(`${id} is ACTIVE but a test names only a file; ACTIVE requires the exact tests that fail when the invariant breaks (§5).`);
      }
      assertKeys(`${id}.mutationEvidence`, entry.mutationEvidence, MUTATION_EVIDENCE_KEYS);
      if (!COMMIT_SHA_RE.test(entry.mutationEvidence.commit ?? '')) {
        fail(`${id}.mutationEvidence.commit must be a full 40-character SHA (§6c).`);
      }
      if (!SHA256_HEX_RE.test(entry.mutationEvidence.patchSha256 ?? '')) {
        fail(`${id}.mutationEvidence.patchSha256 must be a §6b diff digest hex (§6c).`);
      }
      for (const key of ['command', 'expectedFailure']) {
        if (typeof entry.mutationEvidence[key] !== 'string' || entry.mutationEvidence[key].trim() === '') {
          fail(`${id}.mutationEvidence.${key} must be a non-empty string (§6c).`);
        }
      }
    } else if (!isPlainObject(entry.mutationEvidence) && (typeof entry.mutationEvidence !== 'string' || entry.mutationEvidence.trim() === '')) {
      fail(`${id}.mutationEvidence must be prose (PROPOSED/RETIRED) or the closed §6c record.`);
    }

    for (const key of ['supersedes', 'supersededBy']) {
      const v = entry[key];
      if (v !== null && (typeof v !== 'string' || !ID_RE.test(v))) fail(`${id}.${key} must be null or a SPEC-ID.`);
      if (v === id) fail(`${id}.${key} cannot reference itself.`);
    }
    // §4: RETIRED keeps the record and names what absorbed or replaced it — never a quiet delete.
    if (entry.status === 'RETIRED' && entry.supersededBy === null) {
      fail(`${id} is RETIRED without supersededBy; retirement always names its successor (§4).`);
    }
  }

  // Referenced ids must exist — a supersession chain cannot dangle.
  for (const entry of registry.entries) {
    for (const key of ['supersedes', 'supersededBy']) {
      const v = entry[key];
      if (v !== null && !byId.has(v)) fail(`${entry.id}.${key} references unregistered id ${v}.`);
    }
  }

  // The tables and the registry are ONE registry in two forms; disagreement in either direction
  // is a lint failure (§6a: "the human-readable tables in this file and the registry must agree").
  const tableRows = parseSpecTables(specMd);
  const tableById = new Map(tableRows.map((r) => [r.id, r]));
  if (tableRows.length !== new Set(tableRows.map((r) => r.id)).size) fail('the spec tables repeat a SPEC-ID.');
  for (const entry of registry.entries) {
    const row = tableById.get(entry.id);
    if (!row) fail(`${entry.id} is in the registry but not in the spec tables.`);
    if (row.status !== entry.status) fail(`${entry.id} status disagrees: table says ${row.status}, registry says ${entry.status}.`);
    if (row.normativeText !== entry.normativeText) {
      fail(`${entry.id} normative text disagrees between the spec table and the registry.`);
    }
  }
  for (const row of tableRows) {
    if (!byId.has(row.id)) fail(`${row.id} is in the spec tables but not in the registry.`);
  }

  return registry;
}

/**
 * The conformance runner: every ACTIVE id's named tests must run and pass in THIS tree.
 * `runTests` is injected (like resolve-run's exec) so the harness itself is provable against a
 * scripted runner; the default executes `node --test` per file with an exact-name pattern.
 *
 * A pattern that matches ZERO tests is a failure, not a pass: node exits 0 when nothing ran,
 * and "the test I named no longer exists" is precisely the drift conformance exists to catch.
 */
export function runConformance(registry, { runTests = defaultRunTests } = {}) {
  const results = [];
  const active = registry.entries.filter((e) => e.status === 'ACTIVE');
  for (const entry of active) {
    for (const t of entry.tests) {
      const outcome = runTests(t.file, t.title);
      results.push({ id: entry.id, file: t.file, title: t.title, ...outcome });
    }
  }
  return {
    activeCount: active.length,
    results,
    ok: results.every((r) => r.ok),
  };
}

function defaultRunTests(file, title) {
  // The checker itself runs under `node --test`; a child inheriting NODE_TEST_CONTEXT joins the
  // parent's reporter protocol and stops printing the summary this parser reads. The child is a
  // fresh, independent runner on purpose.
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  delete env.NODE_OPTIONS;
  let stdout = '';
  try {
    stdout = execFileSync('node', ['--test', '--test-name-pattern', `^${escapeRegExp(title)}$`, file], { encoding: 'utf8', env });
  } catch (err) {
    return { ok: false, reason: 'CONFORM_TEST_FAILED', detail: String(err.stdout ?? err.message).slice(0, 2000) };
  }
  // node counts the FILE as one passing test even when the name pattern matches nothing inside
  // it, so `# pass 1` proves nothing. The evidence that THIS test ran is its own TAP line.
  const ranNamed = new RegExp(`^\\s*ok \\d+ - ${escapeRegExp(title)}$`, 'm');
  if (!ranNamed.test(stdout)) {
    return { ok: false, reason: 'CONFORM_TEST_NOT_FOUND', detail: `no test named ${JSON.stringify(title)} ran in ${file}` };
  }
  return { ok: true };
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
