import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeBrowser } from '../../src/server/applications/browser.js';
import {
  approveAndSubmit,
  gateAutoSubmit,
  getApplication,
  recoverInterrupted,
  saveUserAnswers,
  submitApplication,
} from '../../src/server/applications/engine.js';
import { all, get, nowIso, run } from '../../src/server/db.js';
import { buildDigest } from '../../src/server/digest.js';
import { getJob, upsertJob } from '../../src/server/jobs.js';
import { importJobs } from '../../src/server/importer.js';
import { applyEligible, runPipeline, scoreJobs } from '../../src/server/pipeline.js';
import { updateSection } from '../../src/server/settings.js';
import { addSource } from '../../src/server/sources/registry.js';
import { readFile } from '../../src/server/storage.js';
import { setupTestEnv, storeSampleProfile } from '../helpers.js';
import { startMockAts, type MockAts } from '../mock-ats.js';

let mock: MockAts;
const env = setupTestEnv({ SUBMIT_CONFIRM_TIMEOUT_MS: '4000', BROWSER_TIMEOUT_MS: '15000' });

beforeAll(async () => {
  mock = await startMockAts();
  storeSampleProfile(true);
  updateSection('preferences', { locations: ['Pune'], country: 'IN', remoteRegions: ['India', 'APAC', 'Worldwide', 'Anywhere'] });
  updateSection('automation', { delayBetweenApplicationsSec: 5 });
  addSource('greenhouse', 'acme', { board: 'acme', companyName: 'Acme', apiBase: mock.url, formBase: mock.url });
  addSource('lever', 'globex', { company: 'globex', companyName: 'Globex', apiBase: mock.url });
});

afterAll(async () => {
  await closeBrowser();
  await mock.close();
  env.cleanup();
});

const jobId = (externalId: string) => get<{ id: number }>('SELECT id FROM jobs WHERE external_id = ?', [externalId])!.id;
const status = (id: number) => getJob(id)!.status;

function addGreenhouseVariant(board: 'captcha' | 'login' | 'silent'): number {
  const src = addSource('greenhouse', board, { board, companyName: `${board} Co`, apiBase: mock.url, formBase: mock.url });
  const { id } = upsertJob(
    {
      sourceType: 'greenhouse',
      externalId: `${board}:1001`,
      title: 'Frontend Engineer',
      company: `${board} Co`,
      location: 'Pune, India',
      workMode: 'hybrid',
      employmentType: 'full_time',
      sourceUrl: null,
      applyUrl: null,
      ats: 'greenhouse',
      atsBoard: board,
      atsJobId: '1001',
      descriptionText: 'Requirements:\n• React and TypeScript\n• 1+ years of experience',
      postedAt: nowIso(),
    },
    src.id,
  );
  scoreJobs({ jobIds: [id] });
  return id;
}

