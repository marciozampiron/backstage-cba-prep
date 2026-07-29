// Simulation application layer (moved from web/lib in #76 — the single owner of scoring,
// ownership, mock finalization, and exam-mode rules): practice sessions, mock exams, missed
// review, deterministic coach.
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
import { RepositoryConflictError } from './repository.js';
import { parseInstant, toInstant } from './instant.js';
import { isValidSmokeRunId } from './smoke-run.js';
import { randomUUID } from 'node:crypto';
import { activeRepository, now, nowIso } from './runtime.js';

// Repository/clock come from the composition seam (runtime.js): tests inject fakes there.
const db = () => activeRepository();

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

export async function startDrill(learnerId, { domainId, competencyId, questionCount, difficulty, onlyMissed, runId = null }) {
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
    for (const attempt of await db().listAttempts(learnerId)) {
      if (attempt.status !== 'submitted') continue;
      for (const slot of attempt.questionOrder) {
        const answer = attempt.answers[slot.index];
        if (answer?.isCorrect !== true) missedSet.add(slot.questionVersionId);
      }
    }
  }

  const sessionId = await db().nextId('ps');
  let pool = pickPublishedVersions({ domainId, competencyId, difficulty, seed: sessionId });
  if (missedSet) pool = pool.filter((v) => missedSet.has(v.questionVersionId));

  if (pool.length < questionCount) {
    throw new ApiError(400, 'INSUFFICIENT_QUESTIONS', 'Not enough questions match this filter.', {
      available: pool.length,
    });
  }

  const attemptId = await db().nextId('att');
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
    startedAt: nowIso(),
    submittedAt: null,
    answers: {}, // index -> { questionVersionId, selectedOption, isCorrect, answeredAt, timeSpentSeconds }
    // #75: the smoke run that created this record, or null outside a run. It is stamped from a run
    // the caller was proven to OWN — never from the request body — so cleanup is scoped to learner
    // AND run without any input naming either.
    runId,
  };
  const session = { practiceSessionId: sessionId, attemptId, learnerId, runId };

  if (runId) {
    // Conditional on the run still being active: the dispatcher's check happened before this
    // handler ran, and on its own it leaves a window in which cleanup can complete underneath us.
    const ok = (await db().saveSmokeScopedRecord({ runId, kind: 'attempt', record: attempt }))
      && (await db().saveSmokeScopedRecord({ runId, kind: 'session', record: session }));
    if (!ok) throw new ApiError(409, 'RUN_CLOSED', 'This smoke run stopped accepting records.');
  } else {
    await db().saveAttempt(attempt);
    await db().saveSession(session);
  }

  return {
    practiceSessionId: sessionId,
    attemptId,
    kind: 'practice',
    config: attempt.config,
    questionCount,
    startedAt: attempt.startedAt,
  };
}

async function requireSession(sessionId, learnerId) {
  const session = await db().getSession(sessionId);
  if (!session) throw new ApiError(404, 'NOT_FOUND', 'Practice session not found.');
  requireOwnership(session, learnerId);
  const attempt = await db().getAttempt(session.attemptId);
  return { session, attempt };
}

export async function nextQuestion(sessionId, learnerId) {
  const { attempt } = await requireSession(sessionId, learnerId);
  const pending = attempt.questionOrder.find((q) => !attempt.answers[q.index]);
  if (!pending) {
    if (finalizeAttempt(attempt)) await db().saveAttempt(attempt);
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

export async function answerQuestion(sessionId, learnerId, { index, questionVersionId, selectedOption, timeSpentSeconds }) {
  const { attempt } = await requireSession(sessionId, learnerId);
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
      answeredAt: nowIso(),
      timeSpentSeconds: timeSpentSeconds ?? null,
    };
  }
  const answer = attempt.answers[index];
  const answered = Object.keys(attempt.answers).length;
  const total = attempt.questionOrder.length;
  if (answered === total) finalizeAttempt(attempt);
  await db().saveAttempt(attempt);

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
  attempt.submittedAt = nowIso();
  const correct = answeredEntries(attempt).filter((a) => a.isCorrect).length;
  attempt.score = {
    correct,
    total: attempt.questionOrder.length,
    percent: Math.round((correct / attempt.questionOrder.length) * 100),
  };
  return true;
}

