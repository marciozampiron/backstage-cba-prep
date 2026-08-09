#!/usr/bin/env node
/**
 * Resolve ONE workflow run by its complete, closed run name — the canonical procedure of
 * docs/runbooks/README.md, as a reviewed executable instead of a loop pasted into a terminal.
 *
 * Design round 8 found two defects in the pasted loop this file replaces: it stopped watching for
 * duplicates the moment it found one run, so a second run bearing the same correlation id that
 * appeared DURING `gh run watch` was never seen although the rule says duplicates always stop;
 * and nothing executed the procedure, so nothing could prove it. This helper implements the whole
 * SPEC-LANE-007 contract, and test/resolve-run.test.js drives it with a simulated `gh` through
 * zero-then-found, immediate duplication, late duplication, a vanished run, an identity change,
 * `gh` failure and unparseable output.
 *
 * Guarantees, each proven by mutation in the tests:
 *  - the title is matched by EQUALITY against the complete run name; substrings never match;
 *  - at most ATTEMPTS queries, INTERVAL_MS between them, and NO wait after the last;
 *  - more than one match at ANY query stops immediately — a duplicate correlation id means reuse,
 *    an unrecorded re-dispatch or forgery, none of which is resolved by picking a run;
 *  - after `gh run watch` reaches a terminal conclusion, the SAME query runs again and must
 *    re-observe exactly the same single run id immediately before the id is printed — uniqueness
 *    observed once is not uniqueness still true when evidence is read;
 *  - stdout carries the run id and nothing else; every stop goes to stderr with a named code.
 *
 * This helper is read-only over GitHub: `gh run list` and `gh run watch` observe; nothing here
 * dispatches, mutates, publishes or spends.
 */
import { execFileSync } from 'node:child_process';

/** SPEC-LANE-007: ten attempts, thirty seconds BETWEEN them. Pinned, not configurable. */
export const ATTEMPTS = 10;
export const INTERVAL_MS = 30_000;

/** The closed run-name grammar of SPEC-LANE-006. Anything else identifies nothing. */
export const TITLE_RE = /^cba-release (bind_only|dev_only|abandon) cba-70-[0-9a-f]{32}$/;

/** A stop is a refusal with a named code — never an exception a caller might retry through. */
export class StopError extends Error {
  constructor(code, detail) {
    super(detail ? `${code}: ${detail}` : code);
    this.code = code;
  }
}

/**
 * @param {object} deps
 * @param {string} deps.workflow - the workflow name to pin in the query
 * @param {string} deps.title - the COMPLETE expected run name (closed grammar)
 * @param {(cmd: string, args: string[]) => string} deps.exec - runs a command, returns stdout, throws on nonzero exit
 * @param {(ms: number) => Promise<void>} deps.sleep
 * @returns {Promise<number>} the unique run id, re-verified after the terminal conclusion
 */
export async function resolveRun({ workflow, title, exec, sleep }) {
  if (typeof workflow !== 'string' || workflow.trim() === '') {
    throw new StopError('RESOLVE_WORKFLOW_MISSING');
  }
  if (typeof title !== 'string' || !TITLE_RE.test(title)) {
    throw new StopError('RESOLVE_TITLE_MALFORMED', 'the run name grammar is closed (SPEC-LANE-006)');
  }

  const list = () => {
    let raw;
    try {
      raw = exec('gh', [
        'run', 'list',
        '--workflow', workflow,
        '--branch', 'main',
        '--event', 'workflow_dispatch',
        '--limit', '50',
        '--json', 'databaseId,displayTitle',
      ]);
    } catch {
      throw new StopError('RESOLVE_GH_LIST_FAILED');
    }
    let rows;
    try {
      rows = JSON.parse(raw);
    } catch {
      throw new StopError('RESOLVE_GH_OUTPUT_UNPARSEABLE');
    }
    if (
      !Array.isArray(rows)
      || rows.some((r) => !r || typeof r !== 'object' || Array.isArray(r)
        || typeof r.databaseId !== 'number' || typeof r.displayTitle !== 'string')
    ) {
      throw new StopError('RESOLVE_GH_OUTPUT_UNPARSEABLE');
    }
    // EQUALITY on the complete name. `includes()` over a title is not identification.
    return rows.filter((r) => r.displayTitle === title).map((r) => r.databaseId);
  };

  let runId = null;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    const ids = list();
    if (ids.length > 1) throw new StopError('RESOLVE_DUPLICATE_RUNS', `${ids.length} runs carry this name`);
    if (ids.length === 1) {
      runId = ids[0];
      break;
    }
    // No sleep after the final attempt: a wait nothing follows is not part of the bound.
    if (attempt < ATTEMPTS) await sleep(INTERVAL_MS);
  }
  if (runId === null) {
    throw new StopError('RESOLVE_NO_RUN', `no run after ${ATTEMPTS} attempts; waiting longer is not a remedy`);
  }

  try {
    exec('gh', ['run', 'watch', String(runId), '--exit-status']);
  } catch {
    throw new StopError('RESOLVE_RUN_FAILED', 'the run did not conclude successfully');
  }

  // The run is terminal. Re-observe IMMEDIATELY before handing the id to whatever accepts the
  // artifact: uniqueness at attempt time says nothing about now.
  const after = list();
  if (after.length > 1) throw new StopError('RESOLVE_DUPLICATE_AFTER_TERMINAL', `${after.length} runs carry this name now`);
  if (after.length === 0) throw new StopError('RESOLVE_RUN_VANISHED');
  if (after[0] !== runId) throw new StopError('RESOLVE_IDENTITY_CHANGED', 'a different run now carries this name');
  return runId;
}

function cliArg(argv, name) {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
}

const invokedAsMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (invokedAsMain) {
  const workflow = cliArg(process.argv, '--workflow');
  const title = cliArg(process.argv, '--title');
  resolveRun({
    workflow,
    title,
    exec: (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8' }),
    sleep: (ms) => new Promise((resolve) => { setTimeout(resolve, ms); }),
  }).then(
    (runId) => {
      process.stdout.write(`${runId}\n`);
    },
    (err) => {
      process.stderr.write(`STOP ${err instanceof StopError ? err.message : err}\n`);
      process.exitCode = 1;
    },
  );
}
