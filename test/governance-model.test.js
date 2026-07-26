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
    /^docs\/architecture\/agent-publication-runbook\.md$/,
    /^\.claude\/(skills|commands)\//,
    /^\.agents\/skills\//,
    /^bin\/cli\.js$/,
    /^src\/(commands|lib)\/(agent-|human-|publish-)/,
  ];

  return tracked.filter(
    (f) => OPERATIONAL.some((re) => re.test(f)) && !HISTORICAL.some((re) => re.test(f)),
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

test('Gemini holds no collaboration, publication or governance role', () => {
  assertNoPermission(
    /\bgemini\b/i,
    /\b(review(s|er|ing)?|approve[sd]?|approval|publish(es|ing)?|prepare[sd]?|execute[sd]?|operat(e|es|or)|push(es)?|merge[sd]?|deploy(s)?|gate|governance|workflow)\b/i,
    'Gemini must hold no workflow, publication or governance role',
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

test('the execution gate is re-checked immediately before the push, after every revalidation', () => {
  const lib = read('src/lib/human-publish-script.js');
  const push = lib.indexOf('git push origin');
  const before = lib.lastIndexOf('check_execution_gate "immediately before push"', push);
  assert.ok(before > -1 && before < push, 'the gate must be re-checked immediately before the push');

  // They must be CONSECUTIVE executable statements. "Nothing network-bound in between" was too weak
  // a rule: a printed line still sits in the window, and any statement can be widened later.
  const between = lib.slice(before + 'check_execution_gate "immediately before push"'.length, push);
  const executable = between
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '' && !l.startsWith('#'));
  assert.deepEqual(
    executable,
    [],
    `the gate check and the push must be consecutive statements; found: ${executable.join(' | ')}`,
  );
});
