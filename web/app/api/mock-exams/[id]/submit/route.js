// POST /api/mock-exams/:id/submit — contract §13. Idempotent; the server auto-submits at expiry
// with unanswered questions scoring incorrect (matches the real exam).
import { submitMockExam } from '../../../../../lib/store.js';
import { handle, json } from '../../../../../lib/api.js';

export const POST = handle(async (_request, { params }) => {
  const { id } = await params;
  return json(submitMockExam(id));
});
