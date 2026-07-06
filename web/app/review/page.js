'use client';
// Review entry: pick a completed attempt to review. Composes existing contracts client-side
// (dashboard recent attempts + per-attempt results for missed counts).
import { useEffect, useState } from 'react';
import Shell from '../components/Shell.js';
import { ChevronIcon } from '../components/icons.js';

export default function ReviewIndexPage() {
  const [rows, setRows] = useState(null);

  useEffect(() => {
    (async () => {
      const dash = await (await fetch('/api/dashboard')).json();
      const attempts = dash.recentAttempts ?? [];
      const withMissed = await Promise.all(
        attempts.map(async (a) => {
          const res = await (await fetch(`/api/attempts/${a.attemptId}/results`)).json();
          return { ...a, missed: res.missed?.count ?? 0 };
        }),
      );
      setRows(withMissed);
    })().catch(() => setRows([]));
  }, []);

  return (
    <Shell>
      <h1>Review Missed Questions</h1>
      <p className="sub">Focus on the concepts that cost you points.</p>

      {!rows && <p className="muted">Loading your attempts…</p>}
      {rows && rows.length === 0 && (
        <div className="card">
          <div className="card-body">
            <strong>Nothing to review yet</strong>
            <p className="muted" style={{ margin: '4px 0 12px' }}>
              Complete a drill or a mock exam first — missed questions land here with full
              explanations and official sources.
            </p>
            <a className="btn" href="/practice/setup">
              Start a drill
            </a>
          </div>
        </div>
      )}
      {rows &&
        rows.map((a) => (
          <a key={a.attemptId} className="action-row" href={`/review/${a.attemptId}`}>
            <div>
              <div className="a-title">
                {a.kind === 'mock' ? 'Mock exam' : 'Drill'} · scored {a.scorePercent}%
              </div>
              <div className="a-sub">
                {a.missed > 0 ? `${a.missed} missed question${a.missed > 1 ? 's' : ''} to review` : 'Perfect run — nothing missed'}
                {' · '}
                {new Date(a.completedAt).toLocaleString()}
              </div>
            </div>
            <span className="chev">
              <ChevronIcon />
            </span>
          </a>
        ))}
    </Shell>
  );
}
