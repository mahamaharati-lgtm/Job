import type { AccuracyReport, CandidateProfile, TailoredResume, TailoringSummary } from '../shared/types.js';
import { decryptJson, decryptString, encryptJson, encryptString } from './crypto.js';
import { all, get, nowIso, parseJson, run, tx } from './db.js';
import { addEvent, getJob, jobMatch, recomputeStatus } from './jobs.js';
import { extractProfileWithLlm, llmAvailable } from './llm.js';
import { extractResumeText } from './profile/extract.js';
import { ensureIds, parseResumeText, profileProblems } from './profile/parse.js';
import { getProfileRecord, profileHash, saveProfile } from './profile/store.js';
import { applyProfileSuggestions, getSettings } from './settings.js';
import { deleteFile, saveFile } from './storage.js';
import { renderCoverLetterPdf, renderDocx, renderPdf, renderText } from './tailoring/render.js';
import { tailorResume } from './tailoring/tailor.js';

/** Original resume ingestion and per-job tailored resume generation. */

function squash(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9₹%]+/g, '');
}

/** Drop anything an LLM extraction produced that does not literally appear in the resume text. */
export function groundLlmProfile(p: CandidateProfile, text: string): { profile: CandidateProfile; dropped: string[] } {
  const hay = squash(text);
  const inText = (s: string) => !s || hay.includes(squash(s).slice(0, 60));
  const dropped: string[] = [];
  const keep = <T>(items: T[], value: (t: T) => string, label: string): T[] =>
    items.filter((i) => {
      const ok = inText(value(i));
      if (!ok) dropped.push(`${label}: ${value(i).slice(0, 60)}`);
      return ok;
    });
  const out: CandidateProfile = {
    ...p,
    skillGroups: p.skillGroups.map((g) => ({ ...g, skills: keep(g.skills, (s) => s, 'skill') })).filter((g) => g.skills.length),
    experience: keep(p.experience, (e) => e.company, 'employer').map((e) => ({ ...e, bullets: keep(e.bullets, (b) => b.text, 'bullet') })),
    projects: keep(p.projects, (x) => x.name, 'project').map((x) => ({
      ...x,
      technologies: keep(x.technologies, (t) => t, 'technology'),
      bullets: keep(x.bullets, (b) => b.text, 'bullet'),
    })),
    education: keep(p.education, (e) => e.institution, 'education'),
    certifications: keep(p.certifications, (c) => c.name, 'certification'),
  };
  return { profile: out, dropped };
}

export interface IngestResult {
  resumeId: number;
  profile: CandidateProfile;
  warnings: string[];
  method: 'heuristic' | 'llm';
}

export async function ingestResume(data: Buffer, filename: string, mime: string): Promise<IngestResult> {
  const text = await extractResumeText(data, filename, mime);
  const parsed = parseResumeText(text);
  let profile = parsed.profile;
  let warnings = [...parsed.warnings];
  let method: 'heuristic' | 'llm' = 'heuristic';
  if (llmAvailable() && getSettings().llm.profileExtraction) {
    const llm = await extractProfileWithLlm(text);
    if (llm) {
      const grounded = groundLlmProfile(ensureIds(llm), text);
      if (grounded.profile.name && grounded.profile.experience.length >= parsed.profile.experience.length) {
        profile = grounded.profile;
        method = 'llm';
        warnings = parsed.warnings.filter((w) => w.includes('no bullet points'));
        if (grounded.dropped.length) warnings.push(`Removed ${grounded.dropped.length} extracted item(s) not found verbatim in your resume.`);
      }
    }
  }
  warnings.push(...profileProblems(profile));
  const fileId = saveFile('original_resume', filename, mime, data);
  const resumeId = tx(() => {
    run(`UPDATE resumes SET is_current = 0 WHERE kind = 'original'`);
    return run(`INSERT INTO resumes (kind, original_file_id, content_enc, is_current, created_at) VALUES ('original', ?, ?, 1, ?)`, [
      fileId,
      encryptString(text),
      nowIso(),
    ]).lastInsertRowid;
  });
  saveProfile(profile, { method, warnings, sourceResumeId: resumeId });
  applyProfileSuggestions(profile);
  return { resumeId, profile, warnings, method };
}

