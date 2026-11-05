import os from 'node:os';
import type { AnswerCategory, AnswerResolution, ApplicationState, FormQuestion, ReviewReason } from '../../shared/types.js';
import { REVIEW_REASON_LABELS } from '../../shared/types.js';
import { decryptJson, encryptJson, randomToken, sha256 } from '../crypto.js';
import { all, get, nowIso, parseJson, run, tx } from '../db.js';
import { addEvent, closeJob, findPriorApplication, getJob, jobMatch, jobTracks, recomputeStatus, type JobRow } from '../jobs.js';
import { logger, safeErrorMessage } from '../logger.js';
import { notifySoon } from '../notifications.js';
import { getProfileRecord } from '../profile/store.js';
import { generateTailoredResume, getCurrentTailored, getTailoredContent } from '../resumes.js';
import { getSettings } from '../settings.js';
import { readFile, saveFile } from '../storage.js';
import { renderText } from '../tailoring/render.js';
import { adapterById, adapterFor } from './adapters.js';
import { listSavedAnswers, resolveAnswers, upsertSavedAnswer } from './answers.js';
import type { FillResult } from './browser.js';

/**
 * Application lifecycle. Guarantees:
 *  - one application per job (UNIQUE job_id) and per company+title across jobs;
 *  - a submission is claimed atomically (state -> submitting) before any browser work;
 *  - a write-ahead "submit clicked" marker is stored before the click, so a crash can never
 *    lead to a blind retry: interrupted attempts become "uncertain" for the user to verify;
 *  - "submitted" is recorded only with confirmation evidence (page + screenshot) or, for
 *    manual applications, the user's own confirmation.
 */

export const WORKER_ID = `${os.hostname()}-${process.pid}-${randomToken(4)}`;

export interface ApplicationRow {
  id: number;
  job_id: number;
  company_title_key: string;
  resume_id: number | null;
  adapter: string;
  state: ApplicationState;
  review_reason: ReviewReason | null;
  questions_json: string | null;
  user_answers_enc: string | null;
  resolution_enc: string | null;
  missing_count: number;
  idempotency_key: string;
  attempts: number;
  submitted_at: string | null;
  submitted_via: string | null;
  confirmation_text: string | null;
  confirmation_url: string | null;
  evidence_file_id: number | null;
  evidence_html_file_id: number | null;
  last_error: string | null;
  next_action: string | null;
  created_at: string;
  updated_at: string;
}

export interface AttemptRow {
  id: number;
  application_id: number;
  started_at: string;
  finished_at: string | null;
  dry_run: number;
  trigger: string;
  worker_id: string;
  submit_clicked_at: string | null;
  outcome: string | null;
  detail: string | null;
  screenshot_file_id: number | null;
  html_file_id: number | null;
}

export type Trigger = 'auto' | 'approve' | 'dry_run';

export function getApplication(jobId: number): ApplicationRow | undefined {
  return get<ApplicationRow>('SELECT * FROM applications WHERE job_id = ?', [jobId]);
}

export function getApplicationById(id: number): ApplicationRow | undefined {
  return get<ApplicationRow>('SELECT * FROM applications WHERE id = ?', [id]);
}

export function listAttempts(applicationId: number): AttemptRow[] {
  return all<AttemptRow>('SELECT * FROM application_attempts WHERE application_id = ? ORDER BY id DESC', [applicationId]);
}

export function appQuestions(app: ApplicationRow): FormQuestion[] {
  return parseJson<FormQuestion[]>(app.questions_json, []);
}

export function appResolution(app: ApplicationRow): AnswerResolution | null {
  return app.resolution_enc ? decryptJson<AnswerResolution>(app.resolution_enc) : null;
}

export function appUserAnswers(app: ApplicationRow): Record<string, string | string[]> {
  return app.user_answers_enc ? decryptJson<Record<string, string | string[]>>(app.user_answers_enc) : {};
}

