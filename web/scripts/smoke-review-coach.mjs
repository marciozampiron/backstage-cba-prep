// Regression smoke (#41, slice 3): missed review (§14) + deterministic coach (§4).
// Run against a running web server:  node scripts/smoke-review-coach.mjs  (BASE=http://... to override)
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
const post = (path, body) =>
  j(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

// build a completed drill with guaranteed misses (always answer "A")
let r = await post('/api/practice-sessions', { questionCount: 5 });
ok(r.status === 201, 'start drill 201');
const sessionId = r.body.practiceSessionId;
const attemptId = r.body.attemptId;

// §14 must refuse while in progress
r = await j(`/api/attempts/${attemptId}/missed`);
ok(r.status === 409 && r.body.error?.code === 'ATTEMPT_NOT_COMPLETED', 'missed pre-submit: 409 ATTEMPT_NOT_COMPLETED');

let firstQuestion = null;
for (let i = 0; i < 5; i++) {
  const nxt = await j(`/api/practice-sessions/${sessionId}/next`);
  firstQuestion ??= nxt.body.question;
  await post(`/api/practice-sessions/${sessionId}/answers`, {
    index: nxt.body.index,
    questionVersionId: nxt.body.question.questionVersionId,
    selectedOption: 'A',
  });
}

// results reference count must match §14 totals
const results = (await j(`/api/attempts/${attemptId}/results`)).body;
r = await j(`/api/attempts/${attemptId}/missed?limit=2`);
ok(r.status === 200 && r.body.totalMissed === results.missed.count, `missed total matches results (${r.body.totalMissed})`);
if (r.body.totalMissed > 0) {
  const item = r.body.items[0];
  ok(
    typeof item.correctOption === 'string' &&
      item.explanation?.length > 0 &&
      item.sourceRefs?.[0]?.url.includes('backstage.io') &&
      item.domain?.domainId &&
      item.competency?.competencyId,
    'missed item fully grounded (correct answer, explanation, source, taxonomy)',
  );
  ok(r.body.items.length <= 2, 'pagination respects limit');
  if (r.body.nextCursor) {
    const page2 = await j(`/api/attempts/${attemptId}/missed?limit=2&cursor=${r.body.nextCursor}`);
    ok(page2.status === 200 && page2.body.items[0]?.index !== item.index, 'cursor pagination advances');
  }

  // §4 explain_question grounded in the learner's answer
  const c = await post('/api/coach/message', {
    action: 'explain_question',
    context: { attemptId, questionVersionId: item.questionVersionId },
  });
  ok(c.status === 200 && c.body.mode === 'deterministic', 'coach explain_question: 200 deterministic');
  ok(c.body.text.includes(item.correctOption + ')'), 'coach explain: names the correct answer');
  ok(c.body.sourceRefs?.[0]?.url.includes('backstage.io'), 'coach explain: source ref present');
  ok(c.body.recommendedAction?.type === 'start_drill', 'coach explain: recommended drill');
}

// §4 recommend_next + explain_domain
r = await post('/api/coach/message', { action: 'recommend_next', context: {} });
ok(r.status === 200 && r.body.mode === 'deterministic' && r.body.recommendedAction?.type === 'start_drill',
  'coach recommend_next: deterministic recommendation');
r = await post('/api/coach/message', { action: 'explain_domain', context: { domainId: 'catalog' } });
ok(r.status === 200 && r.body.text.includes('Backstage Catalog') && r.body.sourceRefs.length > 0,
  'coach explain_domain: grounded domain overview');

// §4 guards
r = await post('/api/coach/message', { action: 'summon_agent', context: {} });
ok(r.status === 400 && r.body.error?.code === 'VALIDATION_FAILED', 'coach unknown action: 400');
r = await post('/api/coach/message', { action: 'explain_question', context: {} });
ok(r.status === 400, 'coach explain without refs: 400');
r = await post('/api/coach/message', { action: 'explain_domain', context: { domainId: 'nope' } });
ok(r.status === 404, 'coach unknown domain: 404');

// leak hygiene: coach/missed never expose AI/infra vocabulary
const scan = JSON.stringify(r.body) + JSON.stringify(results);
ok(!/bedrock|strands|model|token/i.test(scan), 'no AI/infra vocabulary in payloads');

// regression (#41 blocker): blank mock -> missed -> onlyMissed drill must start (unanswered mock
// questions count as missed even though they have no answers entry)
let mock = await post('/api/mock-exams', {});
if (mock.status === 409 && mock.body.error?.code === 'MOCK_EXAM_IN_PROGRESS') {
  await post(`/api/mock-exams/${mock.body.error.details.mockExamId}/submit`);
  mock = await post('/api/mock-exams', {});
}
ok(mock.status === 201, 'blank-mock regression: start mock 201');
await post(`/api/mock-exams/${mock.body.mockExamId}/submit`);
r = await j(`/api/attempts/${mock.body.attemptId}/missed?limit=1`);
ok(r.status === 200 && r.body.totalMissed === 60, 'blank-mock regression: 60 missed');
const missedDomain = r.body.items[0].domain.domainId;
r = await post('/api/practice-sessions', { domainId: missedDomain, questionCount: 5, onlyMissed: true });
ok(r.status === 201, `blank-mock regression: onlyMissed drill starts (201) for domain ${missedDomain}`);
r = await post('/api/practice-sessions', { questionCount: 5, onlyMissed: true });
ok(r.status === 201, 'blank-mock regression: onlyMissed drill starts across all domains');

// pages render
for (const path of ['/review', `/review/${attemptId}`]) {
  const res = await fetch(BASE + path);
  ok(res.status === 200 && (await res.text()).includes('CBA'), `page ${path} renders 200`);
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
