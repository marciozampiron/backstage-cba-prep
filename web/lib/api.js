// Error envelope + response helpers matching docs/product/web-bff-contracts.md conventions.
import { ApiError } from './store.js';

let requestCounter = 0;

export function json(body, status = 200) {
  return Response.json(body, { status });
}

export function errorResponse(status, code, message, details) {
  requestCounter += 1;
  return Response.json(
    {
      error: {
        code,
        message,
        ...(details !== undefined ? { details } : {}),
        requestId: `req_${Date.now().toString(36)}${requestCounter.toString(36)}`,
      },
    },
    { status },
  );
}

// Wrap a route handler: ApiError -> contracted envelope; anything else -> INTERNAL without detail.
export function handle(fn) {
  return async (...args) => {
    try {
      return await fn(...args);
    } catch (err) {
      if (err instanceof ApiError) {
        return errorResponse(err.status, err.code, err.message, err.details);
      }
      console.error(err);
      return errorResponse(500, 'INTERNAL', 'Unexpected failure.');
    }
  };
}
