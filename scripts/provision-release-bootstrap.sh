#!/usr/bin/env bash
# Operator-managed provisioning of a tier's RELEASE BOOTSTRAP (#111) — Zamp runs this, per phase.
#
# TWO MUTUALLY EXCLUSIVE PHASES, one gate each (Codex IMPLEMENTATION_REQUEST + FINDINGS r2,
# 2026-08-18):
#   provision-release-bootstrap.sh <dev|pilot> policies   — observe/create the three operator
#     policies and audit their CONSUMERS; NEVER runs CDK or CloudFormation.
#   provision-release-bootstrap.sh <dev|pilot> bootstrap  — re-observes the policies (read-only),
#     creates/revalidates the CDK release toolkit; NEVER creates or alters a policy.
# No "all" mode, no default, no chaining.
#
# THE REVIEWED TEMPLATE IS THE AUTHORITY, AND NO LOCAL NODE PACKAGE EVER RUNS UNDER PRIVILEGED
# CREDENTIALS (r2-F1/F4, r3-F1): the canonical bootstrap template is COMMITTED
# (infra/aws/bootstrap/cdk-bootstrap-template.yaml, produced once by the pinned CDK, reviewed,
# digest pinned by test) and this script deploys it DIRECTLY through CloudFormation via the AWS
# CLI — `cdk`/`npx` are never executed here, so a compromised node_modules has no path to the
# operator's credentials. The lockfile-CDK ↔ snapshot agreement is proven by a CI test
# (test/provision-release-bootstrap.test.js), credential-free. The read-back compares the live
# stack — full resource set, the five roles' trust/tags/managed/inline/session-duration, the
# COMPLETE parameter map, bucket (policy, lifecycle, ACL), ECR, KMS, SSM — against expectations
# RESOLVED FROM THE SNAPSHOT (scripts/lib/bootstrap-expected-state.py, closed by resource type
# AND by property: anything the model does not consume refuses the snapshot).
#
# NEVER RUN THIS FILE DIRECTLY (r5-F1, r6-F1/F2). `scripts/provision.sh` is the entrypoint, and
# the runbook runs THAT from the commit object store, not from the worktree. It materializes this
# script and every reviewed input into a private write-stripped tree with a manifest, and runs the
# materialized copy. Self-verification from inside a running script is circular (the prefix already
# ran) and racy (compare-then-execute), so this file does not attempt it — it verifies the TREE it
# runs from (non-worktree, write-stripped, manifest bound to the authorized SHA, exact in both
# directions) and reads every reviewed byte from there. No `git` runs here at all.
#
# PYTHON RUNS ISOLATED (r6-F4): every interpreter entry uses `python3 -I`, so PYTHONPATH,
# PYTHONHOME, user site-packages and the current directory cannot inject code that would execute
# under the operator's credentials before any deadline applies; the bounded runner additionally
# scrubs PYTHON* from the environment it hands to children.
#
# OBSERVE-THEN-ACT: account bound (CBA_EXPECTED_ACCOUNT_ID, never echoed) and re-checked
# immediately before the first mutation; renders are per phase, private (0700 mktemp, umask 077),
# trap-removed; only a proven absence may create; any divergence refuses with zero mutation.
#
# DEADLINE SCOPE, stated exactly (r5-F3, r6-F3): every command that reaches the NETWORK or carries
# CREDENTIALS (`aws`) and every Python helper runs through scripts/lib/bounded-run.py — own
# process group, output to files, group killed and reaped on deadline. Local text utilities on
# files this script itself created are NOT wrapped: they touch no network, hold no credentials and
# read bounded local data. That exception set is CLOSED and enumerated here — the external
# programs this file can execute are exactly
# (cat/chmod/cp/cut/dirname/find/grep/head/mkdir/mktemp/python3/sed/sha256sum/sort/tail) — and a
# test inventories this file through BASH'S OWN PARSER (`bash --pretty-print`, then a lexer that
# follows wrappers like `command`/`env`/`timeout`, absolute paths and `$( )` bodies, and reports a
# variable command name as DYNAMIC_COMMAND) and compares that inventory to this list in BOTH
# directions. `aws` never appears there because it is never executed directly: it only ever runs
# as an argument to the bounded runner, which is the property a separate assertion pins.
set -euo pipefail
umask 077
export AWS_REGION=us-east-1 AWS_DEFAULT_REGION=us-east-1 AWS_MAX_ATTEMPTS=1

