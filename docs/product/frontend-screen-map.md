# Frontend Prototype — Screen Map (CBA Web MVP)

Design package for the first learner-facing prototype of the **Certified Backstage Associate (CBA)**
study platform. It is the input for UI generation (Google Stitch); see
[`ai-design-brief.md`](ai-design-brief.md) for the generation prompts.

- **Issue:** #35 (part of #33, related to #11).
- **Runtime base:** [`ADR-0002`](../adr/0002-cloudflare-nextjs-aws-bff.md) — Cloudflare/Next.js frontend,
  AWS Web BFF, AI Orchestration behind the BFF.
- **Not in scope:** real frontend code, backend/BFF, AI orchestration changes, admin/authoring screens.
- **BFF contracts:** the per-screen "BFF" data sketches below are formalized in
  [`web-bff-contracts.md`](web-bff-contracts.md) (#36) — conventions, error shape, no-spend rules, and
  the first six endpoint contracts.
- **Generated prototype:** the Stitch-generated, CBA-aligned learner screens are versioned at
  [`prototypes/stitch-cba-study-coach/`](prototypes/stitch-cba-study-coach/). Its
  [`manifest.json`](prototypes/stitch-cba-study-coach/manifest.json) is the authoritative index — 15
  screens (desktop + mobile) with Stitch screen IDs and per-screen `code.html` / `screen.png` /
  `metadata.json`. Older Stitch screens outside that folder are stale and must be ignored.

## Product principles (non-negotiable for these screens)

1. **A SaaS study platform, not an agent console.** No chat-first UI, no prompt boxes, no workflow
   traces, no "AI is thinking" theater. The learner sees exams, drills, progress, and explanations.
2. **First screen is the learner dashboard**, not a marketing landing page. The signed-in learner lands
   on their study state immediately.
3. **The browser only talks to the Web BFF.** No screen references Bedrock, Strands, model names, tiers,
   or AI orchestration. "AI coach" is a product feature, not an exposed system.
4. **Source-grounded, always visible.** Every answer/explanation shows its official source link
   (backstage.io/docs). Trust is a first-class UI element, never hidden behind AI prose.
5. **CBA is the pilot; the model is generic.** Screens bind to `exam → domain → competency → question`,
   not to CBA-specific hardcoding, so a second exam reuses the same UI.

## The CBA domain (data these screens render)

- Exam: **Certified Backstage Associate** — 60 questions, 90 minutes, ~75% target (not official).
- Four domains with weights: **Development Workflow 24%**, **Infrastructure 22%**, **Catalog 22%**,
  **Customizing 32%** — each with competencies.
- Questions are multiple-choice (A–D), each mapped to one domain + one competency + one official source.
- Scoring and progress are **deterministic**; the AI coach only *explains and recommends*.

## Navigation model

- **App shell** (persistent) for signed-in learners:
  - Left rail (desktop) / bottom tab bar (mobile): **Dashboard · Practice · Mock Exam · Progress · Coach**.
  - Top bar: exam switcher (CBA pilot; dropdown ready for future exams), streak/nudge, avatar → Settings.
- Deep, focused surfaces (Question Session, Results, Review) take over the content area; the shell stays
  for orientation but recedes during a timed session.

## Screen inventory

Each screen lists its **primary user goal**, key content, primary actions, the BFF data it needs
(frontend-shaped, never internal models), key states, and mobile behavior.

### 1. Learner Dashboard — *"What should I study right now?"*

- **Goal:** land on study state and start practicing in one tap.
- **Content:** greeting + streak; **overall readiness** (deterministic % vs the ~75% target); per-domain
  readiness bars (the four domains, weighted); **weakest competency** callout; "Continue" (resume last
  session) and "Recommended drill" cards; recent attempts (last 3); one grounded coach nudge
  (e.g., "Catalog entity relationships are your weak spot — 10-question drill?").
- **Primary actions:** Start recommended drill · Resume · Start mock exam · Open a domain.
- **BFF:** `GET /api/dashboard` → readiness overall + per domain, weakest competency, recent attempts,
  one coach recommendation (already resolved server-side; no model details).
- **States:** first-run (no attempts → "Take a 5-question warm-up" + domain overview instead of empty
  bars); returning; all-domains-strong (encourage a full mock).
- **Mobile:** single column; readiness ring on top; recommended drill as the primary CTA.

### 2. Practice Setup — *"Configure a focused drill."*

- **Goal:** choose what to practice without friction.
- **Content:** domain selector (all / one of the four); optional competency filter; count (5/10/20);
  difficulty (mixed default); "only missed before" toggle; source-grounding note.
- **Primary actions:** Start drill (primary) · Save as preset.
- **BFF:** `GET /api/practice/options` (domains, competencies, counts); `POST /api/practice-sessions`.
- **States:** default (recommended prefilled from weakest area); invalid (count > available).
- **Mobile:** stacked selectors; sticky Start button.

### 3. Question Session — *"Answer, learn why, move on."*

- **Goal:** answer one question at a time with immediate, grounded feedback (drill mode).
- **Content:** progress (e.g., 3/10) + domain/competency tag; question stem; A–D options; after answer →
  correct/incorrect, the **explanation**, and the **official source link**; "Why the others are wrong"
  (optional, from the item); next.
- **Primary actions:** Select option → Submit → Next · Flag · End session.
- **BFF:** `GET /api/practice-sessions/:id/next`, `POST /api/practice-sessions/:id/answers`.
- **States:** unanswered; answered-correct; answered-incorrect; flagged; last question → to Results.
- **Mobile:** full-screen focus; option tap targets large; explanation expands inline; source link chip.

### 4. Mock Exam — *"Simulate the real 60-question, 90-minute exam."*

- **Goal:** a realistic, uninterrupted timed simulation.
- **Content:** exam mode = **no per-question feedback**; countdown timer (90:00); question navigator
  (answered/flagged/unseen grid); mark-for-review; minimal chrome (the shell recedes).
- **Primary actions:** Answer · Flag · Jump (navigator) · Submit exam (with confirm) · auto-submit on time.
- **BFF:** `POST /api/mock-exams` (start), `GET /api/mock-exams/:id`, `POST /api/mock-exams/:id/answers`,
  `POST /api/mock-exams/:id/submit`.
- **States:** in-progress; time-warning (<5 min); paused (if allowed); submitting; auto-submitted.
- **Mobile:** timer pinned top; navigator as a bottom sheet; distraction-free.

### 5. Results — *"How did I do, and what next?"*

- **Goal:** clear score + a concrete next step (never a dead end).
- **Content:** overall score vs target (pass-likelihood framing, clearly "not official"); per-domain
  breakdown (weighted bars, right/total); time used; count of missed; **primary CTA "Review missed
  questions"**; secondary "Drill weakest domain"; grounded coach summary (deterministic-first).
- **Primary actions:** Review missed · Drill weakest · Back to dashboard · Retake mock.
- **BFF:** `GET /api/attempts/:id/results` → per-domain scores, missed list refs, one coach summary.
- **States:** passed-likely; borderline; below target — each with an encouraging, specific next step.
- **Mobile:** score ring first; domain bars; sticky "Review missed".

### 6. Review Missed Questions — *"Turn mistakes into mastery."*

- **Goal:** fast, dense review of missed items with grounding.
- **Content:** list/carousel of missed questions; per item: stem, your answer vs correct, explanation,
  **source link**, domain/competency; "add to focused drill" affordance.
- **Primary actions:** Next/prev · Add to drill · Open source · Ask coach about this item.
- **BFF:** `GET /api/attempts/:id/missed` (or `/api/review?attempt=`).
- **States:** empty (no misses → celebrate + suggest a harder mock); reviewing.
- **Mobile:** one item per screen, swipe; source + coach as chips.

### 7. AI Coach — *"Explain why I missed this and what to study."*

- **Goal:** grounded, learner-facing guidance — **support, not a chatbot playground**.
- **Content:** contextual panel (opened from a missed item, a domain, or the dashboard nudge), not a
  blank chat. Shows: a plain-language explanation grounded in the cited source; the domain/competency
  it maps to; a **recommended next drill** (deterministic weakness → action). Limited, scoped prompts
  ("Explain this", "What should I study next?") rather than an open agent console.
- **Primary actions:** Explain this item · Recommend next drill · Open source · Start recommended drill.
- **BFF:** `POST /api/coach/message` (frontend-shaped: returns grounded text + a recommended action +
  source refs; **no model/tier/orchestration details**). No-spend/dry states handled server-side.
- **States:** loading (calm, brief — no "agent thinking" theater); grounded answer; unavailable
  (graceful, still shows the source + deterministic recommendation).
- **Mobile:** bottom sheet contextual panel; never a full-screen chat as the main surface.

### 8. Progress — *"Am I getting better, and where?"*

- **Goal:** show mastery trend and weak areas over time (deterministic).
- **Content:** readiness trend line; per-domain and per-competency mastery; attempts history; streak;
  "focus areas" (weakest competencies) with a drill CTA each.
- **Primary actions:** Drill a weak competency · Open an attempt's results · Start a mock.
- **BFF:** `GET /api/progress` (trends, per-domain/competency mastery, attempts).
- **States:** cold-start (few attempts → "take more practice to unlock trends"); established.
- **Mobile:** trend on top; domains as a collapsible list; competencies behind a domain tap.

### 9. Settings — *"Make it mine and manage my account."*

- **Goal:** low-frequency account + study preferences.
- **Content:** profile; exam selection (CBA now; future exams disabled/coming-soon); study reminders;
  theme/appearance; accessibility (text size, reduce motion); data/privacy (export, delete); sign out.
- **Primary actions:** Save preferences · Manage account · Sign out.
- **BFF:** `GET/PUT /api/me`, `GET/PUT /api/preferences`.
- **States:** default; saving; saved; destructive-confirm (delete).
- **Mobile:** grouped list rows; standard mobile settings pattern.

## First-run flow

1. **Sign in** (auth handled by the BFF/Cognito; the prototype can stub it) → **Dashboard**, not a
   landing page.
2. First-run dashboard has **no scary empty bars**: show a short domain overview + a **5-question
   warm-up** CTA + "what CBA covers" (the four domains).
3. Warm-up → Question Session (drill mode) → mini-Results → Dashboard now shows first readiness signal +
   a recommended next drill. The learner is "in the loop" within ~2 minutes.

## Global patterns

- **Source grounding is a component**, reused on every answer/explanation/coach reply (a "Source:
  backstage.io/docs/…" chip that opens the official doc).
- **States for every data screen:** loading (calm skeletons), empty (with a next step), error (retry +
  the deterministic fallback still shown).
- **No agent/system exposure:** never show model names, tiers, tokens, orchestration, or workflow traces
  on any learner screen.
- **Accessibility:** large tap targets, keyboard navigable, reduced-motion honored, WCAG-AA contrast.

## Mobile behavior (summary)

- Bottom tab bar replaces the left rail: **Dashboard · Practice · Mock · Progress · Coach**.
- Question Session and Mock Exam are **full-screen focus** modes; the mock timer pins to the top and the
  navigator is a bottom sheet.
- Coach and source are **contextual sheets**, never a full-screen chatbot.
- One primary CTA per screen, thumb-reachable and sticky where it matters (Start drill, Review missed).

## Extensibility (generic exam model)

- Every screen binds to `exam → domain → competency → question` with a **weighting** per domain, so a new
  exam is a data change, not a redesign.
- The exam switcher in the top bar is the seam for multi-exam; CBA is the only enabled option in the pilot.
- Copy avoids CBA-only phrasing where a generic label works ("domains", "competencies", "readiness").

## Out of scope (this package)

- Admin/authoring/review screens (separate package).
- Real auth, real data, billing, and the actual Next.js/BFF implementation.
- Any exposure of Bedrock/Strands/AI orchestration in the learner UI.
