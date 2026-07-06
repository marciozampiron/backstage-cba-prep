// In-memory Simulation adapter for slice 1 (#39): practice sessions, attempts, answers, results.
// One stub learner (no real auth yet); state lives for the process lifetime — the persistence
// slice replaces this behind the same shapes.
import {
  exam,
  getDomain,
  getCompetency,
  getVersion,
  pickPublishedVersions,
  toQuestionPayload,
} from './bank.js';

export const STUB_LEARNER_ID = 'learner-stub';

const globalKey = Symbol.for('cba.simulationStore');
if (!globalThis[globalKey]) {
  globalThis[globalKey] = { sessions: new Map(), attempts: new Map(), counter: 0 };
}
const store = globalThis[globalKey];

function nextId(prefix) {
  store.counter += 1;
  return `${prefix}_${store.counter.toString(36)}${Date.now().toString(36).slice(-4)}`;
}

export class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function startDrill({ domainId, competencyId, questionCount, difficulty, onlyMissed }) {
  if (![5, 10, 20].includes(questionCount)) {
    throw new ApiError(400, 'VALIDATION_FAILED', 'questionCount must be 5, 10, or 20.');
  }
  if (domainId && !getDomain(domainId)) {
    throw new ApiError(400, 'VALIDATION_FAILED', `Unknown domain "${domainId}".`);
  }
  if (competencyId) {
    if (!domainId) {
      throw new ApiError(400, 'VALIDATION_FAILED', 'competencyId requires domainId.');
    }
    if (!getCompetency(domainId, competencyId)) {
      throw new ApiError(400, 'VALIDATION_FAILED', `Unknown competency "${competencyId}".`);
    }
  }

  // onlyMissed: restrict to versions this learner answered incorrectly before.
  let missedSet = null;
  if (onlyMissed) {
    missedSet = new Set();
    for (const attempt of store.attempts.values()) {
      if (attempt.learnerId !== STUB_LEARNER_ID) continue;
      for (const a of attempt.answers.values()) {
        if (a.isCorrect === false) missedSet.add(a.questionVersionId);
      }
    }
  }

  const sessionId = nextId('ps');
  let pool = pickPublishedVersions({ domainId, competencyId, difficulty, seed: sessionId });
  if (missedSet) pool = pool.filter((v) => missedSet.has(v.questionVersionId));

  if (pool.length < questionCount) {
    throw new ApiError(400, 'INSUFFICIENT_QUESTIONS', 'Not enough questions match this filter.', {
      available: pool.length,
    });
  }

  const attemptId = nextId('att');
  const questionOrder = pool
    .slice(0, questionCount)
    .map((v, i) => ({ index: i + 1, questionVersionId: v.questionVersionId }));

  const attempt = {
    attemptId,
    learnerId: STUB_LEARNER_ID,
    examId: exam.examId,
    kind: 'practice',
    status: 'in_progress',
    config: { domainId: domainId ?? null, competencyId: competencyId ?? null, questionCount, difficulty: difficulty ?? 'mixed', onlyMissed: Boolean(onlyMissed) },
    questionOrder,
    startedAt: new Date().toISOString(),
    submittedAt: null,
    answers: new Map(), // index -> { questionVersionId, selectedOption, isCorrect, answeredAt, timeSpentSeconds }
  };
  const session = { practiceSessionId: sessionId, attemptId, learnerId: STUB_LEARNER_ID };

  store.attempts.set(attemptId, attempt);
  store.sessions.set(sessionId, session);

  return {
    practiceSessionId: sessionId,
    attemptId,
    kind: 'practice',
    config: attempt.config,
    questionCount,
    startedAt: attempt.startedAt,
  };
}

function requireSession(sessionId) {
  const session = store.sessions.get(sessionId);
  if (!session) throw new ApiError(404, 'NOT_FOUND', 'Practice session not found.');
  const attempt = store.attempts.get(session.attemptId);
  return { session, attempt };
}

export function nextQuestion(sessionId) {
  const { attempt } = requireSession(sessionId);
  const pending = attempt.questionOrder.find((q) => !attempt.answers.has(q.index));
  if (!pending) {
    finalizeAttempt(attempt);
    return { done: true, attemptId: attempt.attemptId, resultsUrl: `/api/attempts/${attempt.attemptId}/results` };
  }
  return {
    done: false,
    index: pending.index,
    total: attempt.questionOrder.length,
    question: toQuestionPayload(getVersion(pending.questionVersionId)),
  };
}

