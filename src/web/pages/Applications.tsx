import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import type { JobStatus } from '../../shared/types';
import { api } from '../api';
import { Empty, fmtDate, Loading, reasonLabel, ScoreBadge, StatusBadge } from '../components';

interface AppRow {
  id: number;
  job_id: number;
  state: string;
  review_reason: string | null;
  adapter: string;
  submitted_at: string | null;
  submitted_via: string | null;
  confirmation_text: string | null;
  last_error: string | null;
  next_action: string | null;
  missing_count: number;
  attempts: number;
  updated_at: string;
  title: string;
  company: string;
  location: string | null;
  score: number | null;
  status: JobStatus;
  apply_url: string | null;
}

const TABS: Array<{ key: string; label: string; statuses: JobStatus[] }> = [
  { key: 'attention', label: 'Needs you', statuses: ['needs_input', 'needs_review', 'failed'] },
  { key: 'ready', label: 'Resume ready', statuses: ['resume_ready', 'matched'] },
  { key: 'submitted', label: 'Submitted', statuses: ['submitted'] },
  { key: 'closed', label: 'Closed', statuses: ['closed'] },
  { key: 'all', label: 'All', statuses: [] },
];

export function ApplicationsPage() {
  const nav = useNavigate();
  const [tab, setTab] = useState('attention');
  const q = useQuery({ queryKey: ['applications'], queryFn: () => api.get<AppRow[]>('/api/applications'), refetchInterval: 15_000 });
  const current = TABS.find((t) => t.key === tab)!;
  const rows = (q.data ?? []).filter((r) => current.statuses.length === 0 || current.statuses.includes(r.status));
  return (
    <div className="stack" style={{ gap: 16 }}>
      <div className="page-head">
        <div>
          <h1>Applications</h1>
          <p>Every application with its status, evidence, errors and next action. “Submitted” always means confirmed.</p>
        </div>
      </div>
      <div className="tabs" role="tablist">
        {TABS.map((t) => {
          const n = (q.data ?? []).filter((r) => t.statuses.length === 0 || t.statuses.includes(r.status)).length;
          return (
            <button key={t.key} role="tab" aria-selected={tab === t.key} className={`tab${tab === t.key ? ' active' : ''}`} onClick={() => setTab(t.key)}>
              {t.label} <span className="faint">({n})</span>
            </button>
          );
        })}
      </div>
      <div className="card">
        {q.isLoading ? (
          <Loading />
        ) : rows.length === 0 ? (
          <Empty title="Nothing here">Applications are created when a matched job is prepared.</Empty>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Score</th>
                  <th>Role</th>
                  <th>Status</th>
                  <th>Method</th>
                  <th>Submitted / evidence</th>
                  <th>Next action</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className="clickable" onClick={() => nav(`/jobs/${r.job_id}`)}>
                    <td>
                      <ScoreBadge score={r.score} />
                    </td>
                    <td style={{ minWidth: 220 }}>
                      <div className="strong">{r.title}</div>
                      <div className="small muted">
                        {r.company}
                        {r.location ? ` · ${r.location}` : ''}
                      </div>
                    </td>
                    <td>
                      <StatusBadge status={r.status} />
                      {(r.review_reason || r.missing_count > 0) && (
                        <div className="small faint" style={{ marginTop: 3, maxWidth: 220 }}>
                          {r.status === 'needs_input' ? `${r.missing_count} answer(s) needed` : reasonLabel(r.review_reason)}
                        </div>
                      )}
                    </td>
                    <td className="small">{r.adapter === 'manual' ? 'Manual' : r.adapter === 'greenhouse' ? 'Greenhouse form' : 'Lever form'}</td>
                    <td className="small">
                      {r.submitted_at ? (
                        <>
                          {fmtDate(r.submitted_at, true)}
                          <div className="faint ellipsis" style={{ maxWidth: 240 }}>
                            {r.submitted_via} · “{r.confirmation_text}”
                          </div>
                        </>
                      ) : r.last_error ? (
                        <span style={{ color: 'var(--red)' }}>{r.last_error.slice(0, 120)}</span>
                      ) : (
                        <span className="faint">—</span>
                      )}
                    </td>
                    <td className="small muted" style={{ maxWidth: 260 }}>
                      {r.next_action ?? (r.status === 'needs_input' ? 'Answer the missing questions' : '—')}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
