---
id: aws-dev-release-bind
kind: runbook
version: 0.1.0
owner: Opus # maintains this document only — it authorizes nothing (SPEC-RUN-001)
humanApprover: Zamp
specs: [SPEC-RUN-006, SPEC-RUN-007, SPEC-DEPLOY-005, SPEC-DEPLOY-012, SPEC-LANE-001]
inputs: [the release SHA, the dev Environment configuration, the assurance that no cloud authorization is set]
outputs: [the release's manifest with its contextDigest and assemblyDigest, the run id and its evidence artifact]
gateRequired: false
cloudMutation: false
---

# Runbook — dev release, BIND the release to its manifest and digests

> **Status: DESIGN — `PLANNED — not executable`.** Nothing here runs in the current phase.

Design round 3 found the ordering defect this runbook fixes: a `plan_only` cloud authorization
must name the `assemblyDigest`, but that digest is produced **inside** `dev-preflight`, after
dispatch. Authoring the authorization first was therefore impossible. This read-only operation
produces the digest FIRST, so Zamp can author an authorization that names it (SPEC-RUN-006).

**Why it mutates nothing.** The run is dispatched with NO cloud authorization set. Synthesis is
credential-free (SPEC-LANE-001); `dev-preflight` performs read-only AWS calls and emits the
manifest; `dev-stage` assumes the deploy role and then **refuses at the authorization check**,
which happens before any child process exists — no change set is created, no asset is published.
The refusal is the expected outcome, not a failure.

## Preflight

1. The release SHA is a full 40-character ancestor of `main`.
2. The dev Environment's `CBA_CLOUD_GATE` variable is **absent or empty**. If a value from an
   earlier decision is still set, this operation is not run — clear it first (that is the prior
   decision's Cleanup step, performed by Zamp).
3. No other run of this release is in flight (`release-dev` serializes, SPEC-LANE-002).

## Commands

`PLANNED — not executable` in this phase. Templates:

1. **Zamp** confirms no cloud authorization is set:

   ```text
   gh api repos/<owner>/<repo>/environments/dev/variables/CBA_CLOUD_GATE
   ```

   Expected outcome: HTTP 404, or a variable whose value is empty. Anything else stops here.

2. **Zamp** dispatches the binding run and records the dispatch instant:

   ```text
   date -u +%Y-%m-%dT%H:%M:%SZ            # the dispatch instant, recorded before dispatching
   gh workflow run "Release Pilot" --ref main \
     -f release_sha=<full 40-character release SHA> \
     -f mode=dev_only
   ```

   Expected outcome: the run is queued. Dispatch does not return a run id, which is why the
   instant is recorded — step 3 resolves the id deterministically from it.

3. **Zamp** resolves the run id, requiring exactly one match (SPEC-RUN-007):

   ```text
   gh run list --workflow "Release Pilot" --branch main \
     --json databaseId,headSha,createdAt,event \
     --jq '[.[] | select(.event=="workflow_dispatch" and .createdAt >= "<dispatch instant>")]'
   ```

   Expected outcome: exactly one entry. Zero or more than one stops the operation
   (Stop condition 2) — a misattributed run id would bind the wrong evidence.

4. **Zamp** captures the COMPLETE run log as the evidence artifact and digests it:

   ```text
   gh run view <run-id> --log > <evidence-dir>/bind-<run-id>.log
   sha256sum <evidence-dir>/bind-<run-id>.log
   ```

   Expected outcome: the full log — never an excerpt — plus its digest.

5. **Zamp** reads the manifest from the `dev-preflight` job output in that artifact, and records
   `contextDigest`, `assemblyDigest` and the resolved release OID. Expected outcome: the values
   the plan authorization will name.

## Evidence

- The complete run log artifact and its digest, bound to: run id, release SHA, and the manifest's
  `contextDigest` and `assemblyDigest`.
- An `EVENTS.md` entry recording the binding — release SHA, run id, digests — appended through
  the normal reviewed flow.
- No secrets, account ids or live ARNs; the manifest carries digests, not raw values.

## Stop conditions

1. A `CBA_CLOUD_GATE` value is set — stop; this operation must run with no cloud authorization
   in place, or it is no longer read-only in intent.
2. The run id does not resolve to exactly one entry — stop; evidence that cannot be bound to one
   run is not evidence.
3. `dev-stage` refuses with anything other than the missing-authorization code — stop; a
   different refusal means the release does not bind, and the cause is investigated first.
4. Any run-level failure before `dev-preflight` completes — stop; there is no manifest to bind.

## Rollback

Nothing to roll back: no cloud state changed. A superseded binding is simply replaced by a new
binding run for the same or a newer release SHA.

## Cleanup

- The evidence artifact is retained; temporary copies are removed.
- Nothing is set or cleared on the Environment by this operation.
