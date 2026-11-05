import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ANSWER_CATEGORIES, type AnswerCategory, type CandidateProfile } from '../../shared/types.js';
import { adapterById } from '../applications/adapters.js';
import { deleteSavedAnswer, listSavedAnswers, upsertSavedAnswer } from '../applications/answers.js';
import {
  appQuestions,
  appResolution,
  appUserAnswers,
  approveAndSubmit,
  getApplication,
  lastAttempt,
  listAttempts,
  markSubmittedManually,
  prepareApplication,
  resolveUncertain,
  saveUserAnswers,
  submitApplication,
} from '../applications/engine.js';
import { getConfig } from '../config.js';
import { safeEqual } from '../crypto.js';
import { all, get, nowIso, run, wipeAllTables } from '../db.js';
import { buildDigest, overviewStats, renderDigest } from '../digest.js';
import { discover } from '../discovery.js';
import { importJobs } from '../importer.js';
import {
  addEvent,
  addPriorApplication,
  getJob,
  jobMatch,
  jobTracks,
  listEvents,
  listJobs,
  recomputeAllStatuses,
  recomputeStatus,
  reopenJob,
  closeJob,
} from '../jobs.js';
import { llmAvailable } from '../llm.js';
import { logger, safeErrorMessage } from '../logger.js';
import { deliver, listNotifications, markRead, unreadCount } from '../notifications.js';
import { profileProblems } from '../profile/parse.js';
import { experienceYears, getProfileRecord, saveProfile, verifyProfile } from '../profile/store.js';
import { listRuns, runPipeline, scoreJobs, type PipelineStep } from '../pipeline.js';
import { generateTailoredResume, getCurrentTailored, getResume, getTailoredContent, ingestResume, listResumes, updateCoverLetter } from '../resumes.js';
import { getSettings, updateSection, type SettingsSection } from '../settings.js';
import { tick } from '../scheduler.js';
import { ADAPTERS } from '../sources/adapters.js';
import { addSource, deleteSource, detectSourceFromUrl, getSource, listSources, updateSource } from '../sources/registry.js';
import { readFile, wipeAllFiles } from '../storage.js';
import { authConfigured, checkPassword, COOKIE, cookieSecure, createSession, destroySession, isAuthenticated, loginRateLimited, requireAuth } from './auth.js';

const idParam = z.object({ id: z.coerce.number().int().positive() });

/** Long-running actions (browser dry runs/submissions) run in the background; one per job. */
const inFlight = new Map<number, string>();
function runInBackground(jobId: number, label: string, fn: () => Promise<unknown>): boolean {
  if (inFlight.has(jobId)) return false;
  inFlight.set(jobId, label);
  fn()
    .catch((err) => {
      logger.error(`${label} failed`, { job: jobId, error: safeErrorMessage(err) });
      addEvent(jobId, 'error', `${label} failed: ${safeErrorMessage(err)}`);
    })
    .finally(() => inFlight.delete(jobId));
  return true;
}
let pipelineRunning = false;

