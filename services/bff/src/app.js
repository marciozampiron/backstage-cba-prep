// Transport-neutral learner API boundary (#76). One dispatcher owns the IMPLEMENTED routes of
// the contract (docs/product/web-bff-contracts.md) — the 12 deterministic learner endpoints that
// existed in the Next.js app: dashboard, practice options/drills, mock exam, results, missed
// review, deterministic coach. Not yet implemented here (tracked owners): Progress -> #44,
// /api/me -> #69, Preferences -> #79. Runtimes adapt transport to this dispatcher — the Next.js
// route handlers today, the Lambda/API Gateway adapter in #78, and the offline contract harness —
// and none of them re-implement validation, scoring, ownership, or exam-mode rules.
//
// Neutral request shape (no Fetch/Next/Lambda types):
//   { method, path, query, headers, body }
//     method:  'GET' | 'POST'
//     path:    contract path WITHOUT the transport prefix (e.g. '/mock-exams/mock_1/submit')
//     query:   plain object of string values (optional)
//     headers: plain object, lowercase keys (optional)
//     body:    parsed object, raw JSON string, or undefined
// Neutral response shape: { status, body } — plain JSON-serializable.
import { resolveLearner } from './identity.js';
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

let requestCounter = 0;

function errorBody(code, message, details) {
  requestCounter += 1;
  return {
    error: {
      code,
      message,
      ...(details !== undefined ? { details } : {}),
      requestId: `req_${Date.now().toString(36)}${requestCounter.toString(36)}`,
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
].map(([method, pattern, bodyPolicy, handler]) => {
  const parts = pattern.split('/').filter(Boolean);
  return { method, parts, bodyPolicy, handler };
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
 * ASYNC by contract: today's use cases are synchronous, but the public boundary is a Promise so
 * the managed repository adapter (#77, DynamoDB) and future async ports slot in without changing
 * any runtime adapter. Never rejects: every outcome is a `{ status, body }` (errors use the
 * contract envelope).
 */
export async function handleApiRequest({ method, path, query = {}, headers = {}, body } = {}) {
  try {
    const matched = matchRoute(String(method ?? '').toUpperCase(), path ?? '');
    if (!matched) {
      return { status: 404, body: errorBody('NOT_FOUND', 'Unknown API route.') };
    }
    const { learnerId } = resolveLearner(headers);
    const parsedBody = parseBody(body, matched.route.bodyPolicy);
    const result = await matched.route.handler({ learnerId, params: matched.params, query, body: parsedBody });
    if (result && typeof result === 'object' && 'status' in result && 'body' in result) {
      return result;
    }
    return { status: 200, body: result };
  } catch (err) {
    if (err instanceof ApiError) {
      return { status: err.status, body: errorBody(err.code, err.message, err.details) };
    }
    console.error(err);
    return { status: 500, body: errorBody('INTERNAL', 'Unexpected failure.') };
  }
}
