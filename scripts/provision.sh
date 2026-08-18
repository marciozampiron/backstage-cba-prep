#!/usr/bin/env bash
# THE LAUNCHER (#111 r5-F1) — the only supported way to run the release-bootstrap provisioning.
#
# WHY IT EXISTS. A script cannot verify itself: bytes at the top of the file have already run by
# the time any integrity check appears, and helpers compared on disk can be swapped between the
# comparison and the execution (TOCTOU). This launcher removes both by never running the
# worktree's copies at all: it MATERIALIZES the authorized commit's `scripts/` and
# `infra/aws/bootstrap/` into a private, write-stripped directory with `git archive` — one atomic
# extraction, no per-file compare — and execs the provisioning script FROM THERE. Every byte the
# provisioning run then reads or executes came out of the commit, and the worktree can change
# underneath without affecting the run.
#
# THE ROOT OF TRUST, STATED PLAINLY: this launcher's own bytes are not self-verified — nothing can
# do that from inside. What bounds the residual is that this file is deliberately tiny and does
# exactly one thing (materialize, then exec), so the operator can read it whole before running it,
# and `git status` + the SHA binding below prove the worktree it materializes from is the reviewed
# commit. An unforgeable answer needs signed artifacts and remote enforcement (#91 Stage B); until
# then this is a declared residual, not a solved problem.
#
# usage: CBA_EXPECTED_ACCOUNT_ID=<12 digits> CBA_AUTHORIZED_SHA=<40 hex> \
#          bash scripts/provision.sh <dev|pilot> <policies|bootstrap>
set -euo pipefail
umask 077

ENV_NAME="${1:?usage: provision.sh dev|pilot policies|bootstrap}"
PHASE="${2:?usage: provision.sh dev|pilot policies|bootstrap}"
[ "$#" -eq 2 ] || { echo "REFUSED: exactly two arguments — environment and phase"; exit 1; }
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
GIT_T="${CBA_GIT_TIMEOUT_SECONDS:-60}"
printf '%s' "$GIT_T" | LC_ALL=C grep -qzE '^[1-9][0-9]*$' && [ "$GIT_T" -le 300 ] \
  || { echo "REFUSED: CBA_GIT_TIMEOUT_SECONDS must be a positive integer no greater than 300 — zero would disable the deadline"; exit 1; }

# Every git probe's EXIT STATUS is captured and validated BEFORE its output is interpreted
# (r5-F2): a failed `status` produces no output, and empty output must never read as "clean";
# a failed `ls-files` must never read as "no shadow files". `timeout` is the mechanism here —
# these are read-only local git calls, and the bounded runner lives in the tree they are about
# to prove.
git_() { timeout --kill-after=5 "$GIT_T" git -C "$REPO_ROOT" "$@"; }
probe() { # $1 = description; rest = git args. Sets PROBE_OUT. Refuses on ANY nonzero/timeout.
  local desc="$1"; shift
  local rc=0
  PROBE_OUT=$(git_ "$@" 2>/dev/null) || rc=$?
  [ "$rc" -eq 124 ] || [ "$rc" -eq 137 ] \
    && { echo "REFUSED: the git probe for ${desc} exceeded its deadline — nothing ran"; exit 1; }
  [ "$rc" -eq 0 ] \
    || { echo "REFUSED: the git probe for ${desc} failed (status ${rc}) — a failed probe is never a clean answer; nothing ran"; exit 1; }
}

SHA="${CBA_AUTHORIZED_SHA:-}"
printf '%s' "$SHA" | LC_ALL=C grep -qzE '^[0-9a-f]{40}$' \
  || { echo "REFUSED: CBA_AUTHORIZED_SHA is required (full 40-hex commit SHA)"; exit 1; }
probe "HEAD" rev-parse HEAD
[ "$PROBE_OUT" = "$SHA" ] \
  || { echo "REFUSED: HEAD does not match CBA_AUTHORIZED_SHA — run from the authorized commit"; exit 1; }
probe "the worktree state" status --porcelain
[ -z "$PROBE_OUT" ] \
  || { echo "REFUSED: the worktree is dirty — the authorized SHA must be the whole story"; exit 1; }

# MATERIALIZE: one extraction of the authorized commit's executable and reviewed inputs. The
# extracted tree is private (0700) and write-stripped, and it — not the worktree — is what runs.
MAT=$(mktemp -d /tmp/cba-relboot-src.XXXXXX)
chmod 700 "$MAT"
trap 'chmod -R u+w "$MAT" 2>/dev/null || true; rm -rf "$MAT"' EXIT
rc=0
git_ archive --format=tar "$SHA" scripts infra/aws/bootstrap 2>/dev/null | tar -x -C "$MAT" || rc=$?
[ "$rc" -eq 0 ] \
  || { echo "REFUSED: the authorized commit's scripts and bootstrap inputs could not be materialized"; exit 1; }
[ -f "$MAT/scripts/provision-release-bootstrap.sh" ] && [ -f "$MAT/scripts/lib/bounded-run.py" ] \
  || { echo "REFUSED: the materialized tree is incomplete"; exit 1; }
chmod -R a-w "$MAT"

echo "launcher: SHA autorizado == HEAD, worktree limpa, arvore materializada do commit (somente leitura)"
CBA_MATERIALIZED_ROOT="$MAT" exec bash "$MAT/scripts/provision-release-bootstrap.sh" "$ENV_NAME" "$PHASE"
