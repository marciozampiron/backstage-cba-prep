'use client';
// Hosted-UI redirect target (#69 Slice C): completes the code+PKCE exchange (oidc-client-ts
// verifies state and redeems the code with the stored code_verifier) and returns the learner to
// the dashboard. Matches the IdentityStack callback URL path exactly (/auth/callback).
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { completeSignIn } from '../../../lib/auth.js';

export default function AuthCallbackPage() {
  const router = useRouter();
  const [error, setError] = useState(null);

  useEffect(() => {
    completeSignIn()
      .then(() => router.replace('/'))
      .catch(() => setError('Sign-in could not be completed. Please try again.'));
  }, [router]);

  return (
    <main className="content">
      {error ? (
        <p className="error-box">
          {error} <a href="/">Back to the dashboard</a>
        </p>
      ) : (
        <p className="muted">Completing sign-in…</p>
      )}
    </main>
  );
}
