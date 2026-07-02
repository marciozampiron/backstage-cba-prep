# AWS MCP Guidance

This project uses AWS MCP only as implementation research context for the SaaS/agent path. It is not a
source of truth for CBA exam facts.

Verified on 2026-07-02 against the AWS Labs MCP repository:
<https://github.com/awslabs/mcp/tree/main/src/aws-knowledge-mcp-server>

## Server

Use AWS Knowledge MCP first:

```txt
https://knowledge-mcp.global.api.aws
```

AWS describes this as a managed remote MCP server with current AWS docs, API references, architectural
guidance, regional availability, AWS agent skills, and Strands Agents SDK documentation. It does not
require an AWS account or AWS credentials, but it does require public internet access and is rate limited.

## What It Is For

Use AWS Knowledge MCP for:

- Bedrock implementation research;
- Strands Agents SDK research;
- AWS agent skill discovery;
- AWS API/reference lookup while building infrastructure adapters;
- regional availability checks for future deployment planning.

Do not use AWS Knowledge MCP for:

- validating CBA question facts;
- replacing Backstage docs or the Linux Foundation blueprint;
- making final review/approval decisions for question content;
- mutating AWS resources;
- storing provider-specific behavior in the domain layer.

CBA facts still come only from:

- <https://training.linuxfoundation.org/certification/certified-backstage-associate-cba/>
- <https://backstage.io/docs>

## Client Configuration

For clients that support remote HTTP MCP servers:

```json
{
  "mcpServers": {
    "aws-knowledge": {
      "type": "http",
      "url": "https://knowledge-mcp.global.api.aws",
      "disabled": false
    }
  }
}
```

For clients that only support stdio MCP servers, proxy HTTP through `fastmcp`:

```json
{
  "mcpServers": {
    "aws-knowledge": {
      "command": "uvx",
      "args": ["fastmcp", "run", "https://knowledge-mcp.global.api.aws"]
    }
  }
}
```

To test the server outside an agent client:

```bash
npx @modelcontextprotocol/inspector https://knowledge-mcp.global.api.aws
```

## Repo Config Decision

Do not commit an active repo-local `.mcp.json` for now. MCP client formats differ, and committing an
active config can unexpectedly register tools for agents that open the repository. Keep client setup in
local user config and copy the snippets above when needed.

If a repo-local MCP artifact becomes useful later, commit an example-only file such as
`.mcp.example.json`, with no credentials, no AWS account IDs, and no environment-specific values.

## Agent Usage Pattern

When working on #23 or other AWS-backed agent features:

1. Search AWS Knowledge MCP for current Bedrock and Strands guidance.
2. Read the specific AWS/Strands pages returned by the search.
3. Summarize the source-backed implementation decision in the issue or code comment.
4. Implement behind application ports/adapters, following `spec/domain-driven-design.md`.
5. Keep deterministic product state outside AWS provider code.

Recommended search topics when available:

- `strands_docs` for Strands Agents SDK documentation;
- `agent_skills` for AWS agent skill packages;
- AWS service names such as `Amazon Bedrock`, `Bedrock Knowledge Bases`, and `CloudWatch`.
