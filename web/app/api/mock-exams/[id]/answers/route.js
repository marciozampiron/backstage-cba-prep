// POST /api/mock-exams/:id/answers — contract §12 (silent save/replace/clear + flag; never carries
// correctness). Delegates to the shared BFF boundary (#76).
import { bffRoute } from '../../../../../lib/api.js';
export const POST = bffRoute((p) => `/mock-exams/${p.id}/answers`);
