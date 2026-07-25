# Task: make restart-persistence smoke terminate and verify the real Next server (#80)

## Owner

- Agent: Claude (executor)
- Architect/reviewer: Codex
- Human gate: required before push

## Source of truth

- GitHub issue: #80 (sub-issue of #77; hardens the #42 restart evidence)
- Root cause proven during #76 verification (done/76 forensics note): killing the `npx` wrapper
  can leave the real `next-server` child alive; a crashed run leaks it holding the port with a
  removed data dir, poisoning every later run.

## Scope

ONLY `web/scripts/smoke-restart-persistence.mjs`: direct process-group control (no `npx`
wrapper), fail-fast on occupied port, stop = kill own group + await exit + verify port closed,
boot 2 must be a distinct process, `try/finally` cleanup of server and dataDir, never any broad
pkill. Main criterion: `npm run build` then TWO consecutive runs both pass and leave the port
free. No application/repository/schema/AWS/workflow/deploy change.

## Work log

- (in progress)
- Rewrote ONLY `web/scripts/smoke-restart-persistence.mjs`:
  - Server spawned DIRECTLY via `node_modules/.bin/next` (no npx wrapper), `detached: true` so
    the whole owned Next tree (CLI + the forked next-server) lives in the script's own process
    group; signaling uses `process.kill(-pid, ...)` ONLY — no pkill of any kind, alien listeners
    are never touched.
  - Fail-fast preflight: occupied port -> explicit FAIL + exit 1 ("refusing to reuse an unknown
    listener"), proven with a deliberate dummy listener (which survived untouched).
  - stop = SIGTERM group -> await child exit (10s) -> SIGKILL escalation (5s) -> REQUIRE port
    closed (15s poll); both facts are asserted as PASS lines ("owned process tree exited",
    "port closed before boot 2").
  - Boot 2 asserted as a DISTINCT process (pid comparison in the PASS line).
  - try/finally owns cleanup: any still-alive owned server tree or leftover temp data dir fails
    the smoke visibly; data dir removal verified with existsSync.
- Main criterion PROVEN: `npm run build` + TWO consecutive runs -> ALL PASS twice, port 3017 free
  and zero next processes after; previously the second consecutive run failed deterministically.
- Full battery green: 3 memory smokes PASS; root 77/77; bff harness 12/12; validate 60/0;
  `git diff --check` clean; agent-refresh ok. Only the smoke script changed — no application,
  repository, schema, AWS, workflow, or deploy file touched.
- Risk notes: (1) `detached: true` semantics on the Ubuntu CI runner match Linux local behavior
  (same platform family; the lane runs the script once per fresh runner anyway); (2) the PORT
  env override remains supported; parallel use of the same port on one machine is still
  fail-fast by design, not queued.

## Codex review (2 findings) — fixed, amended into the same commit

- (1) Host consistency: single `HOST = 127.0.0.1` pinned in BASE, the preflight probe, AND the
  server bind (`next start -H 127.0.0.1`). Nothing addresses `localhost`/`::1` anymore, so an
  IPv6-only listener can neither slip past the preflight into our traffic path nor be adopted.
  Re-verified: IPv4-occupied port -> fail-fast exit 1; an ::1-only listener is harmlessly
  irrelevant (run passes, alien listener untouched).
- (2) Ownership kept until confirmed: `server = null` now happens ONLY after `exited && closed`
  are both verified (boot 1 and boot 2); an incomplete shutdown throws to `finally` WITH the
  reference intact so the owned-group cleanup retries and failure stays visible.
- Criterion re-run after the fixes: build OK; two consecutive runs ALL PASS; port free; zero
  next processes; negative occupied-port test exit 1.
