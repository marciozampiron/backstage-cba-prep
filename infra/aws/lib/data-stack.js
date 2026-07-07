// Data stack (placeholder, #53).
// Will own the DynamoDB tables (attempts, sessions, learners, progress snapshots, review state,
// agent runs) when promoted from the local file adapter, plus PITR/encryption/naming
// (aws-iac-foundation.md → Data Stack).
const { PlaceholderStack } = require('./placeholder-stack');

class DataStack extends PlaceholderStack {
  constructor(scope, id, props = {}) {
    super(scope, id, {
      ...props,
      domain: 'data',
      purpose: 'Placeholder: DynamoDB tables for attempts/sessions/learners/progress/review/agent-runs.',
    });
  }
}

module.exports = { DataStack };
