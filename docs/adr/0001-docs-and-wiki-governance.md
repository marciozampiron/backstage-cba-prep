# ADR 0001: Docs and Wiki Governance

## Status

Accepted

## Context

The project is evolving from an engine-neutral CBA CLI into a source-grounded SaaS with AI coaching and agentic authoring. Multiple agents and humans need a shared map of product direction, architecture, security, delivery process, and roadmap state.

GitHub Wiki is useful for navigation, but wiki edits can bypass the review and history discipline needed for architecture and product decisions.

## Decision

Repository documentation is canonical. GitHub Wiki is a curated navigation and reading layer.

Canonical docs live in:

- `spec/` for product roadmap, DDD guidance, exam rules, and CBA-specific specifications.
- `docs/wiki/` for wiki source pages.
- `docs/adr/` for architecture decision records.

The GitHub Wiki can mirror or link to `docs/wiki/`, but it must not become the only place where architectural decisions live.

## Consequences

Positive:

- important decisions are reviewed through commits and pull requests;
- agents can read stable files from the repository;
- wiki pages can be regenerated or republished;
- roadmap, architecture, and delivery process remain auditable.

Tradeoffs:

- keeping wiki and repo synchronized requires discipline;
- small editorial fixes may feel heavier when they should go through versioned docs.

## Operating Rules

- Change architectural direction through repo docs first.
- Link wiki pages back to canonical files.
- Use GitHub issues and Project fields for execution status.
- Use ADRs for decisions that affect provider strategy, domain boundaries, security, persistence, or delivery process.
