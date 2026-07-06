# Web BFF Contracts — CBA SaaS Pilot (#36)

Design-time contracts for the first **Web BFF** endpoints of the CBA study platform. This is
documentation only: no backend, framework, auth, database, or AI-orchestration code is implemented
here.

- **Issue:** #36 (part of #33; related to #16 — generic exam SaaS model).
- **Runtime base:** [`ADR-0002`](../adr/0002-cloudflare-nextjs-aws-bff.md) — Cloudflare/Next.js
  frontend; the AWS-hosted Web BFF is the **only browser-reachable backend surface**.
- **Screens served:** [`frontend-screen-map.md`](frontend-screen-map.md) and the versioned prototype
  ([`prototypes/stitch-cba-study-coach/manifest.json`](prototypes/stitch-cba-study-coach/manifest.json)).

## Boundary rules (non-negotiable)

1. **The browser talks only to the Web BFF.** It never reaches the AI Orchestration Service, Bedrock,
   Strands, DynamoDB/S3, or any core service directly. AI runs server-side behind core use cases
   (ADR-0002).
2. **The public contract never exposes internals.** No model IDs, model tiers (`fast/standard/critical`),
   token counts, orchestration/run metadata, port names (`ModelProvider`, `AgentOrchestrator`,
   `AgentRunRepository`), or prompt/trace data appear in any request or response.
3. **Frontend-shaped, not model-shaped.** Responses match what a screen renders, not internal entities.
4. **Deterministic core.** Scores, readiness, and progress are computed deterministically by core
   services. The coach only explains and recommends — it never changes a score.
5. **Source grounding is part of the contract.** Explanations and coach output carry `sourceRefs`
   pointing at official docs (`backstage.io/docs/...`).
6. **AI endpoints must be safe at zero spend.** Any endpoint that may trigger paid AI work defines a
   deterministic fallback and reports it via `mode` (see "No-spend / dry-run" below).

## Conventions

- Base path `/api`, JSON bodies, `camelCase` fields, ISO-8601 UTC timestamps, opaque string ids.
- Auth: the frontend obtains a Cognito-issued session; API Gateway validates it; the BFF receives the
  caller identity (`learnerId`, roles). `/api/admin/*` requires the `admin` role. The prototype may stub
  auth; the contract assumes it.
- Identity is implicit: "my" resources come from the session. Learner ids are never enumerable through
  these endpoints.
- Pagination (list endpoints): `?cursor=` + `?limit=` request, `nextCursor` response (null when done).

### Error shape (all endpoints)

```jsonc
{
  "error": {
    "code": "ATTEMPT_NOT_COMPLETED",      // stable SCREAMING_SNAKE identifier
    "message": "Results are available after the attempt is submitted.",
    "details": { "attemptId": "att_9f2" }, // optional, safe-to-render context
    "requestId": "req_01HZX"               // correlation id for support/observability
  }
}
```

| HTTP | Meaning | Typical codes |
| --- | --- | --- |
| 400 | Invalid input | `VALIDATION_FAILED` |
| 401 | No/expired session | `UNAUTHENTICATED` |
| 403 | Wrong role / not owner | `FORBIDDEN`, `NOT_RESOURCE_OWNER` |
| 404 | Unknown resource | `NOT_FOUND` |
| 409 | State conflict | `ATTEMPT_NOT_COMPLETED`, `MOCK_EXAM_IN_PROGRESS`, `DOMAIN_WEIGHTS_EXCEEDED` |
| 429 | Rate/budget limit | `RATE_LIMITED`, `COACH_RATE_LIMITED` |
| 5xx | Unexpected failure | `INTERNAL` (never carries infra detail) |

Error messages are learner-safe: no stack traces, no service names, no AI/infra vocabulary.

### No-spend / dry-run (coach/AI-touching endpoints)

Paid AI calls are gated server-side behind core use cases with **no-spend/dry-run defaults**
(ADR-0002). Contract consequences:

