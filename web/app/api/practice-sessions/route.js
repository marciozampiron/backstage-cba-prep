// POST /api/practice-sessions — contract §8.
import { startDrill, ApiError } from '../../../lib/store.js';
import { handle, json, errorResponse } from '../../../lib/api.js';

export const POST = handle(async (request) => {
  let body;
  try {
    body = await request.json();
  } catch {
    return errorResponse(400, 'VALIDATION_FAILED', 'Body must be JSON.');
  }
  const { examId, domainId, competencyId, questionCount, difficulty, onlyMissed } = body ?? {};
  if (examId && examId !== 'cba') {
    throw new ApiError(400, 'VALIDATION_FAILED', `Unknown exam "${examId}".`);
  }
  const result = startDrill({
    domainId: domainId || undefined,
    competencyId: competencyId || undefined,
    questionCount: Number(questionCount),
    difficulty: difficulty || 'mixed',
    onlyMissed: Boolean(onlyMissed),
  });
  return json(result, 201);
});
