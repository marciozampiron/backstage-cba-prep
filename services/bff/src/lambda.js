// Lambda transport adapter (#78) for API Gateway HTTP API payload format v2.
// PURE TRANSPORT: translates the v2 event into the neutral request shape and the neutral
// { status, body } back into a v2 response — zero validation, scoring, ownership, or exam-mode
// logic here (that all lives behind handleApiRequest, exactly like the Next.js adapter).
//
// Path convention: the deployed BFF serves the SAME paths as the local app (`/api/...`) so the
// #56 BASE_URL smokes and the frontend need no response-shape or path rewrite; the adapter
// strips the single leading `/api` segment before dispatching.
import { handleApiRequest } from './app.js';
import { principalFromJwtClaims, createProfileLoader, bearerFromHeaders } from './cognito-identity.js';

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
    // Canonical correlation id (#82): API Gateway owns it and emits the same value in its access
    // log as `$context.requestId`, so the API-to-Lambda Logs Insights join resolves. The Lambda
    // invocation id (`context.awsRequestId`) is a DIFFERENT identity — it stays in the AWS-managed
    // platform logs and is never copied here nor used as the correlation key.
    requestId: event.requestContext?.requestId,
  };
}

/**
 * Neutral principal from the API Gateway JWT authorizer (#69 Slice B). Claims only exist when
 * the authorizer already validated signature/issuer/audience; the adapter then enforces
 * token_use=access and attaches the opaque loadProfile capability (the bearer token lives ONLY
 * inside that closure — it is never a readable property of the principal).
 *
 * FAIL CLOSED on a missing bearer: the authorizer reads $request.header.Authorization, so valid
 * claims without the header cannot happen on a real gateway — if they do (forged event, direct
 * invoke, misconfiguration), there is no principal at all: 401, and nothing is ever persisted
 * for the request.
 */
export function principalFromEvent(event, headers) {
  const claims = event.requestContext?.authorizer?.jwt?.claims;
  const principal = principalFromJwtClaims(claims);
  if (!principal) return null;
  const bearer = bearerFromHeaders(headers);
  if (!bearer) return null;
  principal.loadProfile = createProfileLoader({ bearer });
  return principal;
}

/** API Gateway HTTP API (payload v2) Lambda handler. */
export async function handler(event) {
  const neutral = toNeutralRequest(event);
  // `requestId` rides inside the neutral request — the dispatcher reuses that exact value in the
  // completion event and in every error envelope, so all three carry one id.
  const { status, body } = await handleApiRequest({
    ...neutral,
    principal: principalFromEvent(event, neutral.headers),
  });
  return {
    statusCode: status,
    headers: RESPONSE_HEADERS,
    body: JSON.stringify(body),
  };
}
