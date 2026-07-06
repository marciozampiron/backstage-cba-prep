// POST /api/mock-exams — contract §2. Blueprint-weighted 60-question assembly; one in-progress
// mock per learner (409 MOCK_EXAM_IN_PROGRESS with details.mockExamId to resume).
import { startMockExam, ApiError } from '../../../lib/store.js';
import { resolveLearner } from '../../../lib/identity.js';
import { handle, json } from '../../../lib/api.js';

export const POST = handle(async (request) => {
  const { learnerId } = resolveLearner(request);
  let body = {};
  try {
    body = await request.json();
  } catch {
    // empty body is fine — examId is optional in the pilot
  }
  if (body?.examId && body.examId !== 'cba') {
    throw new ApiError(400, 'VALIDATION_FAILED', `Unknown exam "${body.examId}".`);
  }
  return json(startMockExam(learnerId), 201);
});
