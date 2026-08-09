#!/usr/bin/env node
/**
 * The conformance checker (spec/spec-anchored-development.md §6, layer 2). Runs every ACTIVE
 * id's named tests in THIS tree and exits 1 on any failure — including a named test that no
 * longer exists, because "nothing ran" is drift, not success. With zero ACTIVE ids it exits 0
 * and says so plainly: nothing is enforced yet, and claiming otherwise would be the overclaim
 * design round 4 removed.
 *
 * `--commit <full-sha>` validates the registry as of that commit first; the TESTS always run in
 * the current working tree, which is the tree whose conformance is being asked about.
 * Read-only over the repository (SPEC-GOV-001).
 */
import { loadSpecSources, validateSpecRegistry, runConformance, SpecRegistryError } from '../src/lib/spec-registry.js';

function cliArg(argv, name) {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
}

try {
  const commit = cliArg(process.argv, '--commit') ?? null;
  const registry = validateSpecRegistry(loadSpecSources({ commit }));
  const report = runConformance(registry);
  if (report.activeCount === 0) {
    process.stdout.write('spec:conform OK — 0 ACTIVE ids; nothing is enforced yet, and none can drift.\n');
  } else {
    for (const r of report.results) {
      process.stdout.write(`${r.ok ? 'ok' : 'FAIL'} ${r.id} — ${r.file} :: ${r.title}${r.ok ? '' : ` (${r.reason})`}\n`);
    }
    process.stdout.write(`spec:conform ${report.ok ? 'OK' : 'FAIL'} — ${report.activeCount} ACTIVE ids, ${report.results.length} named tests\n`);
    if (!report.ok) process.exitCode = 1;
  }
} catch (err) {
  process.stderr.write(`spec:conform FAIL — ${err instanceof SpecRegistryError ? err.message : err}\n`);
  process.exitCode = 1;
}
