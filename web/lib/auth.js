// Browser session layer (#69 Slice C). Owns the oidc-client-ts UserManager lifecycle: sign-in
// redirect, callback completion, page-refresh resume (session storage), silent refresh-token
// renewal, and Cognito hosted sign-out. Provider details never leak past this module — pages
// only see { signedIn, displayName } via the account widget and a bearer via apiFetch.
//
// Dev mode (CBA_WEB_AUTH unset/dev): /auth/config answers { mode: 'dev' }, every function here
// degrades to "no session layer", and the deterministic dev identity applies server-side.
import { buildOidcSettings, buildSessionStores, cognitoLogoutUrl } from './auth-settings.js';

let configPromise = null;
let managerPromise = null;

export function getAuthConfig() {
  configPromise ??= fetch('/auth/config').then((r) => {
    if (!r.ok) throw new Error('auth config unavailable');
    return r.json();
  });
  return configPromise;
}

async function getManager() {
  managerPromise ??= (async () => {
    const config = await getAuthConfig();
    if (config.mode !== 'cognito') return null;
    const { UserManager, WebStorageStateStore } = await import('oidc-client-ts');
    return new UserManager({
      ...buildOidcSettings(config, window.location.origin),
      // BOTH stores session-scoped (tokens + OIDC state/code_verifier): survive a page refresh,
      // die with the browser session — nothing auth-related ever rests in localStorage.
      ...buildSessionStores(window.sessionStorage, WebStorageStateStore),
    });
  })();
  return managerPromise;
}

/** Resume the session (page refresh): stored user, silently renewed when expired. */
export async function currentUser() {
  const manager = await getManager();
  if (!manager) return null;
  const user = await manager.getUser();
  if (!user) return null;
  if (!user.expired) return user;
  if (user.refresh_token) {
    return manager.signinSilent().catch(() => null);
  }
  return null;
}

/** Bearer access token for BFF calls — null in dev mode / signed out. */
export async function getAccessToken() {
  return (await currentUser())?.access_token ?? null;
}

export async function signIn() {
  const manager = await getManager();
  if (manager) await manager.signinRedirect();
}

/** Complete the hosted-UI redirect on /auth/callback. */
export async function completeSignIn() {
  const manager = await getManager();
  if (!manager) throw new Error('sign-in is not enabled in this mode');
  return manager.signinCallback();
}

export async function signOut() {
  const manager = await getManager();
  if (!manager) return;
  const config = await getAuthConfig();
  await manager.removeUser();
  window.location.assign(cognitoLogoutUrl(config, window.location.origin));
}
