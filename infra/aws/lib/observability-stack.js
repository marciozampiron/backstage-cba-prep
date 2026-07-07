// Observability stack (placeholder, #53).
// Will own CloudWatch log groups, alarms/dashboards, cost/billing signals, and log retention rules
// (aws-iac-foundation.md → Observability Stack).
const { PlaceholderStack } = require('./placeholder-stack');

class ObservabilityStack extends PlaceholderStack {
  constructor(scope, id, props = {}) {
    super(scope, id, {
      ...props,
      domain: 'observability',
      purpose: 'Placeholder: CloudWatch log groups, alarms/dashboards, cost signals, retention rules.',
    });
  }
}

module.exports = { ObservabilityStack };
