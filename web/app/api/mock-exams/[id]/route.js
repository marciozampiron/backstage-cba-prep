// GET /api/mock-exams/:id — contract §11. Timer, navigator (answered/flagged only), one question
// view with the learner's current selection. Exam-mode rule: zero correctness in this payload.
import { getMockExam } from '../../../../lib/store.js';
import { resolveLearner } from '../../../../lib/identity.js';
import { handle, json } from '../../../../lib/api.js';

export const GET = handle(async (request, { params }) => {
  const { learnerId } = resolveLearner(request);
  const { id } = await params;
  const index = new URL(request.url).searchParams.get('index');
  return json(getMockExam(id, learnerId, index));
});
