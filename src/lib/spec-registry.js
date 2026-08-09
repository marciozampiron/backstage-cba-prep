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
import { readFileSync, existsSync, lstatSync } from 'node:fs';
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
      previousRegistryRaw: (() => {
        assertHistoryDeep(git);
        const parents = gitParents(git, commit);
        if (parents.length === 0) return null; // proven root commit
        return fileAtCommit(git, parents[0], REGISTRY_PATH);
      })(),
      fileExists: (rel) => {
        try {
          git('git', ['cat-file', '-e', `${commit}:${rel}`]);
          return true;
        } catch {
          return false;
        }
      },
      readFile: (rel) => git('git', ['show', `${commit}:${rel}`]),
      // Round I1-4: EXECUTED bytes must be a regular file tracked in the audited tree — a
      // symlink "exists", keeps the worktree clean, and runs bytes from outside the commit.
      isRegularTrackedFile: (rel) => {
        const line = tryOrNull(() => git('git', ['ls-tree', commit, '--', rel]));
        if (line === null || String(line).trim() === '') return false;
        const mode = String(line).trim().split(/\s+/)[0];
        return mode === '100644' || mode === '100755';
      },
    };
  }
  return {
    registryRaw: readFileSync(path.join(root, REGISTRY_PATH), 'utf8'),
    specMd: readFileSync(path.join(root, SPEC_PATH), 'utf8'),
    // Round I1-3: on a CLEAN checkout the worktree file IS HEAD's file, so "compare with HEAD"
    // compared the registry with itself and every historical law was vacuously green in CI. The
    // baseline is the last committed version that is NOT the bytes under validation: HEAD when
    // the worktree diverged from it, HEAD's parent when the worktree is exactly HEAD.
    previousRegistryRaw: resolvePreviousRegistryRaw({
      currentRaw: readFileSync(path.join(root, REGISTRY_PATH), 'utf8'),
      git: (cmd, args) => git(cmd, ['-C', root, ...args]),
    }),
    fileExists: (rel) => existsSync(path.join(root, rel)),
    readFile: (rel) => readFileSync(path.join(root, rel), 'utf8'),
    isRegularTrackedFile: (rel) => {
      // BOTH views must agree: the git object is a regular blob AND the path on disk — the one
      // the child would actually execute — is a regular file, not a symlink.
      const line = tryOrNull(() => defaultGit('git', ['-C', root, 'ls-files', '-s', '--', rel]));
      if (line === null || String(line).trim() === '') return false;
      const mode = String(line).trim().split(/\s+/)[0];
      if (mode !== '100644' && mode !== '100755') return false;
      try {
        return lstatSync(path.join(root, rel)).isFile();
      } catch {
        return false;
      }
    },
  };
}

function tryOrNull(fn) {
  try {
    return fn();
  } catch {
    return null;
  }
}

/** Rounds I1-4/5: absent history must be PROVEN absent, never assumed — and a git FAILURE is
 * never absence. The shallow probe itself must run and answer; anything else refuses. */
function assertHistoryDeep(git) {
  let out;
  try {
    out = git('git', ['rev-parse', '--is-shallow-repository']);
  } catch {
    fail('HISTORY_UNPROVABLE: could not determine whether this clone is shallow; a git failure is never "no history".');
  }
  const answer = String(out).trim();
  if (answer === 'true') {
    fail('HISTORY_TRUNCATED: this is a shallow clone, so absent history proves nothing — fetch full history (fetch-depth: 0) before linting.');
  }
  if (answer !== 'false') {
    fail(`HISTORY_UNPROVABLE: unexpected answer from the shallow probe: ${JSON.stringify(answer)}.`);
  }
}

/** The parents of a commit, PROVEN: the enumeration itself must succeed. Zero parents is the
 * only legitimate "no baseline" — a root commit — and it is demonstrated, not defaulted to. */
