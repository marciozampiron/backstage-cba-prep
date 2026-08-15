// Repository-wide governance consistency guards (#93).
//
// The role model has now changed twice. Both times the prose was updated by hand across a dozen
// files, and both times something was left saying the old thing. These tests read the repository
// itself and fail when any ACTIVE operational source contradicts the canonical contract in
// `.agent-handoff/MESSAGE-PROTOCOL.md`.
//
// The guards are written to detect PERMISSION, not mention. Every one of these documents talks
// about pushing, merging and deploying constantly — saying "Codex may never push" must pass while
// "Codex pushes the branch" must fail. That is why each guard looks for a forbidden pairing on a
// line and then requires a negation on that same line.
//
// Append-only history is explicitly out of scope: `EVENTS.md` and `done/` record what happened
// under earlier models, and rewriting history to match today's rules would destroy the audit trail.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  validateAuthorityPolicy, PolicyError, REQUIRED_SURFACES, assertAuthorityAgreement,
  framedTextDigest, framedBundleDigest, zampStatementDigest, cleanupAuthorizationDigest,
  verifyStatementLocator, ZAMP_STATEMENT_MEDIA_TYPE, CLEANUP_VALUE_KEY_ORDER,
} from '../src/lib/authority-policy.js';
import { CANONICAL_REPO } from '../bin/resolve-run.mjs';
import { verifyAndRunCommand as verifyAndRun } from '../src/lib/human-publish-script.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/** The canonical contract. Every other surface must agree with this file. */
const PROTOCOL = '.agent-handoff/MESSAGE-PROTOCOL.md';

/**
 * Active operational sources: files an agent reads as INSTRUCTIONS.
 *
 * Discovered from the tree rather than hardcoded, so a new skill or handoff cannot quietly escape
 * the guards by not being listed.
 */
function operationalSources() {
  // `--others --exclude-standard` includes files added but not yet committed: a new skill must be
  // in scope the moment it exists, not the moment it is committed.
  const tracked = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
    cwd: ROOT,
    encoding: 'utf8',
  })
    .split('\0')
    .filter(Boolean);

  const HISTORICAL = [
    /^\.agent-handoff\/EVENTS\.md$/, // append-only event log
    /^\.agent-handoff\/done\//, // completed handoffs, kept as records
    /^inconsistencias\.md$/, // a point-in-time audit note
  ];

  const OPERATIONAL = [
    /^AGENTS\.md$/,
    /^CLAUDE\.md$/,
    /^\.agent-handoff\/[^/]+\.md$/,
    /^\.agent-handoff\/(active|inbox|templates|decisions|publish-gates)\//,
    /^spec\/security-rules\.md$/,
    // Spec-Anchored Development surfaces (#70 design round 2): authority-bearing documents must
    // sit inside fail-closed discovery BEFORE they become effective, not after.
    /^spec\/spec-anchored-development\.md$/,
    /^spec\/agents\//,
    /^docs\/runbooks\//,
    /^docs\/architecture\/agent-publication-runbook\.md$/,
    /^\.claude\/(skills|commands)\//,
    /^\.agents\/skills\//,
    /^bin\/cli\.js$/,
    /^src\/(commands|lib)\/(agent-|human-|publish-)/,
  ];

  return tracked.filter(
    (f) =>
      OPERATIONAL.some((re) => re.test(f)) &&
      !HISTORICAL.some((re) => re.test(f)) &&
      // `.gitkeep` placeholders hold no instructions; they are directory markers.
      !/(^|\/)\.gitkeep$/.test(f),
  );
}

const SOURCES = operationalSources();

/** A clause that denies, prohibits or conditions rather than permits. */
const NEGATED =
  /\b(never|not|no|nothing|neither|none|cannot|can't|must not|may not|refus\w*|forbid\w*|prohibit\w*|deny|denied|without|instead of|rather than|only after|unless|fails? if|read-only)\b/i;

/** Header cells that mark a markdown column as a list of prohibitions rather than permissions. */
const PROHIBITION_COLUMN = /may never|must never|never|prohibited|forbidden|may not|what it is not/i;

/**
 * Join soft-wrapped markdown lines into blocks.
 *
 * These documents wrap at ~100 columns, so "never a\nbare `bash <path>`" is one sentence split
 * across two lines. Judging lines independently would read the second half as an instruction. Table
 * rows, list items, headings and fenced code keep their own identity; everything else is joined to
 * the block it continues, and the block reports the line where it started.
 *
 * A section explicitly marked HISTORICAL is skipped entirely: the binding instruction allows
 * append-only records to preserve former workflows, and rewriting them to match today's model would
 * destroy the audit trail. The marking must be explicit — a heading containing HISTORICAL or
 * "superseded" — so nothing is exempt by accident.
 *
 * @returns {Array<{line: number, text: string}>}
 */
function blocksOf(text, { markdown = true } = {}) {
  const blocks = [];
  let current = null;
  let inFence = false;
  let historical = false;

  text.split('\n').forEach((line, idx) => {
    const n = idx + 1;
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      current = null;
      if (!historical) blocks.push({ line: n, text: line });
      return;
    }
    const isHeading = markdown && /^\s*#/.test(line);
    if (isHeading) historical = /\b(historical|superseded)\b/i.test(line);
    if (historical) {
      current = null;
      return;
    }
    const standalone = inFence || /^\s*\|/.test(line) || isHeading || line.trim() === '';
    const startsItem = /^\s*([-*+]|\d+\.)\s/.test(line);

    if (standalone) {
      current = null;
      blocks.push({ line: n, text: line });
      return;
    }
    if (startsItem || current === null) {
      current = { line: n, text: line.trim() };
      blocks.push(current);
      return;
    }
    current.text += ` ${line.trim()}`;
  });
  return blocks;
}

/**
 * Blocks split into SENTENCES, each reported with the line its block started on.
 *
 * Evaluating negation over a whole paragraph is a real bypass, and it was reproducible:
 *
 *   "The review scope is not a credential. The review scope authorizes publication."
 *
 * The first sentence contains `not`, so a paragraph-wide check excused the second. Wrapped lines
 * still have to be joined first — that is what `blocksOf` is for — but the negation must then be
 * judged against the sentence that actually matched, and nothing wider.
 *
 * @returns {Array<{line: number, text: string}>}
 */
function sentencesOf(text, opts) {
  const out = [];
  for (const { line, text: block } of blocksOf(text, opts)) {
    // Table rows are their own sentences; splitting a row on `.` would sever a cell mid-thought.
    if (/^\s*\|/.test(block)) {
      out.push({ line, text: block });
      continue;
    }
    for (const sentence of block.split(/(?<=[.!?])\s+/)) {
      if (sentence.trim()) out.push({ line, text: sentence.trim() });
    }
  }
  return out;
}

