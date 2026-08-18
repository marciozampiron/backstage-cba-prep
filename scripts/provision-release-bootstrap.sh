#!/usr/bin/env bash
# Operator-managed provisioning of a tier's RELEASE BOOTSTRAP (#111) — Zamp runs this, per phase.
#
# TWO MUTUALLY EXCLUSIVE PHASES, one gate each (Codex IMPLEMENTATION_REQUEST, 2026-08-18):
#   provision-release-bootstrap.sh <dev|pilot> policies   — observe/create the three operator
#     policies; NEVER runs CDK or CloudFormation.
#   provision-release-bootstrap.sh <dev|pilot> bootstrap  — re-observes the policies (read-only),
#     creates/revalidates the CDK release toolkit; NEVER creates or alters a policy.
# No "all" mode, no default, no chaining: each invocation ends explicitly and the next phase
# requires its own human gate.
#
# OBSERVE-THEN-ACT throughout: the account binds first (CBA_EXPECTED_ACCOUNT_ID, supplied outside
# Git, never echoed) and is RE-CHECKED immediately before the first mutation; templates render
# fresh in EACH phase from the AUTHORIZED SHA (CBA_AUTHORIZED_SHA — must equal HEAD of a clean
# worktree), into a private 0700 mktemp dir that a trap removes; only a PROVEN absence may create
# (IAM NoSuchEntity; CloudFormation "does not exist"); any pre-existing divergence refuses with
# zero mutation; failures reconcile READ-ONLY and stop — never a blind retry. Evidence carries
# names and digests only — never an account id or ARN.
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
mask() { sed -E 's/[0-9]{12}/ACCOUNT/g'; }

# ── the ACCOUNT binds before anything; neither value is ever echoed ──
EXPECTED="${CBA_EXPECTED_ACCOUNT_ID:-}"
printf '%s' "$EXPECTED" | LC_ALL=C grep -qzE '^[0-9]{12}$' \
  || { echo "REFUSED: CBA_EXPECTED_ACCOUNT_ID is required (12 digits, supplied outside Git); the value is not echoed"; exit 1; }
check_account() { # $1 = when
  local got
  got=$(aws sts get-caller-identity --query Account --output text 2>/dev/null) \
    || { echo "REFUSED ($1): STS identity observation failed — nothing was mutated"; exit 1; }
  printf '%s' "$got" | LC_ALL=C grep -qzE '^[0-9]{12}$' \
    || { echo "REFUSED ($1): the STS account is malformed; the value is not echoed"; exit 1; }
  [ "$got" = "$EXPECTED" ] \
    || { echo "REFUSED ($1): the ambient credentials do not belong to the authorized account; neither value is echoed"; exit 1; }
  ACCOUNT="$got"
}
check_account "binding"

# ── the AUTHORIZED SHA binds the bytes this run renders and executes ──
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

# ── observe(desc, aws...): EXISTS, ABSENT only on the service's proven marker, else REFUSE ──
OBS_STATE=""; OBS_OUT=""
observe() { # $1 desc, $2 absence-marker regex, rest = command
  local desc="$1" marker="$2"; shift 2
  local out rc
  set +e; out=$("$@" 2>&1); rc=$?; set -e
  if [ "$rc" -eq 0 ]; then
    grep -q '"NextToken"\|"IsTruncated": true' <<<"$out" \
      && { echo "REFUSED: observation of ${desc} was paginated/truncated — an incomplete read proves nothing"; exit 1; }
    OBS_STATE=EXISTS; OBS_OUT="$out"; return 0
  fi
  if [ -n "$marker" ] && grep -q "$marker" <<<"$out"; then OBS_STATE=ABSENT; OBS_OUT=""; return 0; fi
  echo "REFUSED: observation of ${desc} failed (not a proven absence) — nothing was mutated"; exit 1
}
jqpy() { python3 -c "import json,sys; d=json.load(sys.stdin); $1"; }

