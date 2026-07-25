// Lambda transport adapter (#78) for API Gateway HTTP API payload format v2.
// PURE TRANSPORT: translates the v2 event into the neutral request shape and the neutral
// { status, body } back into a v2 response — zero validation, scoring, ownership, or exam-mode
// logic here (that all lives behind handleApiRequest, exactly like the Next.js adapter).
//
// Path convention: the deployed BFF serves the SAME paths as the local app (`/api/...`) so the
// #56 BASE_URL smokes and the frontend need no response-shape or path rewrite; the adapter
// strips the single leading `/api` segment before dispatching.
import { handleApiRequest } from './app.js';

const API_PREFIX = /^\/api(?=\/|$)/;

// Baseline security headers on every response: learner payloads must never be cached by
// intermediaries, sniffed, or framed. CORS is deliberately NOT set here — #69 owns the
// exact-origin policy (the API Gateway seam), and "*" with credentials is forbidden.
const RESPONSE_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
};

/** Translate an API Gateway HTTP API v2 event into the neutral request shape. */
export function toNeutralRequest(event = {}) {
  const method = event.requestContext?.http?.method ?? '';
  const rawPath = event.rawPath ?? '';
  const path = rawPath.replace(API_PREFIX, '') || '/';

  // v2 lowercases header keys but delivers cookies SEPARATELY — the identity port reads the
  // `cookie` header, so rejoin them (never overriding an explicit cookie header).
  const headers = { ...(event.headers ?? {}) };
  if (Array.isArray(event.cookies) && event.cookies.length > 0 && !headers.cookie) {
    headers.cookie = event.cookies.join('; ');
  }

  let body = event.body;
  if (body !== undefined && body !== null && event.isBase64Encoded) {
    body = Buffer.from(body, 'base64').toString('utf8');
  }

  return {
    method,
    path,
    query: event.queryStringParameters ?? {},
    headers,
    body: body ?? undefined,
  };
}

/** API Gateway HTTP API (payload v2) Lambda handler. */
export async function handler(event) {
  const { status, body } = await handleApiRequest(toNeutralRequest(event));
  return {
    statusCode: status,
    headers: RESPONSE_HEADERS,
    body: JSON.stringify(body),
  };
}
