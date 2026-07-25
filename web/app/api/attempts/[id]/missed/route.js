// GET /api/attempts/:id/missed — contract §14 (grounded review of missed items; post-submit only).
// Delegates to the shared BFF boundary (#76).
import { bffRoute } from '../../../../../lib/api.js';
export const GET = bffRoute((p) => `/attempts/${p.id}/missed`);
