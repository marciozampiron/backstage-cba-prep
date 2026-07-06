'use client';
// Deterministic Study Coach panel (contract §4) — action-scoped, never a free-form chat. Renders
// the scoped action chips, the grounded answer with source chips, and the recommended drill.
import { useState } from 'react';
import { useRouter } from 'next/navigation';

export default function CoachPanel({ context, actions }) {
  const router = useRouter();
  const [answer, setAnswer] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const ask = async (action) => {
    setBusy(true);
    setError(null);
    const res = await fetch('/api/coach/message', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, context }),
    });
    const body = await res.json();
    setBusy(false);
    if (!res.ok) {
      setError(body.error?.message ?? 'The coach is unavailable right now.');
      return;
    }
    setAnswer(body);
  };

  const startRecommended = () => {
    const a = answer.recommendedAction;
    const params = new URLSearchParams();
    if (a.domainId) params.set('domainId', a.domainId);
    if (a.competencyId) params.set('competencyId', a.competencyId);
    params.set('questionCount', String(a.questionCount ?? 10));
    router.push(`/practice/setup?${params.toString()}`);
  };

  return (
    <div className="coach-panel">
      <strong>Study Coach</strong>
      <div className="chips">
        {(actions ?? ['explain_question', 'recommend_next']).map((action) => (
          <button key={action} onClick={() => ask(action)} disabled={busy}>
            {action === 'explain_question'
              ? 'Explain this'
              : action === 'recommend_next'
                ? 'What should I study next?'
                : 'Explain this domain'}
          </button>
        ))}
      </div>
      {error && <p className="error-box">{error}</p>}
      {busy && <p className="muted" style={{ margin: '10px 0 0' }}>Thinking it through…</p>}
      {answer && !busy && (
        <div className="coach-answer">
          <p style={{ margin: 0 }}>{answer.text}</p>
          {answer.sourceRefs.map((s) => (
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
          {answer.recommendedAction?.type === 'start_drill' && (
            <div className="actions" style={{ marginTop: 12 }}>
              <button className="btn" onClick={startRecommended}>
                Start recommended drill
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
