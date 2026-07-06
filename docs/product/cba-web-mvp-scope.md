# CBA Web MVP — Consolidated Scope (#15)

The first sellable web experience, **CBA only**, built to prove the learner loop before any
generalization. This document consolidates the scope that #35 (screens + prototype), #36 (BFF
contracts), and #16 (data model) already specify, resolves the remaining scope tensions, and defines
the MVP's success metrics.

- **Issue:** #15 (Phase 1 — CBA Web MVP). Implementation vehicle: #11 (thin web simulator) under
  epic #33; runtime per [`ADR-0002`](../adr/0002-cloudflare-nextjs-aws-bff.md).
- **Inputs:** [`frontend-screen-map.md`](frontend-screen-map.md) + versioned prototype
  ([`prototypes/stitch-cba-study-coach/`](prototypes/stitch-cba-study-coach/)),
  [`web-bff-contracts.md`](web-bff-contracts.md), [`saas-data-model.md`](saas-data-model.md).

## The learner loop the MVP must prove

```txt
sign in → dashboard (readiness + weakest area)
   → start a drill or a full mock (one question at a time)
      → drill: explanation + official source after each answer
      → mock: 60Q / 90min, feedback only after submit
   → results by domain/competency → review missed questions (grounded in sources)
      → recommended next drill (deterministic)
   → return tomorrow and measurably improve the weakest domain
```

If a learner completes attempts, returns, and their weakest domain improves, the loop is proven and
Phase 2+ investment is justified. Everything in scope serves that loop; everything else waits.

## In scope — flows mapped to what already exists

