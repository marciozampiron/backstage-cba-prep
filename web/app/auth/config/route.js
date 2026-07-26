// GET /auth/config — RUNTIME configuration for the browser (#69 auth, #67 BFF base URL).
//
// Served from the runtime env at request time — the Cloudflare Worker BINDING env on Workers,
// process.env locally — and NEVER from NEXT_PUBLIC_* (Next inlines those at build time, which
// would break the build-once/promote-the-same-artifact rule of the #56 smoke design).
//
// `bffBaseUrl` is served in BOTH modes: it is where `apiFetch` sends learner API calls. Local with
// no base means same-origin `/api`; dev/pilot require a base (the resolver fails fast) and the
// browser then calls the AWS API Gateway directly, guarded by the exact-origin CORS seam (#69).
import { getRuntimeEnv, onCloudflareWorkers, resolveBffConfig } from '../../../lib/bff-config.js';

export const dynamic = 'force-dynamic';

export async function GET() {
  let env;
  let bff;
  try {
    env = await getRuntimeEnv();
    // Throws in dev/pilot when CBA_BFF_BASE_URL is missing or malformed, and on Workers when the
    // tier is absent or `local` — a deployed frontend must never fall back to a same-origin BFF
    // that does not exist there.
    bff = resolveBffConfig(env, { onWorkers: onCloudflareWorkers() });
  } catch {
    return Response.json(
      { error: { code: 'RUNTIME_MISCONFIGURED', message: 'Runtime configuration is incomplete.' } },
      { status: 500 },
    );
  }

  const runtime = { runtimeEnv: bff.runtimeEnv, bffBaseUrl: bff.bffBaseUrl };
  const mode = env.CBA_WEB_AUTH;
  const deployed = bff.runtimeEnv !== 'local';

  if (deployed && mode !== 'cognito') {
    // Fail closed: a deployed runtime has no dev identity. Absent, `dev` or any unknown value is
    // a misconfiguration, never a silent downgrade to the deterministic local learner.
    return Response.json(
      { error: { code: 'AUTH_MISCONFIGURED', message: 'Auth configuration is incomplete.' } },
      { status: 500 },
    );
  }
  if (mode !== 'cognito') {
    // Local only: `dev` (or unset) keeps the deterministic dev learner.
    return Response.json({ mode: 'dev', ...runtime });
  }

  const { COGNITO_USER_POOL_ID, COGNITO_CLIENT_ID, COGNITO_DOMAIN } = env;
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
    ...runtime,
  });
}
