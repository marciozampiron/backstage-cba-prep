// Simulation application layer: practice sessions, mock exams, missed review, deterministic coach.
// All state lives behind the SimulationRepository port (lib/repository.js) — records are plain
// JSON-serializable objects (answers keyed by question index), scoped by learnerId, written through
// on every mutation. Routes call these functions; neither routes nor pages touch the repository.
import {
  exam,
  domains,
  getDomain,
  getCompetency,
  getVersion,
  pickPublishedVersions,
  seededShuffle,
  toQuestionPayload,
} from './bank.js';
import { getRepository } from './repository.js';

const repo = getRepository();

export class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function answeredEntries(attempt) {
  return Object.values(attempt.answers);
}

// Ownership rule (contracts): a record that exists but belongs to another learner is 403, not 404.
function requireOwnership(record, learnerId) {
  if (record.learnerId !== learnerId) {
    throw new ApiError(403, 'NOT_RESOURCE_OWNER', 'This resource belongs to another learner.');
  }
}

/* ---------------- practice drills (slice 1, contracts §8–§10) ---------------- */

export function startDrill(learnerId, { domainId, competencyId, questionCount, difficulty, onlyMissed }) {
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

  // onlyMissed: every slot of a SUBMITTED attempt the learner did not get right — wrong answers
  // and unanswered mock questions alike (unanswered has no answers entry but scored incorrect).
  let missedSet = null;
  if (onlyMissed) {
    missedSet = new Set();
    for (const attempt of repo.listAttempts(learnerId)) {
      if (attempt.status !== 'submitted') continue;
      for (const slot of attempt.questionOrder) {
        const answer = attempt.answers[slot.index];
        if (answer?.isCorrect !== true) missedSet.add(slot.questionVersionId);
      }
    }
  }

  const sessionId = repo.nextId('ps');
  let pool = pickPublishedVersions({ domainId, competencyId, difficulty, seed: sessionId });
  if (missedSet) pool = pool.filter((v) => missedSet.has(v.questionVersionId));

  if (pool.length < questionCount) {
    throw new ApiError(400, 'INSUFFICIENT_QUESTIONS', 'Not enough questions match this filter.', {
      available: pool.length,
    });
  }

  const attemptId = repo.nextId('att');
  const questionOrder = pool
    .slice(0, questionCount)
    .map((v, i) => ({ index: i + 1, questionVersionId: v.questionVersionId }));

  const attempt = {
    attemptId,
    learnerId,
    examId: exam.examId,
    kind: 'practice',
    status: 'in_progress',
    config: {
      domainId: domainId ?? null,
      competencyId: competencyId ?? null,
      questionCount,
      difficulty: difficulty ?? 'mixed',
      onlyMissed: Boolean(onlyMissed),
    },
    questionOrder,
    startedAt: new Date().toISOString(),
    submittedAt: null,
    answers: {}, // index -> { questionVersionId, selectedOption, isCorrect, answeredAt, timeSpentSeconds }
  };
  const session = { practiceSessionId: sessionId, attemptId, learnerId };

  repo.saveAttempt(attempt);
  repo.saveSession(session);

  return {
    practiceSessionId: sessionId,
    attemptId,
    kind: 'practice',
    config: attempt.config,
    questionCount,
    startedAt: attempt.startedAt,
  };
}

function requireSession(sessionId, learnerId) {
  const session = repo.getSession(sessionId);
  if (!session) throw new ApiError(404, 'NOT_FOUND', 'Practice session not found.');
  requireOwnership(session, learnerId);
  const attempt = repo.getAttempt(session.attemptId);
  return { session, attempt };
}

export function nextQuestion(sessionId, learnerId) {
  const { attempt } = requireSession(sessionId, learnerId);
  const pending = attempt.questionOrder.find((q) => !attempt.answers[q.index]);
  if (!pending) {
    if (finalizeAttempt(attempt)) repo.saveAttempt(attempt);
    return {
      done: true,
      attemptId: attempt.attemptId,
      resultsUrl: `/api/attempts/${attempt.attemptId}/results`,
    };
  }
  return {
    done: false,
    index: pending.index,
    total: attempt.questionOrder.length,
    question: toQuestionPayload(getVersion(pending.questionVersionId)),
  };
}

