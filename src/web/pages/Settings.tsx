import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import type { AllSettings, EmploymentType, Track, WorkMode } from '../../shared/types';
import { api, type SettingsResponse, type SourceRow, type SourceType } from '../api';
import { Loading, Modal, TagInput, timeAgo, Toggle, useToast } from '../components';

type Section = keyof AllSettings;

function useSettings() {
  return useQuery({ queryKey: ['settings'], queryFn: () => api.get<SettingsResponse>('/api/settings') });
}

function useSaveSection<S extends Section>(section: S) {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: (value: AllSettings[S]) => api.put<AllSettings[S]>(`/api/settings/${section}`, value),
    onSuccess: () => {
      toast('Settings saved');
      void qc.invalidateQueries();
    },
    onError: (e: Error) => toast(e.message, true),
  });
}

export function SettingsPage() {
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') ?? 'search';
  const s = useSettings();
  const tabs: Array<[string, string]> = [
    ['search', 'Search preferences'],
    ['sources', 'Job sources'],
    ['automation', 'Automation'],
    ['notifications', 'Notifications & schedule'],
    ['data', 'Data & privacy'],
  ];
  return (
    <div className="stack" style={{ gap: 16 }}>
      <div className="page-head">
        <div>
          <h1>Settings</h1>
          <p>Search preferences, sources, automatic-mode rules, notifications and your data.</p>
        </div>
      </div>
      <div className="tabs" role="tablist">
        {tabs.map(([k, l]) => (
          <button key={k} role="tab" aria-selected={tab === k} className={`tab${tab === k ? ' active' : ''}`} onClick={() => setParams({ tab: k })}>
            {l}
          </button>
        ))}
      </div>
      {!s.data ? (
        <Loading />
      ) : tab === 'search' ? (
        <SearchTab settings={s.data} />
      ) : tab === 'sources' ? (
        <SourcesTab settings={s.data} />
      ) : tab === 'automation' ? (
        <AutomationTab settings={s.data} />
      ) : tab === 'notifications' ? (
        <NotificationsTab settings={s.data} />
      ) : (
        <DataTab />
      )}
    </div>
  );
}

function SaveBar({ dirty, saving, onSave, onReset }: { dirty: boolean; saving: boolean; onSave: () => void; onReset: () => void }) {
  return (
    <div className="row" style={{ justifyContent: 'flex-end' }}>
      <button className="btn" disabled={!dirty} onClick={onReset}>
        Reset
      </button>
      <button className="btn btn-primary" disabled={!dirty || saving} onClick={onSave}>
        Save
      </button>
    </div>
  );
}

