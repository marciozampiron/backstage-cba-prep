'use client';
// Practice Session — parity with practice_session_desktop/mobile (focus mode: header with
// progress + elapsed timer + close, competency chip, option rows, visual-only confidence selector,
// sticky submit) and with result_explanation_desktop for the post-answer feedback state.
// Contract rules hold: §9 never exposes correctOption; §10 provides verdict/explanation/sources.
import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { BulbIcon } from '../../../components/icons.js';
import CoachPanel from '../../../components/CoachPanel.js';

function useElapsed(resetKey) {
  const [seconds, setSeconds] = useState(0);
  const start = useRef(Date.now());
  useEffect(() => {
    start.current = Date.now();
    setSeconds(0);
    const t = setInterval(() => setSeconds(Math.floor((Date.now() - start.current) / 1000)), 1000);
    return () => clearInterval(t);
  }, [resetKey]);
  const mm = String(Math.floor(seconds / 60)).padStart(2, '0');
  const ss = String(seconds % 60).padStart(2, '0');
  return { seconds, label: `${mm}:${ss}` };
}

export default function PracticeSessionPage() {
  const { sessionId } = useParams();
  const router = useRouter();
  const [current, setCurrent] = useState(null); // { index, total, question }
  const [selected, setSelected] = useState(null);
  const [confidence, setConfidence] = useState(null); // visual only — not part of contract §10
  const [feedback, setFeedback] = useState(null); // §10 response
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const timer = useElapsed(sessionId);
  const questionStart = useRef(Date.now());

  const loadNext = useCallback(async () => {
    setError(null);
    const res = await fetch(`/api/practice-sessions/${sessionId}/next`);
    const body = await res.json();
    if (!res.ok) {
      setError(body.error?.message ?? 'Could not load the next question.');
      return;
    }
    if (body.done) {
      router.push(`/results/${body.attemptId}`);
      return;
    }
    setCurrent(body);
    setSelected(null);
    setConfidence(null);
    setFeedback(null);
    questionStart.current = Date.now();
  }, [sessionId, router]);

  useEffect(() => {
    loadNext();
  }, [loadNext]);

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
        timeSpentSeconds: Math.round((Date.now() - questionStart.current) / 1000),
      }),
    });
    const body = await res.json();
    setBusy(false);
    if (!res.ok) {
      setError(body.error?.message ?? 'Could not submit the answer.');
      return;
    }
    setFeedback(body);
    window.scrollTo({ top: 0 });
  };

  const progressPct = current ? Math.round(((current.index - 1) / current.total) * 100) : 0;

  return (
    <div>
      <header className="focus-top">
        <span className="focus-brand">CBA Study Coach</span>
        <span className="chip">Practice session</span>
        <div className="focus-mid">
          {current && (
            <>
              <div className="focus-count">
                Question {current.index} of {current.total}
              </div>
              <div className="focus-bar">
                <span style={{ width: `${feedback ? Math.round((current.index / current.total) * 100) : progressPct}%` }} />
              </div>
            </>
          )}
        </div>
        <span className="focus-timer">⏱ {timer.label}</span>
        <a className="focus-close" href="/" aria-label="Exit session">
          ✕
        </a>
      </header>

      <div className="focus-wrap">
        {error && <p className="error-box">{error}</p>}
        {!current && !error && <p className="muted">Loading question…</p>}

        {current && !feedback && (
          <>
            <span className="chip">{current.question.competency.name}</span>
            <p className="stem">{current.question.stem}</p>

            <div role="group" aria-label="Answer options">
              {current.question.options.map((o) => (
                <button
                  key={o.key}
                  type="button"
                  className="option"
                  aria-pressed={selected === o.key}
                  onClick={() => setSelected(o.key)}
                >
                  <span className="radio" />
                  <span>
                    <span className="key">{o.key})</span> {o.text}
                  </span>
                </button>
              ))}
            </div>

            <div className="confidence">
              <span className="label-caps">How confident are you?</span>
              <div className="segmented" role="group" aria-label="Confidence (optional)">
                {['Low', 'Medium', 'High'].map((c) => (
                  <button
                    key={c}
                    type="button"
                    aria-pressed={confidence === c}
                    onClick={() => setConfidence(c)}
                  >
                    {c}
                  </button>
                ))}
              </div>
            </div>

            <footer className="focus-footer">
              <button className="btn" onClick={submit} disabled={!selected || busy}>
                {busy ? 'Checking…' : 'Submit Answer'}
              </button>
            </footer>
          </>
        )}

        {current && feedback && (
          <>
            <div className="verdict">
              <span className={`v-icon ${feedback.correct ? 'ok' : 'bad'}`}>
                {feedback.correct ? '✓' : '✕'}
              </span>
              <div>
                <h1>{feedback.correct ? 'Correct' : 'Incorrect'}</h1>
              </div>
            </div>
            <p className="sub">
              {feedback.correct
                ? 'Nice — read the explanation to lock the concept in.'
                : 'Review the explanation below to understand the correct concept.'}
            </p>

            <div className="card">
              <div className="card-body">
                <span className="chip">{current.question.domain.name}</span>
                <p className="stem" style={{ fontSize: 17, margin: '12px 0 16px' }}>
                  {current.question.stem}
                </p>
                {current.question.options.map((o) => {
                  const isCorrect = o.key === feedback.correctOption;
                  const isYours = o.key === selected;
                  const cls = isCorrect ? 'option correct' : isYours ? 'option incorrect' : 'option';
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
              </div>
            </div>

            <div className="card">
              <div className="card-head">
                <span className="explain-title">
                  <BulbIcon width={16} height={16} /> Explanation
                </span>
              </div>
              <div className="card-body">
                <p style={{ marginTop: 0 }}>
                  The correct answer is <strong>{feedback.correctOption}</strong>.
                </p>
                <p style={{ marginBottom: 0 }}>{feedback.explanation}</p>
                {feedback.whyOthersWrong && <p style={{ marginBottom: 0 }}>{feedback.whyOthersWrong}</p>}
                <span className="label-caps">Source reference</span>
                {feedback.sourceRefs.map((s) => (
                  <a
                    key={s.url}
                    className="source-chip"
                    style={{ marginTop: 0 }}
                    href={s.url}
                    target="_blank"
                    rel="noreferrer"
                  >
                    🔗 Source: {s.url.replace(/^https?:\/\//, '')}
                  </a>
                ))}
              </div>
            </div>

            <div className="next-grid">
              <CoachPanel
                context={{ questionVersionId: current.question.questionVersionId }}
                actions={['explain_question', 'recommend_next']}
              />
              <div className="card move-on" style={{ margin: 0, padding: '16px 18px' }}>
                <strong>Ready to move on?</strong>
                <span className="muted">Your progress is saved automatically.</span>
                <button className="btn" style={{ marginTop: 8 }} onClick={loadNext}>
                  {feedback.nextIndex ? 'Next Question →' : 'See results →'}
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
