#!/usr/bin/env bash
# Operator-managed provisioning of the release-preflight role (#111, round 4) — Zamp runs this.
# OBSERVE-THEN-ACT: the expected account binds first (CBA_EXPECTED_ACCOUNT_ID, supplied outside
# Git, never echoed); then boundary AND role are fully observed — a read that fails for any
# reason other than a PROVEN NoSuchEntity refuses as an observation failure, never as absence.
# Only the provably fresh path may create; a pre-existing role with ANY divergence (an absent
# boundary included) refuses with zero mutation. The boundary is the durable limiter.
set -euo pipefail
ENV_NAME="${1:?usage: provision-preflight-role.sh dev|pilot}"
case "$ENV_NAME" in dev|pilot) : ;; *) echo "REFUSED: environment must be dev or pilot"; exit 1 ;; esac
ROLE="cba-study-coach-gha-release-preflight-${ENV_NAME}"
POLICY_NAME="cba-study-coach-preflight-readonly-${ENV_NAME}"
BOUNDARY_NAME="cba-study-coach-boundary-preflight-${ENV_NAME}"
DIR="$(cd "$(dirname "$0")/.." && pwd)/infra/aws/bootstrap/policies"

# ── the ACCOUNT binds before any IAM call; neither value is ever echoed ──
EXPECTED="${CBA_EXPECTED_ACCOUNT_ID:-}"
printf '%s' "$EXPECTED" | LC_ALL=C grep -qzE '^[0-9]{12}$' \
  || { echo "REFUSED: CBA_EXPECTED_ACCOUNT_ID is required (12 digits, supplied outside Git); the value is not echoed"; exit 1; }
ACCOUNT=$(aws sts get-caller-identity --query Account --output text 2>/dev/null) \
  || { echo "REFUSED: STS identity observation failed — nothing was mutated"; exit 1; }
printf '%s' "$ACCOUNT" | LC_ALL=C grep -qzE '^[0-9]{12}$' \
  || { echo "REFUSED: the STS account is malformed; the value is not echoed"; exit 1; }
[ "$ACCOUNT" = "$EXPECTED" ] \
  || { echo "REFUSED: the ambient credentials do not belong to the authorized account; neither value is echoed"; exit 1; }
BOUNDARY_ARN="arn:aws:iam::${ACCOUNT}:policy/${BOUNDARY_NAME}"

render() { sed -e "s/ACCOUNT_ID_PLACEHOLDER/${ACCOUNT}/g" -e "s/ENVIRONMENT_PLACEHOLDER/${ENV_NAME}/g" "$1"; }
TRUST=$(render "$DIR/preflight-role-trust.template.json")
POLICY_DOC=$(cat "$DIR/preflight-role-policy.template.json")
BOUNDARY_DOC=$(cat "$DIR/preflight-role-boundary.template.json")
for v in "$TRUST" "$POLICY_DOC" "$BOUNDARY_DOC"; do
  grep -q "PLACEHOLDER" <<<"$v" && { echo "REFUSED: unrendered placeholder"; exit 1; }
