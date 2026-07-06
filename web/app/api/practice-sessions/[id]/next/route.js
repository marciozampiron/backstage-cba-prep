// GET /api/practice-sessions/:id/next — contract §9. Never exposes correctOption.
import { nextQuestion } from '../../../../../lib/store.js';
import { handle, json } from '../../../../../lib/api.js';

export const GET = handle(async (_request, { params }) => {
  const { id } = await params;
  return json(nextQuestion(id));
});