export function answerQuestion(sessionId, learnerId, { index, questionVersionId, selectedOption, timeSpentSeconds }) {
  const { attempt } = requireSession(sessionId, learnerId);
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

  const existing = attempt.answers[index];
  if (existing && existing.selectedOption !== selectedOption) {
    throw new ApiError(409, 'ALREADY_ANSWERED', 'This question was already answered with a different selection.');
  }
  if (!existing) {
    attempt.answers[index] = {
      questionVersionId: version.questionVersionId,
      selectedOption,
      isCorrect: selectedOption === version.correctOption,
      answeredAt: new Date().toISOString(),
      timeSpentSeconds: timeSpentSeconds ?? null,
    };
  }
  const answer = attempt.answers[index];
  const answered = Object.keys(attempt.answers).length;
  const total = attempt.questionOrder.length;
  if (answered === total) finalizeAttempt(attempt);
  repo.saveAttempt(attempt);

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
  if (attempt.status !== 'in_progress') return false;
  attempt.status = 'submitted';
  attempt.submittedAt = new Date().toISOString();
  const correct = answeredEntries(attempt).filter((a) => a.isCorrect).length;
  attempt.score = {
    correct,
    total: attempt.questionOrder.length,
    percent: Math.round((correct / attempt.questionOrder.length) * 100),
  };
  return true;
}

export function attemptResults(attemptId, learnerId) {
  const attempt = repo.getAttempt(attemptId);
  if (!attempt) throw new ApiError(404, 'NOT_FOUND', 'Attempt not found.');
  requireOwnership(attempt, learnerId);
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
    if (attempt.answers[slot.index]?.isCorrect) row.correct += 1;
  }
  for (const row of perDomain.values()) {
    row.percent = Math.round((row.correct / row.total) * 100);
  }

  // total - correct counts unanswered mock questions as missed (they score incorrect at submit)
  const missedCount = attempt.score.total - attempt.score.correct;
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
      ...(weakest ? [{ type: 'start_drill', domainId: weakest.domainId, questionCount: 10 }] : []),
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

/* ---------------- mock exam (slice 2, contracts §2 / §11–§13) ---------------- */

function remainingSeconds(attempt) {
  return Math.max(0, Math.floor((new Date(attempt.expiresAt) - Date.now()) / 1000));
}

// Exam-mode invariant: answers are stored WITHOUT correctness until submit.
function finalizeMock(mock, attempt, { autoSubmitted }) {
  if (attempt.status !== 'in_progress') return false;
  for (const slot of attempt.questionOrder) {
    const entry = attempt.answers[slot.index];
    if (entry) {
      entry.isCorrect =
        entry.selectedOption !== null &&
        entry.selectedOption === getVersion(slot.questionVersionId).correctOption;
    }
  }
  attempt.status = 'submitted';
  attempt.submittedAt = autoSubmitted ? attempt.expiresAt : new Date().toISOString();
  mock.autoSubmitted = autoSubmitted;
  const correct = answeredEntries(attempt).filter((a) => a.isCorrect).length;
  attempt.score = {
    correct,
    total: attempt.questionOrder.length,
    percent: Math.round((correct / attempt.questionOrder.length) * 100),
  };
  return true;
}

function ensureMockCurrent(mock, attempt) {
  if (attempt.status === 'in_progress' && remainingSeconds(attempt) === 0) {
    if (finalizeMock(mock, attempt, { autoSubmitted: true })) {
      repo.saveAttempt(attempt);
      repo.saveMock(mock);
    }
  }
}

