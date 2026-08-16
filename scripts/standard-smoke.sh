#!/usr/bin/env bash
# The standard-tier smoke (#111/#117): EXACTLY ONE Converse attempt under the refresh role,
# end_turn-only success, masked evidence. Behavior is proven by executed tests with a fake
# `aws` on PATH (test/blueprint-refresh-smoke.test.js); the workflow invokes this file verbatim.
set -euo pipefail
export AWS_MAX_ATTEMPTS=1

# Fail closed on the SPEND DECISION ID before ANY AWS call: closed grammar, whole-value match
# (grep -z makes the entire input one record, so an embedded newline can never smuggle a second
# evidence line). The id is only ever printed AFTER passing this grammar.
if ! printf '%s' "${SPEND_DECISION_ID:-}" | LC_ALL=C grep -qzE '^zamp-[a-z0-9][a-z0-9._-]{0,79}$'; then
  echo "REFUSED: spend_decision_id fails the closed grammar (zamp-…); the value is not echoed"; exit 1
fi

# Fail closed on the DECISION WINDOW before any AWS call: strict UTC-Z instants, TTL <= 1h,
# and now inside [approved_at, expires_at). Re-checked immediately before the Converse call.
TS_RE='^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$'
printf '%s' "${APPROVED_AT:-}" | LC_ALL=C grep -qzE "$TS_RE" || { echo "REFUSED: approved_at must be strict UTC Z to whole seconds"; exit 1; }
printf '%s' "${EXPIRES_AT:-}" | LC_ALL=C grep -qzE "$TS_RE" || { echo "REFUSED: expires_at must be strict UTC Z to whole seconds"; exit 1; }
AP=$(date -u -d "$APPROVED_AT" +%s) || { echo "REFUSED: approved_at does not parse"; exit 1; }
EX=$(date -u -d "$EXPIRES_AT" +%s) || { echo "REFUSED: expires_at does not parse"; exit 1; }
[ "$AP" -lt "$EX" ] || { echo "REFUSED: the window is inverted or empty"; exit 1; }
[ $((EX - AP)) -le 3600 ] || { echo "REFUSED: the decision TTL exceeds one hour"; exit 1; }
NOW=$(date -u +%s)
[ "$NOW" -ge "$AP" ] || { echo "REFUSED: the decision is not yet valid"; exit 1; }
[ "$NOW" -lt "$EX" ] || { echo "REFUSED: the decision expired"; exit 1; }

# Fail closed on IDENTITY — role name AND account, without ever printing the account.
ROLE_ACCOUNT=$(printf '%s' "${AWS_BEDROCK_REFRESH_ROLE_ARN:-}" | cut -d: -f5)
CALLER_JSON=$(aws sts get-caller-identity --output json)
CALLER=$(printf '%s' "$CALLER_JSON" | jq -r .Arn)
CALLER_ACCOUNT=$(printf '%s' "$CALLER_JSON" | jq -r .Account)
MASKED=$(printf '%s' "$CALLER" | sed -E 's/[0-9]{12}/ACCOUNT/g')
if [ -z "$ROLE_ACCOUNT" ] || [ "$CALLER_ACCOUNT" != "$ROLE_ACCOUNT" ]; then
  echo "REFUSED: caller account diverges from the refresh role's account"; exit 1
fi
case "$CALLER" in
  *assumed-role/cba-study-coach-gha-bedrock-refresh/*) : ;;
  *) echo "REFUSED: identity is not the refresh role: $MASKED"; exit 1 ;;
esac
# Fail closed on MODEL: exactly the approved standard profile — no fallback, ever.
if [ "${BEDROCK_MODEL_STANDARD:-}" != "us.anthropic.claude-sonnet-5" ]; then
  echo "REFUSED: BEDROCK_MODEL_STANDARD diverges from the approved standard profile"; exit 1
fi
# EXACTLY ONE invocation: AWS_MAX_ATTEMPTS=1 disables the CLI's automatic retries, set -e
# stops on failure — there is no second attempt of any kind.
# Condition 8 (Codex): the expiry is revalidated IMMEDIATELY before the paid call.
[ "$(date -u +%s)" -lt "$EX" ] || { echo "REFUSED: the decision expired before the call"; exit 1; }
STOP=$(aws bedrock-runtime converse --region "${AWS_REGION:?}" --model-id "$BEDROCK_MODEL_STANDARD" \
  --messages '[{"role":"user","content":[{"text":"Reply with exactly: ok"}]}]' \
  --inference-config '{"maxTokens":8}' --query stopReason --output text)
# ONLY end_turn is success — max_tokens, content_filtered, guardrail_intervened all fail.
if [ "$STOP" != "end_turn" ]; then
  echo "REFUSED: stopReason=$STOP is not end_turn — the smoke is NOT proven"; exit 1
fi
echo "SMOKE EVIDENCE"
echo "timestamp=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "identity=$MASKED (refresh role confirmed, account matched)"
echo "region=$AWS_REGION"
echo "model=$BEDROCK_MODEL_STANDARD"
echo "stopReason=$STOP"
echo "attempts=1"
echo "authorized_sha=${AUTHORIZED_SHA:-unbound}"
echo "spend_decision=${SPEND_DECISION_ID:-unbound}"
