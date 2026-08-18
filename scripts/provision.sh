#!/usr/bin/env bash
# THE LAUNCHER (#111 r6) — materializes the authorized commit and runs the provisioning from it.
#
# HOW IT IS INVOKED (this is load-bearing, r6-F1). The operator NEVER runs the worktree's copy of
# this file. The runbook command extracts these bytes from the OBJECT STORE of the authorized
# commit and runs THAT:
#
#   L=$(mktemp /tmp/cba-launch.XXXXXX)
#   git -C <repo> show <SHA>:scripts/provision.sh > "$L"
#   CBA_REPO_ROOT=<repo> CBA_AUTHORIZED_SHA=<SHA> CBA_EXPECTED_ACCOUNT_ID=<acct> \
#     bash "$L" <dev|pilot> <policies|bootstrap>; rm -f "$L"
#
# so a tampered worktree copy of this launcher is never executed. What remains trusted is `git`
# itself and the operator's shell — tools, not this repository's code.
#
# WHAT IT DOES. Validates the SHA binding (every git probe's exit status checked BEFORE its output
# is read), extracts `scripts/` and `infra/aws/bootstrap/` of that commit into a private tree,
# writes a MANIFEST of digests into it, strips write permission, and RUNS (never `exec`s — the
# cleanup trap must survive) the provisioning script from there, cleaning the tree up afterwards.
set -euo pipefail
umask 077

ENV_NAME="${1:?usage: provision.sh dev|pilot policies|bootstrap}"
PHASE="${2:?usage: provision.sh dev|pilot policies|bootstrap}"
[ "$#" -eq 2 ] || { echo "REFUSED: exactly two arguments — environment and phase"; exit 1; }
REPO_ROOT="${CBA_REPO_ROOT:-}"
[ -n "$REPO_ROOT" ] && [ -e "$REPO_ROOT/.git" ] \
  || { echo "REFUSED: CBA_REPO_ROOT must name the repository this launcher materializes from"; exit 1; }
GIT_T="${CBA_GIT_TIMEOUT_SECONDS:-60}"
printf '%s' "$GIT_T" | LC_ALL=C grep -qzE '^[1-9][0-9]*$' && [ "$GIT_T" -le 300 ] \
  || { echo "REFUSED: CBA_GIT_TIMEOUT_SECONDS must be a positive integer no greater than 300 — zero would disable the deadline"; exit 1; }

git_() { timeout --kill-after=5 "$GIT_T" git -C "$REPO_ROOT" "$@"; }
probe() { # $1 = description; rest = git args. Sets PROBE_OUT. Refuses on ANY nonzero/timeout.
  local desc="$1"; shift
  local rc=0
  PROBE_OUT=$(git_ "$@" 2>/dev/null) || rc=$?
  { [ "$rc" -eq 124 ] || [ "$rc" -eq 137 ]; } \
    && { echo "REFUSED: the git probe for ${desc} exceeded its deadline — nothing ran"; exit 1; }
  [ "$rc" -eq 0 ] \
    || { echo "REFUSED: the git probe for ${desc} failed (status ${rc}) — a failed probe is never a clean answer; nothing ran"; exit 1; }
}

SHA="${CBA_AUTHORIZED_SHA:-}"
printf '%s' "$SHA" | LC_ALL=C grep -qzE '^[0-9a-f]{40}$' \
  || { echo "REFUSED: CBA_AUTHORIZED_SHA is required (full 40-hex commit SHA)"; exit 1; }
probe "the authorized commit" cat-file -e "${SHA}^{commit}"
probe "HEAD" rev-parse HEAD
[ "$PROBE_OUT" = "$SHA" ] \
  || { echo "REFUSED: HEAD does not match CBA_AUTHORIZED_SHA — run from the authorized commit"; exit 1; }
probe "the worktree state" status --porcelain
[ -z "$PROBE_OUT" ] \
  || { echo "REFUSED: the worktree is dirty — the authorized SHA must be the whole story"; exit 1; }

# MATERIALIZE from the commit OBJECT — the worktree's file contents never take part.
MAT=$(mktemp -d /tmp/cba-relboot-src.XXXXXX)
chmod 700 "$MAT"
cleanup() { chmod -R u+w "$MAT" 2>/dev/null || true; rm -rf "$MAT"; }
trap cleanup EXIT INT TERM
rc=0
git_ archive --format=tar "$SHA" scripts infra/aws/bootstrap 2>/dev/null | tar -x -C "$MAT" || rc=$?
[ "$rc" -eq 0 ] \
  || { echo "REFUSED: the authorized commit's scripts and bootstrap inputs could not be materialized"; exit 1; }
[ -f "$MAT/scripts/provision-release-bootstrap.sh" ] && [ -f "$MAT/scripts/lib/bounded-run.py" ] \
  || { echo "REFUSED: the materialized tree is incomplete"; exit 1; }

# The MANIFEST binds root + contents + SHA, and the child re-verifies it in both directions.
# The digest list is built OUTSIDE the tree: a temp file inside it would list itself.
MANIFEST_TMP=$(mktemp /tmp/cba-manifest.XXXXXX)
cleanup() { rm -f "$MANIFEST_TMP"; chmod -R u+w "$MAT" 2>/dev/null || true; rm -rf "$MAT"; }
( cd "$MAT" && find . -type f -print0 | LC_ALL=C sort -z | xargs -0 sha256sum > "$MANIFEST_TMP" ) \
  || { echo "REFUSED: the materialized tree could not be digested"; exit 1; }
{ printf 'SHA %s\n' "$SHA"; cat "$MANIFEST_TMP"; } > "$MAT/.cba-manifest"
rm -f "$MANIFEST_TMP"
chmod -R a-w "$MAT"

echo "launcher: SHA autorizado == HEAD, worktree limpa, arvore materializada do commit (somente leitura, manifesto vinculado)"
# NOT `exec`: this process owns the cleanup trap, so the private tree cannot outlive the run.
rc=0
CBA_MATERIALIZED_ROOT="$MAT" bash "$MAT/scripts/provision-release-bootstrap.sh" "$ENV_NAME" "$PHASE" || rc=$?
exit "$rc"