- Coach-flavored fields always carry `"mode": "grounded" | "deterministic"`.
- With AI spend disabled, budget exhausted, or the AI path degraded, the BFF still returns **200** with
  a deterministic fallback (stored explanation + source link + weakness-based recommendation) and
  `mode: "deterministic"`. AI unavailability is **never** a 5xx and never names the cause.
- Deterministic data (scores, domains, readiness) never depends on the AI path.
- Per-user throttling of coach calls surfaces as `429 COACH_RATE_LIMITED`.
- Dry-run is a server-side configuration, not a client header — the browser cannot toggle spend.

## Mapping to the #16 SaaS model

| #16 entity | Where it appears in these contracts |
| --- | --- |
| **Exam** | `examId` (pilot: fixed `"cba"`); blueprint drives question count, time limit, target |
| **Domain** | `domains[]` with `weightPercent` (CBA: 24/22/22/32); managed by `POST /api/admin/domains` |
| **Competency** | `weakestCompetency`, coach `relatedCompetency`, `competencies[]` under a domain |
| **Source** | `sourceRefs[] { title, url }` on explanations, coach replies, and review drafts |
| **Question** | `questionId` (+ `draftVersion` in admin review); learner surfaces see stems/options, never answer keys before submission |
| **Attempt** | `attemptId` created by `POST /api/mock-exams`; read via `GET /api/attempts/:id/results` |
| **Learner** | implicit session identity; owns attempts/preferences; never enumerable here |

CBA is the pilot configuration of this model, not a special case: every contract binds to
`exam → domain → competency → question`, so a second exam is data, not new endpoints.

---

## 1. `GET /api/dashboard`

- **UX goal:** render the Learner Dashboard (first screen) in one call — readiness, weighted domain
  bars, weakest competency, resume/recommended-drill cards, recent attempts, one coach nudge.
- **Auth:** learner session.
- **Request:** no body. Optional `?examId=` (pilot default `"cba"`).
- **Response sketch (200):**

```jsonc
{
  "exam": { "examId": "cba", "name": "Certified Backstage Associate" },
  "firstRun": false,                        // true → frontend shows warm-up state, not empty bars
  "readiness": { "percent": 68, "targetPercent": 75, "official": false },
  "domains": [
    { "domainId": "dev-workflow", "name": "Backstage Development Workflow",
      "weightPercent": 24, "readinessPercent": 72 },
    { "domainId": "infrastructure", "name": "Backstage Infrastructure",
      "weightPercent": 22, "readinessPercent": 61 },
    { "domainId": "catalog", "name": "Backstage Catalog",
      "weightPercent": 22, "readinessPercent": 55 },
    { "domainId": "customizing", "name": "Customizing Backstage",
      "weightPercent": 32, "readinessPercent": 74 }
  ],
  "weakestCompetency": { "competencyId": "catalog-relations", "domainId": "catalog",
                         "name": "Catalog entities & relationships", "readinessPercent": 41 },
  "resume": { "sessionId": "ps_31a", "kind": "practice", "answered": 4, "total": 10 },  // null if none
  "recommendedDrill": { "domainId": "catalog", "competencyId": "catalog-relations",
                        "questionCount": 10, "reason": "weakest_competency" },
  "recentAttempts": [
    { "attemptId": "att_9f2", "kind": "mock", "scorePercent": 63, "completedAt": "2026-07-05T22:10:00Z" }
  ],
  "coachNudge": {
    "text": "Catalog entity relationships are your weak spot — a focused 10-question drill will help.",
    "action": { "type": "start_drill", "domainId": "catalog", "competencyId": "catalog-relations",
                "questionCount": 10 },
    "sourceRefs": [ { "title": "Software Catalog", "url": "https://backstage.io/docs/features/software-catalog/" } ],
    "mode": "deterministic"                 // dashboard nudges are precomputed; no live AI call on load
  }
}
```

