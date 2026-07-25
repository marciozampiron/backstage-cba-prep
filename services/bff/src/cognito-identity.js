// Cognito identity adapter (#69 Slice B) — INFRASTRUCTURE/TRANSPORT ONLY.
// This file is the single place where Cognito claims, the bearer access token, and the Cognito
// OIDC endpoint exist. Nothing above the transport imports it: the application receives a
// NEUTRAL principal ({ provider, sub, tokenUse }) plus an opaque `loadProfile()` capability —
// the bearer token lives inside that closure and never appears on any object the application
// can read.
//
// Binding rules (#69 review round 2):
//   - ONLY access tokens are accepted: `token_use` must be exactly "access". An ID token also
//     passes the API Gateway JWT authorizer (its `aud` matches the client id), so this check is
//     NOT redundant — it is the transport-level enforcement of "no ID tokens on the API".
//   - Profile enrichment uses the Cognito OIDC `/oauth2/userInfo` endpoint with the SAME bearer
//     access token the request carried (openid/email/profile scopes only — the
//     aws.cognito.signin.user.admin scope is never requested or required).
//   - The Cognito domain is CONFIGURATION (env COGNITO_DOMAIN, an absolute https URL) — no
//     physical value lives in Git.

const SUB_PATTERN = /^[a-zA-Z0-9-_]{1,128}$/;

/**
 * Map API-Gateway-authorizer-validated JWT claims to a neutral principal.
 * Returns null when the claims do not describe a usable ACCESS token — the caller treats that
 * exactly like an unauthenticated request (the port answers 401).
 */
export function principalFromJwtClaims(claims) {
  if (!claims || typeof claims !== 'object') return null;
  if (claims.token_use !== 'access') return null; // ID (or any other) tokens: rejected
  const sub = claims.sub;
  if (typeof sub !== 'string' || !SUB_PATTERN.test(sub)) return null;
  return { provider: 'cognito', sub, tokenUse: 'access' };
}

/** COGNITO_DOMAIN must be an absolute https base URL (e.g. the hosted-UI domain). */
export function resolveCognitoDomain(env = process.env) {
  const domain = env.COGNITO_DOMAIN;
  if (!domain) {
    throw new Error('COGNITO_DOMAIN is not configured — profile enrichment needs the Cognito OIDC domain.');
  }
  let parsed;
  try {
    parsed = new URL(domain);
  } catch {
    throw new Error(`COGNITO_DOMAIN must be an absolute URL — got "${domain}".`);
  }
  if (parsed.protocol !== 'https:') {
    throw new Error('COGNITO_DOMAIN must use https://.');
  }
  return domain.replace(/\/+$/, '');
}

function sanitizeText(value, max = 120) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > max) return null;
  return trimmed;
}

/**
 * Build the opaque profile-enrichment capability for one request. The bearer token is captured
 * by the closure and is not a property of anything returned — application code can only CALL
 * this, never inspect it. Configuration and the network call are lazy: they happen on first
 * use (/api/me bootstrap), not on every request.
 *
 * Returns a sanitized, neutral profile fragment: { email, displayName }.
 */
export function createProfileLoader({ bearer, env = process.env, fetchImpl = fetch }) {
  return async function loadProfile() {
    const domain = resolveCognitoDomain(env);
    const res = await fetchImpl(`${domain}/oauth2/userInfo`, {
      headers: { authorization: `Bearer ${bearer}` },
    });
    if (!res.ok) {
      // No provider details in the message — this surfaces as a generic 500 upstream.
      throw new Error(`Identity profile lookup failed (status ${res.status}).`);
    }
    const data = await res.json();
    const email = sanitizeText(data.email, 254);
    const displayName =
      sanitizeText(data.name) ??
      sanitizeText(data.preferred_username) ??
      sanitizeText(data.username) ??
      (email ? email.split('@')[0] : null) ??
      'Learner';
    return { email, displayName };
  };
}

/** Extract the bearer token from an already-lowercased header map (transport input). */
export function bearerFromHeaders(headers = {}) {
  const value = headers.authorization ?? '';
  const match = /^Bearer\s+(.+)$/i.exec(value);
  return match ? match[1].trim() : null;
}
