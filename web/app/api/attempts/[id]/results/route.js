// GET /api/attempts/:id/results — contract §3 (practice attempts in slice 1; mock arrives later).
import { attemptResults } from '../../../../../lib/store.js';
import { handle, json } from '../../../../../lib/api.js';

export const GET = handle(async (_request, { params }) => {
  const { id } = await params;
  return json(attemptResults(id));
});
