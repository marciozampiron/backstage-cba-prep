// POST /api/practice-sessions/:id/answers — contract §10 (immediate grounded feedback; identical
// re-post is a safe retry, different selection is 409). Delegates to the shared BFF boundary (#76).
import { bffRoute } from '../../../../../lib/api.js';
export const POST = bffRoute((p) => `/practice-sessions/${p.id}/answers`);
