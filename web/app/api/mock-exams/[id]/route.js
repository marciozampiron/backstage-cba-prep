// GET /api/mock-exams/:id — contract §11 (exam-mode rule: zero correctness in this payload).
// Delegates to the shared BFF boundary (#76).
import { bffRoute } from '../../../../lib/api.js';
export const GET = bffRoute((p) => `/mock-exams/${p.id}`);
