'use client';
// Learner Dashboard — parity with learner_dashboard_desktop/mobile: stat tiles, domain readiness
// with status colors, recommended actions, recent activity. First-run keeps the warm-up behavior.
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Shell from './components/Shell.js';
import { ChevronIcon, TrendIcon, TargetIcon, BookIcon, ClockIcon } from './components/icons.js';

function pctClass(p) {
  if (p === null || p === undefined) return 'none';
  if (p >= 75) return 'good';
  if (p >= 55) return 'warn';
  return 'bad';
}

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

  if (error)
    return (
      <Shell>
        <p className="error-box">{error}</p>
      </Shell>
    );
  if (!data)
    return (
      <Shell>
        <p className="muted">Loading your study state…</p>
      </Shell>
    );

  const startRecommended = () => {
    const params = new URLSearchParams();
    if (data.recommendedDrill.domainId) params.set('domainId', data.recommendedDrill.domainId);
    params.set('questionCount', String(data.recommendedDrill.questionCount));
    router.push(`/practice/setup?${params.toString()}`);
  };

  const drills = data.recentAttempts.length;

  return (
    <Shell>
      <h1>Overview</h1>
      <p className="sub">Your progress towards Certified Backstage Associate readiness.</p>

      <div className="tiles">
        <div className="tile">
          <div className="t-label">
            Readiness score
            <span className="t-icon good">
              <TrendIcon width={13} height={13} />
            </span>
          </div>
          <div className="t-value">{data.readiness.percent !== null ? `${data.readiness.percent}%` : '—'}</div>
          <div className="t-sub">
            {data.firstRun ? 'Take a warm-up to unlock' : 'Deterministic, from your drills'}
          </div>
        </div>
        <div className="tile">
          <div className="t-label">
            Target score
            <span className="t-icon info">
              <TargetIcon width={13} height={13} />
            </span>
          </div>
          <div className="t-value">{data.readiness.targetPercent}%</div>
          <div className="t-sub">Not an official pass score</div>
        </div>
        <div className="tile">
          <div className="t-label">
            Drills completed
            <span className="t-icon warn">
              <BookIcon width={13} height={13} />
            </span>
          </div>
          <div className="t-value">{drills}</div>
          <div className="t-sub">{drills === 0 ? 'Your loop starts here' : 'Recent sessions'}</div>
        </div>
        <div className="tile">
          <div className="t-label">
            Exam format
            <span className="t-icon info">
              <ClockIcon width={13} height={13} />
            </span>
          </div>
          <div className="t-value">60</div>
          <div className="t-sub">questions · 90 minutes</div>
        </div>
      </div>

      <div className="dash-grid">
        <div>
          <div className="card">
            <div className="card-head">
              <h2>Domain Readiness</h2>
            </div>
            <div className="card-body">
              {data.domains.map((d) => (
                <div key={d.domainId} className="domain-row">
                  <div className="d-top">
                    <div>
                      <div className="d-name">{d.name}</div>
                      <div className="d-weight">Weight: {d.weightPercent}%</div>
                    </div>
                    <span className={`d-pct ${pctClass(d.readinessPercent)}`}>
                      {d.readinessPercent !== null ? `${d.readinessPercent}%` : 'no data yet'}
                    </span>
                  </div>
                  <div className="bar">
                    <span
                      className={pctClass(d.readinessPercent)}
                      style={{ width: `${d.readinessPercent ?? 0}%` }}
                    />
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>

        <div>
          <div className="card">
            <div className="card-head">
              <h2>Recommended Actions</h2>
            </div>
            <div className="card-body">
              <button className="action-row primary" onClick={startRecommended}>
                <div>
                  <div className="a-title">
                    {data.firstRun ? 'Start 5-question warm-up' : 'Start adaptive practice'}
                  </div>
                  <div className="a-sub">{data.coachNudge.text}</div>
                </div>
                <span className="chev">
                  <ChevronIcon />
                </span>
              </button>
              <span className="action-row disabled" aria-disabled="true">
                <div>
                  <div className="a-title">Review missed questions</div>
                  <div className="a-sub">Arrives with the review slice</div>
                </div>
                <span className="soon">SOON</span>
              </span>
              <a className="action-row" href="/mock">
                <div>
                  <div className="a-title">
                    {data.resume?.kind === 'mock' ? 'Resume mock exam' : 'Take a mock exam'}
                  </div>
                  <div className="a-sub">
                    {data.resume?.kind === 'mock'
                      ? `${data.resume.answered}/${data.resume.total} answered — timer is running`
                      : '60 questions · 90 minutes · blueprint-weighted'}
                  </div>
                </div>
                <span className="chev">
                  <ChevronIcon />
                </span>
              </a>
            </div>
          </div>

          <div className="card">
            <div className="card-head">
              <h2>Recent Activity</h2>
            </div>
            <div className="card-body">
              {data.recentAttempts.length === 0 && (
                <p className="muted" style={{ margin: 0 }}>
                  No sessions yet — your activity will show up here.
                </p>
              )}
              {data.recentAttempts.map((a) => (
                <div key={a.attemptId} className="activity-row">
                  <span className="t-icon info">
                    <BookIcon width={13} height={13} />
                  </span>
                  <div>
                    Practiced: drill scored {a.scorePercent}%
                    <span className="time">{new Date(a.completedAt).toLocaleString()}</span>
                  </div>
                  <a style={{ marginLeft: 'auto', fontSize: 13 }} href={`/results/${a.attemptId}`}>
                    View
                  </a>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </Shell>
  );
}
