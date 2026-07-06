// POST /api/practice-sessions/:id/answers — contract §10. Immediate grounded feedback from the
// published QuestionVersion (explanation + sourceRefs) — never AI. Identical re-post is a safe
// retry; a different selection returns 409 ALREADY_ANSWERED.
import { answerQuestion } from '../../../../../lib/store.js';
import { resolveLearner } from '../../../../../lib/identity.js';
import { handle, json, errorResponse } from '../../../../../lib/api.js';

export const POST = handle(async (request, { params }) => {
  const { learnerId } = resolveLearner(request);
  const { id } = await params;
  let body;
  try {
    body = await request.json();
  } catch {
    return errorResponse(400, 'VALIDATION_FAILED', 'Body must be JSON.');
  }
  const { index, questionVersionId, selectedOption, timeSpentSeconds } = body ?? {};
  return json(
    answerQuestion(id, learnerId, {
      index: Number(index),
      questionVersionId,
      selectedOption,
      timeSpentSeconds: timeSpentSeconds != null ? Number(timeSpentSeconds) : null,
    }),
  );
});
