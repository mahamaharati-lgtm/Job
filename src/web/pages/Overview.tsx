import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { api, type Overview } from '../api';
import { Empty, Loading, reasonLabel, ScoreBadge, StatusBadge, timeAgo } from '../components';

export function OverviewPage() {
  const nav = useNavigate();
  const q = useQuery({ queryKey: ['overview'], queryFn: () => api.get<Overview>('/api/overview'), refetchInterval: 15_000 });
  const digest = useQuery({ queryKey: ['digest'], queryFn: () => api.get<{ title: string; text: string }>('/api/digest/preview') });
  if (q.isLoading || !q.data) return <Loading />;
  const d = q.data;
  const t = d.stats.totals;
  const lastRun = d.runs[0];
  return (
    <div className="stack" style={{ gap: 16 }}>
      <div className="page-head">
        <div>
          <h1>Overview</h1>
          <p>Jobs found, applications in flight, and anything that needs you.</p>
        </div>
      </div>

      {!d.profile && (
        <div className="alert alert-info">
          <div>
            <strong>Start by uploading your resume</strong>
            The system extracts an editable profile from it. Nothing is tailored or submitted until you review and verify that profile. <Link to="/resumes">Upload resume →</Link>
          </div>
        </div>
      )}
      {d.profile && !d.profile.verified && (
        <div className="alert alert-warn">
          <div>
            <strong>Verify your profile</strong>
            Check the extracted facts, then click “Verify profile”. Automatic submission stays off until you do. <Link to="/profile">Review profile →</Link>
          </div>
        </div>
      )}

      <div className="grid grid-4">
        <div className="card stat">
          <div className="stat-label">New jobs (24h)</div>
          <div className="stat-value">{d.stats.foundLast24h}</div>
          <div className="stat-sub">
            {d.stats.byTrack.frontend} frontend · {d.stats.byTrack.ai} AI open
          </div>
        </div>
        <div className="card stat">
          <div className="stat-label">Matched / resume ready</div>
          <div className="stat-value">
            {t.matched} / {t.resume_ready}
          </div>
          <div className="stat-sub">above your threshold ({d.automation.matchThreshold})</div>
        </div>
        <div className="card stat">
          <div className="stat-label">Needs you</div>
          <div className="stat-value" style={{ color: t.needs_input + t.needs_review + t.failed ? 'var(--amber)' : undefined }}>{t.needs_input + t.needs_review + t.failed}</div>
          <div className="stat-sub">
            {t.needs_input} input · {t.needs_review} review · {t.failed} failed
          </div>
        </div>
        <div className="card stat">
          <div className="stat-label">Submitted (confirmed)</div>
          <div className="stat-value" style={{ color: 'var(--green)' }}>{d.stats.submittedTotal}</div>
          <div className="stat-sub">
            {d.stats.submittedToday}/{d.stats.dailyLimit} today
          </div>
        </div>
      </div>

      <div className="split">
        <div className="stack">
          <div className="card">
            <div className="card-head">
              <h2>Needs your attention</h2>
              <Link to="/applications" className="small">
                All applications →
              </Link>
            </div>
            {d.attention.length === 0 ? (
              <Empty title="Nothing waiting on you">New matches will appear here when they need an answer or approval.</Empty>
            ) : (
              d.attention.map((j) => (
                <div key={j.id} className="list-item clickable" style={{ cursor: 'pointer' }} onClick={() => nav(`/jobs/${j.id}`)}>
                  <div style={{ minWidth: 0 }}>
                    <div className="strong ellipsis">
                      {j.title} · <span className="muted">{j.company}</span>
                    </div>
                    <div className="small muted">{reasonLabel(j.status_reason) ?? ''}</div>
                  </div>
                  <div className="row">
                    <ScoreBadge score={j.score} />
                    <StatusBadge status={j.status} />
                  </div>
                </div>
              ))
            )}
          </div>

          <div className="card">
            <div className="card-head">
              <h2>Recent activity</h2>
              <Link to="/activity" className="small">
                Runs & notifications →
              </Link>
            </div>
            <div className="card-body timeline">
              {d.recent.length === 0 && <span className="muted">No activity yet.</span>}
              {d.recent.slice(0, 12).map((e) => (
                <div key={e.id} className="tl-item">
                  <span className="faint small">{timeAgo(e.created_at)}</span>
                  <span>
                    {e.job_id ? (
                      <Link to={`/jobs/${e.job_id}`}>
                        {e.title} · {e.company}
                      </Link>
                    ) : (
                      <span className="strong">System</span>
                    )}{' '}
                    <span className="muted">— {e.message}</span>
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="stack">
          <div className="card">
            <div className="card-head">
              <h2>Automation</h2>
              <Link to="/settings?tab=automation" className="small">
                Configure →
              </Link>
            </div>
            <div className="card-body">
              <dl className="kv">
                <dt>Mode</dt>
                <dd>{d.automation.mode === 'auto' ? 'Automatic (within your rules)' : 'Review before submit'}</dd>
                <dt>Dry run</dt>
                <dd>{d.automation.dryRun ? 'On — nothing is submitted' : 'Off — live submissions'}</dd>
                <dt>Paused</dt>
                <dd>{d.automation.paused ? 'Yes' : 'No'}</dd>
                <dt>Threshold</dt>
                <dd>{d.automation.matchThreshold}/100</dd>
                <dt>Daily limit</dt>
                <dd>
                  {d.stats.submittedToday}/{d.automation.dailyLimit}
                </dd>
                <dt>Profile</dt>
                <dd>{d.profile ? `${d.profile.name} · ${d.profile.verified ? 'verified' : 'not verified'} · ~${d.profile.years} yrs` : 'not uploaded'}</dd>
                <dt>Last run</dt>
                <dd>
                  {lastRun ? (
                    <>
                      {timeAgo(lastRun.started_at)} · {lastRun.status}
                      {lastRun.summary?.discovery && ` · ${lastRun.summary.discovery.inserted} new`}
                    </>
                  ) : (
                    'never'
                  )}
                </dd>
              </dl>
            </div>
          </div>
          <div className="card">
            <div className="card-head">
              <h2>Today’s digest (preview)</h2>
            </div>
            <div className="card-body">
              {digest.data ? (
                <>
                  <div className="strong" style={{ marginBottom: 8 }}>
                    {digest.data.title}
                  </div>
                  <pre className="small muted" style={{ maxHeight: 360, overflow: 'auto' }}>
                    {digest.data.text}
                  </pre>
                </>
              ) : (
                <Loading />
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
