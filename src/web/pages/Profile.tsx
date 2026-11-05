import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { ANSWER_CATEGORIES, ANSWER_CATEGORY_LABELS, SENSITIVE_CATEGORIES, type AnswerCategory, type CandidateProfile, type ProfileRecord, type SavedAnswer } from '../../shared/types';
import { api } from '../api';
import { Empty, fmtDate, Loading, TagInput, useToast } from '../components';

const uid = () => Math.random().toString(36).slice(2, 10);

export function ProfilePage() {
  const [tab, setTab] = useState<'profile' | 'answers'>('profile');
  return (
    <div className="stack" style={{ gap: 16 }}>
      <div className="page-head">
        <div>
          <h1>Profile & answers</h1>
          <p>The single source of truth for every resume and application. Only facts here are ever used.</p>
        </div>
      </div>
      <div className="tabs" role="tablist">
        <button role="tab" aria-selected={tab === 'profile'} className={`tab${tab === 'profile' ? ' active' : ''}`} onClick={() => setTab('profile')}>
          Candidate profile
        </button>
        <button role="tab" aria-selected={tab === 'answers'} className={`tab${tab === 'answers' ? ' active' : ''}`} onClick={() => setTab('answers')}>
          Answer bank
        </button>
      </div>
      {tab === 'profile' ? <ProfileEditor /> : <AnswerBank />}
    </div>
  );
}

