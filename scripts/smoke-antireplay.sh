#!/usr/bin/env bash
# Anti-replay for the paid smoke (#111, Codex HIGH ×2): a spend decision is consumable ONCE.
# Round 2 hardening: a RERUN keeps GITHUB_RUN_ID and bumps GITHUB_RUN_ATTEMPT — attempt != 1
# refuses outright; and the ledger listing must be STRUCTURALLY COMPLETE — at least one page,
# every page an object with an integer total_count and a workflow_runs array, FETCHED == TOTAL
# exactly, every run carrying the fields this verdict reads, and EXACTLY ONE occurrence of the
# current run whose metadata (attempt 1, run-name, head_sha, workflow_dispatch) matches this
# authorization. Anything absent, duplicated, mistyped or contradictory refuses BEFORE OIDC.
set -euo pipefail
: "${SPEND_DECISION_ID:?}" "${GITHUB_RUN_ID:?}" "${AUTHORIZED_SHA:?}"

printf '%s' "${GITHUB_RUN_ATTEMPT:-}" | LC_ALL=C grep -qzE '^[1-9][0-9]*$' \
  || { echo "REFUSED: GITHUB_RUN_ATTEMPT is missing or non-canonical"; exit 1; }
if [ "$GITHUB_RUN_ATTEMPT" != "1" ]; then
  echo "REFUSED: rerun detected (attempt ${GITHUB_RUN_ATTEMPT}) — a rerun repeats the paid call under the SAME consumed decision"; exit 1
fi

CANONICAL_REPO="marciozampiron/backstage-cba-prep"
if [ "${GITHUB_REPOSITORY:-}" != "$CANONICAL_REPO" ]; then
  echo "REFUSED: this is not the canonical repository — the decision ledger lives there"; exit 1
fi
EXPECTED_NAME="smoke ${SPEND_DECISION_ID}"
LISTING=$(gh api --paginate "repos/${CANONICAL_REPO}/actions/workflows/blueprint-refresh.yml/runs?per_page=100" 2>/dev/null) \
  || { echo "REFUSED: the prior-run listing failed — an unverified history never authorizes a paid call"; exit 1; }

VERDICT=$(printf '%s' "$LISTING" | jq -rs --arg name "$EXPECTED_NAME" --arg self "$GITHUB_RUN_ID" --arg sha "$AUTHORIZED_SHA" '
  if length < 1 then "NO_PAGES"
  elif any(.[]; (type != "object") or ((.total_count? | type) != "number") or (.total_count < 0) or ((.workflow_runs? | type) != "array")) then "BAD_PAGE"
  elif ([.[].total_count] | unique | length) != 1 then "AMBIGUOUS_TOTAL"
  else
    ([.[].workflow_runs[]]) as $runs
    | (.[0].total_count) as $total
    | if ($runs | length) != $total then "COUNT_MISMATCH \($runs|length)/\($total)"
      elif any($runs[]; ((.id?|type) != "number") or ((.display_title?|type) != "string") or ((.run_attempt?|type) != "number") or ((.head_sha?|type) != "string") or ((.event?|type) != "string")) then "BAD_RUN_FIELDS"
      else
        ([$runs[] | select((.id|tostring) == $self)]) as $selfruns
        | if ($selfruns | length) != 1 then "SELF_COUNT \($selfruns|length)"
          elif ($selfruns[0].run_attempt != 1) or ($selfruns[0].display_title != $name) or ($selfruns[0].head_sha != $sha) or ($selfruns[0].event != "workflow_dispatch") then "SELF_DIVERGES"
          elif ([$runs[] | select(.display_title == $name) | select((.id|tostring) != $self)] | length) > 0 then "PRIOR_RUN"
          else "ELIGIBLE" end
      end
  end' 2>/dev/null) || { echo "REFUSED: unparseable listing — exhaustive and well-formed, or nothing"; exit 1; }

case "$VERDICT" in
  ELIGIBLE) echo "anti-replay: attempt 1, ledger complete, this run is its only witness — eligible" ;;
  PRIOR_RUN) echo "REFUSED: a prior run already carries this spend decision — a decision is consumable ONCE, whatever its outcome"; exit 1 ;;
  "COUNT_MISMATCH"*) echo "REFUSED: the run listing is inconsistent (${VERDICT}) — exhaustive or nothing"; exit 1 ;;
  *) echo "REFUSED: ledger verdict ${VERDICT} — anything ambiguous never authorizes a paid call"; exit 1 ;;
esac
