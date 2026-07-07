# Security Policy

## Reporting a vulnerability

If you find a security issue in this repository, please report it privately:

- Preferred: open a GitHub **private vulnerability report** (Security tab → "Report a vulnerability").
- Do not open a public issue or PR that discloses the vulnerability before it is addressed.

Please include: what you found, how to reproduce it, and the potential impact. You can expect an
initial acknowledgement and a triage decision (accepted / needs-info / declined) on a best-effort
basis for this pilot project.

## Scope

This is a pre-release pilot: the source-grounded CBA study kit and the CBA Web MVP. There is no
supported-versions matrix yet — the default branch is the supported line.

Especially relevant reports:

- exposed secrets or credentials (API keys, AWS credentials, tokens);
- a path where the browser could reach AWS/Bedrock/AI provider internals directly;
- a way to publish learner-visible content that bypasses the human review gate;
- learner data crossing the per-learner ownership boundary.

## Security baseline

The repository's security and CI/CD posture is documented in:

- [`docs/architecture/github-security-and-oidc-baseline.md`](docs/architecture/github-security-and-oidc-baseline.md)
  — GitHub security baseline, branch protection, and AWS OIDC roles.
- [`docs/architecture/ci-cd-security-foundation.md`](docs/architecture/ci-cd-security-foundation.md)
  — CI/CD lanes and security foundation.
- [`docs/wiki/Security-Compliance.md`](docs/wiki/Security-Compliance.md) — security and compliance rules.

## Secrets

Never commit API keys, AWS credentials, GitHub tokens, account-specific secrets, or production
environment files. MCP configs (`.mcp.json`, `.mcp.local.json`, `.vscode/mcp.json`) are gitignored
because they can hold provider keys. Use environment variables, GitHub Environments, or AWS Secrets
Manager / SSM Parameter Store; AWS access uses GitHub OIDC role assumption, not long-lived keys.
