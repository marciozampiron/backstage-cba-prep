#!/usr/bin/env bash
# Operator-managed provisioning of the dev release-preflight role (#111) — Zamp runs this.
# Renders the reviewed templates, creates the role under its EXACT canonical name, attaches
# ONLY the reviewed single-action policy, then READS BACK fail-closed: name, trust, policy
# count and content, and the absence of any additional grant — before ever printing the ARN
# that becomes AWS_DEPLOY_PREFLIGHT_ROLE_ARN. Never prints the account id.
set -euo pipefail
ENV_NAME="${1:?usage: provision-preflight-role.sh dev|pilot}"
case "$ENV_NAME" in dev|pilot) : ;; *) echo "REFUSED: environment must be dev or pilot"; exit 1 ;; esac
ROLE="cba-study-coach-gha-release-preflight-${ENV_NAME}"
POLICY_NAME="cba-study-coach-preflight-readonly-${ENV_NAME}"
DIR="$(cd "$(dirname "$0")/.." && pwd)/infra/aws/bootstrap/policies"
ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
TRUST=$(sed -e "s/ACCOUNT_ID_PLACEHOLDER/${ACCOUNT}/g" -e "s/ENVIRONMENT_PLACEHOLDER/${ENV_NAME}/g" "$DIR/preflight-role-trust.template.json")
grep -q "PLACEHOLDER" <<<"$TRUST" && { echo "REFUSED: unrendered placeholder in trust"; exit 1; }
POLICY_DOC=$(cat "$DIR/preflight-role-policy.template.json")
grep -q "PLACEHOLDER" <<<"$POLICY_DOC" && { echo "REFUSED: unrendered placeholder in policy"; exit 1; }

if ! aws iam get-role --role-name "$ROLE" >/dev/null 2>&1; then
  aws iam create-role --role-name "$ROLE" --assume-role-policy-document "$TRUST" \
    --description "Read-only release preflight (${ENV_NAME}) — cognito-idp:DescribeUserPoolDomain only" >/dev/null
  echo "role criado: $ROLE"
else
  echo "role já existe: $ROLE — seguindo para verificação"
fi
aws iam put-role-policy --role-name "$ROLE" --policy-name "$POLICY_NAME" --policy-document "$POLICY_DOC"

# ── READ-BACK fail-closed ──
GOT_TRUST=$(aws iam get-role --role-name "$ROLE" --query 'Role.AssumeRolePolicyDocument' --output json)
python3 - "$ROLE" "$ENV_NAME" <<PY || { echo "REFUSED: read-back diverges — remova o role e investigue antes de instalar o secret"; exit 1; }
import json, sys
role, env = sys.argv[1], sys.argv[2]
trust = json.loads('''$GOT_TRUST''')
s = trust["Statement"]
assert len(s) == 1, "trust must have exactly one statement"
c = s[0]["Condition"]["StringEquals"]
assert c["token.actions.githubusercontent.com:aud"] == "sts.amazonaws.com"
assert c["token.actions.githubusercontent.com:sub"] == f"repo:marciozampiron/backstage-cba-prep:environment:{env}"
assert s[0]["Action"] == "sts:AssumeRoleWithWebIdentity"
PY
INLINE=$(aws iam list-role-policies --role-name "$ROLE" --query 'PolicyNames' --output json)
[ "$(printf '%s' "$INLINE" | jq -r 'length')" = "1" ] || { echo "REFUSED: the role must carry exactly ONE inline policy"; exit 1; }
[ "$(printf '%s' "$INLINE" | jq -r '.[0]')" = "$POLICY_NAME" ] || { echo "REFUSED: unexpected inline policy name"; exit 1; }
ATTACHED=$(aws iam list-attached-role-policies --role-name "$ROLE" --query 'AttachedPolicies' --output json)
[ "$(printf '%s' "$ATTACHED" | jq -r 'length')" = "0" ] || { echo "REFUSED: no managed policy may be attached"; exit 1; }
GOT_POLICY=$(aws iam get-role-policy --role-name "$ROLE" --policy-name "$POLICY_NAME" --query 'PolicyDocument' --output json)
ACTIONS=$(printf '%s' "$GOT_POLICY" | jq -r '[.Statement[].Action] | flatten | join(",")')
[ "$ACTIONS" = "cognito-idp:DescribeUserPoolDomain" ] || { echo "REFUSED: the policy grants more than DescribeUserPoolDomain: $ACTIONS"; exit 1; }
ARN=$(aws iam get-role --role-name "$ROLE" --query 'Role.Arn' --output text)
echo "READ-BACK OK: trust pinado, 1 inline policy exata, 0 managed policies"
echo "ARN (mascarado): $(printf '%s' "$ARN" | sed -E 's/[0-9]{12}/ACCOUNT/g')"
echo "Instale o secret com: gh secret set AWS_DEPLOY_PREFLIGHT_ROLE_ARN --env ${ENV_NAME} --repo marciozampiron/backstage-cba-prep --body '<ARN real acima, sem máscara — pegue com: aws iam get-role --role-name ${ROLE} --query Role.Arn --output text>'"
