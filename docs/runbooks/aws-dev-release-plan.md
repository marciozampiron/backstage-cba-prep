---
id: aws-dev-release-plan
kind: runbook
version: 0.14.0
owner: Opus # maintains this document only — it authorizes nothing (SPEC-RUN-001)
humanApprover: Zamp
specs: [SPEC-DEPLOY-001, SPEC-DEPLOY-003, SPEC-DEPLOY-005, SPEC-DEPLOY-006, SPEC-DEPLOY-009, SPEC-DEPLOY-010, SPEC-DEPLOY-011, SPEC-DEPLOY-012, SPEC-DEPLOY-013, SPEC-DEPLOY-014, SPEC-DEPLOY-015, SPEC-LANE-001, SPEC-LANE-003, SPEC-RUN-002, SPEC-RUN-005, SPEC-RUN-006, SPEC-RUN-007, SPEC-RUN-009, SPEC-DEPLOY-019, SPEC-LANE-006, SPEC-LANE-007]
inputs: [the release SHA, the binding artifact's manifest digest, the wave's stack group, a fresh decisionId, a caller-generated correlation id, Zamp's plan_only cloud authorization value]
outputs: [prepared change sets for the wave, the PLAN_DIGEST, the complete evidence artifact bound to run id and decision]
gateRequired: true
cloudMutation: true
---

# Runbook — dev release, PLAN one wave

> **Status: EVIDENCE PREREQUISITES IMPLEMENTED (Slice I3) — STILL `PLANNED — not executable`.**
> The structured plan artifact now EXISTS in the reviewed tree: the entrypoint writes the closed
> evidence record (`--artifact-out`, correlation-bound, change sets by NAME, honest partial on
> every halt) and the lane uploads it as `plan` after the credential scrub closes the window.
> What keeps this runbook non-executable is the lane's activation prerequisites and the absence
> of publication. This operation is CLOUD MUTATION even though no stack executes: preparing
> change sets creates CloudFormation resources and publishes assets (SPEC-RUN-002). Its
> authorization instrument is the **cloud authorization** (`CBA_CLOUD_GATE`, `plan_only`), never
> the publication one.

One operation: prepare ONE wave's change sets and put the plan on the record.

## Preflight

1. The shared preflight of the [index](aws-dev-release.md) holds.
2. The [binding runbook](aws-dev-release-bind.md) has produced this release's binding artifact
   and its MANIFEST DIGEST (SPEC-RUN-006). The authorization cannot be authored before it: the
   digest covers the complete closed manifest, which only a run produces (SPEC-DEPLOY-019).
3. Zamp has issued the `plan_only` value for THIS decision — mode `plan_only`, which authorizes
   `prepare-change-sets` and NOTHING else (`spec/authority-policy.json`), the manifest digest,
   the wave's stack group, fresh `decisionId`, `planDigest: null`, `approvedAt`/`expiresAt`
   window of at most one hour (SPEC-DEPLOY-009/010/011/019).
3a. A correlation id is generated for THIS dispatch with a CSPRNG
   (`cba-70-$(openssl rand -hex 16)`, matching `^cba-70-[0-9a-f]{32}$`) and recorded before it;
   the run name that carries it is `cba-release <mode> <correlationId>` (SPEC-LANE-006).
4. No value from a previous decision is still set on the Environment (that decision's Cleanup
   completed).

## Commands

`PLANNED — not executable` in this phase. Templates:

1. **Zamp** sets the cloud authorization on the dev Environment (repository administration and a
   cloud instrument — both outside Opus's policy capabilities):

   ```text
   gh api -X PATCH repos/marciozampiron/backstage-cba-prep/environments/dev/variables/CBA_CLOUD_GATE \
     -f name=CBA_CLOUD_GATE \
     -f value='<the plan_only JSON for this decision>'
   ```

   Expected outcome: the variable holds exactly this decision's value.

2. **Zamp** records the dispatch instant and dispatches the lane — `prepare-change-sets` is a
   cloud effect, performed by Zamp:

   ```text
   gh workflow run release-pilot.yml --repo marciozampiron/backstage-cba-prep --ref main \
     -f release_sha=<full 40-character release SHA> \
     -f mode=dev_only \
     -f correlation_id=<caller-generated id for this decision>
   ```

   Expected outcome: the run is queued. Synthesis runs credential-free first (SPEC-LANE-001);
   the entrypoint prepares the wave's named change sets, validates every service page
   (SPEC-DEPLOY-005/012/013) and emits `PLAN_DIGEST` with the redacted rendering
   (SPEC-DEPLOY-003/006/014). Nothing executes.

3. **Zamp** resolves the run and WAITS for a terminal conclusion — a timestamp window selects a
   run, it does not prove which request produced it, and an in-flight log hashes as happily as a
   complete one (SPEC-RUN-009):

   Run [the canonical resolution helper](README.md#resolving-a-run):

   ```bash
   RUN_ID=$(node bin/resolve-run.mjs --title "cba-release dev_only ${CORRELATION_ID}")
   ```

   Expected outcome: the helper prints exactly one run id, and only after re-observing that same
   single id past the terminal conclusion — its ten bounded attempts, the equality match, the
   duplicate stops (immediate AND late) and the post-terminal re-check are implemented and
   test-proven in the helper, not restated here (SPEC-LANE-007). Every deviation stops with a
   named code on stderr. The release SHA is verified separately, from the artifact, in the next
   step; `headSha` selects nothing (SPEC-LANE-006).

4. **Zamp** downloads the structured plan ARTIFACT and digests it — never a `grep` window over a
   log, because a larger plan would be silently truncated and a truncated plan is not what was
   reviewed (SPEC-RUN-007, SPEC-LANE-006):

   ```text
   gh run download "$RUN_ID" --repo marciozampiron/backstage-cba-prep --name plan --dir <evidence-dir>/plan-"$RUN_ID"
   sha256sum <evidence-dir>/plan-"$RUN_ID"/plan.json
   ```

   Expected outcome: an artifact carrying the correlation id, the release SHA, the
   `PLAN_DIGEST`, the rendering and the prepared change-set NAMES — names, not ids: a change-set
   id is an ARN, and evidence carries no live ARNs (SPEC-DEPLOY-006).

5. **Zamp** verifies before accepting, as two independent checks: the run is THIS decision's
   (correlation id in the run name and in the artifact, run id matching, conclusion `success`),
   and the artifact describes THIS release (its `releaseSha` equals the dispatched
   `release_sha` — never the run's `headSha`). Then records the binding — run id, correlation
   id, `decisionId`, release SHA, stack group, `PLAN_DIGEST`, artifact digest. This record is
   what the deploy decision and any abandon decision refer to.

## Evidence

- The COMPLETE structured plan artifact (`plan.json`) and its digest — the reviewed material is
  that artifact, whole, not a `grep` window over a log (SPEC-RUN-007). Round 5 corrected the
  wording: this operation downloads one named artifact, and calling it a "run log" invited
  exactly the log-scraping it replaced.
- The binding record: run id, `decisionId`, release SHA, stack group, `PLAN_DIGEST`, the prepared
  change-set NAMES, artifact digest. Names are deterministic for a release and carry no account
  or region; the ids are ARNs and are never recorded (SPEC-DEPLOY-006).
- An `EVENTS.md` entry per decision, appended through the normal reviewed flow, not by the run.
- No secrets, account ids or live ARNs anywhere; the rendering's redaction discipline
  (SPEC-DEPLOY-006) is the contract.

## Stop conditions

1. Any entrypoint refusal code — the run output names it (`CLOUD_GATE_*`,
   `CHANGE_SET_SCHEMA_UNKNOWN`, `CHANGE_SET_PAGINATION_UNCONSUMED`, `PLAN_PREPARE_FAILED`, …).
   Stop; these are never retried blind; a fresh decision is required after the cause is
   understood.
2. A GitHub-side failure of identity, preflight or credentials — stop; nothing after them ran,
   by construction (SPEC-LANE-001).
3. The window lapsed before dispatch — stop; a fresh decision value is required; windows are
   never widened to "make it fit".
4. The correlation id or run id does not match the request, the artifact's `releaseSha` is not
   the dispatched release SHA, or the run has no `success` conclusion — stop; evidence that
   cannot be tied to THIS decision, from a run that finished, describes a plan nobody
   authorized. A `headSha` differing from the release SHA is expected and is not a stop.
5. The plan artifact does not exist in the run — stop; scraping the log instead is exactly the
   truncation defect this operation removed.
6. Run resolution returns zero matches after the tenth attempt, or more than one at any point —
   stop (SPEC-LANE-007). Waiting longer is not a remedy for a run that never started, and a
   second run bearing this correlation id is never disambiguated by taking the newer one.
7a. `CHANGE_SET_DEPLOYMENT_CONFIG_ABSENT` / `CHANGE_SET_DEPLOYMENT_CONFIG_UNSUPPORTED` /
   `CHANGE_SET_PAGES_DIVERGE` / `CHANGE_SET_SCHEMA_UNKNOWN` — the description CloudFormation
   returned is one this lane cannot approve: it states a deployment configuration outside
   `STANDARD` with rollback-on-failure enabled, states none at all, contradicts itself across
   pages, or carries a member nobody reviewed. None of these is visible in the resource diff, so
   none is waivable by reading the plan harder, and none is a retry: the same preparation will
   return the same description. Stop, understand the cause, and read the paragraph below before
   touching anything — the refusal happened AFTER preparation, so change sets exist.
7. `PLAN_RENDERING_TOO_LARGE` — the wave's evidence record cannot cross the evidence transport
   complete (the narrowest hop is a single environment entry, bounded well under the job-output
   store), so the plan REFUSED after preparation. Evidence is never truncated. The prepared
   change sets REMAIN (a refused plan is a declined plan): remove them under the
   [abandon runbook](aws-dev-release-abandon.md), split the wave into smaller stack groups, and
   plan again.

## Rollback

Prepared change sets **persist until they are deleted**: AWS retains a change set until the stack
is updated or the set is explicitly deleted, and a later plan run does NOT replace one by name —
creating a change set with an existing name fails. A plan Zamp declines therefore leaves
EXECUTABLE change sets behind, and removing them is its own authorized operation:
[abandon](aws-dev-release-abandon.md) (SPEC-RUN-008). No stack state changed here; the change
sets are the thing to clean up.

**A plan that refused BEFORE producing a digest is a different case, and the difference decides
the instrument.** The change sets were prepared and still exist, but no `planDigest` and no
per-entry digests were ever produced. The [abandon](aws-dev-release-abandon.md) lane identifies
what it deletes by exactly those digests (SPEC-RUN-008), so it has nothing here to identify them
with. Planning again is not available either: the change-set name is deterministic per release and
CloudFormation refuses to create a second set under a name that already exists. That state is cleaned up by an exceptional,
reviewed operation under its own human gate, which proves identity (account, region, stack id,
name, status) before deleting by full ARN and reconciles read-only afterwards. Never a blind
retry, never a raw CLI deletion outside an instrument:

| the plan… | the instrument |
| --- | --- |
| produced a digest and Zamp declined it | [abandon](aws-dev-release-abandon.md) (SPEC-RUN-008) |
| refused before any digest existed | `infra/aws/bin/recover-declined-plan.js` — `inspect` (read-only, mints the digest) then `abandon`, authorized exactly as the [abandon runbook](aws-dev-release-abandon.md) prescribes; procedure below |
| never reached preparation | nothing to clean up — no change set was created |

### Recovery procedure (exceptional; change sets only)

Run by Zamp, from a clean checkout of the reviewed executor commit on `main` (the instrument
refuses a dirty tree and records the HEAD it ran as). Credentials are the operator's AWS profile;
the instrument itself resolves the account, assumes this tier's `cdk-<qualifier>-deploy-role` —
the same least-privilege role the lane uses — and imposes the manifest's region on every call.
It cannot delete stacks: `delete-stack` is outside its per-phase command allowlist by
construction. The empty `REVIEW_IN_PROGRESS` stack records are only ever REPORTED — removing one
is reserved to a human by `spec/authority-policy.json` and no lane or instrument performs it.

1. Obtain the TARGET release's verified manifest (the bind artifact of the release whose change
   sets are stranded) — the instrument derives the release SHA, environment, region and the
   change-set name from it and computes its bundle digest itself; nothing is typed.
2. `inspect` (read-only): names the source run, decision and correlation of the refusal, and
   writes the closed evidence file with the per-entry digests and the plan root. It prints the
   evidence file's SHA-256 — record it with the decision.
3. Zamp authors the abandon authorization exactly as the
   [abandon runbook](aws-dev-release-abandon.md) prescribes — naming this manifest's bundle
   digest, the plan root the inspect minted, the reviewed group and a bounded window. Recovery
   adds no authorization schema of its own.
4. `abandon`: validates that authorization AND the inspect evidence (`--evidence`) against each
   other, re-describes the group, recomputes the root, and deletes by full ChangeSetId — one
   attempt, account and window revalidated before each deletion. Every outcome writes a
   continuation record (`--evidence-out`); a halted run resumes under a NEW decision that copies
   the deleted prefix's digests into `absentEntryDigests`, exactly like the lane.

## Cleanup

- After the decision concludes (digest reviewed, or stopped), Zamp clears the `CBA_CLOUD_GATE`
  variable — a live value must not linger past its decision.
- The captured evidence is retained; temporary logs are not.
