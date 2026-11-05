import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import { ANSWER_CATEGORIES, ANSWER_CATEGORY_LABELS, type AnswerCategory, type ResolvedAnswer } from '../../shared/types';
import { api, fileUrl, type JobDetail } from '../api';
import { fmtDate, Loading, Modal, reasonLabel, ScoreBadge, StatusBadge, TrackChips, useToast } from '../components';

export function JobDetailPage() {
  const { id } = useParams();
  const qc = useQueryClient();
  const toast = useToast();
  const key = ['job', id];
  const q = useQuery({
    queryKey: key,
    queryFn: () => api.get<JobDetail>(`/api/jobs/${id}`),
    refetchInterval: (query) => (query.state.data?.busy ? 2000 : 20_000),
  });
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: key });
    void qc.invalidateQueries({ queryKey: ['overview'] });
  };
  const action = (path: string, body: unknown, ok: string) =>
    api
      .post<JobDetail | { started: boolean }>(`/api/jobs/${id}/${path}`, body)
      .then((r) => {
        toast(ok);
        if ('job' in r) qc.setQueryData(key, r);
        refresh();
      })
      .catch((e: Error) => toast(e.message, true));
  const [busyLocal, setBusyLocal] = useState<string | null>(null);
  const run = async (label: string, fn: () => Promise<unknown>) => {
    setBusyLocal(label);
    try {
      await fn();
    } finally {
      setBusyLocal(null);
    }
  };
  const [markOpen, setMarkOpen] = useState(false);
  const [confirmSubmit, setConfirmSubmit] = useState(false);

  if (q.isLoading || !q.data) return <Loading />;
  const { job, match, application: app, resume } = q.data;
  const busy = q.data.busy ?? busyLocal;
  const canAutomate = app?.supportsAutoSubmit ?? (job.ats === 'greenhouse' || job.ats === 'lever');
  const submitted = app?.state === 'submitted';

  return (
    <div className="stack" style={{ gap: 16 }}>
      <div className="page-head">
        <div style={{ minWidth: 0 }}>
          <div className="small muted">
            <Link to="/jobs">← Jobs</Link>
          </div>
          <h1 style={{ marginTop: 6 }}>{job.title}</h1>
          <div className="row muted" style={{ marginTop: 6 }}>
            <span className="strong" style={{ color: 'var(--text)' }}>
              {job.company}
            </span>
            <span>· {job.location ?? 'Location not listed'}</span>
            {job.workMode !== 'unknown' && <span className="badge b-gray">{job.workMode}</span>}
            <TrackChips tracks={job.tracks} />
            <StatusBadge status={job.status} />
            <ScoreBadge score={job.score} eligible={job.eligible} />
          </div>
        </div>
        <div className="row">
          {job.applyUrl && (
            <a className="btn" href={job.applyUrl} target="_blank" rel="noreferrer noopener">
              Open posting ↗
            </a>
          )}
          <button className="btn" disabled={Boolean(busy)} onClick={() => run('Tailoring', () => action('tailor', {}, 'Tailored resume generated'))}>
            {resume ? 'Regenerate resume' : 'Tailor resume'}
          </button>
          {!submitted && (
            <button className="btn" disabled={Boolean(busy)} onClick={() => run('Preparing', () => action('prepare', {}, 'Application prepared'))}>
              Prepare application
            </button>
          )}
        </div>
      </div>

      <NextStep detail={q.data} busy={busy} onAction={action} onMark={() => setMarkOpen(true)} onSubmit={() => setConfirmSubmit(true)} canAutomate={canAutomate} />

      <div className="split">
        <div className="stack">
          <FitCard detail={q.data} />
          {app && app.questions.length > 0 && <AnswersCard detail={q.data} onSaved={(d) => qc.setQueryData(key, d)} />}
          {app && (app.lastAttempt || app.evidenceFileId) && <EvidenceCard detail={q.data} />}
          <div className="card">
            <div className="card-head">
              <h2>Job description</h2>
              <span className="small faint">
                via {job.source}
                {job.sightings.length > 1 && ` (+${job.sightings.length - 1} other source${job.sightings.length > 2 ? 's' : ''})`} · posted {fmtDate(job.postedAt)} · found {fmtDate(job.discoveredAt)}
              </span>
            </div>
            <div className="card-body">
              {job.descriptionPartial && <div className="alert alert-info small" style={{ marginBottom: 10 }}>This source only provides a snippet. Open the posting for the full description.</div>}
              <pre className="description">{job.descriptionText || 'No description available.'}</pre>
            </div>
          </div>
        </div>
        <div className="stack">
          <ResumeCard detail={q.data} />
          {resume?.coverLetter && <CoverLetterCard detail={q.data} onSaved={(d) => qc.setQueryData(key, d)} />}
          <div className="card">
            <div className="card-head">
              <h2>Timeline</h2>
            </div>
            <div className="card-body timeline">
              {q.data.events.map((e) => (
                <div key={e.id} className="tl-item">
                  <span className="faint small">{fmtDate(e.created_at, true)}</span>
                  <span className="small">{e.message}</span>
                </div>
              ))}
            </div>
          </div>
          <div className="row">
            <button className="btn btn-sm" onClick={() => action('dismiss', { dismissed: !job.dismissed }, job.dismissed ? 'Restored' : 'Dismissed')}>
              {job.dismissed ? 'Restore job' : 'Dismiss job'}
            </button>
            <button className="btn btn-sm" onClick={() => action('close', { closed: job.isActive }, job.isActive ? 'Marked closed' : 'Reopened')}>
              {job.isActive ? 'Mark posting closed' : 'Reopen posting'}
            </button>
            <button className="btn btn-sm btn-ghost" onClick={() => action('rescore', {}, 'Re-scored')}>
              Re-score
            </button>
          </div>
        </div>
      </div>

      {markOpen && <MarkSubmittedModal jobId={job.id} onClose={() => setMarkOpen(false)} onDone={(d) => { qc.setQueryData(key, d); refresh(); setMarkOpen(false); toast('Marked as submitted with your evidence.'); }} />}
      {confirmSubmit && (
        <Modal title="Submit this application?" onClose={() => setConfirmSubmit(false)}>
          <div className="stack">
            <p>
              The system will open the {job.company} application form, fill it with your verified profile, tailored resume and saved answers, and submit it. If a CAPTCHA, login or anything unexpected appears, it stops and tells you.
            </p>
            {app?.reviewReason === 'possible_duplicate' && <div className="alert alert-warn">This looks like a role you already applied to. Submitting anyway will send a second application.</div>}
            <div className="row" style={{ justifyContent: 'flex-end' }}>
              <button className="btn" onClick={() => setConfirmSubmit(false)}>
                Cancel
              </button>
              <button
                className="btn btn-primary"
                onClick={() => {
                  setConfirmSubmit(false);
                  void action('approve', { allowDuplicate: app?.reviewReason === 'possible_duplicate' }, 'Submission started — this can take a minute.');
                }}
              >
                Approve & submit
              </button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}

function NextStep({
  detail,
  busy,
  onAction,
  onMark,
  onSubmit,
  canAutomate,
}: {
  detail: JobDetail;
  busy: string | null;
  onAction: (path: string, body: unknown, ok: string) => Promise<void>;
  onMark: () => void;
  onSubmit: () => void;
  canAutomate: boolean;
}) {
  const { job, application: app, resume } = detail;
  if (busy)
    return (
      <div className="alert alert-info">
        <span className="spinner" />
        <div>
          <strong>{busy}…</strong>This page updates automatically.
        </div>
      </div>
    );
  if (app?.state === 'submitted')
    return (
      <div className="alert alert-ok">
        <div>
          <strong>Submitted {fmtDate(app.submittedAt, true)} ({app.submittedVia === 'manual' ? 'by you' : app.submittedVia === 'auto' ? 'automatically' : 'after your approval'})</strong>
          Evidence: “{app.confirmationText}”{app.confirmationUrl && <> · {app.confirmationUrl}</>}
        </div>
      </div>
    );
  if (!job.isActive) return <div className="alert alert-warn"><div><strong>Posting closed</strong>{job.closedReason}</div></div>;
  if (app?.state === 'uncertain')
    return (
      <div className="alert alert-danger">
        <div className="stack-sm" style={{ flex: 1 }}>
          <strong>Submission uncertain: please verify</strong>
          <span>{app.lastError}</span>
          <span className="small">Check your email for a confirmation or the employer’s site. The system will not retry on its own.</span>
          <div className="row">
            <button className="btn btn-sm" onClick={() => onAction('verify', { submitted: true, note: 'Confirmed by me after checking' }, 'Marked as submitted')}>
              It was submitted
            </button>
            <button className="btn btn-sm" onClick={() => onAction('verify', { submitted: false, note: '' }, 'Marked as not submitted')}>
              It was NOT submitted
            </button>
          </div>
        </div>
      </div>
    );
  if (app?.state === 'needs_input')
    return (
      <div className="alert alert-warn">
        <div>
          <strong>Needs input: {app.resolution?.missing.length ?? 0} question(s)</strong>Answer them below. Sensitive answers (work authorization, sponsorship, salary, EEO) are never guessed.
        </div>
      </div>
    );
  const manual = app ? !app.supportsAutoSubmit : !canAutomate;
  if (!resume)
    return (
      <div className="alert alert-info">
        <div>
          <strong>{job.eligible ? 'Next: tailor your resume' : 'Not eligible as configured'}</strong>
          {job.eligible ? 'Generate a tailored, fact-checked resume for this job.' : detail.match?.conflicts.filter((c) => c.severity === 'hard').map((c) => c.message).join(' · ')}
        </div>
      </div>
    );
  return (
    <div className="alert alert-info">
      <div className="stack-sm" style={{ flex: 1 }}>
        <strong>{app?.reviewReason ? reasonLabel(app.reviewReason) : manual ? 'Ready: apply manually' : 'Ready to apply'}</strong>
        {app?.lastError && <span className="small">{app.lastError}</span>}
        {app?.nextAction && <span className="small muted">{app.nextAction}</span>}
        <div className="row">
          {!manual && (
            <>
              <button className="btn btn-sm" onClick={() => onAction('dry-run', {}, 'Dry run started — the form will be filled but not submitted.')}>
                Dry run (fill, don’t submit)
              </button>
              <button className="btn btn-sm btn-primary" onClick={onSubmit}>
                Approve & submit
              </button>
            </>
          )}
          {job.applyUrl && (
            <a className="btn btn-sm" href={job.applyUrl} target="_blank" rel="noreferrer noopener">
              Open application page ↗
            </a>
          )}
          <button className="btn btn-sm" onClick={onMark}>
            I submitted it manually…
          </button>
        </div>
      </div>
    </div>
  );
}

function FitCard({ detail }: { detail: JobDetail }) {
  const m = detail.match;
  if (!m) return <div className="card card-pad muted">Not scored yet. Upload and verify your profile to score jobs.</div>;
  const parts: Array<[string, number, number]> = [
    ['Skills', m.breakdown.skills, 40],
    ['Role / title', m.breakdown.title, 25],
    ['Experience level', m.breakdown.experience, 15],
    ['Location & work mode', m.breakdown.location, 15],
    ['Recency', m.breakdown.recency, 5],
  ];
  return (
    <div className="card">
      <div className="card-head">
        <h2>Fit: {m.score}/100</h2>
        <span className={`badge ${m.eligible ? 'b-green' : 'b-red'}`}>{m.eligible ? 'Eligible' : 'Not eligible as configured'}</span>
      </div>
      <div className="card-body stack">
        <p>{m.explanation}</p>
        <div className="grid grid-2">
          {parts.map(([label, v, max]) => (
            <div key={label} className="stack-sm">
              <div className="row between small">
                <span className="muted">{label}</span>
                <span className="strong">
                  {v}/{max}
                </span>
              </div>
              <div className="bar">
                <span style={{ width: `${(v / max) * 100}%` }} />
              </div>
            </div>
          ))}
        </div>
        {m.conflicts.length > 0 && (
          <div className="stack-sm">
            <h3>Eligibility</h3>
            {m.conflicts.map((c, i) => (
              <div key={i} className={`alert ${c.severity === 'hard' ? 'alert-danger' : 'alert-warn'} small`}>
                {c.severity === 'hard' ? '⛔' : '⚠️'} {c.message}
              </div>
            ))}
          </div>
        )}
        <div className="stack-sm">
          <h3>Skills you have that the posting mentions</h3>
          <div className="row" style={{ gap: 6 }}>
            {m.matchedSkills.length ? m.matchedSkills.map((s) => <span key={s} className="chip chip-ok">✓ {s}</span>) : <span className="muted small">None detected</span>}
          </div>
        </div>
        {(m.missingRequired.length > 0 || m.missingPreferred.length > 0) && (
          <div className="stack-sm">
            <h3>Missing from your verified profile (not added to your resume)</h3>
            <div className="row" style={{ gap: 6 }}>
              {m.missingRequired.map((s) => (
                <span key={s} className="chip chip-miss">
                  required: {s}
                </span>
              ))}
              {m.missingPreferred.map((s) => (
                <span key={s} className="chip">
                  nice to have: {s}
                </span>
              ))}
            </div>
          </div>
        )}
        {m.highlights.length > 0 && (
          <ul className="small muted" style={{ margin: 0, paddingLeft: 18 }}>
            {m.highlights.map((h) => (
              <li key={h}>{h}</li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function answerText(a: ResolvedAnswer): string {
  if (a.value === null) return '—';
  if (a.value === '__RESUME_TEXT__') return 'Tailored resume (text)';
  if (a.value === '__COVER_LETTER_TEXT__') return 'Cover letter (text)';
  const v = Array.isArray(a.value) ? a.value.join(', ') : a.value;
  return a.sensitive && a.source === 'saved_answer' ? `${v} (from answer bank)` : v;
}

function AnswersCard({ detail, onSaved }: { detail: JobDetail; onSaved: (d: JobDetail) => void }) {
  const toast = useToast();
  const app = detail.application!;
  const missing = app.resolution?.missing ?? [];
  const [values, setValues] = useState<Record<string, string>>({});
  const [bank, setBank] = useState<Record<string, AnswerCategory | ''>>({});
  useEffect(() => {
    const init: Record<string, AnswerCategory | ''> = {};
    for (const m of missing) init[m.questionId] = m.category !== 'unknown' && (ANSWER_CATEGORIES as readonly string[]).includes(m.category) ? (m.category as AnswerCategory) : '';
    setBank(init);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [app.id, missing.length]);
  const save = useMutation({
    mutationFn: () => {
      const saveToBank: Record<string, AnswerCategory> = {};
      for (const [k, v] of Object.entries(bank)) if (v && values[k]) saveToBank[k] = v;
      return api.put<JobDetail>(`/api/jobs/${detail.job.id}/answers`, { answers: values, saveToBank });
    },
    onSuccess: (d) => {
      onSaved(d);
      setValues({});
      toast('Answers saved');
    },
    onError: (e: Error) => toast(e.message, true),
  });
  return (
    <div className="card">
      <div className="card-head">
        <h2>Application questions ({app.adapterLabel})</h2>
        <span className="small muted">{app.questions.length} fields</span>
      </div>
      {missing.length > 0 && (
        <div className="card-body stack" style={{ borderBottom: '1px solid var(--border)' }}>
          <h3>Needs your answer</h3>
          {missing.map((m) => {
            const q = app.questions.find((x) => x.id === m.questionId);
            return (
              <div key={m.questionId} className="stack-sm">
                <label className="field">
                  {m.label} {m.sensitive && <span className="badge b-amber">sensitive</span>}
                  {m.note && <span className="hint">{m.note}</span>}
                  {q?.options?.length ? (
                    <select value={values[m.questionId] ?? ''} onChange={(e) => setValues({ ...values, [m.questionId]: e.target.value })}>
                      <option value="">Select…</option>
                      {q.options.map((o) => (
                        <option key={o.value} value={o.label}>
                          {o.label}
                        </option>
                      ))}
                    </select>
                  ) : q?.type === 'textarea' || (q?.type === 'text' && m.category === 'unknown') ? (
                    <textarea rows={3} value={values[m.questionId] ?? ''} onChange={(e) => setValues({ ...values, [m.questionId]: e.target.value })} />
                  ) : (
                    <input value={values[m.questionId] ?? ''} onChange={(e) => setValues({ ...values, [m.questionId]: e.target.value })} />
                  )}
                </label>
                <label className="check small muted">
                  <input type="checkbox" checked={Boolean(bank[m.questionId])} onChange={(e) => setBank({ ...bank, [m.questionId]: e.target.checked ? (m.category !== 'unknown' ? (m.category as AnswerCategory) : 'custom') : '' })} />
                  Save to answer bank for future applications
                  {bank[m.questionId] && (
                    <select style={{ width: 200 }} value={bank[m.questionId]} onChange={(e) => setBank({ ...bank, [m.questionId]: e.target.value as AnswerCategory })}>
                      {ANSWER_CATEGORIES.map((c) => (
                        <option key={c} value={c}>
                          {ANSWER_CATEGORY_LABELS[c]}
                        </option>
                      ))}
                    </select>
                  )}
                </label>
              </div>
            );
          })}
          <div>
            <button className="btn btn-primary" disabled={save.isPending || Object.values(values).every((v) => !v)} onClick={() => save.mutate()}>
              Save answers
            </button>
          </div>
        </div>
      )}
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Question</th>
              <th>Answer</th>
              <th>Source</th>
            </tr>
          </thead>
          <tbody>
            {(app.resolution?.answers ?? []).map((a) => (
              <tr key={a.questionId}>
                <td className="small">
                  {a.label}
                  {a.required && <span className="faint"> *</span>}
                </td>
                <td className="small">{answerText(a)}</td>
                <td className="small muted">{a.source ?? (a.required ? 'missing' : 'left blank')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function EvidenceCard({ detail }: { detail: JobDetail }) {
  const app = detail.application!;
  const shot = app.state === 'submitted' && app.evidenceFileId ? app.evidenceFileId : app.lastAttempt?.screenshotFileId;
  return (
    <div className="card">
      <div className="card-head">
        <h2>{app.state === 'submitted' ? 'Submission evidence' : 'Last attempt'}</h2>
        {app.lastAttempt && (
          <span className="small muted">
            {app.lastAttempt.dryRun ? 'dry run · ' : ''}
            {app.lastAttempt.outcome} · {fmtDate(app.lastAttempt.startedAt, true)}
          </span>
        )}
      </div>
      <div className="card-body stack">
        {app.lastAttempt?.detail && <p className="small">{app.lastAttempt.detail}</p>}
        {shot ? (
          <a href={fileUrl(shot)} target="_blank" rel="noreferrer">
            <img className="screenshot" src={fileUrl(shot)} alt="Screenshot of the application form" />
          </a>
        ) : (
          <span className="small muted">{app.state === 'submitted' ? 'Evidence note recorded (no file).' : 'No screenshot.'}</span>
        )}
        {app.history.length > 1 && (
          <details>
            <summary className="small">All attempts ({app.history.length})</summary>
            {app.history.map((h) => (
              <div key={h.id} className="small muted">
                {fmtDate(h.startedAt, true)} · {h.trigger}
                {h.dryRun ? ' (dry run)' : ''} · {h.outcome}: {h.detail}
              </div>
            ))}
          </details>
        )}
      </div>
    </div>
  );
}

function ResumeCard({ detail }: { detail: JobDetail }) {
  const r = detail.resume;
  const [showPreview, setShowPreview] = useState(true);
  if (!r) return <div className="card card-pad muted">No tailored resume yet.</div>;
  return (
    <div className="card">
      <div className="card-head">
        <h2>Tailored resume</h2>
        <div className="row">
          {r.files.pdf && (
            <a className="btn btn-sm" href={fileUrl(r.files.pdf, true)}>
              PDF
            </a>
          )}
          {r.files.docx && (
            <a className="btn btn-sm" href={fileUrl(r.files.docx, true)}>
              DOCX
            </a>
          )}
          {r.files.txt && (
            <a className="btn btn-sm" href={fileUrl(r.files.txt, true)}>
              TXT
            </a>
          )}
        </div>
      </div>
      <div className="card-body stack">
        <div className="row">
          <span className={`badge ${r.accuracy?.ok ? 'b-green' : 'b-red'}`}>{r.accuracy?.ok ? '✓ Fact-check passed' : '✗ Fact-check failed'}</span>
          <span className="badge b-gray">{r.summary?.method === 'llm_assisted' ? 'Reworded + verified' : 'Reordered, original wording'}</span>
          {r.stale && <span className="badge b-amber">Profile changed — regenerate</span>}
          <span className="small faint">{fmtDate(r.createdAt, true)}</span>
        </div>
        <div className="stack-sm">
          <h3>What changed</h3>
          <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>
            {r.summary?.changes.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
        </div>
        {r.accuracy && r.accuracy.issues.length > 0 && (
          <div className="stack-sm">
            <h3>Accuracy notes</h3>
            {r.accuracy.issues.map((i, n) => (
              <div key={n} className={`small ${i.severity === 'error' ? '' : 'muted'}`}>
                {i.severity === 'error' ? '✗' : '•'} {i.message}
              </div>
            ))}
          </div>
        )}
        {r.accuracy && r.accuracy.rejectedRewrites.length > 0 && (
          <details className="small">
            <summary>{r.accuracy.rejectedRewrites.length} AI rewrite(s) rejected by the fact-checker</summary>
            {r.accuracy.rejectedRewrites.map((x, n) => (
              <div key={n} className="muted" style={{ marginTop: 6 }}>
                “{x.proposed}” — {x.reasons.join('; ')}
              </div>
            ))}
          </details>
        )}
        {r.files.pdf && (
          <>
            <button className="btn btn-sm btn-ghost" onClick={() => setShowPreview(!showPreview)} style={{ alignSelf: 'flex-start' }}>
              {showPreview ? 'Hide preview' : 'Show preview'}
            </button>
            {showPreview && <iframe className="preview-frame" src={fileUrl(r.files.pdf)} title="Tailored resume preview" />}
          </>
        )}
      </div>
    </div>
  );
}

function CoverLetterCard({ detail, onSaved }: { detail: JobDetail; onSaved: (d: JobDetail) => void }) {
  const toast = useToast();
  const r = detail.resume!;
  const [text, setText] = useState(r.coverLetter ?? '');
  useEffect(() => setText(r.coverLetter ?? ''), [r.id, r.coverLetter]);
  const save = useMutation({
    mutationFn: () => api.put<JobDetail>(`/api/jobs/${detail.job.id}/cover-letter`, { text }),
    onSuccess: (d) => {
      onSaved(d);
      toast('Cover letter saved');
    },
    onError: (e: Error) => toast(e.message, true),
  });
  return (
    <div className="card">
      <div className="card-head">
        <h2>Cover letter</h2>
        <span className="row">
          <span className={`badge ${r.coverLetterRequired ? 'b-amber' : 'b-gray'}`}>{r.coverLetterRequired ? 'Required by posting' : 'Optional'}</span>
          {r.files.coverLetter && (
            <a className="btn btn-sm" href={fileUrl(r.files.coverLetter, true)}>
              PDF
            </a>
          )}
        </span>
      </div>
      <div className="card-body stack">
        <textarea rows={12} value={text} onChange={(e) => setText(e.target.value)} />
        <div className="row between">
          <span className="small faint">Drafted only from your verified profile. Edit freely.</span>
          <button className="btn btn-sm" disabled={save.isPending || text === r.coverLetter} onClick={() => save.mutate()}>
            Save
          </button>
        </div>
      </div>
    </div>
  );
}

function MarkSubmittedModal({ jobId, onClose, onDone }: { jobId: number; onClose: () => void; onDone: (d: JobDetail) => void }) {
  const toast = useToast();
  const [note, setNote] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const m = useMutation({
    mutationFn: () => {
      const fd = new FormData();
      fd.append('note', note);
      if (file) fd.append('evidence', file);
      return api.post<JobDetail>(`/api/jobs/${jobId}/mark-submitted`, fd);
    },
    onSuccess: onDone,
    onError: (e: Error) => toast(e.message, true),
  });
  return (
    <Modal title="Mark as submitted" onClose={onClose}>
      <div className="stack">
        <p className="small muted">Only mark it submitted once you have proof: a confirmation page, email or screenshot.</p>
        <label className="field">
          Confirmation evidence
          <input value={note} onChange={(e) => setNote(e.target.value)} placeholder='e.g. Email "Thanks for applying to Acme" on 5 Nov' />
        </label>
        <label className="field">
          Screenshot / PDF / .eml (optional)
          <input type="file" accept="image/*,application/pdf,.eml,text/plain" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        </label>
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={m.isPending || (!note.trim() && !file)} onClick={() => m.mutate()}>
            Mark submitted
          </button>
        </div>
      </div>
    </Modal>
  );
}