function setState(appId: number, state: ApplicationState, extra: Partial<Record<keyof ApplicationRow, unknown>> = {}): void {
  const sets = ['state = :state', 'updated_at = :now', ...Object.keys(extra).map((k) => `${k} = :${k}`)];
  run(`UPDATE applications SET ${sets.join(', ')} WHERE id = :id`, { state, now: nowIso(), id: appId, ...extra });
}

export function ensureApplication(job: JobRow): ApplicationRow {
  const existing = getApplication(job.id);
  if (existing) return existing;
  const adapter = adapterFor(job);
  run(
    `INSERT INTO applications (job_id, company_title_key, adapter, state, idempotency_key, created_at, updated_at)
     VALUES (?, ?, ?, 'draft', ?, ?, ?) ON CONFLICT(job_id) DO NOTHING`,
    [job.id, job.company_title_key, adapter.id, sha256(`${job.id}:${job.company_title_key}:${adapter.id}`).slice(0, 32), nowIso(), nowIso()],
  );
  addEvent(job.id, 'application', `Application created (${adapter.label})`);
  return getApplication(job.id)!;
}

function jobCountry(job: JobRow): string | null {
  const l = (job.location ?? '').toLowerCase();
  if (/india|bengaluru|bangalore|mumbai|pune|hyderabad|chennai|delhi|gurugram|noida|kolkata/.test(l)) return 'IN';
  if (/united states|usa|\bus\b|new york|san francisco|seattle/.test(l)) return 'US';
  if (/united kingdom|\buk\b|london/.test(l)) return 'GB';
  return null;
}

/**
 * Make sure the tailored resume exists, read the form's questions and resolve answers.
 * Leaves the application in needs_input, ready or needs_review (manual).
 */
export async function prepareApplication(jobId: number): Promise<ApplicationRow> {
  const job = getJob(jobId);
  if (!job) throw new Error('Job not found');
  const rec = getProfileRecord();
  if (!rec) throw new Error('Upload your resume first.');
  let app = ensureApplication(job);
  if (['submitted', 'submitting', 'uncertain', 'approved'].includes(app.state)) return app;

  let tailored = getCurrentTailored(jobId);
  if (!tailored || tailored.stale) tailored = await generateTailoredResume(jobId);
  const adapter = adapterById(app.adapter);
  let questions = appQuestions(app);
  if (questions.length === 0 || app.state === 'draft') {
    try {
      questions = (await adapter.getQuestions(job)) ?? [];
    } catch (err) {
      logger.warn('Could not load application questions', { job: jobId, error: safeErrorMessage(err) });
      if (adapter.id !== 'manual') addEvent(jobId, 'warning', `Could not read the application form questions: ${safeErrorMessage(err)}`);
      questions = [];
    }
  }
  const settings = getSettings();
  const resolution = resolveAnswers(questions, {
    profile: rec.profile,
    bank: listSavedAnswers(),
    userAnswers: appUserAnswers(app),
    jobCountry: jobCountry(job),
    jobSource: job.source_type,
    coverLetterPolicy: settings.automation.coverLetters,
    coverLetterRequired: tailored.coverLetterRequired,
  });
  let state: ApplicationState;
  let reason: ReviewReason | null = null;
  if (adapter.id === 'manual') {
    state = 'needs_review';
    reason = 'manual_apply';
  } else if (!resolution.complete) state = 'needs_input';
  else state = app.state === 'needs_review' && app.review_reason && !['review_mode'].includes(app.review_reason) ? 'needs_review' : 'ready';
  if (state === 'needs_review' && !reason) reason = app.review_reason;
  setState(app.id, state, {
    resume_id: tailored.id,
    questions_json: JSON.stringify(questions),
    resolution_enc: encryptJson(resolution),
    missing_count: resolution.missing.length,
    review_reason: reason,
  });
  if (state === 'needs_input' && app.state !== 'needs_input') {
    addEvent(jobId, 'needs_input', `${resolution.missing.length} required answer(s) missing: ${resolution.missing.map((m) => m.label).slice(0, 4).join('; ')}`);
    notifySoon({ kind: 'needs_input', title: `Needs input: ${job.title} at ${job.company}`, body: `Answer ${resolution.missing.length} question(s) to continue: ${resolution.missing.map((m) => m.label).join('; ')}`, jobId });
  }
  recomputeStatus(jobId);
  app = getApplication(jobId)!;
  return app;
}

