// Session-gate decision logic (#69 Slice C review fix) — PURE and dependency-injectable so the
// route-transition semantics are regression-tested offline. The AuthGate component is a thin
// React shell over these two functions.

/** /auth/* stays outside the gate: the callback page must run to CREATE the session. */
export function isGatedPath(pathname) {
  return !String(pathname).startsWith('/auth/');
}

/**
 * Validate the session for ONE pathname. Injected dependencies (config fetch, user lookup) make
 * this testable without a browser. Outcomes:
 *   dev/non-cognito -> ready (deterministic dev identity applies server-side)
 *   cognito + user  -> ready
 *   cognito, no user -> signed-out
 *   any failure      -> error (NEVER mistaken for dev mode)
 */
export async function validateSession({ getConfig, getUser }) {
  try {
    const config = await getConfig();
    if (config.mode !== 'cognito') return { mode: config.mode, status: 'ready' };
    const user = await getUser();
    return { mode: 'cognito', status: user ? 'ready' : 'signed-out' };
  } catch {
    return { mode: null, status: 'error' };
  }
}

/**
 * Render-time status. `ready` is BOUND to the pathname that was actually validated: during a
 * route transition (validated.path !== pathname) the answer is 'checking' — a previous route's
 * 'ready' is never reused, so no protected page can mount ahead of its own validation. The only
 * short-circuits are ungated paths and a runtime already known to be dev (no session to check).
 */
export function resolveGateStatus({ pathname, knownMode, validated }) {
  if (!isGatedPath(pathname)) return 'ready';
  if (knownMode && knownMode !== 'cognito') return 'ready';
  if (!validated || validated.path !== pathname) return 'checking';
  return validated.status;
}
