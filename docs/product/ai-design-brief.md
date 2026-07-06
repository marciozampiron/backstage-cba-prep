# AI Design Brief — CBA Study Platform (for Stitch UI generation)

Generation brief for **Google Stitch** (connected via the gitignored `.mcp.json`) to produce the first
learner-facing prototype screens. Pair it with [`frontend-screen-map.md`](frontend-screen-map.md), which
defines each screen's goal, content, and states.

- **Issue:** #35 (part of #33, related to #11). **Runtime base:** [`ADR-0002`](../adr/0002-cloudflare-nextjs-aws-bff.md).
- **Output wanted:** high-fidelity **prototype screens / a design mockup** (not production code, not a
  landing page).
- **Generated (delivered):** Google Stitch produced the clean, CBA-aligned prototype package, now
  versioned at [`prototypes/stitch-cba-study-coach/`](prototypes/stitch-cba-study-coach/) — 15 screens
  (desktop + mobile), indexed in [`manifest.json`](prototypes/stitch-cba-study-coach/manifest.json). It
  applies all four CBA domains with weights, visible source chips (`Source: backstage.io/docs/...`), and
  Coach / Study-Recommendation language; it carries no non-CBA exam content and no AI/infra exposure.
  Older Stitch screens outside that folder are stale and must be ignored.

## Product in one line

A calm, focused **certification study platform** where learners practice for the Certified Backstage
Associate exam with source-grounded questions, deterministic progress, and a supportive AI coach.

## Who it's for

Working developers/platform engineers studying for a CNCF/Linux Foundation certification. They study in
short, repeated sessions, often on mobile, and value **trust, speed, and clear progress** over decoration.

## Design north star (read before generating)

Design it like **Duolingo meets a clean analytics dashboard for exam prep** — encouraging and
progress-driven, but precise and trustworthy. **It is not a chatbot and not an AI/agent console.**

**Do:**
- Lead with the learner's **study state and next action** (dashboard-first).
- Make **progress and readiness** legible at a glance (rings, weighted domain bars, trends).
- Treat the **official source link** as a visible trust element on every answer/explanation.
- Keep sessions **distraction-free and thumb-friendly**.

**Do not:**
- No landing/marketing hero as the first screen.
- No chat-first UI, prompt boxes, "AI is thinking" animations, token counters, model names, or
  workflow/agent traces anywhere.
- No exposure of infrastructure (Bedrock, Strands, AWS, tiers). The learner sees product features only.

## Visual language

- **Tone:** trustworthy, calm, focused, encouraging. Enterprise-credible but not corporate-cold.
- **Layout:** generous whitespace, strong typographic hierarchy, card-based dashboard, one clear primary
  action per screen.
- **Color:** a calm neutral base + one confident primary (study/brand accent) + semantic states
  (success/green, warning/amber, error/red) used sparingly for correctness and readiness.
- **Data viz:** a readiness ring (overall %), weighted horizontal bars per domain, a simple trend line
  for progress. Keep charts clean and labeled, never decorative.
- **Components:** cards, progress bars/rings, tags/chips (domain · competency · **source**), segmented
  controls (difficulty/count), a persistent nav (left rail desktop / bottom tab bar mobile), bottom
  sheets for contextual panels (coach, source).
- **Accessibility:** WCAG-AA contrast, large tap targets, keyboard-navigable, reduced-motion friendly,
  scalable text.
- **Responsive:** design **mobile-first**, then desktop. Sessions are full-screen focus on mobile.

## Global elements to reuse across screens

- **App shell:** nav = Dashboard · Practice · Mock Exam · Progress · Coach; top bar with an **exam
  switcher** (CBA selected; dropdown implies future exams), streak, avatar → Settings.
- **Source chip:** `Source: backstage.io/docs/…` — appears on every answer/explanation/coach reply.
- **Readiness component:** overall ring + four weighted domain bars (Development Workflow 24%,
  Infrastructure 22%, Catalog 22%, Customizing 32%).
- **Empty/loading/error states:** every data screen has a calm skeleton, an empty state *with a next
  action*, and a graceful error that still shows the deterministic fallback.

## Screens to generate (prompt seeds)

Generate these as a connected set. Each seed is a starting prompt; hold to the screen-map for content.

1. **Learner Dashboard (first screen).** "A signed-in exam-prep dashboard. Top: greeting + streak and an
   overall readiness ring vs a target. Below: four weighted domain readiness bars; a highlighted
   'weakest area' card with a one-tap drill; 'Resume' and 'Recommended drill' cards; recent attempts
   list. Calm, card-based, mobile-first. Not a landing page."
2. **Practice Setup.** "A focused practice configuration screen: pick a domain (or all), optional
   competency, question count (5/10/20), difficulty, and an 'only questions I missed' toggle. One big
   Start button. Minimal, fast."
3. **Question Session.** "A single multiple-choice question study screen: progress '3/10', a domain +
   competency tag, question text, four options A–D. After answering, show correct/incorrect, an
   explanation, and a visible official 'Source' link chip, then a Next button. Full-screen focus, large
   tap targets, mobile-first."
4. **Mock Exam.** "A timed 60-question, 90-minute exam simulation: a pinned countdown timer, current
   question with A–D options, a flag/mark-for-review control, and a question navigator grid
   (answered/flagged/unseen). No per-question feedback in exam mode. Distraction-free chrome. Submit with
   confirmation."
5. **Results.** "An exam results screen: overall score vs target (clearly 'not an official pass score'),
   a per-domain weighted breakdown, time used, missed count, and a prominent 'Review missed questions'
   primary button plus 'Drill weakest domain'. Encouraging, specific next step."
6. **Review Missed Questions.** "A dense review of missed questions: per item show the question, your
   answer vs the correct answer, an explanation, the official source link, and its domain/competency,
   with 'add to a focused drill'. Swipeable one-per-screen on mobile."
7. **AI Coach (contextual panel).** "A grounded study-coach panel opened from a missed question or the
   dashboard — NOT a blank chatbot. It shows a plain-language explanation grounded in a cited source, the
   competency it maps to, and a 'recommended next drill' action with a Start button. Offer a few scoped
   actions ('Explain this', 'What should I study next?'), not an open prompt console. Calm, brief
   loading — no 'AI thinking' theater."
8. **Progress.** "A progress screen: a readiness trend line over time, per-domain and per-competency
   mastery, attempt history, streak, and 'focus areas' (weakest competencies) each with a drill button.
   Clean analytics feel."
9. **Settings.** "A standard account + study-preferences screen: profile, exam selection (CBA active;
   others 'coming soon'), study reminders, appearance/theme, accessibility (text size, reduce motion),
   data/privacy (export, delete), sign out. Grouped list rows."

## Content tone in the UI

- Encourage, don't judge: "Catalog is your weakest area — a 10-question drill will help" (not "You are
  failing Catalog").
- Always pair a result with a **concrete next action**. Never a dead end.
- Keep the AI coach's voice **grounded and brief**, and always attributed to an official source.

## Acceptance for generated screens

- The **first screen is the learner dashboard**, showing real study state — not a marketing page.
- No screen reveals AI/agent/system internals (models, tiers, orchestration, prompts, traces).
- Source grounding is **visible** on answers, explanations, and coach replies.
- The set reads as a **cohesive SaaS study platform** and works **mobile-first**.
- The layout is generic enough that swapping CBA for another exam is a content change, not a redesign.

## What not to generate

- No backend, API, or AI-orchestration UI. No admin/authoring/review screens (separate package).
- No landing/pricing/marketing pages. No chat-console home. No infrastructure diagrams in the learner UI.
