# CBA Exam Blueprint — Certified Backstage Associate

> **Canonical, engine-neutral spec.** Read by every agent (Claude, Codex, Gemini) and by the CLI.
> Source of truth: <https://training.linuxfoundation.org/certification/certified-backstage-associate-cba/>
> Keep current with `npx backstage-cba-prep sync` (CI refreshes it on a schedule).

Every generated question MUST map to exactly one domain + one competency listed here.

## Format

| Property            | Value                                             |
| ------------------- | ------------------------------------------------- |
| Question type       | Multiple choice (single best answer)              |
| Number of questions | 60                                                |
| Duration            | 90 minutes                                        |
| Level               | Associate / pre-professional                      |
| Delivery            | Online, remotely proctored                        |
| Prerequisites       | None                                              |

> Passing score is **not** published on the LF blueprint page. The simulator defaults to 75% (a common
> LF associate threshold), overridable with `--pass`. Do not assert an official passing score anywhere.

## Domains, weights & question budget

Integer counts sum to 60 (largest-remainder rounding; the extra question goes to the heaviest domain):

| # | Domain                         | Weight | Q in 60-mock | ID prefix |
| - | ------------------------------ | ------ | ------------ | --------- |
| 1 | Backstage Development Workflow | 24%    | 14           | `dw`      |
| 2 | Backstage Infrastructure       | 22%    | 13           | `infra`   |
| 3 | Backstage Catalog              | 22%    | 13           | `cat`     |
| 4 | Customizing Backstage          | 32%    | 20           | `cust`    |
|   | **Total**                      | 100%   | **60**       |           |

## Competencies (tag each question with exactly one)

### 1. Backstage Development Workflow — 24%
- Build and run Backstage projects locally
- Understand local development workflows
- Compile a Backstage project with TypeScript
- Download and install dependencies for a Backstage project with NPM/Yarn
- Use Docker to build a container image of a Backstage project

### 2. Backstage Infrastructure — 22%
- Understand the Backstage framework
- Configure Backstage
- Deploy Backstage to production
- Understand Backstage client-server architecture

### 3. Backstage Catalog — 22%
- Understand how/why to use Backstage Catalog
- Populate Backstage Catalog
- Using annotations
- Working with manually registered entity locations
- Troubleshooting entity ingestion
- Working with automated ingestion

### 4. Customizing Backstage — 32%
- Understand frontend versus backend plugins
- Customizing Backstage plugins
- Make changes to React code in Backstage App
- Using Material UI components

## Coverage goal

Give every competency several questions across easy/medium/hard before piling more onto any single
one. Check current coverage with `node bin/cli.js stats`.
