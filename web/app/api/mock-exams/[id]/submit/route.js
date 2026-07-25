// POST /api/mock-exams/:id/submit — contract §13 (idempotent; expiry auto-submits with unanswered
// scoring incorrect). Delegates to the shared BFF boundary (#76).
import { bffRoute } from '../../../../../lib/api.js';
export const POST = bffRoute((p) => `/mock-exams/${p.id}/submit`);
