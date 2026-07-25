// GET /api/attempts/:id/results — contract §3 (practice and mock; kind-aware payload).
// Delegates to the shared BFF boundary (#76).
import { bffRoute } from '../../../../../lib/api.js';
export const GET = bffRoute((p) => `/attempts/${p.id}/results`);
