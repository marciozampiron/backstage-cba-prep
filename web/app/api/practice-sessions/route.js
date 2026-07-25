// POST /api/practice-sessions — contract §8. Delegates to the shared BFF boundary (#76).
import { bffRoute } from '../../../lib/api.js';
export const POST = bffRoute(() => '/practice-sessions');
