'use client';
// Central session gate (#69 Slice C): in cognito mode, NO protected page mounts and NO API call
// fires until the CURRENT pathname has been validated — `ready` is bound to the validated path
// (lib/session-gate.js), so a route transition renders 'checking' and never reuses the previous
// route's answer. Dev mode passes through (after the first config load) and /auth/* stays
// outside the gate. Auth-layer failures are an explicit error state — never mistaken for dev.
import { useEffect, useState } from 'react';
import { usePathname } from 'next/navigation';
import { getAuthConfig, currentUser, signIn } from '../../lib/auth.js';
import { isGatedPath, validateSession, resolveGateStatus } from '../../lib/session-gate.js';

// Module-level memo of the runtime mode: once the config says 'dev' there is no session to
// re-check per route. In cognito mode every route change re-validates.
let knownMode = null;

export default function AuthGate({ children }) {
  const pathname = usePathname();
  const [validated, setValidated] = useState(null); // { path, status } for the LAST checked path

  useEffect(() => {
    if (!isGatedPath(pathname) || (knownMode && knownMode !== 'cognito')) return;
    let alive = true;
    (async () => {
      const result = await validateSession({ getConfig: getAuthConfig, getUser: currentUser });
      if (result.mode) knownMode = result.mode;
      if (alive) setValidated({ path: pathname, status: result.status });
    })();
    return () => {
      alive = false;
    };
  }, [pathname]);

  const status = resolveGateStatus({ pathname, knownMode, validated });

  if (status === 'ready') return children;

  if (status === 'signed-out') {
    // Explicit button instead of an auto-redirect: no redirect loops, and the learner keeps
    // control of when the hosted UI takes over.
    return (
      <main className="gate-screen">
        <div className="logo-mark">C</div>
        <h1>CBA Study Coach</h1>
        <p className="muted">Sign in to continue studying.</p>
        <button type="button" className="auth-btn gate-cta" onClick={() => signIn()}>
          Sign in
        </button>
      </main>
    );
  }

  if (status === 'error') {
    return (
      <main className="gate-screen">
        <p className="error-box">Authentication is unavailable right now. Please try again later.</p>
      </main>
    );
  }

  return (
    <main className="gate-screen">
      <p className="muted">Checking your session…</p>
    </main>
  );
}
