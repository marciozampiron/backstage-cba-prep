// OIDC settings builder (#69 Slice C) — PURE and environment-free so the offline PKCE proof
// test and the browser session layer share exactly the same configuration. All protocol work
// (PKCE S256 code_verifier/code_challenge, state, token exchange, refresh) is delegated to
// oidc-client-ts — a proven library; nothing here hand-rolls OAuth or JWT cryptography.

/** Cognito issuer for a user pool — the region is the pool id's own prefix. */
export function cognitoAuthority(userPoolId) {
  const region = String(userPoolId).split('_')[0];
  return `https://cognito-idp.${region}.amazonaws.com/${userPoolId}`;
}

/**
 * Settings for the oidc-client-ts UserManager/OidcClient.
 * Binding rules encoded here:
 *   - response_type 'code' (authorization code; the library always applies PKCE S256 to it);
 *   - scopes are EXACTLY openid/email/profile — aws.cognito.signin.user.admin is never added;
 *   - loadUserInfo false: profile enrichment belongs to the BFF adapter, not the browser.
 */
export function buildOidcSettings({ userPoolId, clientId }, origin) {
  return {
    authority: cognitoAuthority(userPoolId),
    client_id: clientId,
    redirect_uri: `${origin}/auth/callback`,
    post_logout_redirect_uri: `${origin}/`,
    response_type: 'code',
    scope: 'openid email profile',
    loadUserInfo: false,
    automaticSilentRenew: true,
  };
}

/**
 * BOTH oidc-client-ts stores — userStore (tokens) AND stateStore (OIDC request state incl. the
 * PKCE code_verifier) — bound to the SAME session-scoped storage. Nothing auth-related may rest
 * in localStorage; extracting this keeps the rule regression-testable offline.
 */
export function buildSessionStores(storage, WebStorageStateStore) {
  return {
    userStore: new WebStorageStateStore({ store: storage }),
    stateStore: new WebStorageStateStore({ store: storage }),
  };
}

/** Cognito hosted logout — clears the provider session, then returns to the app origin. */
export function cognitoLogoutUrl({ domain, clientId }, origin) {
  const url = new URL('/logout', domain);
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('logout_uri', `${origin}/`);
  return url.toString();
}
