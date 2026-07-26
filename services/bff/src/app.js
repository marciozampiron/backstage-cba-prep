// Transport-neutral learner API boundary (#76). One dispatcher owns the IMPLEMENTED routes of
// the contract (docs/product/web-bff-contracts.md) — the deterministic learner endpoints that
// existed in the Next.js app (dashboard, practice options/drills, mock exam, results, missed
// review, deterministic coach) plus the learner profile /me (#69, §16). Not yet implemented
// here (tracked owners): Progress -> #44, Preferences -> #79. Runtimes adapt transport to this dispatcher — the Next.js
// route handlers today, the Lambda/API Gateway adapter in #78, and the offline contract harness —
// and none of them re-implement validation, scoring, ownership, or exam-mode rules.
//
// Neutral request shape (no Fetch/Next/Lambda types):
//   { method, path, query, headers, body, principal }
//     method:    'GET' | 'POST' | 'PUT'
//     path:      contract path WITHOUT the transport prefix (e.g. '/mock-exams/mock_1/submit')
//     query:     plain object of string values (optional)
//     headers:   plain object, lowercase keys (optional)
//     body:      parsed object, raw JSON string, or undefined
//     principal: neutral principal built by the TRANSPORT from authorizer-validated claims
//                ({ provider, sub, tokenUse, loadProfile? }) — absent in local/dev mode (#69)
// Neutral response shape: { status, body } — plain JSON-serializable.
import { resolveLearner } from './identity.js';
import { getMe, updateMe } from './profile.js';
import { resolveRuntimeConfig } from './config.js';
import { activeRepository } from './runtime.js';
import { RepositoryConflictError } from './repository.js';
import {
  ApiError,
  startDrill,
  nextQuestion,
  answerQuestion,
  attemptResults,
  startMockExam,
  getMockExam,
  saveMockAnswer,
  submitMockExam,
  missedForAttempt,
  coachMessage,
} from './store.js';
import { dashboard, practiceOptions } from './views.js';
import { emitCompletionEvent } from './telemetry.js';

/** Runtime tier for telemetry only — never throws, so a config problem cannot break a request. */
function safeRuntimeEnv() {
  try {
    return resolveRuntimeConfig().runtimeEnv;
  } catch {
    return undefined;
  }
}

/**
 * Clock reading for telemetry only. The duration measurement is part of the side channel, so an
 * injected/broken clock must not be able to reject a request either — it just costs `durationMs`.
 */
