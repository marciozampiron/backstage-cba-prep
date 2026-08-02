# Active: Remediate the 6 high Dependabot alerts before pilot GO (#106)

Roles and messages are canonical in [`../MESSAGE-PROTOCOL.md`](../MESSAGE-PROTOCOL.md). This file
does not restate them.

## Status

IMPLEMENTED locally; awaiting independent review. All six high alerts are remediated by version
upgrades — **no risk acceptance was used** — plus one extra dev-only fix of the same advisory that
surfaced during the work. Nothing is published, deployed or merged.

## Ownership

- Implementation executor: **Claude Opus 5** (worktree `../cba-issue-106`, branch
  `task/106-dependabot-high-remediation`, cut from `origin/main` at `203ce7e8`).
- Architect / independent technical and security reviewer, read-only: **Codex**.
- Approval, risk acceptance, gate and merge authority: **Zamp**.
- #70 and #91 untouched; their handoffs keep their owners.

## Remediation, alert by alert

| Alert | Package | Where | Was | Now | How | Reach |
|---|---|---|---|---|---|---|
| GHSA-3jxr (high) | brace-expansion | infra/aws lock | 5.0.6 (bundled) | 5.0.8 | `aws-cdk-lib` 2.261.0 → **2.263.0** | build/synth tooling — runs in CI and operator deploys; never in the deployed runtime |
| GHSA-mh99 (high) | brace-expansion | infra/aws lock | 5.0.6 (bundled) | 5.0.8 | same upgrade | same |
| GHSA-6g55 (high) | postcss | web lock | 8.4.31 | **8.5.25** | `overrides` in web/package.json | build-time CSS processing; not in the served bundle |
| GHSA-r28c (high) | postcss | web lock | 8.4.31 | **8.5.25** | same override | same |
| GHSA-f88m (high) | sharp | web lock | 0.34.5 | **0.35.3** | `overrides` in web/package.json | next's optional image optimizer — runtime-adjacent in a self-hosted server, unused in the Cloudflare Workers target |
| GHSA-v2hh (high) | fast-uri | root lock | 3.1.3 | **3.1.5** | `npm update fast-uri` | AI-orchestration path only (`@strands-agents/sdk` → MCP SDK → ajv), optional dependency of the CLI; not the web pilot |

**Why each instrument.** `brace-expansion` is BUNDLED inside the aws-cdk-lib tarball (`inBundle:
true`), so npm `overrides` cannot reach it — the only clean fix is the first aws-cdk-lib that bundles
5.0.8, which is **2.263.0** (2.262.2 still bundles 5.0.7 and was verified insufficient). The
package.json floor moved to `^2.263.0` so resolution can never fall below the fix. `postcss` is
PINNED exactly (`8.4.31`) by next, and `sharp` capped at `^0.34`; `overrides` is the minimal
instrument that reaches a transitive pin without forking next. `fast-uri` is an ordinary transitive
range and a plain `npm update` sufficed.

**Extra, same advisory:** refreshing web's lock surfaced GHSA-mh99's OTHER version line —
`brace-expansion` 2.1.2 (`>=2.0.0 <2.1.3`) under `@node-minify/core`, a dev-only path in the
wrangler/opennextjs toolchain. Fixed to 2.1.4 via `npm audit fix` (semver-compatible). It was not
one of the six listed alerts; recorded here so the count difference is explained, not discovered.

## PR #83 disposition

Inspected, not reused. It bumps fast-uri 3.1.3 → 3.1.4 in the root lock only. This branch reaches
3.1.5 (≥ the 3.1.4 patch floor) against current `main`, so #83 is superseded; recommend Zamp close
it without merge after this lands.

## Out of scope, deliberately

Two MODERATE alerts remain in the root lock: `@hono/node-server` (<2.0.5) and
`@modelcontextprotocol/sdk` (1.25.0–1.29.0), both reachable only through the optional
`@strands-agents/sdk` AI-orchestration path. The #106 scope is the six HIGH alerts; the moderates
stay visible in `npm audit` and belong to a future SDK bump task.

## Validation

- npm audit: **0 high in all four trees** (root also 0 critical; 2 moderates documented above);
  web/infra/bff: 0 total.
- root 378/378 · web 71/71 (+ `npm run build` with postcss 8.5.25/sharp 0.35.3, leak-scan PASS,
  restart-persistence smoke ALL PASS — everything the Web Quality lane runs) · services/bff 404
  (402 pass, 2 skip) · infra/aws 157/157 · bank 60/0.
- Credential-free `cdk synth` on aws-cdk-lib **2.263.0** for dev and pilot: OK.
- `git diff --check` clean. Locks surgical: root ±8 lines (fast-uri only); infra ±50 (aws-cdk-lib);
  web −718/+220 (override dedup).
- Node versions: local runner has Node 22.12 only; the Node 20 leg runs in the Quality CI matrix,
  which is part of the acceptance evidence for publication.
