#!/usr/bin/env bash
# =================================================================================================
# PROMOTE ONE cfn-exec-release SHARD TO ITS REVIEWED DOCUMENT — #111 wave-2 postmortem (Codex B).
#
# The shard policies are ATTACHED to the live cdk cfn-exec role and their ARNs are pinned in the
# bootstrap, so delete/recreate would race everything that resolves them. The reviewed path is
# CreatePolicyVersion --set-as-default: the new default applies atomically to every attached
# principal, the old version is deleted only AFTER the new one is proven, and the tier's invariant
# of EXACTLY ONE version is restored at the end.
#
# Operator-managed: Zamp runs this locally, under his own credentials, one shard per invocation,
# under the decision that authorizes it. Every step observes before it acts; any surprise HALTS
# with the state on record — never a retry, never a guess.
#
#   usage: promote-exec-shard.sh <dev|pilot> <app|platform|guardrails>
#
# Steps (each fail-closed):
#   1. OBSERVE   account; policy identity; old default version id; old document EXACT; consumers.
#   2. REQUIRE   attached as a ROLE policy to exactly this tier's cdk cfn-exec role — nothing
#                else, and NEVER in use as a permissions boundary.
#   3. CREATE    the new version from the REVIEWED rendered bytes, --set-as-default.
#   4. PROVE     re-read: the new default document equals the reviewed bytes canonically, and the
#                consumer set did not move.
#   5. RESTORE   delete the old, now non-default version — exactly one version remains.
#   6. On any partial failure: STOP. The record printed so far is the state; nothing retries.
# =================================================================================================
set -euo pipefail

ENV_NAME="${1:-}"
SHARD="${2:-}"
case "$ENV_NAME" in dev|pilot) ;; *) echo "REFUSED: environment must be dev|pilot"; exit 2 ;; esac
case "$SHARD" in app|platform|guardrails) ;; *) echo "REFUSED: shard must be app|platform|guardrails"; exit 2 ;; esac

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
TEMPLATE="$REPO_ROOT/infra/aws/bootstrap/policies/cfn-exec-release-${SHARD}.template.json"
[ -f "$TEMPLATE" ] || { echo "REFUSED: reviewed template not found: $TEMPLATE"; exit 1; }

case "$ENV_NAME" in dev) QUALIFIER="cbardev" ;; pilot) QUALIFIER="cbarpil" ;; esac
REGION="us-east-1"
POLICY_NAME="cba-study-coach-cfn-exec-release-${ENV_NAME}-${SHARD}"
ROLE_NAME_SUFFIX="cfn-exec-role"

aws_() { aws "$@" --output json --no-cli-pager --cli-connect-timeout 5 --cli-read-timeout 20; }

TMP=$(mktemp -d /tmp/cba-promote-shard.XXXXXX)
chmod 700 "$TMP"
cleanup() { rm -rf "$TMP"; }
trap cleanup EXIT

# --- 1. OBSERVE ----------------------------------------------------------------------------------
ACCOUNT=$(aws_ sts get-caller-identity | python3 -c "import json,sys;print(json.load(sys.stdin)['Account'])")
[[ "$ACCOUNT" =~ ^[0-9]{12}$ ]] || { echo "REFUSED: account did not resolve"; exit 1; }
POLICY_ARN="arn:aws:iam::${ACCOUNT}:policy/${POLICY_NAME}"
EXEC_ROLE="cdk-${QUALIFIER}-${ROLE_NAME_SUFFIX}-${ACCOUNT}-${REGION}"

# The reviewed bytes this promotion installs — rendered EXACTLY as the provisioner renders them.
sed -e "s/ACCOUNT_ID_PLACEHOLDER/${ACCOUNT}/g" \
    -e "s/ENVIRONMENT_PLACEHOLDER/${ENV_NAME}/g" \
    -e "s/QUALIFIER_PLACEHOLDER/${QUALIFIER}/g" "$TEMPLATE" > "$TMP/expected.json"
grep -q "PLACEHOLDER" "$TMP/expected.json" && { echo "REFUSED: unrendered placeholder in the reviewed template"; exit 1; }

aws_ iam get-policy --policy-arn "$POLICY_ARN" > "$TMP/policy.json"
OLD_DEFAULT=$(python3 -c "import json;p=json.load(open('$TMP/policy.json'))['Policy'];print(p['DefaultVersionId'])")
VERSION_COUNT=$(aws_ iam list-policy-versions --policy-arn "$POLICY_ARN" | python3 -c "import json,sys;print(len(json.load(sys.stdin)['Versions']))")
[ "$VERSION_COUNT" = "1" ] || { echo "REFUSED: expected exactly one existing version, found ${VERSION_COUNT} — the invariant is already broken; reconcile read-only before any promotion"; exit 1; }

aws_ iam get-policy-version --policy-arn "$POLICY_ARN" --version-id "$OLD_DEFAULT" > "$TMP/old-version.json"
python3 - "$TMP" <<'PY'
import json, sys, urllib.parse
tmp = sys.argv[1]
doc = json.load(open(f'{tmp}/old-version.json'))['PolicyVersion']['Document']
if isinstance(doc, str):
    doc = json.loads(urllib.parse.unquote(doc))
json.dump(doc, open(f'{tmp}/old-doc.json', 'w'), sort_keys=True)
PY
OLD_SHA=$(sha256sum "$TMP/old-doc.json" | cut -d' ' -f1)

