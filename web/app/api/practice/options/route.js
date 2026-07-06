// GET /api/practice/options — contract §7.
import { exam, domains } from '../../../../lib/bank.js';
import { learnerAttemptStats } from '../../../../lib/store.js';
import { resolveLearner } from '../../../../lib/identity.js';
import { handle, json } from '../../../../lib/api.js';

export const GET = handle((request) => {
  const { learnerId } = resolveLearner(request);
  const { attempts, perDomain } = learnerAttemptStats(learnerId);

  let recommended = { domainId: null, competencyId: null, questionCount: 5, reason: 'warm_up' };
  if (attempts.length > 0) {
    const rated = domains
      .map((d) => ({ d, stat: perDomain.get(d.domainId) }))
      .filter((x) => x.stat)
      .sort(
        (a, b) => a.stat.correct / a.stat.answered - b.stat.correct / b.stat.answered,
      );
    if (rated.length > 0) {
      recommended = {
        domainId: rated[0].d.domainId,
        competencyId: null,
        questionCount: 10,
        reason: 'weakest_domain',
      };
    }
  }

  return json({
    exam: { examId: exam.examId },
    domains: domains.map((d) => ({
      domainId: d.domainId,
      name: d.name,
      weightPercent: d.weightPercent,
      competencies: d.competencies.map((c) => ({ competencyId: c.competencyId, name: c.name })),
    })),
    questionCounts: [5, 10, 20],
    difficulties: ['mixed', 'easy', 'medium', 'hard'],
    toggles: { onlyMissed: true },
    recommended,
  });
});
