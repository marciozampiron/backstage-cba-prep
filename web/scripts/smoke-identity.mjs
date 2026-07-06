// Regression smoke (#43, slice 4b): learner identity boundary — per-learner state isolation,
// ownership enforcement (403 NOT_RESOURCE_OWNER), deterministic dev default, cookie path.
// Run against a running web server:  node scripts/smoke-identity.mjs  (BASE=http://... to override)
const BASE = process.env.BASE ?? 'http://localhost:3000';
let failures = 0;
const ok = (cond, label) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`);
  if (!cond) failures++;
};
const as = (learner) => ({
  j: async (path, init = {}) => {
    const headers = { ...(init.headers ?? {}), ...(learner ? { 'x-cba-learner': learner } : {}) };
    const res = await fetch(BASE + path, { ...init, headers });
    return { status: res.status, body: await res.json() };
  },
  post(path, body) {
    return this.j(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  },
});

const alice = as('smoke-alice');
const bob = as('smoke-bob');
const anon = as(null); // deterministic dev-learner default

// Alice completes a 5-question drill
let r = await alice.post('/api/practice-sessions', { questionCount: 5 });
ok(r.status === 201, 'alice: drill started');
const sessionId = r.body.practiceSessionId;
const attemptId = r.body.attemptId;
for (let i = 0; i < 5; i++) {
  const nxt = await alice.j(`/api/practice-sessions/${sessionId}/next`);
  await alice.post(`/api/practice-sessions/${sessionId}/answers`, {
    index: nxt.body.index,
    questionVersionId: nxt.body.question.questionVersionId,
    selectedOption: 'A',
  });
}
r = await alice.j(`/api/attempts/${attemptId}/results`);
ok(r.status === 200, 'alice: owns her results');

// Bob cannot touch Alice's records — 403 NOT_RESOURCE_OWNER everywhere
r = await bob.j(`/api/practice-sessions/${sessionId}/next`);
ok(r.status === 403 && r.body.error?.code === 'NOT_RESOURCE_OWNER', "bob: alice's session -> 403");
r = await bob.j(`/api/attempts/${attemptId}/results`);
ok(r.status === 403 && r.body.error?.code === 'NOT_RESOURCE_OWNER', "bob: alice's results -> 403");
r = await bob.j(`/api/attempts/${attemptId}/missed`);
ok(r.status === 403 && r.body.error?.code === 'NOT_RESOURCE_OWNER', "bob: alice's missed -> 403");

// Dashboards are isolated
r = await alice.j('/api/dashboard');
ok(r.body.firstRun === false && r.body.recentAttempts.some((a) => a.attemptId === attemptId),
  "alice: dashboard shows her attempt");
r = await bob.j('/api/dashboard');
ok(r.body.firstRun === true && r.body.recentAttempts.length === 0, 'bob: dashboard is first-run (isolated)');

// Coach never leaks another learner's answer history
r = await bob.post('/api/coach/message', {
  action: 'explain_question',
  context: { attemptId, questionVersionId: (await alice.j(`/api/attempts/${attemptId}/missed?limit=1`)).body.items[0]?.questionVersionId ?? 'qv_cat-001_v1' },
});
ok(r.status === 200 && !r.body.text.startsWith('You picked'), "bob: coach doesn't reveal alice's answer");

// Mock ownership
r = await alice.post('/api/mock-exams');
ok(r.status === 201, 'alice: mock started');
const mockId = r.body.mockExamId;
r = await bob.j(`/api/mock-exams/${mockId}`);
ok(r.status === 403 && r.body.error?.code === 'NOT_RESOURCE_OWNER', "bob: alice's mock -> 403");
r = await bob.post('/api/mock-exams');
ok(r.status === 201, 'bob: starts his own mock despite alice having one in progress');
await alice.post(`/api/mock-exams/${mockId}/submit`);
await bob.post(`/api/mock-exams/${r.body.mockExamId}/submit`);

// Deterministic dev default: bare requests (no header/cookie) share one dev learner
r = await anon.post('/api/practice-sessions', { questionCount: 5 });
ok(r.status === 201, 'anon: drill starts under deterministic dev-learner');
const anonSession = r.body.practiceSessionId;
r = await anon.j(`/api/practice-sessions/${anonSession}/next`);
ok(r.status === 200 && r.body.done === false, 'anon: same dev-learner across bare requests');

// Cookie path resolves the same identity as the header
const viaCookie = await fetch(`${BASE}/api/dashboard`, { headers: { cookie: 'cba_learner=smoke-alice' } });
const cookieBody = await viaCookie.json();
ok(cookieBody.recentAttempts.some((a) => a.attemptId === attemptId), 'cookie: cba_learner resolves to the same learner as the header');

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
