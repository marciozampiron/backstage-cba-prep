// Next.js -> BFF transport adapter (#76). The whole learner API lives in the shared
// provider-neutral service (services/bff); each route handler is a one-line delegation built by
// `bffRoute`. This file owns ONLY transport translation (Fetch Request -> neutral request ->
// Response) — no validation, scoring, ownership, or exam-mode logic here.
import { handleApiRequest } from 'backstage-cba-prep-bff';

/**
 * Build a Next.js route handler that delegates to the shared BFF dispatcher.
 * @param {(params: Record<string, string>) => string} pathFor contract path builder
 */
export function bffRoute(pathFor) {
  return async (request, ctx) => {
    const params = ctx?.params ? await ctx.params : {};
    const url = new URL(request.url);
    const method = request.method.toUpperCase();
    const body = method === 'GET' || method === 'HEAD' ? undefined : await request.text();

    const { status, body: payload } = await handleApiRequest({
      method,
      path: pathFor(params),
      query: Object.fromEntries(url.searchParams),
      headers: Object.fromEntries(request.headers),
      body,
    });
    return Response.json(payload, { status });
  };
}
