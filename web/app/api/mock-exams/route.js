// POST /api/mock-exams — contract §2 (blueprint-weighted assembly; one in-progress mock per
// learner). Delegates to the shared BFF boundary (#76).
import { bffRoute } from '../../../lib/api.js';
export const POST = bffRoute(() => '/mock-exams');
