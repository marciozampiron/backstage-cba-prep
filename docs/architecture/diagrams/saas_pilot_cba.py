"""CBA SaaS pilot runtime architecture.

This is an executive runtime view for ADR-0002 and #34. It intentionally keeps
only the boundaries that matter for product and security decisions:

- browser traffic enters AWS only through API Gateway and the Web BFF;
- product use cases sit behind the BFF;
- AI runtime is internal and reached only by server-side use cases;
- Bedrock, data, workflow, and secrets are never browser-reachable.

Render:
    python3 docs/architecture/diagrams/saas_pilot_cba.py
"""
import os

from diagrams import Cluster, Diagram, Edge
from diagrams.aws.compute import AppRunner, Lambda
from diagrams.aws.database import Dynamodb
from diagrams.aws.integration import StepFunctions
from diagrams.aws.management import Cloudwatch
from diagrams.aws.ml import Bedrock
from diagrams.aws.network import APIGateway
from diagrams.aws.security import Cognito, IAM, KMS, SecretsManager
from diagrams.aws.storage import S3
from diagrams.onprem.client import Users
from diagrams.programming.framework import Nextjs
from diagrams.saas.cdn import Cloudflare

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "out")
os.makedirs(OUT, exist_ok=True)

SPINE = "#31475e"
PUBLIC = "#0f766e"
AI = "#b45309"
DATA = "#64748b"

with Diagram(
    "CBA SaaS Pilot - Runtime Architecture",
    filename=os.path.join(OUT, "saas_pilot_cba"),
    outformat="png",
    show=False,
    direction="LR",
    graph_attr={
        "fontsize": "24",
        "labelloc": "t",
        "pad": "0.6",
        "ranksep": "1.35",
        "nodesep": "0.75",
        "splines": "ortho",
    },
):
    with Cluster("Experience layer"):
        users = Users("Learner / Admin")
        edge = Cloudflare("Cloudflare Edge")
        web = Nextjs("Next.js App\nstudy + admin UX")
        users >> Edge(color=SPINE) >> edge >> Edge(color=SPINE) >> web

    with Cluster("AWS access boundary"):
        api = APIGateway("API Gateway\npublic entry")
        auth = Cognito("Cognito\nidentity")
        bff = AppRunner("Web BFF\nfrontend-shaped API")
        api >> Edge(color=SPINE) >> bff
        api - Edge(color=DATA, style="dashed", label="auth") - auth

    with Cluster("Product core"):
        study = Lambda("Study & Exam\nattempts, scoring")
        content = Lambda("Question Bank\napproved items")
        authoring = Lambda("Authoring & Review\nadmin workflows")
        coach = Lambda("Coach\nlearner guidance")

    with Cluster("Internal AI runtime"):
        ai_runtime = AppRunner("AI Orchestration\nStrands runtime + tools\nDDD ports inside")
        model_access = Bedrock("Amazon Bedrock\nmodel access")
        ai_runtime >> Edge(color=SPINE, label="model calls") >> model_access

    with Cluster("State and workflow"):
        data = Dynamodb("DynamoDB\nusers, attempts, content, runs")
        sources = S3("S3\nsources, artifacts")
        jobs = StepFunctions("Step Functions\nlong-running jobs")

    with Cluster("Platform foundation"):
        security = IAM("IAM")
        keys = KMS("KMS")
        secrets = SecretsManager("Secrets")
        observability = Cloudwatch("CloudWatch")
        security >> Edge(style="invis", constraint="false") >> keys
        keys >> Edge(style="invis", constraint="false") >> secrets
        secrets >> Edge(style="invis", constraint="false") >> observability

    web >> Edge(color=PUBLIC, penwidth="2.8", label="only browser path into AWS") >> api
    bff >> Edge(color=SPINE, label="commands / queries") >> [study, content, authoring, coach]

    coach >> Edge(color=AI, penwidth="2.0", label="server-side only") >> ai_runtime
    authoring >> Edge(color=AI, penwidth="2.0", label="AI drafts") >> ai_runtime

    [study, content] >> Edge(color=DATA, style="dashed", label="read/write") >> data
    ai_runtime >> Edge(color=DATA, style="dashed", label="usage + runs") >> data
    authoring >> Edge(color=DATA, style="dashed") >> sources
    authoring >> Edge(color=DATA, style="dashed") >> jobs