# ── full policy validation: name, path, ARN account, default version, document, version set ──
validate_policy() { # $1 name; requires rendered $TMP; refuses on ANY divergence
  local name="$1" t arn ver
  t="$(TEMPLATE_OF "$name")"
  arn="arn:aws:iam::${ACCOUNT}:policy/${name}"
  observe "policy ${name}" "NoSuchEntity" aws iam get-policy --policy-arn "$arn" --output json
  [ "$OBS_STATE" = "EXISTS" ] || return 1   # caller decides what absence means
  printf '%s' "$OBS_OUT" | jqpy "p=d['Policy']; sys.exit(0 if p['PolicyName']=='${name}' and p['Path']=='/' and p['Arn']=='${arn}' else 1)" \
    || { echo "REFUSED: policy ${name} exists but its identity (name/path/arn) diverges — zero mutation performed"; exit 1; }
  ver=$(printf '%s' "$OBS_OUT" | jqpy "print(d['Policy']['DefaultVersionId'])")
  observe "policy versions of ${name}" "" aws iam list-policy-versions --policy-arn "$arn" --output json
  printf '%s' "$OBS_OUT" | jqpy "vs=d['Versions']; sys.exit(0 if len(vs)==1 and vs[0]['IsDefaultVersion'] and vs[0]['VersionId']=='${ver}' else 1)" \
    || { echo "REFUSED: policy ${name} carries a version set beyond the single reviewed default — zero mutation performed"; exit 1; }
  observe "policy document of ${name}" "" aws iam get-policy-version --policy-arn "$arn" --version-id "$ver" --output json
  local got
  got=$(printf '%s' "$OBS_OUT" | jqpy "print(json.dumps(d['PolicyVersion']['Document']))")
  same_doc "$got" "$(cat "$TMP/$t.canon")" \
    || { echo "REFUSED: policy ${name} diverges from the reviewed template — zero mutation performed"; exit 1; }
  return 0
}

# ════════════════════════════ PHASE: policies ════════════════════════════
if [ "$PHASE" = "policies" ]; then
  ABSENT=(); PRESENT=()
  for name in "${POLICY_NAMES[@]}"; do
    if validate_policy "$name"; then PRESENT+=("$name"); else ABSENT+=("$name"); fi
  done
  if [ "${#ABSENT[@]}" -eq 0 ]; then
    echo "POLICIES OK (${ENV_NAME}): as tres policies existem e sao semanticamente identicas — reentrada, zero mutacao"
    echo "PROXIMA FASE: 'bootstrap' exige o seu proprio gate; nada de CDK correu nesta fase"
    exit 0
  fi
  # Every EXISTING one already validated above (any divergence refused before this line), so the
  # only reachable composition here is "all present ones clean + these provably absent".
  check_account "immediately before the first mutation"
  CREATED=(); FAILED=""
  for name in "${ABSENT[@]}"; do
    t="$(TEMPLATE_OF "$name")"
    if aws iam create-policy --policy-name "$name" --policy-document "file://$TMP/$t.json" >/dev/null 2>&1; then
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
CDK_GOT=$( (cd "$REPO_ROOT/infra/aws" && npx --no-install cdk --version 2>/dev/null) ) \
  || { echo "REFUSED: the local CDK is not installed (npx --no-install) — run npm ci in infra/aws first"; exit 1; }
case "$CDK_GOT" in "$CDK_EXPECTED"*) : ;; *) echo "REFUSED: the local CDK does not match the lockfile — no mutation is attempted through a drifted toolchain"; exit 1 ;; esac

# The policies are a PRECONDITION here, observed read-only: this phase never creates or alters one.
for name in "${POLICY_NAMES[@]}"; do
  validate_policy "$name" \
    || { echo "REFUSED: policy ${name} is absent — run the 'policies' phase (its own gate) first; this phase never creates policies"; exit 1; }
done
EXEC_ARN="arn:aws:iam::${ACCOUNT}:policy/${EXEC_POLICY}"

# Generate the toolkit template LOCALLY and validate it; the SAME bytes deploy via --template.
( cd "$REPO_ROOT/infra/aws" && npx --no-install cdk bootstrap --show-template > "$TMP/toolkit.yaml" 2>"$TMP/toolkit.err" ) \
  || { echo "REFUSED: cdk bootstrap --show-template failed — nothing was mutated"; exit 1; }
