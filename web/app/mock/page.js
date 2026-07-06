'use client';
// Mock Exam entry: start a new 60-question / 90-minute simulation or resume the in-progress one
// (the store enforces a single in-progress mock per learner — 409 MOCK_EXAM_IN_PROGRESS resumes).
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Shell from '../components/Shell.js';
import { ClockIcon } from '../components/icons.js';

export default function MockStartPage() {
  const router = useRouter();
  const [resume, setResume] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetch('/api/dashboard')
      .then((r) => r.json())
      .then((d) => setResume(d.resume?.kind === 'mock' ? d.resume : null))
      .catch(() => {});
  }, []);

  const start = async () => {
    setBusy(true);
    setError(null);
    const res = await fetch('/api/mock-exams', { method: 'POST' });
    const body = await res.json();
    if (res.status === 201) {
      router.push(`/mock/${body.mockExamId}`);
      return;
    }
    if (res.status === 409 && body.error?.code === 'MOCK_EXAM_IN_PROGRESS') {
      router.push(`/mock/${body.error.details.mockExamId}`);
      return;
    }
    setBusy(false);
    setError(body.error?.message ?? 'Could not start the mock exam.');
  };

  return (
    <Shell>
      <h1>Mock Exam</h1>
      <p className="sub">Simulate the real Certified Backstage Associate exam.</p>

      <div className="card">
        <div className="card-body">
          <div className="focus-area">
            <span className="fa-icon">
              <ClockIcon width={16} height={16} />
            </span>
            <div>
              <strong>60 questions · 90 minutes · blueprint-weighted</strong>
              <p className="muted" style={{ margin: '4px 0 0' }}>
                No feedback until you submit — flag questions to revisit them, navigate freely, and
                change answers any time before submitting. Unanswered questions score as incorrect,
                and the exam auto-submits when time runs out.
              </p>
            </div>
          </div>
          {error && <p className="error-box">{error}</p>}
          <div className="actions">
            <button className="btn" onClick={start} disabled={busy}>
              {busy
                ? 'Preparing…'
                : resume
                  ? `Resume mock exam (${resume.answered}/${resume.total} answered)`
                  : 'Start Mock Exam'}
            </button>
            <a className="btn btn-secondary" href="/">
              Back to dashboard
            </a>
          </div>
        </div>
      </div>
    </Shell>
  );
}
