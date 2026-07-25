// GET /api/practice/options — contract §7. Delegates to the shared BFF boundary (#76).
import { bffRoute } from '../../../../lib/api.js';
export const GET = bffRoute(() => '/practice/options');
