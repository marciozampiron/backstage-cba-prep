// POST /api/mock-exams/:id/submit — contract §13. Idempotent; the server auto-submits at expiry
// with unanswered questions scoring incorrect (matches the real exam).
import { submitMockExam } from '../../../../../lib/store.js';
import { resolveLearner } from '../../../../../lib/identity.js';
import { handle, json } from '../../../../../lib/api.js';

export const POST = handle(async (request, { params }) => {
  const { learnerId } = resolveLearner(request);
  const { id } = await params;
  return json(submitMockExam(id, learnerId));
});
