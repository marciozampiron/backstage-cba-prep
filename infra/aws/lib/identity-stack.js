// Identity stack (placeholder, #53). Owning track: #47.
// Will own the Cognito user pool/client/domain, callback/logout URLs, and the Cognito-subject ->
// learner-identity mapping (aws-iac-foundation.md → Identity Stack).
const { PlaceholderStack } = require('./placeholder-stack');

class IdentityStack extends PlaceholderStack {
  constructor(scope, id, props = {}) {
    super(scope, id, {
      ...props,
      domain: 'identity',
      purpose: 'Placeholder: Cognito user pool/client/domain + subject->learner mapping (#47).',
    });
  }
}

module.exports = { IdentityStack };