export interface ResumeRecord {
  id: number;
  kind: 'original' | 'tailored';
  jobId: number | null;
  jobTitle?: string;
  company?: string;
  createdAt: string;
  isCurrent: boolean;
  files: { original?: number; pdf?: number; docx?: number; txt?: number; coverLetter?: number };
  summary: TailoringSummary | null;
  accuracy: AccuracyReport | null;
  coverLetterRequired: boolean;
  stale: boolean;
}

interface ResumeRow {
  id: number;
  kind: 'original' | 'tailored';
  job_id: number | null;
  original_file_id: number | null;
  pdf_file_id: number | null;
  docx_file_id: number | null;
  txt_file_id: number | null;
  cover_letter_file_id: number | null;
  content_enc: string | null;
  summary_json: string | null;
  accuracy_json: string | null;
  cover_letter_enc: string | null;
  cover_letter_required: number;
  profile_hash: string | null;
  is_current: number;
  created_at: string;
  title?: string;
  company?: string;
}

function mapResume(r: ResumeRow, currentHash: string | null): ResumeRecord {
  return {
    id: r.id,
    kind: r.kind,
    jobId: r.job_id,
    jobTitle: r.title,
    company: r.company,
    createdAt: r.created_at,
    isCurrent: r.is_current === 1,
    files: {
      original: r.original_file_id ?? undefined,
      pdf: r.pdf_file_id ?? undefined,
      docx: r.docx_file_id ?? undefined,
      txt: r.txt_file_id ?? undefined,
      coverLetter: r.cover_letter_file_id ?? undefined,
    },
    summary: parseJson<TailoringSummary | null>(r.summary_json, null),
    accuracy: parseJson<AccuracyReport | null>(r.accuracy_json, null),
    coverLetterRequired: r.cover_letter_required === 1,
    stale: r.kind === 'tailored' && currentHash !== null && r.profile_hash !== currentHash,
  };
}

function currentProfileHash(): string | null {
  const rec = getProfileRecord();
  return rec ? profileHash(rec.profile) : null;
}

export function listResumes(): ResumeRecord[] {
  const hash = currentProfileHash();
  return all<ResumeRow>(
    `SELECT r.*, j.title, j.company FROM resumes r LEFT JOIN jobs j ON j.id = r.job_id
     WHERE r.is_current = 1 OR r.kind = 'original' ORDER BY r.kind = 'original' DESC, r.created_at DESC LIMIT 500`,
  ).map((r) => mapResume(r, hash));
}

export function getResume(id: number): ResumeRecord | null {
  const r = get<ResumeRow>('SELECT r.*, j.title, j.company FROM resumes r LEFT JOIN jobs j ON j.id = r.job_id WHERE r.id = ?', [id]);
  return r ? mapResume(r, currentProfileHash()) : null;
}

export function getCurrentTailored(jobId: number): ResumeRecord | null {
  const r = get<ResumeRow>(`SELECT * FROM resumes WHERE job_id = ? AND kind = 'tailored' AND is_current = 1 ORDER BY id DESC LIMIT 1`, [jobId]);
  return r ? mapResume(r, currentProfileHash()) : null;
}

export function getTailoredContent(resumeId: number): { resume: TailoredResume | null; coverLetter: string | null } {
  const r = get<ResumeRow>('SELECT content_enc, cover_letter_enc FROM resumes WHERE id = ?', [resumeId]);
  return {
    resume: r?.content_enc ? decryptJson<TailoredResume>(r.content_enc) : null,
    coverLetter: r?.cover_letter_enc ? decryptString(r.cover_letter_enc) : null,
  };
}

