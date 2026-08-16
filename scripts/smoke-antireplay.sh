#!/usr/bin/env bash
# Anti-replay for the paid smoke (#111, Codex HIGH): a spend decision is consumable ONCE, ever.
# Refuses when ANY other run of the canonical workflow in the canonical repository carries this
# decision's run-name — success, failure, cancelled or in_progress alike. The listing must be
# exhaustive or this script fails CLOSED: an API error, a truncated page set or an ambiguous
# response refuses. Runs BEFORE OIDC/STS/Converse by workflow order (asserted in tests).
set -euo pipefail
: "${SPEND_DECISION_ID:?}" "${GITHUB_RUN_ID:?}"
CANONICAL_REPO="marciozampiron/backstage-cba-prep"
if [ "${GITHUB_REPOSITORY:-}" != "$CANONICAL_REPO" ]; then
  echo "REFUSED: this is not the canonical repository — the decision ledger lives there"; exit 1
fi
EXPECTED_NAME="smoke ${SPEND_DECISION_ID}"
LISTING=$(gh api --paginate "repos/${CANONICAL_REPO}/actions/workflows/blueprint-refresh.yml/runs?per_page=100" 2>/dev/null) \
  || { echo "REFUSED: the prior-run listing failed — an unverified history never authorizes a paid call"; exit 1; }
TOTAL=$(printf '%s' "$LISTING" | jq -s '[.[].total_count] | max // 0') || { echo "REFUSED: unparseable listing"; exit 1; }
FETCHED=$(printf '%s' "$LISTING" | jq -s '[.[].workflow_runs | length] | add // 0') || { echo "REFUSED: unparseable listing"; exit 1; }
if [ "$FETCHED" -lt "$TOTAL" ]; then
  echo "REFUSED: the run listing is truncated (${FETCHED}/${TOTAL}) — exhaustive or nothing"; exit 1
fi
PRIOR=$(printf '%s' "$LISTING" | jq -s --arg name "$EXPECTED_NAME" --arg self "$GITHUB_RUN_ID" \
  '[.[].workflow_runs[]? | select((.display_title == $name) or (.name == $name)) | select((.id|tostring) != $self)] | length')
if [ "$PRIOR" != "0" ]; then
  echo "REFUSED: ${PRIOR} prior run(s) already carry this spend decision — a decision is consumable ONCE, whatever its outcome"; exit 1
fi
echo "anti-replay: no prior run carries this decision — eligible"