done
same_doc() { python3 -c '
import json, sys
def canon(x):
    if isinstance(x, dict): return {k: canon(v) for k, v in sorted(x.items())}
    if isinstance(x, list): return [canon(v) for v in x]
    return x
a, b = (json.loads(sys.argv[1]), json.loads(sys.argv[2]))
sys.exit(0 if canon(a) == canon(b) else 1)' "$1" "$2"; }

# ── observe(kind): EXISTS with output, ABSENT only on proven NoSuchEntity, else REFUSE ──
observe() { # $1 = description, rest = aws args; sets OBS_STATE + OBS_OUT
  local desc="$1"; shift
  local out rc
  set +e
  out=$("$@" 2>&1)
  rc=$?
  set -e
  if [ "$rc" -eq 0 ]; then OBS_STATE=EXISTS; OBS_OUT="$out"; return 0; fi
  if grep -q "NoSuchEntity" <<<"$out"; then OBS_STATE=ABSENT; OBS_OUT=""; return 0; fi
  echo "REFUSED: observation of ${desc} failed (not a proven absence) — nothing was mutated"; exit 1
}

# ── OBSERVE EVERYTHING before any decision ──
observe "the boundary policy" aws iam get-policy --policy-arn "$BOUNDARY_ARN" --output json
B_STATE="$OBS_STATE"
if [ "$B_STATE" = "EXISTS" ]; then
  VER=$(printf '%s' "$OBS_OUT" | python3 -c 'import json,sys; print(json.load(sys.stdin)["Policy"]["DefaultVersionId"])')
  observe "the boundary document" aws iam get-policy-version --policy-arn "$BOUNDARY_ARN" --version-id "$VER" --output json
  [ "$OBS_STATE" = "EXISTS" ] || { echo "REFUSED: the boundary exists but its document could not be read"; exit 1; }
  GOT_B=$(printf '%s' "$OBS_OUT" | python3 -c 'import json,sys; print(json.dumps(json.load(sys.stdin)["PolicyVersion"]["Document"]))')
  same_doc "$GOT_B" "$BOUNDARY_DOC" || { echo "REFUSED: the existing boundary diverges from the reviewed template — zero mutation performed"; exit 1; }
fi
observe "the role" aws iam get-role --role-name "$ROLE" --output json
R_STATE="$OBS_STATE"; ROLE_JSON="$OBS_OUT"

validate_role_reads() { # full semantic verification via fresh reads; refuses on ANY divergence
  # $2 = contract: "pre" may accept an empty inline set (nothing installed yet); "post" REQUIRES
  # exactly the reviewed policy present — a put that reported success but materialized nothing
  # is a failed provisioning, never READ-BACK OK.
  local when="$1"
  local contract="${2:?contract pre|post}"
  local got_trust got_boundary attached inline got_policy
  got_trust=$(printf '%s' "$ROLE_JSON" | python3 -c 'import json,sys; print(json.dumps(json.load(sys.stdin)["Role"]["AssumeRolePolicyDocument"]))')
  same_doc "$got_trust" "$TRUST" || { echo "REFUSED (${when}): the role's trust diverges from the reviewed template — zero mutation performed"; exit 1; }
  got_boundary=$(printf '%s' "$ROLE_JSON" | python3 -c 'import json,sys; r=json.load(sys.stdin)["Role"]; print(r.get("PermissionsBoundary",{}).get("PermissionsBoundaryArn",""))')
  [ "$got_boundary" = "$BOUNDARY_ARN" ] || { echo "REFUSED (${when}): the role's permissions boundary is absent or diverges — zero mutation performed"; exit 1; }
  [ "$B_STATE" = "EXISTS" ] || { echo "REFUSED (${when}): the role exists but its boundary policy does not — a contaminated composition; zero mutation performed"; exit 1; }
  observe "attached policies" aws iam list-attached-role-policies --role-name "$ROLE" --output json
  attached="$OBS_OUT"
  [ "$(printf '%s' "$attached" | python3 -c 'import json,sys; print(len(json.load(sys.stdin)["AttachedPolicies"]))')" = "0" ] \
    || { echo "REFUSED (${when}): managed policies are attached beyond the reviewed unit — zero mutation performed"; exit 1; }
  observe "inline policies" aws iam list-role-policies --role-name "$ROLE" --output json
  inline=$(printf '%s' "$OBS_OUT" | python3 -c 'import json,sys; print(",".join(sorted(json.load(sys.stdin)["PolicyNames"])))')
  case "$inline" in
    "")
      [ "$contract" = "pre" ] || { echo "REFUSED (${when}): the put reported success but the inline policy is NOT present — post-mutation requires exactly the reviewed policy"; exit 1; } ;;
    "$POLICY_NAME")
      observe "the inline policy document" aws iam get-role-policy --role-name "$ROLE" --policy-name "$POLICY_NAME" --output json
      got_policy=$(printf '%s' "$OBS_OUT" | python3 -c 'import json,sys; print(json.dumps(json.load(sys.stdin)["PolicyDocument"]))')
      same_doc "$got_policy" "$POLICY_DOC" || { echo "REFUSED (${when}): the inline policy diverges from the reviewed template — zero mutation performed"; exit 1; } ;;
    *) echo "REFUSED (${when}): unexpected inline policies on the role — zero mutation performed"; exit 1 ;;
  esac
}

if [ "$R_STATE" = "EXISTS" ]; then
  # A pre-existing role: EVERYTHING validates before any mutation — the absent-boundary
  # composition refuses here, before any create-policy could run.
  validate_role_reads "pre-existing role, BEFORE any change" pre
else
  # Provably fresh (NoSuchEntity proven): only now may the boundary be created.
  if [ "$B_STATE" = "ABSENT" ]; then
    aws iam create-policy --policy-name "$BOUNDARY_NAME" --policy-document "$BOUNDARY_DOC" >/dev/null
    echo "boundary criada: $BOUNDARY_NAME"
  fi
  aws iam create-role --role-name "$ROLE" --assume-role-policy-document "$TRUST" \
    --permissions-boundary "$BOUNDARY_ARN" \
    --description "Read-only release preflight (${ENV_NAME}) - cognito-idp:DescribeUserPoolDomain only" >/dev/null
  echo "role criado: $ROLE (com boundary)"
fi
aws iam put-role-policy --role-name "$ROLE" --policy-name "$POLICY_NAME" --policy-document "$POLICY_DOC"
observe "the role (read-back)" aws iam get-role --role-name "$ROLE" --output json
[ "$OBS_STATE" = "EXISTS" ] || { echo "REFUSED: the role vanished during provisioning"; exit 1; }
ROLE_JSON="$OBS_OUT"; B_STATE=EXISTS
validate_role_reads "read-back, AFTER provisioning" post
ARN=$(printf '%s' "$ROLE_JSON" | python3 -c 'import json,sys; print(json.load(sys.stdin)["Role"]["Arn"])')
# The VALIDATED ARN travels as exact bytes in a 0600 file — the install command consumes those
# bytes and never re-reads AWS, so a credential swap after the read-back cannot substitute a
# same-named role from another account.
ARN_FILE=$(mktemp /tmp/cba-preflight-arn.XXXXXX)
chmod 600 "$ARN_FILE"
printf '%s' "$ARN" > "$ARN_FILE"
echo "READ-BACK OK: conta vinculada, trust semanticamente igual, boundary pinada, 1 inline exata, 0 managed"
echo "ARN (mascarado): $(printf '%s' "$ARN" | sed -E 's/[0-9]{12}/ACCOUNT/g')"
echo "ARN validado gravado (0600, bytes exatos do read-back): $ARN_FILE"
echo "Instale o secret com EXATAMENTE estes bytes — nenhuma releitura AWS:"
echo "  gh secret set AWS_DEPLOY_PREFLIGHT_ROLE_ARN --env ${ENV_NAME} --repo marciozampiron/backstage-cba-prep --body \"\$(cat ${ARN_FILE})\""