export function startMockExam(learnerId) {
  for (const mock of repo.listMocks(learnerId)) {
    const attempt = repo.getAttempt(mock.attemptId);
    ensureMockCurrent(mock, attempt);
    if (attempt.status === 'in_progress') {
      throw new ApiError(409, 'MOCK_EXAM_IN_PROGRESS', 'A mock exam is already in progress — resume it instead.', {
        mockExamId: mock.mockExamId,
      });
    }
  }

  const mockExamId = repo.nextId('mock');
  // Blueprint-weighted assembly: each domain contributes its mock target, then interleave.
  const picked = [];
  for (const d of domains) {
    const pool = pickPublishedVersions({ domainId: d.domainId, seed: `${mockExamId}:${d.domainId}` });
    if (pool.length < d.mockTarget) {
      throw new Error(
        `mock assembly: domain "${d.domainId}" has ${pool.length} published questions, needs ${d.mockTarget}`,
      );
    }
    picked.push(...pool.slice(0, d.mockTarget));
  }
  const questionOrder = seededShuffle(picked, mockExamId).map((v, i) => ({
    index: i + 1,
    questionVersionId: v.questionVersionId,
  }));

  const attemptId = repo.nextId('att');
  const startedAt = new Date();
  const attempt = {
    attemptId,
    learnerId,
    examId: exam.examId,
    kind: 'mock',
    status: 'in_progress',
    config: { questionCount: exam.questionCount, timeLimitSeconds: exam.timeLimitSeconds },
    questionOrder,
    startedAt: startedAt.toISOString(),
    expiresAt: new Date(startedAt.getTime() + exam.timeLimitSeconds * 1000).toISOString(),
    submittedAt: null,
    answers: {}, // index -> { questionVersionId, selectedOption|null, flagged, answeredAt } — isCorrect only at submit
  };
  const mock = { mockExamId, attemptId, learnerId, autoSubmitted: false };
  repo.saveAttempt(attempt);
  repo.saveMock(mock);

  return {
    mockExamId,
    attemptId,
    examId: exam.examId,
    questionCount: exam.questionCount,
    timeLimitSeconds: exam.timeLimitSeconds,
    startedAt: attempt.startedAt,
    expiresAt: attempt.expiresAt,
    // refs only — no stems, no answers (contract §2)
    questions: questionOrder.map((slot) => ({
      index: slot.index,
      questionId: getVersion(slot.questionVersionId).questionId,
      domainId: getVersion(slot.questionVersionId).domainId,
    })),
  };
}

function requireMock(mockExamId, learnerId) {
  const mock = repo.getMock(mockExamId);
  if (!mock) throw new ApiError(404, 'NOT_FOUND', 'Mock exam not found.');
  requireOwnership(mock, learnerId);
  const attempt = repo.getAttempt(mock.attemptId);
  ensureMockCurrent(mock, attempt);
  return { mock, attempt };
}

function mockCounts(attempt) {
  const entries = answeredEntries(attempt);
  return {
    answeredCount: entries.filter((a) => a.selectedOption !== null).length,
    flaggedCount: entries.filter((a) => a.flagged).length,
  };
}

// §11 — navigator + one question view. NEVER carries correctness/explanations/sources.
export function getMockExam(mockExamId, learnerId, requestedIndex) {
  const { mock, attempt } = requireMock(mockExamId, learnerId);
  const total = attempt.questionOrder.length;

  const navigator = attempt.questionOrder.map((slot) => {
    const entry = attempt.answers[slot.index];
    return {
      index: slot.index,
      answered: Boolean(entry && entry.selectedOption !== null),
      flagged: Boolean(entry?.flagged),
    };
  });

  let index = Number(requestedIndex);
  if (!Number.isInteger(index) || index < 1 || index > total) {
    index = navigator.find((n) => !n.answered)?.index ?? 1;
  }
  const slot = attempt.questionOrder.find((q) => q.index === index);
  const version = getVersion(slot.questionVersionId);
  const entry = attempt.answers[index];

  const status =
    attempt.status === 'in_progress' ? 'in_progress' : mock.autoSubmitted ? 'expired' : 'submitted';

  return {
    mockExamId,
    attemptId: attempt.attemptId,
    status,
    remainingSeconds: attempt.status === 'in_progress' ? remainingSeconds(attempt) : 0,
    expiresAt: attempt.expiresAt,
    navigator,
    question: {
      index,
      questionVersionId: version.questionVersionId,
      stem: version.stem,
      options: version.options,
      selectedOption: entry?.selectedOption ?? null,
      flagged: Boolean(entry?.flagged),
    },
    ...(attempt.status !== 'in_progress'
      ? { resultsUrl: `/api/attempts/${attempt.attemptId}/results` }
      : {}),
  };
}