function SearchTab({ settings }: { settings: SettingsResponse }) {
  const [p, setP] = useState(settings.preferences);
  useEffect(() => setP(settings.preferences), [settings.preferences]);
  const save = useSaveSection('preferences');
  const dirty = JSON.stringify(p) !== JSON.stringify(settings.preferences);
  const toggleIn = <T,>(arr: T[], v: T) => (arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v]);
  return (
    <div className="stack">
      <div className="grid grid-2">
        <div className="card">
          <div className="card-head">
            <h2>Frontend / React track</h2>
            <Toggle checked={p.tracks.frontend.enabled} label="Frontend track" onChange={(v) => setP({ ...p, tracks: { ...p.tracks, frontend: { ...p.tracks.frontend, enabled: v } } })} />
          </div>
          <div className="card-body">
            <label className="field">
              Target titles
              <TagInput value={p.tracks.frontend.titles} onChange={(titles) => setP({ ...p, tracks: { ...p.tracks, frontend: { ...p.tracks.frontend, titles } } })} />
            </label>
          </div>
        </div>
        <div className="card">
          <div className="card-head">
            <h2>AI / prompting track</h2>
            <Toggle checked={p.tracks.ai.enabled} label="AI track" onChange={(v) => setP({ ...p, tracks: { ...p.tracks, ai: { ...p.tracks.ai, enabled: v } } })} />
          </div>
          <div className="card-body stack-sm">
            <label className="field">
              Target titles
              <TagInput value={p.tracks.ai.titles} onChange={(titles) => setP({ ...p, tracks: { ...p.tracks, ai: { ...p.tracks.ai, titles } } })} />
            </label>
            <span className="small muted">ML research / model-training roles are always flagged unless your verified profile shows ML experience.</span>
          </div>
        </div>
      </div>
      <div className="card">
        <div className="card-head">
          <h2>Location & work arrangement</h2>
        </div>
        <div className="card-body stack">
          <div className="grid grid-2">
            <label className="field">
              Preferred cities (on-site / hybrid)
              <TagInput value={p.locations} onChange={(locations) => setP({ ...p, locations })} placeholder="e.g. Bengaluru" />
            </label>
            <label className="field">
              Home country (ISO code)
              <input value={p.country} maxLength={2} onChange={(e) => setP({ ...p, country: e.target.value.toUpperCase() })} placeholder="IN" />
            </label>
            <label className="field">
              Remote regions that include you
              <TagInput value={p.remoteRegions} onChange={(remoteRegions) => setP({ ...p, remoteRegions })} />
            </label>
            <div className="field">
              Accepted work modes
              <div className="row">
                {(['remote', 'hybrid', 'onsite'] as WorkMode[]).map((m) => (
                  <label key={m} className="check">
                    <input type="checkbox" checked={p.workModes.includes(m)} onChange={() => setP({ ...p, workModes: toggleIn(p.workModes, m) })} /> {m}
                  </label>
                ))}
              </div>
              <label className="check" style={{ marginTop: 8 }}>
                <input type="checkbox" checked={p.relocation.willing} onChange={(e) => setP({ ...p, relocation: { ...p.relocation, willing: e.target.checked } })} /> Open to relocation
              </label>
            </div>
          </div>
        </div>
      </div>
      <div className="card">
        <div className="card-head">
          <h2>Level, type, salary & eligibility</h2>
        </div>
        <div className="card-body stack">
          <div className="grid grid-3">
            <label className="field">
              Experience level
              <select value={p.experienceLevel} onChange={(e) => setP({ ...p, experienceLevel: e.target.value as typeof p.experienceLevel })}>
                <option value="internship">Internship</option>
                <option value="entry">Entry / fresher</option>
                <option value="junior">Junior (0–3 yrs)</option>
                <option value="mid">Mid (3–5 yrs)</option>
                <option value="senior">Senior</option>
              </select>
            </label>
            <label className="field">
              Years of experience <span className="hint">Empty = computed from profile</span>
              <input type="number" min={0} step={0.5} value={p.yearsOfExperience ?? ''} onChange={(e) => setP({ ...p, yearsOfExperience: e.target.value === '' ? null : Number(e.target.value) })} />
            </label>
            <label className="field">
              Max job age (days)
              <input type="number" min={1} value={p.maxJobAgeDays} onChange={(e) => setP({ ...p, maxJobAgeDays: Number(e.target.value) || 30 })} />
            </label>
          </div>
          <div className="field">
            Employment types
            <div className="row">
              {(['full_time', 'contract', 'part_time', 'internship'] as EmploymentType[]).map((t) => (
                <label key={t} className="check">
                  <input type="checkbox" checked={p.employmentTypes.includes(t)} onChange={() => setP({ ...p, employmentTypes: toggleIn(p.employmentTypes, t) })} /> {t.replace('_', '-')}
                </label>
              ))}
            </div>
          </div>
          <div className="grid grid-3">
            <label className="field">
              Minimum salary <span className="hint">Filters only listed salaries</span>
              <input type="number" min={0} value={p.salary.minimum ?? ''} onChange={(e) => setP({ ...p, salary: { ...p.salary, minimum: e.target.value === '' ? null : Number(e.target.value) } })} />
            </label>
            <label className="field">
              Currency
              <input value={p.salary.currency} onChange={(e) => setP({ ...p, salary: { ...p.salary, currency: e.target.value.toUpperCase() } })} placeholder="INR" />
            </label>
            <label className="field">
              Period
              <select value={p.salary.period} onChange={(e) => setP({ ...p, salary: { ...p.salary, period: e.target.value as 'year' } })}>
                <option value="year">per year</option>
                <option value="month">per month</option>
                <option value="hour">per hour</option>
              </select>
            </label>
          </div>
          <div className="field">
            Work authorization (for eligibility matching only)
            <span className="hint">Application answers still come only from your Answer bank.</span>
            {p.workAuthorization.map((w, i) => (
              <div key={i} className="row">
                <input style={{ width: 80 }} value={w.country} maxLength={2} onChange={(e) => setP({ ...p, workAuthorization: p.workAuthorization.map((x, j) => (j === i ? { ...x, country: e.target.value.toUpperCase() } : x)) })} />
                <select style={{ width: 220 }} value={w.status} onChange={(e) => setP({ ...p, workAuthorization: p.workAuthorization.map((x, j) => (j === i ? { ...x, status: e.target.value as typeof w.status } : x)) })}>
                  <option value="authorized">Authorized</option>
                  <option value="needs_sponsorship">Needs sponsorship</option>
                  <option value="not_authorized">Not authorized</option>
                </select>
                <button className="btn btn-sm btn-ghost" onClick={() => setP({ ...p, workAuthorization: p.workAuthorization.filter((_, j) => j !== i) })}>
                  Remove
                </button>
              </div>
            ))}
            <div>
              <button className="btn btn-sm" onClick={() => setP({ ...p, workAuthorization: [...p.workAuthorization, { country: p.country || 'IN', status: 'authorized' }] })}>
                + Country
              </button>
            </div>
          </div>
          <div className="grid grid-2">
            <label className="field">
              Excluded companies
              <TagInput value={p.excludedCompanies} onChange={(excludedCompanies) => setP({ ...p, excludedCompanies })} />
            </label>
            <label className="field">
              Excluded keywords
              <TagInput value={p.excludedKeywords} onChange={(excludedKeywords) => setP({ ...p, excludedKeywords })} placeholder="e.g. unpaid, commission only" />
            </label>
          </div>
          <label className="field">
            Search keywords (aggregator sources)
            <TagInput value={p.keywords} onChange={(keywords) => setP({ ...p, keywords })} />
          </label>
        </div>
      </div>
      <SaveBar dirty={dirty} saving={save.isPending} onSave={() => save.mutate(p)} onReset={() => setP(settings.preferences)} />
    </div>
  );
}

