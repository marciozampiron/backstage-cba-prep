// Human-operated publication script generator (#93) — PURE logic, no I/O, no network, no git.
//
// WHERE THIS SITS. Three layers exist and a cold-started agent must not confuse them:
//
//   1. #91 Stage A — `agent-publish`: advisory LOCAL gate validation. Validates, prints, stops.
//   2. THIS bridge — the executor PREPARES a short-lived script, the architect/security reviewer
//      READS it, and the HUMAN runs it explicitly with `bash <path>`. No agent ever executes it.
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
 * Build the human-operated publication script.
 *
 * Everything the script may touch is bound at generation time from an already-validated gate:
 * repository, issue, source branch, target branch, the exact ordered reviewed SHAs, the expected
 * HEAD and the gate expiry. The script re-verifies all of it against live state before doing the
 * one thing it can do — a normal push of the gated branch — and then creates or reuses exactly one
 * pull request.
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
# WHO RUNS THIS: the human operator, explicitly, with:  bash "$0"
# No agent may execute it. The file is mode 0600 and deliberately NOT executable so running it is
# always a deliberate act. It uses only your existing git/gh session — it holds no credential.
#
# WHAT IT MAY DO: verify local and remote state, push the gated branch ${source} without force,
# and create or reuse exactly one pull request into ${target}.
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

# --- 1. the gate must still be valid -------------------------------------------------------------
now_epoch=$(date -u +%s)
expiry_epoch=$(date -u -d "$GATE_EXPIRES" +%s 2>/dev/null) \\
  || die "cannot parse the gate expiry ($GATE_EXPIRES); GNU date is required"
[ -n "$expiry_epoch" ] || die "cannot parse the gate expiry"
[ "$now_epoch" -le "$expiry_epoch" ] || die "the publish gate expired at $GATE_EXPIRES; ask for a new one"

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

# --- 5. remote state: ask the REMOTE, never a local remote-tracking ref -------------------------
# \`git ls-remote\` reads the live value over the wire and touches no local ref. A previous shape of
# this check used \`refs/remotes/origin/main\`, which is only as fresh as the last fetch and relies on
# the opportunistic ref update a plain \`git fetch origin main\` happens to perform. For the check
# that decides whether the reviewed base is still the real base, "happens to" is not good enough.
note "Reading remote state (read-only)..."
remote_base=$(git ls-remote origin "refs/heads/$TARGET_BRANCH" | awk 'NR==1 {print $1}')
[ -n "$remote_base" ] || die "cannot read origin/$TARGET_BRANCH from the remote"
[ "$remote_base" = "$BASE_SHA" ] || die "origin/$TARGET_BRANCH moved since review; re-review against the new base"

remote_head=$(git ls-remote origin "refs/heads/$SOURCE_BRANCH" | awk 'NR==1 {print $1}')
if [ -n "$remote_head" ] && [ "$remote_head" != "$head_sha" ]; then
  # The branch already exists remotely and differs. Fetch its objects so ancestry can be proven,
  # and refuse unless this push is a pure fast-forward — nothing reviewed elsewhere is discarded.
  git fetch --quiet origin "refs/heads/$SOURCE_BRANCH" || die "cannot read the existing remote branch"
  git merge-base --is-ancestor "$remote_head" "$head_sha" \\
    || die "the remote branch has commits this push would discard; a force push is never performed"
fi

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

# --- 7. the ONE mutation: a normal push of the gated branch ------------------------------------
note "Pushing $SOURCE_BRANCH (no force)..."
git push origin "refs/heads/$SOURCE_BRANCH:refs/heads/$SOURCE_BRANCH"

# --- 8. create or reuse EXACTLY one pull request ------------------------------------------------
existing_number=$(gh pr list --repo "$REPO" --head "$SOURCE_BRANCH" --state open --json number --jq '.[0].number // empty')
if [ -n "$existing_number" ]; then
  existing_base=$(gh pr view "$existing_number" --repo "$REPO" --json baseRefName --jq '.baseRefName')
  existing_head=$(gh pr view "$existing_number" --repo "$REPO" --json headRefName --jq '.headRefName')
  [ "$existing_base" = "$TARGET_BRANCH" ] || die "open pull request #$existing_number targets a different base; refusing to touch it"
  [ "$existing_head" = "$SOURCE_BRANCH" ] || die "open pull request #$existing_number has a different head; refusing to touch it"
  note "Reusing existing pull request #$existing_number (its branch was updated by the push above)."
else
  note "Creating the pull request..."
  gh pr create --repo "$REPO" --base "$TARGET_BRANCH" --head "$SOURCE_BRANCH" \\
    --title "Issue #$ISSUE" \\
    --body "Publishes the reviewed branch for issue #$ISSUE under gate $GATE_ID. Merge remains a separate human action after required checks and review."
fi

# --- 9. redacted evidence ------------------------------------------------------------------------
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
