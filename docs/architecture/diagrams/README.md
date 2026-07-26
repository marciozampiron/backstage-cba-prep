# Architecture Diagrams

Architecture-as-code diagrams for the SaaS pilot and the future generic exam
engine. They are generated with Python [`diagrams`](https://diagrams.mingrammer.com/)
and support the runtime decision in
[`ADR-0002`](../../adr/0002-cloudflare-nextjs-aws-bff.md).

## Files

| Script | Purpose | Output |
| --- | --- | --- |
| `saas_pilot_cba.py` | CBA SaaS pilot runtime view: web edge, AWS access boundary, product core, internal AI runtime, state/workflow, foundation. | `out/saas_pilot_cba.png` |
| `generic_exam_engine.py` | Future generic content factory: domain setup, source evidence, AI draft generation, human review, published bank, learner delivery. | `out/generic_exam_engine.png` |
| `operational_observability.py` | Pilot observability view: request path, native CloudWatch baseline, release/incident loop, separate Cloudflare telemetry, optional OTEL evolution. | `out/operational_observability.png` |

## Regenerate

```bash
python3 -m pip install diagrams
cd docs/architecture/diagrams
python3 saas_pilot_cba.py
python3 generic_exam_engine.py
python3 operational_observability.py
```

Graphviz (`dot`) must be installed on the machine that renders the images.

## Architectural guardrails

- Browser traffic has one backend path: Cloudflare/Next.js -> API Gateway -> Web BFF.
- API Gateway is not the BFF; the BFF is a separate backend service.
- Learners never reach Bedrock, Strands, DynamoDB, S3, or internal services directly.
- AI orchestration is internal and reached only by server-side product use cases.
- Strands/tool orchestration lives inside the AI Orchestration service; Bedrock is model access.
- AI output is a draft until the human review gate approves it.
- CBA is the first domain configuration; the future engine is generic by design.

## Icon mapping

| Concept | Rendered with |
| --- | --- |
| Cloudflare edge | `diagrams.saas.cdn.Cloudflare` |
| Next.js app | `diagrams.programming.framework.Nextjs` |
| API Gateway | `diagrams.aws.network.APIGateway` |
| AI orchestration / review workbench / domain workspace | `diagrams.aws.compute.AppRunner` |
| Web BFF in the current pilot deployment shape | `diagrams.aws.compute.Lambda` |
| Product services / crawler | `diagrams.aws.compute.Lambda` |
| Authoring workflow | `diagrams.aws.integration.StepFunctions` |
| Queues and publish events | `diagrams.aws.integration.SQS`, `diagrams.aws.integration.Eventbridge` |
| Bedrock | `diagrams.aws.ml.Bedrock` |
| Operational stores and question banks | `diagrams.aws.database.Dynamodb` |
| Source archive and artifacts | `diagrams.aws.storage.S3` |
| Identity, security, observability | `Cognito`, `IAM`, `KMS`, `Secrets Manager`, `CloudWatch` |
| Operational logs and alarms | `CloudWatch Logs`, `CloudWatch Alarm`, `SNS` |
| Optional tracing evolution | `Lambda` (ADOT layer), `CloudWatch` (Application Signals), `X-Ray` |

These diagrams are not IaC and do not lock the final compute choice. They are
planning artifacts for #34 / #33 and the operational view for #82. Frontend screen design is #35;
BFF contract detail is #36.
