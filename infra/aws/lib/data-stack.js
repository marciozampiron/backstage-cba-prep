// Data stack (#77 Stage C — promoted from the #53 placeholder).
// The minimum managed persistence for the learner loop: ONE environment-scoped DynamoDB table
// backing the BFF SimulationRepository DynamoDB adapter (services/bff/src/dynamodb-repository.js
// documents the access patterns this schema serves — record items + GSI1 learner listing +
// atomic counter + active-mock claim; no Scan anywhere).
//
// Environment posture (pilot-environment-contract.md #47 + release runbook #55):
//   pilot -> durable: PITR ON, deletion protection ON, RemovalPolicy.RETAIN.
//   dev   -> DISPOSABLE by explicit policy: PITR off, deletion protection off, DESTROY.
// No IAM principals or grants are created here — #78 owns the runtime role and its scoped table
// grants (this stack only exposes the construct for it).
const { Stack, RemovalPolicy, CfnOutput } = require('aws-cdk-lib');
const dynamodb = require('aws-cdk-lib/aws-dynamodb');
const { resolveEnvironment } = require('./context');
const { applyFoundationTags } = require('./tags');

class DataStack extends Stack {
  constructor(scope, id, props = {}) {
    super(scope, id, props);
    const environment = resolveEnvironment(this.node, props.environment || 'pilot');
    const durable = environment === 'pilot';
    applyFoundationTags(this, environment);

    // Naming convention: cba-study-coach-<env>-<resource> (aws-iac-foundation.md).
    this.table = new dynamodb.Table(this, 'SimulationTable', {
      // #75: completed smoke-run tombstones keep ownership alive so a cleanup replay stays
      // deterministic, and ownership is learner data — it cannot be retained forever (SEC-DATA-01).
      // The application writes `expiresAt` and TTL removes the row afterwards. TTL is a CLEANUP
      // mechanism and never an authorization one: a completed run is refused immediately by the
      // application, so nothing waits on when the row actually disappears.
      timeToLiveAttribute: 'ttl',
      tableName: `cba-study-coach-${environment}-simulation`,
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: durable },
      deletionProtection: durable,
      removalPolicy: durable ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
    });

    // Learner-scoped listing (list-by-learner WITHOUT Scan): gsi1pk = LEARNER#<id>,
    // gsi1sk = <TYPE>#<id> (begins_with per record type).
    this.table.addGlobalSecondaryIndex({
      indexName: 'gsi1',
      partitionKey: { name: 'gsi1pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'gsi1sk', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // Logical name only — consumed as CBA_WEB_TABLE by the runtime config (#77) and granted to
    // the BFF role by #78. No ARN/account output.
    new CfnOutput(this, 'SimulationTableName', {
      value: this.table.tableName,
      description: 'Publish as CBA_WEB_TABLE for the environment (logical name only).',
    });
  }
}

module.exports = { DataStack };