- **Delegates to:** Study & Exam (readiness/attempts — deterministic) and Coach (nudge — served from a
  precomputed/deterministic recommendation; loading the dashboard must never trigger paid AI work).
- **Pilot vs generic:** pilot pins `examId="cba"` and its 4 seeded domains; generic adds the exam
  switcher (same shape per exam, weights from Exam config).
- **Errors:** `401`. First run is `200` with `firstRun: true`, empty `recentAttempts`, null `resume` —
  not an error.
- **No-spend:** `coachNudge.mode` falls back to `"deterministic"`; the rest of the payload is unaffected.

## 2. `POST /api/mock-exams`

- **UX goal:** start the timed 60-question / 90-minute simulation (Mock Exam screen).
- **Auth:** learner session.
- **Request sketch:**

```jsonc
{ "examId": "cba" }   // optional in the pilot; defaults to "cba"
```

- **Response sketch (201):**

```jsonc
{
  "mockExamId": "mock_7c1",
  "attemptId": "att_b44",                  // the Attempt this simulation produces
  "examId": "cba",
  "questionCount": 60,                     // from the Exam blueprint
  "timeLimitSeconds": 5400,                // 90 min, from the Exam blueprint
  "startedAt": "2026-07-06T14:00:00Z",
  "expiresAt": "2026-07-06T15:30:00Z",
  "questions": [                           // order fixed at start; NO answer keys, NO per-question feedback
    { "index": 1, "questionId": "q_812", "domainId": "catalog" }
    // ... 59 more refs; stems/options fetched per question or in pages by the session flow
  ]
}
```

- **Delegates to:** Study & Exam use case *StartMockExam* — assembles a blueprint-weighted set
  (24/22/22/32) from **approved** `QuestionVersion`s in the Question Bank. Purely deterministic; no AI.
- **Pilot vs generic:** 60/5400 are CBA blueprint values, echoed (not hardcoded by the frontend);
  generic reads them per exam. `questions[].domainId` supports the navigator UI in both.
