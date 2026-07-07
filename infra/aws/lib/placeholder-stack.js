// Base for the not-yet-implemented stacks (#53 scaffold). Each placeholder is a valid, deploy-safe
// stack: foundation tags plus one SSM "scaffold" marker parameter so the template is non-empty and
// self-documenting, and nothing else. The owning track replaces the marker with real resources —
// see each subclass comment and docs/architecture/aws-iac-foundation.md.
const { Stack, CfnOutput } = require('aws-cdk-lib');
const ssm = require('aws-cdk-lib/aws-ssm');
const { getContext } = require('./context');
const { applyFoundationTags } = require('./tags');

class PlaceholderStack extends Stack {
  // props: { domain: string, purpose: string, environment?: string }
  constructor(scope, id, props = {}) {
    super(scope, id, props);
    const environment = getContext(this.node, 'environment', props.environment || 'pilot');
    applyFoundationTags(this, environment);

    new ssm.StringParameter(this, 'ScaffoldMarker', {
      parameterName: `/cba-study-coach/${environment}/${props.domain}/scaffold`,
      stringValue: props.purpose,
      description: 'Placeholder marker (#53). Remove when this stack gets real resources.',
    });
    new CfnOutput(this, 'ScaffoldPurpose', { value: props.purpose });
  }
}

module.exports = { PlaceholderStack };
