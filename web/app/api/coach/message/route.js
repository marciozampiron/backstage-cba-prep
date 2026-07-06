// POST /api/coach/message — contract §4, deterministic mode only in this slice. Action-scoped
// (never free-form chat); text is composed from published items/blueprint data with sourceRefs and
// a recommended action. mode: "grounded" arrives with the Phase 3 AI slice behind this same shape.
import { coachMessage } from '../../../../lib/store.js';
import { resolveLearner } from '../../../../lib/identity.js';
import { handle, json, errorResponse } from '../../../../lib/api.js';

export const POST = handle(async (request) => {
  const { learnerId } = resolveLearner(request);
  let body;
  try {
    body = await request.json();
  } catch {
    return errorResponse(400, 'VALIDATION_FAILED', 'Body must be JSON.');
  }
  const { action, context } = body ?? {};
  return json(coachMessage(learnerId, { action, context: context ?? {} }));
});
