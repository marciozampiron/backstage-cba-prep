#!/usr/bin/env bash
# =================================================================================================
# PROMOTE ONE cfn-exec-release SHARD TO ITS REVIEWED DOCUMENT — #111 wave-2 postmortem, r2.
#
# RUNS ONLY FROM THE MATERIALIZED TREE (review r2-F1). The operator invokes the LAUNCHER exactly
# as for the other phases — the launcher binds CBA_AUTHORIZED_SHA to a clean HEAD, materializes
# the commit's scripts/ and bootstrap inputs into a private write-stripped tree, and runs THIS
# copy from there:
#
#   (
#     set -euo pipefail
#     L=$(mktemp /tmp/cba-launch.XXXXXX); trap 'rm -f "$L"' EXIT
#     git -C <repo> show <SHA>:scripts/provision.sh > "$L"
#     CBA_REPO_ROOT=<repo> CBA_AUTHORIZED_SHA=<SHA> CBA_EXPECTED_ACCOUNT_ID=<acct> \
#       CBA_EXPECTED_OLD_DOC_SHA256=<64-hex> \
#       bash -p "$L" <dev|pilot> promote-<app|platform|guardrails>
#   )
#
# So the template promoted is the one the manifest binds to the authorized SHA — a worktree edit
# after review can never be promoted — and the account is bound and RE-CHECKED immediately before
# every mutation. Python runs `-I` everywhere; every external call is bounded by the verified
# runner; the AWS CLI is pinned to ONE attempt (review r2-F3: CreatePolicyVersion has no
# idempotency key, and the CLI's default retries would turn one authorization into up to three
# attempts on a lost response).
#
# THE PREDECESSOR IS A PRECONDITION (review r2-F2). The live default document must hash to
# CBA_EXPECTED_OLD_DOC_SHA256 — the canonical-JSON digest of the rendered predecessor named by
# the decision — or the promotion refuses with zero mutation. A live document nobody reviewed is
# not a predecessor; it is a surprise, and surprises stop.
#
# THE WHOLE TOPOLOGY IS PROVEN AT EVERY STEP (review r2-F4): normal attachments AND permissions-
# boundary usage before the create, after the create, and in the final state — where the ONE
# surviving version must be the new id, default, carrying exactly the reviewed bytes.
# =================================================================================================
set -euo pipefail
umask 077

[ "$#" -eq 2 ] || { echo "REFUSED: exactly two arguments — environment and shard"; exit 2; }
ENV_NAME="$1"
SHARD="$2"
case "$ENV_NAME" in dev|pilot) ;; *) echo "REFUSED: environment must be dev|pilot"; exit 2 ;; esac
case "$SHARD" in app|platform|guardrails) ;; *) echo "REFUSED: shard must be app|platform|guardrails"; exit 2 ;; esac

# ═══ MATERIALIZED ROOT + MANIFEST + SHA — the same guard the provisioning child runs ═══
# (Kept byte-comparable with provision-release-bootstrap.sh on purpose; a drift between the two
# guards is a review finding, not a convenience.)
MAT_ROOT="${CBA_MATERIALIZED_ROOT:-}"
[ -n "$MAT_ROOT" ] && [ -d "$MAT_ROOT" ] \
  || { echo "REFUSED: run scripts/provision.sh — this script only executes from the tree materialized out of the authorized commit"; exit 1; }
