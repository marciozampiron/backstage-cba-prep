// Browser -> BFF fetch wrapper (#69 bearer, #67 base URL). THE single door to the learner API:
// every page and component calls learner endpoints through here (enforced by the
// no-direct-fetch guard), so the bearer, the BFF base and the path allowlist are applied in
// exactly one place.
//
// The base comes from `/auth/config` at RUNTIME (never a NEXT_PUBLIC_* build-time constant) and
// is cached by the shared auth-config promise, so it costs one request per page load:
//   local, no base configured -> same-origin '/api/...' (the in-app route handlers)
//   dev | pilot               -> '<CBA_BFF_BASE_URL>/api/...' straight to the AWS API Gateway,
//                                guarded by the exact-origin CORS seam (#69)
//
// Auth-layer failures are NOT silenced: a broken session or runtime config must surface through
// the caller's error path rather than degrade into an unauthenticated same-origin request.
import { getAccessToken, getAuthConfig } from './auth.js';

// Only contract paths are accepted. This is what keeps a configured BFF origin from being turned
// into a generic fetch target: an absolute URL, a protocol-relative '//host', or a traversal
// segment would otherwise be concatenated onto (or replace) the base.
//
// Validation goes through the URL NORMALIZER rather than a hand-rolled pattern, because that is
// what the server will do: `new URL()` collapses `.`/`..` segments, so the decision is made on the
// path that actually gets requested. Percent-encoding is then decoded to a fixed point and
// re-normalized, because `%2e%2e` and `%2f` survive URL parsing untouched but become traversal the
// moment anything downstream decodes them (case variations included — decodeURIComponent handles
// `%2E` and `%2e` alike). EVERY form must still land under /api.
const SENTINEL_ORIGIN = 'https://contract-path.invalid';
const MAX_DECODE_PASSES = 4;

function underApi(pathname) {
  return pathname === '/api' || pathname.startsWith('/api/');
}

/**
 * Decode repeatedly until stable, so double-encoded traversal cannot hide behind one pass.
 * Returns null — i.e. FAIL CLOSED — when the value is malformed OR still has not converged within
 * MAX_DECODE_PASSES: a partially decoded form tells us nothing about what a downstream decoder
 * would end up with, so it must never be the basis of an allow decision.
 */
function decodeToFixedPoint(value) {
  let current = value;
  for (let i = 0; i < MAX_DECODE_PASSES; i += 1) {
    let next;
    try {
      next = decodeURIComponent(current);
    } catch {
      // Malformed percent-encoding: refuse rather than guess.
      return null;
    }
    if (next === current) return current;
    current = next;
  }
  return null;
}

/**
 * @returns {string} the normalized `pathname + search` to request
 * @throws when the target does not resolve to exactly /api or a path beneath /api/
 */
function normalizeContractPath(input) {
  const refuse = () => {
    throw new Error(`apiFetch only accepts contract paths under /api — got "${input}".`);
  };
  // Reject before parsing: absolute URLs and protocol-relative authorities would replace the base
  // entirely instead of being appended to it.
  if (typeof input !== 'string' || !input.startsWith('/') || input.startsWith('//')) refuse();

  let url;
  try {
    url = new URL(input, SENTINEL_ORIGIN);
  } catch {
    refuse();
  }
  if (url.origin !== SENTINEL_ORIGIN) refuse();

  const decoded = decodeToFixedPoint(url.pathname);
  if (decoded === null) refuse();
  let decodedNormalized;
  try {
    decodedNormalized = new URL(decoded, SENTINEL_ORIGIN).pathname;
  } catch {
    refuse();
  }
  // The literal path, its decoded form, and the decoded form re-normalized must ALL stay under
  // /api — the third check is what catches `%2e%2e` and encoded separators.
  if (!underApi(url.pathname) || !underApi(decoded) || !underApi(decodedNormalized)) refuse();
  // Belt and braces: no traversal segment may survive decoding.
  if (decoded.split('/').includes('..')) refuse();

  return `${url.pathname}${url.search}`;
}

/**
 * Build an apiFetch bound to its dependencies. Production uses the defaults; tests inject the
 * session/config/fetch seams so the REAL url-building, bearer and allowlist logic is exercised.
 */
export function createApiFetch({
  getToken = getAccessToken,
  getConfig = getAuthConfig,
  fetchImpl = (...args) => fetch(...args),
} = {}) {
  return async function apiFetch(path, init = {}) {
    // Validate FIRST: a refused path must never reach the network, and must not even trigger a
    // session or config lookup.
    const target = normalizeContractPath(path);
    const [token, config] = await Promise.all([getToken(), getConfig()]);
    const base = config?.bffBaseUrl ?? '';
    const headers = { ...(init.headers ?? {}) };
    if (token) headers.authorization = `Bearer ${token}`;
    return fetchImpl(`${base}${target}`, { ...init, headers });
  };
}

export const apiFetch = createApiFetch();
