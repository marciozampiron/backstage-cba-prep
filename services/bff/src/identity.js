// Learner identity boundary (slice 4b, #43; made runtime-neutral in #76).
//
// This is the auth PORT for the BFF: the dispatcher calls `resolveLearner(headers)` with a plain
// lowercase-keyed header object (no Fetch/Next Request types), and passes the resulting learnerId
// into the store — no dispatcher or store code hardcodes a learner. Provider selection is an
// adapter seam per ADR-0002: the dev provider below serves local mode; a Cognito provider (#69)
// replaces it behind the same function without touching the dispatcher, store, records, or the
// frontend. Provider details never reach the browser.
//
// Selection: CBA_WEB_AUTH=dev|cognito (default dev).
//
// Dev provider resolution order (documented in the web README):
//   1. `x-cba-learner` header — tools/smokes and multi-learner testing;
//   2. `cba_learner` cookie — per-browser identity when you want it;
//   3. deterministic fallback `dev-learner` — the simple local mode (no auth configured).
//
// Cognito provider (#69 Slice B): consumes ONLY the neutral principal the transport built from
// API-Gateway-authorizer-validated claims. Binding rules enforced here: access tokens only
// (token_use=access), provider-namespaced learner id from `sub`, and `x-cba-learner` REJECTED —
// browser-supplied identity is never trusted in a deployed runtime.
import { ApiError } from './store.js';

const LEARNER_TOKEN = /^[a-zA-Z0-9_-]{1,64}$/;

function devProvider(headers) {
  const header = headers['x-cba-learner'];
  if (header && LEARNER_TOKEN.test(header)) {
    return { learnerId: `dev-${header}`, mode: 'dev' };
  }
  const cookies = headers.cookie ?? '';
  const match = cookies.match(/(?:^|;\s*)cba_learner=([^;]+)/);
  if (match && LEARNER_TOKEN.test(match[1])) {
    return { learnerId: `dev-${match[1]}`, mode: 'dev' };
  }
  return { learnerId: 'dev-learner', mode: 'dev' };
}

function cognitoProvider(headers, principal) {
  if (headers['x-cba-learner'] !== undefined) {
    // Fail loudly instead of silently ignoring: a client sending dev identity against a deployed
    // runtime is misconfigured, and accepting the request would mask that.
    throw new ApiError(401, 'UNAUTHENTICATED', 'Dev identity headers are not accepted.');
  }
  if (
    !principal ||
    principal.provider !== 'cognito' ||
    principal.tokenUse !== 'access' ||
    typeof principal.sub !== 'string' ||
    principal.sub === ''
  ) {
    throw new ApiError(401, 'UNAUTHENTICATED', 'A valid access token is required.');
  }
  return { learnerId: `cognito-${principal.sub}`, mode: 'cognito' };
}

/**
 * @param {Record<string, string>} headers plain object, lowercase keys
 * @param {{ provider: string, sub: string, tokenUse: string } | null} principal neutral principal
 *   built by the TRANSPORT from authorizer-validated claims (never from raw request data)
 * @returns {{ learnerId: string, mode: string }}
 */
export function resolveLearner(headers = {}, principal = null) {
  const mode = process.env.CBA_WEB_AUTH ?? 'dev';
  if (mode === 'cognito') return cognitoProvider(headers, principal);
  return devProvider(headers);
}
