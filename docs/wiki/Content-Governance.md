# Content Governance

## Trust Boundary

Published exam content must be grounded in official sources.

For CBA:

- exam domain source: Linux Foundation CBA certification page;
- product fact source: official Backstage documentation.

## Content Lifecycle

```text
source -> extracted domain -> draft question -> validation -> human review -> published version
```

## Required Controls

- Every question maps to one exam, one domain, and one competency.
- Every question cites an official source URL.
- Every generated item starts as draft.
- Human review is required before publishing.
- Changed reviewed content becomes stale and must be reviewed again.
- Attempt history must point to the exact question version shown.

## Review States

- `unreviewed`: not yet checked by a human.
- `verified`: answer and explanation match the cited source.
- `flagged`: needs correction, removal, or deeper review.
- `stale`: content changed after a previous review.

## Quality Gates

Before content becomes learner-facing:

- schema validation passes;
- source URL is official and reachable enough for local audit rules;
- answer distribution and coverage are acceptable;
- semantic review is complete;
- provenance metadata is retained.

## Future Admin Console

The review console should make source citation visible, not hidden. Reviewers should be able to approve, reject, request changes, and inspect validation warnings without editing JSON manually.
