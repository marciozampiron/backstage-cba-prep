// Regression smoke (#40 blocker): submitting a mock exam with ZERO answers must not break the
// dashboard. Unanswered questions count as incorrect in the per-domain readiness rollup, and the
// dashboard falls back deterministically when no weakest domain can be rated.
//
// Run against a running web server:  node scripts/smoke-blank-mock.mjs   (BASE=http://... to override)
const BASE = process.env.BASE ?? 'http://localhost:3000';
let failures = 0;
const ok = (cond, label) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`);
  if (!cond) failures++;
};
const j = async (path, init) => {
  const res = await fetch(BASE + path, init);
  return { status: res.status, body: await res.json() };
};
const post = (path) => j(path, { method: 'POST' });

// start a fresh mock; if one is in progress, submit it first (idempotent cleanup)
let r = await post('/api/mock-exams');
if (r.status === 409 && r.body.error?.code === 'MOCK_EXAM_IN_PROGRESS') {
  await post(`/api/mock-exams/${r.body.error.details.mockExamId}/submit`);
  r = await post('/api/mock-exams');
}
ok(r.status === 201, 'start mock 201');
const { mockExamId, attemptId } = r.body;

// submit immediately — 100% blank
r = await post(`/api/mock-exams/${mockExamId}/submit`);
ok(r.status === 200 && r.body.status === 'submitted', 'blank submit: 200 submitted');

// results: all 60 unanswered score incorrect, per-domain rollup covers every domain
r = await j(`/api/attempts/${attemptId}/results`);
ok(r.status === 200 && r.body.score.correct === 0 && r.body.score.total === 60, 'results: 0/60');
ok(r.body.missed.count === 60, 'results: 60 missed (unanswered count as incorrect)');
ok(
  r.body.domains.length === 4 && r.body.domains.every((d) => d.percent === 0 && d.total > 0),
  'results: 4-domain rollup, all 0% with full totals',
);

// dashboard must survive (was 500) with deterministic readiness + nudge
r = await j('/api/dashboard');
ok(r.status === 200, 'dashboard after blank mock: 200 (regression)');
ok(
  r.body.domains.every((d) => d.readinessPercent !== null),
  'dashboard: unanswered mock questions rated into domain readiness',
);
ok(typeof r.body.coachNudge?.text === 'string' && r.body.coachNudge.mode === 'deterministic',
  'dashboard: deterministic coach nudge present');
ok(r.body.recommendedDrill && (r.body.recommendedDrill.domainId !== undefined),
  'dashboard: recommended drill present (weakest or warm-up fallback)');

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