function jobDetail(id: number) {
  const job = getJob(id);
  if (!job) return null;
  const app = getApplication(id);
  const tailored = getCurrentTailored(id);
  const content = tailored ? getTailoredContent(tailored.id) : { resume: null, coverLetter: null };
  const attempt = app ? lastAttempt(app.id) : undefined;
  const resolution = app ? appResolution(app) : null;
  const sightings = all<{ source_type: string; url: string | null }>('SELECT source_type, url FROM job_sightings WHERE job_id = ?', [id]);
  return {
    job: {
      id: job.id,
      title: job.title,
      company: job.company,
      location: job.location,
      workMode: job.work_mode,
      employmentType: job.employment_type,
      salaryText: job.salary_text,
      salaryMin: job.salary_min,
      salaryMax: job.salary_max,
      salaryCurrency: job.salary_currency,
      source: job.source_type,
      sourceUrl: job.source_url,
      applyUrl: job.apply_url,
      ats: job.ats,
      descriptionText: job.description_text,
      descriptionPartial: job.description_partial === 1,
      postedAt: job.posted_at,
      discoveredAt: job.discovered_at,
      lastSeenAt: job.last_seen_at,
      isActive: job.is_active === 1,
      closedReason: job.closed_reason,
      status: job.status,
      statusReason: job.status_reason,
      score: job.score,
      eligible: job.eligible === 1,
      tracks: jobTracks(job),
      dismissed: job.dismissed === 1,
      notes: job.notes,
      sightings,
    },
    match: jobMatch(job),
    application: app
      ? {
          id: app.id,
          adapter: app.adapter,
          adapterLabel: adapterById(app.adapter).label,
          supportsAutoSubmit: adapterById(app.adapter).supportsAutoSubmit,
          state: app.state,
          reviewReason: app.review_reason,
          questions: appQuestions(app),
          resolution: resolution
            ? {
                ...resolution,
                // Values of sensitive answers are shown masked unless the user typed them for this application
                answers: resolution.answers.map((a) => ({ ...a, value: a.sensitive && a.source === 'saved_answer' ? (Array.isArray(a.value) ? a.value : a.value) : a.value })),
              }
            : null,
          userAnswers: appUserAnswers(app),
          attempts: app.attempts,
          submittedAt: app.submitted_at,
          submittedVia: app.submitted_via,
          confirmationText: app.confirmation_text,
          confirmationUrl: app.confirmation_url,
          evidenceFileId: app.evidence_file_id,
          evidenceHtmlFileId: app.evidence_html_file_id,
          lastError: app.last_error,
          nextAction: app.next_action,
          lastAttempt: attempt
            ? { outcome: attempt.outcome, detail: attempt.detail, startedAt: attempt.started_at, finishedAt: attempt.finished_at, dryRun: attempt.dry_run === 1, screenshotFileId: attempt.screenshot_file_id, submitClicked: Boolean(attempt.submit_clicked_at) }
            : null,
          history: listAttempts(app.id).map((a) => ({ id: a.id, outcome: a.outcome, detail: a.detail, startedAt: a.started_at, dryRun: a.dry_run === 1, trigger: a.trigger, screenshotFileId: a.screenshot_file_id })),
        }
      : null,
    resume: tailored ? { ...tailored, content: content.resume, coverLetter: content.coverLetter } : null,
    events: listEvents(id),
    busy: inFlight.get(id) ?? null,
  };
}

async function sendFile(reply: FastifyReply, fileId: number, download: boolean): Promise<void> {
  const { meta, data } = readFile(fileId);
  const inlineSafe = /^(application\/pdf|image\/png|text\/plain)/.test(meta.mime);
  reply.header('Content-Type', meta.mime.startsWith('text/html') ? 'text/plain; charset=utf-8' : meta.mime);
  reply.header('Content-Disposition', `${download || !inlineSafe ? 'attachment' : 'inline'}; filename="${meta.filename.replace(/"/g, '')}"`);
  await reply.send(data);
}