function gitParents(git, ref) {
  let out;
  try {
    out = git('git', ['rev-list', '--max-count=1', '--parents', ref]);
  } catch {
    fail(`HISTORY_UNPROVABLE: could not enumerate the parents of ${ref}.`);
  }
  const tokens = String(out).trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) fail(`HISTORY_UNPROVABLE: empty parent listing for ${ref}.`);
  return tokens.slice(1);
}

/** A file's content at a commit: null ONLY when ls-tree proves the path absent there; a failure
 * of ls-tree, or of show for a path ls-tree just listed, refuses by name (round I1-5 — every
 * tryOrNull on this path silently converted git breakage into "legitimate birth"). */
function fileAtCommit(git, commitRef, rel) {
  let line;
  try {
    line = git('git', ['ls-tree', commitRef, '--', rel]);
  } catch {
    fail(`HISTORY_UNPROVABLE: git ls-tree failed for ${commitRef}; absence must be proven, not assumed.`);
  }
  if (String(line).trim() === '') return null;
  try {
    return git('git', ['show', `${commitRef}:${rel}`]);
  } catch {
    fail(`HISTORY_UNPROVABLE: ${rel} exists at ${commitRef} but could not be read.`);
  }
}

/** The history baseline for the worktree: HEAD if the worktree registry diverged from it, else
 * HEAD's parent — never the very bytes under validation (round I1-3). */
export function resolvePreviousRegistryRaw({ currentRaw, git = defaultGit }) {
  assertHistoryDeep(git);
  const headRaw = fileAtCommit(git, 'HEAD', REGISTRY_PATH);
  if (headRaw === null) return null; // proven: the registry does not exist at HEAD — being born
  if (headRaw !== currentRaw) return headRaw;
  const parents = gitParents(git, 'HEAD');
  if (parents.length === 0) return null; // proven: HEAD is a root commit
  return fileAtCommit(git, parents[0], REGISTRY_PATH);
}

/**
 * A registry path names a tracked, repo-relative, normalized object — round I1-2: existence
 * alone accepted `../cba-issue-91/package.json`, which "exists" and escapes the repository.
 */