ENV_NAME="${1:?usage: provision-release-bootstrap.sh dev|pilot policies|bootstrap}"
PHASE="${2:?usage: provision-release-bootstrap.sh dev|pilot policies|bootstrap}"
[ "$#" -eq 2 ] || { echo "REFUSED: exactly two arguments — environment and phase"; exit 1; }
case "$ENV_NAME" in dev|pilot) : ;; *) echo "REFUSED: environment must be dev or pilot"; exit 1 ;; esac
case "$PHASE" in policies|bootstrap) : ;; *) echo "REFUSED: phase must be policies or bootstrap — there is no combined mode"; exit 1 ;; esac
case "$ENV_NAME" in dev) QUALIFIER=cbardev ;; pilot) QUALIFIER=cbarpil ;; esac
TOOLKIT="cba-release-toolkit-${ENV_NAME}"
GHA_BOUNDARY="cba-study-coach-boundary-gha-deploy-${ENV_NAME}"
RUNTIME_BOUNDARY="cba-study-coach-boundary-runtime-${ENV_NAME}"
EXEC_POLICY="cba-study-coach-cfn-exec-release-${ENV_NAME}"
POLICY_NAMES=("$GHA_BOUNDARY" "$RUNTIME_BOUNDARY" "$EXEC_POLICY")
TEMPLATE_OF() { case "$1" in
  "$GHA_BOUNDARY") echo gha-deploy-boundary ;;
  "$RUNTIME_BOUNDARY") echo runtime-boundary ;;
  "$EXEC_POLICY") echo cfn-exec-release ;;
esac; }
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SNAPSHOT_PATH="infra/aws/bootstrap/cdk-bootstrap-template.yaml"
RESOLVER="${REPO_ROOT}/scripts/lib/bootstrap-expected-state.py"
mask() { sed -E 's/[0-9]{12}/ACCOUNT/g'; }

# ── wall-clock deadlines (r2-F5, r3-F2): positive integers with REVIEWED CEILINGS — zero or
# garbage would silently disable the limit. ──
OBS_T="${CBA_OBSERVE_TIMEOUT_SECONDS:-60}"
BOOT_T="${CBA_BOOTSTRAP_TIMEOUT_SECONDS:-3600}"
printf '%s' "$OBS_T" | LC_ALL=C grep -qzE '^[1-9][0-9]*$' && [ "$OBS_T" -le 600 ] \
  || { echo "REFUSED: CBA_OBSERVE_TIMEOUT_SECONDS must be a positive integer no greater than 600 — zero would disable the deadline"; exit 1; }
printf '%s' "$BOOT_T" | LC_ALL=C grep -qzE '^[1-9][0-9]*$' && [ "$BOOT_T" -le 7200 ] \
  || { echo "REFUSED: CBA_BOOTSTRAP_TIMEOUT_SECONDS must be a positive integer no greater than 7200 — zero would disable the deadline"; exit 1; }
BOUNDED="${REPO_ROOT}/scripts/lib/bounded-run.py"

# ═══════════ ROOT + MANIFEST + SHA ARE VERIFIED TOGETHER (r5-F1, r6-F2) ═══════════
# An environment variable alone proves nothing: round 5 accepted any path, so pointing
# CBA_MATERIALIZED_ROOT at the worktree walked straight past the guard. The tree must now BE what
# the launcher produces — a non-worktree, write-stripped directory whose manifest names the
# authorized SHA and matches its contents EXACTLY, in both directions. A stale tree from an older
# run fails the same way the moment its bytes or its SHA differ.
#
# Residual, stated: a local actor who can set this process's environment can also run any code as
# this user; no in-process check fixes that. What these checks do close is executing the WRONG
# BYTES — a worktree copy, a leftover tree, a hand-made directory — which is the reachable
# failure. Unforgeable provenance needs signing (#91 Stage B).
MAT_ROOT="${CBA_MATERIALIZED_ROOT:-}"
[ -n "$MAT_ROOT" ] && [ -d "$MAT_ROOT" ] \
  || { echo "REFUSED: run scripts/provision.sh — this script only executes from the tree materialized out of the authorized commit"; exit 1; }
