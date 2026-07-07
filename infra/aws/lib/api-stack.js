// API stack (placeholder, #53). Owning track: #46.
// Will own the API Gateway / App Runner / Lambda entrypoints, Web BFF routing, CORS and security
// headers, auth integration, and health/readiness endpoints (aws-iac-foundation.md → API Stack).
const { PlaceholderStack } = require('./placeholder-stack');

class ApiStack extends PlaceholderStack {
  constructor(scope, id, props = {}) {
    super(scope, id, {
      ...props,
      domain: 'api',
      purpose: 'Placeholder: API Gateway/BFF routing, CORS/security headers, auth, health endpoints (#46).',
    });
  }
}

module.exports = { ApiStack };
