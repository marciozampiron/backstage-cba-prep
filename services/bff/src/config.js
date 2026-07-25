// Runtime configuration (#77 Stage A). The deployment tier is EXPLICIT configuration —
// `CBA_RUNTIME_ENV=local|dev|pilot` — never inferred from NODE_ENV or ambient AWS variables
// (pilot-environment-contract.md §3, deployed-runtime fail-fast rule).
//
//   local      permits CBA_WEB_STORE=memory|file (default file). dynamodb is NOT a local value.
//   dev|pilot  REQUIRE CBA_WEB_STORE=dynamodb AND CBA_WEB_TABLE — anything else fails loudly at
//              composition time, so a deployed runtime can never silently fall back to local
//              persistence.

const RUNTIME_ENVS = ['local', 'dev', 'pilot'];
const LOCAL_STORES = ['memory', 'file'];

export function resolveRuntimeConfig(env = process.env) {
  const runtimeEnv = env.CBA_RUNTIME_ENV ?? 'local';
  if (!RUNTIME_ENVS.includes(runtimeEnv)) {
    throw new Error(
      `CBA_RUNTIME_ENV must be one of ${RUNTIME_ENVS.join('|')} — got "${runtimeEnv}".`,
    );
  }

  if (runtimeEnv === 'local') {
    const store = env.CBA_WEB_STORE ?? 'file';
    if (!LOCAL_STORES.includes(store)) {
      throw new Error(
        `CBA_WEB_STORE="${store}" is not a local store. local permits ${LOCAL_STORES.join('|')}; ` +
          'deployed tiers (dev|pilot) must set CBA_RUNTIME_ENV explicitly.',
      );
    }
    return { runtimeEnv, store, table: null, dataDir: env.CBA_WEB_DATA_DIR ?? null };
  }

  const store = env.CBA_WEB_STORE;
  if (store !== 'dynamodb') {
    throw new Error(
      `CBA_RUNTIME_ENV=${runtimeEnv} requires CBA_WEB_STORE=dynamodb — got "${store ?? '(unset)'}". ` +
        'Deployed runtimes must never fall back to memory/file persistence.',
    );
  }
  const table = env.CBA_WEB_TABLE;
  if (!table) {
    throw new Error(`CBA_RUNTIME_ENV=${runtimeEnv} requires CBA_WEB_TABLE to be set.`);
  }
  return { runtimeEnv, store, table, dataDir: null };
}
