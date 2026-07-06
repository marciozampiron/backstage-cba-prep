# Web BFF Contracts — CBA SaaS Pilot (#36, #38)

Design-time contracts for the **Web BFF** endpoints of the CBA study platform. This is
documentation only: no backend, framework, auth, database, or AI-orchestration code is implemented
here.

- **Issues:** #36 (first pass — §1–§6) and #38 (second pass — §7–§17), part of #33; related to #16
  (data model) and #15 (MVP scope; the second pass unblocks the #11 build slices).
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
- **Exam-mode rule:** no correctness feedback surfaces until submission. The session flow —
  resume/navigator, silent answer saves, and idempotent submit — is specified in §11–§13.

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
  "missed": { "count": 19 },               // review list: GET /api/attempts/:id/missed (§14)
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

## Second contract pass (#38) — sessions, review, progress, preferences

Completes the learner MVP surface so #11 can be built without guessing an endpoint. Everything in
this pass is **fully deterministic**: feedback and explanations come from published
`QuestionVersion` content and `Source` refs, progress from `ProgressSnapshot` — **no endpoint here
may trigger paid AI work**, so the no-spend rules are trivially satisfied. All conventions above
(auth, error envelope, pagination, ownership) apply unchanged.

## 7. `GET /api/practice/options`

- **UX goal:** populate Practice Setup in one call — domain/competency pickers, counts, difficulty,
  and a smart prefill.
- **Auth:** learner session.
- **Request:** optional `?examId=` (pilot default `"cba"`).
- **Response sketch (200):**

```jsonc
{
  "exam": { "examId": "cba" },
  "domains": [
    { "domainId": "catalog", "name": "Backstage Catalog", "weightPercent": 22,
      "competencies": [ { "competencyId": "catalog-relations", "name": "Catalog entities & relationships" } ] }
    // ... all four domains
  ],
  "questionCounts": [5, 10, 20],
  "difficulties": ["mixed", "easy", "medium", "hard"],
  "toggles": { "onlyMissed": true },       // supported filters
  "recommended": { "domainId": "catalog", "competencyId": "catalog-relations",
                   "questionCount": 10, "reason": "weakest_competency" }
}
```

- **Delegates to:** Exam Content reads; `recommended` comes from the learner's `ProgressSnapshot`.
- **Pilot vs generic:** CBA's seeded structure; generic serves any `examId`. Same shape.
- **Errors:** `401`; `400` unknown exam.

## 8. `POST /api/practice-sessions`

- **UX goal:** start a focused drill from Practice Setup (or "add missed to a drill" from Review).
- **Auth:** learner session.
- **Request sketch:**

```jsonc
{
  "examId": "cba",                          // optional, defaults to "cba"
  "domainId": "catalog",                    // optional (absent = all domains)
  "competencyId": "catalog-relations",      // optional, requires domainId
  "questionCount": 10,                      // 5 | 10 | 20
  "difficulty": "mixed",                    // optional, default "mixed"
  "onlyMissed": false                       // true = only questions the learner missed before
}
```

- **Response sketch (201):** `{ "practiceSessionId": "ps_31a", "attemptId": "att_c02",
  "kind": "practice", "config": { ...echo... }, "questionCount": 10,
  "startedAt": "2026-07-06T18:00:00Z" }` — questions come one at a time via `/next`.
- **Delegates to:** Simulation use case *StartDrill* — assembles from **published**
  `QuestionVersion`s honoring the filters; `onlyMissed` reads the learner's `AttemptAnswer` history.
- **Pilot vs generic:** identical; filters already bind to `domainId`/`competencyId`.
- **Errors:** `401`; `400 VALIDATION_FAILED` (unknown domain/competency, bad count);
  `400 INSUFFICIENT_QUESTIONS` with `details.available` when the filter can't fill the count
  (frontend offers the lower count).

## 9. `GET /api/practice-sessions/:id/next`

- **UX goal:** fetch the current question of a drill (Question Session screen).
- **Auth:** learner session; caller owns the session.
- **Response sketch (200):**

```jsonc
{
  "done": false,                            // true when the session is finished (then see summary)
  "index": 3, "total": 10,
  "question": {
    "questionVersionId": "qv_812_v1",
    "stem": "A team registers a component but its API dependency does not appear...",
    "options": [ { "key": "A", "text": "..." }, { "key": "B", "text": "..." },
                 { "key": "C", "text": "..." }, { "key": "D", "text": "..." } ],
    "domain": { "domainId": "catalog", "name": "Backstage Catalog" },
    "competency": { "competencyId": "catalog-relations", "name": "Catalog entities & relationships" }
  }
}
```

  When finished: `{ "done": true, "attemptId": "att_c02", "resultsUrl": "/api/attempts/att_c02/results" }`.
  **No `correctOption` in this payload, ever.**

- **Delegates to:** Simulation session read (pinned `questionOrder`).
- **Errors:** `401`; `403 NOT_RESOURCE_OWNER`; `404`.

## 10. `POST /api/practice-sessions/:id/answers`

