'use client';
// Account widget (#69 Slice C): greeting + sign-in/sign-out. In cognito mode it drives the
// hosted-UI session (the AuthGate guarantees one exists before pages mount); in dev mode it
// greets the deterministic dev profile. The display name always comes from /api/me (§16) —
// never from provider claims in the browser. Failures are shown as an explicit unavailable
// state — NEVER converted into a fake dev/signed-in state.
import { useEffect, useState } from 'react';
import { getAuthConfig, currentUser, signIn, signOut } from '../../lib/auth.js';
import { apiFetch } from '../../lib/client-api.js';

export default function AccountControl({ compact = false }) {
  const [state, setState] = useState({ status: 'loading', mode: null, name: null });

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const config = await getAuthConfig();
        if (config.mode === 'cognito' && !(await currentUser())) {
          if (alive) setState({ status: 'signed-out', mode: config.mode, name: null });
          return;
        }
        const res = await apiFetch('/api/me');
        if (!res.ok) throw new Error(`profile unavailable (${res.status})`);
        const me = await res.json();
        if (alive) setState({ status: 'signed-in', mode: config.mode, name: me.displayName ?? 'Learner' });
      } catch {
        if (alive) setState({ status: 'error', mode: null, name: null });
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  if (state.status === 'loading') return <span className="muted">…</span>;

  if (state.status === 'error') {
    return (
      <span className="muted" title="Account unavailable">
        account unavailable
      </span>
    );
  }

  if (state.status === 'signed-out') {
    return (
      <button type="button" className="auth-btn" onClick={() => signIn()}>
        Sign in
      </button>
    );
  }

  return (
    <span className="account">
      <span>Hello, {state.name}</span>
      {!compact && <span className="avatar">{state.name.charAt(0).toUpperCase()}</span>}
      {state.mode === 'cognito' && (
        <button type="button" className="auth-btn" onClick={() => signOut()}>
          Sign out
        </button>
      )}
    </span>
  );
}
