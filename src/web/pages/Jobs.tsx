import { useState } from 'react';
import { keepPreviousData, useMutation, useQuery } from '@tanstack/react-query';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { JOB_STATUSES, STATUS_LABELS } from '../../shared/types';
import { api, type JobListItem, type Paged } from '../api';
import { Empty, Loading, Modal, reasonLabel, ScoreBadge, StatusBadge, TrackChips, timeAgo, useToast } from '../components';

export function JobsPage() {
  const nav = useNavigate();
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const [adding, setAdding] = useState(false);
  const filters = {
    track: params.get('track') ?? '',
    status: params.get('status') ?? '',
    q: params.get('q') ?? '',
    minScore: params.get('minScore') ?? '',
    sort: params.get('sort') ?? 'score',
    eligibleOnly: params.get('eligibleOnly') === '1',
    includeClosed: params.get('includeClosed') === '1',
    page: Number(params.get('page') ?? '1'),
  };
  const set = (k: string, v: string) => {
    const next = new URLSearchParams(params);
    if (v) next.set(k, v);
    else next.delete(k);
    if (k !== 'page') next.delete('page');
    setParams(next, { replace: true });
  };
  const qs = new URLSearchParams();
  Object.entries(filters).forEach(([k, v]) => {
    if (v !== '' && v !== false) qs.set(k, String(v === true ? 'true' : v));
  });
  const q = useQuery({ queryKey: ['jobs', qs.toString()], queryFn: () => api.get<Paged<JobListItem>>(`/api/jobs?${qs}`), placeholderData: keepPreviousData, refetchInterval: 20_000 });

  return (
    <div className="stack" style={{ gap: 16 }}>
      <div className="page-head">
        <div>
          <h1>Jobs</h1>
          <p>Every opening discovered, scored against your verified profile and preferences.</p>
        </div>
        <button className="btn" onClick={() => setAdding(true)}>
          + Add a job manually
        </button>
      </div>

      <div className="card card-pad stack-sm">
        <div className="row" style={{ gap: 10 }}>
          <div className="seg" role="group" aria-label="Track">
            {[
              ['', 'All'],
              ['frontend', 'Frontend / React'],
              ['ai', 'AI / Prompting'],
            ].map(([v, l]) => (
              <button key={v} className={filters.track === v ? 'active' : ''} onClick={() => set('track', v)}>
                {l}
              </button>
            ))}
          </div>
          <select style={{ width: 170 }} value={filters.status} onChange={(e) => set('status', e.target.value)} aria-label="Status">
            <option value="">All open statuses</option>
            {JOB_STATUSES.map((s) => (
              <option key={s} value={s}>
                {STATUS_LABELS[s]}
              </option>
            ))}
          </select>
          <select style={{ width: 140 }} value={filters.minScore} onChange={(e) => set('minScore', e.target.value)} aria-label="Minimum score">
            <option value="">Any score</option>
            <option value="60">60+</option>
            <option value="70">70+</option>
            <option value="80">80+</option>
          </select>
          <select style={{ width: 150 }} value={filters.sort} onChange={(e) => set('sort', e.target.value)} aria-label="Sort">
            <option value="score">Best match</option>
            <option value="newest">Newest found</option>
            <option value="posted">Recently posted</option>
          </select>
          <input style={{ maxWidth: 240 }} placeholder="Search title, company, city" defaultValue={filters.q} onKeyDown={(e) => e.key === 'Enter' && set('q', (e.target as HTMLInputElement).value)} />
          <label className="check small">
            <input type="checkbox" checked={filters.eligibleOnly} onChange={(e) => set('eligibleOnly', e.target.checked ? '1' : '')} /> Eligible only
          </label>
          <label className="check small">
            <input type="checkbox" checked={filters.includeClosed} onChange={(e) => set('includeClosed', e.target.checked ? '1' : '')} /> Show closed
          </label>
        </div>
      </div>

      <div className="card">
        {q.isLoading ? (
          <Loading />
        ) : !q.data || q.data.items.length === 0 ? (
          <Empty title="No jobs match these filters">Click “Run now” to search your sources, add companies in Settings → Sources, or add a job manually.</Empty>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Score</th>
                  <th>Role</th>
                  <th>Location</th>
                  <th>Track</th>
                  <th>Status</th>
                  <th>Found</th>
                </tr>
              </thead>
              <tbody>
                {q.data.items.map((j) => (
                  <tr key={j.id} className="clickable" onClick={() => nav(`/jobs/${j.id}`)}>
                    <td>
                      <ScoreBadge score={j.score} eligible={j.eligible} />
                    </td>
                    <td style={{ minWidth: 240 }}>
                      <div className="strong">{j.title}</div>
                      <div className="small muted">
                        {j.company} · via {j.source}
                        {j.hasTailoredResume && ' · resume ready'}
                      </div>
                    </td>
                    <td className="small">
                      {j.location ?? '—'}
                      <div className="faint">{j.workMode !== 'unknown' ? j.workMode : ''}</div>
                    </td>
                    <td>
                      <TrackChips tracks={j.tracks} />
                    </td>
                    <td>
                      <StatusBadge status={j.status} />
                      {j.statusReason && <div className="small faint" style={{ marginTop: 3, maxWidth: 220 }}>{reasonLabel(j.statusReason)}</div>}
                    </td>
                    <td className="small muted">{timeAgo(j.discoveredAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {q.data && q.data.total > q.data.pageSize && (
          <div className="card-body row between">
            <span className="small muted">
              {q.data.total} jobs · page {q.data.page} of {Math.ceil(q.data.total / q.data.pageSize)}
            </span>
            <div className="row">
              <button className="btn btn-sm" disabled={filters.page <= 1} onClick={() => set('page', String(filters.page - 1))}>
                ← Prev
              </button>
              <button className="btn btn-sm" disabled={filters.page * q.data.pageSize >= q.data.total} onClick={() => set('page', String(filters.page + 1))}>
                Next →
              </button>
            </div>
          </div>
        )}
      </div>
      {adding && <AddJobModal onClose={() => setAdding(false)} onCreated={(id) => { toast('Job added and scored.'); nav(`/jobs/${id}`); }} />}
    </div>
  );
}

function AddJobModal({ onClose, onCreated }: { onClose: () => void; onCreated: (id: number) => void }) {
  const toast = useToast();
  const [form, setForm] = useState({ title: '', company: '', location: '', url: '', description: '' });
  const m = useMutation({
    mutationFn: () => api.post<{ id: number }>('/api/jobs/manual', form),
    onSuccess: (r) => onCreated(r.id),
    onError: (e: Error) => toast(e.message, true),
  });
  const up = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });
  return (
    <Modal title="Add a job (e.g. from LinkedIn or Naukri)" onClose={onClose}>
      <div className="stack">
        <p className="small muted">Paste a posting you found yourself. It gets scored and a tailored resume can be generated; you submit it on the site.</p>
        <div className="grid grid-2">
          <label className="field">
            Title
            <input value={form.title} onChange={up('title')} />
          </label>
          <label className="field">
            Company
            <input value={form.company} onChange={up('company')} />
          </label>
          <label className="field">
            Location
            <input value={form.location} onChange={up('location')} placeholder="Bengaluru / Remote (India)" />
          </label>
          <label className="field">
            Posting URL
            <input value={form.url} onChange={up('url')} />
          </label>
        </div>
        <label className="field">
          Full job description
          <textarea rows={8} value={form.description} onChange={up('description')} />
        </label>
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={m.isPending || !form.title || !form.company || form.description.length < 30} onClick={() => m.mutate()}>
            Add & score
          </button>
        </div>
      </div>
    </Modal>
  );
}