describe('end-to-end pipeline against local mock Greenhouse/Lever forms', () => {
  it('discovers, scores, tailors and stops at Needs input for sensitive questions (nothing submitted)', async () => {
    const res = await runPipeline({ trigger: 'cli', force: true });
    expect(res.discovery?.inserted).toBe(4); // 2 acme + 2 globex (sales role filtered out)
    const fe = jobId('acme:1001');
    expect(getJob(fe)!.score).toBeGreaterThanOrEqual(70);
    expect(status(jobId('acme:1002'))).toBe('found'); // senior role: ineligible
    expect(getJob(jobId('acme:1002'))!.eligible, getJob(jobId('acme:1002'))!.match_json ?? '').toBe(0);
    expect(status(fe)).toBe('needs_input');
    const app = getApplication(fe)!;
    expect(app.missing_count).toBe(2);
    expect(mock.submissions).toHaveLength(0);
    // ML research role from Lever is not matched
    const ml = all<{ eligible: number; tracks: string }>("SELECT eligible, tracks FROM jobs WHERE title = 'Machine Learning Engineer'")[0];
    expect(ml.eligible).toBe(0);
    expect(JSON.parse(ml.tracks)).toContain('ml_research');
  });

  it('after answering, review mode waits for approval and a dry run fills but never submits', async () => {
    const fe = jobId('acme:1001');
    await saveUserAnswers(fe, { question_2002: 'Yes', question_2003: 'No' }, { question_2002: 'work_authorization', question_2003: 'sponsorship' });
    expect(getApplication(fe)!.state).toBe('ready');
    const apply = await applyEligible();
    expect(apply.needsReview).toBeGreaterThanOrEqual(1);
    expect(status(fe)).toBe('needs_review');
    expect(getApplication(fe)!.review_reason).toBe('review_mode');

    const dry = await submitApplication(fe, 'dry_run');
    expect(dry.outcome, dry.detail).toBe('dry_run_complete');
    expect(mock.submissions).toHaveLength(0);
    const attempt = get<{ screenshot_file_id: number; submit_clicked_at: string | null }>('SELECT * FROM application_attempts ORDER BY id DESC LIMIT 1')!;
    expect(attempt.submit_clicked_at).toBeNull();
    expect(readFile(attempt.screenshot_file_id).data.subarray(1, 4).toString()).toBe('PNG');
    expect(getApplication(fe)!.review_reason).toBe('dry_run_complete');
  });

  it('approval with global dry-run ON still does not submit', async () => {
    const fe = jobId('acme:1001');
    const res = await approveAndSubmit(fe);
    expect(res.outcome, res.detail).toBe('dry_run_complete');
    expect(mock.submissions).toHaveLength(0);
  });

  it('submits for real only with dry-run off, records confirmation evidence, and never submits twice', async () => {
    updateSection('automation', { dryRun: false });
    const fe = jobId('acme:1001');
    const res = await approveAndSubmit(fe);
    expect(res.outcome, res.detail).toBe('submitted');
    expect(mock.submissions).toHaveLength(1);
    const body = mock.submissions[0].body;
    expect(body).toContain('Asha');
    expect(body).toContain('asha.rao@example.com');
    expect(body).toContain('application/pdf');
    const app = getApplication(fe)!;
    expect(app.state).toBe('submitted');
    expect(app.confirmation_text).toMatch(/thank you for applying|submitted/i);
    expect(app.confirmation_url).toMatch(/\/confirmation$/);
    expect(app.evidence_file_id).toBeTruthy();
    expect(status(fe)).toBe('submitted');

    const again = await approveAndSubmit(fe);
    expect(again.outcome, again.detail).toBe('skipped');
    const auto = await submitApplication(fe, 'auto');
    expect(auto.outcome, auto.detail).toBe('skipped');
    expect(mock.submissions).toHaveLength(1);
  });

  it('flags the same role at the same company found elsewhere as a possible duplicate', async () => {
    const imp = importJobs([{ title: 'Frontend Engineer', company: 'Acme', location: 'Remote', description: 'Requirements: React, TypeScript, CSS, accessibility, 1+ years of experience' }]);
    const id = imp.ids[0];
    scoreJobs({ jobIds: [id] });
    run("UPDATE jobs SET ats = 'greenhouse', ats_board = 'acme', ats_job_id = '1001', source_id = (SELECT id FROM sources WHERE name = 'acme') WHERE id = ?", [id]);
    const res = await approveAndSubmit(id);
    expect(res.outcome, res.detail).toBe('needs_review');
    expect(getApplication(id)!.review_reason).toBe('possible_duplicate');
    expect(mock.submissions).toHaveLength(1);
  });

  it('stops at a visible CAPTCHA without submitting', async () => {
    const id = addGreenhouseVariant('captcha');
    const res = await approveAndSubmit(id);
    expect(res.outcome, res.detail).toBe('blocked');
    expect(getApplication(id)!.review_reason).toBe('captcha');
    expect(status(id)).toBe('needs_review');
    expect(mock.submissions.filter((s) => s.path.startsWith('/captcha'))).toHaveLength(0);
  });

  it('stops at a login wall', async () => {
    const id = addGreenhouseVariant('login');
    const res = await approveAndSubmit(id);
    expect(res.outcome, res.detail).toBe('blocked');
    expect(getApplication(id)!.review_reason).toBe('login_required');
  });

  it('marks a submission without confirmation as uncertain and never retries it automatically', async () => {
    const id = addGreenhouseVariant('silent');
    const res = await approveAndSubmit(id);
    expect(res.outcome, res.detail).toBe('uncertain');
    expect(getApplication(id)!.state).toBe('uncertain');
    expect(status(id)).toBe('needs_review');
    const before = mock.submissions.length;
    updateSection('automation', { mode: 'auto' });
    await applyEligible();
    await submitApplication(id, 'auto');
    expect(mock.submissions.length).toBe(before);
    updateSection('automation', { mode: 'review' });
  });

  it('Lever: unknown custom required question → Needs input; answered → submitted', async () => {
    const id = jobId('globex:a1b2c3d4-0000-4000-8000-000000000001');
    expect(getJob(id)!.eligible).toBe(1);
    const res = await submitApplication(id, 'approve');
    expect(res.outcome, res.detail).toBe('needs_input');
    const app = getApplication(id)!;
    expect(app.state).toBe('needs_input');
    const qid = 'cards[card-1][field0]';
    await saveUserAnswers(id, { [qid]: 'I enjoy building accessible React interfaces and Globex builds tools I use.' });
    const sub = await approveAndSubmit(id);
    expect(sub.outcome, sub.detail).toBe('submitted');
    expect(getApplication(id)!.confirmation_url).toMatch(/\/thanks$/);
  });

  it('automatic mode respects the daily limit, verification and threshold gates', async () => {
    updateSection('automation', { mode: 'auto', dailyLimit: 2 });
    const job = getJob(jobId('acme:1001'))!;
    const fake = { ...getApplication(job.id)!, state: 'ready' as const };
    expect(gateAutoSubmit(job, fake)).toMatchObject({ ok: false, reason: 'daily_limit', defer: true });
    updateSection('automation', { dailyLimit: 10, matchThreshold: 99 });
    expect(gateAutoSubmit(job, fake)).toMatchObject({ ok: false, reason: 'below_threshold' });
    updateSection('automation', { matchThreshold: 70, paused: true });
    expect(gateAutoSubmit(job, fake)).toMatchObject({ ok: false, reason: 'paused' });
    updateSection('automation', { paused: false, mode: 'review' });
  });

  it('recovers an attempt interrupted after the submit click as uncertain (no blind retry)', () => {
    const id = jobId('globex:a1b2c3d4-0000-4000-8000-000000000002');
    run(`INSERT INTO applications (job_id, company_title_key, adapter, state, idempotency_key, created_at, updated_at) VALUES (?, 'k', 'lever', 'submitting', 'idem-x', ?, ?)`, [id, nowIso(), nowIso()]);
    const appId = getApplication(id)!.id;
    run(`INSERT INTO application_attempts (application_id, started_at, dry_run, trigger, worker_id, submit_clicked_at) VALUES (?, ?, 0, 'auto', 'dead-worker', ?)`, [appId, nowIso(), nowIso()]);
    expect(recoverInterrupted()).toBe(1);
    expect(getApplication(id)!.state).toBe('uncertain');
  });

  it('digest only counts confirmed submissions', () => {
    const d = buildDigest(new Date(Date.now() - 3600_000).toISOString());
    expect(d.submitted.map((s) => s.company).sort()).toEqual(['Acme', 'Globex']);
    expect(d.dryRuns).toBeGreaterThanOrEqual(2);
    expect(d.attention.length).toBeGreaterThanOrEqual(3); // captcha, login, uncertain, duplicate
  });
});
