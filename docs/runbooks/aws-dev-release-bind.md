---
id: aws-dev-release-bind
kind: runbook
version: 0.2.0
owner: Opus # maintains this document only — it authorizes nothing (SPEC-RUN-001)
humanApprover: Zamp
specs: [SPEC-RUN-006, SPEC-RUN-007, SPEC-RUN-009, SPEC-DEPLOY-005, SPEC-DEPLOY-012, SPEC-LANE-001, SPEC-LANE-005, SPEC-LANE-006]
inputs: [the release SHA, a caller-generated correlation id, the dev Environment configuration]
outputs: [the structured binding artifact carrying the exact manifest and its digest, the terminal run record]
gateRequired: false
cloudMutation: false
---

# Runbook — dev release, BIND the release to its manifest and digests

> **Status: DESIGN — BLOCKED ON AN IMPLEMENTATION-PHASE PREREQUISITE.** This runbook cannot be
> executed until the workflow gains the `bind_only` path described below. Round 4 of this
> design's review proved the earlier version could not work and was not safe:
>
> 1. **It could not produce its output.** The manifest is written to `$GITHUB_OUTPUT`, which is
>    neither logged nor uploaded — reading it "from the run log" was impossible.
> 2. **It was not mechanically read-only.** Checking that `CBA_CLOUD_GATE` is absent BEFORE
>    dispatch binds nothing: `dev-stage` reads that mutable Environment variable later, so a
>    value planted during the run would let it prepare change sets. An operator's check cannot
>    constrain a value another actor can change mid-run.
>
> The fix is structural, not procedural, and belongs to the implementation phase:
>
> - **A distinct `bind_only` dispatch path** that terminates after the preflight and is
>   structurally unable to enter any stage that prepares or executes change sets — whatever the
>   Environment holds at any instant of the run (SPEC-LANE-005). The guarantee is the DAG, not a
>   pre-dispatch observation.
> - **A structured uploaded artifact** carrying the exact manifest (release, environment, region,
>   bound context, context digest, assembly digest, stack set) plus the caller's correlation id
>   (SPEC-LANE-006), so evidence is read from an artifact rather than scraped from a log.
>
> Until both exist, this document is a specification of the operation, not an instruction.

Design round 3 found the ordering defect this operation fixes: a `plan_only` cloud authorization
must name the manifest digest, but that digest is produced **inside** the preflight, after
dispatch. Authoring the authorization first was therefore impossible. This read-only operation
produces the manifest FIRST, so Zamp can author an authorization that names its digest
(SPEC-RUN-006, SPEC-DEPLOY-019).

## Preflight

1. The `bind_only` path and the binding artifact exist in the reviewed workflow (SPEC-LANE-005,
   SPEC-LANE-006). Without them this operation does not run at all.
2. The release SHA is a full 40-character ancestor of `main`.
3. A correlation id is generated for THIS request and recorded before dispatch — it is what ties
   the eventual artifact to this decision rather than to a timestamp window (SPEC-RUN-009).
4. No other run of this release is in flight (`release-dev` serializes, SPEC-LANE-002).

## Commands

`PLANNED — not executable` in this phase. Templates:

1. **Zamp** dispatches the binding run, passing the correlation id:

   ```text
   gh workflow run "Release Pilot" --ref main \
     -f release_sha=<full 40-character release SHA> \
     -f mode=bind_only \
     -f correlation_id=<caller-generated id for this request>
   ```

   Expected outcome: the run is queued on the `bind_only` path. No stage that prepares or
   executes change sets exists on that path, so no Environment value can enable one.

2. **Zamp** resolves the run and WAITS for a terminal conclusion — an in-flight run's log is a
   partial file that hashes just as happily as a complete one (SPEC-RUN-009):

   ```text
   gh run list --workflow "Release Pilot" --branch main \
     --json databaseId,headSha,status,conclusion,event \
     --jq '[.[] | select(.event=="workflow_dispatch")]'
   gh run watch <run-id> --exit-status
   ```

   Expected outcome: exactly one candidate whose `headSha` is the release SHA, and a terminal
   `conclusion` of `success`.

3. **Zamp** downloads the structured binding ARTIFACT — not the log — and digests it:

   ```text
   gh run download <run-id> --name binding --dir <evidence-dir>/bind-<run-id>
   sha256sum <evidence-dir>/bind-<run-id>/binding.json
   ```

   Expected outcome: a JSON artifact whose `correlationId` equals the one dispatched, whose
   `releaseSha` equals the request's, and which carries the complete manifest.

4. **Zamp** verifies provenance and correlation BEFORE accepting the artifact as evidence:
   `correlationId` matches, `releaseSha` matches, the run id matches the artifact's, and the run
   conclusion was `success`. Any mismatch stops the operation (Stop condition 2).

5. **Zamp** records the manifest digest the authorization will name, together with the artifact
   digest and the run id.

## Evidence

- The structured binding artifact and its digest, bound to run id, correlation id, release SHA
  and the manifest digest the authorization will name (SPEC-RUN-007, SPEC-RUN-009).
- An `EVENTS.md` entry recording the binding, appended through the normal reviewed flow.
- No secrets, account ids or live ARNs; the manifest carries digests, not raw values.

## Stop conditions

1. The `bind_only` path does not exist in the reviewed workflow — stop; this operation has no
   safe execution without it, and no procedure substitutes a structural guarantee.
2. The correlation id, release SHA or run id in the artifact does not match the request, or the
   run's conclusion is not `success` — stop; evidence that cannot be tied to THIS request, from
   a run that finished, is not evidence.
3. The run has no terminal conclusion yet — wait; never hash an in-flight log or a partial
   artifact.
4. The artifact is absent or its manifest is incomplete — stop; there is no manifest to bind.

## Rollback

Nothing to roll back: no cloud state changed. A superseded binding is simply replaced by a new
binding run for the same or a newer release SHA.

## Cleanup

- The evidence artifact is retained; temporary copies are removed.
- Nothing is set or cleared on the Environment by this operation.