# --- 2. REQUIRE the consumer set ----------------------------------------------------------------
aws_ iam list-entities-for-policy --policy-arn "$POLICY_ARN" > "$TMP/entities.json"
python3 - "$TMP" "$EXEC_ROLE" <<'PY'
import json, sys
tmp, exec_role = sys.argv[1], sys.argv[2]
e = json.load(open(f'{tmp}/entities.json'))
roles = [r['RoleName'] for r in e.get('PolicyRoles', [])]
users = e.get('PolicyUsers', [])
groups = e.get('PolicyGroups', [])
if users or groups:
    print(f'REFUSED: the shard is attached to users/groups ({len(users)}/{len(groups)}) — that is not the reviewed topology'); sys.exit(1)
if roles != [exec_role]:
    print(f'REFUSED: the shard must be attached to exactly [{exec_role}], found {roles}'); sys.exit(1)
PY
# Never in use as a permissions boundary, by anyone.
BOUNDARY_USERS=$(aws_ iam list-entities-for-policy --policy-arn "$POLICY_ARN" --policy-usage-filter PermissionsBoundary | python3 -c "
import json,sys
e=json.load(sys.stdin)
print(len(e.get('PolicyRoles',[]))+len(e.get('PolicyUsers',[]))+len(e.get('PolicyGroups',[])))")
[ "$BOUNDARY_USERS" = "0" ] || { echo "REFUSED: the shard is in use as a permissions boundary by ${BOUNDARY_USERS} principal(s) — promotion would change a boundary, which this instrument must never do"; exit 1; }

# Already at the reviewed document? Then this promotion is a no-op and says so (reentrant).
if python3 - "$TMP" <<'PY'
import json, sys
tmp = sys.argv[1]
old = json.load(open(f'{tmp}/old-doc.json'))
new = json.load(open(f'{tmp}/expected.json'))
sys.exit(0 if old == new else 1)
PY
then
  echo "PROMOTION NOT NEEDED: ${POLICY_NAME} default ${OLD_DEFAULT} already equals the reviewed document (sha256 ${OLD_SHA})"
  exit 0
fi

echo "promote-exec-shard — ${POLICY_NAME}"
echo "  account verified · role consumer: ${EXEC_ROLE} · boundary consumers: 0"
echo "  old default    : ${OLD_DEFAULT} (sha256 ${OLD_SHA})"
echo "  reviewed bytes : sha256 $(python3 -c "import json,hashlib;print(hashlib.sha256(json.dumps(json.load(open('$TMP/expected.json')),sort_keys=True).encode()).hexdigest())")"

# --- 3. CREATE the new default version ----------------------------------------------------------
aws_ iam create-policy-version --policy-arn "$POLICY_ARN" \
  --policy-document "file://$TMP/expected.json" --set-as-default > "$TMP/new-version.json" || {
  echo "HALTED at CreatePolicyVersion: the call failed. State: old default ${OLD_DEFAULT} untouched (verify read-only). No retry."; exit 1; }
NEW_ID=$(python3 -c "import json;print(json.load(open('$TMP/new-version.json'))['PolicyVersion']['VersionId'])")

# --- 4. PROVE the new default and the unmoved consumers -----------------------------------------
aws_ iam get-policy-version --policy-arn "$POLICY_ARN" --version-id "$NEW_ID" > "$TMP/readback.json" || {
  echo "HALTED after CreatePolicyVersion: read-back failed. State: ${NEW_ID} created as default, ${OLD_DEFAULT} still present. Reconcile read-only; no retry."; exit 1; }
python3 - "$TMP" <<'PY' || { echo "HALTED: the read-back document DIFFERS from the reviewed bytes. State: ${NEW_ID:-new} is default and WRONG — do not delete anything; reconcile before any further step."; exit 1; }
import json, sys, urllib.parse
tmp = sys.argv[1]
doc = json.load(open(f'{tmp}/readback.json'))['PolicyVersion']['Document']
if isinstance(doc, str):
    doc = json.loads(urllib.parse.unquote(doc))
expected = json.load(open(f'{tmp}/expected.json'))
sys.exit(0 if doc == expected else 1)
PY
IS_DEFAULT=$(python3 -c "import json;print(json.load(open('$TMP/readback.json'))['PolicyVersion']['IsDefaultVersion'])")
[ "$IS_DEFAULT" = "True" ] || { echo "HALTED: ${NEW_ID} exists but is NOT the default. State on record; reconcile before any further step."; exit 1; }
aws_ iam list-entities-for-policy --policy-arn "$POLICY_ARN" > "$TMP/entities-after.json"
python3 - "$TMP" "$EXEC_ROLE" <<'PY' || { echo "HALTED: the consumer set MOVED during the promotion. State on record; reconcile before any further step."; exit 1; }
import json, sys
tmp, exec_role = sys.argv[1], sys.argv[2]
e = json.load(open(f'{tmp}/entities-after.json'))
roles = [r['RoleName'] for r in e.get('PolicyRoles', [])]
sys.exit(0 if roles == [exec_role] and not e.get('PolicyUsers') and not e.get('PolicyGroups') else 1)
PY

# --- 5. RESTORE the single-version invariant ----------------------------------------------------
aws_ iam delete-policy-version --policy-arn "$POLICY_ARN" --version-id "$OLD_DEFAULT" || {
  echo "HALTED at the cleanup step: ${NEW_ID} IS the proven default (the promotion itself SUCCEEDED); the old version ${OLD_DEFAULT} remains non-default and must be deleted read-verified later. No retry here."; exit 1; }
REMAINING=$(aws_ iam list-policy-versions --policy-arn "$POLICY_ARN" | python3 -c "import json,sys;v=json.load(sys.stdin)['Versions'];print(len(v))")
[ "$REMAINING" = "1" ] || { echo "HALTED: expected exactly one remaining version, found ${REMAINING}. The promotion held; reconcile the version list read-only."; exit 1; }

echo "PROMOTED: ${POLICY_NAME} ${OLD_DEFAULT} -> ${NEW_ID} (default, proven, consumers unchanged, single-version invariant restored)"
