// Next.js -> BFF transport adapter (#76). The whole learner API lives in the shared
// provider-neutral service (services/bff); each route handler is a one-line delegation built by
// `bffRoute`. This file owns ONLY transport translation (Fetch Request -> neutral request ->
// Response) — no validation, scoring, ownership, or exam-mode logic here.
import { handleApiRequest } from 'backstage-cba-prep-bff';

/**
 * Opaque correlation id for the LOCAL/in-process transport (#82). Deployed runtimes use API
 * Gateway's `$context.requestId` instead; here there is no gateway, so the transport generates one
 * id BEFORE dispatch and the dispatcher reuses it — it never mints a second one.
 * `newRequestId` is injectable so tests can pin a deterministic value.
 */
export function localRequestId() {
  return `loc_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
}

/**
 * Build a Next.js route handler that delegates to the shared BFF dispatcher.
 * @param {(params: Record<string, string>) => string} pathFor contract path builder
 * @param {{ newRequestId?: () => string }} [opts] test seam for a deterministic id
 */
export function bffRoute(pathFor, { newRequestId = localRequestId } = {}) {
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
      requestId: newRequestId(),
    });
    return Response.json(payload, { status });
  };
}
