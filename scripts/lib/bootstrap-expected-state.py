#!/usr/bin/env python3
# Expected-state resolver for the REVIEWED CDK bootstrap template (#111 F1/F2/F4).
#
# Input: the committed template snapshot (infra/aws/bootstrap/cdk-bootstrap-template.yaml, read
# from the AUTHORIZED SHA by the caller), the deployment identity (account, region, qualifier,
# execution-policy ARN) and, when available, the deployed physical ids (for values only the live
# stack can name, e.g. the KMS key id). Output: a JSON model of EVERYTHING the template declares
# for the default parameterization this project deploys — the read-back compares live state
# against THIS, so the template stays the single authority and the script can never invent an
# expectation the review did not see.
#
# The resolver implements only the intrinsics this template uses (Ref, Fn::Sub, Fn::If, Fn::Join,
# Fn::Equals, Fn::Not) and REFUSES anything else loudly: an unknown intrinsic means the template
# changed shape, and a changed template must go through review, not through a silent best-effort.
import json
import sys

try:
    import yaml
except ImportError:
    print('REFUSED: python3-yaml is required to resolve the reviewed template', file=sys.stderr)
    sys.exit(2)

NOVALUE = object()


def main():
    if len(sys.argv) not in (6, 7):
        print('usage: bootstrap-expected-state.py <template.yaml> <account> <region> <qualifier> <exec-policy-arn> [physical-ids.json]', file=sys.stderr)
        return 2
    template_path, account, region, qualifier, exec_arn = sys.argv[1:6]
    phys = json.load(open(sys.argv[6])) if len(sys.argv) == 7 else {}
    tpl = yaml.safe_load(open(template_path))

    # The default parameterization this project deploys: everything at template default except
    # the qualifier and the execution policies — exactly the two the script passes on the CLI.
    # CommaDelimitedList parameters are LISTS ("" -> []): Fn::Join over a Ref to one must join
    # its elements, never the characters of a string or the keys of a dict.
    params = {}
    for name, spec in tpl.get('Parameters', {}).items():
        default = spec.get('Default', '')
        if spec.get('Type') == 'CommaDelimitedList':
            params[name] = [] if default == '' else str(default).split(',')
        else:
            params[name] = default
    params['Qualifier'] = qualifier
    params['CloudFormationExecutionPolicies'] = [exec_arn]
    pseudo = {'AWS::AccountId': account, 'AWS::Region': region, 'AWS::Partition': 'aws', 'AWS::NoValue': NOVALUE}

    def cond_eval(node):
        if isinstance(node, bool):
            return node
        if isinstance(node, dict) and len(node) == 1:
            (k, v), = node.items()
            if k == 'Fn::Equals':
                return resolve(v[0]) == resolve(v[1])
            if k == 'Fn::Not':
                return not cond_eval(v[0])
            if k == 'Condition':
                return conditions[v]
        raise SystemExit(f'REFUSED: unsupported condition construct: {node}')

    # Deterministic physical names — the bootstrap's own naming, needed to resolve references.
    bucket_name = f'cdk-{qualifier}-assets-{account}-{region}'
    repo_name = f'cdk-{qualifier}-container-assets-{account}-{region}'
    ref_values = {
        'StagingBucket': bucket_name,
        'ContainerAssetsRepository': repo_name,
        'CdkBootstrapVersion': f'/cdk-bootstrap/{qualifier}/version',
        'FileAssetsBucketEncryptionKey': phys.get('FileAssetsBucketEncryptionKey', 'KMS_KEY_ID_UNKNOWN'),
        # Ref on an AWS::IAM::Role returns the role NAME (the bootstrap's deterministic naming).
        'FilePublishingRole': f'cdk-{qualifier}-file-publishing-role-{account}-{region}',
        'ImagePublishingRole': f'cdk-{qualifier}-image-publishing-role-{account}-{region}',
        'LookupRole': f'cdk-{qualifier}-lookup-role-{account}-{region}',
        'DeploymentActionRole': f'cdk-{qualifier}-deploy-role-{account}-{region}',
        'CloudFormationExecutionRole': f'cdk-{qualifier}-cfn-exec-role-{account}-{region}',
    }
    attr_values = {
        'StagingBucket.Arn': f'arn:aws:s3:::{bucket_name}',
        'StagingBucket.RegionalDomainName': f'{bucket_name}.s3.{region}.amazonaws.com',
        'ContainerAssetsRepository.Arn': f'arn:aws:ecr:{region}:{account}:repository/{repo_name}',
        'FilePublishingRole.Arn': f'arn:aws:iam::{account}:role/cdk-{qualifier}-file-publishing-role-{account}-{region}',
        'CloudFormationExecutionRole.Arn': f'arn:aws:iam::{account}:role/cdk-{qualifier}-cfn-exec-role-{account}-{region}',
        'FileAssetsBucketEncryptionKey.Arn': f"arn:aws:kms:{region}:{account}:key/{phys.get('FileAssetsBucketEncryptionKey', 'KMS_KEY_ID_UNKNOWN')}",
    }

    def sub(text):
        out, i = '', 0
        while True:
            j = text.find('${', i)
            if j < 0:
                return out + text[i:]
            out += text[i:j]
            k = text.index('}', j)
            var = text[j + 2:k]
            if var in pseudo:
                out += str(pseudo[var])
            elif var in params:
                out += str(params[var])
            elif var in attr_values:
                out += str(attr_values[var])
            elif var in ref_values:
                out += str(ref_values[var])
            else:
                raise SystemExit(f'REFUSED: unresolvable Fn::Sub variable ${{{var}}}')
            i = k + 1

    def resolve(node):
        if isinstance(node, dict) and len(node) == 1:
            (k, v), = node.items()
            if k == 'Ref':
                if v in pseudo:
                    return pseudo[v]
                if v in params:
                    return params[v]
                if v in ref_values:
                    return ref_values[v]
                raise SystemExit(f'REFUSED: unresolvable Ref {v}')
            if k == 'Fn::Sub':
                return sub(v) if isinstance(v, str) else NOVALUE
            if k == 'Fn::If':
                name, a, b = v
                return resolve(a) if conditions[name] else resolve(b)
            if k == 'Fn::Join':
                sep, items = v
                items = resolve(items) if isinstance(items, dict) else items
                if not isinstance(items, list):
                    raise SystemExit('REFUSED: Fn::Join over a non-list')
                parts = [resolve(x) for x in items]
                return sep.join(str(p) for p in parts if p is not NOVALUE)
            if k.startswith('Fn::'):
                raise SystemExit(f'REFUSED: unsupported intrinsic {k} — the template changed shape; review it')
        if isinstance(node, dict):
            out = {}
            for k, v in node.items():
                r = resolve(v)
                if r is not NOVALUE:
                    out[k] = r
            return out
        if isinstance(node, list):
            out = []
            for v in node:
                r = resolve(v)
                if r is not NOVALUE:
                    out.append(r)
            return out
        return node

    conditions = {}
    for name, expr in tpl.get('Conditions', {}).items():
        conditions[name] = cond_eval(expr)

    live = {}
    for lid, res in tpl['Resources'].items():
        if 'Condition' in res and not conditions[res['Condition']]:
            continue
        live[lid] = res

    model = {
        'templateVersion': str(tpl['Resources']['CdkBootstrapVersion']['Properties']['Value']),
        'resources': {lid: r['Type'] for lid, r in live.items()},
        'conditionsTrue': sorted(n for n, v in conditions.items() if v),
        'roles': {},
        'bucket': None,
        'ecr': None,
        'kms': None,
        'ssm': {'name': f'/cdk-bootstrap/{qualifier}/version'},
    }
    model['ssm']['value'] = model['templateVersion']

    # Inline policies attached through separate AWS::IAM::Policy resources.
    external_inline = {}
    for lid, res in live.items():
        if res['Type'] != 'AWS::IAM::Policy':
            continue
        p = resolve(res['Properties'])
        for role_ref in res['Properties']['Roles']:
            target = role_ref['Ref']
            external_inline.setdefault(target, {})[p['PolicyName']] = p['PolicyDocument']

    for lid, res in live.items():
        if res['Type'] != 'AWS::IAM::Role':
            continue
        p = resolve(res['Properties'])
        inline = {pol['PolicyName']: pol['PolicyDocument'] for pol in p.get('Policies', [])}
        inline.update(external_inline.get(lid, {}))
        managed = p.get('ManagedPolicyArns', [])
        model['roles'][lid] = {
            'name': p['RoleName'],
            'trust': p['AssumeRolePolicyDocument'],
            'tags': p.get('Tags', []),
            'managed': sorted(managed if isinstance(managed, list) else [managed]),
            'inline': inline,
            'boundary': p.get('PermissionsBoundary'),
        }

    bucket = resolve(live['StagingBucket']['Properties'])
    policy = resolve(live['StagingBucketPolicy']['Properties'])
    sse = bucket['BucketEncryption']['ServerSideEncryptionConfiguration'][0]['ServerSideEncryptionByDefault']
    model['bucket'] = {
        'name': bucket['BucketName'],
        'sseAlgorithm': sse['SSEAlgorithm'],
        'sseKmsKeyArn': sse.get('KMSMasterKeyID'),
        'publicAccessBlock': bucket.get('PublicAccessBlockConfiguration'),
        'versioning': bucket['VersioningConfiguration']['Status'],
        'policy': policy['PolicyDocument'],
    }

    ecr = resolve(live['ContainerAssetsRepository']['Properties'])
    model['ecr'] = {
        'name': ecr['RepositoryName'],
        'imageTagMutability': ecr['ImageTagMutability'],
        'lifecycle': json.loads(ecr['LifecyclePolicy']['LifecyclePolicyText']),
        'policy': ecr['RepositoryPolicyText'],
    }

    if 'FileAssetsBucketEncryptionKey' in live:
        key = resolve(live['FileAssetsBucketEncryptionKey']['Properties'])
        alias = resolve(live['FileAssetsBucketEncryptionKeyAlias']['Properties'])
        model['kms'] = {'keyPolicy': key['KeyPolicy'], 'aliasName': alias['AliasName']}

    json.dump(model, sys.stdout, indent=2, sort_keys=True)
    return 0


if __name__ == '__main__':
    sys.exit(main())
