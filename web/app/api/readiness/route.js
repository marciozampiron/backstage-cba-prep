// GET /api/readiness — logical persistence readiness (#77/#68): adapter kind + ready + tier,
// never physical identifiers. Delegates to the shared BFF boundary.
import { bffRoute } from '../../../lib/api.js';
export const GET = bffRoute(() => '/readiness');
