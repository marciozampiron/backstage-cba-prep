'use client';
// Review Missed Questions — parity with review_desktop/review_mobile: filter row, missed cards
// (difficulty badge, domain chip, source row, Review expand + Practice again), right rail with
// Weak Domains + Recommended Drill. Data: §14 missed items + §3 results (for the rail).
import { useEffect, useMemo, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Shell from '../../components/Shell.js';
import CoachPanel from '../../components/CoachPanel.js';
import { TargetIcon } from '../../components/icons.js';

function pctClass(p) {
  if (p >= 75) return 'good';
  if (p >= 55) return 'warn';
  return 'bad';
}

export default function ReviewAttemptPage() {
  const { attemptId } = useParams();
  const router = useRouter();
  const [missed, setMissed] = useState(null); // §14 payload (all pages folded)
  const [results, setResults] = useState(null); // §3 for the rail
  const [error, setError] = useState(null);
  const [domainFilter, setDomainFilter] = useState('');
  const [difficultyFilter, setDifficultyFilter] = useState('');
  const [openIndex, setOpenIndex] = useState(null);

  useEffect(() => {
    (async () => {
      const items = [];
      let cursor = null;
      let first = null;
      do {
        const res = await fetch(
          `/api/attempts/${attemptId}/missed?limit=60${cursor ? `&cursor=${cursor}` : ''}`,
        );
        const body = await res.json();
        if (!res.ok) throw new Error(body.error?.message ?? 'Could not load missed questions.');
        first ??= body;
        items.push(...body.items);
        cursor = body.nextCursor;
      } while (cursor);
      setMissed({ ...first, items });
      const r = await (await fetch(`/api/attempts/${attemptId}/results`)).json();
      setResults(r);
    })().catch((e) => setError(e.message));
  }, [attemptId]);

  const domains = useMemo(
    () => [...new Map((missed?.items ?? []).map((i) => [i.domain.domainId, i.domain])).values()],
    [missed],
  );
  const visible = (missed?.items ?? []).filter(
    (i) =>
      (!domainFilter || i.domain.domainId === domainFilter) &&
      (!difficultyFilter || i.difficulty === difficultyFilter),
  );

  const weakDomains = (results?.domains ?? [])
    .filter((d) => d.percent < 75)
    .sort((a, b) => a.percent - b.percent)
    .slice(0, 3);
  const weakest = weakDomains[0] ?? null;

  const practiceAgain = (domainId) => {
    const params = new URLSearchParams({ onlyMissed: '1', questionCount: '5' });
    if (domainId) params.set('domainId', domainId);
    router.push(`/practice/setup?${params.toString()}`);
  };

  if (error)
    return (
      <Shell>
        <p className="error-box">{error}</p>
      </Shell>
    );
  if (!missed)
    return (
      <Shell>
        <p className="muted">Loading missed questions…</p>
      </Shell>
    );

  return (
    <Shell>
      <h1>Review Missed Questions</h1>
      <p className="sub">Focus on the concepts that cost you points.</p>

      {missed.totalMissed === 0 ? (
        <div className="card">
          <div className="card-body">
            <strong>Perfect run 🎉</strong>
            <p className="muted" style={{ margin: '4px 0 12px' }}>
              Nothing to review from this attempt. Try a harder drill or a full mock next.
            </p>
            <div className="actions" style={{ marginTop: 0 }}>
              <a className="btn" href="/mock">
                Take a mock exam
              </a>
              <a className="btn btn-secondary" href="/practice/setup">
                New drill
              </a>
            </div>
          </div>
        </div>
      ) : (
        <div className="review-grid">
          <div>
            <div className="card">
              <div className="card-body filter-row">
                <div>
                  <span className="label-caps" style={{ marginTop: 0 }}>
                    Domain
                  </span>
                  <select value={domainFilter} onChange={(e) => setDomainFilter(e.target.value)}>
                    <option value="">All Domains</option>
                    {domains.map((d) => (
                      <option key={d.domainId} value={d.domainId}>
                        {d.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <span className="label-caps" style={{ marginTop: 0 }}>
                    Difficulty
                  </span>
                  <select
                    value={difficultyFilter}
                    onChange={(e) => setDifficultyFilter(e.target.value)}
                  >
                    <option value="">Mixed</option>
                    <option value="easy">easy</option>
                    <option value="medium">medium</option>
                    <option value="hard">hard</option>
                  </select>
                </div>
              </div>
            </div>

            {visible.length === 0 && (
              <p className="muted">No missed questions match this filter.</p>
            )}

            {visible.map((item) => {
              const open = openIndex === item.index;
              return (
                <div key={item.index} className="card review-item">
                  <div className="card-body">
                    <div className="head">
                      <span className="chip">{item.domain.name}</span>
                      <span className={`badge ${item.difficulty}`}>{item.difficulty}</span>
                      <span className="muted" style={{ marginLeft: 'auto', fontSize: 12 }}>
                        Q{item.index}
                        {item.selectedOption === null ? ' · unanswered' : ''}
                      </span>
                    </div>
                    <div className="title">{item.competency.name}</div>
                    {!open && (
                      <>
                        <div className="source-row">
                          Source: {item.sourceRefs[0]?.url.replace(/^https?:\/\//, '')}
                        </div>
                        <div className="actions" style={{ marginTop: 8 }}>
                          <button className="btn btn-secondary" onClick={() => setOpenIndex(item.index)}>
                            Review
                          </button>
                          <button className="btn" onClick={() => practiceAgain(item.domain.domainId)}>
                            Practice again
                          </button>
                        </div>
                      </>
                    )}
                    {open && (
                      <>
                        <p className="stem" style={{ fontSize: 16, margin: '10px 0 14px' }}>
                          {item.stem}
                        </p>
                        {item.options.map((o) => {
                          const isCorrect = o.key === item.correctOption;
                          const isYours = o.key === item.selectedOption;
                          const cls = isCorrect
                            ? 'option correct'
                            : isYours
                              ? 'option incorrect'
                              : 'option';
                          return (
                            <button key={o.key} type="button" className={cls} disabled>
                              <span>
                                <span className="key">{o.key})</span> {o.text}
                              </span>
                              {isCorrect && <span className="tag ok">Correct Answer</span>}
                              {isYours && !isCorrect && <span className="tag bad">Your Answer</span>}
                            </button>
                          );
                        })}
                        <p style={{ margin: '12px 0 4px' }}>{item.explanation}</p>
                        {item.whyOthersWrong && <p style={{ margin: '0 0 4px' }}>{item.whyOthersWrong}</p>}
                        {item.sourceRefs.map((s) => (
                          <a
                            key={s.url}
                            className="source-chip"
                            href={s.url}
                            target="_blank"
                            rel="noreferrer"
                          >
                            🔗 Source: {s.url.replace(/^https?:\/\//, '')}
                          </a>
                        ))}
                        <CoachPanel
                          context={{ attemptId, questionVersionId: item.questionVersionId }}
                          actions={['explain_question', 'recommend_next']}
                        />
                        <div className="actions">
                          <button className="btn btn-secondary" onClick={() => setOpenIndex(null)}>
                            Collapse
                          </button>
                          <button className="btn" onClick={() => practiceAgain(item.domain.domainId)}>
                            Practice again
                          </button>
                        </div>
                      </>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          <div>
            <div className="card">
              <div className="card-head">
                <h2>Weak Domains</h2>
              </div>
              <div className="card-body">
                {weakDomains.length === 0 && (
                  <p className="muted" style={{ margin: 0 }}>
                    No weak domains in this attempt.
                  </p>
                )}
                {weakDomains.map((d) => (
                  <div key={d.domainId} className="domain-row">
                    <div className="d-top">
                      <span className="d-name" style={{ fontSize: 14 }}>
                        {d.name}
                      </span>
                      <span className={`d-pct ${pctClass(d.percent)}`}>{d.percent}%</span>
                    </div>
                    <div className="bar">
                      <span className={pctClass(d.percent)} style={{ width: `${d.percent}%` }} />
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {weakest && (
              <div className="rail-drill">
                <strong>
                  <TargetIcon width={14} height={14} /> Recommended Drill
                </strong>
                <p>
                  Based on this attempt, focusing on <strong>{weakest.name}</strong> yields the
                  highest score improvement.
                </p>
                <button className="btn" onClick={() => practiceAgain(weakest.domainId)}>
                  Start {weakest.name.replace('Backstage ', '')} drill
                </button>
              </div>
            )}

            <div className="rail-note">
              ⓘ Review explanations cite backstage.io/docs sources to ensure accuracy against the
              official documentation.
            </div>
          </div>
        </div>
      )}
    </Shell>
  );
}