case "$MAT_ROOT" in /*) : ;; *) echo "REFUSED: the materialized root must be an absolute path"; exit 1 ;; esac
# r3-H1: the RUNNING COPY must itself be the materialized one. Without this, a worktree copy
# handed a VALID materialized root sails through the manifest guard and executes unreviewed
# bytes against reviewed templates — the exact bypass the guard exists to close.
SELF_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
[ "$SELF_ROOT" = "$MAT_ROOT" ] \
  || { echo "REFUSED: this copy is not the materialized one (run scripts/provision.sh)"; exit 1; }
SHA="${CBA_AUTHORIZED_SHA:-}"
printf '%s' "$SHA" | LC_ALL=C grep -qzE '^[0-9a-f]{40}$' \
  || { echo "REFUSED: CBA_AUTHORIZED_SHA is required (full 40-hex commit SHA)"; exit 1; }
probe_dir="$MAT_ROOT"
while : ; do
  [ -e "$probe_dir/.git" ] \
    && { echo "REFUSED: the materialized root is inside a git worktree — the worktree is exactly what must not run"; exit 1; }
  [ "$probe_dir" = "/" ] && break
  probe_dir=$(dirname "$probe_dir")
done
if find "$MAT_ROOT" -perm -u+w -print -quit | grep -q . ; then
  echo "REFUSED: the materialized tree is writable — only a write-stripped tree may promote"; exit 1
fi
MANIFEST="$MAT_ROOT/.cba-manifest"
[ -f "$MANIFEST" ] || { echo "REFUSED: the materialized tree carries no manifest"; exit 1; }
[ "$(head -n1 "$MANIFEST")" = "SHA ${SHA}" ] \
  || { echo "REFUSED: the manifest does not name the authorized SHA — this tree belongs to another authorization"; exit 1; }
if tail -n +2 "$MANIFEST" | LC_ALL=C grep -qvE '^[0-9a-f]{64}  \./[^/]'; then
  echo "REFUSED: the manifest carries a malformed or non-canonical entry"; exit 1
fi
MANIFEST_PATHS=$(tail -n +2 "$MANIFEST" | sed -E 's/^[0-9a-f]{64}  //' | LC_ALL=C sort)
ACTUAL_PATHS=$(cd "$MAT_ROOT" && find . -type f -not -name .cba-manifest | LC_ALL=C sort)
[ "$MANIFEST_PATHS" = "$ACTUAL_PATHS" ] \
  || { echo "REFUSED: the manifest path set is not exactly the tree's contents (duplicate, missing or extra path)"; exit 1; }
( cd "$MAT_ROOT" && tail -n +2 .cba-manifest | sha256sum -c --status - ) \
  || { echo "REFUSED: the materialized tree diverges from its manifest"; exit 1; }

TEMPLATE="$MAT_ROOT/infra/aws/bootstrap/policies/cfn-exec-release-${SHARD}.template.json"
BOUNDED="$MAT_ROOT/scripts/lib/bounded-run.py"
[ -f "$TEMPLATE" ] || { echo "REFUSED: the materialized tree has no reviewed template for shard ${SHARD}"; exit 1; }
[ -f "$BOUNDED" ] || { echo "REFUSED: the materialized tree has no bounded runner"; exit 1; }

OBS_T="${CBA_PROMOTE_TIMEOUT_SECONDS:-60}"
printf '%s' "$OBS_T" | LC_ALL=C grep -qzE '^[1-9][0-9]*$' && [ "$OBS_T" -le 300 ] \
  || { echo "REFUSED: CBA_PROMOTE_TIMEOUT_SECONDS must be a positive integer no greater than 300"; exit 1; }

TMP=$(mktemp -d /tmp/cba-promote.XXXXXX)
chmod 700 "$TMP"
trap 'rm -rf "$TMP"' EXIT

RUN_OUT=""; RUN_ERR=""
run_() { # bounded external command via the VERIFIED runner; $1 = deadline seconds
  local deadline="$1"; shift
  local rc=0
  python3 -I "$BOUNDED" "$deadline" "$TMP/.out" "$TMP/.err" "$@" || rc=$?
  RUN_OUT=$(cat "$TMP/.out" 2>/dev/null || true)
  RUN_ERR=$(cat "$TMP/.err" 2>/dev/null || true)
  [ "$rc" -eq 125 ] && { echo "REFUSED: processes SURVIVED the deadline kill — the result is INDETERMINATE; reconcile read-only before any new decision"; exit 1; }
  return "$rc"
}
# ONE attempt, always (r2-F3): CreatePolicyVersion is not idempotent, so a CLI retry after a lost
# response is a SECOND unauthorized mutation. The env rides EVERY call so no code path forgets it.
aws_() { run_ "$OBS_T" env AWS_MAX_ATTEMPTS=1 AWS_RETRY_MODE=standard aws --cli-connect-timeout 10 --cli-read-timeout 55 --output json --no-cli-pager "$@"; }

# ═══ ACCOUNT binding — never echoed, re-checked immediately before EVERY mutation ═══
EXPECTED="${CBA_EXPECTED_ACCOUNT_ID:-}"
printf '%s' "$EXPECTED" | LC_ALL=C grep -qzE '^[0-9]{12}$' \
  || { echo "REFUSED: CBA_EXPECTED_ACCOUNT_ID is required (12 digits, supplied outside Git); the value is not echoed"; exit 1; }
check_account() { # $1 = when
  local rc=0
  aws_ sts get-caller-identity --query Account --output text || rc=$?
  [ "$rc" -eq 0 ] || { echo "REFUSED ($1): STS identity observation failed — nothing was mutated at this step"; exit 1; }
  local got; got=$(printf '%s' "$RUN_OUT" | tr -d '[:space:]')
  printf '%s' "$got" | LC_ALL=C grep -qzE '^[0-9]{12}$' \
    || { echo "REFUSED ($1): the STS account is malformed; the value is not echoed"; exit 1; }
  [ "$got" = "$EXPECTED" ] \
    || { echo "REFUSED ($1): the ambient credentials do not belong to the authorized account; neither value is echoed"; exit 1; }
  ACCOUNT="$got"
}
check_account "binding"

case "$ENV_NAME" in dev) QUALIFIER="cbardev" ;; pilot) QUALIFIER="cbarpil" ;; esac
REGION="us-east-1"
POLICY_NAME="cba-study-coach-cfn-exec-release-${ENV_NAME}-${SHARD}"
POLICY_ARN="arn:aws:iam::${ACCOUNT}:policy/${POLICY_NAME}"
EXEC_ROLE="cdk-${QUALIFIER}-cfn-exec-role-${ACCOUNT}-${REGION}"

# The reviewed bytes, rendered EXACTLY as the provisioner renders them — from the MANIFEST-BOUND
# template, so what is promoted is what was reviewed, by construction.
sed -e "s/ACCOUNT_ID_PLACEHOLDER/${ACCOUNT}/g" \
    -e "s/ENVIRONMENT_PLACEHOLDER/${ENV_NAME}/g" \
    -e "s/QUALIFIER_PLACEHOLDER/${QUALIFIER}/g" "$TEMPLATE" > "$TMP/expected.json"
grep -q "PLACEHOLDER" "$TMP/expected.json" && { echo "REFUSED: unrendered placeholder in the reviewed template"; exit 1; }

canon_sha() { # canonical-JSON sha256 of the JSON document in file $1 (isolated python, no imports beyond stdlib)
  python3 -I -c '
import json, hashlib, sys
doc = json.load(open(sys.argv[1]))
print(hashlib.sha256(json.dumps(doc, sort_keys=True, separators=(",", ":")).encode()).hexdigest())
' "$1"
}
NEW_SHA=$(canon_sha "$TMP/expected.json")

# ═══ 1. OBSERVE: policy, single-version invariant, old document, FULL topology ═══
aws_ iam get-policy --policy-arn "$POLICY_ARN" || { echo "REFUSED: the shard policy could not be observed"; exit 1; }
printf '%s' "$RUN_OUT" > "$TMP/policy.json"
OLD_DEFAULT=$(python3 -I -c "import json,sys;print(json.load(open(sys.argv[1]))['Policy']['DefaultVersionId'])" "$TMP/policy.json")
aws_ iam list-policy-versions --policy-arn "$POLICY_ARN" || { echo "REFUSED: the version list could not be observed"; exit 1; }
VERSION_COUNT=$(printf '%s' "$RUN_OUT" | python3 -I -c "import json,sys;print(len(json.load(sys.stdin)['Versions']))")
[ "$VERSION_COUNT" = "1" ] \
  || { echo "REFUSED: expected exactly one existing version, found ${VERSION_COUNT} — the invariant is already broken; reconcile read-only before any promotion"; exit 1; }

aws_ iam get-policy-version --policy-arn "$POLICY_ARN" --version-id "$OLD_DEFAULT" \
  || { echo "REFUSED: the old default document could not be observed"; exit 1; }
printf '%s' "$RUN_OUT" > "$TMP/old-version.json"
python3 -I -c '
import json, sys, urllib.parse
doc = json.load(open(sys.argv[1]))["PolicyVersion"]["Document"]
if isinstance(doc, str):
    doc = json.loads(urllib.parse.unquote(doc))
json.dump(doc, open(sys.argv[2], "w"), sort_keys=True, separators=(",", ":"))
' "$TMP/old-version.json" "$TMP/old-doc.json"
OLD_SHA=$(canon_sha "$TMP/old-doc.json")

check_topology() { # $1 = when. Normal attachments exact AND zero boundary usage, every time.
  local rc=0
  aws_ iam list-entities-for-policy --policy-arn "$POLICY_ARN" || rc=$?
  [ "$rc" -eq 0 ] || { echo "REFUSED ($1): the attachment topology could not be observed"; exit 1; }
  printf '%s' "$RUN_OUT" > "$TMP/entities.json"
  python3 -I -c '
import json, sys
e = json.load(open(sys.argv[1]))
exec_role = sys.argv[2]
roles = [r["RoleName"] for r in e.get("PolicyRoles", [])]
if e.get("PolicyUsers") or e.get("PolicyGroups"):
    print("users-or-groups"); sys.exit(1)
if roles != [exec_role]:
    print("roles:" + ",".join(roles)); sys.exit(1)
' "$TMP/entities.json" "$EXEC_ROLE" >/dev/null \
    || { echo "REFUSED ($1): the shard must be attached as a role policy to exactly this tier's cfn-exec role — nothing else"; exit 1; }
  rc=0
  aws_ iam list-entities-for-policy --policy-arn "$POLICY_ARN" --policy-usage-filter PermissionsBoundary || rc=$?
  [ "$rc" -eq 0 ] || { echo "REFUSED ($1): the boundary-usage topology could not be observed"; exit 1; }
  local boundary
  boundary=$(printf '%s' "$RUN_OUT" | python3 -I -c "
import json, sys
e = json.load(sys.stdin)
print(len(e.get('PolicyRoles', [])) + len(e.get('PolicyUsers', [])) + len(e.get('PolicyGroups', [])))")
  [ "$boundary" = "0" ] \
    || { echo "REFUSED ($1): the shard is in use as a permissions boundary by ${boundary} principal(s) — promotion must never change a boundary"; exit 1; }
}
check_topology "observe"

# Reentrant: live already at the reviewed bytes — nothing to do, and the predecessor is moot.
if [ "$OLD_SHA" = "$NEW_SHA" ]; then
  echo "PROMOTION NOT NEEDED: ${POLICY_NAME} default ${OLD_DEFAULT} already equals the reviewed document (canonical sha256 ${NEW_SHA})"
  exit 0
fi

# ═══ 2. THE PREDECESSOR PRECONDITION (r2-F2) ═══
EXPECTED_OLD="${CBA_EXPECTED_OLD_DOC_SHA256:-}"
printf '%s' "$EXPECTED_OLD" | LC_ALL=C grep -qzE '^[0-9a-f]{64}$' \
  || { echo "REFUSED: CBA_EXPECTED_OLD_DOC_SHA256 is required (64-hex canonical digest of the rendered predecessor document, named by the decision)"; exit 1; }
[ "$OLD_SHA" = "$EXPECTED_OLD" ] || {
  echo "REFUSED: the LIVE default document is not the predecessor the decision names"
  echo "  expected predecessor: ${EXPECTED_OLD}"
  echo "  live document        : ${OLD_SHA}"
  echo "  a live document nobody reviewed is a surprise, and a surprised operation stops — zero mutation"; exit 1; }

echo "promote-exec-shard — ${POLICY_NAME}"
echo "  materialized tree verified · account bound · topology proven (role-only, zero boundary use)"
echo "  predecessor    : ${OLD_DEFAULT} (canonical sha256 ${OLD_SHA}, matches the decision)"
echo "  reviewed bytes : canonical sha256 ${NEW_SHA}"

# ═══ 3. CREATE the new default — account, topology AND predecessor re-proven IMMEDIATELY before ═
check_account "before CreatePolicyVersion"
check_topology "before CreatePolicyVersion"
# r3-M2: the state proven at observe can move while the proofs above run. The predecessor is
# re-read at the last possible boundary; the API's own gap between THIS read and the create is
# the declared, unclosable TOCTOU — everything wider than the API is closed here.
verify_predecessor() { # $1 = when
  local rc=0
  # r5-F1: the IMMUTABLE bytes are validated FIRST; the version SET is the FINAL read before
  # the mutation — so a concurrent version or a moved default during ANY earlier read is still
  # caught by the last one. Only the gap between that final list and the IAM call remains, and
  # that is the declared residual.
  rc=0
  aws_ iam get-policy-version --policy-arn "$POLICY_ARN" --version-id "$OLD_DEFAULT" || rc=$?
  [ "$rc" -eq 0 ] || { echo "REFUSED ($1): the predecessor could not be re-observed — nothing was mutated at this step"; exit 1; }
  printf '%s' "$RUN_OUT" > "$TMP/pre-recheck.json"
  python3 -I -c '
import json, sys, urllib.parse
doc = json.load(open(sys.argv[1]))["PolicyVersion"]["Document"]
if isinstance(doc, str):
    doc = json.loads(urllib.parse.unquote(doc))
json.dump(doc, open(sys.argv[2], "w"), sort_keys=True, separators=(",", ":"))
' "$TMP/pre-recheck.json" "$TMP/pre-recheck-doc.json"
  [ "$(canon_sha "$TMP/pre-recheck-doc.json")" = "$EXPECTED_OLD" ] \
    || { echo "REFUSED ($1): the live document MOVED after the first proof — a surprised operation stops; zero mutation at this step"; exit 1; }
  rc=0
  aws_ iam list-policy-versions --policy-arn "$POLICY_ARN" || rc=$?
  [ "$rc" -eq 0 ] || { echo "REFUSED ($1): the version set could not be re-observed — nothing was mutated at this step"; exit 1; }
  printf '%s' "$RUN_OUT" > "$TMP/pre-versions.json"
  python3 -I -c '
import json, sys
v = json.load(open(sys.argv[1]))["Versions"]
old = sys.argv[2]
if len(v) != 1 or v[0]["VersionId"] != old or not v[0].get("IsDefaultVersion"): sys.exit(1)
' "$TMP/pre-versions.json" "$OLD_DEFAULT" \
    || { echo "REFUSED ($1): the live version set is no longer exactly the authorized predecessor as default — a concurrent change happened; a surprised operation stops with zero mutation"; exit 1; }

}
verify_predecessor "immediately before CreatePolicyVersion"
rc=0
aws_ iam create-policy-version --policy-arn "$POLICY_ARN" \
  --policy-document "file://$TMP/expected.json" --set-as-default || rc=$?
[ "$rc" -eq 0 ] || {
  echo "HALTED at CreatePolicyVersion: the ONE attempt failed or its response was lost (no retry was made). The state is AMBIGUOUS: reconcile read-only — list the versions; if a new default exists it carries the reviewed bytes and the old ${OLD_DEFAULT} awaits verified deletion under a NEW decision."; exit 1; }
printf '%s' "$RUN_OUT" > "$TMP/new-version.json"
# r3-M3: an rc=0 response can still be malformed or truncated, and by now the mutation MAY have
# landed — a traceback here would exit without the honest record. The parser is CLOSED: object,
# PolicyVersion, a version id of the documented shape — anything else is the same ambiguous halt
# as a lost response, with no delete and no retry.
NEW_ID=$(python3 -I -c '
import json, re, sys
try:
    body = json.load(open(sys.argv[1]))
    vid = body["PolicyVersion"]["VersionId"]
except Exception:
    sys.exit(3)
if not isinstance(vid, str) or not re.fullmatch(r"v[0-9]+", vid):
    sys.exit(3)
print(vid)
' "$TMP/new-version.json") || {
  echo "HALTED after CreatePolicyVersion: the call returned success but its response is MALFORMED — the mutation may have landed. State: reconcile read-only (list the versions); ${OLD_DEFAULT} was NOT deleted; no retry was made."; exit 1; }

# ═══ 4. PROVE the new default, the reviewed bytes, and the UNMOVED topology ═══
rc=0
aws_ iam get-policy-version --policy-arn "$POLICY_ARN" --version-id "$NEW_ID" || rc=$?
[ "$rc" -eq 0 ] || { echo "HALTED after CreatePolicyVersion: read-back failed. State: ${NEW_ID} created as default, ${OLD_DEFAULT} still present. Reconcile read-only; no retry."; exit 1; }
printf '%s' "$RUN_OUT" > "$TMP/readback.json"
python3 -I -c '
import json, sys, urllib.parse
rb = json.load(open(sys.argv[1]))["PolicyVersion"]
doc = rb["Document"]
if isinstance(doc, str):
    doc = json.loads(urllib.parse.unquote(doc))
expected = json.load(open(sys.argv[2]))
if doc != expected: print("document-differs"); sys.exit(1)
if not rb.get("IsDefaultVersion"): print("not-default"); sys.exit(1)
' "$TMP/readback.json" "$TMP/expected.json" >/dev/null \
  || { echo "HALTED: the read-back of ${NEW_ID} does not prove the reviewed default — do NOT delete anything; reconcile before any further step."; exit 1; }
check_topology "after CreatePolicyVersion"

# ═══ 5. RESTORE the single-version invariant — account, topology AND the promoted state
#        re-proven at the LAST boundary before THIS mutation too (r3-M2) ═══
check_account "before DeletePolicyVersion"
check_topology "before DeletePolicyVersion"
# r5-F1: the promoted BYTES are validated first; the exact TWO-version split is the FINAL read
# before the delete — a concurrent version or a moved default during any earlier read is caught
# by the last one. Only the gap between that final list and the IAM call remains (declared).
rc=0
aws_ iam get-policy-version --policy-arn "$POLICY_ARN" --version-id "$NEW_ID" || rc=$?
[ "$rc" -eq 0 ] || { echo "REFUSED (before DeletePolicyVersion): the promoted version could not be re-observed — nothing further was mutated"; exit 1; }
printf '%s' "$RUN_OUT" > "$TMP/pre-delete.json"
python3 -I -c '
import json, sys, urllib.parse
rb = json.load(open(sys.argv[1]))["PolicyVersion"]
doc = rb["Document"]
if isinstance(doc, str):
    doc = json.loads(urllib.parse.unquote(doc))
expected = json.load(open(sys.argv[2]))
if doc != expected or not rb.get("IsDefaultVersion"): sys.exit(1)
' "$TMP/pre-delete.json" "$TMP/expected.json" \
  || { echo "REFUSED (before DeletePolicyVersion): the promoted default MOVED after its proof — the old version was NOT deleted; reconcile before any new decision"; exit 1; }
rc=0
aws_ iam list-policy-versions --policy-arn "$POLICY_ARN" || rc=$?
[ "$rc" -eq 0 ] || { echo "REFUSED (before DeletePolicyVersion): the version set could not be re-observed — nothing further was mutated"; exit 1; }
printf '%s' "$RUN_OUT" > "$TMP/pre-delete-versions.json"
python3 -I -c '
import json, sys
v = json.load(open(sys.argv[1]))["Versions"]
old, new = sys.argv[2], sys.argv[3]
by = {x["VersionId"]: bool(x.get("IsDefaultVersion")) for x in v}
if len(v) != 2 or set(by) != {old, new}: sys.exit(1)
if by[old] or not by[new]: sys.exit(1)
' "$TMP/pre-delete-versions.json" "$OLD_DEFAULT" "$NEW_ID" \
  || { echo "REFUSED (before DeletePolicyVersion): the live version set is not exactly {predecessor non-default, promoted default} — a concurrent change happened; the old version was NOT deleted; reconcile before any new decision"; exit 1; }
rc=0
aws_ iam delete-policy-version --policy-arn "$POLICY_ARN" --version-id "$OLD_DEFAULT" || rc=$?
[ "$rc" -eq 0 ] || {
  echo "HALTED at the cleanup step: ${NEW_ID} IS the proven default (the promotion itself SUCCEEDED); the old version ${OLD_DEFAULT} remains non-default and must be deleted read-verified later. No retry here."; exit 1; }

# ═══ 6. FINAL STATE: one version, it is NEW_ID, default, reviewed bytes, topology unmoved ═══
rc=0
aws_ iam list-policy-versions --policy-arn "$POLICY_ARN" || rc=$?
[ "$rc" -eq 0 ] || { echo "HALTED: the final version list could not be observed. The promotion held; reconcile read-only."; exit 1; }
printf '%s' "$RUN_OUT" > "$TMP/final-versions.json"
python3 -I -c '
import json, sys
v = json.load(open(sys.argv[1]))["Versions"]
new_id = sys.argv[2]
if len(v) != 1: print(f"count:{len(v)}"); sys.exit(1)
if v[0]["VersionId"] != new_id: print("survivor:" + v[0]["VersionId"]); sys.exit(1)
if not v[0].get("IsDefaultVersion"): print("survivor-not-default"); sys.exit(1)
' "$TMP/final-versions.json" "$NEW_ID" >/dev/null \
  || { echo "HALTED: the surviving version is not the proven new default — the promotion record above stands; reconcile the version list read-only before any new decision."; exit 1; }
rc=0
aws_ iam get-policy-version --policy-arn "$POLICY_ARN" --version-id "$NEW_ID" || rc=$?
[ "$rc" -eq 0 ] || { echo "HALTED: the final document read failed. The promotion held; reconcile read-only."; exit 1; }
printf '%s' "$RUN_OUT" > "$TMP/final-doc.json"
python3 -I -c '
import json, sys, urllib.parse
doc = json.load(open(sys.argv[1]))["PolicyVersion"]["Document"]
if isinstance(doc, str):
    doc = json.loads(urllib.parse.unquote(doc))
expected = json.load(open(sys.argv[2]))
sys.exit(0 if doc == expected else 1)
' "$TMP/final-doc.json" "$TMP/expected.json" \
  || { echo "HALTED: the FINAL document differs from the reviewed bytes — reconcile before any new decision."; exit 1; }
check_topology "final"

echo "PROMOTED: ${POLICY_NAME} ${OLD_DEFAULT} -> ${NEW_ID} (default proven, reviewed bytes proven, single survivor proven, topology role-only and boundary-free at observe/create/final)"
