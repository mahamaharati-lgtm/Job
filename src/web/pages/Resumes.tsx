import { useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { api, fileUrl, type ResumeRecord } from '../api';
import { Empty, fmtDate, Loading, useToast } from '../components';

export function ResumesPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const nav = useNavigate();
  const input = useRef<HTMLInputElement>(null);
  const [warnings, setWarnings] = useState<string[] | null>(null);
  const q = useQuery({ queryKey: ['resumes'], queryFn: () => api.get<ResumeRecord[]>('/api/resumes') });
  const upload = useMutation({
    mutationFn: (file: File) => {
      const fd = new FormData();
      fd.append('file', file);
      return api.post<{ warnings: string[]; method: string }>('/api/resumes/upload', fd);
    },
    onSuccess: (r) => {
      setWarnings(r.warnings);
      toast(`Profile extracted (${r.method === 'llm' ? 'AI-assisted, grounded in your text' : 'rule-based'}). Review and verify it.`);
      void qc.invalidateQueries();
    },
    onError: (e: Error) => toast(e.message, true),
  });
  const originals = (q.data ?? []).filter((r) => r.kind === 'original');
  const current = originals.find((r) => r.isCurrent);
  const tailored = (q.data ?? []).filter((r) => r.kind === 'tailored');
  return (
    <div className="stack" style={{ gap: 16 }}>
      <div className="page-head">
        <div>
          <h1>Resumes</h1>
          <p>Your original resume is kept unchanged. Each tailored version is linked to its job and fact-checked against your verified profile.</p>
        </div>
        <div>
          <input
            ref={input}
            type="file"
            accept=".pdf,.docx,.txt,.md,application/pdf"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) upload.mutate(f);
              e.target.value = '';
            }}
          />
          <button className="btn btn-primary" disabled={upload.isPending} onClick={() => input.current?.click()}>
            {upload.isPending ? 'Reading resume…' : current ? 'Upload new version' : 'Upload resume (PDF/DOCX)'}
          </button>
        </div>
      </div>

      {warnings && (
        <div className={`alert ${warnings.length ? 'alert-warn' : 'alert-ok'}`}>
          <div>
            <strong>{warnings.length ? 'Please review these points in your profile' : 'Everything was extracted cleanly'}</strong>
            {warnings.length > 0 && (
              <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
                {warnings.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            )}
            <div style={{ marginTop: 6 }}>
              <Link to="/profile">Review & verify profile →</Link>
            </div>
          </div>
        </div>
      )}

      <div className="card">
        <div className="card-head">
          <h2>Original resume</h2>
        </div>
        {q.isLoading ? (
          <Loading />
        ) : !current ? (
          <Empty title="No resume uploaded yet">Upload a text-based PDF, DOCX or TXT file.</Empty>
        ) : (
          <div className="card-body stack">
            <div className="row between">
              <span>
                Uploaded {fmtDate(current.createdAt, true)}
                {originals.length > 1 && <span className="faint"> · {originals.length - 1} older version(s) kept</span>}
              </span>
              {current.files.original && (
                <a className="btn btn-sm" href={fileUrl(current.files.original, true)}>
                  Download original
                </a>
              )}
            </div>
            {current.files.original && <iframe className="preview-frame" style={{ height: 560 }} src={fileUrl(current.files.original)} title="Original resume" />}
          </div>
        )}
      </div>

      <div className="card">
        <div className="card-head">
          <h2>Tailored versions ({tailored.length})</h2>
        </div>
        {tailored.length === 0 ? (
          <Empty title="No tailored resumes yet">They are generated automatically for matched jobs, or from a job’s page.</Empty>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Job</th>
                  <th>Created</th>
                  <th>Fact-check</th>
                  <th>Changes</th>
                  <th>Files</th>
                </tr>
              </thead>
              <tbody>
                {tailored.map((r) => (
                  <tr key={r.id}>
                    <td style={{ minWidth: 200 }}>
                      <a href={`/jobs/${r.jobId}`} onClick={(e) => { e.preventDefault(); nav(`/jobs/${r.jobId}`); }} className="strong">
                        {r.jobTitle}
                      </a>
                      <div className="small muted">{r.company}</div>
                    </td>
                    <td className="small">{fmtDate(r.createdAt, true)}</td>
                    <td>
                      <span className={`badge ${r.accuracy?.ok ? 'b-green' : 'b-red'}`}>{r.accuracy?.ok ? 'Passed' : 'Failed'}</span>
                      {r.stale && <div className="small" style={{ color: 'var(--amber)' }}>profile changed</div>}
                    </td>
                    <td className="small muted" style={{ maxWidth: 380 }}>
                      {r.summary?.changes[0]}
                      {r.summary && r.summary.gaps.length > 0 && <div className="faint">Gaps: {r.summary.gaps.slice(0, 5).join(', ')}</div>}
                    </td>
                    <td>
                      <div className="row" style={{ gap: 4 }}>
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
                        {r.files.coverLetter && (
                          <a className="btn btn-sm" href={fileUrl(r.files.coverLetter, true)}>
                            Cover letter
                          </a>
                        )}
                      </div>
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
