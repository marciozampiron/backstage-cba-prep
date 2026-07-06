// GET /api/attempts/:id/missed — contract §14. Grounded review of missed items (incl. unanswered
// mock questions). Post-submit only: 409 ATTEMPT_NOT_COMPLETED while in progress.
import { missedForAttempt } from '../../../../../lib/store.js';
import { handle, json } from '../../../../../lib/api.js';

export const GET = handle(async (request, { params }) => {
  const { id } = await params;
  const url = new URL(request.url);
  return json(
    missedForAttempt(id, {
      cursor: url.searchParams.get('cursor'),
      limit: url.searchParams.get('limit'),
    }),
  );
});