[ -s "$TMP/toolkit.yaml" ] || { echo "REFUSED: the generated toolkit template is empty"; exit 1; }
grep -qE '\b[0-9]{12}\b' "$TMP/toolkit.yaml" && { echo "REFUSED: the generated template embeds a literal account id"; exit 1; }
# Closed expectation: the modern bootstrap's core resources, by logical id (derived checks below
# use the FULL template-declared set; this list is the floor that must deploy).
CORE_IDS=(StagingBucket ContainerAssetsRepository FilePublishingRole ImagePublishingRole LookupRole DeploymentActionRole CloudFormationExecutionRole CdkBootstrapVersion)
for id in "${CORE_IDS[@]}"; do
  grep -qE "^  ${id}:" "$TMP/toolkit.yaml" \
    || { echo "REFUSED: the generated template lacks core resource ${id} — not a bootstrap template this design knows"; exit 1; }
done
# The template's own Resources section, as "LogicalId Type" pairs, for the closed-set comparison.
awk '/^Resources:/{f=1; next} f && /^[A-Za-z]/{f=0} f && /^  [A-Za-z0-9]+:$/{id=$1; sub(/:$/,"",id)} f && /^    Type: /{print id, $2}' \
  "$TMP/toolkit.yaml" | sort > "$TMP/template-resources"
TEMPLATE_SHA=$(sha256sum "$TMP/toolkit.yaml" | cut -d' ' -f1)
echo "toolkit template gerado e validado: sha256 ${TEMPLATE_SHA}"

