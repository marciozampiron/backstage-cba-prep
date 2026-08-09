#!/usr/bin/env node
/**
 * The traceability linter (spec/spec-anchored-development.md §6, layer 1). Exit 0 when the
 * registry and the spec tables agree and every law of src/lib/spec-registry.js holds; exit 1
 * naming the first divergence. `--commit <full-sha>` lints the registry AS OF that commit, per
 * the audit runbook's contract; the default is the working tree.
 *
 * Read-only over the repository (SPEC-GOV-001): this tool reports, it never repairs.
 */
import { loadSpecSources, validateSpecRegistry, SpecRegistryError } from '../src/lib/spec-registry.js';

function cliArg(argv, name) {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
}

try {
  const commit = cliArg(process.argv, '--commit') ?? null;
  const registry = validateSpecRegistry(loadSpecSources({ commit }));
  const counts = { PROPOSED: 0, ACTIVE: 0, RETIRED: 0 };
  for (const e of registry.entries) counts[e.status] += 1;
  process.stdout.write(`spec:lint OK — ${registry.entries.length} ids (${counts.PROPOSED} PROPOSED, ${counts.ACTIVE} ACTIVE, ${counts.RETIRED} RETIRED)${commit ? ` at ${commit}` : ''}\n`);
} catch (err) {
  process.stderr.write(`spec:lint FAIL — ${err instanceof SpecRegistryError ? err.message : err}\n`);
  process.exitCode = 1;
}