/** Save answers the user typed for this application (optionally into the answer bank). */
export async function saveUserAnswers(
  jobId: number,
  answers: Record<string, string | string[]>,
  saveToBank: Record<string, AnswerCategory> = {},
): Promise<ApplicationRow> {
  const job = getJob(jobId);
  if (!job) throw new Error('Job not found');
  const app = ensureApplication(job);
  const merged = { ...appUserAnswers(app), ...answers };
  setState(app.id, app.state === 'needs_input' || app.state === 'draft' ? 'draft' : app.state, { user_answers_enc: encryptJson(merged) });
  const questions = appQuestions(app);
  for (const [qid, category] of Object.entries(saveToBank)) {
    const q = questions.find((x) => x.id === qid);
    const value = answers[qid];
    if (q && value !== undefined && value !== '') upsertSavedAnswer({ category, question: q.label, answer: Array.isArray(value) ? value.join(', ') : value });
  }
  addEvent(jobId, 'answers', `Saved ${Object.keys(answers).length} answer(s)`);
  return prepareApplication(jobId);
}

function localDate(d: Date, timezone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

/** Applications submitted by the system (auto or approved) today in the user's timezone. */
export function submittedTodayCount(timezone = getSettings().schedule.timezone): number {
  const today = localDate(new Date(), timezone);
  const rows = all<{ submitted_at: string }>(`SELECT submitted_at FROM applications WHERE state = 'submitted' AND submitted_via IN ('auto', 'approved') AND submitted_at >= ?`, [
    new Date(Date.now() - 36 * 3600_000).toISOString(),
  ]);
  return rows.filter((r) => localDate(new Date(r.submitted_at), timezone) === today).length;
}

export interface GateResult {
  ok: boolean;
  reason?: ReviewReason;
  detail?: string;
  /** true = leave the application as-is and try again later (daily limit, pause) */
  defer?: boolean;
}

export function gateAutoSubmit(job: JobRow, app: ApplicationRow): GateResult {
  const s = getSettings();
  const a = s.automation;
  const match = jobMatch(job);
  if (a.paused) return { ok: false, reason: 'paused', defer: true };
  if (a.mode !== 'auto') return { ok: false, reason: 'review_mode' };
  if (!getProfileRecord()?.verified) return { ok: false, reason: 'profile_unverified' };
  if (!match || !match.eligible) return { ok: false, reason: 'eligibility', detail: match?.conflicts.map((c) => c.message).join('; ') };
  if ((job.score ?? 0) < a.matchThreshold) return { ok: false, reason: 'below_threshold', detail: `Score ${job.score} < threshold ${a.matchThreshold}` };
  if (!jobTracks(job).some((t) => a.autoTracks.includes(t))) return { ok: false, reason: 'auto_disabled', detail: `Automatic submission is not enabled for ${jobTracks(job).join('/')} roles` };
  if (!adapterById(app.adapter).supportsAutoSubmit) return { ok: false, reason: 'manual_apply' };
  if (app.state !== 'ready') return { ok: false, reason: 'review_mode', detail: `Application is ${app.state}` };
  if (submittedTodayCount(s.schedule.timezone) >= a.dailyLimit) return { ok: false, reason: 'daily_limit', defer: true };
  return { ok: true };
}

/** Atomically move an application into "submitting". Returns the attempt id or null if not claimable. */
function claim(appId: number, ctk: string, fromStates: ApplicationState[], dryRun: boolean, trigger: Trigger): number | null {
  return tx(() => {
    const dup = get<{ id: number }>(`SELECT id FROM applications WHERE company_title_key = ? AND id != ? AND state IN ('submitted', 'submitting', 'uncertain')`, [ctk, appId]);
    if (dup && !dryRun) return null;
    const placeholders = fromStates.map(() => '?').join(', ');
    const res = run(`UPDATE applications SET state = 'submitting', attempts = attempts + 1, updated_at = ? WHERE id = ? AND state IN (${placeholders})`, [nowIso(), appId, ...fromStates]);
    if (res.changes !== 1) return null;
    return run('INSERT INTO application_attempts (application_id, started_at, dry_run, trigger, worker_id) VALUES (?, ?, ?, ?, ?)', [appId, nowIso(), dryRun ? 1 : 0, trigger, WORKER_ID]).lastInsertRowid;
  });
}

export interface SubmitOutcome {
  outcome: FillResult['outcome'] | 'skipped' | 'deferred' | 'needs_review' | 'needs_input';
  detail: string;
}

function reviewReasonFor(block: FillResult['blockReason']): ReviewReason {
  switch (block) {
    case 'captcha':
      return 'captcha';
    case 'login_required':
      return 'login_required';
    case 'verification_required':
      return 'verification_required';
    default:
      return 'unsupported_form';
  }
}

/**
 * Run (or dry-run) the submission for a job.
 * trigger "auto" = scheduler (gated by automatic-mode rules); "approve" = user clicked
 * Approve & submit; "dry_run" = fill without submitting.
 */
export async function submitApplication(jobId: number, trigger: Trigger, opts: { allowDuplicate?: boolean } = {}): Promise<SubmitOutcome> {
  const settings = getSettings();
  if (settings.automation.paused && trigger !== 'dry_run') return { outcome: 'deferred', detail: 'Automation is paused' };
  let job = getJob(jobId);
  if (!job) throw new Error('Job not found');
  if (!job.is_active) return { outcome: 'closed', detail: 'Posting is closed' };
  let app = await prepareApplication(jobId);
  if (['submitted', 'submitting', 'uncertain'].includes(app.state)) return { outcome: 'skipped', detail: `Application already ${app.state}` };
  if (app.state === 'needs_input') return { outcome: 'needs_input', detail: `${app.missing_count} required answer(s) missing` };

  const prior = findPriorApplication(job.company_title_key, jobId);
  if (prior && !opts.allowDuplicate) {
    setState(app.id, 'needs_review', { review_reason: 'possible_duplicate', next_action: 'Confirm this is a different role before submitting' });
    addEvent(jobId, 'duplicate', `Possible duplicate: you already applied to "${job.title}" at ${job.company}${prior.date ? ` on ${prior.date.slice(0, 10)}` : ''}`);
    recomputeStatus(jobId);
    return { outcome: 'needs_review', detail: 'Possible duplicate application' };
  }

  const adapter = adapterById(app.adapter);
  const dryRun = trigger === 'dry_run' || settings.automation.dryRun;
  if (!adapter.supportsAutoSubmit) {
    setState(app.id, 'needs_review', { review_reason: 'manual_apply', next_action: 'Open the application page, submit with the prepared resume, then mark it submitted' });
    recomputeStatus(jobId);
    return { outcome: 'needs_review', detail: 'Manual application required' };
  }
  if (trigger === 'auto' && !dryRun) {
    const gate = gateAutoSubmit(job, app);
    if (!gate.ok) {
      if (gate.defer) return { outcome: 'deferred', detail: REVIEW_REASON_LABELS[gate.reason!] };
      setState(app.id, 'needs_review', { review_reason: gate.reason, next_action: gate.detail ?? REVIEW_REASON_LABELS[gate.reason!] });
      recomputeStatus(jobId);
      return { outcome: 'needs_review', detail: gate.detail ?? REVIEW_REASON_LABELS[gate.reason!] };
    }
  }
  if (trigger === 'auto' && dryRun && settings.automation.mode !== 'auto') {
    setState(app.id, 'needs_review', { review_reason: 'review_mode', next_action: 'Approve to submit' });
    recomputeStatus(jobId);
    return { outcome: 'needs_review', detail: 'Review mode' };
  }

  const active = await adapter.isActive(job);
  if (active === false) {
    closeJob(jobId, 'Employer reports the posting is no longer available');
    return { outcome: 'closed', detail: 'Posting closed' };
  }

  const from: ApplicationState[] = trigger === 'auto' ? ['ready'] : ['ready', 'needs_review', 'approved', 'failed'];
  const attemptId = claim(app.id, job.company_title_key, from, dryRun, trigger);
  if (!attemptId) return { outcome: 'skipped', detail: 'Another worker is handling this application, or a duplicate was already submitted' };
  recomputeStatus(jobId);
  job = getJob(jobId)!;
  app = getApplication(jobId)!;

  let result: FillResult;
  try {
    const tailored = getCurrentTailored(jobId)!;
    const content = getTailoredContent(tailored.id);
    const pdf = readFile(tailored.files.pdf!);
    const cover = tailored.files.coverLetter ? readFile(tailored.files.coverLetter) : null;
    const resolution = appResolution(app)!;
    result = await adapter.submit(job, {
      questions: appQuestions(app),
      answers: resolution.answers,
      resumePdf: { name: pdf.meta.filename, mimeType: 'application/pdf', buffer: pdf.data },
      resumeText: content.resume ? renderText(content.resume) : '',
      coverLetterPdf: cover ? { name: cover.meta.filename, mimeType: 'application/pdf', buffer: cover.data } : undefined,
      coverLetterText: content.coverLetter ?? undefined,
      dryRun,
      captchaPolicy: settings.automation.captchaPolicy,
      onBeforeSubmit: () => {
        run('UPDATE application_attempts SET submit_clicked_at = ? WHERE id = ?', [nowIso(), attemptId]);
      },
    });
  } catch (err) {
    const clicked = Boolean(get<{ c: string | null }>('SELECT submit_clicked_at AS c FROM application_attempts WHERE id = ?', [attemptId])?.c);
    result = { outcome: clicked ? 'uncertain' : 'failed', submitClicked: clicked, detail: safeErrorMessage(err) };
  }
  return recordResult(job, app, attemptId, trigger, dryRun, result);
}

function recordResult(job: JobRow, app: ApplicationRow, attemptId: number, trigger: Trigger, dryRun: boolean, r: FillResult): SubmitOutcome {
  const shot = r.screenshot ? saveFile('evidence_png', `attempt-${attemptId}.png`, 'image/png', r.screenshot) : null;
  const html = r.html ? saveFile('evidence_html', `attempt-${attemptId}.html`, 'text/html; charset=utf-8', Buffer.from(r.html)) : null;
  run('UPDATE application_attempts SET finished_at = ?, outcome = ?, detail = ?, screenshot_file_id = ?, html_file_id = ? WHERE id = ?', [
    nowIso(),
    r.outcome,
    r.detail,
    shot,
    html,
    attemptId,
  ]);
  const title = `${job.title} at ${job.company}`;
  switch (r.outcome) {
    case 'submitted':
      if (dryRun) throw new Error('Invariant violated: dry run reported a submission');
      setState(app.id, 'submitted', {
        submitted_at: nowIso(),
        submitted_via: trigger === 'auto' ? 'auto' : 'approved',
        confirmation_text: r.confirmationText ?? null,
        confirmation_url: r.confirmationUrl ?? null,
        evidence_file_id: shot,
        evidence_html_file_id: html,
        review_reason: null,
        last_error: null,
        next_action: 'Watch your inbox for a reply',
      });
      addEvent(job.id, 'submitted', `Submitted (${trigger === 'auto' ? 'automatic' : 'approved by you'}). Evidence: "${r.confirmationText ?? 'confirmation page'}"`, app.id);
      notifySoon({ kind: 'submitted', title: `Submitted: ${title}`, body: `Confirmation: ${r.confirmationText ?? 'confirmation page detected'}`, jobId: job.id });
      break;
    case 'dry_run_complete':
      setState(app.id, 'needs_review', { review_reason: 'dry_run_complete', next_action: 'Check the screenshot, then approve to submit (with dry-run off)', last_error: null });
      addEvent(job.id, 'dry_run', 'Dry run: form filled and screenshotted; nothing was submitted', app.id);
      break;
    case 'uncertain':
      setState(app.id, 'uncertain', { review_reason: r.blockReason === 'captcha' ? 'captcha' : 'verify_submission', last_error: r.detail, next_action: 'Check your email / the employer site, then mark as submitted or not submitted' });
      addEvent(job.id, 'uncertain', r.detail, app.id);
      notifySoon({ kind: 'needs_review', title: `Verify submission: ${title}`, body: r.detail, jobId: job.id });
      break;
    case 'blocked': {
      const reason = reviewReasonFor(r.blockReason);
      setState(app.id, 'needs_review', { review_reason: reason, last_error: r.detail, next_action: 'Open the application page and finish it manually, then mark it submitted' });
      addEvent(job.id, 'blocked', r.detail, app.id);
      notifySoon({ kind: 'blocked', title: `Manual action needed: ${title}`, body: `${REVIEW_REASON_LABELS[reason]}. ${r.detail}`, jobId: job.id });
      break;
    }
    case 'needs_input': {
      const extra: FormQuestion[] = (r.unfilledRequired ?? []).map((label, i) => ({ id: `extra_${i}_${label.replace(/\W+/g, '_').slice(0, 40)}`, label, required: true, type: 'text', section: 'discovered' }));
      const questions = [...appQuestions(app).filter((q) => !q.id.startsWith('extra_')), ...extra];
      const resolution = appResolution(app);
      const missing = [...(resolution?.missing ?? []), ...extra.map((q) => ({ questionId: q.id, label: q.label, category: 'unknown' as const, value: null, source: null, sensitive: false, required: true, note: 'Found on the live form' }))];
      setState(app.id, 'needs_input', {
        questions_json: JSON.stringify(questions),
        resolution_enc: encryptJson({ answers: [...(resolution?.answers ?? []), ...missing.slice(resolution?.missing.length ?? 0)], missing, complete: false }),
        missing_count: missing.length,
        last_error: r.detail,
      });
      addEvent(job.id, 'needs_input', r.detail, app.id);
      notifySoon({ kind: 'needs_input', title: `Needs input: ${title}`, body: r.detail, jobId: job.id });
      break;
    }
    case 'closed':
      setState(app.id, 'failed', { last_error: r.detail, next_action: 'Posting closed' });
      closeJob(job.id, r.detail);
      break;
    default:
      setState(app.id, 'failed', { last_error: r.detail, next_action: r.submitClicked ? 'Verify on the employer site' : 'Retry' });
      addEvent(job.id, 'failed', r.detail, app.id);
      notifySoon({ kind: 'failed', title: `Failed: ${title}`, body: r.detail, jobId: job.id });
  }
  recomputeStatus(job.id);
  return { outcome: r.outcome, detail: r.detail };
}

/** User clicked "Approve & submit" in review mode. */
export async function approveAndSubmit(jobId: number, opts: { allowDuplicate?: boolean } = {}): Promise<SubmitOutcome> {
  const app = getApplication(jobId);
  if (app && ['needs_review', 'ready', 'failed'].includes(app.state)) {
    setState(app.id, 'approved', {});
    addEvent(jobId, 'approved', 'Approved by you');
    recomputeStatus(jobId);
    // approved -> run immediately
    const res = await submitApplication(jobId, 'approve', opts);
    const after = getApplication(jobId);
    if (after?.state === 'approved') setState(after.id, 'needs_review', { review_reason: 'review_mode' });
    recomputeStatus(jobId);
    return res;
  }
  return submitApplication(jobId, 'approve', opts);
}

/** Manual applications: the user confirms they submitted, with a note and/or a file. */
export function markSubmittedManually(jobId: number, input: { note: string; evidence?: { filename: string; mime: string; data: Buffer } }): ApplicationRow {
  const job = getJob(jobId);
  if (!job) throw new Error('Job not found');
  if (!input.note.trim() && !input.evidence) throw Object.assign(new Error('Add a confirmation note (e.g. the confirmation email subject) or attach a screenshot as evidence.'), { statusCode: 400 });
  const app = ensureApplication(job);
  if (app.state === 'submitted') return app;
  const fileId = input.evidence ? saveFile('manual_evidence', input.evidence.filename, input.evidence.mime, input.evidence.data) : null;
  setState(app.id, 'submitted', {
    submitted_at: nowIso(),
    submitted_via: 'manual',
    confirmation_text: input.note.trim().slice(0, 500) || 'User-provided evidence',
    evidence_file_id: fileId,
    review_reason: null,
    last_error: null,
    next_action: 'Watch your inbox for a reply',
  });
  addEvent(jobId, 'submitted', `Marked as submitted by you: ${input.note.trim().slice(0, 120) || 'evidence attached'}`, app.id);
  recomputeStatus(jobId);
  return getApplication(jobId)!;
}

/** Resolve an uncertain submission after the user checked. */
export function resolveUncertain(jobId: number, submitted: boolean, note: string): ApplicationRow {
  const app = getApplication(jobId);
  if (!app || !['uncertain', 'failed', 'needs_review'].includes(app.state)) throw Object.assign(new Error('Nothing to verify for this job'), { statusCode: 400 });
  if (submitted) return markSubmittedManually(jobId, { note: note || 'Verified by you after an uncertain automatic submission' });
  setState(app.id, 'ready', { review_reason: null, last_error: null, next_action: 'Confirmed not submitted; you can submit again' });
  addEvent(jobId, 'verified', `You confirmed the application was NOT submitted${note ? `: ${note}` : ''}`, app.id);
  recomputeStatus(jobId);
  return getApplication(jobId)!;
}

/**
 * On startup: attempts interrupted by a crash or restart. If submit may have been clicked
 * the application becomes "uncertain" (never retried automatically); otherwise "failed"
 * (safe to retry because nothing was sent).
 */
export function recoverInterrupted(): number {
  const stuck = all<ApplicationRow>(`SELECT * FROM applications WHERE state = 'submitting'`);
  for (const app of stuck) {
    const attempt = get<AttemptRow>('SELECT * FROM application_attempts WHERE application_id = ? ORDER BY id DESC LIMIT 1', [app.id]);
    if (attempt?.worker_id === WORKER_ID && !attempt.finished_at) continue; // still running in this process
    const clicked = Boolean(attempt?.submit_clicked_at);
    if (attempt && !attempt.finished_at) {
      run('UPDATE application_attempts SET finished_at = ?, outcome = ?, detail = ? WHERE id = ?', [nowIso(), clicked ? 'uncertain' : 'failed', 'Interrupted (process restarted)', attempt.id]);
    }
    if (clicked) {
      setState(app.id, 'uncertain', { review_reason: 'verify_submission', last_error: 'The process stopped right after clicking submit', next_action: 'Verify on the employer site or your email' });
      notifySoon({ kind: 'needs_review', title: 'Verify an interrupted submission', body: 'An application was interrupted right after submit was clicked. Please verify it.', jobId: app.job_id });
    } else setState(app.id, 'failed', { last_error: 'Interrupted before submitting (nothing was sent)', next_action: 'Retry' });
    addEvent(app.job_id, 'recovered', clicked ? 'Interrupted after submit click → needs verification' : 'Interrupted before submit → safe to retry', app.id);
    recomputeStatus(app.job_id);
  }
  return stuck.length;
}

export function lastAttempt(appId: number): AttemptRow | undefined {
  return get<AttemptRow>('SELECT * FROM application_attempts WHERE application_id = ? ORDER BY id DESC LIMIT 1', [appId]);
}

export function retryableFailed(): number[] {
  return all<{ job_id: number }>(
    `SELECT a.job_id FROM applications a WHERE a.state = 'failed' AND a.attempts < 3
       AND NOT EXISTS (SELECT 1 FROM application_attempts t WHERE t.application_id = a.id AND t.submit_clicked_at IS NOT NULL)`,
  ).map((r) => r.job_id);
}