// §12 — silent save/replace/clear + flag. No feedback of any kind.
export function saveMockAnswer(mockExamId, learnerId, { index, questionVersionId, selectedOption, flagged }) {
  const { attempt } = requireMock(mockExamId, learnerId);
  if (attempt.status !== 'in_progress') {
    throw new ApiError(409, 'ATTEMPT_NOT_IN_PROGRESS', 'This mock exam was already submitted or expired.');
  }
  const slot = attempt.questionOrder.find((q) => q.index === index);
  if (!slot) throw new ApiError(400, 'VALIDATION_FAILED', `No question at index ${index}.`);
  if (questionVersionId !== slot.questionVersionId) {
    throw new ApiError(409, 'VERSION_MISMATCH', 'Submitted questionVersionId does not match the pinned version.', {
      expected: slot.questionVersionId,
    });
  }
  const version = getVersion(slot.questionVersionId);
  if (
    selectedOption !== undefined &&
    selectedOption !== null &&
    !version.options.some((o) => o.key === selectedOption)
  ) {
    throw new ApiError(400, 'VALIDATION_FAILED', `Invalid option "${selectedOption}".`);
  }

  const existing = attempt.answers[index] ?? {
    questionVersionId: slot.questionVersionId,
    selectedOption: null,
    flagged: false,
    answeredAt: null,
  };
  if (selectedOption !== undefined) {
    existing.selectedOption = selectedOption; // null clears; answers replaceable until submit
    existing.answeredAt = selectedOption === null ? null : new Date().toISOString();
  }
  if (flagged !== undefined) existing.flagged = Boolean(flagged);
  attempt.answers[index] = existing;
  repo.saveAttempt(attempt);

  return { saved: true, ...mockCounts(attempt), remainingSeconds: remainingSeconds(attempt) };
}

// §13 — idempotent submit; expiry auto-submits with unanswered scoring incorrect.
export function submitMockExam(mockExamId, learnerId) {
  const { mock, attempt } = requireMock(mockExamId, learnerId);
  if (attempt.status === 'in_progress') {
    if (finalizeMock(mock, attempt, { autoSubmitted: false })) {
      repo.saveAttempt(attempt);
      repo.saveMock(mock);
    }
  }
  return {
    attemptId: attempt.attemptId,
    status: 'submitted',
    submittedAt: attempt.submittedAt,
    autoSubmitted: mock.autoSubmitted,
    resultsUrl: `/api/attempts/${attempt.attemptId}/results`,
  };
}

/* ---------------- missed review + deterministic coach (slice 3, §14 / §4) ---------------- */