export async function updateCoverLetter(resumeId: number, text: string): Promise<void> {
  const r = get<ResumeRow>('SELECT * FROM resumes WHERE id = ?', [resumeId]);
  if (!r || r.kind !== 'tailored') throw new Error('Tailored resume not found');
  const rec = getProfileRecord();
  const pdf = await renderCoverLetterPdf(rec?.profile.name ?? 'Cover letter', text);
  const fileId = saveFile('cover_letter_pdf', 'cover-letter.pdf', 'application/pdf', pdf);
  deleteFile(r.cover_letter_file_id);
  run('UPDATE resumes SET cover_letter_enc = ?, cover_letter_file_id = ? WHERE id = ?', [encryptString(text), fileId, resumeId]);
  if (r.job_id) addEvent(r.job_id, 'cover_letter', 'Cover letter edited');
}

function slug(s: string): string {
  return s.replace(/[^\w]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
}

/** Generate (or regenerate) the tailored resume + cover letter for a job. */
export async function generateTailoredResume(jobId: number): Promise<ResumeRecord> {
  const job = getJob(jobId);
  if (!job) throw new Error('Job not found');
  const rec = getProfileRecord();
  if (!rec) throw new Error('Upload your resume first.');
  const match = jobMatch(job);
  if (!match) throw new Error('Job has not been scored yet.');
  const settings = getSettings();
  const result = await tailorResume(
    rec.profile,
    { title: job.title, company: job.company, descriptionText: job.description_text ?? '', match },
    { useLlm: llmAvailable() && settings.llm.tailoring, llmCoverLetter: llmAvailable() && settings.llm.coverLetters },
  );
  const base = `${slug(rec.profile.name)}-${slug(job.company)}-${slug(job.title)}`;
  const [pdf, docx, coverPdf] = await Promise.all([renderPdf(result.resume), renderDocx(result.resume), renderCoverLetterPdf(rec.profile.name, result.coverLetter)]);
  const txt = Buffer.from(renderText(result.resume), 'utf8');
  const pdfId = saveFile('tailored_pdf', `${base}.pdf`, 'application/pdf', pdf);
  const docxId = saveFile('tailored_docx', `${base}.docx`, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', docx);
  const txtId = saveFile('tailored_txt', `${base}.txt`, 'text/plain; charset=utf-8', txt);
  const coverId = saveFile('cover_letter_pdf', `${base}-cover-letter.pdf`, 'application/pdf', coverPdf);
  const id = tx(() => {
    const old = all<ResumeRow>(`SELECT * FROM resumes WHERE job_id = ? AND kind = 'tailored' AND is_current = 1`, [jobId]);
    for (const o of old) {
      run('UPDATE resumes SET is_current = 0 WHERE id = ?', [o.id]);
    }
    return run(
      `INSERT INTO resumes (kind, job_id, pdf_file_id, docx_file_id, txt_file_id, cover_letter_file_id, content_enc, summary_json, accuracy_json,
         cover_letter_enc, cover_letter_required, profile_hash, is_current, created_at)
       VALUES ('tailored', :job, :pdf, :docx, :txt, :cover, :content, :summary, :accuracy, :letter, :required, :hash, 1, :now)`,
      {
        job: jobId,
        pdf: pdfId,
        docx: docxId,
        txt: txtId,
        cover: coverId,
        content: encryptJson(result.resume),
        summary: JSON.stringify(result.summary),
        accuracy: JSON.stringify(result.accuracy),
        letter: encryptString(result.coverLetter),
        required: match.requirements.coverLetterRequired ? 1 : 0,
        hash: profileHash(rec.profile),
        now: nowIso(),
      },
    ).lastInsertRowid;
  });
  addEvent(jobId, 'tailored', `Tailored resume generated (${result.summary.method === 'llm_assisted' ? 'reworded + fact-checked' : 'reordered, original wording'}; accuracy check ${result.accuracy.ok ? 'passed' : 'FAILED'})`);
  recomputeStatus(jobId);
  return getResume(id)!;
}
