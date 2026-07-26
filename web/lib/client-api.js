// Browser -> BFF fetch wrapper (#69 Slice C). Attaches the Cognito bearer when a session
// exists; in dev mode getAccessToken resolves to null legitimately and the request rides the
// deterministic dev identity. Auth-layer FAILURES are not silenced: a broken session layer must
// surface through the caller's error path, never degrade into an unauthenticated request that
// dies later as a confusing 401.
// Same-origin '/api' today; #67 swaps the base for the runtime-configured CBA_BFF_BASE_URL
// (Worker runtime variable — never a build-time constant) in this ONE place.
import { getAccessToken } from './auth.js';

export async function apiFetch(path, init = {}) {
  const token = await getAccessToken();
  const headers = { ...(init.headers ?? {}) };
  if (token) headers.authorization = `Bearer ${token}`;
  return fetch(path, { ...init, headers });
}
