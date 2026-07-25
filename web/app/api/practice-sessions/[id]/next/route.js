// GET /api/practice-sessions/:id/next — contract §9 (never exposes correctOption).
// Delegates to the shared BFF boundary (#76).
import { bffRoute } from '../../../../../lib/api.js';
export const GET = bffRoute((p) => `/practice-sessions/${p.id}/next`);
