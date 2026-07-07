const { Tags } = require('aws-cdk-lib');

// Foundation tags for every stack, per docs/architecture/aws-iac-foundation.md.
function applyFoundationTags(scope, environment) {
  Tags.of(scope).add('Project', 'CBAStudyCoach');
  Tags.of(scope).add('Environment', environment);
  Tags.of(scope).add('ManagedBy', 'CDK');
  Tags.of(scope).add('CostCenter', 'pilot');
}

module.exports = { applyFoundationTags };