function SourcesTab({ settings }: { settings: SettingsResponse }) {
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['sources'], queryFn: () => api.get<{ sources: SourceRow[]; types: SourceType[] }>('/api/sources') });
  const [url, setUrl] = useState('');
  const [name, setName] = useState('');
  const [testing, setTesting] = useState<number | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const inv = () => void qc.invalidateQueries({ queryKey: ['sources'] });
  const add = useMutation({
    mutationFn: () => api.post('/api/sources', { url, name: name || undefined }),
    onSuccess: () => {
      toast('Source added');
      setUrl('');
      setName('');
      inv();
    },
    onError: (e: Error) => toast(e.message, true),
  });
  const update = useMutation({ mutationFn: (s: { id: number; enabled: boolean }) => api.put(`/api/sources/${s.id}`, { enabled: s.enabled }), onSuccess: inv });
  const remove = useMutation({ mutationFn: (id: number) => api.del(`/api/sources/${id}`), onSuccess: inv });
  const test = async (id: number) => {
    setTesting(id);
    try {
      const r = await api.post<{ summary: { fetched: number; relevant: number; inserted: number; errors: Array<{ error: string }> } }>(`/api/sources/${id}/test`);
      if (r.summary.errors.length) toast(r.summary.errors[0].error, true);
      else toast(`Fetched ${r.summary.fetched} jobs, ${r.summary.relevant} relevant, ${r.summary.inserted} new.`);
      void qc.invalidateQueries();
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setTesting(null);
    }
  };
  if (!q.data) return <Loading />;
  const typeOf = (t: string) => q.data.types.find((x) => x.type === t);
  const integrationLabel = { official_api: 'Official API', public_api: 'Public API', api_key_required: 'API key' } as const;
  return (
    <div className="stack">
      <div className="card">
        <div className="card-head">
          <h2>Add a company careers page</h2>
          <button className="btn btn-sm" onClick={() => setImportOpen(true)}>
            Import jobs / past applications (JSON)
          </button>
        </div>
        <div className="card-body stack-sm">
          <div className="row">
            <input style={{ flex: 2, width: 'auto', minWidth: 240 }} value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://jobs.lever.co/company  ·  boards.greenhouse.io/company  ·  jobs.ashbyhq.com/company" />
            <input style={{ flex: 1, width: 'auto', minWidth: 140 }} value={name} onChange={(e) => setName(e.target.value)} placeholder="Company name (optional)" />
            <button className="btn btn-primary" disabled={!url || add.isPending} onClick={() => add.mutate()}>
              Add
            </button>
          </div>
          <span className="small muted">Supported: Greenhouse, Lever, Ashby and SmartRecruiters job boards (official public APIs). LinkedIn/Naukri do not offer APIs — add those jobs manually from the Jobs page.</span>
          {!settings.env.adzunaConfigured && <span className="small" style={{ color: 'var(--amber)' }}>Tip: set ADZUNA_APP_ID / ADZUNA_APP_KEY (free) to search Indian job boards by keyword and city.</span>}
        </div>
      </div>
      <div className="card">
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>On</th>
                <th>Source</th>
                <th>Integration</th>
                <th>Last run</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {q.data.sources.map((s) => {
                const t = typeOf(s.type);
                return (
                  <tr key={s.id}>
                    <td>
                      <Toggle checked={s.enabled} label={`Enable ${s.name}`} onChange={(v) => update.mutate({ id: s.id, enabled: v })} />
                    </td>
                    <td>
                      <div className="strong">{(s.config.companyName as string) ?? s.name}</div>
                      <div className="small muted">
                        {t?.label} · {s.name}
                      </div>
                      {t?.terms && <div className="small faint">{t.terms}</div>}
                    </td>
                    <td>
                      <span className="badge b-gray">{t ? integrationLabel[t.integration] : s.type}</span>
                    </td>
                    <td className="small">
                      {s.lastRunAt ? (
                        <>
                          <span className={`badge ${s.lastStatus === 'ok' ? 'b-green' : 'b-red'}`}>{s.lastStatus}</span> {timeAgo(s.lastRunAt)}
                          {s.lastStatus === 'ok' && <div className="faint">{s.lastCount} listed</div>}
                          {s.lastError && <div style={{ color: 'var(--red)', maxWidth: 320 }}>{s.lastError}</div>}
                        </>
                      ) : (
                        <span className="faint">never</span>
                      )}
                    </td>
                    <td>
                      <div className="row" style={{ justifyContent: 'flex-end' }}>
                        <button className="btn btn-sm" disabled={testing === s.id} onClick={() => test(s.id)}>
                          {testing === s.id ? 'Running…' : 'Run now'}
                        </button>
                        <button className="btn btn-sm btn-ghost" onClick={() => remove.mutate(s.id)}>
                          Remove
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
      {importOpen && <ImportModal onClose={() => setImportOpen(false)} />}
    </div>
  );
}

function ImportModal({ onClose }: { onClose: () => void }) {
  const toast = useToast();
  const qc = useQueryClient();
  const [kind, setKind] = useState<'jobs' | 'prior'>('jobs');
  const [text, setText] = useState('');
  const m = useMutation({
    mutationFn: async (): Promise<string> => {
      const parsed = JSON.parse(text) as unknown;
      const items = Array.isArray(parsed) ? parsed : ((parsed as { jobs?: unknown[]; items?: unknown[] }).jobs ?? (parsed as { items?: unknown[] }).items ?? []);
      if (kind === 'jobs') {
        const r = await api.post<{ inserted: number; merged: number; errors: string[] }>('/api/jobs/import', { jobs: items });
        return `Imported: ${r.inserted} new, ${r.merged} merged${r.errors.length ? `, ${r.errors.length} invalid` : ''}`;
      }
      const r = await api.post<{ added: number }>('/api/prior-applications', { items });
      return `Added ${r.added} past applications (used for duplicate checks)`;
    },
    onSuccess: (msg) => {
      toast(msg);
      void qc.invalidateQueries();
      onClose();
    },
    onError: (e: Error) => toast(e.message, true),
  });
  return (
    <Modal title="Import" onClose={onClose}>
      <div className="stack">
        <div className="seg">
          <button className={kind === 'jobs' ? 'active' : ''} onClick={() => setKind('jobs')}>
            Jobs
          </button>
          <button className={kind === 'prior' ? 'active' : ''} onClick={() => setKind('prior')}>
            Past applications
          </button>
        </div>
        <span className="small muted">
          {kind === 'jobs' ? 'JSON array of {title, company, location, url, description, postedAt, source}.' : 'JSON array of {company, title, appliedAt, url} — the system will never re-apply to these.'}
        </span>
        <textarea rows={10} className="mono" value={text} onChange={(e) => setText(e.target.value)} placeholder='[{"company":"Acme","title":"Frontend Engineer","appliedAt":"2026-10-01"}]' />
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button className="btn btn-primary" disabled={!text.trim() || m.isPending} onClick={() => m.mutate()}>
            Import
          </button>
        </div>
      </div>
    </Modal>
  );
}

function AutomationTab({ settings }: { settings: SettingsResponse }) {
  const [a, setA] = useState(settings.automation);
  useEffect(() => setA(settings.automation), [settings.automation]);
  const save = useSaveSection('automation');
  const dirty = JSON.stringify(a) !== JSON.stringify(settings.automation);
  const [confirmLive, setConfirmLive] = useState(false);
  const goingLive = a.mode === 'auto' && !a.dryRun && (settings.automation.mode !== 'auto' || settings.automation.dryRun);
  return (
    <div className="stack">
      <div className="grid grid-2">
        <div className="card">
          <div className="card-head">
            <h2>Mode</h2>
          </div>
          <div className="card-body stack">
            <div className="seg">
              <button className={a.mode === 'review' ? 'active' : ''} onClick={() => setA({ ...a, mode: 'review' })}>
                Review before submit
              </button>
              <button className={a.mode === 'auto' ? 'active' : ''} onClick={() => setA({ ...a, mode: 'auto' })}>
                Automatic
              </button>
            </div>
            <p className="small muted">
              {a.mode === 'review'
                ? 'Matched jobs are prepared (tailored resume + answers). You approve each submission.'
                : 'Jobs that pass every rule below are submitted without asking: score ≥ threshold, no eligibility conflicts, verified profile, every required answer available, a supported form, and within the daily limit. Anything else waits for you.'}
            </p>
            <label className="check">
              <Toggle checked={a.dryRun} label="Dry run" onChange={(v) => setA({ ...a, dryRun: v })} />
              <span>
                <b>Dry run</b> — fill forms and save screenshots, never submit
              </span>
            </label>
            <label className="check">
              <Toggle danger checked={a.paused} label="Pause" onChange={(v) => setA({ ...a, paused: v })} />
              <span>
                <b>Paused</b> — nothing is filled or submitted
              </span>
            </label>
          </div>
        </div>
        <div className="card">
          <div className="card-head">
            <h2>Rules</h2>
          </div>
          <div className="card-body stack">
            <div className="grid grid-2">
              <label className="field">
                Match threshold (0–100)
                <input type="number" min={0} max={100} value={a.matchThreshold} onChange={(e) => setA({ ...a, matchThreshold: Number(e.target.value) })} />
              </label>
              <label className="field">
                Daily application limit
                <input type="number" min={0} max={100} value={a.dailyLimit} onChange={(e) => setA({ ...a, dailyLimit: Number(e.target.value) })} />
              </label>
              <label className="field">
                Max per run
                <input type="number" min={0} max={50} value={a.maxPerRun} onChange={(e) => setA({ ...a, maxPerRun: Number(e.target.value) })} />
              </label>
              <label className="field">
                Delay between applications (s)
                <input type="number" min={5} value={a.delayBetweenApplicationsSec} onChange={(e) => setA({ ...a, delayBetweenApplicationsSec: Number(e.target.value) })} />
              </label>
            </div>
            <div className="field">
              Tracks allowed for automatic submission
              <div className="row">
                {(['frontend', 'ai'] as Track[]).map((t) => (
                  <label key={t} className="check">
                    <input type="checkbox" checked={a.autoTracks.includes(t)} onChange={() => setA({ ...a, autoTracks: a.autoTracks.includes(t) ? a.autoTracks.filter((x) => x !== t) : [...a.autoTracks, t] })} />
                    {t === 'frontend' ? 'Frontend / React' : 'AI / Prompting'}
                  </label>
                ))}
              </div>
            </div>
            <label className="field">
              CAPTCHA policy
              <select value={a.captchaPolicy} onChange={(e) => setA({ ...a, captchaPolicy: e.target.value as typeof a.captchaPolicy })}>
                <option value="pause_if_challenged">Stop when a CAPTCHA challenge is shown (default)</option>
                <option value="pause_if_present">Stop whenever a CAPTCHA widget is present (stricter)</option>
              </select>
              <span className="hint">CAPTCHAs are never solved or bypassed. The application waits for you.</span>
            </label>
            <div className="grid grid-2">
              <label className="field">
                Cover letters
                <select value={a.coverLetters} onChange={(e) => setA({ ...a, coverLetters: e.target.value as typeof a.coverLetters })}>
                  <option value="when_required">Attach only when required</option>
                  <option value="always">Attach whenever a field exists</option>
                  <option value="never">Never attach</option>
                </select>
              </label>
              <label className="check" style={{ marginTop: 22 }}>
                <input type="checkbox" checked={a.autoTailor} onChange={(e) => setA({ ...a, autoTailor: e.target.checked })} /> Tailor resumes automatically for matches
              </label>
            </div>
          </div>
        </div>
      </div>
      <SaveBar dirty={dirty} saving={save.isPending} onSave={() => (goingLive ? setConfirmLive(true) : save.mutate(a))} onReset={() => setA(settings.automation)} />
      {confirmLive && (
        <Modal title="Enable live automatic submissions?" onClose={() => setConfirmLive(false)}>
          <div className="stack">
            <p>With automatic mode on and dry run off, eligible applications are submitted without asking you each time, up to {a.dailyLimit} per day.</p>
            <ul className="small">
              <li>Only jobs scoring ≥ {a.matchThreshold} with no eligibility conflicts.</li>
              <li>Only when every required answer comes from your verified profile or answer bank.</li>
              <li>CAPTCHAs, logins and uncertain confirmations always stop and notify you.</li>
            </ul>
            <div className="row" style={{ justifyContent: 'flex-end' }}>
              <button className="btn" onClick={() => setConfirmLive(false)}>
                Cancel
              </button>
              <button
                className="btn btn-primary"
                onClick={() => {
                  setConfirmLive(false);
                  save.mutate(a);
                }}
              >
                Enable
              </button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}

function NotificationsTab({ settings }: { settings: SettingsResponse }) {
  const toast = useToast();
  const [n, setN] = useState(settings.notifications);
  const [s, setS] = useState(settings.schedule);
  useEffect(() => setN(settings.notifications), [settings.notifications]);
  useEffect(() => setS(settings.schedule), [settings.schedule]);
  const saveN = useSaveSection('notifications');
  const saveS = useSaveSection('schedule');
  const test = useMutation({
    mutationFn: () => api.post<{ delivered: string[]; errors: string[] }>('/api/notifications/test'),
    onSuccess: (r) => toast(r.errors.length ? `Errors: ${r.errors.join('; ')}` : r.delivered.length ? `Sent via ${r.delivered.join(', ')}` : 'No channel is enabled', r.errors.length > 0),
  });
  const dirtyN = JSON.stringify(n) !== JSON.stringify(settings.notifications);
  const dirtyS = JSON.stringify(s) !== JSON.stringify(settings.schedule);
  return (
    <div className="grid grid-2">
      <div className="card">
        <div className="card-head">
          <h2>Notification channels</h2>
          <button className="btn btn-sm" onClick={() => test.mutate()}>
            Send test
          </button>
        </div>
        <div className="card-body stack">
          <div className="stack-sm">
            <label className="check">
              <Toggle checked={n.email.enabled} label="Email" onChange={(v) => setN({ ...n, email: { ...n.email, enabled: v } })} /> <b>Email</b>
              {!settings.env.smtpEnabled && <span className="small" style={{ color: 'var(--amber)' }}>needs SMTP_* env vars</span>}
            </label>
            <input type="email" value={n.email.to} onChange={(e) => setN({ ...n, email: { ...n.email, to: e.target.value } })} placeholder="Recipient (default: your profile email)" />
          </div>
          <div className="stack-sm">
            <label className="check">
              <Toggle checked={n.ntfy.enabled} label="ntfy" onChange={(v) => setN({ ...n, ntfy: { ...n.ntfy, enabled: v } })} /> <b>Phone push (ntfy)</b>
            </label>
            <div className="row">
              <input style={{ flex: 1, width: 'auto' }} value={n.ntfy.server} onChange={(e) => setN({ ...n, ntfy: { ...n.ntfy, server: e.target.value } })} />
              <input style={{ flex: 1, width: 'auto' }} value={n.ntfy.topic} onChange={(e) => setN({ ...n, ntfy: { ...n.ntfy, topic: e.target.value } })} placeholder="long-random-topic-name" />
            </div>
            <span className="small faint">Install the ntfy app and subscribe to the same topic. Use a long, unguessable topic name.</span>
          </div>
          <div className="stack-sm">
            <label className="check">
              <Toggle checked={n.telegram.enabled} label="Telegram" onChange={(v) => setN({ ...n, telegram: { ...n.telegram, enabled: v } })} /> <b>Telegram</b>
              {!settings.env.telegramConfigured && <span className="small" style={{ color: 'var(--amber)' }}>needs TELEGRAM_BOT_TOKEN</span>}
            </label>
            <input value={n.telegram.chatId} onChange={(e) => setN({ ...n, telegram: { ...n.telegram, chatId: e.target.value } })} placeholder="Chat ID" />
          </div>
          <div className="stack-sm">
            <label className="check">
              <Toggle checked={n.webhook.enabled} label="Webhook" onChange={(v) => setN({ ...n, webhook: { ...n.webhook, enabled: v } })} /> <b>Slack / Discord webhook</b>
            </label>
            <input value={n.webhook.url} onChange={(e) => setN({ ...n, webhook: { ...n.webhook, url: e.target.value } })} placeholder="https://hooks.slack.com/…" />
          </div>
          <div className="divider" />
          <h3>Notify me about</h3>
          <div className="row">
            {(Object.keys(n.events) as Array<keyof typeof n.events>).map((k) => (
              <label key={k} className="check">
                <input type="checkbox" checked={n.events[k]} onChange={(e) => setN({ ...n, events: { ...n.events, [k]: e.target.checked } })} /> {k.replace(/([A-Z])/g, ' $1').toLowerCase()}
              </label>
            ))}
          </div>
          <SaveBar dirty={dirtyN} saving={saveN.isPending} onSave={() => saveN.mutate(n)} onReset={() => setN(settings.notifications)} />
        </div>
      </div>
      <div className="card">
        <div className="card-head">
          <h2>Schedule</h2>
        </div>
        <div className="card-body stack">
          <label className="check">
            <Toggle checked={s.enabled} label="Scheduler" onChange={(v) => setS({ ...s, enabled: v })} /> Run on a schedule (server-side, keeps running when this page is closed)
          </label>
          <div className="grid grid-2">
            <label className="field">
              Search every (hours)
              <input type="number" min={1} max={168} value={s.discoveryEveryHours} onChange={(e) => setS({ ...s, discoveryEveryHours: Number(e.target.value) })} />
            </label>
            <label className="field">
              Daily digest at
              <input type="time" value={s.digestTime} onChange={(e) => setS({ ...s, digestTime: e.target.value })} />
            </label>
          </div>
          <label className="field">
            Timezone
            <input value={s.timezone} onChange={(e) => setS({ ...s, timezone: e.target.value })} placeholder="Asia/Kolkata" />
          </label>
          <SaveBar dirty={dirtyS} saving={saveS.isPending} onSave={() => saveS.mutate(s)} onReset={() => setS(settings.schedule)} />
          {!settings.env.publicUrl && <span className="small faint">Set PUBLIC_URL so notifications link straight to the job.</span>}
        </div>
      </div>
    </div>
  );
}

function DataTab() {
  const toast = useToast();
  const [confirm, setConfirm] = useState('');
  const del = useMutation({
    mutationFn: () => api.del('/api/data', { confirm }),
    onSuccess: () => {
      toast('All your data has been deleted.');
      setTimeout(() => window.location.assign('/'), 1200);
    },
    onError: (e: Error) => toast(e.message, true),
  });
  return (
    <div className="grid grid-2">
      <div className="card">
        <div className="card-head">
          <h2>Export</h2>
        </div>
        <div className="card-body stack">
          <p className="small muted">Download your profile, saved answers, settings, jobs and application history as JSON.</p>
          <a className="btn" href="/api/data/export" style={{ alignSelf: 'flex-start' }}>
            Download export
          </a>
          <div className="divider" />
          <h3>How your data is protected</h3>
          <ul className="small muted" style={{ margin: 0, paddingLeft: 18 }}>
            <li>Resumes, profile, answers and screenshots are encrypted (AES-256-GCM) with your DATA_ENCRYPTION_KEY.</li>
            <li>Secrets live only in server environment variables, never in the database or code.</li>
            <li>Logs redact emails, phone numbers and tokens.</li>
            <li>The dashboard requires your password; sessions are httpOnly cookies.</li>
          </ul>
        </div>
      </div>
      <div className="card" style={{ borderColor: 'var(--red)' }}>
        <div className="card-head">
          <h2 style={{ color: 'var(--red)' }}>Delete all my data</h2>
        </div>
        <div className="card-body stack">
          <p className="small">Permanently deletes your resumes, profile, answers, jobs, applications, evidence, notifications, sources and settings from this server. This cannot be undone.</p>
          <label className="field">
            Type <code>DELETE MY DATA</code> to confirm
            <input value={confirm} onChange={(e) => setConfirm(e.target.value)} />
          </label>
          <button className="btn btn-danger" disabled={confirm !== 'DELETE MY DATA' || del.isPending} onClick={() => del.mutate()}>
            Delete everything
          </button>
        </div>
      </div>
    </div>
  );
}
