// Human-operated publication script generator (#93) — PURE logic, no I/O, no network, no git.
//
// WHERE THIS SITS. Three layers exist and a cold-started agent must not confuse them:
//
//   1. #91 Stage A — `agent-publish`: advisory LOCAL gate validation. Validates, prints, stops.
//   2. THIS bridge — the executor PREPARES a short-lived script, the architect/security reviewer
//      READS it, and the HUMAN runs it with a verify-and-run command that hashes the bytes it
//      executes. No agent ever executes it.
//   3. #91 Stage B — authenticated bot/App identity, remote replay consumption, required PR and
//      administrator enforcement. Only Stage B makes any of this unforgeable.
//
// The script and the declared roles are PROCESS guardrails, not authenticated role separation. A
// caller declares its own role; nothing here proves it. The bridge exists because the human needs
// a reviewable, bounded artifact instead of typing publication commands from memory — which is how
// the 2026-07-26 incident happened.
//
// The generator is deliberately incapable of acting: it produces text and a path. It performs no
// network call and no Git/GitHub mutation, and the file it writes is non-executable by design so
// running it is always an explicit human decision.
import { safeLabel, GateError } from './publish-gate.js';

/** Directory the artifact may live in. A repository path would make it look like project code. */
export const OUTPUT_ROOT = '/tmp';

/** Bash primitives the generated script must never contain. Asserted by tests on real output. */
export const FORBIDDEN_SCRIPT_PATTERNS = [
  { label: 'force push', re: /--force|--force-with-lease|\+refs\/|push\s+-f\b/ },
  { label: 'pushing an integration branch', re: /push\s+\S+\s+(HEAD:)?(main|master)\b|:refs\/heads\/(main|master)\b/ },
  // `git merge` but NOT `git merge-base`: the script legitimately uses `merge-base --is-ancestor`
  // to prove the push is a fast-forward. `\bmerge\b` alone matched the hyphen and made the
  // self-check refuse every well-formed script.
  { label: 'merge', re: /\bgh\s+pr\s+merge\b|\bgit\s+merge(?![-\w])|\bgh\s+api\b[^\n]*\/merge\b/ },
  { label: 'deploy', re: /\bgh\s+workflow\s+run\b|\bcdk\s+deploy\b|\bwrangler\s+deploy\b|\baws\s+\w+\s+(create|update|delete|put)/ },
  { label: 'repository administration', re: /\bgh\s+api\b[^\n]*\/(branches|rulesets|protection|actions\/secrets|environments)\b|\bgh\s+repo\s+edit\b|\bgh\s+secret\b/ },
  { label: 'credential handling', re: /GH_TOKEN=|GITHUB_TOKEN=|AWS_SECRET|\bgh\s+auth\s+(login|refresh|token)\b|~\/\.aws\/credentials/ },
  { label: 'history rewriting', re: /\bgit\s+(rebase|reset\s+--hard|commit\s+--amend|filter-branch|push\s+--mirror)\b/ },
  { label: 'paid service invocation', re: /bedrock|invoke-model|openai\.com|anthropic\.com\/v1/i },
];

function fail(code, message) {
  throw new GateError(code, message);
}

/**
 * Validate the requested output path.
 *
 * The path decides where a runnable artifact lands, so it is validated structurally BEFORE the
 * filesystem is consulted: a traversal segment or a repository path is a defect regardless of what
 * happens to exist on disk. Symlink and overwrite are filesystem facts, so the caller passes an
 * observation rather than this module reaching for `fs`.
 *
 * @param {string} outputPath requested absolute path
 * @param {{ exists?: boolean, isSymlink?: boolean, repoRoot?: string }} [observed]
 */
