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
# THE REVIEWED TEMPLATE IS THE AUTHORITY (r2-F1/F4): the canonical bootstrap template is COMMITTED
# (infra/aws/bootstrap/cdk-bootstrap-template.yaml, produced by the pinned CDK and reviewed); the
# locally generated `--show-template` output must equal it BYTE FOR BYTE before any mutation, the
# deploy uses exactly those bytes via --template, and the read-back compares the live stack — the
# FULL resource set, the five roles' trust/tags/managed/inline documents, bucket, ECR, KMS, SSM —
# against expectations RESOLVED FROM THAT SNAPSHOT (scripts/lib/bootstrap-expected-state.py), so
# a compromised node_modules can neither widen the deployment nor validate its own product.
#
# OBSERVE-THEN-ACT: account bound first (CBA_EXPECTED_ACCOUNT_ID, never echoed) and re-checked
# immediately before the first mutation; CBA_AUTHORIZED_SHA must equal HEAD of a clean worktree
# and every reviewed byte is read from THAT SHA; renders are per phase, private (0700 mktemp,
# umask 077), trap-removed; only a proven absence may create; any divergence refuses with zero
# mutation; every external call carries a WALL-CLOCK DEADLINE (r2-F5) and a timeout is a named
# refusal, never a blind retry. Evidence carries names and digests only.
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

# ── wall-clock deadlines (r2-F5): every external call is bounded; 124 is a NAMED refusal ──
OBS_T="${CBA_OBSERVE_TIMEOUT_SECONDS:-60}"
CDK_T="${CBA_CDK_TIMEOUT_SECONDS:-300}"
BOOT_T="${CBA_BOOTSTRAP_TIMEOUT_SECONDS:-3600}"
aws_() { timeout --foreground --kill-after=10 "$OBS_T" aws --cli-connect-timeout 10 --cli-read-timeout 55 "$@"; }

# ── the ACCOUNT binds before anything; neither value is ever echoed ──
EXPECTED="${CBA_EXPECTED_ACCOUNT_ID:-}"
printf '%s' "$EXPECTED" | LC_ALL=C grep -qzE '^[0-9]{12}$' \
  || { echo "REFUSED: CBA_EXPECTED_ACCOUNT_ID is required (12 digits, supplied outside Git); the value is not echoed"; exit 1; }
check_account() { # $1 = when
  local got rc
  set +e; got=$(aws_ sts get-caller-identity --query Account --output text 2>/dev/null); rc=$?; set -e
  [ "$rc" -eq 124 ] && { echo "REFUSED ($1): STS observation exceeded its wall-clock deadline (OBSERVATION_TIMEOUT)"; exit 1; }
  [ "$rc" -eq 0 ] || { echo "REFUSED ($1): STS identity observation failed — nothing was mutated"; exit 1; }
  printf '%s' "$got" | LC_ALL=C grep -qzE '^[0-9]{12}$' \
    || { echo "REFUSED ($1): the STS account is malformed; the value is not echoed"; exit 1; }
  [ "$got" = "$EXPECTED" ] \
    || { echo "REFUSED ($1): the ambient credentials do not belong to the authorized account; neither value is echoed"; exit 1; }
  ACCOUNT="$got"
}
check_account "binding"

# ── the AUTHORIZED SHA binds every reviewed byte this run consumes ──
SHA="${CBA_AUTHORIZED_SHA:-}"
printf '%s' "$SHA" | LC_ALL=C grep -qzE '^[0-9a-f]{40}$' \
  || { echo "REFUSED: CBA_AUTHORIZED_SHA is required (full 40-hex commit SHA)"; exit 1; }
HEAD_SHA=$(git -C "$REPO_ROOT" rev-parse HEAD 2>/dev/null) \
  || { echo "REFUSED: the repository HEAD could not be read"; exit 1; }
[ "$HEAD_SHA" = "$SHA" ] \
  || { echo "REFUSED: HEAD does not match CBA_AUTHORIZED_SHA — run from the authorized commit"; exit 1; }
[ -z "$(git -C "$REPO_ROOT" status --porcelain 2>/dev/null)" ] \
  || { echo "REFUSED: the worktree is dirty — the authorized SHA must be the whole story"; exit 1; }

