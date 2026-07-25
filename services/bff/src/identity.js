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

function cognitoProvider() {
  // Deliberate seam, not an implementation: the Cognito adapter (#69, ADR-0002) verifies the
  // API-Gateway-validated session and maps the subject to a learnerId here.
  throw new Error(
    'CBA_WEB_AUTH=cognito is not configured in the local pilot. Implement the Cognito identity adapter (#69) or unset CBA_WEB_AUTH for dev mode.',
  );
}

/**
 * @param {Record<string, string>} headers plain object, lowercase keys
 * @returns {{ learnerId: string, mode: string }}
 */
export function resolveLearner(headers = {}) {
  const mode = process.env.CBA_WEB_AUTH ?? 'dev';
  if (mode === 'cognito') return cognitoProvider(headers);
  return devProvider(headers);
}
