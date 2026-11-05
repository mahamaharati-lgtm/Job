import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type RunRow } from '../api';
import { Empty, fmtDate, Loading } from '../components';

interface NotificationRow {
  id: number;
  kind: string;
  title: string;
  body: string;
  job_id: number | null;
  created_at: string;
  read_at: string | null;
  delivered: string[];
  delivery_errors: string[];
}

export function ActivityPage() {
  const qc = useQueryClient();
  const runs = useQuery({ queryKey: ['runs'], queryFn: () => api.get<RunRow[]>('/api/runs'), refetchInterval: 15_000 });
  const notes = useQuery({ queryKey: ['notifications'], queryFn: () => api.get<{ items: NotificationRow[]; unread: number }>('/api/notifications'), refetchInterval: 30_000 });
  const read = useMutation({ mutationFn: () => api.post('/api/notifications/read'), onSuccess: () => void qc.invalidateQueries() });
  return (
    <div className="stack" style={{ gap: 16 }}>
      <div className="page-head">
        <div>
          <h1>Activity</h1>
          <p>Scheduled and manual runs, and every notification sent to you.</p>
        </div>
      </div>
      <div className="split">
        <div className="card">
          <div className="card-head">
            <h2>Runs</h2>
          </div>
          {runs.isLoading ? (
            <Loading />
          ) : (runs.data ?? []).length === 0 ? (
            <Empty title="No runs yet">Click “Run now”, or wait for the scheduler.</Empty>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Started</th>
                    <th>Status</th>
                    <th>Found</th>
                    <th>Matched</th>
                    <th>Tailored</th>
                    <th>Applications</th>
                  </tr>
                </thead>
                <tbody>
                  {(runs.data ?? []).map((r) => (
                    <tr key={r.id}>
                      <td className="small">
                        {fmtDate(r.started_at, true)}
                        <div className="faint">{r.trigger}</div>
                      </td>
                      <td>
                        <span className={`badge ${r.status === 'success' ? 'b-green' : r.status === 'partial' ? 'b-amber' : r.status === 'running' ? 'b-blue' : r.status === 'skipped' ? 'b-gray' : 'b-red'}`}>{r.status}</span>
                        {r.summary?.errors?.length ? <div className="small" style={{ color: 'var(--red)', maxWidth: 260 }}>{r.summary.errors.slice(0, 2).join(' · ')}</div> : null}
                        {r.summary?.skippedReason && <div className="small faint">{r.summary.skippedReason}</div>}
                      </td>
                      <td className="small">
                        {r.summary?.discovery ? `${r.summary.discovery.inserted} new / ${r.summary.discovery.relevant} relevant` : '—'}
                        {r.summary?.discovery && <div className="faint">{r.summary.discovery.sourcesRun} sources ok, {r.summary.discovery.sourcesFailed} failed</div>}
                      </td>
                      <td className="small">{r.summary ? `${r.summary.matched} / ${r.summary.scored} scored` : '—'}</td>
                      <td className="small">{r.summary?.tailored ?? '—'}</td>
                      <td className="small">
                        {r.summary ? (
                          <>
                            {r.summary.apply.submitted} submitted · {r.summary.apply.dryRuns} dry runs
                            <div className="faint">
                              {r.summary.apply.needsReview} review · {r.summary.apply.needsInput} input · {r.summary.apply.failed} failed
                            </div>
                          </>
                        ) : (
                          '—'
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
        <div className="card">
          <div className="card-head">
            <h2>Notifications {notes.data?.unread ? <span className="nav-count">{notes.data.unread}</span> : null}</h2>
            <button className="btn btn-sm" onClick={() => read.mutate()}>
              Mark all read
            </button>
          </div>
          {(notes.data?.items ?? []).length === 0 ? (
            <Empty title="No notifications yet" />
          ) : (
            (notes.data?.items ?? []).map((n) => (
              <div key={n.id} className="list-item" style={{ alignItems: 'flex-start', opacity: n.read_at ? 0.7 : 1 }}>
                <div style={{ minWidth: 0 }}>
                  <div className="strong">{n.title}</div>
                  <pre className="small muted" style={{ maxHeight: 120, overflow: 'hidden' }}>
                    {n.body}
                  </pre>
                  <div className="small faint">
                    {fmtDate(n.created_at, true)} · {n.delivered.length ? `sent via ${n.delivered.join(', ')}` : 'in-app only'}
                    {n.delivery_errors.length > 0 && <span style={{ color: 'var(--red)' }}> · {n.delivery_errors.join('; ')}</span>}
                  </div>
                </div>
                {n.job_id && (
                  <a className="btn btn-sm" href={`/jobs/${n.job_id}`}>
                    Open
                  </a>
                )}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
