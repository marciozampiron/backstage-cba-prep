#!/usr/bin/env node
/**
 * Resolve ONE workflow run by its complete, closed run name — the canonical procedure of
 * docs/runbooks/README.md, as a reviewed executable instead of a loop pasted into a terminal.
 *
 * Design round 8 found two defects in the pasted loop this file replaces: it stopped watching for
 * duplicates the moment it found one run, so a second run bearing the same correlation id that
 * appeared DURING `gh run watch` was never seen although the rule says duplicates always stop;
 * and nothing executed the procedure, so nothing could prove it. Round 9 closed three more holes:
 * the helper accepted ANY workflow name from its caller while the contract says the workflow is
 * pinned; `--limit 50` silently truncated the window a duplicate could hide beyond; and no
 * external call carried a wall-clock deadline, so a stalled `gh` or an endlessly queued run made
 * "ten attempts" bound nothing.
 *
 * Guarantees, each proven by mutation in test/resolve-run.test.js:
 *  - the WORKFLOW IS PINNED by file identity (`release-pilot.yml`) inside this file — a name
 *    string can collide or be renamed, the file is the identity; callers cannot supply another;
 *  - the title is matched by EQUALITY against the complete run name; substrings never match;
 *  - the query window is EXHAUSTIVE OR THE RUN STOPS: the list is requested with a large pinned
 *    limit, and a page that comes back full refuses as truncated — a window that might have cut
 *    off an older duplicate proves nothing about uniqueness;
 *  - at most ATTEMPTS queries, INTERVAL_MS between them, and NO wait after the last;
 *  - more than one match at ANY query stops immediately;
 *  - after `gh run watch` reaches a terminal conclusion, the SAME query runs again and must
 *    re-observe exactly the same single run id immediately before the id is printed;
 *  - every external call carries a reviewed deadline: LIST_TIMEOUT_MS per query and
 *    WATCH_TIMEOUT_MS for the watch — the lane's own jobs are bounded by `timeout-minutes`
 *    summing to 35, so a watch that outlives 45 minutes is not a slow run, it is a hung one;
 *  - stdout carries the run id and nothing else; every stop goes to stderr with a named code.
 *
 * This helper is read-only over GitHub: `gh run list` and `gh run watch` observe; nothing here
 * dispatches, mutates, publishes or spends.
 */
import { execFileSync } from 'node:child_process';

/** SPEC-LANE-007: ten attempts, thirty seconds BETWEEN them. Pinned, not configurable. */
export const ATTEMPTS = 10;
export const INTERVAL_MS = 30_000;

/**
 * The ONE workflow this helper resolves runs of, pinned by FILE identity. Round 9: the helper
 * accepted any workflow string from its caller, so a caller could aim the whole contract at an
 * attacker-named workflow; and a display NAME is not an identity — names can collide.
 */
export const WORKFLOW_FILE = 'release-pilot.yml';

/**
 * Exhaustive-or-stop window: the query asks for up to this many runs, and a page that comes back
 * exactly this full is treated as TRUNCATED and refuses — round 9 caught `--limit 50` quietly
 * assuming the newest fifty prove uniqueness while an older duplicate sits at position 51.
 */
export const QUERY_LIMIT = 1000;

/** Wall-clock deadlines (round 9): one bounded query, one bounded watch. */
export const LIST_TIMEOUT_MS = 60_000;
/** release-pilot.yml pins timeout-minutes 5+5+15+5+5 = 35min end to end; 45 covers queue slack. */
export const WATCH_TIMEOUT_MS = 45 * 60_000;

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
 * @param {string} deps.title - the COMPLETE expected run name (closed grammar)
 * @param {(cmd: string, args: string[], opts: {timeoutMs: number}) => string} deps.exec -
 *   runs a command with a wall-clock deadline, returns stdout, throws on nonzero exit; a
 *   deadline kill must surface as an error with `timedOut: true`
 * @param {(ms: number) => Promise<void>} deps.sleep
 * @returns {Promise<number>} the unique run id, re-verified after the terminal conclusion
 */
export async function resolveRun({ title, exec, sleep }) {
  if (typeof title !== 'string' || !TITLE_RE.test(title)) {
    throw new StopError('RESOLVE_TITLE_MALFORMED', 'the run name grammar is closed (SPEC-LANE-006)');
  }

  const list = () => {
    let raw;
    try {
      raw = exec('gh', [
        'run', 'list',
        '--workflow', WORKFLOW_FILE,
        '--branch', 'main',
        '--event', 'workflow_dispatch',
        '--limit', String(QUERY_LIMIT),
        '--json', 'databaseId,displayTitle',
      ], { timeoutMs: LIST_TIMEOUT_MS });
    } catch (err) {
      throw new StopError(err && err.timedOut ? 'RESOLVE_LIST_TIMEOUT' : 'RESOLVE_GH_LIST_FAILED');
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
    // A FULL page may have cut off an older duplicate: it proves presence, never uniqueness.
    if (rows.length >= QUERY_LIMIT) {
      throw new StopError('RESOLVE_WINDOW_TRUNCATED', `the query returned ${rows.length} rows; uniqueness cannot be proven from a truncated window`);
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
    exec('gh', ['run', 'watch', String(runId), '--exit-status'], { timeoutMs: WATCH_TIMEOUT_MS });
  } catch (err) {
    throw new StopError(
      err && err.timedOut ? 'RESOLVE_WATCH_TIMEOUT' : 'RESOLVE_RUN_FAILED',
      err && err.timedOut ? 'the watch outlived the reviewed deadline; a hung run is not a slow run' : 'the run did not conclude successfully',
    );
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
  const title = cliArg(process.argv, '--title');
  resolveRun({
    title,
    exec: (cmd, args, { timeoutMs }) => {
      try {
        return execFileSync(cmd, args, { encoding: 'utf8', timeout: timeoutMs, killSignal: 'SIGTERM' });
      } catch (err) {
        if (err && (err.killed === true || err.signal === 'SIGTERM' || err.code === 'ETIMEDOUT')) {
          const timeout = new Error(`deadline of ${timeoutMs}ms exceeded`);
          timeout.timedOut = true;
          throw timeout;
        }
        throw err;
      }
    },
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
