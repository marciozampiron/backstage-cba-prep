'use client';
// Practice Setup (screen map #2): configure a focused drill without friction.
import { Suspense, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';

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

  if (!options) return <p className="muted">Loading options…</p>;

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
    <main>
      <h1>Set up your drill</h1>
      <p className="sub">Every question is grounded in the official Backstage docs.</p>

      <div className="card">
        <label className="label-caps" htmlFor="domain">
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
          <option value="">All domains</option>
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

        <span className="label-caps">Questions</span>
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

        <span className="label-caps">Difficulty</span>
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

        <label className="toggle-row">
          <input
            type="checkbox"
            checked={onlyMissed}
            onChange={(e) => setOnlyMissed(e.target.checked)}
          />
          Only questions I missed before
        </label>

        {error && <p className="error-box">{error}</p>}

        <div className="actions">
          <button className="btn" onClick={start} disabled={starting}>
            {starting ? 'Starting…' : 'Start drill'}
          </button>
        </div>
      </div>
    </main>
  );
}

export default function PracticeSetupPage() {
  return (
    <Suspense fallback={<p className="muted">Loading options…</p>}>
      <SetupForm />
    </Suspense>
  );
}