- **UX goal:** submit an answer and get **instant grounded feedback** (drill mode).
- **Auth:** learner session; caller owns the session.
- **Request sketch:** `{ "index": 3, "questionVersionId": "qv_812_v1", "selectedOption": "B",
  "timeSpentSeconds": 42 }` — the version id is echoed back as a pin-check.
- **Response sketch (200):**

```jsonc
{
  "correct": false,
  "correctOption": "C",
  "explanation": "Backstage resolves catalog relations from entity descriptor references...",
  "whyOthersWrong": null,                   // optional, when the item provides it
  "sourceRefs": [ { "title": "Software Catalog", "url": "https://backstage.io/docs/features/software-catalog/" } ],
  "progress": { "answered": 3, "total": 10 },
  "nextIndex": 4                            // null when this was the last question
}
```

- **Deterministic by contract:** feedback comes from the published `QuestionVersion` (explanation +
  sources) — this endpoint never calls the AI path. "Ask the coach about this" goes through
  `POST /api/coach/message` (§4) separately.
- **Delegates to:** Simulation use case *AnswerDrillQuestion* (writes `AttemptAnswer`).
- **Errors:** `401`; `403`; `404`; `400 VALIDATION_FAILED` (bad index/option);
  `409 VERSION_MISMATCH` (`questionVersionId` differs from the pinned one);
  `409 ALREADY_ANSWERED` (re-post with a *different* selection; an identical re-post returns `200`
  with the same payload — safe retry).

## 11. `GET /api/mock-exams/:id`

- **UX goal:** load/resume the Mock Exam screen — timer, navigator grid, and one question view.
- **Auth:** learner session; caller owns the mock.
- **Request:** optional `?index=` (defaults to the first unanswered question).
- **Response sketch (200):**

```jsonc
{
  "mockExamId": "mock_7c1", "attemptId": "att_b44",
  "status": "in_progress",                  // in_progress | submitted | expired
  "remainingSeconds": 3120, "expiresAt": "2026-07-06T15:30:00Z",
  "navigator": [ { "index": 1, "answered": true, "flagged": false }
                 // ... 60 entries, no correctness info
               ],
  "question": {
    "index": 7, "questionVersionId": "qv_231_v2",
    "stem": "...", "options": [ { "key": "A", "text": "..." } /* ... */ ],
    "selectedOption": null, "flagged": false
  }
}
```

- **Exam-mode rule:** no correctness anywhere in this payload — only answered/flagged state.
- **Delegates to:** Simulation session read.
- **Errors:** `401`; `403`; `404`. An expired-but-unsubmitted mock returns `200` with
  `status: "expired"` and the auto-submitted results reference once processed.

## 12. `POST /api/mock-exams/:id/answers`

- **UX goal:** save (or replace/clear) an answer and flag state during the mock — silent, no feedback.
- **Auth:** learner session; caller owns the mock.
- **Request sketch:** `{ "index": 7, "questionVersionId": "qv_231_v2", "selectedOption": "B",
  "flagged": false }` — `selectedOption: null` clears; answers are replaceable until submit
  (unlike practice).
- **Response sketch (200):** `{ "saved": true, "answeredCount": 41, "flaggedCount": 3,
  "remainingSeconds": 3050 }` — **no correctness**.
- **Delegates to:** Simulation use case *SaveMockAnswer* (upserts `AttemptAnswer`; correctness is
  computed only at submit).
- **Errors:** `401`; `403`; `404`; `400`; `409 ATTEMPT_NOT_IN_PROGRESS` (already submitted/expired);
  `409 VERSION_MISMATCH`.

## 13. `POST /api/mock-exams/:id/submit`

- **UX goal:** submit the mock (confirm dialog) — or the server auto-submits at `expiresAt`.
- **Auth:** learner session; caller owns the mock.
- **Request:** empty body. **Idempotent:** re-submitting returns the same result.
- **Response sketch (200):** `{ "attemptId": "att_b44", "status": "submitted",
  "submittedAt": "2026-07-06T15:23:00Z", "autoSubmitted": false,
  "resultsUrl": "/api/attempts/att_b44/results" }` — the frontend then loads §3 for the Results
  screen.
- **Delegates to:** Simulation use case *SubmitMockExam* — deterministic scoring of all
  `AttemptAnswer`s, per-domain rollup, then folds into `ProgressSnapshot`.
- **Errors:** `401`; `403`; `404`. Submitting an expired mock returns `200` with
  `autoSubmitted: true` (unanswered items score as incorrect — matches the real exam).

## 14. `GET /api/attempts/:id/missed`

- **UX goal:** the Review Missed Questions screen — dense, grounded review of every missed item.
- **Auth:** learner session; caller owns the attempt; attempt must be completed.
- **Request:** `?cursor=` + `?limit=` (default 20).
- **Response sketch (200):**

