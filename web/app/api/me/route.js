// GET/PUT /api/me — learner profile, contract §16 (#69). Delegates to the shared BFF boundary;
// locally the dev identity provider applies (no principal), deployed runtimes go through the
// Lambda transport + Cognito adapter.
import { bffRoute } from '../../../lib/api.js';
export const GET = bffRoute(() => '/me');
export const PUT = bffRoute(() => '/me');
