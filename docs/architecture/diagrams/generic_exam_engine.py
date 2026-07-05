"""Generic exam engine content factory.

This is the future multi-domain view. CBA is the first configured domain; later
exams follow the same source-grounded path. AI assists authoring, but the human
review gate is the only path to learner-visible content.

Render:
    python3 docs/architecture/diagrams/generic_exam_engine.py
"""
import os

from diagrams import Cluster, Diagram, Edge
from diagrams.aws.compute import AppRunner, Lambda
from diagrams.aws.database import Dynamodb
from diagrams.aws.integration import Eventbridge, SQS, StepFunctions
from diagrams.aws.ml import Bedrock
from diagrams.aws.network import APIGateway
from diagrams.aws.storage import S3
from diagrams.generic.blank import Blank
from diagrams.onprem.client import Users
from diagrams.programming.framework import Nextjs
from diagrams.saas.cdn import Cloudflare

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "out")
os.makedirs(OUT, exist_ok=True)

SPINE = "#31475e"
PUBLIC = "#0f766e"
AI = "#b45309"
APPROVE = "#15803d"
DATA = "#64748b"

with Diagram(
    "Generic Exam Engine - Source-Grounded Content Factory",
    filename=os.path.join(OUT, "generic_exam_engine"),
    outformat="png",
    show=False,
    direction="LR",
    graph_attr={
        "fontsize": "24",
        "labelloc": "t",
        "pad": "0.6",
        "ranksep": "1.25",
        "nodesep": "0.7",
        "splines": "ortho",
    },
):
    author = Users("Admin / Author")

    with Cluster("1. Domain setup"):
        domain = AppRunner("Domain Workspace\nCBA now; future exams later")
        config = Blank("Exam blueprint\nsource rules")
        domain >> Edge(color=SPINE) >> config

    with Cluster("2. Source evidence"):
        crawler = Lambda("Crawler")
        source_archive = S3("Source Archive")
        source_index = Dynamodb("Source Index")
        crawler >> Edge(color=SPINE) >> source_archive
        crawler >> Edge(color=DATA, style="dashed") >> source_index

    with Cluster("3. Draft generation"):
        workflow = StepFunctions("Authoring Workflow")
        ai_runtime = AppRunner("AI Orchestration\nStrands + tools")
        bedrock = Bedrock("Bedrock")
        drafts = Dynamodb("Draft Questions")
        workflow >> Edge(color=AI) >> ai_runtime
        ai_runtime >> Edge(color=SPINE, label="model calls") >> bedrock
        ai_runtime >> Edge(color=DATA, style="dashed") >> drafts

    with Cluster("4. Human gate"):
        review = AppRunner("Review Workbench\napprove / reject / change")

    with Cluster("5. Published bank"):
        published = Dynamodb("Approved QuestionVersion")
        events = Eventbridge("Publish Events")

    with Cluster("6. Learner delivery"):
        learner = Users("Learner")
        edge = Cloudflare("Cloudflare Edge")
        web = Nextjs("Next.js App")
        api = APIGateway("API Gateway")
        bff = AppRunner("Web BFF")
        learner >> Edge(color=SPINE) >> edge >> Edge(color=SPINE) >> web
        web >> Edge(color=PUBLIC, penwidth="2.8", label="only public AWS path") >> api >> Edge(color=SPINE) >> bff

    queue = SQS("Ingestion Queue")

    author >> Edge(color=SPINE) >> domain
    config >> Edge(color=SPINE, label="domain + source links") >> crawler
    crawler >> Edge(color=DATA, style="dashed") >> queue
    source_index >> Edge(color=SPINE, label="grounded facts") >> workflow
    drafts >> Edge(color=AI, penwidth="2.0", label="AI draft") >> review
    review >> Edge(color=APPROVE, penwidth="2.8", label="approve: only path to publish") >> published
    review >> Edge(color=DATA, style="dashed") >> events
    bff >> Edge(color=SPINE, label="reads approved content") >> published
