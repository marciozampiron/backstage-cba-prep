// GET /api/practice-sessions/:id/next — contract §9. Never exposes correctOption.
import { nextQuestion } from '../../../../../lib/store.js';
import { resolveLearner } from '../../../../../lib/identity.js';
import { handle, json } from '../../../../../lib/api.js';

export const GET = handle(async (request, { params }) => {
  const { learnerId } = resolveLearner(request);
  const { id } = await params;
  return json(nextQuestion(id, learnerId));
});
