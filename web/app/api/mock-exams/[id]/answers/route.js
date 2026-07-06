// POST /api/mock-exams/:id/answers — contract §12. Silent save/replace/clear + flag; answers are
// replaceable until submit and the response never carries correctness.
import { saveMockAnswer } from '../../../../../lib/store.js';
import { handle, json, errorResponse } from '../../../../../lib/api.js';

export const POST = handle(async (request, { params }) => {
  const { id } = await params;
  let body;
  try {
    body = await request.json();
  } catch {
    return errorResponse(400, 'VALIDATION_FAILED', 'Body must be JSON.');
  }
  const { index, questionVersionId, selectedOption, flagged } = body ?? {};
  return json(
    saveMockAnswer(id, {
      index: Number(index),
      questionVersionId,
      selectedOption,
      flagged,
    }),
  );
});