export function answerQuestion(sessionId, { index, questionVersionId, selectedOption, timeSpentSeconds }) {
  const { attempt } = requireSession(sessionId);
  const slot = attempt.questionOrder.find((q) => q.index === index);
  if (!slot) throw new ApiError(400, 'VALIDATION_FAILED', `No question at index ${index}.`);

  const version = getVersion(slot.questionVersionId);
  if (questionVersionId !== slot.questionVersionId) {
    throw new ApiError(409, 'VERSION_MISMATCH', 'Submitted questionVersionId does not match the pinned version.', {
      expected: slot.questionVersionId,
    });
  }
  if (!version.options.some((o) => o.key === selectedOption)) {
    throw new ApiError(400, 'VALIDATION_FAILED', `Invalid option "${selectedOption}".`);
  }

  const existing = attempt.answers.get(index);
  if (existing && existing.selectedOption !== selectedOption) {
    throw new ApiError(409, 'ALREADY_ANSWERED', 'This question was already answered with a different selection.');
  }
  if (!existing) {
    attempt.answers.set(index, {
      questionVersionId: version.questionVersionId,
      selectedOption,
      isCorrect: selectedOption === version.correctOption,
      answeredAt: new Date().toISOString(),
      timeSpentSeconds: timeSpentSeconds ?? null,
    });
  }
  const answer = attempt.answers.get(index);
  const answered = attempt.answers.size;
  const total = attempt.questionOrder.length;
  if (answered === total) finalizeAttempt(attempt);

  return {
    correct: answer.isCorrect,
    correctOption: version.correctOption,
    explanation: version.explanation,
    whyOthersWrong: version.whyOthersWrong,
    sourceRefs: version.sourceRefs,
    progress: { answered, total },
    nextIndex: answered < total ? index + 1 : null,
  };
}

function finalizeAttempt(attempt) {
  if (attempt.status !== 'in_progress') return;
  attempt.status = 'submitted';
  attempt.submittedAt = new Date().toISOString();
  const answers = [...attempt.answers.values()];
  const correct = answers.filter((a) => a.isCorrect).length;
  attempt.score = {
    correct,
    total: attempt.questionOrder.length,
    percent: Math.round((correct / attempt.questionOrder.length) * 100),
  };
}

export function attemptResults(attemptId) {
  const attempt = store.attempts.get(attemptId);
  if (!attempt) throw new ApiError(404, 'NOT_FOUND', 'Attempt not found.');
  if (attempt.status === 'in_progress') {
    throw new ApiError(409, 'ATTEMPT_NOT_COMPLETED', 'Results are available after the attempt is completed.', {
      attemptId,
    });
  }

  const perDomain = new Map();
  for (const slot of attempt.questionOrder) {
    const version = getVersion(slot.questionVersionId);
    const domain = getDomain(version.domainId);
    if (!perDomain.has(domain.domainId)) {
      perDomain.set(domain.domainId, {
        domainId: domain.domainId,
        name: domain.name,
        weightPercent: domain.weightPercent,
        correct: 0,
        total: 0,
        percent: 0,
      });
    }
    const row = perDomain.get(domain.domainId);
    row.total += 1;
    if (attempt.answers.get(slot.index)?.isCorrect) row.correct += 1;
  }
  for (const row of perDomain.values()) {
    row.percent = Math.round((row.correct / row.total) * 100);
  }

  const missedCount = [...attempt.answers.values()].filter((a) => !a.isCorrect).length;
  const weakest = [...perDomain.values()].sort((a, b) => a.percent - b.percent)[0] ?? null;

  return {
    attemptId,
    examId: attempt.examId,
    kind: attempt.kind,
    score: attempt.score,
    target: { percent: exam.targetPercent, official: false },
    domains: [...perDomain.values()],
    timeUsedSeconds: Math.max(
      0,
      Math.round((new Date(attempt.submittedAt) - new Date(attempt.startedAt)) / 1000),
    ),
    missed: { count: missedCount },
    nextActions: [
      ...(missedCount > 0 ? [{ type: 'review_missed', attemptId }] : []),
      ...(weakest
        ? [{ type: 'start_drill', domainId: weakest.domainId, questionCount: 10 }]
        : []),
    ],
    coachSummary: {
      text:
        missedCount === 0
          ? 'Perfect run. Try a longer drill or a harder filter next.'
          : `You missed ${missedCount} question${missedCount > 1 ? 's' : ''}. ${weakest.name} is the area to focus on next.`,
      sourceRefs: [],
      mode: 'deterministic',
    },
    completedAt: attempt.submittedAt,
  };
}

export function learnerAttemptStats() {
  const attempts = [...store.attempts.values()]
    .filter((a) => a.learnerId === STUB_LEARNER_ID && a.status === 'submitted')
    .sort((a, b) => (a.submittedAt < b.submittedAt ? 1 : -1));

  const perDomain = new Map();
  for (const attempt of attempts) {
    for (const slot of attempt.questionOrder) {
      const version = getVersion(slot.questionVersionId);
      const answer = attempt.answers.get(slot.index);
      if (!answer) continue;
      const row = perDomain.get(version.domainId) ?? { answered: 0, correct: 0 };
      row.answered += 1;
      if (answer.isCorrect) row.correct += 1;
      perDomain.set(version.domainId, row);
    }
  }
  return { attempts, perDomain };
}
