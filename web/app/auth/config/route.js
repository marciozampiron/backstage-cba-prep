// GET /auth/config — RUNTIME auth configuration for the browser (#69 Slice C).
// Served from process.env at request time — NEVER NEXT_PUBLIC_* (build-frozen; #47 rule). In
// dev mode the payload is just { mode: 'dev' } and the sign-in UI stays hidden; in cognito mode
// it carries the ids the OIDC client needs (configuration, not secrets — the SPA client has no
// secret by design). Physical values only ever come from the environment (#67 owns the deployed
// frontend runtime vars).
export const dynamic = 'force-dynamic';

export function GET() {
  const mode = process.env.CBA_WEB_AUTH ?? 'dev';
  if (mode !== 'cognito') {
    return Response.json({ mode: 'dev' });
  }
  const { COGNITO_USER_POOL_ID, COGNITO_CLIENT_ID, COGNITO_DOMAIN } = process.env;
  if (!COGNITO_USER_POOL_ID || !COGNITO_CLIENT_ID || !COGNITO_DOMAIN) {
    // Fail closed: a cognito runtime without its config must not render a broken sign-in.
    return Response.json(
      { error: { code: 'AUTH_MISCONFIGURED', message: 'Auth configuration is incomplete.' } },
      { status: 500 },
    );
  }
  return Response.json({
    mode: 'cognito',
    userPoolId: COGNITO_USER_POOL_ID,
    clientId: COGNITO_CLIENT_ID,
    domain: COGNITO_DOMAIN,
  });
}
