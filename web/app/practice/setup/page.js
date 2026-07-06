'use client';
// Practice Setup — parity with practice_setup_desktop/mobile: Configure Your Session card, domain
// select, segmented difficulty/count, practice-mode cards, weak-areas-style toggle, Start Practice →.
// API values come from GET /api/practice/options (contract §7); POST /api/practice-sessions (§8).
import { Suspense, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Shell from '../../components/Shell.js';

function SetupForm() {
  const router = useRouter();
  const search = useSearchParams();
  const [options, setOptions] = useState(null);
  const [domainId, setDomainId] = useState(search.get('domainId') ?? '');
  const [competencyId, setCompetencyId] = useState('');
  const [questionCount, setQuestionCount] = useState(Number(search.get('questionCount')) || 5);
  const [difficulty, setDifficulty] = useState('mixed');
  const [onlyMissed, setOnlyMissed] = useState(false);
  const [error, setError] = useState(null);
  const [starting, setStarting] = useState(false);

  useEffect(() => {
    fetch('/api/practice/options')
      .then((r) => r.json())
      .then(setOptions)
      .catch(() => setError('Could not load practice options.'));
  }, []);

  if (!options)
    return <p className="muted">{error ?? 'Loading options…'}</p>;

  const domain = options.domains.find((d) => d.domainId === domainId) ?? null;

  const start = async () => {
    setStarting(true);
    setError(null);
    const res = await fetch('/api/practice-sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        domainId: domainId || undefined,
        competencyId: competencyId || undefined,
        questionCount,
        difficulty,
        onlyMissed,
      }),
    });
    const body = await res.json();
    if (!res.ok) {
      setStarting(false);
      setError(
        body.error?.code === 'INSUFFICIENT_QUESTIONS'
          ? `Only ${body.error.details.available} questions match this filter — pick a smaller drill or widen the filter.`
          : body.error?.message ?? 'Could not start the drill.',
      );
      return;
    }
    router.push(`/practice/session/${body.practiceSessionId}`);
  };

  return (
    <>
      <h1>Practice Setup</h1>
      <p className="sub">Customize your practice to focus on what matters most.</p>

      <div className="card">
        <div className="card-head">
          <h2>Configure Your Session</h2>
        </div>
        <div className="card-body">
          <label className="label-caps" style={{ marginTop: 4 }} htmlFor="domain">
            Domain
          </label>
          <select
            id="domain"
            value={domainId}
            onChange={(e) => {
              setDomainId(e.target.value);
              setCompetencyId('');
            }}
          >
            <option value="">All Domains</option>
            {options.domains.map((d) => (
              <option key={d.domainId} value={d.domainId}>
                {d.name} ({d.weightPercent}%)
              </option>
            ))}
          </select>

          {domain && (
            <>
              <label className="label-caps" htmlFor="competency">
                Competency (optional)
              </label>
              <select
                id="competency"
                value={competencyId}
                onChange={(e) => setCompetencyId(e.target.value)}
              >
                <option value="">All competencies</option>
                {domain.competencies.map((c) => (
                  <option key={c.competencyId} value={c.competencyId}>
                    {c.name}
                  </option>
                ))}
              </select>
            </>
          )}

          <div className="setup-grid">
            <div>
              <span className="label-caps">Difficulty level</span>
              <div className="segmented" role="group" aria-label="Difficulty">
                {options.difficulties.map((d) => (
                  <button
                    key={d}
                    type="button"
                    aria-pressed={difficulty === d}
                    onClick={() => setDifficulty(d)}
                  >
                    {d}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <span className="label-caps">Number of questions</span>
              <div className="segmented" role="group" aria-label="Question count">
                {options.questionCounts.map((n) => (
                  <button
                    key={n}
                    type="button"
                    aria-pressed={questionCount === n}
                    onClick={() => setQuestionCount(n)}
                  >
                    {n}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <span className="label-caps">Practice mode</span>
          <div className="mode-grid">
            <button type="button" className="mode-card" aria-pressed="true">
              <span className="radio" />
              <span>
                <span className="m-name">Review Mode</span>
                <br />
                <span className="m-desc">
                  Get instant feedback after each question to learn as you go.
                </span>
              </span>
            </button>
            <span className="mode-card disabled" aria-disabled="true">
              <span className="radio" />
              <span>
                <span className="m-name">
                  Timed Mode <span className="soon">SOON</span>
                </span>
                <br />
                <span className="m-desc">
                  Simulate test conditions — arrives with the mock exam slice.
                </span>
              </span>
            </span>
          </div>

          <div className="toggle-row">
            <div className="t-text">
              <div className="t-name">Only questions I missed before</div>
              <div className="t-desc">Rebuild weak spots by replaying questions you got wrong.</div>
            </div>
            <button
              type="button"
              className="switch"
              role="switch"
              aria-checked={onlyMissed}
              aria-label="Only questions I missed before"
              onClick={() => setOnlyMissed((v) => !v)}
            />
          </div>

          {error && <p className="error-box">{error}</p>}

          <div className="setup-footer">
            <button className="btn" onClick={start} disabled={starting}>
              {starting ? 'Starting…' : 'Start Practice →'}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}

export default function PracticeSetupPage() {
  return (
    <Shell>
      <Suspense fallback={<p className="muted">Loading options…</p>}>
        <SetupForm />
      </Suspense>
    </Shell>
  );
}