// §14 — grounded review of missed items. Post-submit only: correctness/explanations exist here
// precisely because the attempt is completed, so the exam-mode rule stays intact.
export function missedForAttempt(attemptId, learnerId, { cursor, limit } = {}) {
  const attempt = repo.getAttempt(attemptId);
  if (!attempt) throw new ApiError(404, 'NOT_FOUND', 'Attempt not found.');
  requireOwnership(attempt, learnerId);
  if (attempt.status === 'in_progress') {
    throw new ApiError(409, 'ATTEMPT_NOT_COMPLETED', 'Missed review is available after the attempt is submitted.', {
      attemptId,
    });
  }

  const missed = [];
  for (const slot of attempt.questionOrder) {
    const entry = attempt.answers[slot.index];
    if (entry?.isCorrect) continue; // unanswered mock questions count as missed
    const version = getVersion(slot.questionVersionId);
    const domain = getDomain(version.domainId);
    const competency = getCompetency(version.domainId, version.competencyId);
    missed.push({
      index: slot.index,
      questionVersionId: version.questionVersionId,
      stem: version.stem,
      options: version.options,
      selectedOption: entry?.selectedOption ?? null,
      correctOption: version.correctOption,
      explanation: version.explanation,
      whyOthersWrong: version.whyOthersWrong,
      difficulty: version.difficulty,
      sourceRefs: version.sourceRefs,
      domain: { domainId: domain.domainId, name: domain.name },
      competency: { competencyId: competency.competencyId, name: competency.name },
    });
  }

  const pageSize = Math.min(Math.max(Number(limit) || 20, 1), 60);
  const start = Math.max(Number(cursor) || 0, 0);
  const items = missed.slice(start, start + pageSize);
  const next = start + pageSize < missed.length ? String(start + pageSize) : null;
  return { attemptId, kind: attempt.kind, totalMissed: missed.length, items, nextCursor: next };
}

function versionForCoach(context) {
  if (context?.questionVersionId) {
    const v = getVersion(context.questionVersionId);
    if (!v) throw new ApiError(404, 'NOT_FOUND', 'Unknown question version.');
    return v;
  }
  if (context?.questionId) {
    // contract §4 accepts questionId — resolve to the published version
    const v = pickPublishedVersions({ seed: 'coach' }).find((x) => x.questionId === context.questionId);
    if (!v) throw new ApiError(404, 'NOT_FOUND', 'Unknown question.');
    return v;
  }
  throw new ApiError(400, 'VALIDATION_FAILED', 'explain_question requires context.questionId or context.questionVersionId.');
}

function learnerAnswerFor(learnerId, context, version) {
  if (!context?.attemptId) return null;
  const attempt = repo.getAttempt(context.attemptId);
  // Only ever reveal the caller's own answer history to the coach.
  if (!attempt || attempt.learnerId !== learnerId || attempt.status === 'in_progress') return null;
  for (const slot of attempt.questionOrder) {
    if (slot.questionVersionId === version.questionVersionId) {
      return attempt.answers[slot.index] ?? null;
    }
  }
  return null;
}

function weakestRatedDomain(learnerId) {
  const { perDomain } = learnerAttemptStats(learnerId);
  let weakest = null;
  for (const d of domains) {
    const stat = perDomain.get(d.domainId);
    if (!stat || stat.answered === 0) continue;
    const pct = stat.correct / stat.answered;
    if (!weakest || pct < weakest.pct) weakest = { domain: d, pct };
  }
  return weakest;
}