function isRepoRelativePath(p) {
  if (typeof p !== 'string' || p.trim() === '' || p.includes('\0')) return false;
  if (p.startsWith('/') || p.includes('\\')) return false;
  // A single trailing slash names a directory anchor (a policy FAMILY is a legitimate anchor).
  const normalized = p.endsWith('/') ? p.slice(0, -1) : p;
  if (normalized === '') return false;
  if (normalized.split('/').some((seg) => seg === '..' || seg === '.' || seg === '')) return false;
  return true;
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
export function validateSpecRegistry({ registryRaw, specMd, fileExists, readFile = null, previousRegistryRaw = null, isRegularTrackedFile = null }) {
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
      if (!isRepoRelativePath(anchor.file)) fail(`${id} anchor file must be a normalized repo-relative path: ${anchor.file}`);
      if (!fileExists(anchor.file)) fail(`${id} anchor file does not exist: ${anchor.file}`);
    }
    if (!Array.isArray(entry.tests)) fail(`${id}.tests must be an array.`);
    for (const t of entry.tests) {
      assertKeys(`${id} test`, t, ['file', 'title']);
      if (typeof t.file !== 'string' || t.file.trim() === '') fail(`${id} test.file must be a path.`);
      if (t.title !== null && (typeof t.title !== 'string' || t.title.trim() === '')) {
        fail(`${id} test.title must be null (PROPOSED only) or the exact test name.`);
      }
      if (!isRepoRelativePath(t.file)) fail(`${id} test file must be a normalized repo-relative path: ${t.file}`);
      if (!fileExists(t.file)) fail(`${id} test file does not exist: ${t.file}`);
      // Round I1-4: a test file is EXECUTED, so it must be a regular tracked file of the audited
      // tree — a symlink executes bytes that belong to no reviewed commit.
      if (isRegularTrackedFile !== null && !isRegularTrackedFile(t.file)) {
        fail(`${id} test file must be a regular tracked file (symlinks and untracked files refuse): ${t.file}`);
      }
    }
    if (!Array.isArray(entry.checks)) fail(`${id}.checks must be an array.`);
    for (const check of entry.checks) {
      assertKeys(`${id} check`, check, ['kind', 'ref']);
      if (check.kind !== 'script') fail(`${id} check.kind must be "script".`);
      if (!isRepoRelativePath(check.ref)) fail(`${id} check.ref must be a normalized repo-relative path: ${check.ref}`);
      if (!fileExists(check.ref)) fail(`${id} check.ref must be an existing path.`);
      if (isRegularTrackedFile !== null && !isRegularTrackedFile(check.ref)) {
        fail(`${id} check.ref must be a regular tracked file (symlinks and untracked files refuse): ${check.ref}`);
      }
    }
    if (!Array.isArray(entry.governedPaths) || entry.governedPaths.some((g) => typeof g !== 'string' || g.trim() === '')) {
      fail(`${id}.governedPaths must be an array of paths.`);
    }
    for (const g of entry.governedPaths) {
      if (!isRepoRelativePath(g)) fail(`${id} governed path must be a normalized repo-relative path: ${g}`);
      if (!fileExists(g)) fail(`${id} governed path does not exist: ${g}`);
    }

    // §4 + §6c: what an ACTIVE id must carry — the activation contains its conformance.
    if (entry.status === 'ACTIVE') {
      if (entry.anchors.length === 0) fail(`${id} is ACTIVE with no code anchor (SPEC-GOV-006).`);
      // Round I1-2: existence of the FILE is not existence of the ANCHOR. An ACTIVE id's symbol
      // must appear in the anchored file — a weak but real check; the semantic stage judges
      // meaning, this only refuses a symbol nobody could find.
      for (const anchor of entry.anchors) {
        if (anchor.symbol !== null) {
          if (readFile === null) fail(`${id} is ACTIVE with symbol anchors but no readFile accessor was provided to verify them.`);
          const content = readFile(anchor.file);
          if (!String(content).includes(anchor.symbol)) {
            fail(`${id} anchor symbol ${JSON.stringify(anchor.symbol)} does not appear in ${anchor.file}.`);
          }
        }
      }
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

    if (!Array.isArray(entry.supersedes) || entry.supersedes.some((v) => typeof v !== 'string' || !ID_RE.test(v))) {
      fail(`${id}.supersedes must be an array of SPEC-IDs (empty when it replaces nothing).`);
    }
    if (new Set(entry.supersedes).size !== entry.supersedes.length) fail(`${id}.supersedes repeats an id.`);
    if (entry.supersedes.includes(id)) fail(`${id}.supersedes cannot reference itself.`);
    {
      const v = entry.supersededBy;
      if (v !== null && (typeof v !== 'string' || !ID_RE.test(v))) fail(`${id}.supersededBy must be null or a SPEC-ID.`);
      if (v === id) fail(`${id}.supersededBy cannot reference itself.`);
    }
    // §4: RETIRED keeps the record and names what absorbed or replaced it — never a quiet delete.
    if (entry.status === 'RETIRED' && entry.supersededBy === null) {
      fail(`${id} is RETIRED without supersededBy; retirement always names its successor (§4).`);
    }
  }

  // Referenced ids must exist, and the supersession relation is RECIPROCAL — round I1-2:
  // SPEC-DEPLOY-020 pointing its supersededBy at an unrelated id validated, because nothing
  // required the named successor to name it back.
  for (const entry of registry.entries) {
    for (const v of entry.supersedes) {
      if (!byId.has(v)) fail(`${entry.id}.supersedes references unregistered id ${v}.`);
    }
    const by = entry.supersededBy;
    if (by !== null) {
      if (!byId.has(by)) fail(`${entry.id}.supersededBy references unregistered id ${by}.`);
      if (!byId.get(by).supersedes.includes(entry.id)) {
        fail(`${entry.id}.supersededBy names ${by}, but ${by}.supersedes does not name ${entry.id} back — supersession is reciprocal or it is nothing.`);
      }
    }
    // §4 atomicity: an ACTIVE successor's activation commit retired everything it replaces.
    if (entry.status === 'ACTIVE') {
      for (const v of entry.supersedes) {
        const prior = byId.get(v);
        if (prior.status !== 'RETIRED' || prior.supersededBy !== entry.id) {
          fail(`${entry.id} is ACTIVE but ${v} is not RETIRED naming it back; activation and retirement are one atomic commit (§4).`);
        }
      }
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

  // --- the HISTORICAL laws (round I1-2) -------------------------------------------------------
  // Judged against the last committed registry; induction over reviewed commits carries each law
  // back to the registry's birth. Without this, an ACTIVE text edited together with its digest
  // and table validated, and a deleted id simply lowered the count.
  if (previousRegistryRaw !== null) {
    let previous;
    try {
      previous = JSON.parse(previousRegistryRaw);
    } catch {
      fail('the previous committed registry does not parse; history cannot be judged.');
    }
    for (const prev of previous.entries ?? []) {
      const now = byId.get(prev.id);
      if (!now) fail(`${prev.id} existed in the committed registry and is gone; ids are never deleted and never reused (§4).`);
      if (prev.status === 'ACTIVE') {
        if (now.status === 'PROPOSED') fail(`${prev.id} was ACTIVE and is now PROPOSED; enforcement is never quietly switched off (§4).`);
        if (now.status === 'ACTIVE' && now.normativeText !== prev.normativeText) {
          fail(`${prev.id} is ACTIVE and its normative text changed; an ACTIVE invariant is immutable — a change mints a successor (§4).`);
        }
        if (now.status === 'RETIRED') {
          const successor = now.supersededBy === null ? null : byId.get(now.supersededBy);
          if (!successor || successor.status !== 'ACTIVE') {
            fail(`${prev.id} was ACTIVE and is now RETIRED without an ACTIVE successor; retirement of an enforced id is atomic with its successor's activation (§4).`);
          }
          // Round I1-3: retiring is not a license to rewrite — the record is kept byte-identical.
          if (now.normativeText !== prev.normativeText) {
            fail(`${prev.id} was ACTIVE and its text changed during retirement; a previously enforced sentence is immutable through and past its retirement (§4).`);
          }
        }
      }
      if (prev.status === 'RETIRED') {
        if (now.status !== 'RETIRED') fail(`${prev.id} was RETIRED and changed status; retirement is permanent (§4).`);
        if (now.supersededBy !== prev.supersededBy) fail(`${prev.id} is RETIRED and its supersededBy changed; the record of what absorbed it is immutable.`);
        if (now.normativeText !== prev.normativeText) fail(`${prev.id} is RETIRED and its normative text changed; the record is kept, not edited.`);
      }
    }
  }

  return registry;
}

/**
 * Round I1-2: `--commit` proved nothing while the TESTS ran from whatever worktree happened to
 * be checked out — a broken target could borrow a fixed tree's green. Conformance for a commit
 * requires the worktree to BE that commit, exactly and cleanly.
 */
export function assertConformTarget({ commit, git = defaultGit }) {
  const head = String(git('git', ['rev-parse', 'HEAD'])).trim();
  if (head !== commit) {
    fail(`CONFORM_HEAD_MISMATCH: the worktree is at ${head}, not the audited ${commit}; tests always run from the tree they claim to describe.`);
  }
  const status = String(git('git', ['status', '--porcelain'])).trim();
  if (status !== '') {
    fail('CONFORM_WORKTREE_DIRTY: uncommitted changes present; a dirty tree is not the audited commit.');
  }
}

/**
 * The third traceability direction (§5): every `[SPEC-…]` annotation in tracked content must
 * resolve to a registered id. Zero annotations resolve trivially — the direction exists from
 * day one so the first annotation is already governed.
 */
const ANNOTATION_ID_RE = /^SPEC-(GOV|AUDIT|RUN|DEPLOY|LANE|IAM)-[0-9]{3}$/;
/** Documentation placeholders that DESCRIBE the token format without being annotations. Closed. */
const ANNOTATION_PLACEHOLDERS = new Set(['SPEC-…', 'SPEC-<AREA>-<NNN>', 'SPEC-ID']);
// Assembled so this file's own source never contains a degenerate bracket candidate.
const ANNOTATION_CANDIDATE_RE = new RegExp(`\\[${'SPEC-'}[^\\]]*\\]`, 'g');

export function annotationOffenses({ registryIds, git = defaultGit, commit = null }) {
  // Round I1-3: the scan is bound to what it audits — the exact commit when one is named, the
  // worktree otherwise — and a grep FAILURE is a refusal, never "no annotations": git grep exits
  // 1 with no output for zero matches, and anything else is an error.
  const args = ['grep', '-In', '-F', `[${'SPEC-'}`];
  if (commit !== null) args.push(commit);
  let grep = '';
  try {
    grep = git('git', args);
  } catch (err) {
    const status = err && typeof err.status === 'number' ? err.status : null;
    const out = err && err.stdout ? String(err.stdout).trim() : '';
    if (status === 1 && out === '') return [];
    fail(`ANNOTATION_SCAN_FAILED: git grep did not run cleanly (exit ${status ?? 'unknown'}); an unscanned tree is not an annotation-free tree.`);
  }
  const offenses = [];
  for (const line of String(grep).split('\n')) {
    if (line.trim() === '') continue;
    const where = line.split(':').slice(0, commit === null ? 2 : 3).join(':');
    for (const match of line.matchAll(ANNOTATION_CANDIDATE_RE)) {
      const inner = match[0].slice(1, -1);
      if (ANNOTATION_PLACEHOLDERS.has(inner)) continue;
      // A bracket may carry ONE annotation or a comma-separated reference list (runbook
      // frontmatter); every piece must be a well-formed, registered id — round I1-3: a broad
      // candidate that fails the grammar (a two-digit id, a typo) is an offense, not invisible.
      for (const piece of inner.split(',').map((x) => x.trim())) {
        if (!ANNOTATION_ID_RE.test(piece)) {
          offenses.push(`${where} carries malformed SPEC token ${JSON.stringify(piece)}`);
        } else if (!registryIds.has(piece)) {
          offenses.push(`${where} annotates unregistered ${piece}`);
        }
      }
    }
  }
  return offenses;
}

/**
 * The governed-path predicate (§6): a change to an ACTIVE id's governed paths without a change
 * to any of that id's tests or checks is flagged. Pure over a changed-file list so it is
 * provable; `diffChangedFiles` supplies the list for the audited mode.
 */
export function governedPathOffenses({ registry, changedFiles }) {
  if (changedFiles === null) return [];
  const offenses = [];
  const covers = (governed, file) => (governed.endsWith('/') ? file.startsWith(governed) : file === governed);
  for (const entry of registry.entries) {
    if (entry.status !== 'ACTIVE') continue;
    const touched = changedFiles.filter((f) => entry.governedPaths.some((g) => covers(g, f)));
    if (touched.length === 0) continue;
    const evidenceFiles = new Set([...entry.tests.map((t) => t.file), ...(entry.checks ?? []).map((c) => c.ref)]);
    const evidenceMoved = changedFiles.some((f) => evidenceFiles.has(f));
    if (!evidenceMoved) {
      offenses.push(`${entry.id}: governed path(s) changed (${touched.join(', ')}) with no change to its tests or checks — conformance evidence must move with the code it governs (§6).`);
    }
  }
  return offenses;
}

/** The changed-file list for the mode being audited: commit vs its parent, a dirty worktree vs
 * HEAD, or a clean checkout's HEAD vs its parent. Null when no baseline exists (birth commit). */
export function diffChangedFiles({ commit = null, git = defaultGit }) {
  assertHistoryDeep(git);
  // Round I1-4: `--name-only` reported only a rename's DESTINATION, so a governed file renamed
  // away disappeared without ever counting as touched. `--name-status` carries both sides.
  const parseStatus = (raw) => {
    const files = [];
    for (const line of String(raw).split('\n')) {
      if (line.trim() === '') continue;
      const cols = line.split('\t');
      const code = cols[0].trim();
      if (code.startsWith('R') || code.startsWith('C')) {
        files.push(cols[1], cols[2]); // a rename/copy touches BOTH paths
      } else {
        files.push(cols[1]);
      }
    }
    return files.filter(Boolean);
  };
  if (commit !== null) {
    const parents = gitParents(git, commit);
    if (parents.length === 0) return null; // proven root commit — nothing to diff against
    let raw;
    try {
      raw = git('git', ['diff', '--name-status', '-M', parents[0], commit]);
    } catch {
      fail('HISTORY_UNPROVABLE: git diff failed; an unproven diff is not an empty diff.');
    }
    return parseStatus(raw);
  }
  const status = String(git('git', ['status', '--porcelain'])).trim();
  if (status !== '') {
    const tracked = parseStatus(git('git', ['diff', '--name-status', '-M', 'HEAD']));
    const untracked = status.split('\n').filter((l) => l.startsWith('??')).map((l) => l.slice(3).trim());
    return [...new Set([...tracked, ...untracked])];
  }
  const parents = gitParents(git, 'HEAD');
  if (parents.length === 0) return null; // proven root commit
  let raw;
  try {
    raw = git('git', ['diff', '--name-status', '-M', parents[0], 'HEAD']);
  } catch {
    fail('HISTORY_UNPROVABLE: git diff failed; an unproven diff is not an empty diff.');
  }
  return parseStatus(raw);
}

/**
 * The conformance runner: every ACTIVE id's named tests must run and pass in THIS tree.
 * `runTests` is injected (like resolve-run's exec) so the harness itself is provable against a
 * scripted runner; the default executes `node --test` per file with an exact-name pattern.
 *
 * A pattern that matches ZERO tests is a failure, not a pass: node exits 0 when nothing ran,
 * and "the test I named no longer exists" is precisely the drift conformance exists to catch.
 */
export function runConformance(registry, { runTests = defaultRunTests, runCheck = defaultRunCheck } = {}) {
  const results = [];
  const active = registry.entries.filter((e) => e.status === 'ACTIVE');
  for (const entry of active) {
    for (const t of entry.tests) {
      const outcome = runTests(t.file, t.title);
      results.push({ id: entry.id, kind: 'test', file: t.file, title: t.title, ...outcome });
    }
    // Round I1-2: an ACTIVE id's checks are obligations, not decoration — a conformance that
    // ignored them returned PASS over a failing check. Every check runs, bounded.
    for (const check of entry.checks ?? []) {
      const outcome = runCheck(check.ref);
      results.push({ id: entry.id, kind: 'check', file: check.ref, title: null, ...outcome });
    }
  }
  return {
    activeCount: active.length,
    results,
    ok: results.every((r) => r.ok),
  };
}

/** Wall-clock bound for a conformance check script — the resolve-run lesson applied here. */
export const CHECK_TIMEOUT_MS = 60_000;

/**
 * The commit-bound conformance run, as ONE function: target guard, validation, execution, and —
 * round I1-3 — the guard AGAIN before any PASS is emitted, because a check is an arbitrary
 * child process and a child that edited code or tests mid-run must invalidate the verdict, not
 * decorate it.
 */
export function runConformanceForCommit({ commit, git = defaultGit, root = process.cwd(), loadDeps = {}, runDeps = {} }) {
  assertConformTarget({ commit, git });
  const registry = validateSpecRegistry(loadSpecSources({ commit, ...loadDeps }));
  // Round I1-5: two guards around the WHOLE run left a window — a check or a concurrent process
  // could swap a later child's file for a symlink and restore it before the final guard. Every
  // child now runs inside its own boundary: object mode, lstat, exact bytes and tree
  // cleanliness, verified immediately before AND immediately after that child.
  const baseTests = runDeps.runTests ?? defaultRunTests;
  const baseCheck = runDeps.runCheck ?? defaultRunCheck;
  const guarded = (rel, fn) => {
    assertChildBoundary({ commit, rel, git, root });
    const outcome = fn();
    assertChildBoundary({ commit, rel, git, root });
    return outcome;
  };
  const report = runConformance(registry, {
    runTests: (file, title) => guarded(file, () => baseTests(file, title)),
    runCheck: (ref) => guarded(ref, () => baseCheck(ref)),
  });
  assertConformTarget({ commit, git });
  return report;
}

/**
 * The per-child boundary (round I1-5): the bytes about to run — and just ran — are exactly the
 * audited commit's regular blob, on a physically regular path, in a clean tree. A symlink swap
 * between the run-level guards lands exactly here.
 */
export function assertChildBoundary({ commit, rel, git = defaultGit, root = process.cwd() }) {
  let line;
  try {
    line = git('git', ['ls-tree', commit, '--', rel]);
  } catch {
    fail(`EXEC_OBJECT_UNREADABLE: could not read the audited object for ${rel}.`);
  }
  const mode = String(line).trim().split(/\s+/)[0];
  if (mode !== '100644' && mode !== '100755') {
    fail(`EXEC_NOT_REGULAR_IN_COMMIT: ${rel} is not a regular file in the audited commit.`);
  }
  let blob;
  try {
    blob = git('git', ['show', `${commit}:${rel}`]);
  } catch {
    fail(`EXEC_OBJECT_UNREADABLE: could not read the audited bytes of ${rel}.`);
  }
  let st;
  try {
    st = lstatSync(path.join(root, rel));
  } catch {
    fail(`EXEC_PATH_MISSING: ${rel} is absent from the tree that would execute it.`);
  }
  if (!st.isFile()) {
    fail(`EXEC_PATH_NOT_REGULAR: ${rel} is not a regular file on disk — a symlink swapped in between guards is exactly this.`);
  }
  const disk = readFileSync(path.join(root, rel), 'utf8');
  if (disk !== String(blob)) {
    fail(`EXEC_BYTES_DRIFTED: ${rel} on disk differs from the audited commit's bytes.`);
  }
  const status = String(git('git', ['status', '--porcelain'])).trim();
  if (status !== '') {
    fail('CONFORM_WORKTREE_DIRTY: uncommitted changes present at a child boundary.');
  }
}

function defaultRunCheck(ref) {
  try {
    execFileSync('bash', [ref], { encoding: 'utf8', env: childEnv(), timeout: CHECK_TIMEOUT_MS, killSignal: 'SIGTERM' });
    return { ok: true };
  } catch (err) {
    if (err && (err.killed === true || err.signal === 'SIGTERM')) {
      return { ok: false, reason: 'CONFORM_CHECK_TIMEOUT', detail: `check outlived ${CHECK_TIMEOUT_MS}ms` };
    }
    return { ok: false, reason: 'CONFORM_CHECK_FAILED', detail: String(err.stdout ?? err.message).slice(0, 2000) };
  }
}

/** Wall-clock bound for one named conformance test — ten minutes of one test is a hang. */
export const CONFORM_TEST_TIMEOUT_MS = 10 * 60_000;

/** Children run with a MINIMAL environment: the conformance verdict must not depend on — or
 * leak — whatever the invoking shell happened to export (round I1-3). */
function childEnv() {
  return { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR };
}

function defaultRunTests(file, title) {
  // A fresh, independent runner on purpose: a child inheriting NODE_TEST_CONTEXT joins the
  // parent's reporter protocol and stops printing the summary this parser reads.
  let stdout = '';
  try {
    stdout = execFileSync('node', ['--test', '--test-name-pattern', `^${escapeRegExp(title)}$`, file], {
      encoding: 'utf8', env: childEnv(), timeout: CONFORM_TEST_TIMEOUT_MS, killSignal: 'SIGTERM',
    });
  } catch (err) {
    if (err && (err.killed === true || err.signal === 'SIGTERM')) {
      return { ok: false, reason: 'CONFORM_TEST_TIMEOUT', detail: `test outlived ${CONFORM_TEST_TIMEOUT_MS}ms` };
    }
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
