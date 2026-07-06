'use client';
// Question Session — drill mode (screen map #3): one question at a time, submit, immediate
// grounded feedback (explanation + official source chip), next.
import { useCallback, useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';

export default function PracticeSessionPage() {
  const { sessionId } = useParams();
  const router = useRouter();
  const [current, setCurrent] = useState(null); // { index, total, question }
  const [selected, setSelected] = useState(null);
  const [feedback, setFeedback] = useState(null); // §10 response
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [startedAt, setStartedAt] = useState(Date.now());

  const loadNext = useCallback(async () => {
    setError(null);
    const res = await fetch(`/api/practice-sessions/${sessionId}/next`);
    const body = await res.json();
    if (!res.ok) {
      setError(body.error?.message ?? 'Could not load the next question.');
      return;
    }
    if (body.done) {
      router.push(`/practice/results/${body.attemptId}`);
      return;
    }
    setCurrent(body);
    setSelected(null);
    setFeedback(null);
    setStartedAt(Date.now());
  }, [sessionId, router]);

  useEffect(() => {
    loadNext();
  }, [loadNext]);

  if (error) return <p className="error-box">{error}</p>;
  if (!current) return <p className="muted">Loading question…</p>;

  const submit = async () => {
    if (!selected || busy) return;
    setBusy(true);
    const res = await fetch(`/api/practice-sessions/${sessionId}/answers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        index: current.index,
        questionVersionId: current.question.questionVersionId,
        selectedOption: selected,
        timeSpentSeconds: Math.round((Date.now() - startedAt) / 1000),
      }),
    });
    const body = await res.json();
    setBusy(false);
    if (!res.ok) {
      setError(body.error?.message ?? 'Could not submit the answer.');
      return;
    }
    setFeedback(body);
  };

  const optionClass = (key) => {
    if (!feedback) return 'option';
    if (key === feedback.correctOption) return 'option correct';
    if (key === selected && !feedback.correct) return 'option incorrect';
    return 'option';
  };

  return (
    <main>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <span className="progress-tag">
          Question {current.index} of {current.total}
        </span>
        <span className="muted">
          {current.question.domain.name} · {current.question.competency.name}
        </span>
      </div>

      <p className="stem">{current.question.stem}</p>

      <div role="group" aria-label="Answer options">
        {current.question.options.map((o) => (
          <button
            key={o.key}
            type="button"
            className={optionClass(o.key)}
            aria-pressed={selected === o.key}
            disabled={Boolean(feedback)}
            onClick={() => setSelected(o.key)}
          >
            <span className="key">{o.key}</span>
            <span>{o.text}</span>
          </button>
        ))}
      </div>

      {!feedback && (
        <div className="actions">
          <button className="btn" onClick={submit} disabled={!selected || busy}>
            {busy ? 'Checking…' : 'Submit answer'}
          </button>
        </div>
      )}

      {feedback && (
        <div className="feedback">
          <p className={`verdict ${feedback.correct ? 'ok' : 'bad'}`} style={{ marginTop: 0 }}>
            {feedback.correct ? 'Correct.' : `Not quite — the answer is ${feedback.correctOption}.`}
          </p>
          <p style={{ marginBottom: 0 }}>{feedback.explanation}</p>
          {feedback.sourceRefs.map((s) => (
            <a key={s.url} className="source-chip" href={s.url} target="_blank" rel="noreferrer">
              Source: {s.url.replace(/^https?:\/\//, '')}
            </a>
          ))}
          <div className="actions">
            <button className="btn" onClick={loadNext}>
              {feedback.nextIndex ? 'Next question' : 'See results'}
            </button>
          </div>
        </div>
      )}
    </main>
  );
}
