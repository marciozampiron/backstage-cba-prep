"""CBA Study Coach operational observability architecture.

The diagram is an executive view. Detailed fields, thresholds, queries, and
release checks live in aws-observability-baseline.md.

Render:
    python3 docs/architecture/diagrams/operational_observability.py
"""
import os

from diagrams import Cluster, Diagram, Edge
from diagrams.aws.compute import Lambda
from diagrams.aws.database import Dynamodb
from diagrams.aws.devtools import XRay
from diagrams.aws.integration import SNS
from diagrams.aws.management import Cloudwatch, CloudwatchAlarm, CloudwatchLogs
from diagrams.aws.network import APIGateway
from diagrams.onprem.client import Users
from diagrams.programming.flowchart import PredefinedProcess
from diagrams.onprem.vcs import Github
from diagrams.saas.cdn import Cloudflare

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "out")
os.makedirs(OUT, exist_ok=True)

TRAFFIC = "#31475e"
TELEMETRY = "#2563eb"
ALERT = "#b91c1c"
RELEASE = "#15803d"
DEFERRED = "#b45309"
BOUNDARY = "#64748b"

with Diagram(
    "CBA Study Coach - Operational Observability",
    filename=os.path.join(OUT, "operational_observability"),
    outformat="png",
    show=False,
    direction="LR",
    graph_attr={
        "fontsize": "24",
        "labelloc": "t",
        "pad": "0.65",
        "ranksep": "1.05",
        "nodesep": "0.85",
        "splines": "ortho",
    },
):
    with Cluster("1. Runtime and edge boundary", direction="TB"):
        edge = Cloudflare("Cloudflare Worker")
        api = APIGateway("HTTP API")
        bff = Lambda("Web BFF")
        data = Dynamodb("Simulation data")
        edge_view = Cloudflare("Workers observability\nseparate control plane")

        edge >> Edge(color=TRAFFIC, penwidth="2.2", label="browser traffic") >> api
        api >> Edge(color=TRAFFIC) >> bff >> Edge(color=TRAFFIC) >> data
        edge >> Edge(color=BOUNDARY, style="dashed", label="edge telemetry") >> edge_view

    with Cluster(
        "2. AWS operational baseline",
        direction="TB",
        # Internal padding only: the leftmost node's label is wider than its icon and used
        # to overflow the cluster border. No node, edge, or boundary changes.
        graph_attr={"margin": "26"},
    ):
        logs = CloudwatchLogs("Sanitized logs\nAPI + Lambda")
        metrics = Cloudwatch("Native metrics\nAPI + Lambda + DDB")
        insights = CloudwatchLogs("Logs Insights\nsaved queries")
        dashboard = Cloudwatch("Operations dashboard\nservice health + investigation")
        individual_alarms = CloudwatchAlarm("Diagnostic alarms\nsix minimum signals")
        operational_health = CloudwatchAlarm("OperationalHealth\ncomposite")

        logs >> Edge(color=TELEMETRY) >> insights >> Edge(color=TELEMETRY) >> dashboard
        metrics >> Edge(color=TELEMETRY) >> dashboard
        metrics >> Edge(color=ALERT) >> individual_alarms
        individual_alarms >> Edge(color=ALERT, label="aggregate") >> operational_health
        [individual_alarms, operational_health] >> Edge(color=TELEMETRY) >> dashboard

    with Cluster("3. Release and incident response", direction="LR"):
        pipeline = Github("GitHub Actions #70\ndeploy + smokes")
        gates = Github("Release verification\nO1 structure\nO2 health + traffic")
        notifications = SNS("Encrypted SNS\noperations")
        operator = Users("Operator")

        pipeline >> Edge(color=RELEASE, penwidth="2.0") >> gates
        gates >> Edge(color=RELEASE, label="GO / NO-GO") >> operator
        notifications >> Edge(color=ALERT, label="notify") >> operator

    with Cluster("Future option - not pilot baseline", direction="TB"):
        future_boundary = PredefinedProcess("Lambda transport\ninstrumentation boundary")
        adot = Lambda("ADOT Lambda layer\nauto-instrumentation")
        app_signals = Cloudwatch("Application Signals\nservice map + SLOs")
        traces = XRay("X-Ray traces")

        future_boundary >> Edge(
            color=DEFERRED,
            style="dashed",
            label="cost/privacy/IAM gate",
        ) >> adot
        adot >> Edge(color=DEFERRED, style="dashed") >> app_signals
        app_signals >> Edge(color=DEFERRED, style="dashed") >> traces

    api >> Edge(color=TELEMETRY, style="dashed", label="access events") >> logs
    bff >> Edge(color=TELEMETRY, style="dashed", label="request completion") >> logs
    [api, bff, data] >> Edge(color=TELEMETRY, style="dashed") >> metrics

    operational_health >> Edge(color=ALERT) >> notifications
    operational_health >> Edge(
        color=RELEASE,
        style="dashed",
        label="alarm states",
    ) >> gates
    metrics >> Edge(
        color=RELEASE,
        style="dashed",
        label="positive traffic",
    ) >> gates

    operator >> Edge(style="invis") >> future_boundary
