// Fail-closed stand-in for the in-process BFF, used ONLY in the Cloudflare Workers build (#67).
//
// The learner API lives on AWS (ADR-0002): in a deployed runtime the browser calls the API
// Gateway directly with `CBA_BFF_BASE_URL`, so the in-app `/api/**` route handlers exist purely
// for local development. `next.config.mjs` aliases `backstage-cba-prep-bff` to this module when
// CBA_BUILD_TARGET=cloudflare, which keeps the whole BFF — its use cases, the question bank, the
// DynamoDB adapter and the AWS SDK — OUT of the Worker bundle.
//
// It answers with the contract error envelope instead of throwing, so a stray request produces a
// deterministic 503 and NEVER any learner data. Reaching this code means a deployed frontend
// called its own origin instead of the configured BFF — a misconfiguration, surfaced loudly.
export async function handleApiRequest() {
  return {
    status: 503,
    body: {
      error: {
        code: 'BFF_NOT_AVAILABLE',
        message:
          'The learner API is not served by this frontend runtime. Requests must go to the ' +
          'configured Web BFF (CBA_BFF_BASE_URL).',
      },
    },
  };
}
