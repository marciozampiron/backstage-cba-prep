// GET /api/dashboard — contract §1. Delegates to the shared BFF boundary (#76).
import { bffRoute } from '../../../lib/api.js';
export const GET = bffRoute(() => '/dashboard');
