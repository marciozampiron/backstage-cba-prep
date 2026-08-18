#!/usr/bin/env python3
# Read-back validator for the release toolkit (#111 r2-F1/F2/F4): compares EVERY observed live
# surface against the model resolved from the REVIEWED template snapshot. Never short-circuits —
# an operator sees every divergence at once. Output carries names only; the caller masks digits.
#
# Normalization exists because IAM stores what it MEANS, not what it was sent: a bare account-id
# principal becomes arn:...:root, condition booleans become strings. Both sides pass through the
# SAME normalizer, so the comparison is semantic and the normalizer cannot hide a widening — a
# wildcard, an extra principal or a dropped condition still differs after normalization.
import json
import os
import sys

TMP, QUALIFIER, ACCOUNT, EXEC_ARN, TOOLKIT = sys.argv[1:6]
failures = []


def fail(msg):
    failures.append(msg)


def load(name):
    with open(os.path.join(TMP, name)) as f:
        return json.load(f)


def norm(x):
    if isinstance(x, dict):
        out = {}
        for k, v in sorted(x.items()):
            if k == 'Principal' and isinstance(v, dict):
                v = {pk: norm_principal(pv) for pk, pv in sorted(v.items())}
            elif k == 'Condition':
                v = stringify(v)
            else:
                v = norm(v)
            out[k] = v
        return out
    if isinstance(x, list):
        n = [norm(v) for v in x]
        try:
            return sorted(n, key=lambda e: json.dumps(e, sort_keys=True))
        except TypeError:
            return n
    return x


def norm_principal(v):
    def one(p):
        if isinstance(p, str) and p == ACCOUNT:
            return f'arn:aws:iam::{ACCOUNT}:root'
        return p
    if isinstance(v, list):
        return sorted(one(p) for p in v)
    return one(v)


def stringify(x):
    if isinstance(x, dict):
        return {k: stringify(v) for k, v in sorted(x.items())}
    if isinstance(x, list):
        return sorted((stringify(v) for v in x), key=lambda e: json.dumps(e, sort_keys=True))
    if isinstance(x, bool):
        return 'true' if x else 'false'
    return x


def same(a, b):
    return norm(a) == norm(b)


model = load('model.json')

# 1. The stack itself.
stack = load('obs.stack.json')['Stacks'][0]
if stack['StackStatus'] not in ('CREATE_COMPLETE', 'UPDATE_COMPLETE'):
    fail(f"stack: status {stack['StackStatus']} is not a terminal COMPLETE state")
if stack.get('EnableTerminationProtection') is not True:
    fail('stack: termination protection is not enabled')
if stack.get('RoleARN'):
    fail('stack: an unexpected service role is set')
if stack.get('NotificationARNs'):
    fail('stack: unexpected notification ARNs are set')
params = {p['ParameterKey']: p['ParameterValue'] for p in stack.get('Parameters', [])}
if params.get('Qualifier') != QUALIFIER:
    fail('stack: the Qualifier parameter diverges')
if EXEC_ARN not in params.get('CloudFormationExecutionPolicies', ''):
    fail('stack: the CloudFormationExecutionPolicies parameter does not name the reviewed policy')
if params.get('TrustedAccounts'):
    fail('stack: TrustedAccounts is non-empty — cross-account trust must never exist')

# 2. The stored template equals the reviewed snapshot bytes.
body = load('obs.template.json')['TemplateBody']
with open(os.path.join(TMP, 'toolkit.yaml')) as f:
    snapshot = f.read()
body_text = body if isinstance(body, str) else json.dumps(body)
if body_text.strip() != snapshot.strip():
    fail('template: the stored template diverges from the reviewed snapshot')

# 3. The COMPLETE resource set, both directions, with types and terminal states.
rs = load('obs.resources.json')['StackResourceSummaries']
live = {r['LogicalResourceId']: r['ResourceType'] for r in rs}
for r in rs:
    if not r['ResourceStatus'].endswith('_COMPLETE'):
        fail(f"resources: {r['LogicalResourceId']} is in state {r['ResourceStatus']}")
for lid, t in model['resources'].items():
    if lid not in live:
        fail(f'resources: {lid} is declared by the template but not deployed')
    elif live[lid] != t:
        fail(f'resources: {lid} has type {live[lid]}, template declares {t}')
for lid in live:
    if lid not in model['resources']:
        fail(f'resources: {lid} is deployed but the template declares no such resource')

