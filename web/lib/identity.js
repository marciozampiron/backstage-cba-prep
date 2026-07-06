// Learner identity boundary (slice 4b, #43).
//
// This is the auth PORT for the BFF-shaped routes: route handlers call `resolveLearner(request)`
// and pass the resulting learnerId into the store — no route or store code hardcodes a learner.
// Provider selection is an adapter seam per ADR-0002: the dev provider below serves local/pilot
// mode; a Cognito provider replaces it behind the same function without touching routes, store,
// records, or the frontend. Provider details never reach the browser.
//
// Selection: CBA_WEB_AUTH=dev|cognito (default dev).
//
// Dev provider resolution order (documented in the README):
//   1. `x-cba-learner` header — tools/smokes and multi-learner testing;
//   2. `cba_learner` cookie — per-browser identity when you want it;
//   3. deterministic fallback `dev-learner` — the simple local mode (no auth configured).

const LEARNER_TOKEN = /^[a-zA-Z0-9_-]{1,64}$/;

function devProvider(request) {
  const header = request.headers.get('x-cba-learner');
  if (header && LEARNER_TOKEN.test(header)) {
    return { learnerId: `dev-${header}`, mode: 'dev' };
  }
  const cookies = request.headers.get('cookie') ?? '';
  const match = cookies.match(/(?:^|;\s*)cba_learner=([^;]+)/);
  if (match && LEARNER_TOKEN.test(match[1])) {
    return { learnerId: `dev-${match[1]}`, mode: 'dev' };
  }
  return { learnerId: 'dev-learner', mode: 'dev' };
}

function cognitoProvider() {
  // Deliberate seam, not an implementation: the Cognito adapter (ADR-0002) verifies the
  // API-Gateway-validated session and maps the subject to a learnerId here.
  throw new Error(
    'CBA_WEB_AUTH=cognito is not configured in the local pilot. Implement the Cognito identity adapter (ADR-0002) or unset CBA_WEB_AUTH for dev mode.',
  );
}

export function resolveLearner(request) {
  const mode = process.env.CBA_WEB_AUTH ?? 'dev';
  if (mode === 'cognito') return cognitoProvider(request);
  return devProvider(request);
}