export function assertSafeOutputPath(outputPath, observed = {}) {
  if (typeof outputPath !== 'string' || outputPath.trim() === '') {
    fail('OUTPUT_PATH_INVALID', 'An output path is required.');
  }
  const raw = outputPath;
  if (raw !== raw.trim()) fail('OUTPUT_PATH_INVALID', 'The output path must not have surrounding whitespace.');
  if (/[\x00-\x1f\x7f]/.test(raw)) fail('OUTPUT_PATH_INVALID', 'The output path must not contain control characters.');
  if (!raw.startsWith(`${OUTPUT_ROOT}/`)) {
    fail('OUTPUT_PATH_OUTSIDE_TMP', `The script must be written under ${OUTPUT_ROOT}/ — it is a temporary artifact, not project code.`);
  }
  // Traversal is refused on the LITERAL path: a normalised path that happens to stay inside /tmp
  // still signals a caller doing something it should not.
  if (raw.split('/').includes('..') || raw.includes('/./')) {
    fail('OUTPUT_PATH_TRAVERSAL', 'The output path must not contain traversal segments.');
  }
  if (!/^\/tmp\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.sh$/.test(raw)) {
    fail('OUTPUT_PATH_INVALID', 'The output path must be /tmp/<name>.sh with a safe, bounded name.');
  }
  if (observed.repoRoot && raw.startsWith(`${observed.repoRoot}/`)) {
    fail('OUTPUT_PATH_IN_REPO', 'The script must never be written inside the repository.');
  }
  if (observed.isSymlink === true) {
    fail('OUTPUT_PATH_SYMLINK', 'The output path is a symlink; refusing to follow it.');
  }
  if (observed.exists === true) {
    fail('OUTPUT_PATH_EXISTS', 'The output path already exists; refusing to overwrite a previous artifact.');
  }
  return raw;
}

/** `owner/repo`, nothing else — it is interpolated into the script. */
export function assertRepoSlug(slug) {
  if (typeof slug !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,38}\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(slug)) {
    fail('REPO_SLUG_INVALID', 'The repository must be "owner/repo".');
  }
  if (safeLabel(slug) === '<redacted>') {
    fail('REPO_SLUG_INVALID', 'The repository slug was refused and is not echoed.');
  }
  return slug;
}