case "$MAT_ROOT" in /*) : ;; *) echo "REFUSED: the materialized root must be an absolute path"; exit 1 ;; esac
[ "$REPO_ROOT" = "$MAT_ROOT" ] \
  || { echo "REFUSED: this copy is not the materialized one (run scripts/provision.sh)"; exit 1; }
SHA="${CBA_AUTHORIZED_SHA:-}"
printf '%s' "$SHA" | LC_ALL=C grep -qzE '^[0-9a-f]{40}$' \
  || { echo "REFUSED: CBA_AUTHORIZED_SHA is required (full 40-hex commit SHA)"; exit 1; }
# A worktree is never a materialized tree: it carries git metadata, at the root or above it.
probe_dir="$MAT_ROOT"
while : ; do
  [ -e "$probe_dir/.git" ] \
    && { echo "REFUSED: the materialized root is inside a git worktree — the worktree is exactly what must not run"; exit 1; }
  [ "$probe_dir" = "/" ] && break
  probe_dir=$(dirname "$probe_dir")
done
# Write-stripped, as the launcher leaves it: a writable tree can be edited between check and use.
if find "$MAT_ROOT" -perm -u+w -print -quit | grep -q . ; then
  echo "REFUSED: the materialized tree is writable — only a write-stripped tree may provision"; exit 1
fi
MANIFEST="$MAT_ROOT/.cba-manifest"
[ -f "$MANIFEST" ] \
  || { echo "REFUSED: the materialized tree carries no manifest"; exit 1; }
[ "$(head -n1 "$MANIFEST")" = "SHA ${SHA}" ] \
  || { echo "REFUSED: the manifest does not name the authorized SHA — this tree belongs to another authorization"; exit 1; }
# EXACT SET EQUALITY, not counts (r7-F3): a duplicated valid line used to compensate for an
# omitted path, so a swapped file could hide behind a manifest that merely had the right length.
# Every line must be well formed and canonical, and the SORTED PATH LISTS must be identical
# strings — which is set AND multiplicity equality, so a duplicate and an omission both refuse.
if tail -n +2 "$MANIFEST" | LC_ALL=C grep -qvE '^[0-9a-f]{64}  \./[^/]'; then
  echo "REFUSED: the manifest carries a malformed or non-canonical entry"; exit 1
fi
if tail -n +2 "$MANIFEST" | LC_ALL=C grep -qE '(^|/)\.\.(/|$)'; then
  echo "REFUSED: the manifest carries a path-traversal entry"; exit 1
fi
MANIFEST_PATHS=$(tail -n +2 "$MANIFEST" | sed -E 's/^[0-9a-f]{64}  //' | LC_ALL=C sort)
# The manifest cannot carry its own digest, so it is the one file outside the comparison.
ACTUAL_PATHS=$(cd "$MAT_ROOT" && find . -type f -not -name .cba-manifest | LC_ALL=C sort)
[ "$MANIFEST_PATHS" = "$ACTUAL_PATHS" ] \
  || { echo "REFUSED: the manifest path set is not exactly the tree's contents (duplicate, missing or extra path)"; exit 1; }
# Then the digests themselves, every line checked.
( cd "$MAT_ROOT" && tail -n +2 .cba-manifest | sha256sum -c --status - ) \
  || { echo "REFUSED: the materialized tree diverges from its manifest"; exit 1; }
MANIFEST_COUNT=$(printf '%s\n' "$MANIFEST_PATHS" | grep -c . || true)
echo "execucao: arvore materializada verificada (raiz nao-worktree, somente leitura, manifesto ${MANIFEST_COUNT} arquivos, conjunto de caminhos identico, digests conferidos); nenhum git roda nesta fase"

# ── the private working dir; every bounded call captures into it ──
TMP=$(mktemp -d /tmp/cba-relboot.XXXXXX)
chmod 700 "$TMP"
trap 'rm -rf "$TMP"' EXIT

RUN_OUT=""; RUN_ERR=""
run_() { # bounded ANY external command through the verified runner; $1 = deadline seconds
  # NEVER toggles set -e: a callee flipping errexit back on would undo the CALLER's guard and
  # turn every nonzero result into a silent exit — `|| rc=$?` is errexit-safe by itself.
  local deadline="$1"; shift
  local rc=0
  python3 -I "$BOUNDED" "$deadline" "$TMP/.out" "$TMP/.err" "$@" || rc=$?
  RUN_OUT=$(cat "$TMP/.out" 2>/dev/null || true)
  RUN_ERR=$(cat "$TMP/.err" 2>/dev/null || true)
  [ "$rc" -eq 125 ] && { echo "REFUSED: processes SURVIVED the deadline kill — the result is INDETERMINATE; reconcile read-only before any new gate"; exit 1; }
  return "$rc"
}
aws_() { run_ "$OBS_T" aws --cli-connect-timeout 10 --cli-read-timeout 55 "$@"; }

# ── the ACCOUNT binds next; neither value is ever echoed ──
EXPECTED="${CBA_EXPECTED_ACCOUNT_ID:-}"
printf '%s' "$EXPECTED" | LC_ALL=C grep -qzE '^[0-9]{12}$' \
  || { echo "REFUSED: CBA_EXPECTED_ACCOUNT_ID is required (12 digits, supplied outside Git); the value is not echoed"; exit 1; }
check_account() { # $1 = when
  local rc=0
  aws_ sts get-caller-identity --query Account --output text || rc=$?
  [ "$rc" -eq 124 ] && { echo "REFUSED ($1): STS observation exceeded its wall-clock deadline (OBSERVATION_TIMEOUT)"; exit 1; }
  [ "$rc" -eq 0 ] || { echo "REFUSED ($1): STS identity observation failed — nothing was mutated"; exit 1; }
  local got="$RUN_OUT"
  printf '%s' "$got" | LC_ALL=C grep -qzE '^[0-9]{12}$' \
    || { echo "REFUSED ($1): the STS account is malformed; the value is not echoed"; exit 1; }
  [ "$got" = "$EXPECTED" ] \
    || { echo "REFUSED ($1): the ambient credentials do not belong to the authorized account; neither value is echoed"; exit 1; }
  ACCOUNT="$got"
}
check_account "binding"

# ── fresh private render, per phase; nothing is transported between phases ──
canon() { python3 -I -c '
import json, sys
def c(x):
    if isinstance(x, dict): return {k: c(v) for k, v in sorted(x.items())}
    if isinstance(x, list): return [c(v) for v in x]
    return x
print(json.dumps(c(json.load(open(sys.argv[1])))))' "$1"; }
same_doc() { python3 -I -c '
import json, sys
def c(x):
    if isinstance(x, dict): return {k: c(v) for k, v in sorted(x.items())}
    if isinstance(x, list): return [c(v) for v in x]
    return x
a, b = (json.loads(sys.argv[1]), json.loads(sys.argv[2]))
sys.exit(0 if c(a) == c(b) else 1)' "$1" "$2"; }
for name in "${POLICY_NAMES[@]}"; do
  t="$(TEMPLATE_OF "$name")"
  raw="$TMP/$t.raw"; out="$TMP/$t.json"
  cp "${MAT_ROOT}/infra/aws/bootstrap/policies/${t}.template.json" "$raw" 2>/dev/null \
    || { echo "REFUSED: template ${t} is missing from the materialized commit tree"; exit 1; }
  sed -e "s/ACCOUNT_ID_PLACEHOLDER/${ACCOUNT}/g" \
      -e "s/ENVIRONMENT_PLACEHOLDER/${ENV_NAME}/g" \
      -e "s/QUALIFIER_PLACEHOLDER/${QUALIFIER}/g" "$raw" > "$out"
  grep -q "PLACEHOLDER" "$out" && { echo "REFUSED: unrendered placeholder in ${t}"; exit 1; }
  [ -f "$out" ] && [ ! -L "$out" ] || { echo "REFUSED: the rendered ${t} is not a regular file"; exit 1; }
  canon "$out" > "$TMP/$t.canon" 2>/dev/null \
    || { echo "REFUSED: the rendered ${t} is not valid JSON"; exit 1; }
  echo "render ${t}: sha256 $(sha256sum "$TMP/$t.canon" | cut -d' ' -f1)"
done

# ── observe(desc, absence-marker, aws args...): EXISTS / proven ABSENT / named refusal ──
OBS_STATE=""; OBS_OUT=""
observe() {
  local desc="$1" marker="$2"; shift 2
  local rc
  rc=0; aws_ "$@" || rc=$?
  if [ "$rc" -eq 124 ] || [ "$rc" -eq 137 ]; then
    echo "REFUSED: observation of ${desc} exceeded its wall-clock deadline (OBSERVATION_TIMEOUT) — nothing was mutated"; exit 1
  fi
  if [ "$rc" -eq 0 ]; then
    grep -q '"NextToken"\|"IsTruncated": true' <<<"$RUN_OUT" \
      && { echo "REFUSED: observation of ${desc} was paginated/truncated — an incomplete read proves nothing"; exit 1; }
    OBS_STATE=EXISTS; OBS_OUT="$RUN_OUT"; return 0
  fi
  if [ -n "$marker" ] && grep -q "$marker" <<<"$RUN_ERR$RUN_OUT"; then OBS_STATE=ABSENT; OBS_OUT=""; return 0; fi
  echo "REFUSED: observation of ${desc} failed (not a proven absence) — nothing was mutated"; exit 1
}
jqpy() { python3 -I -c "import json,sys; d=json.load(sys.stdin); $1"; }
pyq() { python3 -I -c "import json,sys; $1"; }

# ── policy consumers (r2-F3): a boundary attached as a NORMAL policy grants its actions ──
validate_policy_usage() { # $1 = policy name
  local name="$1" arn="arn:aws:iam::${ACCOUNT}:policy/$1"
  observe "permissions-usage of ${name}" "" iam list-entities-for-policy --policy-arn "$arn" --policy-usage-filter PermissionsPolicy --output json
  local perm="$OBS_OUT"
  observe "boundary-usage of ${name}" "" iam list-entities-for-policy --policy-arn "$arn" --policy-usage-filter PermissionsBoundary --output json
  local bound="$OBS_OUT"
  if [ "$name" = "$EXEC_POLICY" ]; then
    # The execution policy is a NORMAL policy for exactly the toolkit execution role — and it is
    # never anyone's permissions boundary. Before the bootstrap phase runs, zero consumers is fine.
    printf '%s' "$perm" | jqpy "
roles=[r['RoleName'] for r in d.get('PolicyRoles',[])]
ok = not d.get('PolicyUsers') and not d.get('PolicyGroups') and all(r=='cdk-${QUALIFIER}-cfn-exec-role-${ACCOUNT}-us-east-1' for r in roles)
sys.exit(0 if ok else 1)" \
      || { echo "REFUSED: the execution policy ${name} is attached beyond the expected execution role — zero mutation performed"; exit 1; }
    printf '%s' "$bound" | jqpy "sys.exit(0 if not d.get('PolicyRoles') and not d.get('PolicyUsers') and not d.get('PolicyGroups') else 1)" \
      || { echo "REFUSED: the execution policy ${name} is used as a permissions boundary — zero mutation performed"; exit 1; }
  else
    # A boundary is NEVER attached as a normal policy — attached, it GRANTS what it should cap.
    printf '%s' "$perm" | jqpy "sys.exit(0 if not d.get('PolicyRoles') and not d.get('PolicyUsers') and not d.get('PolicyGroups') else 1)" \
      || { echo "REFUSED: boundary ${name} is attached as a NORMAL policy to some principal — it would grant its actions directly; zero mutation performed"; exit 1; }
    # And it bounds ONLY its nominal set: the tier's deploy role, or the tier's release-created roles.
    local pattern
    case "$name" in
      "$GHA_BOUNDARY") pattern="^cba-study-coach-gha-deploy-${ENV_NAME}\$" ;;
      "$RUNTIME_BOUNDARY") pattern="^cba-study-coach-${ENV_NAME}-" ;;
    esac
    printf '%s' "$bound" | jqpy "
import re
roles=[r['RoleName'] for r in d.get('PolicyRoles',[])]
ok = not d.get('PolicyUsers') and not d.get('PolicyGroups') and all(re.match(r'${pattern}', r) for r in roles)
sys.exit(0 if ok else 1)" \
      || { echo "REFUSED: boundary ${name} bounds a principal outside its nominal set (cross-tier or foreign) — zero mutation performed"; exit 1; }
  fi
}

# ── full policy validation: identity, default version, document, version set, consumers ──
validate_policy() { # $1 name; refuses on ANY divergence; returns 1 only on proven absence
  local name="$1" t arn ver
  t="$(TEMPLATE_OF "$name")"
  arn="arn:aws:iam::${ACCOUNT}:policy/${name}"
  observe "policy ${name}" "NoSuchEntity" iam get-policy --policy-arn "$arn" --output json
  [ "$OBS_STATE" = "EXISTS" ] || return 1
  printf '%s' "$OBS_OUT" | jqpy "p=d['Policy']; sys.exit(0 if p['PolicyName']=='${name}' and p['Path']=='/' and p['Arn']=='${arn}' else 1)" \
    || { echo "REFUSED: policy ${name} exists but its identity (name/path/arn) diverges — zero mutation performed"; exit 1; }
  ver=$(printf '%s' "$OBS_OUT" | jqpy "print(d['Policy']['DefaultVersionId'])")
  observe "policy versions of ${name}" "" iam list-policy-versions --policy-arn "$arn" --output json
  printf '%s' "$OBS_OUT" | jqpy "vs=d['Versions']; sys.exit(0 if len(vs)==1 and vs[0]['IsDefaultVersion'] and vs[0]['VersionId']=='${ver}' else 1)" \
    || { echo "REFUSED: policy ${name} carries a version set beyond the single reviewed default — zero mutation performed"; exit 1; }
  observe "policy document of ${name}" "" iam get-policy-version --policy-arn "$arn" --version-id "$ver" --output json
  local got
  got=$(printf '%s' "$OBS_OUT" | jqpy "print(json.dumps(d['PolicyVersion']['Document']))")
  same_doc "$got" "$(cat "$TMP/$t.canon")" \
    || { echo "REFUSED: policy ${name} diverges from the reviewed template — zero mutation performed"; exit 1; }
  validate_policy_usage "$name"
  return 0
}

# ════════════════════════════ PHASE: policies ════════════════════════════
if [ "$PHASE" = "policies" ]; then
  ABSENT=(); PRESENT=()
  for name in "${POLICY_NAMES[@]}"; do
    if validate_policy "$name"; then PRESENT+=("$name"); else ABSENT+=("$name"); fi
  done
  if [ "${#ABSENT[@]}" -eq 0 ]; then
    echo "POLICIES OK (${ENV_NAME}): as tres policies existem, sao semanticamente identicas e seus consumidores estao no conjunto nominal — reentrada, zero mutacao"
    echo "PROXIMA FASE: 'bootstrap' exige o seu proprio gate; nada de CDK correu nesta fase"
    exit 0
  fi
  check_account "immediately before the first mutation"
  CREATED=(); FAILED=""
  for name in "${ABSENT[@]}"; do
    t="$(TEMPLATE_OF "$name")"
    if aws_ iam create-policy --policy-name "$name" --policy-document "file://$TMP/$t.json" >/dev/null 2>&1; then
      CREATED+=("$name")
    else
      FAILED="$name"; break
    fi
  done
  if [ -n "$FAILED" ]; then
    echo "PARTIAL FAILURE (honest record): created=[${CREATED[*]:-}] failed-at=${FAILED} — no rollback, no retry; investigate and re-run under a new gate"
    exit 1
  fi
  for name in "${ABSENT[@]}"; do
    validate_policy "$name" \
      || { echo "REFUSED: create of ${name} reported success but the policy did NOT materialize — never READ-BACK OK"; exit 1; }
    echo "policy criada e read-back completo: ${name}"
  done
  echo "POLICIES OK (${ENV_NAME}): criadas [${CREATED[*]}] | reentrantes [${PRESENT[*]:-nenhuma}]"
  echo "PROXIMA FASE: 'bootstrap' exige o seu proprio gate; nada de CDK correu nesta fase"
  exit 0
fi

# ════════════════════════════ PHASE: bootstrap ════════════════════════════
# NO cdk, NO npx, NO node_modules code runs in this phase (r3-F1): the mutation is the reviewed
# snapshot submitted DIRECTLY to CloudFormation by the AWS CLI. The lockfile-CDK ↔ snapshot
# agreement is a credential-free CI proof (test/provision-release-bootstrap.test.js), not an
# operator-shell execution.

# The policies are a PRECONDITION here, observed read-only: this phase never creates or alters one.
for name in "${POLICY_NAMES[@]}"; do
  validate_policy "$name" \
    || { echo "REFUSED: policy ${name} is absent — run the 'policies' phase (its own gate) first; this phase never creates policies"; exit 1; }
done
EXEC_ARN="arn:aws:iam::${ACCOUNT}:policy/${EXEC_POLICY}"

# ── THE REVIEWED SNAPSHOT IS THE AUTHORITY (r2-F1/r3-F1): committed bytes, from the SHA ──
cp "${MAT_ROOT}/${SNAPSHOT_PATH}" "$TMP/toolkit.yaml" 2>/dev/null \
  || { echo "REFUSED: the bootstrap template snapshot is missing from the materialized commit tree"; exit 1; }
TEMPLATE_SHA=$(sha256sum "$TMP/toolkit.yaml" | cut -d' ' -f1)
echo "toolkit template: snapshot revisado do SHA autorizado, sha256 ${TEMPLATE_SHA}"

# ── full read-back against the model RESOLVED FROM THE SNAPSHOT (r2-F1/F2/F4) ──
readback() { # $1 = when; refuses on ANY divergence, reporting EVERY failure at once
  local when="$1" stack
  observe "the toolkit stack (${when})" "does not exist" cloudformation describe-stacks --stack-name "$TOOLKIT" --output json
  [ "$OBS_STATE" = "EXISTS" ] || { echo "REFUSED (${when}): the toolkit stack is not observable"; exit 1; }
  printf '%s' "$OBS_OUT" > "$TMP/obs.stack.json"; stack="$OBS_OUT"
  observe "the stored template (${when})" "" cloudformation get-template --stack-name "$TOOLKIT" --output json
  printf '%s' "$OBS_OUT" > "$TMP/obs.template.json"
  observe "the stack resources (${when})" "" cloudformation list-stack-resources --stack-name "$TOOLKIT" --output json
  printf '%s' "$OBS_OUT" > "$TMP/obs.resources.json"
  observe "the stack policy (${when})" "" cloudformation get-stack-policy --stack-name "$TOOLKIT" --output json
  printf '%s' "$OBS_OUT" > "$TMP/obs.stackpolicy.json"

  # Physical ids feed the resolver (the KMS key id is only nameable by the live stack).
  jqpy "
phys={r['LogicalResourceId']: r.get('PhysicalResourceId','') for r in d['StackResourceSummaries']}
print(json.dumps(phys))" < "$TMP/obs.resources.json" > "$TMP/phys.json"
  run_ "$OBS_T" python3 -I "$RESOLVER" "$TMP/toolkit.yaml" "$ACCOUNT" us-east-1 "$QUALIFIER" "$EXEC_ARN" "$TMP/phys.json" \
    || { echo "REFUSED (${when}): the expected-state resolver refused the reviewed snapshot"; sed -E 's/[0-9]{12}/ACCOUNT/g' <<<"$RUN_ERR"; exit 1; }
  printf '%s\n' "$RUN_OUT" > "$TMP/model.json"

  # IAM: the five roles, each fully observed.
  local lid rname
  for lid in $(pyq "print(' '.join(sorted(json.load(open('$TMP/model.json'))['roles'])))"); do
    rname=$(pyq "print(json.load(open('$TMP/model.json'))['roles']['$lid']['name'])")
    observe "role ${lid} (${when})" "NoSuchEntity" iam get-role --role-name "$rname" --output json
    [ "$OBS_STATE" = "EXISTS" ] || { echo "REFUSED (${when}): bootstrap role ${lid} is absent"; exit 1; }
    printf '%s' "$OBS_OUT" > "$TMP/obs.role.$lid.json"
    observe "attached policies of ${lid} (${when})" "" iam list-attached-role-policies --role-name "$rname" --output json
    printf '%s' "$OBS_OUT" > "$TMP/obs.attached.$lid.json"
    observe "inline policies of ${lid} (${when})" "" iam list-role-policies --role-name "$rname" --output json
    printf '%s' "$OBS_OUT" > "$TMP/obs.inline-names.$lid.json"
    mkdir -p "$TMP/obs.inline.$lid"
    local p
    for p in $(printf '%s' "$OBS_OUT" | jqpy "print(' '.join(d['PolicyNames']))"); do
      observe "inline ${p} of ${lid} (${when})" "" iam get-role-policy --role-name "$rname" --policy-name "$p" --output json
      printf '%s' "$OBS_OUT" > "$TMP/obs.inline.$lid/$p.json"
    done
  done
  observe "policy attachments (${when})" "" iam list-entities-for-policy --policy-arn "$EXEC_ARN" --policy-usage-filter PermissionsPolicy --output json
  printf '%s' "$OBS_OUT" > "$TMP/obs.exec-entities.json"

  # SSM, S3, ECR, KMS — the surfaces the template declares.
  observe "the bootstrap version parameter (${when})" "ParameterNotFound" ssm get-parameter --name "/cdk-bootstrap/${QUALIFIER}/version" --output json
  [ "$OBS_STATE" = "EXISTS" ] || { echo "REFUSED (${when}): /cdk-bootstrap/${QUALIFIER}/version is absent"; exit 1; }
  printf '%s' "$OBS_OUT" > "$TMP/obs.ssm.json"
  local bucket repo keyid
  bucket=$(pyq "print(json.load(open('$TMP/model.json'))['bucket']['name'])")
  observe "bucket encryption (${when})" "" s3api get-bucket-encryption --bucket "$bucket" --output json
  printf '%s' "$OBS_OUT" > "$TMP/obs.s3-enc.json"
  observe "bucket versioning (${when})" "" s3api get-bucket-versioning --bucket "$bucket" --output json
  printf '%s' "$OBS_OUT" > "$TMP/obs.s3-ver.json"
  observe "bucket public access block (${when})" "" s3api get-public-access-block --bucket "$bucket" --output json
  printf '%s' "$OBS_OUT" > "$TMP/obs.s3-pab.json"
  observe "bucket policy (${when})" "" s3api get-bucket-policy --bucket "$bucket" --output json
  printf '%s' "$OBS_OUT" > "$TMP/obs.s3-policy.json"
  observe "bucket lifecycle (${when})" "" s3api get-bucket-lifecycle-configuration --bucket "$bucket" --output json
  printf '%s' "$OBS_OUT" > "$TMP/obs.s3-lifecycle.json"
  observe "bucket acl (${when})" "" s3api get-bucket-acl --bucket "$bucket" --output json
  printf '%s' "$OBS_OUT" > "$TMP/obs.s3-acl.json"
  repo=$(pyq "print(json.load(open('$TMP/model.json'))['ecr']['name'])")
  observe "the container repository (${when})" "" ecr describe-repositories --repository-names "$repo" --output json
  printf '%s' "$OBS_OUT" > "$TMP/obs.ecr.json"
  observe "the repository lifecycle policy (${when})" "" ecr get-lifecycle-policy --repository-name "$repo" --output json
  printf '%s' "$OBS_OUT" > "$TMP/obs.ecr-lifecycle.json"
  observe "the repository policy (${when})" "" ecr get-repository-policy --repository-name "$repo" --output json
  printf '%s' "$OBS_OUT" > "$TMP/obs.ecr-policy.json"
  keyid=$(pyq "print(json.load(open('$TMP/phys.json')).get('FileAssetsBucketEncryptionKey',''))")
  if pyq "sys.exit(0 if json.load(open('$TMP/model.json'))['kms'] else 1)"; then
    [ -n "$keyid" ] || { echo "REFUSED (${when}): the template materializes a KMS key but the stack names none"; exit 1; }
    observe "the bootstrap KMS key (${when})" "" kms describe-key --key-id "$keyid" --output json
    printf '%s' "$OBS_OUT" > "$TMP/obs.kms.json"
    observe "the KMS key policy (${when})" "" kms get-key-policy --key-id "$keyid" --policy-name default --output json
    printf '%s' "$OBS_OUT" > "$TMP/obs.kms-policy.json"
    observe "the KMS alias (${when})" "" kms list-aliases --key-id "$keyid" --output json
    printf '%s' "$OBS_OUT" > "$TMP/obs.kms-aliases.json"
  fi

  # ONE validator, comparing EVERYTHING against the resolved model; never short-circuits.
  local vrc=0
  run_ "$OBS_T" python3 -I "${REPO_ROOT}/scripts/lib/bootstrap-readback-validate.py" "$TMP" "$QUALIFIER" "$ACCOUNT" "$EXEC_ARN" "$TOOLKIT" || vrc=$?
  printf '%s\n%s\n' "$RUN_OUT" "$RUN_ERR" | grep -v '^$' | sed -E 's/[0-9]{12}/ACCOUNT/g' || true
  [ "$vrc" -eq 0 ] || { echo "REFUSED (${when}): the live stack diverges from the reviewed template — every divergence is listed above"; exit 1; }
  echo "READ-BACK OK (${when}): conjunto completo de recursos, 5 roles (trust/tags/managed/inline exatos), exec policy exclusiva, SSM, bucket (policy incluida), ECR (lifecycle+policy), KMS (policy+alias) — tudo igual ao snapshot revisado sha256 ${TEMPLATE_SHA}"
}

observe "the toolkit stack" "does not exist" cloudformation describe-stacks --stack-name "$TOOLKIT" --output json
if [ "$OBS_STATE" = "EXISTS" ]; then
  readback "reentrada, zero mutacao"
  echo "BOOTSTRAP OK (${ENV_NAME}): stack ${TOOLKIT} ja existe e validou integralmente — nenhuma mutacao"
  exit 0
fi

# ── ONE read-only reconciliation, reached by EVERY mutation failure path (r4-F3) ──
# A create-stack whose response was lost looks exactly like one that never happened: the request
# may have been accepted and the stack may be building. Round 3 promised reconciliation and then
# exited before performing it on the create-stack paths. This routine is the single owner of that
# promise: EXACTLY ONE describe-stacks, no retry, and it never decides anything — the operator
# reads the status and opens a new gate.
reconcile_and_stop() { # $1 = headline, $2 = stderr file to tail
  echo "$1"
  local rc=0
  aws_ cloudformation describe-stacks --stack-name "$TOOLKIT" --output json || rc=$?
  if [ "$rc" -eq 0 ] && [ -n "$RUN_OUT" ]; then
    printf '%s' "$RUN_OUT" | jqpy "s=d['Stacks'][0]; print('reconciliation — stack status:', s['StackStatus'])" 2>/dev/null \
      || echo "reconciliation — stack status: unparseable"
  elif grep -q "does not exist" <<<"$RUN_ERR$RUN_OUT"; then
    echo "reconciliation — stack status: does not exist (the request left no stack)"
  else
    echo "reconciliation — stack status: NOT OBSERVABLE; treat the account as indeterminate"
  fi
  [ -n "${2:-}" ] && [ -s "$2" ] && sed -E 's/[0-9]{12}/ACCOUNT/g' "$2" | tail -3
  echo "NENHUM retry foi tentado; abra um novo gate depois de investigar"
  exit 1
}

check_account "immediately before the first mutation"
# The ONE mutation: the reviewed snapshot bytes go to CloudFormation directly — the AWS CLI is
# the executor, the same trust root as every observation; no local package touches credentials.
# Omitted parameters take the template defaults the resolver models.
RC=0
python3 -I "$BOUNDED" "$OBS_T" "$TMP/create.out" "$TMP/create.err" \
  aws --cli-connect-timeout 10 --cli-read-timeout 55 cloudformation create-stack \
    --stack-name "$TOOLKIT" \
    --template-body "file://$TMP/toolkit.yaml" \
    --parameters "ParameterKey=Qualifier,ParameterValue=${QUALIFIER}" \
                 "ParameterKey=CloudFormationExecutionPolicies,ParameterValue=${EXEC_ARN}" \
    --capabilities CAPABILITY_NAMED_IAM \
    --enable-termination-protection \
    --output json || RC=$?
case "$RC" in
  0) : ;;
  124|137) reconcile_and_stop "BOOTSTRAP TIMEOUT at create-stack (deadline exceeded; the process group was killed and reaped) — the request may have been ACCEPTED; the result is INDETERMINATE:" "$TMP/create.err" ;;
  125) reconcile_and_stop "BOOTSTRAP INDETERMINATE at create-stack: processes SURVIVED the deadline kill:" "$TMP/create.err" ;;
  *) reconcile_and_stop "BOOTSTRAP FAILED at create-stack — the request may still have been accepted before the error surfaced:" "$TMP/create.err" ;;
esac
RC=0
python3 -I "$BOUNDED" "$BOOT_T" "$TMP/wait.out" "$TMP/wait.err" \
  aws --cli-connect-timeout 10 --cli-read-timeout 55 cloudformation wait stack-create-complete --stack-name "$TOOLKIT" || RC=$?
case "$RC" in
  0) : ;;
  124|137) reconcile_and_stop "BOOTSTRAP TIMEOUT while waiting (deadline exceeded; the process group was killed and reaped) — the result is INDETERMINATE:" "$TMP/wait.err" ;;
  125) reconcile_and_stop "BOOTSTRAP INDETERMINATE while waiting: processes SURVIVED the deadline kill:" "$TMP/wait.err" ;;
  *) reconcile_and_stop "BOOTSTRAP FAILED while waiting for the stack to complete:" "$TMP/wait.err" ;;
esac
readback "read-back, AFTER bootstrap"
echo "BOOTSTRAP OK (${ENV_NAME}): ${TOOLKIT} criado (qualifier ${QUALIFIER}) com os bytes exatos do snapshot revisado; evidencia acima carrega nomes e digests apenas"