- **Errors:** `401`; `409 MOCK_EXAM_IN_PROGRESS` with `details.mockExamId` (resume, don't fork);
  `400 VALIDATION_FAILED` for an unknown `examId`.
- **Exam-mode rule:** no correctness feedback surfaces until submission (answers/submit/navigator
  endpoints are deferred — see "Deferred endpoints").

## 3. `GET /api/attempts/:id/results`

- **UX goal:** render the Results screen — score vs target, weighted per-domain breakdown, time used,
  missed count, coach summary, concrete next actions.
- **Auth:** learner session; caller must own the attempt.
- **Request:** path param `id` (attemptId). No query params in the pilot.
- **Response sketch (200):**

```jsonc
{
  "attemptId": "att_b44",
  "examId": "cba",
  "kind": "mock",                          // "mock" | "practice"
  "score": { "correct": 41, "total": 60, "percent": 68 },
  "target": { "percent": 75, "official": false },   // rendered as "not an official pass score"
  "domains": [
    { "domainId": "dev-workflow", "name": "Backstage Development Workflow",
      "weightPercent": 24, "correct": 11, "total": 14, "percent": 79 }
    // ... one entry per domain
  ],
  "timeUsedSeconds": 4980,
  "missed": { "count": 19 },               // review list itself = deferred GET /api/attempts/:id/missed
  "nextActions": [
    { "type": "review_missed", "attemptId": "att_b44" },
    { "type": "start_drill", "domainId": "catalog", "questionCount": 10 }
  ],
  "coachSummary": {
    "text": "Solid Development Workflow. Catalog is holding you back — review entity relationships first.",
    "sourceRefs": [ { "title": "Software Catalog", "url": "https://backstage.io/docs/features/software-catalog/" } ],
    "mode": "grounded"
  },
  "completedAt": "2026-07-06T15:23:00Z"
}
```

- **Delegates to:** Study & Exam (deterministic scoring — the authoritative numbers) and Coach (summary
  text; may enrich server-side via the AI path, deterministic-first).
- **Pilot vs generic:** `target` is a CBA pilot constant surfaced by config; generic reads it per exam.
  Shape is exam-agnostic already.
- **Errors:** `401`; `403 NOT_RESOURCE_OWNER`; `404`; `409 ATTEMPT_NOT_COMPLETED` while in progress.
- **No-spend:** `coachSummary.mode: "deterministic"` fallback (rule-based summary from the weakest
  domain); score/domain data never waits on or degrades with the AI path.

## 4. `POST /api/coach/message`

- **UX goal:** the contextual Study Coach panel — **scoped actions, not an open chat console**
  ("Explain this", "What should I study next?").
- **Auth:** learner session.
- **Request sketch:**

```jsonc
{
  "action": "explain_question",            // "explain_question" | "recommend_next" | "explain_domain"
  "context": {                             // exactly the refs the action needs
    "attemptId": "att_b44",
    "questionId": "q_812"
    // "domainId" / "competencyId" for the other actions
  }
}
```

  No free-form prompt field in the pilot: the action enum is the API. (A bounded `note` field is a
  possible generic-future addition, still not a chat.)

- **Response sketch (200):**

```jsonc
{
  "messageId": "cm_5e0",
  "text": "You picked the answer that treats catalog-info.yaml as optional. Backstage requires it to register a component...",
  "sourceRefs": [
    { "title": "Descriptor format", "url": "https://backstage.io/docs/features/software-catalog/descriptor-format/" }
  ],
  "relatedCompetency": { "domainId": "catalog", "competencyId": "catalog-relations" },
  "recommendedAction": { "type": "start_drill", "domainId": "catalog",
                         "competencyId": "catalog-relations", "questionCount": 10 },
  "mode": "grounded"                       // or "deterministic" (fallback)
}
```

- **Delegates to:** Coach use case, which alone may call the **AI Orchestration Service** (server-side,
  behind the #23 ports). The browser never reaches that service; this response never contains model
  IDs, tiers, token usage, run ids, or orchestration/trace data — only learner-facing text, sources,
  and actions.
- **Pilot vs generic:** pilot fixes the three actions above; generic may extend the enum and ground on
  per-exam Source entities. Shape unchanged.
- **Errors:** `400` (unknown action / missing context refs); `401`; `403` (context refs not owned by
  caller); `404` (unknown question/attempt); `429 COACH_RATE_LIMITED`.
- **No-spend / dry-run (required behavior):** with spend disabled or the AI path down, respond `200`
  with the stored item explanation + source + deterministic recommendation and
  `mode: "deterministic"`. Zero-spend mode must keep this endpoint fully usable.

## 5. `GET /api/admin/questions/review`

- **UX goal:** the admin Review Workbench queue — list **AI-drafted questions awaiting human review**
  (the human gate is the only path to learner-visible content).
- **Auth:** admin session (`admin` role). `403 FORBIDDEN` otherwise.
- **Request:** `?status=pending|approved|rejected` (default `pending`), optional `?examId=`,
  `?domainId=`, `?cursor=`, `?limit=` (default 20).
- **Response sketch (200):**

```jsonc
{
  "items": [
    {
      "questionId": "q_913",
      "draftVersion": 2,
      "status": "pending",
      "origin": "ai_draft",                // "ai_draft" | "manual" — provenance flag only, no model info
      "exam": { "examId": "cba" },
      "domain": { "domainId": "catalog", "name": "Backstage Catalog" },
      "competency": { "competencyId": "catalog-relations", "name": "Catalog entities & relationships" },
      "stemPreview": "A team registers a component but its API dependency does not appear...",
      "sourceRef": { "title": "Software Catalog", "url": "https://backstage.io/docs/features/software-catalog/" },
      "createdAt": "2026-07-06T03:12:00Z"
    }
  ],
  "nextCursor": null,
  "counts": { "pending": 12, "approved": 60, "rejected": 5 }
}
```

- **Delegates to:** Authoring & Review use case *ListQuestionsForReview* (reads draft
  `QuestionVersion`s). **Read-only over drafts** — it never triggers generation; the authoring pipeline
  (workflow + AI Orchestration) is internal and not reachable from this surface.
- **Pilot vs generic:** pilot lists the CBA bank only (`examId` filter pre-set); generic makes `examId`
  a first-class filter across tenant exams. `origin` stays a provenance enum — model/tier/run details
  live in internal audit (`AgentRunRepository`), never in this response.
- **Errors:** `401`; `403`; `400` for an invalid `status`. An empty queue is `200` with `items: []`.
- **AI note:** no spend can be triggered from here; approval/rejection actions are deferred endpoints.

## 6. `POST /api/admin/domains`

- **UX goal:** the admin Domain Workspace — configure a domain (name, weight, competencies, source
  rules) for an exam. This endpoint is the seam to the generic exam engine (#16): CBA's four domains
  are the first configuration, not hardcoded product.
- **Auth:** admin session.
- **Request sketch:**

```jsonc
{
  "examId": "cba",
  "name": "Customizing Backstage",
  "slug": "customizing",                   // optional; derived from name when absent
  "weightPercent": 32,
  "competencies": [
    { "name": "Plugins", "slug": "plugins" },
    { "name": "app-config", "slug": "app-config" }
  ],
  "sourceRules": [                         // official-docs allowlist that grounds this domain's content
    { "baseUrl": "https://backstage.io/docs/plugins/" }
  ]
}
```

- **Response sketch (201):**

```jsonc
{
  "domainId": "customizing",
  "examId": "cba",
  "name": "Customizing Backstage",
  "weightPercent": 32,
  "competencies": [ { "competencyId": "plugins", "name": "Plugins" },
                    { "competencyId": "app-config", "name": "app-config" } ],
  "sourceRules": [ { "baseUrl": "https://backstage.io/docs/plugins/" } ],
  "createdAt": "2026-07-06T14:30:00Z"
}
```

- **Delegates to:** Authoring/Domain-setup use case *CreateDomain* — writes the exam blueprint config
  that drives dashboards, mock-exam assembly, and the source-grounded authoring pipeline (crawler
  scope comes from `sourceRules`). Deterministic; no AI.
- **Pilot vs generic:** in the pilot the four CBA domains ship **seeded**, and this endpoint is
  admin-gated and effectively idempotent maintenance (re-creating a seeded slug → `409`). In the
  generic future it is the primary way a new exam takes shape. Same contract in both.
- **Errors:** `400 VALIDATION_FAILED` (missing name, weight out of 1–100); `401`; `403`;
  `404` (unknown exam); `409 DUPLICATE_DOMAIN_SLUG`; `409 DOMAIN_WEIGHTS_EXCEEDED` with
  `details.totalPercent` when the exam's domain weights would exceed 100.

---

## Deferred endpoints (same conventions, later contract passes)

Already sketched per screen in [`frontend-screen-map.md`](frontend-screen-map.md): practice sessions
(`/api/practice-sessions*`, `/api/practice/options`), mock-exam session flow
(`GET /api/mock-exams/:id`, `.../answers`, `.../submit`), missed review (`/api/attempts/:id/missed`),
progress (`/api/progress`), profile/preferences (`/api/me`, `/api/preferences`), and admin review
actions (approve/reject/change). They inherit every rule in this document.

## Out of scope (#36)

- Any implementation (Next.js/BFF/auth/persistence/AI orchestration) — this file is the contract.
- OpenAPI generation — a possible follow-up once the shapes stabilize.
- Question bank content and the internal authoring pipeline.
