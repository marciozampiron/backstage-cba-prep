// GET /api/attempts/:id/results — contract §3 (practice and mock attempts; kind-aware payload).
import { attemptResults } from '../../../../../lib/store.js';
import { handle, json } from '../../../../../lib/api.js';

export const GET = handle(async (_request, { params }) => {
  const { id } = await params;
  return json(attemptResults(id));
});
