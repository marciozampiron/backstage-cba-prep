# Operational message template (AGENT-HANDOFF v1)

Copy the envelope below for any operational handoff. The contract is
[`../MESSAGE-PROTOCOL.md`](../MESSAGE-PROTOCOL.md); this file is only a skeleton.

Delete the guidance lines in parentheses. Keep every field — an omitted field is a defect, not a
shortcut, because the next actor reads this instead of guessing.

```
[AGENT-HANDOFF v1]
TO: (Opus | Codex | Zamp)
FROM: (Opus | Codex | Zamp)
ROLE: (implementation executor and publication operator | architect and independent reviewer | approval and merge authority)
TYPE: (REVIEW_REQUEST | FINDINGS | REVIEW_APPROVED | GATE_RECOMMENDATION | HUMAN_GATE_GRANTED | OPERATION_RESULT | MERGE_DECISION)
ISSUE: #<n>
BRANCH: task/<n>-<slug>
COMMITS:
  <full 40-char SHA, in order>
STATUS: (what state the work is in)
NEXT_OWNER: (who acts next)
PROHIBITED_ACTIONS: (what this message does NOT authorize)
```

Never include secrets, tokens, account IDs, raw credentials, or mutable SHA aliases. `HEAD`, a
short SHA and a branch name all mean something different tomorrow; use full SHAs.

## Additional fields by type

**`REVIEW_REQUEST` (Opus → Codex)** — add:

```
VALIDATION: (commands run and their results)
FILES_CHANGED: (paths)
REQUIREMENT_MAP: (each requirement -> where it is implemented)
RESIDUAL_RISKS: (what is still not guaranteed)
```

**`FINDINGS` (Codex → Opus)** — severity-ordered, each with file/line, exploit path, impact,
violated control ID, evidence and remediation. Add:

```
VERDICT: (approved | changes required)
```

**`REVIEW_APPROVED` (Codex → Zamp + Opus)** — must state explicitly that it does **not** authorize
publication:

```
SCOPE: technical review only
PROHIBITED_ACTIONS: does not authorize push, PR mutation, merge or deploy
```

**`GATE_RECOMMENDATION` (Codex → Zamp)** — a recommendation, never a gate:

```
RECOMMENDED_SCOPE: (exact branch and ordered full SHAs)
PROHIBITED_ACTIONS: this message is not a gate and authorizes nothing
```

**`HUMAN_GATE_GRANTED` (Zamp → Opus)** — the only message that authorizes an operation:

```
GATE_ID: <id>
DIGEST: <sha256 of the reviewed script>
EXPIRES_AT: <RFC3339 with offset, at most 12h>
ALLOWED_EFFECTS: push the listed commit to task/<n>-<slug>; create or reuse exactly one pull request
PROHIBITED_ACTIONS: no merge, no deploy, no push to main, no force-push, no repository administration, no secret access, no paid call
```

**`OPERATION_RESULT` (Opus → Zamp + Codex)** — add:

```
EVIDENCE: (branch ref landed, PR number, CI status)
MERGED: no — merge is Zamp's decision
RESIDUAL_RISKS: (what remains)
```

**`MERGE_DECISION` (Zamp)** — the final record:

```
DECISION: (merged | not merged)
RATIONALE: (why)
```