function readClock(now) {
  try {
    const value = now();
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

let requestCounter = 0;

/**
 * The ONE place a request id is ever minted (#82 Slice A). Transports supply the canonical id —
 * the Lambda transport copies API Gateway's `$context.requestId`, local/in-process transports
 * generate an opaque id BEFORE dispatch — and this only falls back for direct callers such as
 * unit tests. A request that already has an id never receives a second one, which is exactly what
 * makes the API-to-Lambda correlation query resolve.
 */
function resolveRequestId(provided) {
  if (typeof provided === 'string' && provided.trim() !== '') return provided.trim();
  requestCounter += 1;
  return `req_${Date.now().toString(36)}${requestCounter.toString(36)}`;
}

/** The error envelope carries the SAME canonical id as the completion event — never its own. */
function errorBody(requestId, code, message, details) {
  return {
    error: {
      code,
      message,
      ...(details !== undefined ? { details } : {}),
      requestId,
    },
  };
}

// Body policies mirror the pre-#76 route behavior exactly:
//   'required-json' — invalid/missing JSON is 400 VALIDATION_FAILED ("Body must be JSON.")
//   'optional-json' — invalid/missing JSON degrades to {} (mock start tolerates empty bodies)
//   'none'          — the endpoint never reads a body
function parseBody(raw, policy) {
  if (policy === 'none') return {};
  if (raw !== undefined && raw !== null && typeof raw === 'object') return raw;
  if (typeof raw === 'string' && raw !== '') {
    try {
      return JSON.parse(raw);
    } catch {
      if (policy === 'required-json') {
        throw new ApiError(400, 'VALIDATION_FAILED', 'Body must be JSON.');
      }
      return {};
    }
  }
  if (policy === 'required-json') {
    throw new ApiError(400, 'VALIDATION_FAILED', 'Body must be JSON.');
  }
  return {};
}

function requireKnownExam(examId) {
  if (examId && examId !== 'cba') {
    throw new ApiError(400, 'VALIDATION_FAILED', `Unknown exam "${examId}".`);
  }
}

// Contract routes: [method, pattern, bodyPolicy, handler(ctx)]
// ctx: { learnerId, params, query, body }
const ROUTES = [
  // Readiness (#77/#68): LOGICAL evidence only — adapter kind, ready flag, runtime tier. Never
  // table names, ARNs, account ids, or record identifiers. Unauthenticated on purpose: deploy
  // gates (#70) probe it before any learner smoke, and it exposes no learner data.
  [
    'GET',
    '/readiness',
    'none',
    async () => {
      const { runtimeEnv } = resolveRuntimeConfig();
      const { adapter, ready } = await activeRepository().readiness();
      return { adapter, ready, runtimeEnv };
    },
    { auth: false },
  ],
  // Learner profile (#69 Slice B, contract §16). The opaque loadProfile capability rides the
  // principal; the use cases never see tokens or provider endpoints.
  ['GET', '/me', 'none', ({ learnerId, principal }) => getMe(learnerId, { loadProfile: principal?.loadProfile })],
  [
    'PUT',
    '/me',
    'required-json',
    ({ learnerId, principal, body }) => updateMe(learnerId, body, { loadProfile: principal?.loadProfile }),
  ],
  ['GET', '/dashboard', 'none', ({ learnerId }) => dashboard(learnerId)],
  ['GET', '/practice/options', 'none', ({ learnerId }) => practiceOptions(learnerId)],
  [
    'POST',
    '/practice-sessions',
    'required-json',
    async ({ learnerId, body }) => {
      requireKnownExam(body.examId);
      const result = await startDrill(learnerId, {
        domainId: body.domainId || undefined,
        competencyId: body.competencyId || undefined,
        questionCount: Number(body.questionCount),
        difficulty: body.difficulty || 'mixed',
        onlyMissed: Boolean(body.onlyMissed),
      });
      return { status: 201, body: result };
    },
  ],
  ['GET', '/practice-sessions/:id/next', 'none', ({ learnerId, params }) => nextQuestion(params.id, learnerId)],
  [
    'POST',
    '/practice-sessions/:id/answers',
    'required-json',
    ({ learnerId, params, body }) =>
      answerQuestion(params.id, learnerId, {
        index: Number(body.index),
        questionVersionId: body.questionVersionId,
        selectedOption: body.selectedOption,
        timeSpentSeconds: body.timeSpentSeconds != null ? Number(body.timeSpentSeconds) : null,
      }),
  ],
  [
    'POST',
    '/mock-exams',
    'optional-json',
    async ({ learnerId, body }) => {
      requireKnownExam(body.examId);
      return { status: 201, body: await startMockExam(learnerId) };
    },
  ],
  ['GET', '/mock-exams/:id', 'none', ({ learnerId, params, query }) => getMockExam(params.id, learnerId, query.index)],
  [
    'POST',
    '/mock-exams/:id/answers',
    'required-json',
    ({ learnerId, params, body }) =>
      saveMockAnswer(params.id, learnerId, {
        index: Number(body.index),
        questionVersionId: body.questionVersionId,
        selectedOption: body.selectedOption,
        flagged: body.flagged,
      }),
  ],
  ['POST', '/mock-exams/:id/submit', 'none', ({ learnerId, params }) => submitMockExam(params.id, learnerId)],
  ['GET', '/attempts/:id/results', 'none', ({ learnerId, params }) => attemptResults(params.id, learnerId)],
  [
    'GET',
    '/attempts/:id/missed',
    'none',
    ({ learnerId, params, query }) =>
      missedForAttempt(params.id, learnerId, { cursor: query.cursor, limit: query.limit }),
  ],
  [
    'POST',
    '/coach/message',
    'required-json',
    ({ learnerId, body }) => coachMessage(learnerId, { action: body.action, context: body.context ?? {} }),
  ],
].map(([method, pattern, bodyPolicy, handler, opts]) => {
  const parts = pattern.split('/').filter(Boolean);
  // routeKey is the matched PATTERN, never the concrete path: telemetry stays bounded (one value
  // per contract route) and no attempt/session/question id can leak through it.
  return { method, pattern, routeKey: `${method} ${pattern}`, parts, bodyPolicy, handler, auth: opts?.auth !== false };
});

function matchRoute(method, path) {
  const parts = String(path).split('?')[0].split('/').filter(Boolean);
  for (const route of ROUTES) {
    if (route.method !== method || route.parts.length !== parts.length) continue;
    const params = {};
    let ok = true;
    for (let i = 0; i < parts.length; i++) {
      const p = route.parts[i];
      if (p.startsWith(':')) params[p.slice(1)] = decodeURIComponent(parts[i]);
      else if (p !== parts[i]) {
        ok = false;
        break;
      }
    }
    if (ok) return { route, params };
  }
  return null;
}

/**
 * Dispatch one neutral request against the implemented learner API routes.
 * ASYNC end to end: the use cases and the repository port are awaitable (#77), so the managed
 * DynamoDB adapter and future async ports slot in without changing any runtime adapter. Never
 * rejects: every outcome is a `{ status, body }` (errors use the contract envelope).
 */
export async function handleApiRequest({
  method,
  path,
  query = {},
  headers = {},
  body,
  principal = null,
  requestId: incomingRequestId,
  now = () => Date.now(),
  emit = emitCompletionEvent,
} = {}) {
  const requestId = resolveRequestId(incomingRequestId);
  const startedAt = readClock(now);
  const upperMethod = String(method ?? '').toUpperCase();
  let routeKey;
  let outcome;

  try {
    const matched = matchRoute(upperMethod, path ?? '');
    if (!matched) {
      outcome = { status: 404, body: errorBody(requestId, 'NOT_FOUND', 'Unknown API route.') };
      return outcome;
    }
    routeKey = matched.route.routeKey;
    const { learnerId } = matched.route.auth ? resolveLearner(headers, principal) : { learnerId: null };
    const parsedBody = parseBody(body, matched.route.bodyPolicy);
    const result = await matched.route.handler({
      learnerId,
      principal: matched.route.auth ? principal : null,
      params: matched.params,
      query,
      body: parsedBody,
    });
    outcome =
      result && typeof result === 'object' && 'status' in result && 'body' in result
        ? result
        : { status: 200, body: result };
    return outcome;
  } catch (err) {
    if (err instanceof ApiError) {
      outcome = { status: err.status, body: errorBody(requestId, err.code, err.message, err.details) };
      return outcome;
    }
    if (err instanceof RepositoryConflictError) {
      outcome = {
        status: 409,
        body: errorBody(requestId, 'CONFLICT', 'The record was modified concurrently — retry the request.'),
      };
      return outcome;
    }
    // The raw error may carry request data — never logged. Only the sanitized event below is.
    outcome = { status: 500, body: errorBody(requestId, 'INTERNAL', 'Unexpected failure.') };
    return outcome;
  } finally {
    // EXACTLY ONE emission ATTEMPT per request, made after the response shape is known (`finally`
    // runs on every path, including the early 404 return). "Attempt" is the honest guarantee:
    // telemetry is a side channel, so DELIVERY cannot be promised — a broken sink must never
    // change, delay or reject an otherwise valid business result (`security-rules.md` §2.5).
    //
    // The catch is deliberately silent: reporting a sink failure through another logger risks a
    // failure loop, and logging the request or the raw error here would leak exactly the material
    // the allowlist exists to keep out. The lost event is visible operationally as a gap between
    // API Gateway access logs and application events.
    const status = outcome?.status ?? 500;
    try {
      const endedAt = readClock(now);
      emit({
        level: status >= 500 ? 'error' : 'info',
        message: 'request.completed',
        requestId,
        routeKey,
        method: upperMethod,
        statusCode: status,
        // Undefined when either clock reading failed — the validator then drops the field rather
        // than emitting NaN, and the rest of the event still ships.
        durationMs: startedAt !== undefined && endedAt !== undefined ? endedAt - startedAt : undefined,
        errorCode: outcome?.body?.error?.code,
        runtimeEnv: safeRuntimeEnv(),
      });
    } catch {
      /* best effort by contract — see above */
    }
  }
}