function shQuote(value) {
  // Single-quote for the shell. Every interpolated value has already passed a strict validator, so
  // this is belt-and-braces rather than the primary defence.
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/**
 * The command the human actually runs.
 *
 * `bash <path>` was wrong, and subtly so: the reviewer verifies a digest, and then the human opens
 * the path AGAIN. Anything running as the same user can replace the file in between, and the human
 * would then execute arbitrary commands under their own git/gh credentials — the exact authority
 * this whole design exists to constrain. Verifying and executing must act on ONE read.
 *
 * This reads the file once into a shell variable, hashes those captured bytes, and only then runs
 * them with `bash -c`. The path is never reopened, so no window exists between the check and the
 * execution. Command substitution strips trailing newlines, so the digest is recomputed over
 * `printf '%s\n'`, which reproduces the file exactly because the generated script ends with exactly
 * one newline — asserted by a test, since the whole guarantee rests on it.
 *
 * @param {string} outputPath the artifact's path
 * @param {string} digest sha256 of the bytes on disk
 */
export function verifyAndRunCommand(outputPath, digest) {
  // Wrapped in a subshell so a mismatch can `exit 1` — a refusal must be detectable by exit status,
  // not only by a message — without terminating the human's interactive shell, which a bare `exit`
  // would do. The subshell inherits the terminal, so the script's TTY check and typed confirmation
  // still work.
  return [
    '(',
    `  s=$(cat ${shQuote(outputPath)})`,
    `  if [ "$(printf '%s\\n' "$s" | sha256sum | cut -d' ' -f1)" = ${shQuote(digest)} ]; then`,
    '    bash -c "$s"',
    '  else',
    "    echo 'REFUSED: the script changed after review — do not run it' >&2",
    '    exit 1',
    '  fi',
    ')',
  ].join('\n');
}

/**
 * Build the human-operated publication script.
 *
 * Everything the script may touch is bound at generation time from an already-validated gate:
 * repository, issue, source branch, target branch, the exact ordered reviewed SHAs, the expected
 * HEAD and the gate expiry. The script re-verifies all of it against live state — including that
 * its push target and its API target are the same repository, and that the open pull-request set is
 * unambiguous and not a fork's — before its two bounded external effects: a non-force push of the
 * gated branch, then creating or reusing exactly one pull request.
 *
 * @param {object} args
 * @param {object} args.result output of Stage A `validateGate`
 * @param {string} args.repo `owner/repo`
 * @param {string} args.generatedAt ISO instant
 * @returns {string} script text
 */
export function buildPublicationScript({ result, repo, generatedAt }) {
  assertRepoSlug(repo);
  const gate = result.gate;
  const commits = result.commits;
  const head = commits[commits.length - 1];
  const issue = gate.issue;
  const source = result.sourceBranch;
  const target = gate.targetBranch;
  const confirmation = `publish ${issue} ${head.slice(0, 12)}`;

  return `#!/usr/bin/env bash
# Human-operated publication script for issue #${issue} — GENERATED, DO NOT EDIT.
#
# Generated: ${generatedAt}
# Gate:      ${gate.gateId}
# Approver:  ${gate.approver}
#
# WHO RUNS THIS: the human operator, explicitly, using the verify-and-run command printed when this
# file was prepared. That command reads this file ONCE, checks its SHA-256 against the reviewed
# digest, and executes those same captured bytes. Do NOT run it with a bare \`bash <path>\`: that
# reopens the file, and anything running as your user could have replaced it after the review.
# No agent may execute it. The file is mode 0600 and deliberately NOT executable so running it is
# always a deliberate act. It uses only your existing git/gh session — it holds no credential.
#
# WHAT IT MAY DO — exactly two bounded external effects, in this order: push the gated branch
# ${source} without force, and then create or reuse exactly one pull
# request into ${target}. It performs NO OTHER REMOTE MUTATION. (It is not purely read-only
# locally: when the branch already exists on the remote it fetches those objects so ancestry can
# be proven, which writes to the local object store and FETCH_HEAD.)
#
# WHAT IT MAY NEVER DO: merge, deploy, push ${target}, force-push, rewrite history, change
# repository settings or branch protection, read or administer secrets, or call a paid service.
# Merge remains a separate human action after required checks and review.
#
# This is the interim bridge between #91 Stage A (advisory local validation) and #91 Stage B
# (authenticated bot identity and remote enforcement). It is a process guardrail, not authenticated
# role separation.

set -euo pipefail

REPO=${shQuote(repo)}
ISSUE=${shQuote(String(issue))}
SOURCE_BRANCH=${shQuote(source)}
TARGET_BRANCH=${shQuote(target)}
EXPECTED_HEAD=${shQuote(head)}
BASE_SHA=${shQuote(gate.baseSha)}
GATE_ID=${shQuote(gate.gateId)}
GATE_EXPIRES=${shQuote(gate.expiresAt)}
CONFIRMATION=${shQuote(confirmation)}
REVIEWED_SHAS=(
${commits.map((sha) => `  ${shQuote(sha)}`).join('\n')}
)

die() { printf '%s\\n' "REFUSED: $*" >&2; exit 1; }
note() { printf '%s\\n' "$*"; }

# --- 0. a human must be at the keyboard ---------------------------------------------------------
# Not decoration: without a terminal the typed confirmation below could be fed from a pipe or a
# here-string by an automated caller. Refusing a non-interactive stdin keeps the confirmation a
# human act rather than a string an agent can supply.
[ -t 0 ] || die "this script must be run interactively by a human operator, not from a pipe or an agent"

# --- 1. volatile checks, defined once and run TWICE ---------------------------------------------
# Expiry, the origin binding, the live remote and the pull-request set are all state that can change
# while a human reads the prompt. Checking them only before the confirmation would mean a terminal
# left open overnight could push against an expired gate or a moved base. They are functions so the
# exact same assertions run again immediately before the push, with nothing in between.

check_gate_expiry() {
  local now_epoch expiry_epoch
  now_epoch=$(date -u +%s)
  expiry_epoch=$(date -u -d "$GATE_EXPIRES" +%s 2>/dev/null) \\
    || die "cannot parse the gate expiry ($GATE_EXPIRES); GNU date is required"
  [ -n "$expiry_epoch" ] || die "cannot parse the gate expiry"
  [ "$now_epoch" -le "$expiry_epoch" ] || die "the publish gate expired at $GATE_EXPIRES; ask for a new one"
}

# The push goes to \`origin\`; every \`gh\` query goes to $REPO. If those two ever name different
# repositories, the branch lands in one place while the pull request is inspected in another.
check_origin_binding() {
  local origin_url
  origin_url=$(git remote get-url origin)
  case "$origin_url" in
    "https://github.com/$REPO"|"https://github.com/$REPO.git"|"git@github.com:$REPO"|"git@github.com:$REPO.git") ;;
    *) die "the origin remote does not match the repository this script was generated for" ;;
  esac
}

# \`git ls-remote\` reads the live value over the wire and touches no local ref. A local
# remote-tracking ref is only as fresh as the last fetch, which is not good enough for the check
# that decides whether the reviewed base is still the real base.
check_remote_state() {
  local remote_base remote_head
  remote_base=$(git ls-remote origin "refs/heads/$TARGET_BRANCH" | awk 'NR==1 {print $1}')
  [ -n "$remote_base" ] || die "cannot read origin/$TARGET_BRANCH from the remote"
  [ "$remote_base" = "$BASE_SHA" ] || die "origin/$TARGET_BRANCH moved since review; re-review against the new base"

  remote_head=$(git ls-remote origin "refs/heads/$SOURCE_BRANCH" | awk 'NR==1 {print $1}')
  if [ -n "$remote_head" ] && [ "$remote_head" != "$EXPECTED_HEAD" ]; then
    # The branch already exists remotely and differs. Fetching brings its objects locally so
    # ancestry can be proven; it is the only local write this script performs and it mutates
    # nothing on the remote. Refuse unless the push is a pure fast-forward.
    git fetch --quiet origin "refs/heads/$SOURCE_BRANCH" || die "cannot read the existing remote branch"
    git merge-base --is-ancestor "$remote_head" "$EXPECTED_HEAD" \\
      || die "the remote branch has commits this push would discard; a force push is never performed"
  fi
}

# \`gh pr list --head\` matches by BRANCH NAME and spans forks, so a pull request opened from a fork
# whose branch happens to share this name would otherwise look like "the" pull request.
pr_query() {
  gh pr list --repo "$REPO" --head "$SOURCE_BRANCH" --state open \\
    --json number,baseRefName,headRefName,isCrossRepository,headRepositoryOwner
}
REPO_OWNER=\${REPO%%/*}

# Refuses unless the open pull requests for this head are zero, or exactly one that belongs to this
# repository, is not from a fork, and targets exactly the reviewed base and head.
assert_pr_set() {
  local when="$1" json count
  json=$(pr_query)
  count=$(printf '%s' "$json" | jq 'length')
  [ "$count" -le 1 ] || die "$when: $count open pull requests share this head branch; refusing to guess which one is correct"
  if [ "$count" -eq 1 ]; then
    [ "$(printf '%s' "$json" | jq -r '.[0].isCrossRepository')" = "false" ] \\
      || die "$when: the open pull request comes from a fork; refusing to touch it"
    [ "$(printf '%s' "$json" | jq -r '.[0].headRepositoryOwner.login')" = "$REPO_OWNER" ] \\
      || die "$when: the open pull request is headed from another owner; refusing to touch it"
    [ "$(printf '%s' "$json" | jq -r '.[0].baseRefName')" = "$TARGET_BRANCH" ] \\
      || die "$when: the open pull request targets a different base; refusing to touch it"
    [ "$(printf '%s' "$json" | jq -r '.[0].headRefName')" = "$SOURCE_BRANCH" ] \\
      || die "$when: the open pull request has a different head; refusing to touch it"
  fi
  printf '%s' "$count"
}

command -v jq >/dev/null 2>&1 || die "jq is required to inspect pull requests safely"
command -v git >/dev/null 2>&1 || die "git is required"
command -v gh >/dev/null 2>&1 || die "the GitHub CLI is required"

check_gate_expiry

# --- 2. the branch may never be an integration branch ------------------------------------------
case "$SOURCE_BRANCH" in
  main|master) die "the source branch may never be an integration branch" ;;
esac
[ "$TARGET_BRANCH" = "main" ] || die "the pull request must target main"

# --- 3. local worktree: correct branch, clean, exclusive ---------------------------------------
current_branch=$(git rev-parse --abbrev-ref HEAD)
[ "$current_branch" = "$SOURCE_BRANCH" ] || die "checked out branch is not the gated source branch"
[ -z "$(git status --porcelain)" ] || die "the worktree has uncommitted changes"
worktree_count=$(git worktree list --porcelain | grep -c "^branch refs/heads/$SOURCE_BRANCH$" || true)
[ "$worktree_count" -le 1 ] || die "the gated branch is checked out in more than one worktree"

# --- 4. local history: exact HEAD and exact ordered commit set ----------------------------------
head_sha=$(git rev-parse HEAD)
[ "$head_sha" = "$EXPECTED_HEAD" ] || die "HEAD is not the reviewed commit"
mapfile -t observed < <(git rev-list --reverse "$BASE_SHA..HEAD")
[ "\${#observed[@]}" -eq "\${#REVIEWED_SHAS[@]}" ] || die "the commit count changed since review"
for i in "\${!REVIEWED_SHAS[@]}"; do
  [ "\${observed[$i]}" = "\${REVIEWED_SHAS[$i]}" ] || die "commit $((i + 1)) differs from the reviewed set (amend, rebase or reorder)"
done

# --- 5. remote pre-flight, BEFORE anything is published -----------------------------------------
# Doing this before the confirmation means a mismatch costs nothing: the branch is not published.
note "Reading remote state (no remote mutation)..."
check_origin_binding
check_remote_state
pr_count_before=$(assert_pr_set "before publishing")

# --- 6. explicit typed confirmation -------------------------------------------------------------
note ""
note "About to publish:"
note "  repository : $REPO"
note "  issue      : #$ISSUE"
note "  branch     : $SOURCE_BRANCH -> $TARGET_BRANCH (pull request only)"
note "  head       : \${EXPECTED_HEAD:0:12}"
note "  gate       : $GATE_ID"
note ""
note "Type exactly:  $CONFIRMATION"
printf 'confirmation> '
read -r typed
[ "$typed" = "$CONFIRMATION" ] || die "confirmation did not match; nothing was published"

# --- 7. REVALIDATION: the same checks again, with nothing between them and the push --------------
# The human may have taken any amount of time at the prompt. Everything that could have changed in
# the meantime is re-verified here; local history is re-verified too, in case the worktree moved.
note "Revalidating after confirmation..."
check_gate_expiry
check_origin_binding
check_remote_state
[ "$(git rev-parse HEAD)" = "$EXPECTED_HEAD" ] || die "HEAD changed while awaiting confirmation"
[ -z "$(git status --porcelain)" ] || die "the worktree changed while awaiting confirmation"
pr_count_now=$(assert_pr_set "after confirmation")
[ "$pr_count_now" = "$pr_count_before" ] || die "the pull-request set changed while awaiting confirmation"

# --- 8. FIRST external effect: a normal push of the gated branch ------------------------------------
note "Pushing $SOURCE_BRANCH (no force)..."
git push origin "refs/heads/$SOURCE_BRANCH:refs/heads/$SOURCE_BRANCH"

# --- 9. SECOND external effect: create or reuse EXACTLY one pull request -----------------------
# Re-queried after the push, not trusted from before it: the remote may have changed in between,
# and the same assertions must hold against the state that actually exists now.
pr_count_after=$(assert_pr_set "after publishing")
if [ "$pr_count_after" -eq 1 ]; then
  existing_number=$(pr_query | jq -r '.[0].number')
  note "Reusing existing pull request #$existing_number (its branch was updated by the push above)."
else
  [ "$pr_count_now" -eq 0 ] || die "the pull request that existed before the push is gone; stopping rather than opening a second one"
  note "Creating the pull request..."
  gh pr create --repo "$REPO" --base "$TARGET_BRANCH" --head "$SOURCE_BRANCH" \\
    --title "Issue #$ISSUE" \\
    --body "Publishes the reviewed branch for issue #$ISSUE under gate $GATE_ID. Merge remains a separate human action after required checks and review."
fi

# --- 10. redacted evidence ------------------------------------------------------------------------
note ""
note "Published (evidence — no credential material):"
note "  gate       : $GATE_ID"
note "  issue      : #$ISSUE"
note "  branch     : $SOURCE_BRANCH"
note "  head       : \${EXPECTED_HEAD:0:12}"
note "  base       : \${BASE_SHA:0:12}"
note "  commits    : \${#REVIEWED_SHAS[@]}"
note "  merged     : no — merge is a separate human action"
`;
}