readback() { # full read-back of the deployed toolkit; refuses on ANY divergence
  local when="$1" stack body bucket repo
  observe "the toolkit stack (${when})" "does not exist" aws cloudformation describe-stacks --stack-name "$TOOLKIT" --output json
  [ "$OBS_STATE" = "EXISTS" ] || { echo "REFUSED (${when}): the toolkit stack is not observable"; exit 1; }
  stack="$OBS_OUT"
  printf '%s' "$stack" | jqpy "s=d['Stacks'][0]; sys.exit(0 if s['StackStatus'] in ('CREATE_COMPLETE','UPDATE_COMPLETE') else 1)" \
    || { echo "REFUSED (${when}): the toolkit stack is not in a terminal COMPLETE state"; exit 1; }
  printf '%s' "$stack" | jqpy "s=d['Stacks'][0]; sys.exit(0 if s.get('EnableTerminationProtection') is True else 1)" \
    || { echo "REFUSED (${when}): termination protection is not enabled"; exit 1; }
  printf '%s' "$stack" | jqpy "s=d['Stacks'][0]; sys.exit(1 if s.get('RoleARN') else 0)" \
    || { echo "REFUSED (${when}): the stack carries an unexpected service role"; exit 1; }
  printf '%s' "$stack" | jqpy "s=d['Stacks'][0]; sys.exit(0 if not s.get('NotificationARNs') else 1)" \
    || { echo "REFUSED (${when}): the stack carries unexpected notification ARNs"; exit 1; }
  printf '%s' "$stack" | jqpy "
s=d['Stacks'][0]; ps={p['ParameterKey']: p['ParameterValue'] for p in s.get('Parameters',[])}
ok = ps.get('Qualifier')=='${QUALIFIER}' and '${EXEC_POLICY}' in ps.get('CloudFormationExecutionPolicies','') and not ps.get('TrustedAccounts')
sys.exit(0 if ok else 1)" \
    || { echo "REFUSED (${when}): the stack parameters diverge (qualifier, execution policy or trust)"; exit 1; }

  observe "the stored template (${when})" "" aws cloudformation get-template --stack-name "$TOOLKIT" --output json
  printf '%s' "$OBS_OUT" | jqpy "
b=d['TemplateBody']
b = b if isinstance(b,str) else json.dumps(b)
expected = open('$TMP/toolkit.yaml').read()
sys.exit(0 if b.strip() == expected.strip() else 1)" \
    || { echo "REFUSED (${when}): the stored template diverges from the generated, validated bytes"; exit 1; }

  observe "the stack resources (${when})" "" aws cloudformation list-stack-resources --stack-name "$TOOLKIT" --output json
  printf '%s' "$OBS_OUT" > "$TMP/resources.json"
  jqpy "
rs=d['StackResourceSummaries']
bad=[r['LogicalResourceId'] for r in rs if not r['ResourceStatus'].endswith('_COMPLETE')]
sys.exit(0 if not bad else 1)" < "$TMP/resources.json" \
    || { echo "REFUSED (${when}): a stack resource is not in a COMPLETE state"; exit 1; }
  python3 - "$TMP/resources.json" "$TMP/template-resources" <<'PYEOF' \
    || { echo "REFUSED (${when}): the deployed resource set diverges from the template's closed set"; exit 1; }
import json, sys
rs = {r['LogicalResourceId']: r['ResourceType'] for r in json.load(open(sys.argv[1]))['StackResourceSummaries']}
tpl = dict(line.split() for line in open(sys.argv[2]).read().splitlines())
core = ['StagingBucket','ContainerAssetsRepository','FilePublishingRole','ImagePublishingRole','LookupRole','DeploymentActionRole','CloudFormationExecutionRole','CdkBootstrapVersion']
extra = [i for i, t in rs.items() if tpl.get(i) != t]
missing = [i for i in core if i not in rs]
sys.exit(0 if not extra and not missing else 1)
PYEOF

  # The five bootstrap roles: trust, boundary, path, tags, inline and managed policies.
  local role arn5 trustdoc
  for role in deploy file-publishing image-publishing lookup cfn-exec; do
    arn5="cdk-${QUALIFIER}-${role}-role-${ACCOUNT}-us-east-1"
    observe "role ${role} (${when})" "NoSuchEntity" aws iam get-role --role-name "$arn5" --output json
    [ "$OBS_STATE" = "EXISTS" ] || { echo "REFUSED (${when}): bootstrap role cdk-${QUALIFIER}-${role} is absent"; exit 1; }
    printf '%s' "$OBS_OUT" | jqpy "r=d['Role']; sys.exit(0 if r['Path']=='/' and not r.get('PermissionsBoundary') else 1)" \
      || { echo "REFUSED (${when}): bootstrap role cdk-${QUALIFIER}-${role} carries an unexpected path or boundary"; exit 1; }
    trustdoc=$(printf '%s' "$OBS_OUT" | jqpy "print(json.dumps(d['Role']['AssumeRolePolicyDocument']))")
    if [ "$role" = "cfn-exec" ]; then
      printf '%s' "$trustdoc" | jqpy "
ss=d['Statement']; ok=all(s.get('Principal',{}).get('Service')=='cloudformation.amazonaws.com' for s in ss)
sys.exit(0 if ok and ss else 1)" \
        || { echo "REFUSED (${when}): the execution role trusts something beyond CloudFormation"; exit 1; }
    else
      printf '%s' "$trustdoc" | jqpy "
import re
flat=json.dumps(d)
foreign=[m for m in re.findall(r'arn:aws:iam::([0-9]{12}):', flat) if m != '${ACCOUNT}']
sys.exit(0 if not foreign and 'cloudformation.amazonaws.com' not in flat else 1)" \
        || { echo "REFUSED (${when}): role cdk-${QUALIFIER}-${role} trusts a foreign account — --trust must never have run"; exit 1; }
    fi
    observe "attached policies of ${role} (${when})" "" aws iam list-attached-role-policies --role-name "$arn5" --output json
    if [ "$role" = "cfn-exec" ]; then
      printf '%s' "$OBS_OUT" | jqpy "
aps=d['AttachedPolicies']; sys.exit(0 if [p['PolicyArn'] for p in aps]==['${EXEC_ARN}'] else 1)" \
        || { echo "REFUSED (${when}): the execution role's managed policies are not exactly the reviewed release policy"; exit 1; }
    else
      printf '%s' "$OBS_OUT" | jqpy "sys.exit(0 if not d['AttachedPolicies'] else 1)" \
        || { echo "REFUSED (${when}): role cdk-${QUALIFIER}-${role} carries unexpected managed policies"; exit 1; }
    fi
    observe "inline policies of ${role} (${when})" "" aws iam list-role-policies --role-name "$arn5" --output json
    for p in $(printf '%s' "$OBS_OUT" | jqpy "print(' '.join(d['PolicyNames']))"); do
      observe "inline ${p} of ${role} (${when})" "" aws iam get-role-policy --role-name "$arn5" --policy-name "$p" --output json
    done
  done

  # The release execution policy is attached to the execution role and NOTHING else.
  observe "policy attachments (${when})" "" aws iam list-entities-for-policy --policy-arn "$EXEC_ARN" --output json
  printf '%s' "$OBS_OUT" | jqpy "
ok = [r['RoleName'] for r in d.get('PolicyRoles',[])]==['cdk-${QUALIFIER}-cfn-exec-role-${ACCOUNT}-us-east-1'] \
     and not d.get('PolicyUsers') and not d.get('PolicyGroups')
sys.exit(0 if ok else 1)" \
    || { echo "REFUSED (${when}): the release execution policy is attached beyond the expected execution role"; exit 1; }

  observe "the bootstrap version parameter (${when})" "ParameterNotFound" aws ssm get-parameter --name "/cdk-bootstrap/${QUALIFIER}/version" --output json
  [ "$OBS_STATE" = "EXISTS" ] || { echo "REFUSED (${when}): /cdk-bootstrap/${QUALIFIER}/version is absent"; exit 1; }
  printf '%s' "$OBS_OUT" | jqpy "sys.exit(0 if d['Parameter']['Value'].isdigit() else 1)" \
    || { echo "REFUSED (${when}): the bootstrap version parameter is not numeric"; exit 1; }

  bucket=$(printf '%s' "$stack" | jqpy "
s=d['Stacks'][0]; outs={o['OutputKey']: o['OutputValue'] for o in s.get('Outputs',[])}
print(outs.get('BucketName',''))")
  [ -n "$bucket" ] || { echo "REFUSED (${when}): the stack outputs no BucketName"; exit 1; }
  observe "bucket encryption (${when})" "" aws s3api get-bucket-encryption --bucket "$bucket" --output json
  printf '%s' "$OBS_OUT" | jqpy "sys.exit(0 if d['ServerSideEncryptionConfiguration']['Rules'] else 1)" \
    || { echo "REFUSED (${when}): the assets bucket has no server-side encryption"; exit 1; }
  observe "bucket versioning (${when})" "" aws s3api get-bucket-versioning --bucket "$bucket" --output json
  printf '%s' "$OBS_OUT" | jqpy "sys.exit(0 if d.get('Status')=='Enabled' else 1)" \
    || { echo "REFUSED (${when}): the assets bucket versioning is not Enabled"; exit 1; }
  observe "bucket ownership (${when})" "" aws s3api get-bucket-ownership-controls --bucket "$bucket" --output json
  printf '%s' "$OBS_OUT" | jqpy "sys.exit(0 if d['OwnershipControls']['Rules'] else 1)" \
    || { echo "REFUSED (${when}): the assets bucket has no ownership controls"; exit 1; }
  observe "bucket public access block (${when})" "" aws s3api get-public-access-block --bucket "$bucket" --output json
  printf '%s' "$OBS_OUT" | jqpy "
c=d['PublicAccessBlockConfiguration']
sys.exit(0 if all(c.get(k) is True for k in ('BlockPublicAcls','BlockPublicPolicy','IgnorePublicAcls','RestrictPublicBuckets')) else 1)" \
    || { echo "REFUSED (${when}): the assets bucket public access block is not fully enabled"; exit 1; }

  repo=$(jqpy "
rs={r['LogicalResourceId']: r.get('PhysicalResourceId','') for r in d['StackResourceSummaries']}
print(rs.get('ContainerAssetsRepository',''))" < "$TMP/resources.json")
  [ -n "$repo" ] || { echo "REFUSED (${when}): the container assets repository has no physical id"; exit 1; }
  observe "the container repository (${when})" "" aws ecr describe-repositories --repository-names "$repo" --output json
  printf '%s' "$OBS_OUT" | jqpy "
r=d['repositories'][0]
ok = r.get('encryptionConfiguration') and r.get('imageTagMutability')=='IMMUTABLE' and r.get('imageScanningConfiguration',{}).get('scanOnPush') is True
sys.exit(0 if ok else 1)" \
    || { echo "REFUSED (${when}): the container repository diverges (encryption, tag mutability or scanning)"; exit 1; }
  observe "the repository lifecycle policy (${when})" "" aws ecr get-lifecycle-policy --repository-name "$repo" --output json
  observe "the repository policy (${when})" "" aws ecr get-repository-policy --repository-name "$repo" --output json

  # KMS only when the template materialized a key in THIS deployment.
  if grep -qE '^\S+ AWS::KMS::Key$' <(jqpy "
for r in d['StackResourceSummaries']: print(r['LogicalResourceId'], r['ResourceType'])" < "$TMP/resources.json"); then
    local keyid
    keyid=$(jqpy "
rs={r['ResourceType']: r.get('PhysicalResourceId','') for r in d['StackResourceSummaries']}
print(rs.get('AWS::KMS::Key',''))" < "$TMP/resources.json")
    observe "the bootstrap KMS key (${when})" "" aws kms describe-key --key-id "$keyid" --output json
    printf '%s' "$OBS_OUT" | jqpy "sys.exit(0 if d['KeyMetadata'].get('Enabled') is True else 1)" \
      || { echo "REFUSED (${when}): the bootstrap KMS key is not enabled"; exit 1; }
  fi

  observe "the stack policy (${when})" "" aws cloudformation get-stack-policy --stack-name "$TOOLKIT" --output json
  printf '%s' "$OBS_OUT" | jqpy "sys.exit(1 if d.get('StackPolicyBody') else 0)" \
    || { echo "REFUSED (${when}): an unexpected stack policy is present"; exit 1; }

  echo "READ-BACK OK (${when}): stack COMPLETE com termination protection, template identico (sha256 ${TEMPLATE_SHA}), conjunto fechado de recursos, 5 roles validados (trust/attach), exec policy anexada somente ao execution role, SSM versionado, bucket blindado, ECR imutavel"
}

observe "the toolkit stack" "does not exist" aws cloudformation describe-stacks --stack-name "$TOOLKIT" --output json
if [ "$OBS_STATE" = "EXISTS" ]; then
  readback "reentrada, zero mutacao"
  echo "BOOTSTRAP OK (${ENV_NAME}): stack ${TOOLKIT} ja existe e validou integralmente — nenhuma mutacao"
  exit 0
fi

check_account "immediately before the first mutation"
set +e
( cd "$REPO_ROOT/infra/aws" && npx --no-install cdk bootstrap "aws://${ACCOUNT}/us-east-1" \
    --qualifier "$QUALIFIER" \
    --toolkit-stack-name "$TOOLKIT" \
    --cloudformation-execution-policies "$EXEC_ARN" \
    --termination-protection \
    --template "$TMP/toolkit.yaml" ) > "$TMP/bootstrap.log" 2>&1
RC=$?
set -e
if [ "$RC" -ne 0 ]; then
  echo "BOOTSTRAP FAILED — read-only reconciliation follows; no retry is attempted:"
  set +e
  aws cloudformation describe-stacks --stack-name "$TOOLKIT" --output json 2>/dev/null \
    | jqpy "s=d['Stacks'][0]; print('stack status:', s['StackStatus'])" 2>/dev/null \
    || echo "stack status: not observable (it may not exist)"
  set -e
  tail -5 "$TMP/bootstrap.log" | mask
  exit 1
fi
readback "read-back, AFTER bootstrap"
echo "BOOTSTRAP OK (${ENV_NAME}): ${TOOLKIT} criado (qualifier ${QUALIFIER}); evidencia acima carrega nomes e digests apenas"
