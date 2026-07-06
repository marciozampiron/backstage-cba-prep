// GET /api/mock-exams/:id — contract §11. Timer, navigator (answered/flagged only), one question
// view with the learner's current selection. Exam-mode rule: zero correctness in this payload.
import { getMockExam } from '../../../../lib/store.js';
import { handle, json } from '../../../../lib/api.js';

export const GET = handle(async (request, { params }) => {
  const { id } = await params;
  const index = new URL(request.url).searchParams.get('index');
  return json(getMockExam(id, index));
});