export async function attemptResults(attemptId, learnerId) {
  const attempt = await db().getAttempt(attemptId);
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
  return Math.max(0, Math.floor((new Date(attempt.expiresAt) - now()) / 1000));
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
  attempt.submittedAt = autoSubmitted ? attempt.expiresAt : nowIso();
  mock.autoSubmitted = autoSubmitted;
  const correct = answeredEntries(attempt).filter((a) => a.isCorrect).length;
  attempt.score = {
    correct,
    total: attempt.questionOrder.length,
    percent: Math.round((correct / attempt.questionOrder.length) * 100),
  };
  return true;
}

async function ensureMockCurrent(mock, attempt) {
  if (attempt.status === 'in_progress' && remainingSeconds(attempt) === 0) {
    if (finalizeMock(mock, attempt, { autoSubmitted: true })) {
      await db().saveAttempt(attempt);
      await db().saveMock(mock);
      await db().releaseActiveMock(mock.learnerId, mock.mockExamId);
    }
  }
}

// Lazy sweep of the learner's active-mock claim: finalizes an expired mock (releasing the claim)
// and self-heals stale claims — missing records, AND claims left behind by a partial failure
// (e.g. the attempt was submitted but a later save/release crashed). Any claim whose attempt is
// not in_progress is released here, so a learner can never be locked out of starting a mock.
// Returns the still-active { mock, attempt } or null when the learner may start a new mock.
async function sweepActiveMock(learnerId) {
  const activeId = await db().getActiveMock(learnerId);
  if (!activeId) return null;
  const mock = await db().getMock(activeId);
  const attempt = mock ? await db().getAttempt(mock.attemptId) : null;
  if (!mock || !attempt) {
    await db().releaseActiveMock(learnerId, activeId);
    return null;
  }
  await ensureMockCurrent(mock, attempt);
  if (attempt.status !== 'in_progress') {
    // Finalized (now or earlier) but the claim survived a partial failure: release it.
    await db().releaseActiveMock(learnerId, activeId);
    return null;
  }
  return { mock, attempt };
}

export async function startMockExam(learnerId, { runId = null } = {}) {
  // One-active-mock is enforced by an ATOMIC per-learner claim on the repository port (#77) —
  // never list-then-create. The sweep first finalizes an expired claim so a learner can restart.
  const active = await sweepActiveMock(learnerId);
  if (active) {
    throw new ApiError(409, 'MOCK_EXAM_IN_PROGRESS', 'A mock exam is already in progress — resume it instead.', {
      mockExamId: active.mock.mockExamId,
    });
  }

  const mockExamId = await db().nextId('mock');
  let claimed;
  try {
    claimed = await db().claimActiveMock(learnerId, mockExamId, { runId });
  } catch (err) {
    // The run stopped accepting records between the dispatcher check and this write. That is a
    // closed run, not a lost race — reporting it as MOCK_EXAM_IN_PROGRESS would send the caller
    // looking for a mock that does not exist.
    if (err instanceof RepositoryConflictError) {
      throw new ApiError(409, 'RUN_CLOSED', 'This smoke run stopped accepting records.');
    }
    throw err;
  }
  if (!claimed) {
    // Lost a concurrent race: surface the winner's mock, exactly like the sequential case.
    const winnerId = await db().getActiveMock(learnerId);
    throw new ApiError(409, 'MOCK_EXAM_IN_PROGRESS', 'A mock exam is already in progress — resume it instead.', {
      mockExamId: winnerId,
    });
  }
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

  const attemptId = await db().nextId('att');
  const startedAt = new Date(now());
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
    runId, // #75 — see startDrill
  };
  const mock = { mockExamId, attemptId, learnerId, autoSubmitted: false, runId };
  if (runId) {
    const ok = (await db().saveSmokeScopedRecord({ runId, kind: 'attempt', record: attempt }))
      && (await db().saveSmokeScopedRecord({ runId, kind: 'mock', record: mock }));
    if (!ok) throw new ApiError(409, 'RUN_CLOSED', 'This smoke run stopped accepting records.');
  } else {
    await db().saveAttempt(attempt);
    await db().saveMock(mock);
  }

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

