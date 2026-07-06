'use client';
// Mini-results after a drill (screen map #5, practice flavor): score, per-domain rows,
// concrete next actions — never a dead end.
import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';

export default function PracticeResultsPage() {
  const { attemptId } = useParams();
  const router = useRouter();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    fetch(`/api/attempts/${attemptId}/results`)
      .then(async (r) => {
        const body = await r.json();
        if (!r.ok) throw new Error(body.error?.message ?? 'Could not load results.');
        return body;
      })
      .then(setData)
      .catch((e) => setError(e.message));
  }, [attemptId]);

  if (error) return <p className="error-box">{error}</p>;
  if (!data) return <p className="muted">Scoring your drill…</p>;

  const drillWeakest = data.nextActions.find((a) => a.type === 'start_drill');

  return (
    <main>
      <h1>Drill complete</h1>
      <p className="sub">
        Target {data.target.percent}% — not an official pass score.
      </p>

      <div className="card">
        <div className="score-hero">
          <span className="big">{data.score.percent}%</span>
          <span className="muted">
            {data.score.correct} of {data.score.total} correct · {data.timeUsedSeconds}s
          </span>
        </div>
      </div>

      <div className="card">
        <h2>By domain</h2>
        {data.domains.map((d) => (
          <div key={d.domainId} className="domain-row" style={{ display: 'block' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span>{d.name}</span>
              <span className="weight">
                {d.correct}/{d.total} · {d.percent}%
              </span>
            </div>
            <div className="bar">
              <span style={{ width: `${d.percent}%` }} />
            </div>
          </div>
        ))}
      </div>

      <div className="card">
        <h2>Coach</h2>
        <p style={{ margin: 0 }}>{data.coachSummary.text}</p>
        <div className="actions">
          {drillWeakest && (
            <button
              className="btn"
              onClick={() =>
                router.push(
                  `/practice/setup?domainId=${drillWeakest.domainId}&questionCount=${drillWeakest.questionCount}`,
                )
              }
            >
              Drill weakest domain
            </button>
          )}
          <a className="btn btn-secondary" href="/">
            Back to dashboard
          </a>
        </div>
      </div>
    </main>
  );
}