# ── fresh private render, per phase; nothing is transported between phases ──
TMP=$(mktemp -d /tmp/cba-relboot.XXXXXX)
chmod 700 "$TMP"
trap 'rm -rf "$TMP"' EXIT
canon() { python3 -c '
import json, sys
def c(x):
    if isinstance(x, dict): return {k: c(v) for k, v in sorted(x.items())}
    if isinstance(x, list): return [c(v) for v in x]
    return x
print(json.dumps(c(json.load(open(sys.argv[1])))))' "$1"; }
same_doc() { python3 -c '
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
  git -C "$REPO_ROOT" show "${SHA}:infra/aws/bootstrap/policies/${t}.template.json" > "$raw" 2>/dev/null \
    || { echo "REFUSED: template ${t} could not be read from the authorized SHA"; exit 1; }
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
  local out rc
  set +e; out=$(aws_ "$@" 2>&1); rc=$?; set -e
  if [ "$rc" -eq 124 ] || [ "$rc" -eq 137 ]; then
    echo "REFUSED: observation of ${desc} exceeded its wall-clock deadline (OBSERVATION_TIMEOUT) — nothing was mutated"; exit 1
  fi
  if [ "$rc" -eq 0 ]; then
    grep -q '"NextToken"\|"IsTruncated": true' <<<"$out" \
      && { echo "REFUSED: observation of ${desc} was paginated/truncated — an incomplete read proves nothing"; exit 1; }
    OBS_STATE=EXISTS; OBS_OUT="$out"; return 0
  fi
  if [ -n "$marker" ] && grep -q "$marker" <<<"$out"; then OBS_STATE=ABSENT; OBS_OUT=""; return 0; fi
  echo "REFUSED: observation of ${desc} failed (not a proven absence) — nothing was mutated"; exit 1
}
jqpy() { python3 -c "import json,sys; d=json.load(sys.stdin); $1"; }
pyq() { python3 -c "import json,sys; $1"; }

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
# The LOCAL CDK must be the lockfile's; always npx --no-install. This check lives INSIDE the
# bootstrap phase because the policies phase never executes the CDK at all — not even --version.
CDK_EXPECTED=$(node -p "require('${REPO_ROOT}/infra/aws/package-lock.json').packages['node_modules/aws-cdk'].version" 2>/dev/null) \
  || { echo "REFUSED: the pinned aws-cdk version could not be read from the lockfile"; exit 1; }
CDK_GOT=$( (cd "$REPO_ROOT/infra/aws" && timeout --foreground --kill-after=10 "$CDK_T" npx --no-install cdk --version 2>/dev/null) ) \
  || { echo "REFUSED: the local CDK is not installed or did not answer within its deadline (npx --no-install)"; exit 1; }
case "$CDK_GOT" in "$CDK_EXPECTED"*) : ;; *) echo "REFUSED: the local CDK does not match the lockfile — no mutation is attempted through a drifted toolchain"; exit 1 ;; esac

# The policies are a PRECONDITION here, observed read-only: this phase never creates or alters one.
for name in "${POLICY_NAMES[@]}"; do
  validate_policy "$name" \
    || { echo "REFUSED: policy ${name} is absent — run the 'policies' phase (its own gate) first; this phase never creates policies"; exit 1; }
done
EXEC_ARN="arn:aws:iam::${ACCOUNT}:policy/${EXEC_POLICY}"

# ── THE REVIEWED SNAPSHOT IS THE AUTHORITY (r2-F1): committed bytes, from the authorized SHA ──
git -C "$REPO_ROOT" show "${SHA}:${SNAPSHOT_PATH}" > "$TMP/toolkit.yaml" 2>/dev/null \
  || { echo "REFUSED: the committed bootstrap template snapshot could not be read from the authorized SHA"; exit 1; }