export async function registerRoutes(app: FastifyInstance): Promise<void> {
  // ----------------------------------------------------------------- public
  app.get('/api/health', async () => ({ ok: true, time: nowIso() }));

  app.get('/api/auth/me', async (req) => ({
    authenticated: isAuthenticated(req),
    authConfigured: authConfigured(),
    llmEnabled: llmAvailable(),
    smtpEnabled: getConfig().smtpEnabled,
  }));

  app.post('/api/auth/login', async (req, reply) => {
    if (loginRateLimited(req.ip)) return reply.code(429).send({ error: 'Too many attempts. Try again in 15 minutes.' });
    const { password } = z.object({ password: z.string().min(1).max(500) }).parse(req.body);
    if (!authConfigured()) return reply.code(400).send({ error: 'Set ADMIN_PASSWORD (or ADMIN_PASSWORD_HASH) on the server first.' });
    if (!checkPassword(password)) return reply.code(401).send({ error: 'Wrong password' });
    const { token, expires } = createSession();
    reply.setCookie(COOKIE, token, { httpOnly: true, sameSite: 'strict', secure: cookieSecure(req), path: '/', expires });
    return { ok: true };
  });

  app.post('/api/auth/logout', async (req, reply) => {
    destroySession(req.cookies[COOKIE]);
    reply.clearCookie(COOKIE, { path: '/' });
    return { ok: true };
  });

  // External scheduler trigger for hosts that sleep (e.g. GitHub Actions cron → this endpoint)
  app.post('/api/internal/tick', async (req, reply) => {
    const secret = getConfig().CRON_SECRET;
    const auth = req.headers.authorization ?? '';
    if (!secret || !auth.startsWith('Bearer ') || !safeEqual(auth.slice(7), secret)) return reply.code(401).send({ error: 'Unauthorized' });
    void tick('tick');
    return reply.code(202).send({ accepted: true });
  });

  // ----------------------------------------------------------------- authenticated
  await app.register(async (api) => {
    api.addHook('preHandler', requireAuth);

    api.get('/api/overview', async () => {
      const s = getSettings();
      const rec = getProfileRecord();
      const attention = all<{ id: number; title: string; company: string; status: string; status_reason: string | null; score: number | null }>(
        `SELECT id, title, company, status, status_reason, score FROM jobs WHERE status IN ('needs_input','needs_review','failed') AND dismissed = 0 ORDER BY status_updated_at DESC LIMIT 20`,
      );
      const recent = all('SELECT e.*, j.title, j.company FROM events e LEFT JOIN jobs j ON j.id = e.job_id ORDER BY e.id DESC LIMIT 25');
      return {
        stats: overviewStats(),
        automation: s.automation,
        schedule: s.schedule,
        profile: rec ? { name: rec.profile.name, verified: rec.verified, warnings: rec.warnings, years: experienceYears(rec.profile) } : null,
        attention,
        recent,
        runs: listRuns(5),
        unread: unreadCount(),
        pipelineRunning,
        nextRunHint: s.schedule.enabled ? `every ${s.schedule.discoveryEveryHours}h, digest at ${s.schedule.digestTime} (${s.schedule.timezone})` : 'scheduler disabled',
      };
    });

    // ---- jobs
    api.get('/api/jobs', async (req) => {
      const q = z
        .object({
          track: z.string().optional(),
          status: z.string().optional(),
          q: z.string().max(100).optional(),
          minScore: z.coerce.number().optional(),
          source: z.string().optional(),
          includeDismissed: z.coerce.boolean().optional(),
          includeClosed: z.coerce.boolean().optional(),
          eligibleOnly: z.coerce.boolean().optional(),
          sort: z.enum(['score', 'newest', 'posted']).optional(),
          page: z.coerce.number().optional(),
          pageSize: z.coerce.number().optional(),
        })
        .parse(req.query);
      return listJobs(q);
    });

    api.get('/api/jobs/:id', async (req, reply) => {
      const { id } = idParam.parse(req.params);
      const d = jobDetail(id);
      return d ?? reply.code(404).send({ error: 'Job not found' });
    });

    api.post('/api/jobs/:id/rescore', async (req) => {
      const { id } = idParam.parse(req.params);
      scoreJobs({ jobIds: [id] });
      return jobDetail(id);
    });

    api.post('/api/jobs/:id/tailor', async (req) => {
      const { id } = idParam.parse(req.params);
      await generateTailoredResume(id);
      return jobDetail(id);
    });

    api.post('/api/jobs/:id/prepare', async (req) => {
      const { id } = idParam.parse(req.params);
      await prepareApplication(id);
      return jobDetail(id);
    });

    api.put('/api/jobs/:id/answers', async (req) => {
      const { id } = idParam.parse(req.params);
      const body = z
        .object({
          answers: z.record(z.string(), z.union([z.string().max(5000), z.array(z.string().max(500))])),
          saveToBank: z.record(z.string(), z.enum(ANSWER_CATEGORIES)).optional(),
        })
        .parse(req.body);
      await saveUserAnswers(id, body.answers, body.saveToBank as Record<string, AnswerCategory> | undefined);
      return jobDetail(id);
    });

    api.post('/api/jobs/:id/dry-run', async (req, reply) => {
      const { id } = idParam.parse(req.params);
      const ok = runInBackground(id, 'Dry run', () => submitApplication(id, 'dry_run'));
      return reply.code(ok ? 202 : 409).send(ok ? { started: true } : { error: 'Another action is running for this job' });
    });

    api.post('/api/jobs/:id/approve', async (req, reply) => {
      const { id } = idParam.parse(req.params);
      const { allowDuplicate } = z.object({ allowDuplicate: z.boolean().optional() }).parse(req.body ?? {});
      const ok = runInBackground(id, 'Submission', () => approveAndSubmit(id, { allowDuplicate }));
      return reply.code(ok ? 202 : 409).send(ok ? { started: true } : { error: 'Another action is running for this job' });
    });

    api.post('/api/jobs/:id/mark-submitted', async (req) => {
      const { id } = idParam.parse(req.params);
      let note = '';
      let evidence: { filename: string; mime: string; data: Buffer } | undefined;
      if (req.isMultipart()) {
        for await (const part of req.parts()) {
          if (part.type === 'file') {
            if (!/^(image\/(png|jpe?g|webp)|application\/pdf|message\/rfc822|text\/plain)/.test(part.mimetype)) throw Object.assign(new Error('Evidence must be an image, PDF, text or .eml file'), { statusCode: 400 });
            evidence = { filename: part.filename, mime: part.mimetype, data: await part.toBuffer() };
          } else if (part.fieldname === 'note') note = String(part.value ?? '');
        }
      } else note = z.object({ note: z.string().max(1000) }).parse(req.body).note;
      markSubmittedManually(id, { note, evidence });
      return jobDetail(id);
    });

    api.post('/api/jobs/:id/verify', async (req) => {
      const { id } = idParam.parse(req.params);
      const body = z.object({ submitted: z.boolean(), note: z.string().max(1000).default('') }).parse(req.body);
      resolveUncertain(id, body.submitted, body.note);
      return jobDetail(id);
    });

    api.post('/api/jobs/:id/dismiss', async (req) => {
      const { id } = idParam.parse(req.params);
      const { dismissed } = z.object({ dismissed: z.boolean() }).parse(req.body);
      run('UPDATE jobs SET dismissed = ? WHERE id = ?', [dismissed ? 1 : 0, id]);
      addEvent(id, dismissed ? 'dismissed' : 'restored', dismissed ? 'Dismissed by you' : 'Restored by you');
      recomputeStatus(id);
      return jobDetail(id);
    });

    api.post('/api/jobs/:id/close', async (req) => {
      const { id } = idParam.parse(req.params);
      const { closed } = z.object({ closed: z.boolean() }).parse(req.body);
      if (closed) closeJob(id, 'Marked closed by you');
      else reopenJob(id);
      return jobDetail(id);
    });

    api.put('/api/jobs/:id/notes', async (req) => {
      const { id } = idParam.parse(req.params);
      const { notes } = z.object({ notes: z.string().max(5000) }).parse(req.body);
      run('UPDATE jobs SET notes = ? WHERE id = ?', [notes, id]);
      return { ok: true };
    });

    api.put('/api/jobs/:id/cover-letter', async (req) => {
      const { id } = idParam.parse(req.params);
      const { text } = z.object({ text: z.string().min(20).max(10_000) }).parse(req.body);
      const t = getCurrentTailored(id);
      if (!t) throw Object.assign(new Error('Generate the tailored resume first'), { statusCode: 400 });
      await updateCoverLetter(t.id, text);
      return jobDetail(id);
    });

    api.post('/api/jobs/manual', async (req) => {
      const body = z
        .object({ title: z.string().min(2), company: z.string().min(1), location: z.string().optional(), url: z.string().optional(), description: z.string().min(30).max(100_000) })
        .parse(req.body);
      const res = importJobs([{ ...body, source: 'manual' }], 'manual');
      if (res.errors.length) throw Object.assign(new Error(res.errors.join('; ')), { statusCode: 400 });
      scoreJobs({ jobIds: res.ids });
      return { id: res.ids[0] };
    });

    api.post('/api/jobs/import', async (req) => {
      const body = z.object({ jobs: z.array(z.unknown()).max(500) }).parse(req.body);
      const res = importJobs(body.jobs, 'import');
      scoreJobs({ jobIds: res.ids });
      return res;
    });

    api.post('/api/prior-applications', async (req) => {
      const body = z
        .object({ items: z.array(z.object({ company: z.string().min(1), title: z.string().min(1), appliedAt: z.string().optional(), url: z.string().optional(), note: z.string().optional() })).max(2000) })
        .parse(req.body);
      for (const i of body.items) addPriorApplication(i.company, i.title, i.appliedAt ?? null, i.url ?? null, i.note ?? null);
      return { added: body.items.length };
    });

    api.get('/api/prior-applications', async () => all('SELECT * FROM prior_applications ORDER BY id DESC LIMIT 1000'));

    // ---- applications
    api.get('/api/applications', async () =>
      all(
        `SELECT a.id, a.job_id, a.state, a.review_reason, a.adapter, a.submitted_at, a.submitted_via, a.confirmation_text, a.last_error, a.next_action, a.missing_count, a.attempts, a.updated_at,
                j.title, j.company, j.location, j.score, j.status, j.apply_url
         FROM applications a JOIN jobs j ON j.id = a.job_id ORDER BY a.updated_at DESC LIMIT 500`,
      ),
    );

    // ---- resumes & files
    api.get('/api/resumes', async () => listResumes());

    api.post('/api/resumes/upload', async (req) => {
      const file = await req.file();
      if (!file) throw Object.assign(new Error('No file uploaded'), { statusCode: 400 });
      const data = await file.toBuffer();
      const result = await ingestResume(data, file.filename, file.mimetype);
      return { ...result, record: getProfileRecord() };
    });

    api.get('/api/resumes/:id', async (req, reply) => {
      const { id } = idParam.parse(req.params);
      const r = getResume(id);
      if (!r) return reply.code(404).send({ error: 'Not found' });
      return { ...r, ...(r.kind === 'tailored' ? getTailoredContent(id) : {}) };
    });

    api.get('/api/files/:id', async (req, reply) => {
      const { id } = idParam.parse(req.params);
      const { download } = z.object({ download: z.coerce.boolean().optional() }).parse(req.query);
      await sendFile(reply, id, Boolean(download));
    });

    // ---- profile & answers
    api.get('/api/profile', async () => ({ record: getProfileRecord(), yearsOfExperience: getProfileRecord() ? experienceYears(getProfileRecord()!.profile) : null }));

    api.put('/api/profile', async (req) => {
      const { profile } = z.object({ profile: z.record(z.string(), z.unknown()) }).parse(req.body);
      const p = profile as unknown as CandidateProfile;
      const problems = profileProblems(p);
      if (problems.length) throw Object.assign(new Error(problems.join(' ')), { statusCode: 400 });
      const rec = saveProfile(p, { method: 'manual', keepVerification: true });
      return { record: rec };
    });

    api.post('/api/profile/verify', async () => {
      const rec = verifyProfile();
      scoreJobs({ all: true });
      return { record: rec };
    });

    api.get('/api/answers', async () => listSavedAnswers());
    api.post('/api/answers', async (req) => {
      const body = z
        .object({ id: z.string().optional(), category: z.enum(ANSWER_CATEGORIES), question: z.string().max(1000).optional(), answer: z.string().min(1).max(5000), country: z.string().max(2).optional() })
        .parse(req.body);
      return upsertSavedAnswer(body);
    });
    api.delete('/api/answers/:id', async (req) => {
      const { id } = z.object({ id: z.string() }).parse(req.params);
      deleteSavedAnswer(id);
      return { ok: true };
    });

    // ---- settings & automation
    api.get('/api/settings', async () => ({
      ...getSettings(),
      env: { llmEnabled: llmAvailable(), smtpEnabled: getConfig().smtpEnabled, telegramConfigured: Boolean(getConfig().TELEGRAM_BOT_TOKEN), adzunaConfigured: Boolean(getConfig().ADZUNA_APP_ID && getConfig().ADZUNA_APP_KEY), publicUrl: getConfig().PUBLIC_URL ?? null },
    }));

    api.put('/api/settings/:section', async (req) => {
      const { section } = z.object({ section: z.enum(['preferences', 'automation', 'schedule', 'notifications', 'llm']) }).parse(req.params);
      const updated = updateSection(section as SettingsSection, req.body);
      if (section === 'preferences') scoreJobs({ all: true });
      if (section === 'automation') recomputeAllStatuses();
      return updated;
    });

    api.post('/api/automation/pause', async (req) => {
      const { paused } = z.object({ paused: z.boolean() }).parse(req.body);
      const a = updateSection('automation', { paused });
      addEvent(null, paused ? 'paused' : 'resumed', paused ? 'Automation paused' : 'Automation resumed');
      return a;
    });

    // ---- sources
    api.get('/api/sources', async () => ({
      sources: listSources(),
      types: Object.values(ADAPTERS).map((a) => ({ type: a.type, label: a.label, kind: a.kind, integration: a.integration, terms: a.terms ?? null, configHelp: a.configHelp })),
    }));

    api.post('/api/sources', async (req) => {
      const body = z.object({ url: z.string().optional(), type: z.string().optional(), name: z.string().optional(), config: z.record(z.string(), z.unknown()).optional() }).parse(req.body);
      if (body.url) {
        const d = detectSourceFromUrl(body.url);
        if (!d) throw Object.assign(new Error('Unrecognized careers URL. Supported: Greenhouse, Lever, Ashby and SmartRecruiters job boards.'), { statusCode: 400 });
        return addSource(d.type, d.name, { ...d.config, ...(body.name ? { companyName: body.name } : {}) });
      }
      if (!body.type) throw Object.assign(new Error('Provide a careers URL or a source type'), { statusCode: 400 });
      return addSource(body.type, body.name ?? body.type, body.config ?? {});
    });

    api.put('/api/sources/:id', async (req) => {
      const { id } = idParam.parse(req.params);
      const body = z.object({ enabled: z.boolean().optional(), config: z.record(z.string(), z.unknown()).optional(), minIntervalMinutes: z.number().int().min(30).max(10080).optional() }).parse(req.body);
      return updateSource(id, body);
    });

    api.delete('/api/sources/:id', async (req) => {
      const { id } = idParam.parse(req.params);
      deleteSource(id);
      return { ok: true };
    });

    api.post('/api/sources/:id/test', async (req) => {
      const { id } = idParam.parse(req.params);
      if (!getSource(id)) throw Object.assign(new Error('Source not found'), { statusCode: 404 });
      const summary = await discover({ sourceIds: [id] });
      scoreJobs();
      return { summary, source: getSource(id) };
    });

    // ---- pipeline / runs
    api.post('/api/pipeline/run', async (req, reply) => {
      const body = z.object({ steps: z.array(z.enum(['discover', 'score', 'tailor', 'prepare', 'apply'])).optional(), force: z.boolean().optional() }).parse(req.body ?? {});
      if (pipelineRunning) return reply.code(409).send({ error: 'A run is already in progress' });
      pipelineRunning = true;
      runPipeline({ trigger: 'manual', steps: body.steps as PipelineStep[] | undefined, force: body.force ?? true })
        .catch((err) => logger.error('Manual pipeline failed', { error: safeErrorMessage(err) }))
        .finally(() => (pipelineRunning = false));
      return reply.code(202).send({ started: true });
    });

    api.get('/api/runs', async () => listRuns(50));

    // ---- notifications & digest
    api.get('/api/notifications', async () => ({ items: listNotifications(100), unread: unreadCount() }));
    api.post('/api/notifications/read', async (req) => {
      const { id } = z.object({ id: z.number().optional() }).parse(req.body ?? {});
      markRead(id);
      return { ok: true };
    });
    api.post('/api/notifications/test', async () => deliver({ kind: 'test', title: 'Test notification', body: 'If you can read this, notifications from Job Autopilot work.' }));
    api.get('/api/digest/preview', async () => {
      const d = buildDigest();
      return { data: d, ...renderDigest(d) };
    });

    // ---- data export & deletion
    api.get('/api/data/export', async (_req, reply) => {
      const exportData = {
        exportedAt: nowIso(),
        profile: getProfileRecord(),
        answers: listSavedAnswers(),
        settings: getSettings(),
        jobs: all('SELECT id, title, company, location, status, score, source_type, source_url, apply_url, discovered_at, posted_at, notes FROM jobs'),
        applications: all('SELECT job_id, state, submitted_at, submitted_via, confirmation_text, confirmation_url, last_error FROM applications'),
        priorApplications: all('SELECT * FROM prior_applications'),
      };
      reply.header('Content-Disposition', 'attachment; filename="job-autopilot-export.json"');
      return exportData;
    });

    api.delete('/api/data', async (req, reply) => {
      const { confirm } = z.object({ confirm: z.string() }).parse(req.body);
      if (confirm !== 'DELETE MY DATA') return reply.code(400).send({ error: 'Type DELETE MY DATA to confirm' });
      wipeAllTables();
      wipeAllFiles();
      logger.warn('All stored data deleted by user');
      reply.clearCookie(COOKIE, { path: '/' });
      return { ok: true };
    });

    api.get('/api/meta/session-check', async (req: FastifyRequest) => ({ ok: isAuthenticated(req) }));
    void get;
  });
}