Every MVP flow is already specified end-to-end. The build phase (#11) implements against these
artifacts — no new design decisions should be needed:

| MVP flow (issue #15) | Screen (#35 / prototype) | BFF contract (#36) | Entities (#16) | Phase 0 CLI concept |
| --- | --- | --- | --- | --- |
| Dashboard after login (first screen) | Learner Dashboard (desktop + mobile) | `GET /api/dashboard` | Exam, Domain, ProgressSnapshot, Attempt, Learner | blueprint + `stats` |
| Configure and start a domain drill | Practice Setup | `GET /api/practice/options`, `POST /api/practice-sessions` *(2nd contract pass)* | Exam, Domain, Competency, Attempt | bank + blueprint |
| Answer one question at a time (drill: instant feedback + source) | Question/Practice Session | `GET .../next`, `POST .../answers` *(2nd contract pass)* | Attempt, AttemptAnswer, QuestionVersion, Source | bank + `validate`d items |
| Full mock exam (60Q / 90min, no per-question feedback) | Mock Exam | `POST /api/mock-exams` (+ session flow, 2nd pass) | Exam, Domain, QuestionVersion, Attempt | blueprint + simulator |
| Score by domain/competency | Results / Mock Exam Results | `GET /api/attempts/:id/results` | Attempt, AttemptAnswer, Domain, Competency | deterministic `score` |
| Review missed with explanation + official source | Review Missed Questions (+ Result Explanation) | `GET /api/attempts/:id/missed` *(2nd contract pass)* | AttemptAnswer, QuestionVersion, Source | bank explanations + sources |
| Study guidance at the end | Dashboard `recommendedDrill` + Results next actions + Study Coach panel | `POST /api/coach/message` (deterministic mode) | ProgressSnapshot, Source | `stats` weak-domain output |
| Save attempts per learner | (implicit — powers dashboard/progress) | session identity on every call | Learner, Attempt, AttemptAnswer, ProgressSnapshot | local attempt history → per-user |

Plus the supporting surfaces already designed: Progress (trends) and Settings (preferences, exam
switcher seam) — shipped thin.

## Explicit scope decisions (consolidation)

These resolve the tensions between issue #15's original wording and what #16/#36 later fixed:

1. **"Study plan" in the MVP = deterministic next-step guidance**, not the `StudyPlan` entity. The
   dashboard's `recommendedDrill`, results `nextActions`, and weakest-competency callout are the
   embryo (#16 defers the full `StudyPlan` to Phase 2/3). The MVP must always answer *"what should I
   study next?"* — it does not manage multi-week plans.
2. **Coach ships deterministic-first, zero-spend safe.** The Study Coach panel uses the #36 contract
   in `mode: "deterministic"` (stored explanations + sources + weakness-based recommendations). The
   grounded AI mode (Phase 3, #12) can be enabled later **without any frontend change** — that is what
   the `mode` field is for. No free-form chat in any mode (issue non-goal).
3. **Attempts are saved per learner from day one.** "Save attempts per user" requires identity, so the
   MVP includes minimal auth (Cognito-mediated session per ADR-0002 — sign-in only, no profiles
   beyond `Learner` basics). Phase 2 (#13/#17/#18) deepens accounts, adaptive mastery, and analytics —
   it does not introduce persistence, which the MVP already has via `Attempt`/`AttemptAnswer`/
   `ProgressSnapshot`.
4. **Admin surfaces are out of the learner MVP.** The #36 admin contracts
   (`/api/admin/questions/review`, `/api/admin/domains`) and the review workbench ship with the
   authoring pipeline (Phase 4), not here. The MVP consumes the migrated, already-approved 60-item
   bank (#16 migration mapping).
5. **Content is the existing bank.** The 60 approved CBA items migrate 1:1 into published
   `QuestionVersion`s; no new content work is in MVP scope.

## Non-goals (unchanged from issue #15, reaffirmed)

- Billing / subscriptions (Phase 6; `Tenant`/`Entitlement` stay dormant).
- Multi-cert authoring or generic exam ingestion (Phase 5; the model already supports it as data).
- Autonomous publishing of AI-generated questions (human gate is non-negotiable).
- Free-form AI chat outside exam domains/sources (coach is action-scoped by contract).
- Native apps; the web app is mobile-first responsive (#35 mobile behavior).

## Success metrics (MVP definition of "the loop is proven")

Deterministic, computable from `Attempt`/`AttemptAnswer`/`ProgressSnapshot` — no analytics platform
required for v1:

| Metric | Definition | MVP target (initial hypothesis) |
| --- | --- | --- |
| **Activation** | new learner completes a first drill (≥ 5 questions) in the first session | ≥ 60% |
| **Completed attempts** | submitted drills + mocks per active learner per week | ≥ 3 |
| **Returning learners** | learners who start another attempt within 7 days of their first | ≥ 40% |
| **Weak-domain improvement** | readiness delta on the learner's initially weakest domain after ≥ 3 attempts | positive for ≥ 50% of returning learners |
| **Time to first question** | sign-in → first question answered (first-run flow, #35) | ≤ 2 minutes |

Targets are starting hypotheses to calibrate after the first cohort; the *definitions* are the
deliverable. Guardrail: mock completion rate (started → submitted) should stay ≥ 70% — a lower number
signals the 90-minute simulation is mis-paced for the audience.

## Build order (thin slices for #11)

1. **Drill loop** — stub session identity; dashboard (first-run state) → practice setup → question
   session with explanation + source → mini-results. Proves the core loop on the migrated bank.
2. **Mock exam** — timer, navigator, submit, results by domain/competency.
3. **Review + guidance** — review missed, deterministic coach panel, recommended next drill.
4. **Real sessions + persistence** — Cognito-mediated auth, per-learner attempts, readiness snapshot,
   progress screen; metrics instrumentation (the five above).

Prerequisite for slices 1/3: the **second BFF contract pass** (practice sessions, answers/submit,
missed review, progress, preferences — already listed as deferred in #36).

## Acceptance criteria from issue #15 — status

| Criterion | Status |
| --- | --- |
| Designer/agent can build wireframes without guessing core flows | **Met** — #35 screen map + the versioned Stitch prototype (15 screens, desktop + mobile) |
| Engineering can map each screen to existing CLI concepts (bank, blueprint, score, history, stats) | **Met** — mapping table above + #16 JSON bank migration mapping |
| MVP success metrics defined (completed attempts, returning learners, weak-domain improvement) | **Met** — metrics table above, computable from the #16 model |

## Out of scope for this document

- Implementation (#11), infrastructure sizing, and the physical DB choice (deferred in #16).
- The second BFF contract pass itself (flagged as the next design task).
- Any change to prototype, contracts, or data model — this document consolidates; it does not amend.