/** Markdown emphasis must not hide a word: `**only** after` has to read as `only after`. */
const plain = (t) => t.replace(/[*_`]/g, '');

/**
 * Split a file into the CLAUSES a guard should judge.
 *
 * Line-level matching is too coarse here. A markdown roles table puts permissions and prohibitions
 * in different columns of the same line, and the canonical flow line names four actors and four
 * verbs at once — judged whole, both look like every actor may do everything.
 *
 * So: table rows are split by cell, and prohibition columns are dropped entirely because their
 * header already negates them. Prose is split into sentences, and **a negation anywhere in a
 * sentence negates all of it** — that is how "may never merge, deploy or push" actually reads, and
 * judging its fragments separately would invent violations that the text does not contain.
 *
 * @returns {Array<{line: number, text: string}>}
 */
function clausesOf(text, opts) {
  const out = [];
  let prohibitionCols = new Set();

  const emit = (line, scope) => {
    const s = plain(scope);
    if (!s.trim()) return;
    if (NEGATED.test(s)) return; // the negation covers the whole scope
    for (const clause of s.split(/[,|;]| or /)) {
      if (clause.trim()) out.push({ line, text: clause.trim() });
    }
  };

  blocksOf(text, opts).forEach(({ line: n, text: line }) => {
    if (/^\s*\|/.test(line)) {
      if (/^\s*\|[\s:|-]+\|\s*$/.test(line)) return; // separator row
      const cells = line.split('|').slice(1, -1);
      if (cells.some((cName) => PROHIBITION_COLUMN.test(cName))) {
        // This is a header row: learn which columns list prohibitions, and assert nothing itself.
        prohibitionCols = new Set(
          cells.map((cName, i) => (PROHIBITION_COLUMN.test(cName) ? i : -1)).filter((i) => i >= 0),
        );
        return;
      }
      cells.forEach((cell, i) => {
        if (!prohibitionCols.has(i)) emit(n, cell);
      });
      return;
    }

    if (line.trim() === '') prohibitionCols = new Set(); // a blank line ends the table context

    for (const sentence of line.split(/->|→|;|(?<=[.!?])\s+/)) emit(n, sentence);
  });
  return out;
}

/**
 * Scan every operational source for a forbidden pairing.
 *
 * @param {RegExp} actor matches the actor in the clause
 * @param {RegExp} verb matches the capability that actor must not hold
 * @param {string} label what the violation would mean
 */
function assertNoPermission(actor, verb, label) {
  const violations = [];
  for (const rel of SOURCES) {
    for (const { line, text } of clausesOf(read(rel), { markdown: rel.endsWith('.md') })) {
      if (!actor.test(text) || !verb.test(text)) continue;
      if (NEGATED.test(text)) continue;
      violations.push(`${rel}:${line}: ${text}`);
    }
  }
  assert.deepEqual(violations, [], `${label}\n${violations.join('\n')}`);
}

/* ================= the guards have to be able to fail ================= */

test('POSITIVE CONTROL: every operational-source family is discovered, by family and by file', () => {
  // Design round 3: adding a discovery pattern without a control proves nothing — a later edit
  // could drop `spec/agents/**` or `docs/runbooks/**` and every other test would stay green.
  // This asserts BOTH that the known files are in scope AND that the family patterns match a
  // hypothetical new member, so deleting a pattern fails here rather than silently un-governing.
  const discovered = new Set(SOURCES);
  for (const known of [
    'spec/spec-anchored-development.md',
    'spec/agents/gemini-spec-auditor.md',
    'docs/runbooks/README.md',
    'docs/runbooks/spec-conformance-audit.md',
    'docs/runbooks/aws-dev-release.md',
  ]) {
    assert.ok(discovered.has(known), `${known} must be an operational source`);
  }
  // Family-level: a NEW file in each governed family would be discovered too. The classifier is
  // re-derived here from the same predicate the discovery uses, applied to hypothetical paths.
  for (const family of ['spec/agents/', 'docs/runbooks/', '.agent-handoff/active/', '.claude/skills/', '.agents/skills/']) {
    const members = [...discovered].filter((f) => f.startsWith(family));
    assert.ok(members.length > 0, `no discovered source under ${family} — that family's pattern is gone`);
  }
});

test('POSITIVE CONTROL: the scan reaches the real operational surfaces', () => {
  assert.ok(SOURCES.length >= 15, `expected a substantial surface list, got ${SOURCES.length}`);
  for (const required of [
    'AGENTS.md',
    PROTOCOL,
    '.agent-handoff/README.md',
    '.agent-handoff/COMMANDS.md',
    '.agent-handoff/templates/task.md',
    '.agent-handoff/templates/message.md',
    '.agent-handoff/publish-gates/README.md',
    'spec/security-rules.md',
    'docs/architecture/agent-publication-runbook.md',
    '.claude/skills/publication-prepare/SKILL.md',
    '.agents/skills/publication-review/SKILL.md',
    'bin/cli.js',
  ]) {
    assert.ok(SOURCES.includes(required), `${required} must be in scope for the governance guards`);
  }
  // History is deliberately excluded: it records what earlier models did.
  assert.equal(SOURCES.includes('.agent-handoff/EVENTS.md'), false);
});

test('POSITIVE CONTROL: a planted violation is actually detected', () => {
  // A guard that cannot fail proves nothing. This exercises the same matcher on synthetic lines.
  const actor = /\bCodex\b/;
  const verb = /\b(push(es)?|merge[sd]?|deploy(s)?)\b/i;
  const permits = 'Codex pushes the task branch and merges the pull request.';
  const denies = 'Codex may never push, merge or deploy.';
  assert.ok(actor.test(permits) && verb.test(permits) && !NEGATED.test(permits), 'the matcher must flag a permission');
  assert.ok(NEGATED.test(denies), 'the matcher must clear a prohibition');
});

/* ================= 1. the message table is canonical ================= */

const CANONICAL_MESSAGES = [
  { type: 'REVIEW_REQUEST', sender: 'Opus', receiver: 'Codex' },
  { type: 'FINDINGS', sender: 'Codex', receiver: 'Opus' },
  { type: 'REVIEW_APPROVED', sender: 'Codex', receiver: 'Zamp + Opus' },
  { type: 'GATE_RECOMMENDATION', sender: 'Codex', receiver: 'Zamp' },
  { type: 'HUMAN_GATE_GRANTED', sender: 'Zamp', receiver: 'Opus' },
  { type: 'OPERATION_RESULT', sender: 'Opus', receiver: 'Zamp + Codex' },
  { type: 'MERGE_DECISION', sender: 'Zamp', receiver: 'GitHub/human record' },
];

test('the canonical message table matches the contract exactly', () => {
  const text = read(PROTOCOL);
  // Scoped to section 3: the actors table and the envelope table also use backticked cells.
  // Only the FIRST table in section 3: a second table there documents the SCOPE values and also
  // uses backticked cells.
  const section = text.slice(text.indexOf('## 3. Message types'), text.indexOf('## 4. Required envelope'));
  const firstTable = section.split(/\n\s*\n/).find((b) => /^\|\s*Type\s*\|/m.test(b)) ?? '';
  const rows = firstTable
    .split('\n')
    .filter((l) => /^\|\s*`[A-Z_]+`\s*\|/.test(l))
    .map((l) => l.split('|').map((c) => c.trim()).filter(Boolean));

  assert.equal(rows.length, CANONICAL_MESSAGES.length, 'the protocol must define exactly the canonical message types');
  rows.forEach((cells, i) => {
    const expected = CANONICAL_MESSAGES[i];
    assert.equal(cells[0], `\`${expected.type}\``, `row ${i + 1} type`);
    assert.equal(cells[1], expected.sender, `${expected.type} sender`);
    assert.equal(cells[2].replace(/\*\*/g, ''), expected.receiver, `${expected.type} receiver`);
  });
});

test('no operational source invents a message type outside the canonical set', () => {
  const known = new Set(CANONICAL_MESSAGES.map((m) => m.type));
  const invented = [];
  for (const rel of SOURCES) {
    read(rel)
      .split('\n')
      .forEach((line, i) => {
        // Only a token in a MESSAGE-TYPE POSITION counts: after `TYPE:`, or introduced as a
        // message. Error codes and environment variables are also SCREAMING_SNAKE and are not
        // message types, so a blanket token scan would be pure noise.
        const positions = [
          ...line.matchAll(/^\s*TYPE:\s*\(?([A-Z_ |]+)\)?/g),
          ...line.matchAll(/\b([A-Z][A-Z_]{4,})\b\s+(?:message|envelope)\b/g),
          ...line.matchAll(/\bmessage\s+`([A-Z][A-Z_]{4,})`/g),
        ];
        for (const m of positions) {
          for (const token of m[1].split(/[ |]+/).filter(Boolean)) {
            if (known.has(token)) continue;
            invented.push(`${rel}:${i + 1}: ${token}`);
          }
        }
      });
  }
  assert.deepEqual(invented, [], `message types outside the canonical set: ${invented.join(', ')}`);
});

test('the canonical flow appears in the contract and is not contradicted', () => {
  assert.match(read(PROTOCOL), /Opus prepares -> Codex reviews -> Zamp approves -> Opus executes -> Zamp decides\/performs merge/);
});

/* ================= 2. Gemini has no workflow role ================= */

test('the Gemini persona holds no AUTHORITY — approval, gate, risk, review-of-record and every operational permission stay denied', () => {
  // Round I7-2: the persona IS seated (read-only semantic auditor) — that role is not denied
  // here. What this guard forbids is any surface PAIRING Gemini with an authority verb without
  // a negation on the same clause: the seated role's own lines all negate (read-only, never,
  // no authority), so they pass; a line that grants would fail.
  assertNoPermission(
    /\bgemini\b/i,
    /\b(review(s|er|ing)?|approve[sd]?|approval|publish(es|ing)?|prepare[sd]?|execute[sd]?|operat(e|es|or)|push(es)?|merge[sd]?|deploy(s)?|gate|governance|workflow)\b/i,
    'Gemini must hold no authority: no approval, gate, risk acceptance, review-of-record or operational permission',
  );
});

test('Gemini remains a supported model provider — product functionality is untouched', () => {
  // The role removal must not be read as removing the provider. These are product features.
  const llm = read('src/lib/llm.js');
  assert.match(llm, /google|gemini/i, 'the Google/Gemini provider must remain in src/lib/llm.js');
  assert.match(read('src/commands/generate.js'), /google/i, 'generate must keep the google provider');
  assert.match(read(PROTOCOL), /supported \*\*model provider\*\*/);
});

/* ================= 3. Codex is read-only ================= */

test('Codex is never instructed to implement, prepare, publish, push, merge or deploy', () => {
  assertNoPermission(
    /\bcodex\b/i,
    /\b(implement(s|ing)?|prepare[sd]?|publish(es|ing)?|execute[sd]?|run[s]? the script|push(es)?|merge[sd]?|deploy(s|ing)?|grant[s]? the (human )?gate)\b/i,
    'Codex must be read-only: no implementing, preparing, executing, pushing, merging or deploying',
  );
});

test('the contract states Codex authority explicitly', () => {
  const text = read(PROTOCOL);
  assert.match(text, /\*\*Codex may never\*\* implement the reviewed delivery, prepare or execute the publication\s+script,\s+push,\s+merge,\s+deploy,\s+or grant the human gate/);
});

/* ================= 4. Opus may not self-approve, merge, deploy or push main ================= */

test('Opus is never permitted to self-approve, merge, deploy, push main or force-push', () => {
  assertNoPermission(
    /\b(opus|executor|operator)\b/i,
    /\b(self-approv\w*|approve[sd]? (its|his|her|their) own|merge[sd]?|deploy(s|ing)?|push(es)? (to )?`?main`?|force-push\w*|administer\w*)\b/i,
    'Opus must never self-approve, merge, deploy, push main, force-push or administer the repository',
  );
});

test('the contract states Opus authority explicitly, and the code enforces the approver split', () => {
  assert.match(
    read(PROTOCOL),
    /\*\*Opus may never\*\* self-review, self-approve, amend\/rebase\/squash reviewed commits, push `main`,\s+force-push, merge, deploy, administer the repository, access secrets, or invoke a paid service/,
  );
  // Not only prose: a gate approved by the operator is refused mechanically.
  const lib = read('src/lib/human-publish-script.js');
  assert.match(lib, /APPROVER_IS_OPERATOR/);
  assert.match(lib, /APPROVER_NOT_HUMAN/);
  assert.match(read('src/commands/agent-human-publish-script.js'), /assertApproverIsNotOperator\(gate, executor\)/);
});

/* ================= 5. Zamp is not the executor or the script operator ================= */

test('Zamp is never described as implementation executor or script operator', () => {
  assertNoPermission(
    /\bzamp\b/i,
    /\b(implements?|implementation executor|operates? the script|script operator|runs? the (publication )?script|prepares? the script)\b/i,
    'Zamp approves and merges; Zamp is not the implementation executor or the script operator',
  );
});

test('no active operational source calls the human the operator of the script', () => {
  // The previous model said exactly this, in a dozen places. It must not survive anywhere active.
  const violations = [];
  for (const rel of SOURCES) {
    for (const { line, text } of clausesOf(read(rel), { markdown: rel.endsWith('.md') })) {
      // `agent-human-publish-script` and the branch/file names built from it are identifiers, not
      // statements about who operates anything.
      const t = plain(text).replace(/[\w-]*human-publi(sh|cation)-script[\w-]*/g, '<cmd>');
      if (!/\b(human|humano)\b/i.test(t)) continue;
      if (!/\b(runs?|executes?|operat(e|es|or))\b/i.test(t)) continue;
      if (!/\b(script|artifact|publication)\b/i.test(t)) continue;
      if (NEGATED.test(t)) continue;
      violations.push(`${rel}:${line}: ${text.trim()}`);
    }
  }
  assert.deepEqual(violations, [], `the human is not the script operator:\n${violations.join('\n')}`);
});

/* ================= 6. approval is never implied ================= */

test('REVIEW_APPROVED and generic approval never authorize publication', () => {
  const protocolText = read(PROTOCOL);
  assert.match(protocolText, /`REVIEW_APPROVED` is a technical\s+verdict, not permission to publish/);
  assert.match(protocolText, /is \*\*never\*\* equivalent to `HUMAN_GATE_GRANTED`/);
  assert.match(protocolText, /Only a\s+`HUMAN_GATE_GRANTED` message with exact ordered full SHAs authorizes an operation/);

  // And no active source may say the opposite.
  const violations = [];
  for (const rel of SOURCES) {
    read(rel).split('\n').forEach((line, i) => {
      const claimsAuthority =
        /\b(REVIEW_APPROVED|generic approval|"approved"|approved\b|ok\b|lgtm|aprovado|pode pushar)\b/i.test(line) &&
        /\b(authoriz\w*|grants?|allows?|permits?|is a gate|equivalent)\b/i.test(line);
      if (!claimsAuthority || NEGATED.test(line)) return;
      violations.push(`${rel}:${i + 1}: ${line.trim()}`);
    });
  }
  assert.deepEqual(violations, [], `a generic approval must never authorize publication:\n${violations.join('\n')}`);
});

/* ================= 7. no bare-path publication instruction ================= */

test('no operational source offers a bare `bash <path>` publication instruction', () => {
  const violations = [];
  for (const rel of SOURCES) {
    for (const { line, text } of blocksOf(read(rel), { markdown: rel.endsWith('.md') })) {
      // The supported form always reads the file into a variable first.
      if (!/\bbash\s+(["'`]?[$/~]|<path>|\$\{?0)/.test(text)) continue;
      if (/bash -c "\$s"/.test(text)) continue; // the verify-and-run form
      if (NEGATED.test(plain(text))) continue; // "never a bare `bash <path>`"
      violations.push(`${rel}:${line}: ${text.trim()}`);
    }
  }
  assert.deepEqual(violations, [], `bare-path invocation is not supported:\n${violations.join('\n')}`);
});

test('the supported invocation still verifies the bytes it executes', () => {
  // Guard 7 removes the unsafe form; this makes sure the safe one did not go with it.
  const lib = read('src/lib/human-publish-script.js');
  assert.match(lib, /export function verifyAndRunCommand/);
  assert.match(lib, /sha256sum/);
  assert.match(lib, /bash -c "\$s"/);
});

/* ================= 8. templates carry the required fields ================= */

test('the message template declares every required envelope field', () => {
  const tpl = read('.agent-handoff/templates/message.md');
  for (const field of ['TO', 'FROM', 'ROLE', 'TYPE', 'ISSUE', 'BRANCH', 'COMMITS', 'STATUS', 'NEXT_OWNER', 'PROHIBITED_ACTIONS']) {
    assert.match(tpl, new RegExp(`^${field}:`, 'm'), `the message template must declare ${field}`);
  }
  assert.match(tpl, /\[AGENT-HANDOFF v1\]/);
  // Every canonical type must have a place in the template.
  for (const { type } of CANONICAL_MESSAGES) {
    assert.ok(tpl.includes(type), `the message template must cover ${type}`);
  }
  // Review and operation messages carry evidence and residual risks.
  assert.match(tpl, /VALIDATION:/);
  assert.match(tpl, /RESIDUAL_RISKS:/);
  assert.match(tpl, /EVIDENCE:/);
  assert.match(tpl, /full 40-char SHA|full SHAs/);
});

test('the task template requires exact SHAs, status, next owner, prohibited actions and risks', () => {
  const tpl = read('.agent-handoff/templates/task.md');
  assert.match(tpl, /MESSAGE-PROTOCOL\.md/);
  for (const field of ['COMMITS', 'STATUS', 'NEXT_OWNER', 'PROHIBITED_ACTIONS']) {
    assert.ok(tpl.includes(field), `the task template must require ${field}`);
  }
  assert.match(tpl, /full 40-character SHAs/);
  assert.match(tpl, /residual risks/i);
  assert.match(tpl, /validation evidence/i);
  assert.match(tpl, /HUMAN_GATE_GRANTED/);
});

/* ================= the contract is actually reachable from a cold start ================= */

test('the canonical contract is in the mandatory boot sequence', () => {
  for (const rel of ['AGENTS.md', '.agent-handoff/README.md', '.agent-handoff/COMMANDS.md']) {
    assert.match(read(rel), /MESSAGE-PROTOCOL\.md/, `${rel} must point a cold-started agent at the contract`);
  }
  // In AGENTS.md and the handoff README it must be part of the numbered boot list, not a footnote.
  for (const rel of ['AGENTS.md', '.agent-handoff/README.md']) {
    assert.match(read(rel), /^\s*2\.\s+`?\.agent-handoff\/MESSAGE-PROTOCOL\.md`?/m, `${rel} boot sequence`);
  }
});

test('surfaces summarise rather than duplicate the contract', () => {
  // Duplication is what let the model drift. Only the canonical file may carry the full table.
  const full = SOURCES.filter((rel) => {
    if (rel === PROTOCOL) return false;
    if (rel === '.agent-handoff/templates/message.md') return false; // the copyable skeleton needs them all
    const text = read(rel);
    return CANONICAL_MESSAGES.every((m) => text.includes(m.type));
  });
  assert.deepEqual(full, [], `only ${PROTOCOL} may restate the full message table: ${full.join(', ')}`);
});

/* ================= explicit assertions, because the heuristic had false negatives ============== */
//
// The clause heuristic above is a coarse net, and it proved too coarse: because a negation anywhere
// in a sentence exempts the whole sentence, every contradiction below passed 20/20 while sitting in
// live documents. The heuristic stays as a backstop for phrasings nobody predicted, but the real
// control is here — exact phrases that must not exist, and exact statements that must.

/** Phrases from the superseded model. Each was live and green under the heuristic alone. */
const FORBIDDEN_PHRASES = [
  'no agent publishes',
  'No agent may execute',
  'human operator',
  'the human runs',
  'the HUMAN runs',
  'human-operated',
  'interactive terminal is required',
  'human at the keyboard',
  'the human then reopened',
  'only actor who runs',
  // Variants that survived the previous round because no phrase covered them.
  'performed by the human owner',
  'deliberate human act',
  'a separate human action',
  'human/TTY',
  'TTY check',
  // The claim that Stage A consumes anything: it reads and validates, and the same file validates
  // twice. Idempotent consumption is #91 Stage B.
  'consumed at preparation',
];

test('no active operational source contains a superseded-model phrase', () => {
  const violations = [];
  for (const rel of SOURCES) {
    // blocksOf skips sections explicitly marked HISTORICAL, which may keep the old wording.
    for (const { line, text } of blocksOf(read(rel), { markdown: rel.endsWith('.md') })) {
      for (const phrase of FORBIDDEN_PHRASES) {
        if (text.toLowerCase().includes(phrase.toLowerCase())) {
          violations.push(`${rel}:${line}: "${phrase}" in: ${text.trim().slice(0, 120)}`);
        }
      }
    }
  }
  assert.deepEqual(violations, [], `superseded-model phrasing is still live:\n${violations.join('\n')}`);
});

test('POSITIVE CONTROL: the phrase scan would catch a reintroduced contradiction', () => {
  // Proof the scan is not vacuous: the same matcher, on the same shape of text, must flag it.
  const planted = 'The one-line answer: no agent publishes. The human operator runs it.';
  const hits = FORBIDDEN_PHRASES.filter((p) => planted.toLowerCase().includes(p.toLowerCase()));
  assert.ok(hits.length >= 2, 'the phrase list must detect the exact contradictions it exists for');
});

/**
 * Statements each canonical surface MUST make. An omission is as much a drift as a contradiction —
 * the previous round passed every guard while the runbook still taught the old model.
 */
const REQUIRED_STATEMENTS = {
  'docs/architecture/agent-publication-runbook.md': [
    /nothing is published without an exact human gate/i,
    /Opus prepares and, after\s+Codex reviews and Zamp grants a `HUMAN_GATE_GRANTED`/i,
    /Zamp decides and performs the merge/i,
    /no terminal check/i,
    /Two gates, because one was circular/i,
    /CBA_EXECUTION_GATE/,
    /headRefOid/,
  ],
  '.agent-handoff/MESSAGE-PROTOCOL.md': [
    /Only a\s+`HUMAN_GATE_GRANTED` message with exact ordered full SHAs authorizes an operation/i,
    /Review happens twice/i,
    /Two gates, not one/i,
    /artifact/i,
  ],
  'AGENTS.md': [/MESSAGE-PROTOCOL\.md/, /HUMAN_GATE_GRANTED/, /Gemini/],
  'spec/security-rules.md': [/HUMAN_GATE_GRANTED/, /MESSAGE-PROTOCOL\.md/],
  '.claude/skills/publication-prepare/SKILL.md': [/HUMAN_GATE_GRANTED/, /CBA_EXECUTION_GATE/, /never merge/i],
  '.agents/skills/publication-review/SKILL.md': [/read-only/i, /never implement/i, /SCOPE/, /CBA_EXECUTION_GATE/],
  '.agent-handoff/publish-gates/README.md': [/execution gate/i, /artifactDigest|artifact digest/i],
  '.agent-handoff/README.md': [/CBA_EXECUTION_GATE/, /artifactDigest/],
  '.agent-handoff/COMMANDS.md': [/CBA_EXECUTION_GATE/, /artifact digest/i],
};

/** Surfaces a cold-started agent reads before operating. Each must show the two-gate sequence. */
const TWO_GATE_SURFACES = [
  'AGENTS.md',
  '.agent-handoff/README.md',
  '.agent-handoff/COMMANDS.md',
  '.agent-handoff/MESSAGE-PROTOCOL.md',
  '.agent-handoff/publish-gates/README.md',
  'spec/security-rules.md',
  'docs/architecture/agent-publication-runbook.md',
  '.claude/skills/publication-prepare/SKILL.md',
  '.agents/skills/publication-review/SKILL.md',
];

test('every cold-start surface shows the two-gate sequence, not just a gate', () => {
  // The previous round documented the execution gate only in the runbook and the artifact, so an
  // agent booting from AGENTS.md or COMMANDS.md would never learn the second manifest exists.
  for (const rel of TWO_GATE_SURFACES) {
    const flat = read(rel).replace(/\s+/g, ' ');
    assert.match(flat, /HUMAN_GATE_GRANTED/, `${rel} must name the authorizing message`);
    assert.match(
      flat,
      /CBA_EXECUTION_GATE|execution gate/i,
      `${rel} must name the execution gate, not only the review scope`,
    );
    assert.match(
      flat,
      /artifact ?[Dd]igest|digest of the artifact|artifact's digest|artifactDigest/,
      `${rel} must say the execution gate is bound to the artifact digest`,
    );
  }
});

test('the review scope is never described as authorizing an operation', () => {
  const violations = [];
  for (const rel of SOURCES) {
    for (const { line, text } of clausesOf(read(rel), { markdown: rel.endsWith('.md') })) {
      const t = plain(text);
      if (!/review scope|scope manifest/i.test(t)) continue;
      if (!/authoriz\w*|grants?|permits?|allows?/i.test(t)) continue;
      // "the review scope ALONE authorizes nothing" is the idiom, so `alone` reads as a limit here.
      if (NEGATED.test(t) || /\balone\b/i.test(t)) continue;
      // If the same clause names the execution gate as the authorizer, authority is attributed
      // correctly and the review scope is only being mentioned alongside it.
      if (/execution ?gate|EXECUTION_GATE/i.test(t)) continue;
      violations.push(`${rel}:${line}: ${text.trim()}`);
    }
  }
  assert.deepEqual(violations, [], `the review scope authorizes nothing:\n${violations.join('\n')}`);
});

test('every canonical surface makes the statements the model depends on', () => {
  for (const [rel, patterns] of Object.entries(REQUIRED_STATEMENTS)) {
    const flat = read(rel).replace(/\s+/g, ' ');
    for (const re of patterns) {
      assert.match(flat, re, `${rel} must state ${re}`);
    }
  }
});

/* ================= the two-gate separation is real, not just documented ======================== */

test('the artifact requires and validates an execution gate before any effect', () => {
  const lib = read('src/lib/human-publish-script.js');
  const gateCheck = lib.indexOf('CBA_EXECUTION_GATE');
  const push = lib.indexOf('git push origin');
  assert.ok(gateCheck > -1 && push > -1 && gateCheck < push, 'the execution gate must be validated before the push');

  for (const required of [
    /HUMAN_GATE_GRANTED" \]/, // the gate must declare its type
    /the execution gate is for a different issue/,
    /the execution gate names a different source branch/,
    /the execution gate authorizes a different artifact than the one being run/,
    /does not name the reviewed commits exactly and in order/,
    /the execution gate expired at/,
    /window exceeds 12 hours/,
    /the execution gate path is a symlink/,
  ]) {
    assert.match(lib, required, `the artifact must enforce ${required}`);
  }
});

test('the execution gate is re-evaluated after the confirmation, not just the review scope', () => {
  const lib = read('src/lib/human-publish-script.js');
  const confirm = lib.indexOf('IFS= read -r typed');
  const push = lib.indexOf('git push origin');
  const between = lib.slice(confirm, push);
  // The defect this pins: the revalidation called check_gate_expiry, which validates the REVIEW
  // SCOPE window, so an execution gate expiring during the prompt still reached the push.
  assert.match(between, /check_execution_gate "after confirmation"/);
  // And the execution-gate check must own its own expiry rather than borrowing the scope's.
  const fn = lib.slice(lib.indexOf('check_execution_gate() {'), lib.indexOf('check_execution_gate "before publishing"'));
  assert.match(fn, /the execution gate expired at/);
  assert.match(fn, /window exceeds 12 hours/);
});

test('the execution gate is opened with O_NOFOLLOW and read once into an immutable snapshot', () => {
  const lib = read('src/lib/human-publish-script.js');
  // A shell `[ ! -L ]` test followed by an open leaves a window a same-user process can use, and
  // bash cannot express O_NOFOLLOW — so the open is delegated to node and the kernel refuses the
  // symlink at open time.
  assert.match(lib, /O_RDONLY \| fs\.constants\.O_NOFOLLOW/);
  assert.match(lib, /fs\.fstatSync\(fd\)/);
  assert.match(lib, /fs\.readFileSync\(fd, "utf8"\)/);
  assert.match(lib, /EXECUTION_GATE_JSON=\$\(node -e/);
  assert.match(lib, /expected_keys=/); // closed schema
  // The old shell-only sequence must be gone, not merely supplemented.
  assert.equal(/exec 9< "\$CBA_EXECUTION_GATE"/.test(lib), false, 'the shell open must be replaced, not kept');
});

test('the verify-and-run command supplies the digest the gate must name', () => {
  const cmd = verifyAndRun('/tmp/x.sh', 'b'.repeat(64));
  assert.match(cmd, /CBA_ARTIFACT_DIGEST='b{64}' bash -c "\$s"/);
  // Without it the gate could authorize a different artifact than the one running.
  assert.ok(cmd.indexOf('CBA_ARTIFACT_DIGEST') < cmd.indexOf('bash -c'));
});

test('the approver is bound to a canonical identity, not merely a shape', () => {
  const lib = read('src/lib/human-publish-script.js');
  assert.match(lib, /export const CANONICAL_APPROVER/);
  assert.match(lib, /APPROVER_NOT_CANONICAL/);
  // The honesty requirement survives: this is declared, not authenticated.
  assert.match(lib.replace(/\s+/g, ' '), /still a DECLARED identity, not an authenticated one/i);
});

test('the artifact is written through one descriptor, never reopened by name', () => {
  const cmd = read('src/commands/agent-human-publish-script.js');
  assert.match(cmd, /O_CREAT \| C\.O_EXCL \| C\.O_WRONLY \| C\.O_NOFOLLOW/);
  assert.match(cmd, /fchmodSync\(fd, SCRIPT_MODE\)/);
  assert.match(cmd, /fstatSync\(fd\)/);
  // The name must not be re-resolved after the create.
  assert.equal(/chmodSync\(outputPath/.test(cmd), false, 'chmod must act on the descriptor, not the path');
  assert.equal(/[^l]statSync\(outputPath/.test(cmd), false, 'stat must act on the descriptor, not the path');
});

/* ================= semantic documentation tests, not word presence ============================= */
//
// Required-word checks proved insufficient: a surface can name `CBA_EXECUTION_GATE` and still tell
// the reader to pass the execution gate as `--gate`, or still call the review scope "consumed". These
// assert what the documents MEAN about the two manifests.

test('no document passes the execution gate where the review scope belongs', () => {
  const violations = [];
  for (const rel of SOURCES) {
    read(rel)
      .split('\n')
      .forEach((line, i) => {
        // `--gate` takes the review scope. The execution gate reaches the artifact only as an env
        // var, and its filename convention is cba-gate-*, so this pairing is always a mistake.
        // A sentence prohibiting the pairing, or a table contrasting the two channels, is correct.
        if (NEGATED.test(plain(line)) || /^\s*\|/.test(line)) return;
        if (/--gate\s+\S*cba-gate-/.test(line)) violations.push(`${rel}:${i + 1}: ${line.trim()}`);
        if (/CBA_EXECUTION_GATE[^\n]*--gate|--gate[^\n]*CBA_EXECUTION_GATE/.test(line)) {
          violations.push(`${rel}:${i + 1}: ${line.trim()}`);
        }
      });
  }
  assert.deepEqual(violations, [], `the execution gate is never a --gate argument:\n${violations.join('\n')}`);
});

test('the two manifests keep distinct names, schemas and channels everywhere', () => {
  for (const rel of ['.agent-handoff/COMMANDS.md', '.agent-handoff/publish-gates/README.md', '.agent-handoff/MESSAGE-PROTOCOL.md']) {
    const flat = read(rel).replace(/\s+/g, ' ');
    assert.match(flat, /cba-scope-/, `${rel} must name the review-scope file convention`);
    assert.match(flat, /CBA_EXECUTION_GATE/, `${rel} must name the execution-gate channel`);
  }
  // The execution gate is a separate closed schema, not the review scope with extra fields.
  const gateDoc = read('.agent-handoff/publish-gates/README.md').replace(/\s+/g, ' ');
  assert.match(gateDoc, /separate,? closed nine-key schema/i);
  assert.match(gateDoc, /different documents, not one document with optional extras/i);
  assert.equal(/execution gate adds/i.test(gateDoc), false, 'the execution gate does not "add" fields to the review scope');
});

test('neither manifest is described as consumed — Stage A only reads and validates', () => {
  const violations = [];
  for (const rel of SOURCES) {
    for (const { line, text } of blocksOf(read(rel), { markdown: rel.endsWith('.md') })) {
      const t = plain(text);
      if (!/\bconsume[sd]?\b/i.test(t)) continue;
      // Only consumption of a GATE or MANIFEST is in scope; "consumes repo-state.js" is an import.
      if (!/\b(gate|manifest|scope)\b/i.test(t)) continue;
      // A deferred Stage B property, or a denial — including a list governed by one "not", as in
      // "it does not publish, open a pull request, merge, consume a gate". The exact wrong claim
      // ("consumed at preparation") is additionally pinned in FORBIDDEN_PHRASES, so this leniency
      // cannot hide it.
      if (/Stage B/i.test(t) || NEGATED.test(t)) continue;
      violations.push(`${rel}:${line}: ${text.trim().slice(0, 140)}`);
    }
  }
  assert.deepEqual(violations, [], `consumption is Stage B, not today:\n${violations.join('\n')}`);
});

test('the artifact attributes publication to the execution gate, not the review scope', () => {
  const lib = read('src/lib/human-publish-script.js');
  // The review scope bounded preparation; recording it as the authorization would credit the wrong
  // decision in the prompt, the pull-request body and the final evidence.
  assert.match(lib, /REVIEW_SCOPE_ID=/);
  assert.match(lib, /EXECUTION_GATE_ID="\$gate_id"/);
  assert.equal(/^GATE_ID=/m.test(lib), false, 'the ambiguous GATE_ID must be gone');

  const body = lib.slice(lib.indexOf('gh pr create'), lib.indexOf('gh pr create') + 600);
  assert.match(body, /Authorized by execution gate \$EXECUTION_GATE_ID/);
  assert.match(body, /review scope \$REVIEW_SCOPE_ID/);

  const evidence = lib.slice(lib.indexOf('Published (evidence'));
  assert.match(evidence, /authorized by\s+: execution gate \$EXECUTION_GATE_ID/);
  assert.match(evidence, /review scope\s+: \$REVIEW_SCOPE_ID/);
});

test('the execution gate is re-checked immediately before EVERY external effect', () => {
  const lib = read('src/lib/human-publish-script.js');
  // Both effects, not only the push. Seven statements — two of them network calls that can block —
  // sat between the pre-push check and `gh pr create`, so a gate expiring in that span would still
  // have opened a pull request.
  for (const [label, mutation] of [
    ['immediately before push', 'git push origin'],
    ['immediately before the pull request', 'gh pr create'],
  ]) {
    const at = lib.indexOf(mutation);
    assert.ok(at > -1, `${mutation} must exist in the template`);
    const check = lib.lastIndexOf(`check_execution_gate "${label}"`, at);
    assert.ok(check > -1 && check < at, `the gate must be re-checked immediately before ${mutation}`);

    // CONSECUTIVE executable statements: a printed line still sits in the window, and any statement
    // left there can be widened later.
    const executable = lib
      .slice(check + `check_execution_gate "${label}"`.length, at)
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l !== '' && !l.startsWith('#'));
    assert.deepEqual(
      executable,
      [],
      `nothing executable may sit between the gate check and ${mutation}; found: ${executable.join(' | ')}`,
    );
  }
});

/* ================= the two manifests must not be conflated, semantically ======================= */
//
// Presence checks passed while `publish-gates/README.md` still said "in Stage B the same gate becomes
// the input to real publication" and described "A gate" as the machine-readable form of
// HUMAN_GATE_GRANTED. Both sentences contained the right vocabulary and the wrong meaning. These
// tests judge the CLAIM: which document authorizes, and which one Stage B will consume.

const SCOPE = String.raw`review[- ]scope`;

/**
 * Schema rows say it a third way — "exactly what may be published" — so rows carry their own verb
 * list. Keeping the lists separate stops ordinary prose about publishing from reading as an authority
 * claim.
 */
const ROW_CLAIM_VERB = /\b(authoriz\w*|grants?|granted|confers?|publish\w*)\b/gi;

/** A denial undone by an exception is not a denial. */
const QUALIFIED_DENIAL = /^[\w-]+\s+(?:nothing|no)\b[^.]{0,60}\b(?:except|other than|apart from|besides|save for|but for)\b/i;

/** A clause boundary followed by a different named subject, immediately before the predicate. */
const OTHER_SUBJECT_OWNS_IT =
  /(?:[;|]|\b(?:but|while|and|whereas|however|although)\b)\s+(?:the\s+|a\s+|an\s+)?(?:execution gate|artifact|pull request|hook|bot credential|Stage B|human gate|operator|approver|reviewer|Codex|Opus|Zamp)\s+(?:\w+\s+){0,2}$/i;

/** Is a negation attached to THIS predicate occurrence, rather than merely nearby? */
function occurrenceIsDenied(before, tail) {
  return (
    /\b(?:does|do|did|is|are|was|were|would|will|may|can|could|shall|should)\s+not\s+(?:\w{1,12}\s+)?$/i.test(before) ||
    /\b(?:cannot|can't|never)\s+(?:\w{1,12}\s+)?$/i.test(before) ||
    /\bno\s+(?:\w+\s+){0,3}$/i.test(before) ||
    (/^[\w-]+\s+(?:nothing\b|no\b)/i.test(tail) && !QUALIFIED_DENIAL.test(tail))
  );
}

/**
 * Every predicate of ONE relationship that remains a positive claim.
 *
 * A denial neutralizes only its own predicate, so each occurrence is judged separately. And a
 * relationship with no recognized predicate is **not** a denied relationship — treating an empty
 * predicate set as "all denied" silently suppressed a real claim, because absence of evidence is not
 * evidence of a denial.
 *
 * @param {string} sentence
 * @param {{subject: RegExp, verbs: RegExp}} relationship
 * @returns {{predicates: string[], undenied: string[]}}
 */
function relationshipPredicates(sentence, { subject, verbs }) {
  const t = sentence.replace(/[*`]/g, ''); // emphasis only; underscores belong to identifiers
  const found = { predicates: [], undenied: [] };
  const at = subject.exec(t);
  if (!at) return found;
  const after = t.slice(at.index + at[0].length);

  for (const m of after.matchAll(new RegExp(verbs.source, 'gi'))) {
    const before = after.slice(0, m.index);
    const tail = after.slice(m.index);
    if (OTHER_SUBJECT_OWNS_IT.test(before)) continue; // a clause with its own subject owns it
    found.predicates.push(m[0]);
    if (!occurrenceIsDenied(before, tail)) found.undenied.push(m[0]);
  }
  return found;
}

/** Denied only when predicates exist AND every one of them is denied. */
function relationshipIsFullyDenied(sentence, relationship) {
  const { predicates, undenied } = relationshipPredicates(sentence, relationship);
  return predicates.length > 0 && undenied.length === 0;
}

/** The review-scope authorization relationship, asserted on directly by several tests. */
const SCOPE_AUTHORITY = {
  subject: new RegExp(SCOPE, 'i'),
  verbs: /\b(authoriz\w*|grants?|granted|confers?|promot\w*|becomes?)\b/,
};
const undeniedScopePredicates = (sentence) => relationshipPredicates(sentence, SCOPE_AUTHORITY).undenied;

/** Stage B is the other actor that may be said not to promote the scope into an authorization. */
const STAGE_B_DOES_NOT_PROMOTE = /\bStage B\b[^.]{0,40}\bdoes\s+not\s+promote\b[^.]{0,40}review[- ]scope/i;

/**
 * Claim SPANS, not sentence patterns.
 *
 * Five rounds of findings all had one shape: a denial matched somewhere in the sentence and suppressed
 * the whole sentence. Narrowing the denial regex never fixed it, because the unit of judgement was
 * wrong. So each entry now names the exact span that IS the claim, and the negation has to break that
 * span or sit immediately before it. A denial about a different object cannot reach it, because the
 * span it would have to interrupt is somewhere else in the sentence.
 *
 * This scanner is **advisory**. The authoritative control is the allowlist in
 * `spec/authority-policy.json`: it fails closed on any authority statement that is not explicitly
 * permitted, which is bounded, whereas detecting bad prose is not.
 */
const CONFLATION_PATTERNS = [
  {
    label: 'a gate or the review scope described as the publication input',
    subject: /\b(?:the same gate|review[- ]scope)\b/i,
    // The span is the PREDICATE alone. A negation either breaks the span — "does not become the
    // publication input" simply does not contain "become the publication input" — or sits immediately
    // before it. A denial about a different object is elsewhere in the sentence and cannot reach it.
    claims: /\b(?:becomes?|is|serves? as|acts? as|promoted (?:into|to))\s+(?:the\s+|a\s+|an\s+)?(?:publication\s+input|input\s+(?:to|for)\s+(?:\w+\s+){0,3}publication)\b/gi,
  },
  {
    label: 'a generic "gate" as the machine-readable HUMAN_GATE_GRANTED',
    subject: /\bA gate\b/i,
    claims: /\bis\s+(?:the\s+)?machine-readable\s+form\s+of\s+(?:a|an)?\s*`?HUMAN_GATE_GRANTED/gi,
  },
  {
    label: 'the review scope authorizing an operation',
    // This relationship really does carry several predicates in one sentence, so it keeps the
    // per-occurrence enumeration rather than a span.
    re: new RegExp(String.raw`${SCOPE}[^.]{0,60}\bauthoriz\w+`, 'i'),
    relationship: SCOPE_AUTHORITY,
    denials: [STAGE_B_DOES_NOT_PROMOTE],
  },
];

/** Text immediately before a claim span, within the same clause. */
const ADJACENT_NEGATION =
  /\b(?:does|do|did|is|are|was|were|would|will|may|can|could|shall|should)\s+not\s+(?:\w{1,12}\s+)?$|\b(?:never|cannot|can't)\s+(?:\w{1,12}\s+)?$/i;

/**
 * Shared scanner, so the positive controls exercise the SAME code the repository scan does.
 *
 * A positive control that reimplements the matcher proves nothing about the guard.
 */
function findConflations(files) {
  const violations = [];
  for (const { rel, text, markdown } of files) {
    for (const { line, text: sentence } of sentencesOf(text, { markdown })) {
      for (const { label, re, subject, claims, relationship, denials } of CONFLATION_PATTERNS) {
        const t = sentence.replace(/[*`]/g, '');

        // Span-based entries: every occurrence is judged on its own, the subject must precede it, and
        // a negation counts only when it sits immediately before that occurrence.
        if (claims) {
          const at = subject.exec(t);
          if (!at) continue;
          for (const m of t.matchAll(claims)) {
            if (m.index < at.index) continue; // the predicate must follow its subject
            if (ADJACENT_NEGATION.test(t.slice(0, m.index))) continue;
            violations.push(`${rel}:${line}: [${label}] ${m[0].trim().slice(0, 140)}`);
          }
          continue;
        }

        // Enumeration where a relationship carries several predicates. Finding nothing is never a
        // denial.
        if (!re.test(sentence)) continue;
        if (relationship && relationshipIsFullyDenied(sentence, relationship)) continue;
        if ((denials ?? []).some((d) => d.test(t))) continue;
        violations.push(`${rel}:${line}: [${label}] ${sentence.trim().slice(0, 140)}`);
      }
    }
  }
  return violations;
}

test('no document promotes the review scope into an authorization', () => {
  assert.deepEqual(findConflations(SOURCES.map((rel) => ({ rel, text: read(rel), markdown: rel.endsWith('.md') }))), []);
});

test('POSITIVE CONTROL: findConflations reports the exact sentences that shipped', () => {
  // Previously this only asserted `re.test(sentence)`, which cannot see a denial matcher suppressing
  // the claim — precisely the failure mode of the last three rounds. It now goes through the real
  // scanner, so it exercises claim matching AND denial handling together.
  for (const shipped of [
    'In **Stage B** the same gate becomes the input to real publication under the executor bot credential.',
    'A gate is **evidence of a decision**, not a credential: it is the machine-readable form of a `HUMAN_GATE_GRANTED` message.',
  ]) {
    assert.ok(scan(shipped).length >= 1, `findConflations must report: ${shipped}`);
  }
});

test('the gate document attributes each stage to the right manifest', () => {
  const flat = read('.agent-handoff/publish-gates/README.md').replace(/\s+/g, ' ');
  // Stage A validates the review scope, by that name.
  assert.match(flat, /In \*\*Stage A\*\* the \*\*review scope manifest\*\* is only ever \*validated\*/);
  assert.match(flat, /The review scope authorizes nothing/i);
  // Stage B authorizes with an authenticated EXECUTION gate, not "the same gate".
  assert.match(flat, /In \*\*Stage B\*\* publication is authorized by an \*\*authenticated execution gate\*\*/);
  assert.match(flat, /Stage B does \*not\* promote the review scope into an authorization/i);
  // Only the execution gate is the machine-readable HUMAN_GATE_GRANTED.
  assert.match(flat, /An \*\*execution gate\*\*[\s\S]{0,240}machine-readable form of a `HUMAN_GATE_GRANTED`/);
  // The opening line must not make the same generic claim about "a publish gate".
  assert.match(flat, /This folder documents the \*\*review scope manifest\*\*\. It is not the authorization to publish/);
  assert.match(flat, /The review scope manifest is \*\*not\*\* a `HUMAN_GATE_GRANTED`/);
});

/* ================= the negation bypass, and the schema's authority wording ====================== */

test('POSITIVE CONTROL: an unrelated negation no longer excuses a later claim', () => {
  // Reproduced by review, verbatim: a paragraph-wide negation check skipped this whole block because
  // the FIRST sentence contains "not". The scanner now judges the sentence that matched.
  const planted = 'The review scope is not a credential. The review scope authorizes publication.';
  const hits = findConflations([{ rel: 'planted.md', text: planted, markdown: true }]);
  assert.equal(hits.length, 1, `the second sentence must be reported; got ${JSON.stringify(hits)}`);
  assert.match(hits[0], /authoriz/i);

  // And a genuine denial in the SAME sentence is still not a violation.
  const denied = 'The review scope authorizes nothing, in Stage A or ever.';
  assert.deepEqual(findConflations([{ rel: 'denied.md', text: denied, markdown: true }]), []);
});

test('POSITIVE CONTROL: a wrapped sentence is still judged as one sentence', () => {
  // Joining wrapped lines must survive the change: a negation split across a line break still
  // covers its own sentence.
  const wrapped = 'The review scope does\nnot authorize publication.';
  assert.deepEqual(findConflations([{ rel: 'wrapped.md', text: wrapped, markdown: true }]), []);
});

/**
 * The review-scope schema table must not describe any field as granting publication authority.
 *
 * Same rule as the prose scanner, and it had the same bypass: a row-wide denial hid a later claim.
 * This row produced nothing at all —
 *
 *   | executor | grants no publication authority but is authorized to publish the branch |
 *
 * — because "grants no publication authority" was read as covering the whole cell. Each predicate in
 * the cell is now judged on its own, with the field as the subject.
 */
function findScopeAuthorityClaims(text) {
  const start = text.indexOf('## Schema');
  const end = text.indexOf('## Why each field exists');
  if (start < 0 || end < 0) return ['the Schema section could not be located'];

  const violations = [];
  for (const row of text.slice(start, end).split('\n')) {
    if (!/^\s*\|/.test(row)) continue;
    const cells = row.split('|').slice(1, -1);
    for (const cell of cells) {
      const t = cell.replace(/[*`]/g, '');
      const claims = [];
      for (const m of t.matchAll(ROW_CLAIM_VERB)) {
        const before = t.slice(0, m.index);
        const tail = t.slice(m.index);
        // Only a publication-flavoured predicate matters here.
        if (!/^(authoriz|grant|confer|publish)/i.test(m[0]) && !/publi(sh|cation)/i.test(tail.slice(0, 40))) continue;
        const deniedBefore =
          /\b(?:does|do|did|is|are|was|were|would|will|may|can|could|shall|should)\s+not\s+(?:\w{1,12}\s+)?$/i.test(before) ||
          /\b(?:cannot|can't|never)\s+(?:\w{1,12}\s+)?$/i.test(before) ||
          /\bno\s+(?:\w+\s+){0,3}$/i.test(before);
        const deniedAfter = /^\w+\s+(?:nothing\b|no\b)/i.test(tail) && !QUALIFIED_DENIAL.test(tail);
        if (deniedBefore || deniedAfter) continue;
        claims.push(m[0]);
      }
      if (claims.length) violations.push(`${row.trim()}  [claim: ${claims.join(' / ')}]`);
    }
  }
  return violations;
}

test('no review-scope schema field grants publication authority', () => {
  const violations = findScopeAuthorityClaims(read('.agent-handoff/publish-gates/README.md'));
  assert.deepEqual(violations, [], `the review scope authorizes nothing:\n${violations.join('\n')}`);
});

test('POSITIVE CONTROL: a schema row granting publication authority is caught', () => {
  // The exact shape that shipped: the `executor` row described as authorized to publish.
  const planted = [
    '## Schema',
    '',
    '| Field | Meaning |',
    '| --- | --- |',
    '| `executor` | the agent identity authorized to publish — a gate is not transferable |',
    '| `commits` | full 40-char SHAs, **ordered**, exactly what may be published |',
    '',
    '## Why each field exists',
  ].join('\n');
  const hits = findScopeAuthorityClaims(planted);
  assert.equal(hits.length, 2, `both rows must be reported; got ${JSON.stringify(hits)}`);
});

test('the review-scope schema states plainly that it grants no publication authority', () => {
  const flat = read('.agent-handoff/publish-gates/README.md').replace(/\s+/g, ' ');
  assert.match(flat, /No field here grants publication authority/i);
  assert.match(flat, /confers no publication authority/i);
  assert.match(flat, /in scope for preparation and review/i);
});

/* ================= negation must bind to the prohibited relationship ========================== */
//
// Moving from paragraph to sentence was only half the fix. Within one sentence, an unrelated denial
// still exempted the claim. These drive `findConflations()` DIRECTLY — not the repository, not a
// poisoned file — so nothing else in the suite can account for a pass.

const scan = (text) => findConflations([{ rel: 'input.md', text, markdown: true }]);

test('REGRESSION: an unrelated negation in the same sentence does not exempt the claim', () => {
  const hits = scan('The review scope is not a credential but authorizes publication.');
  assert.equal(hits.length, 1, `expected exactly one violation, got ${JSON.stringify(hits)}`);
  assert.match(hits[0], /authoriz/i);
});

test('REGRESSION: an unrelated negation in another table cell does not exempt the claim', () => {
  const hits = scan('| Review scope authorizes publication | it is not a credential |');
  assert.equal(hits.length, 1, `expected exactly one violation, got ${JSON.stringify(hits)}`);
  assert.match(hits[0], /authoriz/i);
});

test('a negation BOUND to the relationship is still accepted, in every documented form', () => {
  // These are the only shapes that may exempt a claim, and each must actually work — otherwise the
  // guard becomes unusable and the next author simply deletes it.
  for (const accepted of [
    'The review scope does not authorize publication.',
    'The review scope cannot authorize publication.',
    'The review scope never authorizes publication.',
    'The review scope authorizes nothing, in Stage A or ever.',
    'The review scope grants no publication authority.',
    'Stage B does not promote the review scope into an authorization.',
  ]) {
    assert.deepEqual(scan(accepted), [], `this denial must be accepted: ${accepted}`);
  }
});

test('the accepted forms are not accepted for the WRONG reason', () => {
  // Each denial above must be doing the work. Strip the negation and the same sentence must fail,
  // which proves the exemption comes from the bound negation and not from a pattern that never
  // matched in the first place.
  for (const [denial, claim] of [
    ['The review scope does not authorize publication.', 'The review scope does authorize publication.'],
    ['The review scope never authorizes publication.', 'The review scope always authorizes publication.'],
    ['The review scope authorizes nothing, in Stage A or ever.', 'The review scope authorizes publication, in Stage A or ever.'],
  ]) {
    assert.deepEqual(scan(denial), [], `denial must pass: ${denial}`);
    assert.equal(scan(claim).length, 1, `claim must fail: ${claim}`);
  }
});

test('REGRESSION: the schema-row scanner binds negation to the claim as well', () => {
  const planted = [
    '## Schema',
    '',
    '| Field | Meaning |',
    '| --- | --- |',
    // An unrelated denial about transferability must not excuse the authority claim.
    '| `executor` | the agent identity authorized to publish — a gate is not transferable |',
    // A bound denial must be accepted.
    '| `executor` | the identity this scope was prepared for — it confers no publication authority |',
    '| `expiresAt` | so a decision cannot authorize the next cycle |',
    '',
    '## Why each field exists',
  ].join('\n');
  const hits = findScopeAuthorityClaims(planted);
  assert.equal(hits.length, 1, `only the unbound claim must be reported; got ${JSON.stringify(hits)}`);
  assert.match(hits[0], /authorized to publish/);
});

/* ================= denials must bind the SUBJECT, not just a verb ============================== */
//
// Binding to the verb was still a bypass. Each of these is a claim about the review scope with a
// denial about something else, and all three were reproducible false negatives. They run through
// `findConflations()` directly.

test('REGRESSION: a denial about another component does not exempt the review scope', () => {
  const hits = scan('The review scope authorizes publication while another component confers no authority.');
  assert.equal(hits.length, 1, `expected one violation, got ${JSON.stringify(hits)}`);
});

test('REGRESSION: an unrelated security-defect clause does not exempt the review scope', () => {
  const hits = scan('The review scope authorizes publication; missing audit evidence would be a security defect.');
  assert.equal(hits.length, 1, `expected one violation, got ${JSON.stringify(hits)}`);
});

test('REGRESSION: a negated verb about a DIFFERENT subject does not exempt the review scope', () => {
  const hits = scan('The review scope authorizes publication while deployment does not authorize billing.');
  assert.equal(hits.length, 1, `expected one violation, got ${JSON.stringify(hits)}`);
});

test('only subject-bound denials exempt a claim, and each documented form works', () => {
  // The accepted set is deliberately small. Every entry must pass, or authors cannot state the truth
  // and will delete the guard instead.
  for (const accepted of [
    'The review scope does not authorize publication.',
    'The review scope cannot authorize publication.',
    'The review scope never authorizes publication.',
    'The review scope authorizes nothing, in Stage A or ever.',
    'The review scope grants no publication authority.',
    'The review scope confers no publication authority.',
    'Stage B does not promote the review scope into an authorization.',
  ]) {
    assert.deepEqual(scan(accepted), [], `must be accepted: ${accepted}`);
  }
});

test('a subject-bound denial for the WRONG subject does not carry over', () => {
  // "deployment does not authorize" is a perfectly good denial — about deployment. It must not
  // launder a claim about the review scope sitting in the same sentence.
  assert.equal(scan('Deployment does not authorize billing.').length, 0);
  assert.equal(
    scan('Deployment does not authorize billing, but the review scope authorizes publication.').length,
    1,
  );
});

test('underscored identifiers survive the scanners — the dead matcher is really gone', () => {
  // `plain()` strips underscores, which is why a HUMAN_GATE_GRANTED matcher hidden behind it could
  // never fire. Asserted behaviourally from both sides rather than by grepping this file.
  assert.equal(/HUMAN_GATE_GRANTED/.test(plain('not a HUMAN_GATE_GRANTED')), false, 'plain() removes underscores');
  const rel = { subject: /\bA gate\b/i, verbs: /\bmachine-readable\b/ };
  assert.deepEqual(
    relationshipPredicates('A gate is not the machine-readable form of a HUMAN_GATE_GRANTED', rel).undenied,
    [],
    'a complete denial about an underscored identifier must be recognised',
  );
  // Emphasis is still stripped, so `**not**` reads as `not`.
  assert.deepEqual(
    relationshipPredicates('A gate is **not** the machine-readable form of a HUMAN_GATE_GRANTED', rel).undenied,
    [],
  );
});

test('the denial must attach to the FIRST authority verb after the subject', () => {
  // Coordination keeps the subject, so this must be accepted…
  assert.deepEqual(scan('A review scope manifest bounds what may be prepared and authorizes nothing.'), []);
  // …while a later clause with its own subject must not launder the claim, however it is joined.
  for (const claim of [
    'The review scope authorizes publication while another component confers no authority.',
    'The review scope authorizes publication and deployment does not authorize billing.',
    'The review scope authorizes publication; the execution gate authorizes nothing.',
  ]) {
    assert.equal(scan(claim).length, 1, `must be reported: ${claim}`);
  }
});

/* ================= a denial neutralizes only its OWN predicate ================================= */
//
// Attaching the denial to the first authority verb was still too coarse: a sentence carries more than
// one predicate, and denying one must not cover the rest. All three inputs below were reproducible
// false negatives, and all three run through the real scanners.

test('REGRESSION: denying one predicate does not hide a second, positive one', () => {
  const hits = scan('The review scope does not authorize deployment but authorizes publication.');
  assert.equal(hits.length, 1, `expected one violation, got ${JSON.stringify(hits)}`);
});

test('REGRESSION: an exception undoes the denial it follows', () => {
  const hits = scan('The review scope authorizes nothing except publication.');
  assert.equal(hits.length, 1, `expected one violation, got ${JSON.stringify(hits)}`);
  // Every phrasing of the carve-out, not just the one reported.
  for (const variant of ['other than publication', 'apart from publication', 'besides publication', 'save for publication']) {
    assert.equal(scan(`The review scope authorizes nothing ${variant}.`).length, 1, variant);
  }
});

test('REGRESSION: a schema row denial does not hide a later claim in the same cell', () => {
  const planted = [
    '## Schema',
    '',
    '| Field | Meaning |',
    '| --- | --- |',
    '| `executor` | grants no publication authority but is authorized to publish the branch |',
    '',
    '## Why each field exists',
  ].join('\n');
  const hits = findScopeAuthorityClaims(planted);
  assert.equal(hits.length, 1, `the later claim must be reported; got ${JSON.stringify(hits)}`);
  assert.match(hits[0], /authorized/i);
});

test('complete denials still pass, and every predicate is accounted for', () => {
  // If a full denial were reported, authors could not state the truth and would delete the guard.
  for (const accepted of [
    'The review scope does not authorize publication.',
    'The review scope does not authorize deployment and does not authorize publication.',
    'The review scope authorizes nothing.',
    'The review scope authorizes nothing, in Stage A or ever.',
    'The review scope grants no publication authority.',
    'The review scope confers no publication authority.',
    'The review scope cannot authorize publication and cannot authorize deployment.',
    'A review scope manifest bounds what may be prepared and authorizes nothing.',
    'Stage B does not promote the review scope into an authorization.',
    // A different subject owning its own true predicate.
    'The review scope authorizes nothing; the execution gate authorizes publication.',
  ]) {
    assert.deepEqual(scan(accepted), [], `must be accepted: ${accepted}`);
  }

  // …and the enumeration really is per-predicate: one denied, one not.
  assert.deepEqual(
    undeniedScopePredicates('The review scope does not authorize deployment but authorizes publication.'),
    ['authorizes'],
  );
  assert.deepEqual(undeniedScopePredicates('The review scope does not authorize publication.'), []);
});

test('schema rows accept only field-bound complete denials', () => {
  const accepted = [
    '## Schema',
    '',
    '| Field | Meaning |',
    '| --- | --- |',
    '| `executor` | the identity this scope was prepared for — it confers no publication authority |',
    '| `expiresAt` | so a decision cannot authorize the next cycle |',
    '| — | **No field here grants publication authority.** |',
    '| `commits` | full 40-char SHAs, **ordered**, exactly what is in scope for preparation and review |',
    '',
    '## Why each field exists',
  ].join('\n');
  assert.deepEqual(findScopeAuthorityClaims(accepted), []);
});

/* ================= a relationship with no predicate is NOT a denied relationship =============== */
//
// The suppression these cover is structural rather than linguistic: when the scanner could not find a
// predicate it counted zero undenied predicates and read that as "all denied". Absence of evidence
// was treated as evidence of a denial, which is the wrong default for a security guard.

test('REGRESSION: a claim whose verb the enumerator does not know is still reported', () => {
  // "serves as" was recognised by the claim pattern but absent from the predicate list.
  const hits = scan('The review scope serves as the publication input.');
  assert.equal(hits.length, 1, `expected one violation, got ${JSON.stringify(hits)}`);
  // Same shape, other phrasing.
  assert.equal(scan('The review scope acts as the publication input.').length, 1);
});

test('REGRESSION: a denial about a different property does not exempt the same gate', () => {
  const hits = scan('The same gate is not immutable but becomes the publication input.');
  assert.equal(hits.length, 1, `expected one violation, got ${JSON.stringify(hits)}`);
});

test('REGRESSION: a denial about optionality does not exempt the machine-readable claim', () => {
  const hits = scan('A gate is not optional but is the machine-readable form of HUMAN_GATE_GRANTED.');
  assert.equal(hits.length, 1, `expected one violation, got ${JSON.stringify(hits)}`);
});

test('every pattern still accepts a denial bound to its own relationship', () => {
  // One complete denial per pattern. Without these the guard would be unusable and an author would
  // remove it rather than phrase around it.
  for (const accepted of [
    'The same gate does not become the publication input.',
    'The same gate is never the publication input.',
    'The review scope does not become the publication input.',
    'The review scope is not promoted into a publication input.',
    'A gate is not the machine-readable form of a HUMAN_GATE_GRANTED.',
    'The review scope does not authorize publication.',
    'Stage B does not promote the review scope into an authorization.',
  ]) {
    assert.deepEqual(scan(accepted), [], `must be accepted: ${accepted}`);
  }
});

test('an empty predicate set never counts as a denial, for any pattern', () => {
  // Asserted on the primitive, so a future pattern cannot reintroduce the default-exempt behaviour.
  const noSuchVerb = { subject: /\bthe same gate\b/i, verbs: /\bnever-appears-here\b/ };
  assert.equal(relationshipIsFullyDenied('The same gate becomes the publication input.', noSuchVerb), false);
  const realVerb = { subject: /\bthe same gate\b/i, verbs: /\bbecomes?\b/ };
  assert.equal(relationshipIsFullyDenied('The same gate does not become the publication input.', realVerb), true);
});

/* ================= a denial neutralizes only the OCCURRENCE it interrupts ====================== */
//
// Five rounds of findings shared one shape: a denial matched somewhere in the sentence and suppressed
// the whole sentence. Narrowing the denial never fixed it, because the unit of judgement was wrong.
// The claim is now a predicate SPAN, judged per occurrence.

test('REGRESSION: a denial of one object does not exempt a claim about another (same gate)', () => {
  const hits = scan('The same gate does not become the documentation input but becomes the publication input.');
  assert.equal(hits.length, 1, `expected one violation, got ${JSON.stringify(hits)}`);
  assert.match(hits[0], /becomes the publication input/i);
});

test('REGRESSION: a denial of one object does not exempt a claim about another (review scope)', () => {
  const hits = scan('The review scope does not become a documentation input but serves as the publication input.');
  assert.equal(hits.length, 1, `expected one violation, got ${JSON.stringify(hits)}`);
  assert.match(hits[0], /serves as the publication input/i);
});

test('REGRESSION: a denial about an advisory review does not exempt the HUMAN_GATE_GRANTED claim', () => {
  const hits = scan(
    'A gate is not the machine-readable form of an advisory review but is the machine-readable form of HUMAN_GATE_GRANTED.',
  );
  assert.equal(hits.length, 1, `expected one violation, got ${JSON.stringify(hits)}`);
});

test('the complete-denial equivalents of all three still pass', () => {
  for (const accepted of [
    'The same gate does not become the publication input.',
    'The same gate is never the publication input.',
    'The review scope does not become the publication input.',
    'The review scope does not serve as the publication input.',
    'The review scope is not promoted into a publication input.',
    'A gate is not the machine-readable form of a HUMAN_GATE_GRANTED.',
    'A gate is never the machine-readable form of a HUMAN_GATE_GRANTED.',
  ]) {
    assert.deepEqual(scan(accepted), [], `must be accepted: ${accepted}`);
  }
});

/* ================= the AUTHORITATIVE control: a closed authority policy ======================== */
//
// The prose scanner above is advisory, and five rounds of bypasses are the argument for why it cannot
// be the guarantee: detecting bad prose is unbounded. This inverts the problem. Every sentence on a
// canonical surface that makes an authority claim must appear, verbatim and normalized, in
// spec/authority-policy.json. A new phrasing fails until a human adds it deliberately — fail-closed,
// the same discipline as the closed nine-key execution-gate schema.

/**
 * Parsed at module scope, VALIDATED in its own test.
 *
 * Validating here would throw during module evaluation, and node's test runner then reports one opaque
 * failure for the whole file — three hundred other assertions never run, and the reason is invisible.
 * A malformed policy must fail loudly and attributably, so validation is a test of its own and the
 * dependent tests read the parsed document.
 */
const POLICY = JSON.parse(read('spec/authority-policy.json'));

/** Surfaces come FROM the policy, so the list itself is validated closed rather than restated here. */
const POLICY_SURFACES = POLICY.governedSurfaces ?? [];

/**
 * The governed vocabulary. Any statement naming one of these documents is in scope.
 *
 * There is deliberately NO second filter for "does this sound like an authority claim". That filter
 * was the same unbounded-detection mistake one level up: a planted sentence — "The review scope may
 * serve as sufficient basis for publication in urgent cases" — contained no word from the authority
 * list, so the collector never saw it and the allowlist never checked it. Dropping the filter makes
 * the collector mechanical: every sentence about a governed document must be explicitly permitted.
 */
/**
 * The governed vocabulary — every instrument, not only the publication one.
 *
 * Design round 3 found the gap: the collector recognized publication-gate phrases only, so the new
 * documents' entries were empty because nothing about cloud authority, spend authority, the human
 * approver or Gemini's standing was ever COLLECTED. An empty allowlist that nothing feeds is not a
 * closed policy, it is a decoration. The vocabulary now covers all three authorization kinds and
 * the two role claims that carry authority.
 */
/**
 * Round 7 widened it again, for the reason round 3 established: a new instrument whose sentences
 * nobody collects is governed in name only. `stack-record-authorization` is an authorization
 * instrument, and risk acceptance is a capability only Zamp holds — both belong in the vocabulary.
 */
const GOVERNED_DOC = /review[- ]scope|execution gate|publish gate|the same gate|\ba gate\b|cloud authorization|spend authorization|cloud-authorization|spend-authorization|stack-record-authorization|stack-record cleanup|risk acceptance|riskAccept|CBA_CLOUD_GATE|humanApprover|human approver|gemini spec auditor/i;
const normalizeStatement = (s) => s.replace(/[*`]/g, '').replace(/\s+/g, ' ').trim();

/**
 * Every statement on a surface that mentions a governed document.
 *
 * Parsed SEQUENTIALLY, line by line. Choosing one representation per markdown block was a real gap:
 * a block containing a table was parsed entirely as table rows, so prose sitting immediately before or
 * after the table — with no blank line between — was discarded and never checked. Prose accumulates
 * into a paragraph buffer; a table row flushes it and is a unit in its own right; a blank line flushes
 * it. Nothing is skipped because of what a neighbouring line happens to be.
 */
function authorityStatements(text) {
  const out = [];
  let paragraph = [];
  let inFence = false;
  let historical = false;

  const flush = () => {
    if (!paragraph.length) return;
    const joined = paragraph.join(' ').replace(/\s+/g, ' ');
    for (const sentence of joined.split(/(?<=[.!?])\s+/)) {
      const t = normalizeStatement(sentence);
      if (t && GOVERNED_DOC.test(t)) out.push(t);
    }
    paragraph = [];
  };

  for (const line of text.split('\n')) {
    if (/^\s*```/.test(line)) {
      flush();
      inFence = !inFence;
      continue;
    }
    if (inFence) continue; // fenced code is example text, not a statement about authority

    // A section explicitly marked historical is an append-only record of what a document USED to say.
    // The contract allows those to keep former wording; describing a superseded claim accurately
    // requires writing it down, and an active instruction must not contain it.
    if (/^\s*#/.test(line)) {
      flush();
      historical = /\b(historical|superseded)\b/i.test(line);
      continue;
    }
    if (historical) continue;
    if (line.trim() === '') {
      flush();
      continue;
    }
    if (/^\s*\|/.test(line)) {
      flush(); // prose that ended where the table began is still a statement
      if (/^\s*\|[\s:|-]+\|\s*$/.test(line)) continue; // separator row
      const t = normalizeStatement(line);
      if (t && GOVERNED_DOC.test(t)) out.push(t);
      continue;
    }
    paragraph.push(line.trim());
  }
  flush();
  return out;
}

test('the authority policy states the invariants as data, not prose', () => {
  // The review scope authorizes nothing — as an empty list, not a sentence a scanner has to parse.
  assert.deepEqual(POLICY.documents['review-scope'].authorizes, []);
  assert.deepEqual(POLICY.documents['review-scope'].bounds, ['preparation', 'review']);
  assert.equal(POLICY.documents['review-scope'].suppliedAs, '--gate');

  // The execution gate authorizes exactly two effects, and is bound to the artifact digest.
  assert.deepEqual(POLICY.documents['execution-gate'].authorizes, [
    'push-reviewed-commit-to-task-branch',
    'create-or-reuse-one-pull-request',
  ]);
  assert.equal(POLICY.documents['execution-gate'].messageType, 'HUMAN_GATE_GRANTED');
  assert.equal(POLICY.documents['execution-gate'].boundTo, 'artifactDigest');
  assert.equal(POLICY.documents['execution-gate'].suppliedAs, 'CBA_EXECUTION_GATE');

  // Merge is authorized by Zamp's MERGE_DECISION and performed by Zamp. Recording it as authorized
  // by nothing was wrong in a way that mattered: it reads as "no gate needed".
  assert.equal(POLICY.effects.merge.authorizedBy, 'MERGE_DECISION');
  assert.equal(POLICY.effects.merge.performedBy, 'zamp');
  // Deploy needs its own instrument — the cloud authorization, never the publication gate
  // (#70 design round 3). Preparing change sets is a cloud effect too, and is named as one.
  assert.equal(POLICY.effects.deploy.authorizedBy, 'cloud-authorization');
  assert.equal(POLICY.effects.deploy.performedBy, 'zamp');
  for (const effect of ['prepare-change-sets', 'execute-change-sets', 'abandon-change-sets']) {
    assert.equal(POLICY.effects[effect].authorizedBy, 'cloud-authorization');
    assert.equal(POLICY.effects[effect].performedBy, 'zamp');
  }
  assert.equal(POLICY.effects['invoke-paid-model-audit'].authorizedBy, 'spend-authorization');
  assert.equal(POLICY.effects['invoke-paid-model-audit'].performedBy, 'zamp');
  // The three instruments are distinct documents, and none authorizes another's effects.
  assert.deepEqual(POLICY.documents['cloud-authorization'].authorizes, ['deploy', 'prepare-change-sets', 'execute-change-sets', 'abandon-change-sets']);
  // Round 4: the instrument binds the COMPLETE manifest, not a release SHA plus one digest.
  // Round 5: it also binds its MODE, its decision and its window, and the mode map proves — as
  // data — that a plan_only value cannot execute or abandon anything.
  assert.equal(POLICY.documents['cloud-authorization'].boundTo, 'mode+decisionId+manifestDigest+stacks+planDigest+window');
  assert.deepEqual(POLICY.documents['cloud-authorization'].modes, {
    plan_only: ['prepare-change-sets'],
    deploy: ['deploy', 'execute-change-sets'],
    abandon: ['abandon-change-sets'],
  });
  // Removing the empty stack RECORD is a DISTINCT effect, with its own instrument, and no lane
  // performs it. Round 6: it used to name the cloud instrument, which did not authorize it — the
  // effect read as authorized and no value could authorize it.
  assert.equal(POLICY.effects['delete-review-in-progress-stack-record'].performedBy, 'zamp');
  assert.equal(POLICY.effects['delete-review-in-progress-stack-record'].authorizedBy, 'stack-record-authorization');
  assert.match(POLICY.effects['delete-review-in-progress-stack-record'].note, /human-performed only/);
  const cleanup = POLICY.documents['stack-record-authorization'];
  assert.deepEqual(cleanup.authorizes, ['delete-review-in-progress-stack-record']);
  assert.equal(cleanup.writtenBy, 'zamp');
  // Out of band, so no lane can consume a value permitting it.
  assert.equal(cleanup.suppliedAs, 'out-of-band record');
  // The cloud instrument must NOT carry it: that is what would make it lane-readable.
  assert.equal(POLICY.documents['cloud-authorization'].authorizes.includes('delete-review-in-progress-stack-record'), false);
  // ROUND 7: the binding names the account, region, stack NAME and immutable ARN, the exact
  // status and the instant — recording WHEN someone looked constrained nothing on its own.
  assert.equal(cleanup.boundTo, 'issue+decisionId+environment+account+region+stackName+stackId+observedStatus+observedAt');
  assert.equal(cleanup.maxObservationAgeMinutes, 15);
  // And the residual that no re-observation can close: unaccepted, so NO procedure exists.
  // Round 8: acceptance is a RECORD or nothing — null means no one accepted anything.
  assert.equal(cleanup.riskAcceptance, null);
  assert.equal(cleanup.executableProcedure, false);
  assert.match(cleanup.residualRisk, /compare-and-delete/);
  const modeEffects = Object.values(POLICY.documents['cloud-authorization'].modes).flat();
  assert.equal(new Set(modeEffects).size, modeEffects.length, 'an effect belongs to exactly one mode');
  assert.deepEqual(POLICY.documents['spend-authorization'].authorizes, ['invoke-paid-model-audit']);
  assert.equal(POLICY.documents['cloud-authorization'].writtenBy, 'zamp');
  assert.equal(POLICY.documents['spend-authorization'].writtenBy, 'zamp');
  // Opus may neither author a cloud authorization nor perform a cloud effect.
  assert.ok(POLICY.actors.opus.mayNever.includes('author-cloud-authorization'));
  assert.ok(POLICY.actors.opus.mayNever.includes('perform-cloud-effect'));
  assert.ok(POLICY.actors.codex.mayNever.includes('perform-cloud-effect'));

  // Opus operates but may never approve itself or merge; Codex may never implement or operate.
  assert.ok(POLICY.actors.opus.mayNever.includes('self-approve'));
  assert.ok(POLICY.actors.opus.mayNever.includes('merge'));
  assert.ok(POLICY.actors.codex.mayNever.includes('implement'));
  assert.ok(POLICY.actors.codex.mayNever.includes('operate-artifact'));
  assert.ok(POLICY.actors.codex.mayNever.includes('grant-human-gate'));
  assert.deepEqual(POLICY.actors.gemini.may, []);

  // Every effect the execution gate authorizes must be an effect the policy knows about.
  for (const effect of POLICY.documents['execution-gate'].authorizes) {
    assert.ok(POLICY.effects[effect], `effect ${effect} must be declared`);
    assert.equal(POLICY.effects[effect].authorizedBy, 'execution-gate');
  }
});

test('every authority statement on a canonical surface is explicitly allowed', () => {
  const unlisted = [];
  for (const rel of POLICY_SURFACES) {
    const allowed = new Set(POLICY.allowedAuthorityStatements[rel] ?? []);
    for (const statement of authorityStatements(read(rel))) {
      if (!allowed.has(statement)) unlisted.push(`${rel}: ${statement}`);
    }
  }
  assert.deepEqual(
    unlisted,
    [],
    'these statements make an authority claim that spec/authority-policy.json does not permit.\n' +
      'Fix the sentence, or add it to allowedAuthorityStatements after a human confirms it is correct:\n' +
      unlisted.join('\n'),
  );
});

test('the allowlist has no stale entries — every permitted statement still exists', () => {
  // Fail-closed cuts both ways: an entry left behind after an edit would quietly permit wording that
  // is no longer in the tree, and the next author would inherit an allowance nobody reviewed.
  const stale = [];
  for (const [rel, statements] of Object.entries(POLICY.allowedAuthorityStatements)) {
    const present = new Set(authorityStatements(read(rel)));
    for (const s of statements) if (!present.has(s)) stale.push(`${rel}: ${s}`);
  }
  assert.deepEqual(stale, [], `stale allowlist entries:\n${stale.join('\n')}`);
});

test('POSITIVE CONTROL: an unlisted authority claim fails, and rewording it is what fixes it', () => {
  const allowed = new Set(POLICY.allowedAuthorityStatements['AGENTS.md'] ?? []);
  // A claim the policy does not permit — including the exact shapes the prose scanner missed.
  for (const planted of [
    'The review scope authorizes publication.',
    'The same gate does not become the documentation input but becomes the publication input.',
    'A gate is not the machine-readable form of an advisory review but is the machine-readable form of HUMAN_GATE_GRANTED.',
    'The review scope grants limited publication authority.',
  ]) {
    const found = authorityStatements(planted);
    assert.equal(found.length, 1, `the collector must see it as an authority statement: ${planted}`);
    assert.equal(allowed.has(found[0]), false, `it must not already be permitted: ${planted}`);
  }
  // And a real allowlisted statement is recognised as permitted.
  const real = authorityStatements(read('AGENTS.md'));
  assert.ok(real.length >= 1);
  for (const s of real) assert.ok(allowed.has(s), `already-reviewed statement must be permitted: ${s}`);
});

/* ================= the policy is validated as CLOSED ========================================== */
//
// A closed schema is only closed if rejection is demonstrated. Each case below takes the real policy,
// injects one specific violation, and requires the validator to refuse it. Without these the validator
// could be an empty function and every other test here would still pass.

/** A deep copy of the real policy, so injections cannot leak between cases. */
const clonePolicy = () => JSON.parse(read('spec/authority-policy.json'));

function expectRejected(mutate, expected) {
  const policy = clonePolicy();
  mutate(policy);
  assert.throws(() => validateAuthorityPolicy(policy), (err) => {
    assert.ok(err instanceof PolicyError, `expected a PolicyError, got ${err}`);
    assert.match(err.message, expected, `unexpected reason: ${err.message}`);
    return true;
  });
}

test('the authority policy is a valid closed policy', () => {
  // The whole guarantee rests on this passing; every negative case below proves it can fail.
  assert.doesNotThrow(() => validateAuthorityPolicy(clonePolicy()));
});

test('an unknown actor is rejected', () => {
  expectRejected((p) => {
    p.actors.gemini_ops = { role: 'helper', may: ['validate'], mayNever: [] };
  }, /policy\.actors must be exactly/);
});

test('a missing actor is rejected', () => {
  expectRejected((p) => {
    delete p.actors.gemini;
  }, /policy\.actors must be exactly/);
});

test('an unknown top-level field is rejected', () => {
  expectRejected((p) => {
    p.extra = true;
  }, /policy has unknown key\(s\): extra/);
});

test('an unknown field inside an actor is rejected', () => {
  expectRejected((p) => {
    p.actors.opus.escalation = 'allowed';
  }, /policy\.actors\.opus has unknown key\(s\): escalation/);
});

test('an unknown field inside a document is rejected', () => {
  expectRejected((p) => {
    p.documents['review-scope'].alsoAuthorizes = ['merge'];
  }, /policy\.documents\.review-scope has unknown key\(s\)/);
});

test('a prohibited capability in `may` is rejected', () => {
  for (const cap of ['self-approve', 'force-push', 'administer-repository', 'access-secrets', 'invoke-paid-service', 'grant-human-gate']) {
    expectRejected((p) => {
      p.actors.opus.may.push(cap);
    }, new RegExp(`may contains "${cap}", which no actor may ever be granted`));
  }
});

test('a may/mayNever contradiction is rejected', () => {
  expectRejected((p) => {
    p.actors.opus.may.push('merge');
  }, /lists merge as both may and mayNever/);
});

test('a dropped canonical prohibition is rejected', () => {
  // The exact-set comparison subsumes a "must include" rule, and it names the missing item, so the
  // maintainer is told which prohibition was lost rather than being handed two lists to diff.
  expectRejected((p) => {
    p.actors.opus.mayNever = p.actors.opus.mayNever.filter((c) => c !== 'access-secrets');
  }, /policy\.actors\.opus\.mayNever must be exactly the declared set — missing access-secrets/);
  expectRejected((p) => {
    p.actors.opus.mayNever = p.actors.opus.mayNever.filter((c) => c !== 'invoke-paid-service');
  }, /missing invoke-paid-service/);
  expectRejected((p) => {
    p.actors.codex.mayNever = p.actors.codex.mayNever.filter((c) => c !== 'grant-human-gate');
  }, /policy\.actors\.codex\.mayNever must be exactly the declared set — missing grant-human-gate/);
});

test('an unresolved reference is rejected', () => {
  // an effect that no declared document or decision authorizes
  expectRejected((p) => {
    p.effects.merge.authorizedBy = 'the-vibes';
  }, /policy\.effects\.merge\.authorizedBy must be one of/);
  // a document authorizing an effect that does not exist
  expectRejected((p) => {
    p.documents['execution-gate'].authorizes.push('rewrite-history');
  }, /references unknown effect "rewrite-history"/);
  // an unknown capability
  expectRejected((p) => {
    p.actors.zamp.may.push('bypass-review');
  }, /references unknown capability "bypass-review"/);
  // a performer who is not a declared actor
  expectRejected((p) => {
    p.effects.deploy.performedBy = 'jenkins';
  }, /performedBy must be a declared actor/);
  // an allowlist entry for a surface the policy does not govern
  expectRejected((p) => {
    p.allowedAuthorityStatements['README.md'] = ['A gate is a gate.'];
  }, /which is not a governed surface/);
});

test('an unsupported policy version is rejected', () => {
  for (const version of [0, 2, '1', null]) {
    expectRejected((p) => {
      p.version = version;
    }, /is not supported/);
  }
});

test('the review scope authorizing anything is rejected', () => {
  expectRejected((p) => {
    p.documents['review-scope'].authorizes.push('create-or-reuse-one-pull-request');
  }, /review-scope\.authorizes must be empty/);
});

test('merge or a cloud effect recorded under the wrong instrument is rejected', () => {
  expectRejected((p) => {
    p.effects.merge.authorizedBy = 'review-scope';
  }, /must be authorized by MERGE_DECISION/);
  // The exact conflation design round 3 found: a cloud effect claiming the PUBLICATION gate.
  // Each cloud effect is checked, so widening one of them cannot ride on another's rule.
  for (const effect of ['deploy', 'prepare-change-sets', 'execute-change-sets', 'abandon-change-sets', 'delete-review-in-progress-stack-record']) {
    expectRejected((p) => {
      p.effects[effect].authorizedBy = 'execution-gate';
    }, new RegExp(`${effect}[\\s\\S]*(cloud instrument|must be exactly)`));
  }
  // ROUND 6: an effect may not name a document that does not authorize it. This is the exact
  // dangling reverse reference the validator accepted — the stack-record effect pointed at the
  // cloud instrument, which listed it nowhere and gave it no mode, so it read as authorized and
  // could not be authorized by any value.
  expectRejected((p) => {
    p.effects['delete-review-in-progress-stack-record'].authorizedBy = 'cloud-authorization';
  }, /does not authorize delete-review-in-progress-stack-record|must be exactly "stack-record-authorization"/);
  expectRejected((p) => {
    p.effects['invoke-paid-model-audit'].authorizedBy = 'review-scope';
  }, /does not authorize invoke-paid-model-audit|must be exactly "spend-authorization"/);
  // And the out-of-band cleanup instrument cannot be widened to cover what a lane performs.
  expectRejected((p) => {
    p.documents['stack-record-authorization'].authorizes.push('execute-change-sets');
  }, /must be exactly|authorizedBy/);
  // And the spend instrument cannot be swapped for the cloud one.
  expectRejected((p) => {
    p.documents['spend-authorization'].authorizes = ['execute-change-sets'];
  }, /authorizes/);
  // ROUND 5: a mode may not silently acquire another mode's effect — the exact widening that
  // would let a plan_only authorization execute or abandon. Two independent rules can catch it
  // (the structural partition, or the pinned literal), and either refusal is a refusal.
  // These are refused by the PARTITION LAW in src/lib/authority-policy.js — not by a literal
  // comparison. The reviewed VALUE is pinned separately, against the real file, in
  // "the authority policy states the invariants as data, not prose".
  const modeRejection = /exactly one mode|does not cover|unknown mode|must be an object/;
  expectRejected((p) => {
    p.documents['cloud-authorization'].modes.plan_only.push('execute-change-sets');
  }, modeRejection);
  expectRejected((p) => {
    p.documents['cloud-authorization'].modes.abandon.push('deploy');
  }, modeRejection);
  // A mode that drops effects leaves them authorized by nothing — also rejected.
  expectRejected((p) => {
    p.documents['cloud-authorization'].modes = { plan_only: ['prepare-change-sets'] };
  }, modeRejection);
  // A mode name outside the closed vocabulary cannot be introduced by the policy file.
  expectRejected((p) => {
    p.documents['cloud-authorization'].modes = { anything_goes: ['deploy', 'prepare-change-sets', 'execute-change-sets', 'abandon-change-sets'] };
  }, modeRejection);
  // And a mode cannot name an effect the instrument does not authorize at all.
  expectRejected((p) => {
    p.documents['cloud-authorization'].modes.abandon = ['delete-review-in-progress-stack-record'];
  }, /does not authorize/);
  // ROUND 6: the lane-readable instrument cannot acquire a cleanup mode either — that is the
  // fold-in this round rejected, and `stack-record-cleanup` is no longer in the mode vocabulary.
  expectRejected((p) => {
    p.documents['cloud-authorization'].modes['stack-record-cleanup'] = ['delete-review-in-progress-stack-record'];
  }, /unknown mode/);
  // The map is not merely present: a mode whose value is not a list of effect names is refused.
  expectRejected((p) => {
    p.documents['cloud-authorization'].modes = 'plan_only';
  }, /must be an object/);
  expectRejected((p) => {
    p.documents['cloud-authorization'].modes = { plan_only: 'prepare-change-sets', deploy: ['deploy', 'execute-change-sets'], abandon: ['abandon-change-sets'] };
  }, /modes\.plan_only/);
});

test('ROUND 6: the instrument/effect relation is a law over both matrices, proven directly', () => {
  // The pinned literals in src/lib/authority-policy.js are correct, so no mutation of the DATA can
  // reach this law first — a pin always speaks before it. That is precisely why the law takes its
  // matrices as arguments: called with a deliberately broken pair, it is provable, and the module
  // calls it on its own literals at import so a self-contradicting pin cannot load.
  const ok = () =>
    assertAuthorityAgreement(
      { 'do-thing': { authorizedBy: 'cloud-authorization' } },
      { 'cloud-authorization': { authorizes: ['do-thing'], modes: { only: ['do-thing'] } } },
      'T',
    );
  assert.doesNotThrow(ok);

  // THE ROUND 6 DEFECT, exactly: the effect names an instrument that does not list it.
  assert.throws(
    () =>
      assertAuthorityAgreement(
        { 'do-thing': { authorizedBy: 'cloud-authorization' } },
        { 'cloud-authorization': { authorizes: [], modes: {} } },
        'T',
      ),
    /does not authorize do-thing/,
  );
  // The other half: an instrument that lists the effect but whose MODES place it in none of them —
  // authorized by the document and by no value the document can take.
  assert.throws(
    () =>
      assertAuthorityAgreement(
        { 'do-thing': { authorizedBy: 'cloud-authorization' } },
        { 'cloud-authorization': { authorizes: ['do-thing'], modes: { other: [] } } },
        'T',
      ),
    /modes place it in none of them/,
  );
  // And the forward direction: the document claims an effect that names someone else.
  assert.throws(
    () =>
      assertAuthorityAgreement(
        { 'do-thing': { authorizedBy: 'spend-authorization' } },
        { 'cloud-authorization': { authorizes: ['do-thing'] }, 'spend-authorization': { authorizes: [] } },
        'T',
      ),
    /must be "cloud-authorization" because that document authorizes it|does not authorize do-thing/,
  );
  // A document claiming an effect that does not exist at all.
  assert.throws(
    () => assertAuthorityAgreement({}, { 'cloud-authorization': { authorizes: ['ghost'] } }, 'T'),
    /unknown effect "ghost"/,
  );
  // The real matrices satisfy it — the same call the module makes at import.
  assert.doesNotThrow(() => assertAuthorityAgreement(POLICY.effects, POLICY.documents, 'live'));
});

test('ROUND 7: no procedure may exist over a residual risk nobody accepted', () => {
  // Acceptance is Zamp's decision. A document may not declare an executable procedure while the
  // residual it names is unaccepted — that is the one combination that would turn "we wrote the
  // risk down" into "we proceeded anyway".
  expectRejected((p) => {
    p.documents['stack-record-authorization'].executableProcedure = true;
  }, /unaccepted residual risk/);
  // The risk must actually be stated; whitespace is not a statement.
  expectRejected((p) => {
    p.documents['stack-record-authorization'].residualRisk = '   ';
  }, /must state the risk/);
  // ROUND 8: acceptance is a RECORD, not a boolean — a flag could be flipped together with
  // executableProcedure in one edit, and nothing in the data said what an acceptance contains.
  // Each defect of the record is refused by name, BEFORE the pinned-literal comparison.
  // Rounds 9-10 fixture: shape-complete, digested under the §6b framings, scoped by digest to
  // one out-of-band cleanup authorization. Dates are far-future so the CLOCK law (evaluated
  // against real time by default) does not rot these tests; the clock law itself is proven below
  // with an injected `now`. No ARN appears here: round 10 removed the only field that carried
  // one, because a live ARN never enters the tracked policy.
  const RISK_SHA = framedTextDigest(
    'policy.documents.stack-record-authorization.residualRisk',
    POLICY.documents['stack-record-authorization'].residualRisk,
  );
  // ROUND 11: the positive fixtures are REAL — actual statement bytes and an actual nine-key
  // cleanup value, digested through the one shared implementation, never a repeated hex.
  const STATEMENT_PATH = '.agent-handoff/decisions/risk-70-stack-record-cleanup.md';
  const STATEMENT_LOCATOR = { path: STATEMENT_PATH, introducedIn: 'f'.repeat(40) };
  const STATEMENT_TEXT = 'I, Zamp, accept the TOCTOU residual for stack record X under decision cleanup-70-example-0001.\n';
  const STATEMENT_SHA = zampStatementDigest(STATEMENT_LOCATOR, STATEMENT_TEXT);
  const CLEANUP_VALUE = {
    issue: 70,
    decisionId: 'cleanup-70-example-0001',
    environment: 'dev',
    account: '111122223333',
    region: 'us-east-1',
    stackName: 'CbaStudyCoach-dev-Identity',
    stackId: ['arn:aws:cloudformation:us-east-1', '111122223333', 'stack/CbaStudyCoach-dev-Identity/12345678-1234-1234-1234-123456789012'].join(':'),
    observedStatus: 'REVIEW_IN_PROGRESS',
    observedAt: '2026-08-07T10:00:00Z',
  };
  const CLEANUP_SHA = cleanupAuthorizationDigest(CLEANUP_VALUE);
  const record = () => ({
    acceptedBy: 'zamp',
    decisionId: 'risk-70-stack-record-cleanup',
    finding: 'TOCTOU between the final re-observation and DeleteStack',
    justification: 'example under test',
    compensatingControls: ['re-observation within the 15-minute window immediately before acting'],
    acceptedAt: '2026-08-07T12:00:00Z',
    reviewBy: '2033-11-05T12:00:00Z',
    expiresAt: '2035-02-03T12:00:00Z',
    boundToEffect: 'delete-review-in-progress-stack-record',
    residualRiskSha256: RISK_SHA,
    coversCleanupAuthorizationSha256: CLEANUP_SHA,
    coversCleanupDecisionId: 'cleanup-70-example-0001',
    zampStatement: {
      source: 'zamp-verbatim-message',
      locator: { ...STATEMENT_LOCATOR },
      sentAt: '2026-08-07T11:00:00Z',
      encoding: 'utf-8',
      bytes: Buffer.byteLength(STATEMENT_TEXT, 'utf8'),
      sha256: STATEMENT_SHA,
    },
  });
  expectRejected((p) => {
    p.documents['stack-record-authorization'].riskAcceptance = true;
  }, /must be null or a closed acceptance record/);
  expectRejected((p) => {
    const r = record(); delete r.expiresAt;
    p.documents['stack-record-authorization'].riskAcceptance = r;
  }, /riskAcceptance/);
  // Only Zamp holds accept-risk; an acceptance signed by the executor is the self-approval this
  // whole protocol exists to prevent.
  expectRejected((p) => {
    p.documents['stack-record-authorization'].riskAcceptance = { ...record(), acceptedBy: 'opus' };
  }, /accept-risk is Zamp's capability alone/);
  expectRejected((p) => {
    p.documents['stack-record-authorization'].riskAcceptance = { ...record(), expiresAt: '2026-08-07T11:00:00Z' };
  }, /ordered acceptedAt < reviewBy <= expiresAt/);
  expectRejected((p) => {
    p.documents['stack-record-authorization'].riskAcceptance = { ...record(), compensatingControls: [] };
  }, /compensatingControls/);
  expectRejected((p) => {
    p.documents['stack-record-authorization'].riskAcceptance = { ...record(), boundToEffect: 'execute-change-sets' };
  }, /must be an effect this document authorizes/);
  // A calendar-invalid instant is a DIFFERENT date than the human wrote — same rule as the lane.
  expectRejected((p) => {
    p.documents['stack-record-authorization'].riskAcceptance = { ...record(), acceptedAt: '2026-02-30T12:00:00Z' };
  }, /strict RFC3339 UTC instant/);
  // ROUNDS 9-10: an acceptance of some OTHER finding accepts nothing here — the record carries
  // the §6b TEXT-FRAMED digest of THIS instrument's residualRisk, recomputed by the validator.
  expectRejected((p) => {
    p.documents['stack-record-authorization'].riskAcceptance = { ...record(), residualRiskSha256: 'b'.repeat(64) };
  }, /does not match the §6b text-framed digest/);
  expectRejected((p) => {
    const r = record();
    p.documents['stack-record-authorization'].residualRisk = 'a different finding entirely';
    p.documents['stack-record-authorization'].riskAcceptance = r;
  }, /does not match the §6b text-framed digest|must be exactly/);
  // ROUND 10 adversarials on the framing itself: the raw-text digest (the round-9 defect), a
  // different subject, a KIND swap and a stray newline each produce a DIFFERENT digest.
  {
    const text = POLICY.documents['stack-record-authorization'].residualRisk;
    const subject = 'policy.documents.stack-record-authorization.residualRisk';
    const raw = createHash('sha256').update(text, 'utf8').digest('hex');
    const wrongSubject = framedTextDigest('policy.documents.spend-authorization.residualRisk', text);
    const kindSwap = createHash('sha256').update(JSON.stringify({
      digestKind: 'bundle', version: 1,
      records: [{ subject, encoding: 'utf-8', bytes: Buffer.byteLength(text, 'utf8'), text }],
    }), 'utf8').digest('hex');
    const newline = framedTextDigest(subject, `${text}\n`);
    for (const bad of [raw, wrongSubject, kindSwap, newline]) {
      assert.notEqual(bad, RISK_SHA);
      expectRejected((p) => {
        p.documents['stack-record-authorization'].riskAcceptance = { ...record(), residualRiskSha256: bad };
      }, /does not match the §6b text-framed digest/);
    }
  }
  // ROUND 10: the stack is bound by DIGEST of the out-of-band cleanup authorization — never by
  // an ARN in the tracked policy — and the digest must at least be one.
  expectRejected((p) => {
    // The probe ARN is assembled at runtime so this file itself stays clean under the scan below.
    p.documents['stack-record-authorization'].riskAcceptance = { ...record(), coversCleanupAuthorizationSha256: ['arn:aws:cloudformation:us-east-1', '111122223333', 'stack/x/1'].join(':') };
  }, /never by copying its ARN/);
  expectRejected((p) => {
    p.documents['stack-record-authorization'].riskAcceptance = { ...record(), coversCleanupDecisionId: 'risk-70-stack-record-cleanup' };
  }, /cannot name the acceptance itself/);
  // ROUNDS 9-10: the declared owner is not the decision — the statement POINTER is closed:
  // source, normalization, canonical bytes, §6b bundle digest.
  expectRejected((p) => {
    p.documents['stack-record-authorization'].riskAcceptance = { ...record(), zampStatement: 'a'.repeat(64) };
  }, /proves nothing/);
  expectRejected((p) => {
    p.documents['stack-record-authorization'].riskAcceptance = { ...record(), zampStatement: { ...record().zampStatement, source: 'meeting-notes' } };
  }, /not a paraphrase/);
  expectRejected((p) => {
    p.documents['stack-record-authorization'].riskAcceptance = { ...record(), zampStatement: { ...record().zampStatement, encoding: 'utf-16' } };
  }, /without a fixed normalization/);
  expectRejected((p) => {
    p.documents['stack-record-authorization'].riskAcceptance = { ...record(), zampStatement: { ...record().zampStatement, bytes: 0 } };
  }, /positive integer/);
  // ROUND 11: a source CLASS plus a timestamp finds nothing univocally — the locator names the
  // decision file and the introducing commit, and both have closed shapes.
  expectRejected((p) => {
    const stmt = { ...record().zampStatement };
    delete stmt.locator;
    p.documents['stack-record-authorization'].riskAcceptance = { ...record(), zampStatement: stmt };
  }, /zampStatement/);
  expectRejected((p) => {
    p.documents['stack-record-authorization'].riskAcceptance = { ...record(), zampStatement: { ...record().zampStatement, locator: { path: '/tmp/anywhere.md', introducedIn: 'f'.repeat(40) } } };
  }, /decision file under \.agent-handoff\/decisions\//);
  expectRejected((p) => {
    p.documents['stack-record-authorization'].riskAcceptance = { ...record(), zampStatement: { ...record().zampStatement, locator: { path: STATEMENT_PATH, introducedIn: 'main' } } };
  }, /full 40-character SHA/);
  // ROUND 11: the envelopes are canonical — same bytes under a different producer, record name,
  // media type, or with a stray newline, and the same VALUE with one key changed, all digest
  // differently. Two reviewers can no longer frame the same content two compatible ways.
  {
    assert.equal(ZAMP_STATEMENT_MEDIA_TYPE, 'text/markdown');
    assert.deepEqual(CLEANUP_VALUE_KEY_ORDER, ['issue', 'decisionId', 'environment', 'account', 'region', 'stackName', 'stackId', 'observedStatus', 'observedAt']);
    const statementName = `${STATEMENT_PATH}@${STATEMENT_LOCATOR.introducedIn}`;
    const variants = [
      framedBundleDigest({ producer: 'opus', name: statementName, mediaType: 'text/markdown', content: STATEMENT_TEXT }),
      framedBundleDigest({ producer: 'zamp', name: 'some-other-name.md', mediaType: 'text/markdown', content: STATEMENT_TEXT }),
      framedBundleDigest({ producer: 'zamp', name: statementName, mediaType: 'text/plain', content: STATEMENT_TEXT }),
      zampStatementDigest(STATEMENT_LOCATOR, `${STATEMENT_TEXT}\n`),
      zampStatementDigest({ path: '.agent-handoff/decisions/other-decision.md', introducedIn: STATEMENT_LOCATOR.introducedIn }, STATEMENT_TEXT),
      // ROUND 12: the same path at a DIFFERENT introducing commit is a different statement — the
      // exact pair that round 11's envelope could not tell apart.
      zampStatementDigest({ path: STATEMENT_PATH, introducedIn: 'e'.repeat(40) }, STATEMENT_TEXT),
    ];
    for (const v of variants) assert.notEqual(v, STATEMENT_SHA);
    assert.equal(new Set(variants).size, variants.length, 'each perturbation is its own digest');
    // determinism: the same inputs reproduce the same digest
    assert.equal(zampStatementDigest(STATEMENT_LOCATOR, STATEMENT_TEXT), STATEMENT_SHA);
    assert.equal(cleanupAuthorizationDigest({ ...CLEANUP_VALUE }), CLEANUP_SHA);
    // one authorization key changed → a different authorization
    assert.notEqual(cleanupAuthorizationDigest({ ...CLEANUP_VALUE, observedAt: '2026-08-07T10:00:01Z' }), CLEANUP_SHA);
    assert.notEqual(cleanupAuthorizationDigest({ ...CLEANUP_VALUE, decisionId: 'cleanup-70-example-0002' }), CLEANUP_SHA);
    // key order is the envelope's, not the caller's: a permuted object digests identically
    const permuted = Object.fromEntries(Object.entries(CLEANUP_VALUE).reverse());
    assert.equal(cleanupAuthorizationDigest(permuted), CLEANUP_SHA);
    // ROUND 12: the shape is a PRECONDITION, not a projection. Codex's reproductions, inverted:
    // an extra key no longer digests identically — it REFUSES; a missing key no longer yields a
    // plausible digest — it refuses; and so do undefined values, wrong types and non-objects.
    assert.throws(() => cleanupAuthorizationDigest({ ...CLEANUP_VALUE, effect: 'delete-something-else' }), /extra: \[effect\]/);
    assert.throws(() => {
      const { stackId, ...withoutStackId } = CLEANUP_VALUE;
      return cleanupAuthorizationDigest(withoutStackId);
    }, /missing: \[stackId\]/);
    assert.throws(() => cleanupAuthorizationDigest({ ...CLEANUP_VALUE, stackName: undefined }), /would vanish in serialization/);
    assert.throws(() => cleanupAuthorizationDigest({ ...CLEANUP_VALUE, issue: '70' }), /must be the integer 70/);
    assert.throws(() => cleanupAuthorizationDigest({ ...CLEANUP_VALUE, region: 42 }), /must be a non-empty string/);
    for (const notAnObject of [null, [], 'value', 42]) {
      assert.throws(() => cleanupAuthorizationDigest(notAnObject), /plain object/);
    }
  }
  // ROUND 12: a SHA that merely looks like a SHA proves nothing — the locator verification runs
  // the four history checks, here against a SCRIPTED git covering every named refusal.
  {
    const REVIEWED_HEAD_SHA = 'd'.repeat(40);
    const scriptedGit = (overrides = {}) => (cmd, args) => {
      assert.equal(cmd, 'git');
      // cat-file is called for the reviewed head AND the locator commit; tell them apart.
      const step = args[0] === 'cat-file' ? (args[2].startsWith(REVIEWED_HEAD_SHA) ? 'headExists' : 'exists')
        : args[0] === 'merge-base' ? 'ancestor'
          : args[0] === 'diff-tree' ? 'added'
            : args[0] === 'show' ? 'content' : assert.fail(`unexpected git call: ${args.join(' ')}`);
      if (step in overrides) return overrides[step]();
      if (step === 'added') return `A\t${STATEMENT_PATH}\n`;
      if (step === 'content') return STATEMENT_TEXT;
      return '';
    };
    const base = { locator: { ...STATEMENT_LOCATOR }, bytes: Buffer.byteLength(STATEMENT_TEXT, 'utf8'), sha256: STATEMENT_SHA, reviewedHead: REVIEWED_HEAD_SHA };
    assert.deepEqual(verifyStatementLocator({ ...base, git: scriptedGit() }), { ok: true });
    // ROUND 13: the reviewed head obeys the identity rule — a moving target is not a proof
    // anchor. Each bad shape refuses by name, BEFORE any git call touches ancestry.
    for (const movingTarget of ['HEAD', 'main', 'd'.repeat(39), 'D'.repeat(40), `${'d'.repeat(40)} `, 42, null, undefined]) {
      assert.equal(
        verifyStatementLocator({ ...base, reviewedHead: movingTarget, git: scriptedGit() }).reason,
        'REVIEWED_HEAD_NOT_A_FULL_SHA',
        String(movingTarget),
      );
    }
    // A well-formed SHA that names no commit refuses too — shape is not existence.
    assert.equal(
      verifyStatementLocator({ ...base, git: scriptedGit({ headExists: () => { throw new Error('missing'); } }) }).reason,
      'REVIEWED_HEAD_MISSING',
    );
    assert.equal(verifyStatementLocator({ ...base, git: scriptedGit({ exists: () => { throw new Error('missing'); } }) }).reason, 'LOCATOR_COMMIT_MISSING');
    assert.equal(verifyStatementLocator({ ...base, git: scriptedGit({ ancestor: () => { throw new Error('not ancestor'); } }) }).reason, 'LOCATOR_COMMIT_NOT_ANCESTOR');
    assert.equal(verifyStatementLocator({ ...base, git: scriptedGit({ added: () => `M\t${STATEMENT_PATH}\n` }) }).reason, 'LOCATOR_FILE_NOT_ADDED_THERE');
    assert.equal(verifyStatementLocator({ ...base, git: scriptedGit({ added: () => 'A\tsome/other/file.md\n' }) }).reason, 'LOCATOR_FILE_NOT_ADDED_THERE');
    assert.equal(verifyStatementLocator({ ...base, git: scriptedGit({ content: () => 'different historical content\n' }) }).reason, 'LOCATOR_BYTES_MISMATCH');
    const sameLength = STATEMENT_TEXT.replace('accept', 'reject'); // same byte count, different bytes
    assert.equal(Buffer.byteLength(sameLength, 'utf8'), Buffer.byteLength(STATEMENT_TEXT, 'utf8'));
    assert.equal(verifyStatementLocator({ ...base, git: scriptedGit({ content: () => sameLength }) }).reason, 'LOCATOR_CONTENT_MISMATCH');
    // a locator whose SHA differs verifies only against ITS OWN digest, never the recorded one
    assert.equal(verifyStatementLocator({ ...base, locator: { path: STATEMENT_PATH, introducedIn: 'e'.repeat(40) }, git: scriptedGit() }).reason, 'LOCATOR_CONTENT_MISMATCH');
  }
  // ROUND 9: the validator evaluates the CLOCK. An expired acceptance in the tree fails closed…
  {
    const expired = clonePolicy();
    expired.documents['stack-record-authorization'].riskAcceptance = {
      ...record(), acceptedAt: '2026-01-01T00:00:00Z', reviewBy: '2026-02-01T00:00:00Z', expiresAt: '2026-03-01T00:00:00Z',
    };
    assert.throws(
      () => validateAuthorityPolicy(expired, { now: Date.parse('2026-06-01T00:00:00Z') }),
      /expired acceptance authorizes nothing/,
    );
    // …and one dated in the future was not decided yet.
    const future = clonePolicy();
    future.documents['stack-record-authorization'].riskAcceptance = record();
    assert.throws(
      () => validateAuthorityPolicy(future, { now: Date.parse('2026-01-01T00:00:00Z') }),
      /dated in the future/,
    );
  }
  // Even a COMPLETE, well-shaped, unexpired record cannot slip in silently: the pinned literal is
  // null, so accepting the risk is a reviewed change to the policy itself, never a runtime state.
  expectRejected((p) => {
    p.documents['stack-record-authorization'].riskAcceptance = record();
  }, /must be exactly/);
  // An observation may not be allowed to age past the reviewed bound.
  for (const bad of [60, 16, 0, -1, 1.5, '15']) {
    expectRejected((p) => {
      p.documents['stack-record-authorization'].maxObservationAgeMinutes = bad;
    }, /at most 15|authorizes nothing/);
  }
  // And, while no procedure exists, no runbook may carry the command that performs the effect.
  for (const rel of fs.readdirSync(path.join(ROOT, 'docs/runbooks')).filter((f) => f.endsWith('.md'))) {
    const text = read(`docs/runbooks/${rel}`);
    assert.equal(
      /aws\s+cloudformation\s+delete-stack/i.test(text),
      false,
      `${rel} carries a delete-stack command while stack-record-authorization.executableProcedure is false`,
    );
  }
});

/**
 * Rebuild the COMPLETE commands inside fenced blocks, joining backslash continuations — round
 * 12: a per-line scan let an override live on the next line of the same command.
 */
function reconstructFencedCommands(text) {
  const commands = [];
  let inFence = false;
  let buffer = null;
  for (const line of text.split('\n')) {
    if (/^\s*```/.test(line)) {
      // ROUND 15: a fence boundary reached with a continuation open used to RESET the buffer —
      // the joined command vanished from the reconstruction while bash would execute it. A
      // dangling continuation is refused, never dropped.
      if (buffer !== null) throw new Error('dangling continuation at a fence boundary — a trailing backslash with nothing sanctioned to join is refused');
      inFence = !inFence;
      continue;
    }
    if (!inFence) continue;
    const trimmed = line.trim();
    // ROUND 15: the blank/comment skip applies ONLY between commands. While a continuation is
    // open, shell semantics join WHATEVER comes next — a comment line is payload that lands
    // inside the very command bash would run, and a blank line terminates it; skipping either
    // made the injected command invisible while executable.
    if (buffer === null && (trimmed === '' || trimmed.startsWith('#'))) continue;
    const continued = /\\$/.test(trimmed);
    const payload = trimmed.replace(/\\$/, '').trim();
    if (buffer !== null) {
      buffer = `${buffer} ${payload}`.trim();
      if (!continued) {
        commands.push(buffer);
        buffer = null;
      }
    } else if (continued) {
      buffer = payload;
    } else {
      commands.push(payload);
    }
  }
  if (inFence) throw new Error('unbalanced fence — a block that never closes is refused');
  if (buffer !== null) throw new Error('dangling continuation at EOF');
  return commands;
}

/**
 * The reviewed command inventory — round 14. Rounds 11-13 tried to ANALYZE commands (flags, then
 * anchored templates keyed on the word `gh`) and each round found the analysis fail-open: the
 * word `gh` can be spelled without the sequence `gh` (`g'h'`, `g\\h`, `$(printf '\\147\\150')`,
 * `${G}${H}`), and template alternations accepted cartesian combinations no runbook contains.
 * Identity needs no analysis: EVERY reconstructed fenced command line of EVERY runbook — gh or
 * not — must EQUAL its reviewed literal, in order, and a runbook absent from this inventory is
 * itself a deviation. Changing any fenced command anywhere is a red build until the same
 * reviewed commit updates this inventory.
 */
const REVIEWED_RUNBOOK_COMMANDS = {
  "docs/runbooks/README.md": [
    "---",
    "id: <kebab-case, unique, matches the filename without .md>",
    "kind: <runbook | index>",
    "version: <semver — bump on every change>",
    "owner: <the actor that maintains this document>",
    "humanApprover: Zamp",
    "specs: [<SPEC-IDs this document operationalizes, per spec/spec-anchored-development.md>]",
    "inputs: [<what the operator must have before starting — names, never values>]",
    "outputs: [<what a completed run produces — evidence, records>]",
    "gateRequired: <true|false — whether any step depends on a Zamp authorization, of either kind>",
    "cloudMutation: <true|false — whether any step can change cloud state, change-set creation included>",
    "---",
    "CORRELATION_ID=\"cba-70-$(openssl rand -hex 16)\"   # matches ^cba-70-[0-9a-f]{32}$",
    "printf '%s\\n' \"$CORRELATION_ID\"                   # record it BEFORE dispatching",
    "RUN_ID=$(node bin/resolve-run.mjs --title \"cba-release <mode> ${CORRELATION_ID}\")",
  ],
  "docs/runbooks/aws-dev-release-abandon.md": [
    "gh api -X PATCH repos/marciozampiron/backstage-cba-prep/environments/dev/variables/CBA_CLOUD_GATE -f name=CBA_CLOUD_GATE -f value='<the abandon JSON for this decision>'",
    "gh workflow run release-pilot.yml --repo marciozampiron/backstage-cba-prep --ref main -f release_sha=<full 40-character release SHA> -f mode=abandon -f correlation_id=<caller-generated id for this decision>",
    "RUN_ID=$(node bin/resolve-run.mjs --title \"cba-release abandon ${CORRELATION_ID}\")",
    "gh run download \"$RUN_ID\" --repo marciozampiron/backstage-cba-prep --name abandon --dir <evidence-dir>/abandon-\"$RUN_ID\"",
    "sha256sum <evidence-dir>/abandon-\"$RUN_ID\"/abandon.json",
  ],
  "docs/runbooks/aws-dev-release-bind.md": [
    "gh workflow run release-pilot.yml --repo marciozampiron/backstage-cba-prep --ref main -f release_sha=<full 40-character release SHA> -f mode=bind_only -f correlation_id=<caller-generated id for this request>",
    "RUN_ID=$(node bin/resolve-run.mjs --title \"cba-release bind_only ${CORRELATION_ID}\")",
    "gh run download \"$RUN_ID\" --repo marciozampiron/backstage-cba-prep --name binding --dir <evidence-dir>/bind-\"$RUN_ID\"",
    "sha256sum <evidence-dir>/bind-\"$RUN_ID\"/binding.json",
  ],
  "docs/runbooks/aws-dev-release-deploy.md": [
    "gh api -X PATCH repos/marciozampiron/backstage-cba-prep/environments/dev/variables/CBA_CLOUD_GATE -f name=CBA_CLOUD_GATE -f value='<the deploy JSON for this decision, planDigest included>'",
    "gh workflow run release-pilot.yml --repo marciozampiron/backstage-cba-prep --ref main -f release_sha=<full 40-character release SHA> -f mode=dev_only -f correlation_id=<caller-generated id for this decision>",
    "RUN_ID=$(node bin/resolve-run.mjs --title \"cba-release dev_only ${CORRELATION_ID}\")",
    "gh run download \"$RUN_ID\" --repo marciozampiron/backstage-cba-prep --name deploy --dir <evidence-dir>/deploy-\"$RUN_ID\"",
    "sha256sum <evidence-dir>/deploy-\"$RUN_ID\"/deploy.json",
  ],
  "docs/runbooks/aws-dev-release-plan.md": [
    "gh api -X PATCH repos/marciozampiron/backstage-cba-prep/environments/dev/variables/CBA_CLOUD_GATE -f name=CBA_CLOUD_GATE -f value='<the plan_only JSON for this decision>'",
    "gh workflow run release-pilot.yml --repo marciozampiron/backstage-cba-prep --ref main -f release_sha=<full 40-character release SHA> -f mode=dev_only -f correlation_id=<caller-generated id for this decision>",
    "RUN_ID=$(node bin/resolve-run.mjs --title \"cba-release dev_only ${CORRELATION_ID}\")",
    "gh run download \"$RUN_ID\" --repo marciozampiron/backstage-cba-prep --name plan --dir <evidence-dir>/plan-\"$RUN_ID\"",
    "sha256sum <evidence-dir>/plan-\"$RUN_ID\"/plan.json",
  ],
  "docs/runbooks/aws-dev-release-recovery.md": [
    "aws sts get-caller-identity --profile <reviewed-read-only-profile> --region us-east-1 --no-cli-pager",
    "aws cloudformation describe-stacks --stack-name <cba-study-coach-dev-…> --profile <reviewed-read-only-profile> --region us-east-1 --no-cli-pager --query 'Stacks[0].StackStatus'",
    "aws cloudformation describe-stack-events --stack-name <cba-study-coach-dev-…> --profile <reviewed-read-only-profile> --region us-east-1 --no-cli-pager --max-items 20",
  ],
  "docs/runbooks/aws-dev-release.md": [
  ],
  "docs/runbooks/spec-conformance-audit.md": [
  ],
};

/**
 * The three sanctioned OPERATION CLASSES a gh command in the inventory may belong to — the
 * round-15 meta-rule. Anchored both ends; method, endpoint, workflow file, ref and artifact
 * shape are inside the pattern, so a DELETE under the canonical prefix and an untouched
 * subcommand (`gh issue close`) both refuse.
 */
const SANCTIONED_GH_OPERATIONS = [
  /^gh api -X PATCH repos\/marciozampiron\/backstage-cba-prep\/environments\/dev\/variables\/CBA_CLOUD_GATE -f name=CBA_CLOUD_GATE -f value='<the (plan_only|deploy|abandon) JSON for this decision(, planDigest included)?>'$/,
  /^gh workflow run release-pilot\.yml --repo marciozampiron\/backstage-cba-prep --ref main -f release_sha=<full 40-character release SHA> -f mode=(bind_only|dev_only|abandon) -f correlation_id=<caller-generated id for this (decision|request)>$/,
  /^gh run download "\$RUN_ID" --repo marciozampiron\/backstage-cba-prep --name (binding|plan|deploy|abandon) --dir <evidence-dir>\/(bind|plan|deploy|abandon)-"\$RUN_ID"$/,
];

function inventoriedGhOffenses(cmd) {
  if (!/^gh\b/.test(cmd)) return [];
  if (SANCTIONED_GH_OPERATIONS.some((re) => re.test(cmd))) return [];
  return [`inventoried gh command outside the sanctioned operation classes: ${cmd}`];
}

function runbookCommandDeviations(rel, commands) {
  const expected = REVIEWED_RUNBOOK_COMMANDS[rel];
  if (expected === undefined) return [`${rel} is not in the reviewed command inventory`];
  const out = [];
  const max = Math.max(expected.length, commands.length);
  for (let i = 0; i < max; i += 1) {
    if (commands[i] !== expected[i]) {
      out.push(`${rel}[${i}] expected ${JSON.stringify(expected[i])} but found ${JSON.stringify(commands[i])}`);
    }
  }
  return out;
}

test('ROUND 11-14: every fenced command in every runbook IS its reviewed literal', () => {
  const runbooks = fs.readdirSync(path.join(ROOT, 'docs/runbooks')).filter((f) => f.endsWith('.md'));
  const offenses = [];
  for (const rel of runbooks) {
    try {
      offenses.push(...runbookCommandDeviations(`docs/runbooks/${rel}`, reconstructFencedCommands(read(`docs/runbooks/${rel}`))));
    } catch (err) {
      offenses.push(`docs/runbooks/${rel}: ${err.message}`);
    }
  }
  // Fail-closed in both directions: an inventory entry whose file is gone is stale review.
  for (const rel of Object.keys(REVIEWED_RUNBOOK_COMMANDS)) {
    assert.ok(fs.existsSync(path.join(ROOT, rel)), `stale inventory entry: ${rel}`);
  }
  assert.deepEqual(offenses, [], offenses.join('\n'));
  // And the INVENTORY itself is bounded: every inventoried gh command must belong to one of the
  // three sanctioned OPERATION CLASSES, so an edit that rewrote a runbook and this inventory
  // together still cannot introduce repository administration (round 15: prefix checks let
  // `gh api -X DELETE repos/<canon>/actions/secrets/…` and `gh issue close` through). Honest
  // scope, stated plainly: this bounds gh-spelled operations by CLASS; exact cross-field pairing
  // and non-gh spellings inside the inventory are what independent review of any inventory diff
  // exists for — the inventory is a reviewed artifact, and this rule is its belt, not its judge.
  for (const cmds of Object.values(REVIEWED_RUNBOOK_COMMANDS)) {
    for (const cmd of cmds) {
      assert.deepEqual(inventoriedGhOffenses(cmd), [], cmd);
    }
  }
});

test('ROUND 14: identity, not analysis — every demonstrated bypass class deviates', () => {
  const planRel = 'docs/runbooks/aws-dev-release-plan.md';
  const bindRel = 'docs/runbooks/aws-dev-release-bind.md';
  const planText = read(planRel);
  const bindText = read(bindRel);
  const injectIntoFirstFence = (text, line) => text.replace(/```[a-z]*\n/, (m) => `${m}${line}\n`);
  const deviates = (rel, text) => {
    try {
      return runbookCommandDeviations(rel, reconstructFencedCommands(text));
    } catch (err) {
      // A refusal of the document IS a deviation: fail-closed, never fail-quiet (round 15).
      return [err.message];
    }
  };

  // The real files, unmodified, are clean — so every deviation below is caused by the injection.
  assert.deepEqual(deviates(planRel, planText), []);
  assert.deepEqual(deviates(bindRel, bindText), []);

  // ROUND 14: gh spelled without the sequence `gh`. Analysis keyed on the word could never see
  // these; identity does not care how the executable is spelled.
  for (const obfuscated of [
    "g'h' secret set PROD",
    'g\\h secret set PROD',
    "$(printf '\\147\\150') secret set PROD",
    'G=g; H=h; ${G}${H} secret set PROD',
  ]) {
    assert.ok(deviates(planRel, injectIntoFirstFence(planText, obfuscated)).length > 0, obfuscated);
  }

  // ROUND 14: cartesian combinations of the old alternations — each is a line no runbook
  // contains, so each deviates from the literal at its position.
  const swaps = [
    [bindRel, bindText,
      'gh run download "$RUN_ID" --repo marciozampiron/backstage-cba-prep --name binding --dir <evidence-dir>/bind-"$RUN_ID"',
      'gh run download "$RUN_ID" --repo marciozampiron/backstage-cba-prep --name plan --dir <evidence-dir>/deploy-"$RUN_ID"'],
    [planRel, planText,
      "-f value='<the plan_only JSON for this decision>'",
      "-f value='<the deploy JSON for this decision>'"],
    [bindRel, bindText,
      '-f correlation_id=<caller-generated id for this request>',
      '-f correlation_id=<caller-generated id for this decision>'],
  ];
  for (const [rel, text, fromStr, toStr] of swaps) {
    assert.ok(text.includes(fromStr), `swap source must exist: ${fromStr}`);
    assert.ok(deviates(rel, text.replace(fromStr, toStr)).length > 0, toStr);
  }

  // Removal deviates too: a command cannot quietly disappear from a runbook.
  const withoutDownload = bindText.replace(/gh run download[^\n]*\n/, '');
  assert.ok(deviates(bindRel, withoutDownload).length > 0);

  // And an APPENDED command — beyond the last reviewed literal — deviates as well: length is
  // part of identity, not only per-position content. (Round 14's own reversion proof exposed
  // this: a comparator that skips positions past the expected list stayed green until this
  // regression existed.)
  const appendToLastFence = (text, line) => {
    const closer = text.lastIndexOf('```');
    return `${text.slice(0, closer)}${line}\n${text.slice(closer)}`;
  };
  assert.ok(deviates(planRel, appendToLastFence(planText, 'gh secret set PROD')).length > 0);
  assert.ok(deviates(planRel, appendToLastFence(planText, "g'h' secret set PROD")).length > 0);

  // ROUND 15: a dangling continuation cannot vanish. Codex's reproduction — a continuation whose
  // next line is a comment — used to reconstruct IDENTICALLY to the original document while bash
  // would join and execute it. Now the comment is payload (shell semantics), so the joined
  // command deviates; a continuation left open at the fence closer, at EOF, and an unbalanced
  // fence are refused outright, and the refusal is a deviation.
  const contComment = appendToLastFence(planText, "g'h' secret set PROD \\\n# continuation content ignored by scanner");
  assert.ok(deviates(planRel, contComment).length > 0, 'continuation + comment must deviate');
  const contBlank = appendToLastFence(planText, "g'h' secret set PROD \\\n");
  assert.ok(deviates(planRel, contBlank).length > 0, 'continuation + blank line must deviate');
  const contAtClose = appendToLastFence(planText, "g'h' secret set PROD \\");
  assert.ok(deviates(planRel, contAtClose).length > 0, 'continuation at the fence closer must deviate');
  const FENCE = '`'.repeat(3);
  const contAtEof = [planText, `${FENCE}bash`, "g'h' secret set PROD \\"].join('\n');
  assert.ok(deviates(planRel, contAtEof).length > 0, 'continuation at EOF must deviate');
  const unbalanced = [planText, `${FENCE}bash`, 'gh secret set PROD'].join('\n');
  assert.ok(deviates(planRel, unbalanced).length > 0, 'an unbalanced fence must deviate');
  // …and the real document still reconstructs cleanly, so the refusals are attributable.
  assert.deepEqual(deviates(planRel, planText), []);

  // ROUND 15 meta: the inventory's own bound is a closed operation-class list, not prefixes.
  assert.ok(inventoriedGhOffenses(`gh api -X DELETE repos/${CANONICAL_REPO}/actions/secrets/PROD`).length > 0);
  assert.ok(inventoriedGhOffenses('gh issue close 70').length > 0);
  assert.ok(inventoriedGhOffenses('gh secret set PROD').length > 0);
  assert.deepEqual(inventoriedGhOffenses(`gh workflow run release-pilot.yml --repo ${CANONICAL_REPO} --ref main -f release_sha=<full 40-character release SHA> -f mode=dev_only -f correlation_id=<caller-generated id for this decision>`), []);

  // Rounds 12-13 regressions, restated under identity: none of these lines is a reviewed
  // literal, so each deviates wherever it is injected.
  for (const bypass of [
    'gh api -X PATCH "$ENDPOINT" -f name=CBA_CLOUD_GATE',
    `gh api -X DELETE repos/${CANONICAL_REPO}/actions/secrets/PROD`,
    `gh workflow run release-pilot.yml --repo ${CANONICAL_REPO} --repo attacker/fork --ref main`,
    `gh workflow run release-pilot.yml --repo ${CANONICAL_REPO} --repo=attacker/fork --ref main`,
    `gh workflow run release-pilot.yml --repo ${CANONICAL_REPO} --ref main && gh secret set PROD`,
    'env X=1 gh secret set PROD',
    'true; gh secret set PROD',
    'gh run list --workflow release-pilot.yml',
  ]) {
    assert.ok(deviates(planRel, injectIntoFirstFence(planText, bypass)).length > 0, bypass);
  }

  // …and the continuation-line override still deviates as ONE reconstructed command.
  const doc = [
    '```bash',
    `gh workflow run release-pilot.yml --repo ${CANONICAL_REPO} \\`,
    '  --repo attacker/fork --ref main',
    '```',
  ].join('\n');
  const [cmd] = reconstructFencedCommands(doc);
  assert.match(cmd, /--repo attacker\/fork/);
  assert.ok(deviates(planRel, injectIntoFirstFence(planText, `${cmd}`)).length > 0);
});

test('ROUND I4-3: the retired over-claim about the abandon refusal cannot return', () => {
  // I4 claimed the abandon refusal ran "provably before any AWS call"; I4-2 precised it (the STS
  // identity reads precede the gate check by design), and I4-3 found the stale phrase surviving
  // in the canonical handoff beside the corrected one — two contradictory guarantees coexisting.
  // The stale phrasing is refused, finitely, on every surface that states the guarantee.
  const surfaces = [
    '.agent-handoff/done/70-cloudflare-aws-deploy-pipeline.md',
    'spec/spec-anchored-development.md',
    'infra/aws/bin/deploy-release.js',
    'infra/aws/test/deploy-preflight.test.js',
  ];
  const offending = surfaces.filter((rel) => /provably before any AWS call/i.test(read(rel)));
  assert.deepEqual(offending, [], `stale guarantee wording in: ${offending.join(', ')}`);
  // POSITIVE CONTROL: the pattern sees the phrase it guards against.
  assert.ok(/provably before any AWS call/i.test('and provably before any AWS call, until'));
});

test('ROUND 10: no governance surface carries a CloudFormation stack ARN', () => {
  // The acceptance binds its stack by DIGEST of an out-of-band value precisely so that no live
  // ARN — account id included — ever enters the tracked policy or its documents. This scan keeps
  // that true against regression: a stack ARN in any governance surface is a finding, whatever
  // account it names.
  const surfaces = [
    'src/lib/authority-policy.js',
    'spec/authority-policy.json',
    ...fs.readdirSync(path.join(ROOT, 'spec')).filter((f) => f.endsWith('.md')).map((f) => `spec/${f}`),
    ...fs.readdirSync(path.join(ROOT, 'spec/agents')).filter((f) => f.endsWith('.md')).map((f) => `spec/agents/${f}`),
    ...fs.readdirSync(path.join(ROOT, 'docs/runbooks')).filter((f) => f.endsWith('.md')).map((f) => `docs/runbooks/${f}`),
    'test/governance-model.test.js',
  ];
  const offending = surfaces.filter((rel) => /arn:aws[a-z-]*:cloudformation:[a-z0-9-]*:[0-9]{12}:/.test(read(rel)));
  assert.deepEqual(offending, [], `stack ARNs with account ids in governance surfaces: ${offending.join(', ')}`);
  // POSITIVE CONTROL: the scanner sees the shape it guards against (probe assembled at runtime
  // so this file itself stays clean).
  assert.ok(/arn:aws[a-z-]*:cloudformation:[a-z0-9-]*:[0-9]{12}:/.test(['arn:aws:cloudformation:us-east-1', '111122223333', 'stack/x/1'].join(':')));
});

test('a dangling document-to-effect authority is rejected', () => {
  expectRejected((p) => {
    // the document claims the effect, but the effect names a different authorizer
    p.documents['execution-gate'].authorizes.push('merge');
  }, /policy\.effects\.merge\.authorizedBy must be "execution-gate"|policy\.documents\.execution-gate\.authorizes must be exactly/);
});

test('an incomplete governed-surface list is rejected', () => {
  // The required set must always be governed…
  expectRejected((p) => {
    p.governedSurfaces = p.governedSurfaces.filter((s) => s !== '.agents/skills/review-security/SKILL.md');
  }, /governedSurfaces is missing required surface\(s\): \.agents\/skills\/review-security\/SKILL\.md/);
  // …and anything added to it must also be classified canonical and carry an allowlist entry, so a
  // surface cannot be governed in name only.
  expectRejected((p) => {
    p.governedSurfaces.push('docs/README.md');
  }, /canonical-authority.*missing docs\/README\.md/s);
  expectRejected((p) => {
    p.governedSurfaces.push('docs/README.md');
    p.surfaceClassification['canonical-authority'].push('docs/README.md');
  }, /allowedAuthorityStatements keys.*missing docs\/README\.md/s);
  expectRejected((p) => {
    p.governedSurfaces.push('AGENTS.md');
  }, /governedSurfaces contains a duplicate/);
});

test('the governed-surface list covers every cold-start document, template and review skill', () => {
  // Asserted against the code's required set, and the policy is validated against the same set, so a
  // surface cannot be quietly dropped from either side.
  for (const required of [
    'AGENTS.md',
    '.agent-handoff/MESSAGE-PROTOCOL.md',
    '.agent-handoff/README.md',
    '.agent-handoff/COMMANDS.md',
    '.agent-handoff/publish-gates/README.md',
    '.agent-handoff/templates/task.md',
    '.agent-handoff/templates/message.md',
    'spec/security-rules.md',
    'docs/architecture/agent-publication-runbook.md',
    '.claude/skills/publication-prepare/SKILL.md',
    '.claude/skills/security-review/SKILL.md',
    '.agents/skills/publication-review/SKILL.md',
    '.agents/skills/review-security/SKILL.md',
  ]) {
    assert.ok(REQUIRED_SURFACES.includes(required), `${required} must be a governed surface`);
    assert.ok(POLICY.governedSurfaces.includes(required), `${required} must be listed in the policy`);
  }
});

test('a denormalized allowlist entry is rejected', () => {
  expectRejected((p) => {
    p.allowedAuthorityStatements['AGENTS.md'].push('  a gate   with odd spacing ');
  }, /must hold normalized statements/);
  expectRejected((p) => {
    const first = p.allowedAuthorityStatements['AGENTS.md'][0];
    p.allowedAuthorityStatements['AGENTS.md'].push(first);
  }, /lists a duplicate statement/);
});

/* ================= prose adjacent to a table is still collected ================================ */

test('REGRESSION: prose immediately BEFORE a table, with no blank line, is collected', () => {
  const text = ['The review scope authorizes publication.', '| Field | Meaning |', '| --- | --- |'].join('\n');
  assert.deepEqual(authorityStatements(text), ['The review scope authorizes publication.']);
});

test('REGRESSION: prose immediately AFTER a table, with no blank line, is collected', () => {
  const text = ['| Field | Meaning |', '| --- | --- |', 'The execution gate authorizes merge.'].join('\n');
  assert.deepEqual(authorityStatements(text), ['The execution gate authorizes merge.']);
});

test('a table row and its surrounding prose are all collected, in order', () => {
  const text = [
    'The review scope authorizes publication.',
    '| the review scope | authorized to publish |',
    '| --- | --- |',
    'The execution gate authorizes merge.',
  ].join('\n');
  assert.deepEqual(authorityStatements(text), [
    'The review scope authorizes publication.',
    '| the review scope | authorized to publish |',
    'The execution gate authorizes merge.',
  ]);
  // A row that names no governed document is correctly out of scope.
  assert.deepEqual(authorityStatements('| `executor` | authorized to publish |'), []);
});

test('fenced code is not read as an authority statement', () => {
  // Command examples name the gate files constantly; they are illustrations, not claims.
  const text = ['```bash', 'node bin/cli.js agent-publish --gate /tmp/cba-scope-93.json', '```'].join('\n');
  assert.deepEqual(authorityStatements(text), []);
});

/* ================= every operational source has exactly one classification ===================== */
//
// The gap this closes: `CURRENT.md`, the active #93 handoff and the CLI help are mandatory cold-start
// inputs, and they sat outside the authoritative allowlist while looking covered by the advisory
// scanner. A source with no classification is now a failure rather than a default.

test('every discovered operational source is classified, exactly once', () => {
  const classification = POLICY.surfaceClassification ?? {};
  const classOf = new Map();
  for (const [cls, list] of Object.entries(classification)) {
    for (const surface of list ?? []) classOf.set(surface, cls);
  }

  // `operationalSources()` discovers from the tree, so a new skill or handoff appears here the moment
  // it exists — and must then be classified before the suite passes.
  const unclassified = SOURCES.filter((rel) => !classOf.has(rel));
  assert.deepEqual(
    unclassified,
    [],
    'these operational sources have no classification in spec/authority-policy.json.\n' +
      'Classify each as canonical-authority, link-only or historical:\n' +
      unclassified.join('\n'),
  );
});

test('the mandatory cold-start inputs are canonical-authority, not merely advisory', () => {
  const canonical = new Set(POLICY.surfaceClassification?.['canonical-authority'] ?? []);
  for (const required of [
    '.agent-handoff/CURRENT.md',
    '.agent-handoff/done/93-human-publication-script.md',
    'bin/cli.js',
    '.agent-handoff/templates/decision.md',
  ]) {
    assert.ok(canonical.has(required), `${required} must be canonical-authority`);
    assert.ok(REQUIRED_SURFACES.includes(required), `${required} must be in the code's required set`);
    assert.ok(
      Object.hasOwn(POLICY.allowedAuthorityStatements, required),
      `${required} must have an allowlist entry, even if empty`,
    );
  }
});

test('a closed handoff lives in done/, and the guard follows the file rather than pinning it', () => {
  // #93 is CLOSED. Its handoff was kept in `active/` for one commit BECAUSE three sources hard-code
  // its path, which inverts the responsibility: real state must drive the guard, not the reverse.
  // This asserts the direction. `active/` must not hold a closed issue's handoff, and no source may
  // still name the old path — a rename that updates only two of the three leaves the suite green in
  // exactly the way the #75 close did.
  const rel = '.agent-handoff/done/93-human-publication-script.md';
  // Derived, never written out: this file is one of the sources scanned below, so spelling the old
  // path here would make the scan find its own assertion and fail for the wrong reason.
  const superseded = rel.replace('/done/', '/active/');

  assert.ok(fs.existsSync(path.join(ROOT, rel)), `${rel} must exist — a closed handoff belongs in done/`);
  assert.equal(
    fs.existsSync(path.join(ROOT, superseded)),
    false,
    'the #93 handoff must not be in active/: issue #93 is closed',
  );

  // Every source that names it must name the done/ path, and none may keep the active/ one.
  for (const src of ['src/lib/authority-policy.js', 'test/governance-model.test.js', 'spec/authority-policy.json']) {
    const text = read(src);
    assert.ok(text.includes(rel), `${src} must reference ${rel}`);
    assert.equal(text.includes(superseded), false, `${src} still pins the old active/ path`);
  }
  assert.ok(REQUIRED_SURFACES.includes(rel), 'the code-side required set must name the done/ path');
});

/**
 * The two binding deploy conditions #69 registered against #70, checked on SUPPLIED text.
 *
 * It takes text rather than reading the file so the contract can be exercised against a mutation in
 * memory. That is the difference between proving a rule holds and proving it BITES: the previous
 * version of this check read the file itself, so every regression had to be staged on disk, and the
 * one property nobody staged — the ordering — went unasserted. Turning `fail before` into
 * `fail after` passed.
 *
 * Narrow and deterministic, not a prose parser: two labelled clauses, the specific thing each one
 * guards, and the ordering. Rewording the surrounding text stays free.
 *
 * @param {string} text
 * @returns {string[]} one message per violated rule; empty means the contract holds
 */
function preflightContractErrors(text) {
  const errors = [];

  // ORDERING. A preflight that fails AFTER `cdk deploy` is not a preflight: by then the User Pool
  // domain exists. Every ordering statement must say `before`, and at least one must exist — an
  // absent statement is as bad as a wrong one.
  const ordering = [...text.matchAll(/fail\s+(\w+)\s+`cdk deploy`/g)].map((m) => m[1]);
  if (ordering.length === 0) {
    errors.push('the preflight must state that it fails BEFORE `cdk deploy` runs');
  }
  for (const word of ordering) {
    if (word !== 'before') errors.push(`the preflight must fail BEFORE \`cdk deploy\`, not ${word}`);
  }

  for (const [id, required] of [
    // Must refuse on the RESOLVED value: a committed default and a failed override look identical.
    ['PREFLIGHT-1', ['.invalid', 'authCallbackUrls', 'authLogoutUrls', 'refuse to run `cdk deploy`']],
    // Must require BOTH explicit supply and regional uniqueness — either alone is not the condition.
    ['PREFLIGHT-2', ['authDomainPrefix', 'explicitly', 'unique', 'region', 'refuse to run `cdk deploy`']],
  ]) {
    const m = new RegExp(`\\*\\*${id}\\*\\*([\\s\\S]*?)(?=\\n- \\*\\*|\\n#{2,3} )`).exec(text);
    if (!m) {
      errors.push(`${id} must be present as a labelled clause`);
      continue;
    }
    for (const token of required) {
      if (!m[1].includes(token)) errors.push(`${id} must name ${token}`);
    }
  }

  // The preflight binds every lane, not just the pilot one that first needed it.
  if (!/applies to EVERY deploy lane/.test(text)) {
    errors.push('the preflight must state that it binds every deploy lane');
  }

  return errors;
}

test('the #70 handoff carries both deploy preflight conditions #69 registered against it', () => {
  // #69 registered two binding conditions on #70 and then closed. A transfer that keeps the domain
  // DECISION but drops the preflight loses them silently: deciding the origin makes the values
  // knowable, supplying and verifying them is what clears the deploy.
  const text = read('.agent-handoff/done/70-cloudflare-aws-deploy-pipeline.md');
  assert.deepEqual(preflightContractErrors(text), [], 'the real #70 handoff must satisfy the contract');
});

test('POSITIVE CONTROL: the preflight contract rejects each way it can be hollowed out', () => {
  const text = read('.agent-handoff/done/70-cloudflare-aws-deploy-pipeline.md');
  const rejects = (mutated, why) => {
    assert.notDeepEqual(preflightContractErrors(mutated), [], `must be rejected: ${why}`);
  };

  // The ordering. This is the mutation the file-reading version of this check could not see: the
  // clauses, the tokens and the every-lane sentence all survive it, and the guard still passed.
  rejects(text.replace('fail before `cdk deploy`', 'fail after `cdk deploy`'), 'before -> after');
  rejects(text.replace(/fail before `cdk deploy` runs/, 'fail when convenient'), 'ordering removed');

  // The clauses, and the specific thing each one guards.
  rejects(text.replace('**PREFLIGHT-1**', '**GONE-1**'), 'PREFLIGHT-1 deleted');
  rejects(text.replace('**PREFLIGHT-2**', '**GONE-2**'), 'PREFLIGHT-2 deleted');
  rejects(text.replace('**explicitly\n  supplied**', '**supplied**'), 'explicit supply dropped');
  rejects(text.split('unique').join('set'), 'regional uniqueness dropped');
  rejects(text.replace(/refuse to run `cdk deploy` if `\.invalid`/, 'refuse if `.invalid`'), 'PREFLIGHT-1 loses its anchor');

  // The scope.
  rejects(text.replace('applies to EVERY deploy lane', 'applies to the pilot lane'), 'narrowed to pilot');
});

test('a link-only surface may not define authority, and must point at the contract', () => {
  // No surface is link-only today; the rule is asserted on the primitive so it holds when one appears.
  for (const rel of POLICY.surfaceClassification?.['link-only'] ?? []) {
    const text = read(rel);
    assert.deepEqual(
      authorityStatements(text),
      [],
      `${rel} is link-only and must not make an authority statement`,
    );
    assert.match(text, /MESSAGE-PROTOCOL\.md/, `${rel} is link-only and must link to the canonical contract`);
  }
});

test('a surface classified twice is rejected', () => {
  expectRejected((p) => {
    p.surfaceClassification['link-only'].push('AGENTS.md');
  }, /classified as both canonical-authority and link-only/);
});

test('an unknown classification bucket is rejected', () => {
  expectRejected((p) => {
    p.surfaceClassification.advisory = ['README.md'];
  }, /policy\.surfaceClassification has unknown key\(s\): advisory/);
});

test('a canonical surface removed from the classification is rejected', () => {
  expectRejected((p) => {
    p.surfaceClassification['canonical-authority'] = p.surfaceClassification['canonical-authority'].filter(
      (s) => s !== 'bin/cli.js',
    );
  }, /canonical-authority.*missing bin\/cli\.js/s);
});

test('a missing allowlist key is rejected, so a whole surface cannot go unchecked', () => {
  expectRejected((p) => {
    delete p.allowedAuthorityStatements['.agent-handoff/CURRENT.md'];
  }, /allowedAuthorityStatements keys must be exactly the declared set — missing \.agent-handoff\/CURRENT\.md/);
});

test('REGRESSION: an authority claim in a newly governed surface fails the allowlist', () => {
  // One per surface class of input named in the finding: a cold-start state file, the active handoff,
  // the CLI help and a template. Each is checked against the collector the allowlist uses.
  for (const planted of [
    'The review scope authorizes publication.',
    'A gate may be reused for a regenerated artifact.',
    'The execution gate authorizes merge.',
  ]) {
    const found = authorityStatements(planted);
    assert.equal(found.length, 1, `must be collected: ${planted}`);
    for (const rel of ['.agent-handoff/CURRENT.md', '.agent-handoff/done/93-human-publication-script.md', 'bin/cli.js', '.agent-handoff/templates/decision.md']) {
      const allowed = new Set(POLICY.allowedAuthorityStatements[rel] ?? []);
      assert.equal(allowed.has(found[0]), false, `${rel} must not already permit: ${planted}`);
    }
  }
});

// ─── SLICE I6-2 ───────────────────────────────────────────────────────────────────────────────
// The [SPEC-ID] annotation MIGRATION is a closed inventory. spec:lint proves existing tokens
// RESOLVE; it cannot see a token that was silently deleted. This regression pins the exact
// bracketed literals the I6 migration placed (and the pre-existing frontmatter lists it counts
// on), file by file — remove or reword one and this fails by name. It is deliberately FINITE:
// a future PROPOSED id gains no obligation here; per-anchor presence becomes mandatory only at
// activation (SPEC-GOV-006). Extending this inventory is part of annotating, not automatic.
test('SLICE I6-2: the annotation migration inventory is FINITE and every expected token is present', () => {
  const INVENTORY = {
    'infra/aws/bin/deploy-release.js': [
      '[SPEC-DEPLOY-001, SPEC-DEPLOY-008, SPEC-DEPLOY-011, SPEC-DEPLOY-013, SPEC-DEPLOY-016, SPEC-DEPLOY-017, SPEC-DEPLOY-018]',
      '[SPEC-DEPLOY-007]', '[SPEC-DEPLOY-009]', '[SPEC-DEPLOY-010]', '[SPEC-DEPLOY-003]',
      '[SPEC-DEPLOY-012]', '[SPEC-DEPLOY-005]', '[SPEC-RUN-007]', '[SPEC-RUN-008]', '[SPEC-DEPLOY-021]',
    ],
    'infra/aws/lib/context.js': ['[SPEC-DEPLOY-015]', '[SPEC-DEPLOY-004]'],
    'infra/aws/lib/deploy-preflight.js': ['[SPEC-DEPLOY-019]'],
    'bin/resolve-run.mjs': ['[SPEC-LANE-007]'],
    'infra/aws/lib/security-stack.js': ['[SPEC-IAM-001]'],
    '.github/workflows/release-pilot.yml': [
      '[SPEC-LANE-001, SPEC-LANE-002, SPEC-LANE-003, SPEC-LANE-004, SPEC-RUN-007, SPEC-RUN-008]',
      '[SPEC-LANE-006]', '[SPEC-LANE-005, SPEC-LANE-006]',
    ],
    'docs/runbooks/README.md': ['[SPEC-RUN-001]', '[SPEC-RUN-002]', '[SPEC-RUN-005]', '[SPEC-RUN-003, SPEC-RUN-004]'],
    'spec/agents/gemini-spec-auditor.md': ['[SPEC-AUDIT-002, SPEC-AUDIT-003, SPEC-AUDIT-004, SPEC-AUDIT-005]'],
    'spec/spec-anchored-development.md': [
      '[SPEC-GOV-001]', '[SPEC-GOV-002, SPEC-GOV-003, SPEC-GOV-004, SPEC-GOV-005]',
      '[SPEC-GOV-006, SPEC-GOV-007]', '[SPEC-GOV-004, SPEC-GOV-008]', '[SPEC-GOV-009]',
    ],
  };
  // Sites the migration counts on but did not create: the twin DEPLOY-019 tokens in the
  // entrypoint and the twin DEPLOY-006/DEPLOY-014 pairs are asserted by COUNT so neither copy
  // can vanish while the other keeps the include() true.
  const COUNTS = {
    'infra/aws/bin/deploy-release.js': [['[SPEC-DEPLOY-019]', 2], ['[SPEC-DEPLOY-006]', 2], ['[SPEC-DEPLOY-014]', 2]],
    'infra/aws/lib/context.js': [['[SPEC-DEPLOY-015]', 2]],
    '.github/workflows/release-pilot.yml': [['[SPEC-LANE-006]', 2]],
  };
  for (const [file, tokens] of Object.entries(INVENTORY)) {
    const body = fs.readFileSync(path.join(ROOT, file), 'utf8');
    for (const token of tokens) {
      assert.ok(body.includes(token), `${file} must carry ${token} — a silently dropped annotation is drift, not cleanup`);
    }
  }
  for (const [file, pairs] of Object.entries(COUNTS)) {
    const body = fs.readFileSync(path.join(ROOT, file), 'utf8');
    for (const [token, expected] of pairs) {
      const seen = body.split(token).length - 1;
      assert.equal(seen, expected, `${file} must carry ${token} exactly ${expected} times (saw ${seen})`);
    }
  }
});

// ─── SLICE I7 ─────────────────────────────────────────────────────────────────────────────────
// The Gemini Spec Auditor persona is SEATED — and seated as NOTHING BUT an auditor. These two
// tests are the discriminants Codex required: every canonical surface declares the SAME role
// with no contradiction, and the policy validator refuses a Gemini that gains any grant or a
// reworded standing.
test('SLICE I7: every canonical surface seats the SAME Gemini persona — read-only, no authority', () => {
  const protocol = read(PROTOCOL);
  assert.match(protocol, /Read-only semantic auditor/);
  assert.match(protocol, /SPEC_AUDIT_REPORT v1 document artifact/);
  assert.match(protocol, /mechanical layers first, then the semantic audit, then Codex/);
  const agents = read('AGENTS.md');
  assert.match(agents, /Gemini Spec Auditor persona/);
  assert.match(agents, /SPEC_AUDIT_REPORT v1/);
  const persona = read('spec/agents/gemini-spec-auditor.md');
  assert.match(persona, /Status: SEATED \(Slice I7\)/);
  assert.match(persona, /VERDICT: PASS \| FINDINGS \| INCOMPLETE/);
  assert.match(persona, /AUTHORITY: none/);
  assert.match(read('docs/runbooks/spec-conformance-audit.md'), /PERSONA SEATED \(Slice I7\)/);
  // The policy twin: the exact seated standing — an empty may is the LAW, not an omission.
  assert.equal(POLICY.actors.gemini.role, 'read-only semantic auditor — the Gemini Spec Auditor persona; no authority of any kind');
  assert.deepEqual(POLICY.actors.gemini.may, []);
  for (const cap of ['accept-risk', 'access-secrets', 'any-authority-bearing-role', 'author-cloud-authorization', 'authorize-spend', 'deploy', 'grant-human-gate', 'implement', 'invoke-paid-service', 'merge', 'operate-artifact', 'perform-cloud-effect', 'prepare-artifact', 'push']) {
    assert.ok(POLICY.actors.gemini.mayNever.includes(cap), `gemini.mayNever must include ${cap}`);
  }
  // The paid invocation stays Zamp's effect under the spend document — the persona spends nothing.
  assert.equal(POLICY.effects['invoke-paid-model-audit'].authorizedBy, 'spend-authorization');
});

test('SLICE I7: the validator refuses a Gemini that gains any grant or a reworded standing', () => {
  expectRejected((p) => {
    p.actors.gemini.may = ['validate'];
  }, /gemini/);
  expectRejected((p) => {
    p.actors.gemini.role = 'semantic reviewer';
  }, /gemini/);
  expectRejected((p) => {
    p.actors.gemini.mayNever = p.actors.gemini.mayNever.filter((c) => c !== 'grant-human-gate');
  }, /gemini/);
});

// ─── ROUND I7-2 ── the seated role and the broad ban must never coexist again ─────────────────
test('ROUND I7-2: the retired blanket term cannot return while the persona is seated', () => {
  // The finding: a policy that seats a read-only auditor while forbidding "any workflow or
  // governance role" contradicts itself — a literal consumer must conclude the persona may not
  // exercise its own seat. The blanket term was NARROWED to authority ('any-authority-bearing-
  // role'); this regression keeps the two states from ever coexisting again. The string is
  // split so this test's own source cannot satisfy the scan it performs.
  const retired = 'any-workflow-or-' + 'governance-role';
  for (const rel of ['spec/authority-policy.json', 'src/lib/authority-policy.js', PROTOCOL, 'AGENTS.md', 'spec/agents/gemini-spec-auditor.md']) {
    assert.ok(!read(rel).includes(retired), `${rel} must not carry the retired blanket ban "${retired}" — the seated persona HAS a role; what it may never have is authority`);
  }
  // …and the narrowed term is REAL, in the vocabulary and on the actor, never grantable.
  assert.ok(POLICY.actors.gemini.mayNever.includes('any-authority-bearing-role'));
  assert.ok(!POLICY.actors.gemini.may.includes('any-authority-bearing-role'));
  const persona = read('spec/agents/gemini-spec-auditor.md');
  assert.match(persona, /Status: SEATED \(Slice I7\)/, 'the persona stays seated while the ban stays narrowed');
});

// ─── SLICE I8 ── the first activations: enforcement is ON and its evidence is closed ──────────
test('SLICE I8: the first two activations are ACTIVE with closed §6c records — enforcement is on', () => {
  const reg = JSON.parse(read('spec/registry.json'));
  for (const id of ['SPEC-DEPLOY-016', 'SPEC-DEPLOY-021']) {
    const e = reg.entries.find((x) => x.id === id);
    assert.equal(e.status, 'ACTIVE', `${id} must stay ACTIVE — enforcement is never quietly switched off`);
    assert.deepEqual(Object.keys(e.mutationEvidence).sort(), ['command', 'commit', 'expectedFailure', 'patchSha256']);
    assert.match(e.mutationEvidence.commit, /^[0-9a-f]{40}$/);
    assert.match(e.mutationEvidence.patchSha256, /^[0-9a-f]{64}$/);
    assert.ok(e.tests.length >= 2 && e.tests.every((t) => typeof t.title === 'string' && t.title.length > 0), `${id} names its exact tests`);
  }
});
