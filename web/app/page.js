'use client';
// Learner Dashboard — first screen (screen map #1). Slice 1 focuses on the first-run state;
// after attempts exist it shows the naive readiness the stub computes.
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';

export default function DashboardPage() {
  const router = useRouter();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    fetch('/api/dashboard')
      .then((r) => r.json())
      .then(setData)
      .catch(() => setError('Could not load your dashboard.'));
  }, []);

  if (error) return <p className="error-box">{error}</p>;
  if (!data) return <p className="muted">Loading your study state…</p>;

  const startRecommended = () => {
    const params = new URLSearchParams();
    if (data.recommendedDrill.domainId) params.set('domainId', data.recommendedDrill.domainId);
    params.set('questionCount', String(data.recommendedDrill.questionCount));
    router.push(`/practice/setup?${params.toString()}`);
  };

  return (
    <main>
      <h1>{data.firstRun ? 'Welcome — let’s get you exam-ready' : 'Welcome back'}</h1>
      <p className="sub">
        {data.firstRun
          ? 'Take a quick warm-up drill to get your first readiness signal.'
          : `Overall readiness ${data.readiness.percent}% vs a ${data.readiness.targetPercent}% target (not an official pass score).`}
      </p>

      <div className="card">
        <h2>{data.firstRun ? 'What the CBA covers' : 'Readiness by domain'}</h2>
        {data.domains.map((d) => (
          <div key={d.domainId} className="domain-row" style={{ display: 'block' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span>{d.name}</span>
              <span className="weight">
                {d.weightPercent}%{d.readinessPercent !== null ? ` · ready ${d.readinessPercent}%` : ''}
              </span>
            </div>
            {d.readinessPercent !== null && (
              <div className="bar">
                <span style={{ width: `${d.readinessPercent}%` }} />
              </div>
            )}
          </div>
        ))}
      </div>

      <div className="card">
        <h2>Coach</h2>
        <p style={{ margin: 0 }}>{data.coachNudge.text}</p>
        <div className="actions">
          <button className="btn" onClick={startRecommended}>
            {data.firstRun ? 'Start 5-question warm-up' : 'Start recommended drill'}
          </button>
          <a className="btn btn-secondary" href="/practice/setup">
            Configure a drill
          </a>
        </div>
      </div>

      {data.recentAttempts.length > 0 && (
        <div className="card">
          <h2>Recent attempts</h2>
          {data.recentAttempts.map((a) => (
            <div key={a.attemptId} className="domain-row">
              <span>
                {a.kind === 'practice' ? 'Drill' : 'Mock'} · {a.scorePercent}%
              </span>
              <a href={`/practice/results/${a.attemptId}`}>View results</a>
            </div>
          ))}
        </div>
      )}
    </main>
  );
}