# 4. The five roles: trust, tags, boundary, path, managed and inline — all exact.
for lid, exp in sorted(model['roles'].items()):
    role = load(f'obs.role.{lid}.json')['Role']
    if role.get('Path') != '/':
        fail(f'{lid}: unexpected path')
    got_boundary = role.get('PermissionsBoundary', {}).get('PermissionsBoundaryArn')
    if got_boundary != exp.get('boundary'):
        fail(f'{lid}: permissions boundary diverges from the template')
    if not same(role['AssumeRolePolicyDocument'], exp['trust']):
        fail(f'{lid}: the trust document diverges from the template')
    got_tags = {t['Key']: t['Value'] for t in role.get('Tags', [])}
    exp_tags = {t['Key']: t['Value'] for t in exp['tags']}
    if got_tags != exp_tags:
        fail(f'{lid}: the tag set diverges from the template')
    attached = sorted(p['PolicyArn'] for p in load(f'obs.attached.{lid}.json')['AttachedPolicies'])
    if attached != exp['managed']:
        fail(f'{lid}: the managed policy set diverges from the template')
    inline_names = sorted(load(f'obs.inline-names.{lid}.json')['PolicyNames'])
    if inline_names != sorted(exp['inline']):
        fail(f'{lid}: the inline policy NAME set diverges from the template')
    else:
        for pname, pdoc in exp['inline'].items():
            got = load(f'obs.inline.{lid}/{pname}.json')['PolicyDocument']
            if not same(got, pdoc):
                fail(f'{lid}: inline policy {pname} diverges from the template')

# 5. The execution policy is attached to the execution role and NOTHING else.
ent = load('obs.exec-entities.json')
exec_role = f'cdk-{QUALIFIER}-cfn-exec-role-{ACCOUNT}-us-east-1'
if [r['RoleName'] for r in ent.get('PolicyRoles', [])] != [exec_role] or ent.get('PolicyUsers') or ent.get('PolicyGroups'):
    fail('exec policy: attached beyond the expected execution role')

# 6. SSM carries the template's own version value.
ssm = load('obs.ssm.json')['Parameter']
if ssm['Value'] != model['ssm']['value']:
    fail(f"ssm: version {ssm['Value']} diverges from the template's {model['ssm']['value']}")

# 7-10. The bucket: encryption (algorithm AND key), versioning, PAB, and its policy.
b = model['bucket']
enc = load('obs.s3-enc.json')['ServerSideEncryptionConfiguration']['Rules'][0]['ApplyServerSideEncryptionByDefault']
if enc.get('SSEAlgorithm') != b['sseAlgorithm']:
    fail('bucket: the SSE algorithm diverges from the template')
if b.get('sseKmsKeyArn') and enc.get('KMSMasterKeyID') != b['sseKmsKeyArn']:
    fail('bucket: the SSE KMS key diverges from the deployed encryption key')
if load('obs.s3-ver.json').get('Status') != b['versioning']:
    fail('bucket: versioning diverges from the template')
pab = load('obs.s3-pab.json')['PublicAccessBlockConfiguration']
if b.get('publicAccessBlock') and any(pab.get(k) is not True for k in b['publicAccessBlock']):
    fail('bucket: the public access block is not fully enabled')
bpol = json.loads(load('obs.s3-policy.json')['Policy'])
if not same(bpol, b['policy']):
    fail('bucket: the bucket policy diverges from the template')

# 11. ECR: exactly what the template declares — mutability, lifecycle, repository policy.
e = model['ecr']
repo = load('obs.ecr.json')['repositories'][0]
if repo.get('imageTagMutability') != e['imageTagMutability']:
    fail('ecr: image tag mutability diverges from the template')
if not same(json.loads(load('obs.ecr-lifecycle.json')['lifecyclePolicyText']), e['lifecycle']):
    fail('ecr: the lifecycle policy diverges from the template')
if not same(json.loads(load('obs.ecr-policy.json')['policyText']), e['policy']):
    fail('ecr: the repository policy diverges from the template')

# 12. KMS, because the default parameterization materializes the key.
if model.get('kms'):
    if load('obs.kms.json')['KeyMetadata'].get('Enabled') is not True:
        fail('kms: the bootstrap key is not enabled')
    kpol = json.loads(load('obs.kms-policy.json')['Policy'])
    if not same(kpol, model['kms']['keyPolicy']):
        fail('kms: the key policy diverges from the template')
    aliases = [a['AliasName'] for a in load('obs.kms-aliases.json')['Aliases']]
    if model['kms']['aliasName'] not in aliases:
        fail('kms: the template alias is absent')

# 13. No stack policy.
if load('obs.stackpolicy.json').get('StackPolicyBody'):
    fail('stack: an unexpected stack policy is present')

for f in failures:
    print(f'DIVERGENCE: {f}')
sys.exit(1 if failures else 0)