function ProfileEditor() {
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['profile'], queryFn: () => api.get<{ record: ProfileRecord | null; yearsOfExperience: number | null }>('/api/profile') });
  const [p, setP] = useState<CandidateProfile | null>(null);
  useEffect(() => {
    if (q.data?.record) setP(structuredClone(q.data.record.profile));
  }, [q.data?.record?.updatedAt]); // eslint-disable-line react-hooks/exhaustive-deps
  const save = useMutation({
    mutationFn: () => api.put<{ record: ProfileRecord }>('/api/profile', { profile: p }),
    onSuccess: () => {
      toast('Profile saved. Changes reset verification — verify again when you are happy.');
      void qc.invalidateQueries();
    },
    onError: (e: Error) => toast(e.message, true),
  });
  const verify = useMutation({
    mutationFn: () => api.post('/api/profile/verify'),
    onSuccess: () => {
      toast('Profile verified. Jobs have been re-scored.');
      void qc.invalidateQueries();
    },
    onError: (e: Error) => toast(e.message, true),
  });
  if (q.isLoading) return <Loading />;
  const rec = q.data?.record;
  if (!rec || !p)
    return (
      <div className="card">
        <Empty title="No profile yet">
          <Link to="/resumes">Upload your resume</Link> to extract one.
        </Empty>
      </div>
    );
  const dirty = JSON.stringify(p) !== JSON.stringify(rec.profile);
  const set = <K extends keyof CandidateProfile>(k: K, v: CandidateProfile[K]) => setP({ ...p, [k]: v });

  return (
    <div className="stack">
      <div className={`alert ${rec.verified && !dirty ? 'alert-ok' : 'alert-warn'}`}>
        <div style={{ flex: 1 }}>
          <strong>{rec.verified && !dirty ? `Verified ${fmtDate(rec.verifiedAt, true)}` : dirty ? 'Unsaved changes' : 'Not verified yet'}</strong>
          {rec.verified && !dirty
            ? `Extracted with the ${rec.extractionMethod} parser. About ${q.data?.yearsOfExperience ?? '?'} years of experience (incl. internships).`
            : 'Check every field against your real resume. Automatic submission and tailoring use only what is here.'}
          {rec.warnings.length > 0 && (
            <ul style={{ margin: '6px 0 0', paddingLeft: 18 }} className="small">
              {rec.warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          )}
        </div>
        <div className="row">
          <button className="btn" disabled={!dirty || save.isPending} onClick={() => save.mutate()}>
            Save changes
          </button>
          <button className="btn btn-primary" disabled={dirty || rec.verified || verify.isPending} onClick={() => verify.mutate()}>
            Verify profile
          </button>
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <h2>Contact & links</h2>
        </div>
        <div className="card-body stack">
          <div className="grid grid-2">
            {(['name', 'headline', 'email', 'phone', 'location'] as const).map((k) => (
              <label key={k} className="field">
                {k[0].toUpperCase() + k.slice(1)}
                <input value={p[k]} onChange={(e) => set(k, e.target.value)} />
              </label>
            ))}
          </div>
          <h3>Links</h3>
          {p.links.map((l, i) => (
            <div key={i} className="row">
              <input style={{ width: 160 }} value={l.label} onChange={(e) => set('links', p.links.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))} aria-label="Link label" />
              <input style={{ flex: 1, width: 'auto' }} value={l.url} onChange={(e) => set('links', p.links.map((x, j) => (j === i ? { ...x, url: e.target.value } : x)))} aria-label="URL" />
              <button className="btn btn-sm btn-danger" onClick={() => set('links', p.links.filter((_, j) => j !== i))}>
                Remove
              </button>
            </div>
          ))}
          <div>
            <button className="btn btn-sm" onClick={() => set('links', [...p.links, { label: 'LinkedIn', url: 'https://www.linkedin.com/in/' }])}>
              + Add link (e.g. LinkedIn)
            </button>
          </div>
          <label className="field">
            Professional summary
            <textarea rows={4} value={p.summary} onChange={(e) => set('summary', e.target.value)} />
          </label>
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <h2>Skills</h2>
          <button className="btn btn-sm" onClick={() => set('skillGroups', [...p.skillGroups, { name: 'Skills', skills: [] }])}>
            + Group
          </button>
        </div>
        <div className="card-body stack">
          <p className="small muted">Only list skills you genuinely have. Matching and tailoring never add skills that are not here.</p>
          {p.skillGroups.map((g, i) => (
            <div key={i} className="stack-sm">
              <div className="row">
                <input style={{ width: 240 }} value={g.name} onChange={(e) => set('skillGroups', p.skillGroups.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} aria-label="Group name" />
                <button className="btn btn-sm btn-ghost" onClick={() => set('skillGroups', p.skillGroups.filter((_, j) => j !== i))}>
                  Remove group
                </button>
              </div>
              <TagInput value={g.skills} onChange={(skills) => set('skillGroups', p.skillGroups.map((x, j) => (j === i ? { ...x, skills } : x)))} placeholder="Add a skill and press Enter" />
            </div>
          ))}
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <h2>Experience</h2>
          <button className="btn btn-sm" onClick={() => set('experience', [...p.experience, { id: uid(), title: '', company: '', startDate: '', endDate: null, bullets: [] }])}>
            + Role
          </button>
        </div>
        <div className="card-body stack">
          {p.experience.map((e, i) => {
            const upd = (patch: Partial<typeof e>) => set('experience', p.experience.map((x, j) => (j === i ? { ...x, ...patch } : x)));
            return (
              <div key={e.id} className="card card-pad stack-sm" style={{ boxShadow: 'none' }}>
                <div className="grid grid-2">
                  <label className="field">
                    Title
                    <input value={e.title} onChange={(ev) => upd({ title: ev.target.value })} />
                  </label>
                  <label className="field">
                    Employer
                    <input value={e.company} onChange={(ev) => upd({ company: ev.target.value })} />
                  </label>
                  <label className="field">
                    Start (YYYY-MM)
                    <input value={e.startDate} onChange={(ev) => upd({ startDate: ev.target.value })} placeholder="2025-07" />
                  </label>
                  <label className="field">
                    End (YYYY-MM, empty = Present)
                    <input value={e.endDate ?? ''} onChange={(ev) => upd({ endDate: ev.target.value || null })} placeholder="Present" />
                  </label>
                </div>
                <h3>Bullets {e.bullets.length === 0 && <span className="badge b-amber">none — add real responsibilities to improve matching</span>}</h3>
                {e.bullets.map((b, k) => (
                  <div key={b.id} className="row">
                    <textarea rows={2} style={{ flex: 1, minHeight: 50 }} value={b.text} onChange={(ev) => upd({ bullets: e.bullets.map((x, m) => (m === k ? { ...x, text: ev.target.value } : x)) })} />
                    <button className="btn btn-sm btn-ghost" onClick={() => upd({ bullets: e.bullets.filter((_, m) => m !== k) })} aria-label="Remove bullet">
                      ✕
                    </button>
                  </div>
                ))}
                <div className="row">
                  <button className="btn btn-sm" onClick={() => upd({ bullets: [...e.bullets, { id: uid(), text: '' }] })}>
                    + Bullet
                  </button>
                  <button className="btn btn-sm btn-danger" onClick={() => set('experience', p.experience.filter((_, j) => j !== i))}>
                    Remove role
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <h2>Projects</h2>
          <button className="btn btn-sm" onClick={() => set('projects', [...p.projects, { id: uid(), name: '', technologies: [], links: [], bullets: [] }])}>
            + Project
          </button>
        </div>
        <div className="card-body stack">
          {p.projects.map((pr, i) => {
            const upd = (patch: Partial<typeof pr>) => set('projects', p.projects.map((x, j) => (j === i ? { ...x, ...patch } : x)));
            return (
              <div key={pr.id} className="card card-pad stack-sm" style={{ boxShadow: 'none' }}>
                <div className="grid grid-2">
                  <label className="field">
                    Name
                    <input value={pr.name} onChange={(ev) => upd({ name: ev.target.value })} />
                  </label>
                  <label className="field">
                    Subtitle
                    <input value={pr.subtitle ?? ''} onChange={(ev) => upd({ subtitle: ev.target.value })} />
                  </label>
                </div>
                <label className="field">
                  Technologies
                  <TagInput value={pr.technologies} onChange={(technologies) => upd({ technologies })} />
                </label>
                {pr.bullets.map((b, k) => (
                  <div key={b.id} className="row">
                    <textarea rows={2} style={{ flex: 1, minHeight: 50 }} value={b.text} onChange={(ev) => upd({ bullets: pr.bullets.map((x, m) => (m === k ? { ...x, text: ev.target.value } : x)) })} />
                    <button className="btn btn-sm btn-ghost" onClick={() => upd({ bullets: pr.bullets.filter((_, m) => m !== k) })} aria-label="Remove bullet">
                      ✕
                    </button>
                  </div>
                ))}
                <div className="row">
                  <button className="btn btn-sm" onClick={() => upd({ bullets: [...pr.bullets, { id: uid(), text: '' }] })}>
                    + Bullet
                  </button>
                  <button className="btn btn-sm btn-danger" onClick={() => set('projects', p.projects.filter((_, j) => j !== i))}>
                    Remove project
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <h2>Education & certifications</h2>
        </div>
        <div className="card-body stack">
          {p.education.map((e, i) => {
            const upd = (patch: Partial<typeof e>) => set('education', p.education.map((x, j) => (j === i ? { ...x, ...patch } : x)));
            return (
              <div key={e.id} className="grid grid-2">
                <label className="field">
                  Degree
                  <input value={e.degree} onChange={(ev) => upd({ degree: ev.target.value })} />
                </label>
                <label className="field">
                  Institution
                  <input value={e.institution} onChange={(ev) => upd({ institution: ev.target.value })} />
                </label>
                <label className="field">
                  Dates
                  <input value={e.dates ?? ''} onChange={(ev) => upd({ dates: ev.target.value })} />
                </label>
                <label className="field">
                  Grade
                  <input value={e.grade ?? ''} onChange={(ev) => upd({ grade: ev.target.value })} />
                </label>
              </div>
            );
          })}
          <label className="field">
            Certifications
            <TagInput value={p.certifications.map((c) => c.name)} onChange={(names) => set('certifications', names.map((name) => p.certifications.find((c) => c.name === name) ?? { id: uid(), name }))} />
          </label>
        </div>
      </div>
      <div className="row" style={{ justifyContent: 'flex-end' }}>
        <button className="btn" disabled={!dirty} onClick={() => setP(structuredClone(rec.profile))}>
          Discard changes
        </button>
        <button className="btn btn-primary" disabled={!dirty || save.isPending} onClick={() => save.mutate()}>
          Save changes
        </button>
      </div>
    </div>
  );
}

const PRESETS: Array<{ category: AnswerCategory; hint: string; examples: string[] }> = [
  { category: 'work_authorization', hint: 'Per country. Used for “Are you authorized to work in …?”', examples: ['Yes', 'No'] },
  { category: 'sponsorship', hint: '“Will you now or in the future require sponsorship?”', examples: ['No', 'Yes'] },
  { category: 'salary_expectation', hint: 'Only used where a form asks. Leave empty to be asked each time.', examples: ['8 LPA', 'Negotiable'] },
  { category: 'current_compensation', hint: 'Current CTC, if you choose to share it', examples: [] },
  { category: 'notice_period', hint: '', examples: ['Immediate', '30 days', '60 days'] },
  { category: 'start_date', hint: '', examples: ['Within 30 days of offer'] },
  { category: 'relocation', hint: '', examples: ['Yes', 'No'] },
  { category: 'onsite_ok', hint: '', examples: ['Yes', 'No'] },
  { category: 'years_experience', hint: 'Your own number (the system will not compute it for forms)', examples: [] },
  { category: 'gender', hint: 'Voluntary. Choose “Decline to self-identify” if you prefer.', examples: ['Decline to self-identify'] },
  { category: 'race_ethnicity', hint: 'Voluntary (mostly US forms)', examples: ['Decline to self-identify'] },
  { category: 'veteran', hint: 'Voluntary (US forms)', examples: ['I am not a protected veteran', 'Decline to self-identify'] },
  { category: 'disability', hint: 'Voluntary (US forms)', examples: ['Decline to self-identify'] },
  { category: 'legal_consent', hint: 'Answer for required privacy/consent checkboxes. Leave empty to review each one.', examples: ['Yes, I agree'] },
];

function AnswerBank() {
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['answers'], queryFn: () => api.get<SavedAnswer[]>('/api/answers') });
  const [draft, setDraft] = useState<{ category: AnswerCategory; question: string; answer: string; country: string }>({ category: 'work_authorization', question: '', answer: '', country: '' });
  const save = useMutation({
    mutationFn: (a: Partial<SavedAnswer> & { category: AnswerCategory; answer: string }) => api.post<SavedAnswer>('/api/answers', a),
    onSuccess: () => {
      toast('Saved');
      setDraft({ ...draft, question: '', answer: '' });
      void qc.invalidateQueries({ queryKey: ['answers'] });
    },
    onError: (e: Error) => toast(e.message, true),
  });
  const del = useMutation({ mutationFn: (id: string) => api.del(`/api/answers/${id}`), onSuccess: () => void qc.invalidateQueries({ queryKey: ['answers'] }) });
  const preset = PRESETS.find((p) => p.category === draft.category);
  return (
    <div className="split">
      <div className="card">
        <div className="card-head">
          <h2>Saved answers</h2>
          <span className="small muted">encrypted at rest</span>
        </div>
        {q.isLoading ? (
          <Loading />
        ) : (q.data ?? []).length === 0 ? (
          <Empty title="No saved answers yet">Applications that ask sensitive questions will wait in “Needs input” until you answer them here or on the job.</Empty>
        ) : (
          (q.data ?? []).map((a) => (
            <div key={a.id} className="list-item">
              <div style={{ minWidth: 0 }}>
                <div className="strong">
                  {ANSWER_CATEGORY_LABELS[a.category]}
                  {a.country && <span className="badge b-gray" style={{ marginLeft: 6 }}>{a.country}</span>}
                  {SENSITIVE_CATEGORIES.includes(a.category) && <span className="badge b-amber" style={{ marginLeft: 6 }}>sensitive</span>}
                </div>
                {a.question && <div className="small muted">Q: {a.question}</div>}
                <div className="small">A: {a.answer}</div>
              </div>
              <button className="btn btn-sm btn-danger" onClick={() => del.mutate(a.id)}>
                Delete
              </button>
            </div>
          ))
        )}
      </div>
      <div className="card">
        <div className="card-head">
          <h2>Add an answer</h2>
        </div>
        <div className="card-body stack">
          <div className="alert alert-info small">
            <div>Work authorization, sponsorship, salary, notice period, legal declarations and demographic questions are <b>never guessed</b>. They are answered only from what you save here.</div>
          </div>
          <label className="field">
            Category
            <select value={draft.category} onChange={(e) => setDraft({ ...draft, category: e.target.value as AnswerCategory })}>
              {ANSWER_CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {ANSWER_CATEGORY_LABELS[c]}
                </option>
              ))}
            </select>
            {preset?.hint && <span className="hint">{preset.hint}</span>}
          </label>
          {(draft.category === 'work_authorization' || draft.category === 'sponsorship') && (
            <label className="field">
              Country (ISO code, e.g. IN, US) <span className="hint">Leave empty to apply to all countries</span>
              <input value={draft.country} maxLength={2} onChange={(e) => setDraft({ ...draft, country: e.target.value.toUpperCase() })} />
            </label>
          )}
          {draft.category === 'custom' && (
            <label className="field">
              Question
              <input value={draft.question} onChange={(e) => setDraft({ ...draft, question: e.target.value })} placeholder="Why do you want to work here?" />
            </label>
          )}
          <label className="field">
            Answer
            <textarea rows={3} value={draft.answer} onChange={(e) => setDraft({ ...draft, answer: e.target.value })} />
          </label>
          {preset && preset.examples.length > 0 && (
            <div className="row">
              {preset.examples.map((ex) => (
                <button key={ex} className="btn btn-sm" onClick={() => setDraft({ ...draft, answer: ex })}>
                  {ex}
                </button>
              ))}
            </div>
          )}
          <button className="btn btn-primary" disabled={!draft.answer.trim() || save.isPending} onClick={() => save.mutate({ category: draft.category, question: draft.question, answer: draft.answer, country: draft.country || undefined })}>
            Save answer
          </button>
        </div>
      </div>
    </div>
  );
}
