// AI Orchestration stack (placeholder, #53).
// Will own the internal AI Orchestration Service IAM (Bedrock invoke for the runtime coach/authoring
// paths), Secrets Manager/SSM provider config, and future async queues/events — never browser
// reachable (aws-iac-foundation.md → AI Orchestration Stack; ADR-0002).
const { PlaceholderStack } = require('./placeholder-stack');

class AiOrchestrationStack extends PlaceholderStack {
  constructor(scope, id, props = {}) {
    super(scope, id, {
      ...props,
      domain: 'ai-orchestration',
      purpose: 'Placeholder: internal AI Orchestration Service role/config, Bedrock invoke, async events.',
    });
  }
}

module.exports = { AiOrchestrationStack };
