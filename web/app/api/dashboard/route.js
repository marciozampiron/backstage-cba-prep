// GET /api/dashboard — contract §1 (web-bff-contracts.md). Slice 1: first-run aware; readiness is
// a naive deterministic rollup of in-memory attempts (ProgressSnapshot arrives with persistence).
import { exam, domains } from '../../../lib/bank.js';
import { learnerAttemptStats } from '../../../lib/store.js';
import { handle, json } from '../../../lib/api.js';

export const GET = handle(() => {
  const { attempts, perDomain } = learnerAttemptStats();
  const firstRun = attempts.length === 0;

  const domainRows = domains.map((d) => {
    const stat = perDomain.get(d.domainId);
    return {
      domainId: d.domainId,
      name: d.name,
      weightPercent: d.weightPercent,
      readinessPercent: stat ? Math.round((stat.correct / stat.answered) * 100) : null,
    };
  });

  const rated = domainRows.filter((d) => d.readinessPercent !== null);
  const overall =
    rated.length > 0
      ? Math.round(
          rated.reduce((sum, d) => sum + d.readinessPercent * d.weightPercent, 0) /
            rated.reduce((sum, d) => sum + d.weightPercent, 0),
        )
      : null;
  const weakest = rated.length > 0 ? [...rated].sort((a, b) => a.readinessPercent - b.readinessPercent)[0] : null;

  const recommendedDrill = firstRun
    ? { domainId: null, competencyId: null, questionCount: 5, reason: 'warm_up' }
    : { domainId: weakest?.domainId ?? null, competencyId: null, questionCount: 10, reason: 'weakest_domain' };

  return json({
    exam: { examId: exam.examId, name: exam.name },
    firstRun,
    readiness: { percent: overall, targetPercent: exam.targetPercent, official: false },
    domains: domainRows,
    weakestCompetency: null, // competency-level readiness arrives with ProgressSnapshot (later slice)
    resume: null, // sessions are short-lived in slice 1; resume lands with persistence
    recommendedDrill,
    recentAttempts: attempts.slice(0, 3).map((a) => ({
      attemptId: a.attemptId,
      kind: a.kind,
      scorePercent: a.score.percent,
      completedAt: a.submittedAt,
    })),
    coachNudge: {
      text: firstRun
        ? `The CBA covers ${domains.length} domains. Take a 5-question warm-up to get your first readiness signal.`
        : `${weakest.name} is your weakest area — a focused 10-question drill will help.`,
      action: recommendedDrill.domainId
        ? { type: 'start_drill', domainId: recommendedDrill.domainId, questionCount: 10 }
        : { type: 'start_drill', questionCount: 5 },
      sourceRefs: [],
      mode: 'deterministic',
    },
  });
});
