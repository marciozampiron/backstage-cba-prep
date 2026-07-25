// Deterministic deployed-contract suite (#78): parameterized by a TRANSPORT function so the same
// assertions run (a) in-process against the Lambda adapter in CI — never touching the network —
// and (b) against a deployed BFF via the HTTP runner (deployed-http.test.js, gated on the
// canonical BASE_URL from the #55 runbook) that #70 will point at the real endpoint.
//
// Exam-mode safety uses a RECURSIVE ALLOWLIST (additionalProperties:false semantics): every key
// of every pre-submit payload must be explicitly allowed, so a future field (correctAnswer,
// solution, grading, table names, …) fails the suite even though no blacklist names it.
import { test } from 'node:test';
import assert from 'node:assert/strict';

/* ---------------- recursive allowlist validator ---------------- */

// Spec grammar: { key: true } primitive leaf | { key: spec } nested object | { key: [spec] } array.
export function allowlistViolations(value, spec, pathPrefix = '$', out = []) {
  if (value === null || value === undefined) return out;
  if (Array.isArray(spec)) {
    if (!Array.isArray(value)) {
      out.push(`${pathPrefix}: expected array`);
      return out;
    }
    value.forEach((v, i) => allowlistViolations(v, spec[0], `${pathPrefix}[${i}]`, out));
    return out;
  }
  if (spec === true) {
    // A leaf admits ONLY primitives: an object smuggled under an allowed key (e.g.
    // stem: { correctOption: "A" }) is a leak, not an allowed value.
    if (typeof value === 'object') out.push(`${pathPrefix}: leaf must be a primitive`);
    return out;
  }
  if (typeof value !== 'object') {
    out.push(`${pathPrefix}: expected object`);
    return out;
  }
  for (const [key, v] of Object.entries(value)) {
    if (!(key in spec)) {
      out.push(`${pathPrefix}.${key}: key not in allowlist`);
      continue;
    }
    allowlistViolations(v, spec[key], `${pathPrefix}.${key}`, out);
  }
  return out;
}

/* ---------------- pre-submit payload allowlists (#36/#38 presentation fields ONLY) ---------- */

const OPTION_SPEC = { key: true, text: true };
const QUESTION_PRESENTATION = {
  questionVersionId: true,
  stem: true,
  options: [OPTION_SPEC],
  domain: { domainId: true, name: true },
  competency: { competencyId: true, name: true },
};

export const ALLOWLISTS = {
  drillStart: {
    practiceSessionId: true,
    attemptId: true,
    kind: true,
    config: {
      domainId: true,
      competencyId: true,
      questionCount: true,
      difficulty: true,
      onlyMissed: true,
    },
    questionCount: true,
    startedAt: true,
  },
  mockStart: {
    mockExamId: true,
    attemptId: true,
    examId: true,
    questionCount: true,
    timeLimitSeconds: true,
    startedAt: true,
    expiresAt: true,
    questions: [{ index: true, questionId: true, domainId: true }],
  },
  mockView: {
    mockExamId: true,
    attemptId: true,
    status: true,
    remainingSeconds: true,
    expiresAt: true,
    navigator: [{ index: true, answered: true, flagged: true }],
    question: {
      index: true,
      questionVersionId: true,
      stem: true,
      options: [OPTION_SPEC],
      selectedOption: true,
      flagged: true,
    },
    resultsUrl: true, // present only after submit; harmless in the allowlist
  },
  mockSave: { saved: true, answeredCount: true, flaggedCount: true, remainingSeconds: true },
  drillNext: {
    done: true,
    index: true,
    total: true,
    question: QUESTION_PRESENTATION,
    attemptId: true, // done:true form
    resultsUrl: true, // done:true form
  },
};

/* ---------------- readiness gate ---------------- */

// What a DEPLOYED target must report (pilot-release-runbook §3: BASE_URL points at the API
// Gateway BFF, which runs dynamodb in dev|pilot). ready:false or a local adapter must FAIL.
export const DEPLOYED_READINESS = { adapter: 'dynamodb', runtimeEnvs: ['dev', 'pilot'] };