```jsonc
{
  "attemptId": "att_b44",
  "items": [
    {
      "index": 7,
      "questionVersionId": "qv_231_v2",
      "stem": "...",
      "options": [ { "key": "A", "text": "..." } /* ... */ ],
      "selectedOption": "B",
      "correctOption": "C",
      "explanation": "...",
      "whyOthersWrong": null,
      "sourceRefs": [ { "title": "TechDocs", "url": "https://backstage.io/docs/features/techdocs/" } ],
      "domain": { "domainId": "infrastructure", "name": "Backstage Infrastructure" },
      "competency": { "competencyId": "techdocs-config", "name": "TechDocs configuration" }
    }
  ],
  "nextCursor": null
}
```

  "Add to a focused drill" is not a separate endpoint: the frontend calls
  `POST /api/practice-sessions` with `onlyMissed: true` (+ optional `domainId`). "Ask the coach"
  uses §4 with the item's refs.

- **Delegates to:** Simulation read (incorrect `AttemptAnswer`s joined with their pinned versions).
- **Errors:** `401`; `403`; `404`; `409 ATTEMPT_NOT_COMPLETED`. No misses → `200` with `items: []`
  (frontend celebrates and suggests a harder mock).

## 15. `GET /api/progress`

- **UX goal:** the Progress screen — readiness trend, per-domain/competency mastery, attempt
  history, focus areas.
- **Auth:** learner session.
- **Request:** optional `?examId=`; `?cursor=`/`?limit=` page the attempt history.
- **Response sketch (200):**

```jsonc
{
  "exam": { "examId": "cba", "name": "Certified Backstage Associate" },
  "current": {
    "overall": { "readinessPercent": 68, "targetPercent": 75 },
    "perDomain": [ { "domainId": "catalog", "name": "Backstage Catalog",
                     "weightPercent": 22, "readinessPercent": 55, "answered": 34, "correct": 19 } ],
    "perCompetency": [ { "competencyId": "catalog-relations", "domainId": "catalog",
                         "readinessPercent": 41, "answered": 12, "correct": 5 } ]
  },
  "trend": [ { "asOf": "2026-07-01T00:00:00Z", "readinessPercent": 52 } ],   // [] while cold-start
  "trendUnlockAfterAttempts": 3,            // frontend shows "take more practice to unlock trends"
  "streak": { "current": 4, "lastStudyDate": "2026-07-06" },
  "focusAreas": [ { "competencyId": "catalog-relations", "name": "Catalog entities & relationships",
                    "domainId": "catalog", "readinessPercent": 41,
                    "drill": { "questionCount": 10 } } ],
  "attempts": { "items": [ { "attemptId": "att_b44", "kind": "mock", "scorePercent": 68,
                             "completedAt": "2026-07-06T15:23:00Z" } ], "nextCursor": null }
}
```

- **Delegates to:** Learner Progress reads (`ProgressSnapshot` history + attempts). Deterministic.
- **Pilot vs generic:** identical; multi-exam later selects by `examId`.
- **Errors:** `401`. Cold-start is `200` with empty trend, not an error.

## 16. `GET /api/me` · `PUT /api/me`

- **UX goal:** Settings — profile and active exam.
- **Auth:** learner session (identity from the session; no ids in the URL).
- **GET response (200):** `{ "displayName": "Marcio", "email": "m@example.com",
  "activeExam": { "examId": "cba", "name": "Certified Backstage Associate" },
  "createdAt": "2026-06-01T12:00:00Z" }`.
- **PUT request:** partial — `{ "displayName"?, "activeExamId"? }` → `200` with the updated GET
  shape. Email changes go through the identity provider flow, not this endpoint.
- **Delegates to:** Learner profile use cases.
- **Pilot vs generic:** pilot exposes the single seeded exam in `activeExam` (switcher disabled);
  generic validates `activeExamId` against the learner's available exams.
- **Errors:** `401`; `400 VALIDATION_FAILED` (empty name, unknown exam).

## 17. `GET /api/preferences` · `PUT /api/preferences`

- **UX goal:** Settings — study reminders, appearance, accessibility.
- **Auth:** learner session.
- **GET response (200):**

```jsonc
{
  "reminders": { "enabled": true, "timeOfDay": "08:00", "days": ["mon","tue","wed","thu","fri"] },
  "appearance": { "theme": "system" },      // system | light | dark
  "accessibility": { "textScale": 1.0, "reduceMotion": false }
}
```

- **PUT request:** partial merge of the same shape → `200` with the full updated object.
- **Delegates to:** Learner preferences use cases. Deterministic; preferences never affect scoring.
- **Errors:** `401`; `400 VALIDATION_FAILED` (unknown theme, out-of-range scale).

---

## Deferred endpoints (same conventions, later contract passes)

Only the **admin review actions** remain unspecified: approve / reject / request-changes on a draft
`QuestionVersion` (completing a `ReviewTask`, #16 §11). They ship with the Phase 4 authoring
pipeline and inherit every rule in this document. Learner-surface contracts are complete as of #38.

## Out of scope (#36, #38)

- Any implementation (Next.js/BFF/auth/persistence/AI orchestration) — this file is the contract.
- OpenAPI generation — a possible follow-up once the shapes stabilize.
- Question bank content and the internal authoring pipeline.