async function requireMock(mockExamId, learnerId) {
  const mock = await db().getMock(mockExamId);
  if (!mock) throw new ApiError(404, 'NOT_FOUND', 'Mock exam not found.');
  requireOwnership(mock, learnerId);
  const attempt = await db().getAttempt(mock.attemptId);
  await ensureMockCurrent(mock, attempt);
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
export async function getMockExam(mockExamId, learnerId, requestedIndex) {
  const { mock, attempt } = await requireMock(mockExamId, learnerId);
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
export async function saveMockAnswer(mockExamId, learnerId, { index, questionVersionId, selectedOption, flagged }) {
  const { attempt } = await requireMock(mockExamId, learnerId);
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
    existing.answeredAt = selectedOption === null ? null : nowIso();
  }
  if (flagged !== undefined) existing.flagged = Boolean(flagged);
  attempt.answers[index] = existing;
  await db().saveAttempt(attempt);

  return { saved: true, ...mockCounts(attempt), remainingSeconds: remainingSeconds(attempt) };
}

// §13 — idempotent submit; expiry auto-submits with unanswered scoring incorrect.
export async function submitMockExam(mockExamId, learnerId) {
  const { mock, attempt } = await requireMock(mockExamId, learnerId);
  if (attempt.status === 'in_progress') {
    if (finalizeMock(mock, attempt, { autoSubmitted: false })) {
      await db().saveAttempt(attempt);
      await db().saveMock(mock);
      await db().releaseActiveMock(mock.learnerId, mock.mockExamId);
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
export async function missedForAttempt(attemptId, learnerId, { cursor, limit } = {}) {
  const attempt = await db().getAttempt(attemptId);
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

async function learnerAnswerFor(learnerId, context, version) {
  if (!context?.attemptId) return null;
  const attempt = await db().getAttempt(context.attemptId);
  // Only ever reveal the caller's own answer history to the coach.
  if (!attempt || attempt.learnerId !== learnerId || attempt.status === 'in_progress') return null;
  for (const slot of attempt.questionOrder) {
    if (slot.questionVersionId === version.questionVersionId) {
      return attempt.answers[slot.index] ?? null;
    }
  }
  return null;
}

async function weakestRatedDomain(learnerId) {
  const { perDomain } = await learnerAttemptStats(learnerId);
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
export async function coachMessage(learnerId, { action, context }) {
  if (action === 'explain_question') {
    const version = versionForCoach(context);
    const domain = getDomain(version.domainId);
    const competency = getCompetency(version.domainId, version.competencyId);
    const answer = await learnerAnswerFor(learnerId, context, version);
    const picked =
      answer && answer.selectedOption && answer.selectedOption !== version.correctOption
        ? `You picked ${answer.selectedOption}) — the correct answer is ${version.correctOption}). `
        : answer && answer.selectedOption === version.correctOption
          ? `You answered ${version.correctOption}) correctly. `
          : `The correct answer is ${version.correctOption}). `;
    return {
      messageId: await db().nextId('cm'),
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
    const weakest = await weakestRatedDomain(learnerId);
    if (!weakest) {
      return {
        messageId: await db().nextId('cm'),
        text: 'Take a 5-question warm-up first — it gives you a readiness signal I can turn into a targeted recommendation.',
        sourceRefs: [],
        relatedCompetency: null,
        recommendedAction: { type: 'start_drill', questionCount: 5 },
        mode: 'deterministic',
      };
    }
    const { domain, pct } = weakest;
    return {
      messageId: await db().nextId('cm'),
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
      messageId: await db().nextId('cm'),
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
export async function currentMockResume(learnerId) {
  const active = await sweepActiveMock(learnerId);
  if (!active) return null;
  return {
    sessionId: active.mock.mockExamId,
    kind: 'mock',
    answered: mockCounts(active.attempt).answeredCount,
    total: active.attempt.questionOrder.length,
  };
}

export async function learnerAttemptStats(learnerId) {
  const attempts = (await db().listAttempts(learnerId))
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


/**
 * Mint a smoke run for the authenticated learner (#75).
 *
 * The run is a RECORD, not a token claim: a Cognito access token cannot carry a per-run value
 * without infrastructure this issue may not introduce, and a design whose identity can never be
 * issued is not a design. Ownership is what the record establishes, so a later reference to this
 * run id proves nothing on its own.
 */
export async function startSmokeRun(learnerId) {
  if (typeof learnerId !== 'string' || learnerId === '') {
    throw new ApiError(401, 'UNAUTHENTICATED', 'A smoke run requires an authenticated learner.');
  }
  // Random, not sequential: a guessable run id would let one caller reference another's run, and
  // the ownership check would then be the only thing standing between them.
  const runId = `run-${randomUUID().replace(/-/g, '').slice(0, 24)}`;
  // Abandoned runs need a bound too: a run that is never cleaned up would otherwise keep learner
  // ownership forever. It gets the same retention from creation, and completion re-anchors it.
  const startedMs = now();
  const run = {
    runId,
    learnerId,
    status: 'active',
    startedAt: new Date(startedMs).toISOString(),
    writeDeadlineAt: new Date(startedMs + SMOKE_WRITE_WINDOW_MS).toISOString(),
    ownershipExpiresAt: new Date(startedMs + SMOKE_OWNERSHIP_MS).toISOString(),
  };
  await db().saveSmokeRun(run);
  // R6 mint order: run, then lease, then stamp — and only then success. A failure past this point
  // leaves an orphan run that is bounded by its own ttl and whose id is never returned, so the
  // failure direction is always a run that cannot be used, never data that cannot expire.
  await bindProfileToSmokeRun(learnerId, runId);
  return run;
}

/**
 * Bind the learner's profile retention to a smoke run (#75 R6).
 *
 * Runs in the trusted server context at mint — the repository never accepts smoke classification
 * from request data or from a profile record. The horizon is read from the STORED run, never
 * supplied: an absent, ownership-expired or mismatched run is refused outright.
 *
 * The lease is written whether or not a profile exists yet, which is what covers a learner who
 * mints before their first /api/me: bootstrap consumes the lease at creation, so there is no window
 * in which an unbounded smoke profile can exist. An existing profile is stamped monotonically.
 */
export async function bindProfileToSmokeRun(learnerId, runId) {
  const run = await db().getSmokeRun(runId);
  if (!run || run.learnerId !== learnerId || runOwnershipExpired(run)) {
    throw new ApiError(403, 'FORBIDDEN', 'This smoke run does not belong to the caller.');
  }
  const horizon = run.ownershipExpiresAt;
  await db().extendSmokeLease({ learnerId, retainUntil: horizon });
  await db().stampProfileRetention({ learnerId, retainUntil: horizon });
  return { runId, retainUntil: horizon };
}

/**
 * Resolve a referenced run id to a run this learner owns, or `null`.
 *
 * `null` for unknown AND for someone else's run, deliberately: distinguishing them would tell a
 * caller which run ids exist.
 */
export async function ownedSmokeRun(learnerId, runId) {
  if (!isValidSmokeRunId(runId) || typeof learnerId !== 'string' || learnerId === '') return null;
  const run = await db().getSmokeRun(runId);
  if (!run || run.learnerId !== learnerId) return null;
  // TTL is eventually consistent, so the application decides. Scoped to OWNERSHIP: a run past its
  // write deadline is still cleanable, and that is the point.
  if (runOwnershipExpired(run)) return null;
  return run;
}

/** How many times cleanup retries a contended delete before reporting the run incomplete. */
const CLEANUP_ATTEMPTS = 3;

/**
 * How long a completed run tombstone is retained (#75, SEC-DATA-01).
 *
 * The tombstone keeps ownership alive so a replay stays deterministic, and ownership is learner
 * data — it cannot be kept forever. Seven days comfortably outlives any #70 retry window while
 * still being bounded, and DynamoDB TTL enforces it in the managed adapter.
 *
 * TTL is a CLEANUP mechanism, never an authorization one: `runIsClosed` refuses a completed run
 * immediately, so nothing depends on when the row actually disappears.
 */
export const SMOKE_RUN_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * The three clocks of the approved retention model (design revision 6).
 *
 * They answer three DIFFERENT questions, which is why one field could not serve them: collapsing
 * write eligibility into cleanup authority made cleanup unreachable exactly when it was needed.
 * Ownership deliberately outlives child retention by a day, so there is always a window in which
 * the children still exist and the run that owns them can still be named.
 */
export const SMOKE_WRITE_WINDOW_MS = 24 * 60 * 60 * 1000;      // may new records join this run?
export const SMOKE_OWNERSHIP_MS = 8 * 24 * 60 * 60 * 1000;     // may this run still be cleaned up?
export const SMOKE_CHILD_RETENTION_MS = SMOKE_RUN_RETENTION_MS; // how long a child record lives

/**
 * May this run still accept new records?
 *
 * Closed OR past the write deadline. A malformed deadline fails closed: a run whose bound cannot be
 * read is not a run with no bound.
 */
export function runIsClosed(run, atMs = now()) {
  if (!run) return true;
  if (run.status !== 'active') return true;
  const deadline = parseInstant(run.writeDeadlineAt);
  return deadline === null || atMs >= deadline;
}

/**
 * May this run still be cleaned up?
 *
 * Ownership, NOT the write deadline. Cleanup against a write-expired run is the manual-recovery
 * path after a cancelled workflow, and refusing it would strand the data it was meant to remove.
 */
export function runOwnershipExpired(run, atMs = now()) {
  const horizon = parseInstant(run?.ownershipExpiresAt);
  return horizon === null || atMs >= horizon;
}

/**
 * Delete every record a smoke RUN created for the authenticated smoke LEARNER (#75).
 *
 * Provider-neutral: it validates the scope, retries, verifies, and delegates the physical deletion
 * to the repository port.
 *
 * COMPLETENESS IS VERIFIED, NOT INFERRED. The adapter deletes conditionally on the revision it
 * read, so a record written between the read and the delete is skipped. Counting deletions cannot
 * distinguish "nothing existed" from "something survived contention" — both report zero — and a
 * partial cleanup that answers 200 would let a run be promoted with records left behind. So after a
 * bounded retry the scope is queried again, and anything still matching makes this a failure with
 * the leftovers named by class.
 */
export async function cleanupSmokeRun(learnerId, runId) {
  if (typeof learnerId !== 'string' || learnerId === '') {
    throw new ApiError(401, 'UNAUTHENTICATED', 'Cleanup requires an authenticated learner.');
  }
  if (!isValidSmokeRunId(runId)) {
    throw new ApiError(400, 'VALIDATION_FAILED', 'A smoke run id is required.');
  }

  // CLOSE FIRST. Every smoke-scoped write is conditional on the run being active, so moving it out
  // of `active` before deleting anything is what stops a write that already passed the dispatcher
  // check from committing after this call reports success.
  await db().closeSmokeRun(runId);

  const deleted = { practiceSessions: 0, mockExams: 0, attempts: 0, answers: 0, projections: 0 };
  let remaining = null;
  for (let attempt = 0; attempt < CLEANUP_ATTEMPTS; attempt++) {
    const round = await db().deleteSmokeRunData({ learnerId, runId });
    for (const key of Object.keys(deleted)) deleted[key] += round[key] ?? 0;
    remaining = await db().countSmokeRunRecords({ learnerId, runId });
    if (remaining.practiceSessions + remaining.mockExams + remaining.attempts === 0) {
      // Finalized ONLY here — after the scope has been re-queried and proven empty. Marking the run
      // complete inside the delete marked it finished while a projection was still pending and
      // before anything was verified, so a failure in between produced a run that looked done.
      // The tombstone anchor is FRESH from completion, not inherited from either active clock —
      // a run completed on day six gets seven more days, not the one it had left.
      // ONE clock read for both. Two reads let a moving clock make the retention window differ
      // from exactly seven days after the recorded completion — small, but it means the anchor and
      // the horizon describe different instants.
      const completedMs = now();
      await db().completeSmokeRun({
        runId,
        completedAt: toInstant(completedMs),
        expiresAt: toInstant(completedMs + SMOKE_RUN_RETENTION_MS),
      });
      // The run id is echoed because #70 correlates the summary with the run it just executed; the
      // learner id is NOT, because the response is written into a workflow log.
      return { runId, deleted, completedAt: toInstant(completedMs) };
    }
  }

  // Observable, and it blocks: the design (§6) makes a failed cleanup a failed run even when every
  // gate passed. Leftovers are reported per CLASS — never ids — so the summary says what survived
  // without naming a learner's records.
  throw new ApiError(409, 'CLEANUP_INCOMPLETE', 'Cleanup could not remove every record for this run.', {
    runId,
    deleted,
    remaining,
  });
}