TEMPLATE_SHA=$(sha256sum "$TMP/toolkit.yaml" | cut -d' ' -f1)
set +e
( cd "$REPO_ROOT/infra/aws" && timeout --foreground --kill-after=10 "$CDK_T" npx --no-install cdk bootstrap --show-template > "$TMP/generated.yaml" 2>"$TMP/generated.err" )
RC=$?
set -e
[ "$RC" -eq 124 ] && { echo "REFUSED: cdk bootstrap --show-template exceeded its wall-clock deadline (CDK_TIMEOUT) — nothing was mutated"; exit 1; }
[ "$RC" -eq 0 ] || { echo "REFUSED: cdk bootstrap --show-template failed — nothing was mutated"; exit 1; }
cmp -s "$TMP/toolkit.yaml" "$TMP/generated.yaml" \
  || { echo "REFUSED (TEMPLATE_DRIFT): the locally generated template does not equal the reviewed snapshot byte for byte — a drifted or compromised toolchain must not deploy; nothing was mutated"; exit 1; }
echo "toolkit template: gerado == snapshot revisado, sha256 ${TEMPLATE_SHA}"

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
  python3 "$RESOLVER" "$TMP/toolkit.yaml" "$ACCOUNT" us-east-1 "$QUALIFIER" "$EXEC_ARN" "$TMP/phys.json" > "$TMP/model.json" \
    || { echo "REFUSED (${when}): the expected-state resolver refused the reviewed snapshot"; exit 1; }

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
  local vrc
  set +e
  python3 "${REPO_ROOT}/scripts/lib/bootstrap-readback-validate.py" "$TMP" "$QUALIFIER" "$ACCOUNT" "$EXEC_ARN" "$TOOLKIT" > "$TMP/verdict.txt" 2>&1
  vrc=$?
  set -e
  sed -E 's/[0-9]{12}/ACCOUNT/g' "$TMP/verdict.txt"
  [ "$vrc" -eq 0 ] || { echo "REFUSED (${when}): the live stack diverges from the reviewed template — every divergence is listed above"; exit 1; }
  echo "READ-BACK OK (${when}): conjunto completo de recursos, 5 roles (trust/tags/managed/inline exatos), exec policy exclusiva, SSM, bucket (policy incluida), ECR (lifecycle+policy), KMS (policy+alias) — tudo igual ao snapshot revisado sha256 ${TEMPLATE_SHA}"
}

observe "the toolkit stack" "does not exist" cloudformation describe-stacks --stack-name "$TOOLKIT" --output json
if [ "$OBS_STATE" = "EXISTS" ]; then
  readback "reentrada, zero mutacao"
  echo "BOOTSTRAP OK (${ENV_NAME}): stack ${TOOLKIT} ja existe e validou integralmente — nenhuma mutacao"
  exit 0
fi

check_account "immediately before the first mutation"
set +e
( cd "$REPO_ROOT/infra/aws" && timeout --foreground --kill-after=30 "$BOOT_T" npx --no-install cdk bootstrap "aws://${ACCOUNT}/us-east-1" \
    --qualifier "$QUALIFIER" \
    --toolkit-stack-name "$TOOLKIT" \
    --cloudformation-execution-policies "$EXEC_ARN" \
    --termination-protection \
    --template "$TMP/toolkit.yaml" ) > "$TMP/bootstrap.log" 2>&1
RC=$?
set -e
if [ "$RC" -ne 0 ]; then
  if [ "$RC" -eq 124 ] || [ "$RC" -eq 137 ]; then
    echo "BOOTSTRAP TIMEOUT (wall-clock deadline exceeded) — the result is INDETERMINATE; read-only reconciliation follows and NOTHING is retried:"
  else
    echo "BOOTSTRAP FAILED — read-only reconciliation follows; no retry is attempted:"
  fi
  set +e
  aws_ cloudformation describe-stacks --stack-name "$TOOLKIT" --output json 2>/dev/null \
    | jqpy "s=d['Stacks'][0]; print('stack status:', s['StackStatus'])" 2>/dev/null \
    || echo "stack status: not observable (it may not exist)"
  set -e
  tail -5 "$TMP/bootstrap.log" | mask
  exit 1
fi
readback "read-back, AFTER bootstrap"
echo "BOOTSTRAP OK (${ENV_NAME}): ${TOOLKIT} criado (qualifier ${QUALIFIER}); evidencia acima carrega nomes e digests apenas"