export function assertReadiness(body, { adapter, runtimeEnvs }) {
  assert.deepEqual(Object.keys(body).sort(), ['adapter', 'ready', 'runtimeEnv']);
  assert.equal(body.ready, true, 'readiness gate: ready must be true');
  assert.equal(body.adapter, adapter, `readiness gate: adapter must be "${adapter}"`);
  assert.ok(
    runtimeEnvs.includes(body.runtimeEnv),
    `readiness gate: runtimeEnv "${body.runtimeEnv}" must be one of ${runtimeEnvs.join('|')}`,
  );
}

/* ---------------- the suite ---------------- */

/**
 * @param {string} name suite label
 * @param {(method:string, path:string, opts?:{learner?:string,body?:object,query?:object,cookieLearner?:string}) => Promise<{status:number,body:any,headers?:Record<string,string>}>} transport
 * @param {{ authenticated?: boolean, readiness?: {adapter: string, runtimeEnvs: string[]} }} opts
 *   authenticated=false limits the suite to the public/anonymous assertions (a deployed target
 *   before #69 has no dev identity). readiness defaults to the DEPLOYED expectations; the
 *   in-process transport overrides it with its local shape.
 */
export function runDeployedContractSuite(
  name,
  transport,
  { authenticated = true, readiness = DEPLOYED_READINESS } = {},
) {
  test(`${name}: readiness is public, logical-only and HEALTHY for this target`, async () => {
    const res = await transport('GET', '/api/readiness');
    assert.equal(res.status, 200);
    assertReadiness(res.body, readiness);
  });

  // NOTE: the unknown-route 404 envelope is deliberately NOT asserted here. With explicit routes
  // only (no $default), a deployed HTTP API answers unmatched paths itself — the Lambda never
  // runs — so that envelope is a property of the in-process transport (see lambda.test.js).

  if (!authenticated) return;

  test(`${name}: drill creation and pre-answer payloads pass the recursive allowlist`, async () => {
    const start = await transport('POST', '/api/practice-sessions', {
      learner: 'suiteDrill',
      body: { questionCount: 5 },
    });
    assert.equal(start.status, 201);
    assert.deepEqual(allowlistViolations(start.body, ALLOWLISTS.drillStart), []);
    const next = await transport('GET', `/api/practice-sessions/${start.body.practiceSessionId}/next`, {
      learner: 'suiteDrill',
    });
    assert.equal(next.status, 200);
    assert.deepEqual(allowlistViolations(next.body, ALLOWLISTS.drillNext), []);
  });

  test(`${name}: every pre-submit mock payload passes the recursive allowlist`, async () => {
    const learner = 'suiteMock';
    const start = await transport('POST', '/api/mock-exams', { learner, body: {} });
    assert.equal(start.status, 201);
    assert.deepEqual(allowlistViolations(start.body, ALLOWLISTS.mockStart), []);

    const view = await transport('GET', `/api/mock-exams/${start.body.mockExamId}`, { learner });
    assert.equal(view.status, 200);
    assert.deepEqual(allowlistViolations(view.body, ALLOWLISTS.mockView), []);

    const save = await transport('POST', `/api/mock-exams/${start.body.mockExamId}/answers`, {
      learner,
      body: {
        index: view.body.question.index,
        questionVersionId: view.body.question.questionVersionId,
        selectedOption: view.body.question.options[0].key,
      },
    });
    assert.equal(save.status, 200);
    assert.deepEqual(allowlistViolations(save.body, ALLOWLISTS.mockSave), []);

    // Positive control: after submit, correction fields exist — proving the allowlist would have
    // caught them pre-submit.
    const submit = await transport('POST', `/api/mock-exams/${start.body.mockExamId}/submit`, { learner });
    assert.equal(submit.status, 200);
    const missed = await transport('GET', `/api/attempts/${start.body.attemptId}/missed`, { learner });
    assert.equal(missed.status, 200);
    const leaked = allowlistViolations(missed.body.items[0], ALLOWLISTS.mockView.question);
    assert.ok(leaked.length > 0, 'post-submit review must violate the pre-submit allowlist');
  });

  test(`${name}: ownership stays 403 through this transport`, async () => {
    const start = await transport('POST', '/api/practice-sessions', {
      learner: 'suiteOwner',
      body: { questionCount: 5 },
    });
    assert.equal(start.status, 201);
    const res = await transport('GET', `/api/attempts/${start.body.attemptId}/results`, {
      learner: 'suiteIntruder',
    });
    assert.equal(res.status, 403);
    assert.equal(res.body.error.code, 'NOT_RESOURCE_OWNER');
  });
}
