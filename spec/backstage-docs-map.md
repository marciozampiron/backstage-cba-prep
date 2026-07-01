# Backstage Docs Map — grounding sources per competency

> **Canonical, engine-neutral spec.** Every generated question must carry a `source` URL that
> **proves its answer**. Pick the most specific page below. Never cite a page you have not verified.
> Docs root: <https://backstage.io/docs>

## 1. Backstage Development Workflow

| Competency                  | Primary source(s) |
| --------------------------- | ----------------- |
| Build & run locally         | https://backstage.io/docs/getting-started/ · https://backstage.io/docs/getting-started/create-an-app |
| Local development workflows | https://backstage.io/docs/getting-started/ |
| Compile with TypeScript     | https://backstage.io/docs/tooling/cli/build-system · https://backstage.io/docs/deployment/docker |
| Dependencies (NPM/Yarn)     | https://backstage.io/docs/getting-started/ |
| Docker image build          | https://backstage.io/docs/deployment/docker |

Verified facts:
- Scaffold: `npx @backstage/create-app@latest`. Package manager: **Yarn** (v4.x).
- `yarn start` runs **both** frontend (`:3000`) and backend (`:7007`) locally.
- Node: active LTS (22 or 24). Dev DB: SQLite in-memory; prod: PostgreSQL.
- Docker host build (from repo root): `yarn install --immutable` → `yarn tsc` → `yarn build:backend`,
  then `docker image build . -f packages/backend/Dockerfile --tag backstage`,
  run with `docker run -it -p 7007:7007 backstage`.

## 2. Backstage Infrastructure

| Competency                 | Primary source(s) |
| -------------------------- | ----------------- |
| Understand the framework   | https://backstage.io/docs/overview/what-is-backstage |
| Configure Backstage        | https://backstage.io/docs/conf/ · https://backstage.io/docs/conf/writing |
| Deploy to production       | https://backstage.io/docs/deployment/ · https://backstage.io/docs/deployment/k8s |
| Client-server architecture | https://backstage.io/docs/overview/architecture-overview |

Verified facts:
- Backstage = open source **framework for building developer portals**; created by **Spotify**, a
  **CNCF** project. Three core features: **Software Catalog, Software Templates, TechDocs**.
- Architecture parts: **Core, App, Plugins**. Frontend (React SPA) talks to Backend over **HTTP APIs**.
- Config: `app-config.yaml`; local override `app-config.local.yaml`; prod `app-config.production.yaml`.
  Env substitution via `${VAR}`.
- Backend uses **Knex**; provisions a **separate logical database per plugin**.

## 3. Backstage Catalog

| Competency                        | Primary source(s) |
| --------------------------------- | ----------------- |
| Why/how to use the Catalog        | https://backstage.io/docs/features/software-catalog/ |
| Populate the Catalog              | https://backstage.io/docs/features/software-catalog/descriptor-format |
| Using annotations                 | https://backstage.io/docs/features/software-catalog/well-known-annotations |
| Manually registered locations     | https://backstage.io/docs/features/software-catalog/configuration |
| Troubleshooting entity ingestion  | https://backstage.io/docs/features/software-catalog/well-known-annotations |
| Automated ingestion               | https://backstage.io/docs/features/software-catalog/external-integrations |

Verified facts:
- Entity descriptor file: `catalog-info.yaml`. Required top-level: `apiVersion`, `kind`, `metadata`, `spec`.
- Kinds: Component, API, Resource, System, Domain, Group, User, Location, Template.
- Annotations live under `metadata.annotations`. Well-known keys include
  `backstage.io/managed-by-location` (`<type>:<target>`), `backstage.io/orphan` (`"true"`),
  `backstage.io/techdocs-ref`, `backstage.io/source-location`, `github.com/project-slug` (`<org>/<repo>`).
- Static registration: entries under `catalog.locations` in `app-config.yaml`.
- Manual UI registration ("Register an existing component") points to a **URL of a catalog-info.yaml**.
- Automated ingestion: **entity providers** (e.g., GitHub discovery) keep entities in sync.

## 4. Customizing Backstage

| Competency                    | Primary source(s) |
| ----------------------------- | ----------------- |
| Frontend vs backend plugins   | https://backstage.io/docs/overview/architecture-overview · https://backstage.io/docs/plugins/ |
| Customizing plugins           | https://backstage.io/docs/plugins/ · https://backstage.io/docs/plugins/create-a-plugin |
| React changes in the App      | https://backstage.io/docs/getting-started/app-custom-theme |
| Material UI components        | https://backstage.io/docs/getting-started/app-custom-theme |
| Backend plugins / new backend | https://backstage.io/docs/backend-system/ |

Verified facts:
- **Frontend plugin**: renders UI at a dedicated route (e.g., `/catalog`). **Backend plugin**: server-side,
  exposes HTTP APIs. **Standalone** plugin runs entirely in the browser.
- Third-party SaaS calls needing secrets go through the **backend proxy** (secrets stay server-side).
- Monorepo layout: frontend app in `packages/app`, backend in `packages/backend`.
- UI components: `@backstage/core-components`, built on **Material UI (MUI)**.
- New backend system wiring: `createBackend()` + `backend.add(...)`.
