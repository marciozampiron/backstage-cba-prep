'use client';
// Mock Exam — parity with mock_exam_desktop: left navigator panel (legend + 60-cell grid), question
// area with Mark-for-Review and Previous/Next, countdown timer chip, Submit Exam with confirmation.
// Exam-mode rule: the §11/§12 payloads carry no correctness; feedback exists only after submit.
import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';

function fmt(seconds) {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export default function MockExamPage() {
  const { mockExamId } = useParams();
  const router = useRouter();
  const [data, setData] = useState(null); // §11 payload
  const [error, setError] = useState(null);
  const [confirming, setConfirming] = useState(false);
  const [navOpen, setNavOpen] = useState(false);
  const [now, setNow] = useState(Date.now());
  const deadline = useRef(null);
  const submitting = useRef(false);

  const apply = useCallback((body) => {
    deadline.current = Date.now() + body.remainingSeconds * 1000;
    setData(body);
  }, []);

  const load = useCallback(
    async (index) => {
      setError(null);
      const res = await fetch(
        `/api/mock-exams/${mockExamId}${index ? `?index=${index}` : ''}`,
      );
      const body = await res.json();
      if (!res.ok) {
        setError(body.error?.message ?? 'Could not load the mock exam.');
        return;
      }
      if (body.status !== 'in_progress') {
        router.replace(`/results/${body.attemptId}`);
        return;
      }
      apply(body);
    },
    [mockExamId, router, apply],
  );

  useEffect(() => {
    load();
  }, [load]);

  // countdown tick + auto-submit at zero
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const remaining = deadline.current ? Math.max(0, Math.floor((deadline.current - now) / 1000)) : null;

  const submit = useCallback(async () => {
    if (submitting.current) return;
    submitting.current = true;
    const res = await fetch(`/api/mock-exams/${mockExamId}/submit`, { method: 'POST' });
    const body = await res.json();
    if (res.ok) {
      router.replace(`/results/${body.attemptId}`);
    } else {
      submitting.current = false;
      setError(body.error?.message ?? 'Could not submit the exam.');
    }
  }, [mockExamId, router]);

  useEffect(() => {
    if (remaining === 0 && data) submit();
  }, [remaining, data, submit]);

  if (error) return <p className="error-box" style={{ margin: 20 }}>{error}</p>;
  if (!data) return <p className="muted" style={{ margin: 20 }}>Loading mock exam…</p>;

  const { navigator: nav, question } = data;
  const total = nav.length;
  const answered = nav.filter((n) => n.answered).length;
  const flagged = nav.filter((n) => n.flagged).length;

  const save = async (patch) => {
    const res = await fetch(`/api/mock-exams/${mockExamId}/answers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        index: question.index,
        questionVersionId: question.questionVersionId,
        ...patch,
      }),
    });
    const body = await res.json();
    if (!res.ok) {
      setError(body.error?.message ?? 'Could not save.');
      return;
    }
    deadline.current = Date.now() + body.remainingSeconds * 1000;
    setData((d) => ({
      ...d,
      navigator: d.navigator.map((n) =>
        n.index === question.index
          ? {
              ...n,
              answered:
                patch.selectedOption !== undefined ? patch.selectedOption !== null : n.answered,
              flagged: patch.flagged !== undefined ? patch.flagged : n.flagged,
            }
          : n,
      ),
      question: {
        ...d.question,
        selectedOption:
          patch.selectedOption !== undefined ? patch.selectedOption : d.question.selectedOption,
        flagged: patch.flagged !== undefined ? patch.flagged : d.question.flagged,
      },
    }));
  };

  return (
    <div>
      <header className="mock-top">
        <span className="focus-brand">CBA Mock Exam</span>
        <button className="btn btn-secondary mock-toggle-nav" onClick={() => setNavOpen((v) => !v)}>
          Questions
        </button>
        <span className={`timer-chip ${remaining !== null && remaining < 300 ? 'low' : ''}`}>
          ⏱ {remaining !== null ? fmt(remaining) : '--:--'}
        </span>
        <button className="btn" onClick={() => setConfirming(true)}>
          Submit Exam
        </button>
      </header>

      <div className="mock-body">
        <aside className={`mock-nav ${navOpen ? 'open' : ''}`}>
          <h2>Question Overview</h2>
          <div className="legend">
            <span className="row">
              <span className="swatch answered" /> Answered <span className="n">{answered}</span>
            </span>
            <span className="row">
              <span className="swatch" /> Unanswered <span className="n">{total - answered}</span>
            </span>
            <span className="row">
              <span className="swatch flagged" /> Flagged <span className="n">{flagged}</span>
            </span>
          </div>
          <div className="nav-grid">
            {nav.map((n) => (
              <button
                key={n.index}
                className={`cell ${n.answered ? 'answered' : ''} ${n.flagged ? 'flagged' : ''} ${
                  n.index === question.index ? 'current' : ''
                }`}
                onClick={() => {
                  setNavOpen(false);
                  load(n.index);
                }}
                aria-label={`Question ${n.index}${n.answered ? ', answered' : ''}${n.flagged ? ', flagged' : ''}`}
              >
                {n.index}
              </button>
            ))}
          </div>
        </aside>

        <main className="mock-main">
          <div className="q-meta">
            <span className="label-caps" style={{ margin: 0 }}>
              Question {question.index} of {total}
            </span>
            <button className={`flag-btn ${question.flagged ? 'on' : ''}`} onClick={() => save({ flagged: !question.flagged })}>
              ⚑ {question.flagged ? 'Flagged for review' : 'Mark for Review'}
            </button>
          </div>

          <p className="stem">{question.stem}</p>

          <div role="group" aria-label="Answer options">
            {question.options.map((o) => (
              <button
                key={o.key}
                type="button"
                className="option"
                aria-pressed={question.selectedOption === o.key}
                onClick={() =>
                  save({ selectedOption: question.selectedOption === o.key ? null : o.key })
                }
              >
                <span className="radio" />
                <span>
                  <span className="key">{o.key})</span> {o.text}
                </span>
              </button>
            ))}
          </div>
          <p className="muted" style={{ marginTop: 6 }}>
            Tap a selected option again to clear it. No feedback until you submit — just like the
            real exam.
          </p>

          <div className="mock-footer">
            <button
              className="btn btn-secondary"
              disabled={question.index <= 1}
              onClick={() => load(question.index - 1)}
            >
              ← Previous
            </button>
            <button
              className="btn"
              disabled={question.index >= total}
              onClick={() => load(question.index + 1)}
            >
              Next →
            </button>
          </div>
        </main>
      </div>

      {confirming && (
        <div className="focus-footer" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
          <span>
            <strong>Submit exam?</strong>{' '}
            <span className="muted">
              {total - answered > 0
                ? `${total - answered} unanswered question${total - answered > 1 ? 's' : ''} will score as incorrect.`
                : 'All questions answered.'}
            </span>
          </span>
          <span style={{ display: 'flex', gap: 10 }}>
            <button className="btn btn-secondary" onClick={() => setConfirming(false)}>
              Keep going
            </button>
            <button className="btn" onClick={submit}>
              Submit now
            </button>
          </span>
        </div>
      )}
    </div>
  );
}
