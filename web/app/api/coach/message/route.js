// POST /api/coach/message — contract §4 (deterministic mode only in this slice; action-scoped).
// Delegates to the shared BFF boundary (#76).
import { bffRoute } from '../../../../lib/api.js';
export const POST = bffRoute(() => '/coach/message');
