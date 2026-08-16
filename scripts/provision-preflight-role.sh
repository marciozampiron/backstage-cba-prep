#!/usr/bin/env bash
# Operator-managed provisioning of the release-preflight role (#111, round 3) — Zamp runs this.
# VALIDATE-BEFORE-MUTATE: a pre-existing role has its trust, boundary, inline and managed
# policies verified SEMANTICALLY against the rendered templates BEFORE any put; divergence
# refuses with zero mutation. The role carries a versioned permissions BOUNDARY that permits
# only cognito-idp:DescribeUserPoolDomain — the durable limiter: a policy attached later can
# never exceed it. Full read-back precedes the ARN print. Never prints the account id.
set -euo pipefail
ENV_NAME="${1:?usage: provision-preflight-role.sh dev|pilot}"
case "$ENV_NAME" in dev|pilot) : ;; *) echo "REFUSED: environment must be dev or pilot"; exit 1 ;; esac
ROLE="cba-study-coach-gha-release-preflight-${ENV_NAME}"
POLICY_NAME="cba-study-coach-preflight-readonly-${ENV_NAME}"
BOUNDARY_NAME="cba-study-coach-boundary-preflight-${ENV_NAME}"
DIR="$(cd "$(dirname "$0")/.." && pwd)/infra/aws/bootstrap/policies"
ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
BOUNDARY_ARN="arn:aws:iam::${ACCOUNT}:policy/${BOUNDARY_NAME}"

render() { sed -e "s/ACCOUNT_ID_PLACEHOLDER/${ACCOUNT}/g" -e "s/ENVIRONMENT_PLACEHOLDER/${ENV_NAME}/g" "$1"; }
TRUST=$(render "$DIR/preflight-role-trust.template.json")
POLICY_DOC=$(cat "$DIR/preflight-role-policy.template.json")
BOUNDARY_DOC=$(cat "$DIR/preflight-role-boundary.template.json")
for v in "$TRUST" "$POLICY_DOC" "$BOUNDARY_DOC"; do
  grep -q "PLACEHOLDER" <<<"$v" && { echo "REFUSED: unrendered placeholder"; exit 1; }
done

# Semantic equality: full canonical documents, closed — not a field probe.
same_doc() { python3 -c '
import json, sys
def canon(x):
    if isinstance(x, dict): return {k: canon(v) for k, v in sorted(x.items())}
    if isinstance(x, list): return [canon(v) for v in x]
    return x
a, b = (json.loads(sys.argv[1]), json.loads(sys.argv[2]))
sys.exit(0 if canon(a) == canon(b) else 1)' "$1" "$2"; }

# ── the BOUNDARY first: exists+equal, or created; divergence refuses with zero mutation ──
if aws iam get-policy --policy-arn "$BOUNDARY_ARN" >/dev/null 2>&1; then
  VER=$(aws iam get-policy --policy-arn "$BOUNDARY_ARN" --query 'Policy.DefaultVersionId' --output text)
  GOT_B=$(aws iam get-policy-version --policy-arn "$BOUNDARY_ARN" --version-id "$VER" --query 'PolicyVersion.Document' --output json)
  same_doc "$GOT_B" "$BOUNDARY_DOC" || { echo "REFUSED: the existing boundary diverges from the reviewed template — zero mutation performed"; exit 1; }
else
  aws iam create-policy --policy-name "$BOUNDARY_NAME" --policy-document "$BOUNDARY_DOC" >/dev/null
  echo "boundary criada: $BOUNDARY_NAME"
fi

validate_role() { # full semantic verification of an EXISTING role; refuses on any divergence
  local when="$1"
  local got_trust got_boundary inline attached got_policy
  got_trust=$(aws iam get-role --role-name "$ROLE" --query 'Role.AssumeRolePolicyDocument' --output json)
  same_doc "$got_trust" "$TRUST" || { echo "REFUSED (${when}): the role's trust diverges from the reviewed template — zero mutation performed"; exit 1; }
  got_boundary=$(aws iam get-role --role-name "$ROLE" --query 'Role.PermissionsBoundary.PermissionsBoundaryArn' --output text)
  [ "$got_boundary" = "$BOUNDARY_ARN" ] || { echo "REFUSED (${when}): the role's permissions boundary is absent or diverges — zero mutation performed"; exit 1; }
  attached=$(aws iam list-attached-role-policies --role-name "$ROLE" --query 'AttachedPolicies' --output json)
  [ "$(printf '%s' "$attached" | jq -r 'length')" = "0" ] || { echo "REFUSED (${when}): managed policies are attached beyond the reviewed unit — zero mutation performed"; exit 1; }
  inline=$(aws iam list-role-policies --role-name "$ROLE" --query 'PolicyNames' --output json)
  case "$(printf '%s' "$inline" | jq -r 'sort | join(",")')" in
    "") : ;;
    "$POLICY_NAME")
      got_policy=$(aws iam get-role-policy --role-name "$ROLE" --policy-name "$POLICY_NAME" --query 'PolicyDocument' --output json)
      same_doc "$got_policy" "$POLICY_DOC" || { echo "REFUSED (${when}): the inline policy diverges from the reviewed template — zero mutation performed"; exit 1; } ;;
    *) echo "REFUSED (${when}): unexpected inline policies on the role — zero mutation performed"; exit 1 ;;
  esac
}

if aws iam get-role --role-name "$ROLE" >/dev/null 2>&1; then
  validate_role "pre-existing role, BEFORE any change"
else
  aws iam create-role --role-name "$ROLE" --assume-role-policy-document "$TRUST" \
    --permissions-boundary "$BOUNDARY_ARN" \
    --description "Read-only release preflight (${ENV_NAME}) — cognito-idp:DescribeUserPoolDomain only" >/dev/null
  echo "role criado: $ROLE (com boundary)"
fi
aws iam put-role-policy --role-name "$ROLE" --policy-name "$POLICY_NAME" --policy-document "$POLICY_DOC"
validate_role "read-back, AFTER provisioning"
INLINE_COUNT=$(aws iam list-role-policies --role-name "$ROLE" --query 'PolicyNames' --output json | jq -r 'length')
[ "$INLINE_COUNT" = "1" ] || { echo "REFUSED: exactly ONE inline policy must exist after provisioning"; exit 1; }
ARN=$(aws iam get-role --role-name "$ROLE" --query 'Role.Arn' --output text)
echo "READ-BACK OK: trust semanticamente igual, boundary pinada, 1 inline exata, 0 managed"
echo "ARN (mascarado): $(printf '%s' "$ARN" | sed -E 's/[0-9]{12}/ACCOUNT/g')"
echo "Instale o secret: gh secret set AWS_DEPLOY_PREFLIGHT_ROLE_ARN --env ${ENV_NAME} --repo marciozampiron/backstage-cba-prep --body \"\$(aws iam get-role --role-name ${ROLE} --query Role.Arn --output text)\""
