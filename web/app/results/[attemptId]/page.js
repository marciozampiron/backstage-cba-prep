'use client';
// Attempt results — kind-aware (mock vs drill), parity with mock_results_desktop/mobile: score
// ring, readiness pill, Recommended Study Plan focus area, colored Domain Breakdown.
import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Shell from '../../components/Shell.js';
import { TargetIcon } from '../../components/icons.js';

function pctClass(p) {
  if (p >= 75) return 'good';
  if (p >= 55) return 'warn';
  return 'bad';
}

function ScoreRing({ percent }) {
  const r = 62;
  const c = 2 * Math.PI * r;
  return (
    <div className="ring" role="img" aria-label={`Overall score ${percent} percent`}>
      <svg width="150" height="150">
        <circle cx="75" cy="75" r={r} stroke="var(--border)" strokeWidth="12" fill="none" />
        <circle
          cx="75"
          cy="75"
          r={r}
          stroke="var(--primary)"
          strokeWidth="12"
          fill="none"
          strokeLinecap="round"
          strokeDasharray={`${(percent / 100) * c} ${c}`}
        />
      </svg>
      <span className="ring-label">{percent}%</span>
    </div>
  );
}

export default function AttemptResultsPage() {
  const { attemptId } = useParams();
  const router = useRouter();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

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

  if (error)
    return (
      <Shell>
        <p className="error-box">{error}</p>
      </Shell>
    );
  if (!data)
    return (
      <Shell>
        <p className="muted">Scoring your attempt…</p>
      </Shell>
    );

  const isMock = data.kind === 'mock';
  const delta = data.score.percent - data.target.percent;
  const readinessPill =
    delta >= 0
      ? { cls: 'good', text: 'Pass Readiness: High' }
      : delta >= -15
        ? { cls: 'warn', text: 'Pass Readiness: Building' }
        : { cls: 'plain', text: 'Keep drilling — early days' };

  const drillWeakest = data.nextActions.find((a) => a.type === 'start_drill');
  const weakestDomain = drillWeakest
    ? data.domains.find((d) => d.domainId === drillWeakest.domainId)
    : null;
  const minutes = Math.round(data.timeUsedSeconds / 60);

  const retakeMock = async () => {
    setBusy(true);
    const res = await fetch('/api/mock-exams', { method: 'POST' });
    const body = await res.json();
    if (res.status === 201) router.push(`/mock/${body.mockExamId}`);
    else if (res.status === 409) router.push(`/mock/${body.error.details.mockExamId}`);
    else setBusy(false);
  };

  return (
    <Shell>
      <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 220 }}>
          <h1>{isMock ? 'Mock Exam Results' : 'Drill Results'}</h1>
          <p className="sub" style={{ marginBottom: 0 }}>
            {data.score.correct} of {data.score.total} correct ·{' '}
            {isMock ? `${minutes} min` : `${data.timeUsedSeconds}s`} · target {data.target.percent}%
            (not an official pass score)
          </p>
        </div>
        {drillWeakest && (
          <button
            className="btn btn-secondary"
            onClick={() =>
              router.push(
                `/practice/setup?domainId=${drillWeakest.domainId}&questionCount=${drillWeakest.questionCount}`,
              )
            }
          >
            Start Targeted Practice
          </button>
        )}
        {isMock ? (
          <button className="btn" onClick={retakeMock} disabled={busy}>
            {busy ? 'Preparing…' : 'Retake Mock'}
          </button>
        ) : (
          <a className="btn" href="/practice/setup">
            New Drill
          </a>
        )}
      </div>

      <div className="results-grid" style={{ marginTop: 18 }}>
        <div className="card" style={{ margin: 0 }}>
          <div className="card-head">
            <h2>Overall Score</h2>
          </div>
          <div className="ring-wrap">
            <ScoreRing percent={data.score.percent} />
            <span className={`pill ${readinessPill.cls}`}>{readinessPill.text}</span>
            {isMock && data.missed.count > 0 && (
              <span className="muted">{data.missed.count} missed (unanswered count as incorrect)</span>
            )}
          </div>
        </div>

        <div>
          <div className="card">
            <div className="card-head">
              <h2>Recommended Study Plan</h2>
            </div>
            <div className="card-body">
              <div className="focus-area">
                <span className="fa-icon">
                  <TargetIcon width={16} height={16} />
                </span>
                <div>
                  <strong>
                    {weakestDomain
                      ? `Focus area identified: ${weakestDomain.name}`
                      : 'No weak area detected in this attempt'}
                  </strong>
                  <p className="muted" style={{ margin: '4px 0 0' }}>
                    {data.coachSummary.text}
                  </p>
                </div>
              </div>
            </div>
          </div>

          <div className="card" style={{ marginBottom: 0 }}>
            <div className="card-head">
              <h2>Domain Breakdown</h2>
            </div>
            <div className="card-body">
              {data.domains.map((d) => (
                <div key={d.domainId} className="domain-row">
                  <div className="d-top">
                    <div>
                      <div className="d-name">{d.name}</div>
                      <div className="d-weight">
                        {d.correct}/{d.total} correct{isMock ? ` · weight ${d.weightPercent}%` : ''}
                      </div>
                    </div>
                    <span className={`d-pct ${pctClass(d.percent)}`}>{d.percent}%</span>
                  </div>
                  <div className="bar">
                    <span className={pctClass(d.percent)} style={{ width: `${d.percent}%` }} />
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </Shell>
  );
}