// §4 — deterministic mode only. Text is composed from published item/blueprint data and always
// carries sourceRefs + a recommended action. No model call anywhere on this path (Phase 3 seam:
// the grounded mode swaps in behind the same shape via `mode`).
export function coachMessage(learnerId, { action, context }) {
  if (action === 'explain_question') {
    const version = versionForCoach(context);
    const domain = getDomain(version.domainId);
    const competency = getCompetency(version.domainId, version.competencyId);
    const answer = learnerAnswerFor(learnerId, context, version);
    const picked =
      answer && answer.selectedOption && answer.selectedOption !== version.correctOption
        ? `You picked ${answer.selectedOption}) — the correct answer is ${version.correctOption}). `
        : answer && answer.selectedOption === version.correctOption
          ? `You answered ${version.correctOption}) correctly. `
          : `The correct answer is ${version.correctOption}). `;
    return {
      messageId: repo.nextId('cm'),
      text: `${picked}${version.explanation}`,
      sourceRefs: version.sourceRefs,
      relatedCompetency: { domainId: domain.domainId, competencyId: competency.competencyId },
      recommendedAction: {
        type: 'start_drill',
        domainId: domain.domainId,
        competencyId: competency.competencyId,
        questionCount: 10,
      },
      mode: 'deterministic',
    };
  }

  if (action === 'recommend_next') {
    const weakest = weakestRatedDomain(learnerId);
    if (!weakest) {
      return {
        messageId: repo.nextId('cm'),
        text: 'Take a 5-question warm-up first — it gives you a readiness signal I can turn into a targeted recommendation.',
        sourceRefs: [],
        relatedCompetency: null,
        recommendedAction: { type: 'start_drill', questionCount: 5 },
        mode: 'deterministic',
      };
    }
    const { domain, pct } = weakest;
    return {
      messageId: repo.nextId('cm'),
      text: `${domain.name} is your weakest area right now (${Math.round(pct * 100)}% of scored questions correct, exam weight ${domain.weightPercent}%). A focused 10-question drill there yields the highest score improvement.`,
      sourceRefs: pickPublishedVersions({ domainId: domain.domainId, seed: 'coach' })
        .slice(0, 2)
        .flatMap((v) => v.sourceRefs),
      relatedCompetency: null,
      recommendedAction: { type: 'start_drill', domainId: domain.domainId, questionCount: 10 },
      mode: 'deterministic',
    };
  }

  if (action === 'explain_domain') {
    const domain = context?.domainId ? getDomain(context.domainId) : null;
    if (!domain) {
      throw new ApiError(
        context?.domainId ? 404 : 400,
        context?.domainId ? 'NOT_FOUND' : 'VALIDATION_FAILED',
        context?.domainId ? 'Unknown domain.' : 'explain_domain requires context.domainId.',
      );
    }
    const competencies = domain.competencies.map((c) => c.name).join('; ');
    return {
      messageId: repo.nextId('cm'),
      text: `${domain.name} is ${domain.weightPercent}% of the CBA exam. It covers: ${competencies}. Drill it in focused sets and read the cited docs for anything you miss.`,
      sourceRefs: pickPublishedVersions({ domainId: domain.domainId, seed: 'coach' })
        .slice(0, 2)
        .flatMap((v) => v.sourceRefs),
      relatedCompetency: null,
      recommendedAction: { type: 'start_drill', domainId: domain.domainId, questionCount: 10 },
      mode: 'deterministic',
    };
  }

  throw new ApiError(400, 'VALIDATION_FAILED', `Unknown coach action "${action}".`);
}

/* ---------------- dashboard/readiness inputs ---------------- */

// Dashboard resume support (§1 resume shape). Sweeps expiry lazily.
export function currentMockResume(learnerId) {
  for (const mock of repo.listMocks(learnerId)) {
    const attempt = repo.getAttempt(mock.attemptId);
    ensureMockCurrent(mock, attempt);
    if (attempt.status === 'in_progress') {
      return {
        sessionId: mock.mockExamId,
        kind: 'mock',
        answered: mockCounts(attempt).answeredCount,
        total: attempt.questionOrder.length,
      };
    }
  }
  return null;
}

export function learnerAttemptStats(learnerId) {
  const attempts = repo
    .listAttempts(learnerId)
    .filter((a) => a.status === 'submitted')
    .sort((a, b) => (a.submittedAt < b.submittedAt ? 1 : -1));

  const perDomain = new Map();
  for (const attempt of attempts) {
    for (const slot of attempt.questionOrder) {
      const version = getVersion(slot.questionVersionId);
      const answer = attempt.answers[slot.index];
      const row = perDomain.get(version.domainId) ?? { answered: 0, correct: 0 };
      // Submitted attempts scored every slot: an unanswered mock question counted as incorrect
      // at submit, so it counts against domain readiness here too.
      row.answered += 1;
      if (answer?.isCorrect) row.correct += 1;
      perDomain.set(version.domainId, row);
    }
  }
  return { attempts, perDomain };
}
