import { closeBrowser } from './applications/browser.js';
import { getApplication, prepareApplication, retryableFailed, submitApplication, type SubmitOutcome } from './applications/engine.js';
import { all, get, nowIso, parseJson, run } from './db.js';
import { discover, type DiscoverySummary } from './discovery.js';
import { getJob, recomputeStatus, type JobRow } from './jobs.js';
import { logger, safeErrorMessage } from './logger.js';
import { scoreJob, SCORING_VERSION } from './matching.js';
import { notifySoon } from './notifications.js';
import { getProfileRecord } from './profile/store.js';
import { generateTailoredResume, getCurrentTailored } from './resumes.js';
import { getSettings } from './settings.js';
import type { SourceContext } from './sources/common.js';

/**
 * The end-to-end pipeline: discover → score → tailor → prepare → apply (per your rules).
 * Each step is idempotent so the scheduler can run it repeatedly.
 */

export type PipelineStep = 'discover' | 'score' | 'tailor' | 'prepare' | 'apply';
export const ALL_STEPS: PipelineStep[] = ['discover', 'score', 'tailor', 'prepare', 'apply'];

export interface PipelineSummary {
  discovery?: DiscoverySummary;
  scored: number;
  matched: number;
  tailored: number;
  prepared: number;
  apply: { attempted: number; submitted: number; dryRuns: number; needsReview: number; needsInput: number; failed: number; deferred: number };
  errors: string[];
  skippedReason?: string;
}

// ---------------------------------------------------------------------------
// Locks (prevents two pipeline runs at once, across processes)
// ---------------------------------------------------------------------------
export function acquireLock(name: string, owner: string, ttlMs: number): boolean {
  const now = nowIso();
  const expires = new Date(Date.now() + ttlMs).toISOString();
  const res = run(
    `INSERT INTO locks (name, owner, expires_at) VALUES (:name, :owner, :expires)
     ON CONFLICT(name) DO UPDATE SET owner = excluded.owner, expires_at = excluded.expires_at
     WHERE locks.expires_at < :now OR locks.owner = :owner`,
    { name, owner, expires, now },
  );
  return res.changes === 1;
}

export function releaseLock(name: string, owner: string): void {
  run('DELETE FROM locks WHERE name = ? AND owner = ?', [name, owner]);
}

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------
export function scoreJobs(opts: { all?: boolean; jobIds?: number[] } = {}): { scored: number; matched: number } {
  const rec = getProfileRecord();
  if (!rec) return { scored: 0, matched: 0 };
  const { preferences, automation } = getSettings();
  const rows = opts.jobIds
    ? opts.jobIds.map((id) => getJob(id)).filter((j): j is JobRow => Boolean(j))
    : all<JobRow>(
        `SELECT * FROM jobs WHERE is_active = 1 AND dismissed = 0 ${opts.all ? '' : 'AND (scored_at IS NULL OR scoring_version IS NULL OR scoring_version < :v OR scored_at < :profileAt OR scored_at < :prefsAt)'}`,
        opts.all ? {} : { v: SCORING_VERSION, profileAt: rec.updatedAt, prefsAt: get<{ u: string }>("SELECT COALESCE(MAX(updated_at), '') AS u FROM settings WHERE key IN ('preferences', 'automation')")?.u ?? '' },
      );
  let matched = 0;
  for (const job of rows) {
    const m = scoreJob(
      {
        title: job.title,
        company: job.company,
        location: job.location,
        workMode: job.work_mode,
        employmentType: job.employment_type,
        descriptionText: job.description_text ?? '',
        postedAt: job.posted_at,
        salaryMin: job.salary_min,
        salaryMax: job.salary_max,
        salaryCurrency: job.salary_currency,
      },
      rec.profile,
      preferences,
    );
    run('UPDATE jobs SET score = ?, eligible = ?, tracks = ?, match_json = ?, scored_at = ?, scoring_version = ? WHERE id = ?', [
      m.score,
      m.eligible ? 1 : 0,
      JSON.stringify(m.tracks),
      JSON.stringify(m),
      nowIso(),
      SCORING_VERSION,
      job.id,
    ]);
    if (m.eligible && m.score >= automation.matchThreshold) matched++;
    recomputeStatus(job.id);
  }
  return { scored: rows.length, matched };
}

function candidates(limit: number, statuses: string[]): JobRow[] {
  const { automation } = getSettings();
  return all<JobRow>(
    `SELECT * FROM jobs WHERE is_active = 1 AND dismissed = 0 AND eligible = 1 AND score >= ? AND status IN (${statuses.map(() => '?').join(',')})
     ORDER BY score DESC, discovered_at DESC LIMIT ?`,
    [automation.matchThreshold, ...statuses, limit],
  );
}

export async function tailorMatched(limit = 25): Promise<{ tailored: number; errors: string[] }> {
  let tailored = 0;
  const errors: string[] = [];
  for (const job of candidates(limit, ['matched', 'resume_ready', 'needs_input', 'needs_review'])) {
    const cur = getCurrentTailored(job.id);
    if (cur && !cur.stale) continue;
    try {
      await generateTailoredResume(job.id);
      tailored++;
    } catch (err) {
      errors.push(`Tailor ${job.title} @ ${job.company}: ${safeErrorMessage(err)}`);
    }
  }
  return { tailored, errors };
}

export async function prepareReady(limit = 25): Promise<{ prepared: number; errors: string[] }> {
  let prepared = 0;
  const errors: string[] = [];
  for (const job of candidates(limit, ['resume_ready', 'needs_input'])) {
    const app = getApplication(job.id);
    if (app && !['draft', 'needs_input'].includes(app.state)) continue;
    try {
      await prepareApplication(job.id);
      prepared++;
    } catch (err) {
      errors.push(`Prepare ${job.title} @ ${job.company}: ${safeErrorMessage(err)}`);
    }
  }
  return { prepared, errors };
}

export async function applyEligible(): Promise<PipelineSummary['apply'] & { errors: string[] }> {
  const { automation } = getSettings();
  const out = { attempted: 0, submitted: 0, dryRuns: 0, needsReview: 0, needsInput: 0, failed: 0, deferred: 0, errors: [] as string[] };
  if (automation.paused) return out;
  const readyIds = all<{ job_id: number }>(
    `SELECT a.job_id FROM applications a JOIN jobs j ON j.id = a.job_id
     WHERE a.state = 'ready' AND j.is_active = 1 AND j.dismissed = 0 ORDER BY j.score DESC LIMIT ?`,
    [automation.maxPerRun],
  ).map((r) => r.job_id);
  const ids = [...new Set([...readyIds, ...retryableFailed()])].slice(0, automation.maxPerRun);
  let browserUsed = false;
  for (const [i, jobId] of ids.entries()) {
    if (getSettings().automation.paused) break;
    let res: SubmitOutcome;
    try {
      res = await submitApplication(jobId, 'auto');
    } catch (err) {
      out.errors.push(safeErrorMessage(err));
      continue;
    }
    out.attempted++;
    if (['submitted', 'dry_run_complete', 'uncertain', 'blocked', 'failed'].includes(res.outcome)) browserUsed = true;
    if (res.outcome === 'submitted') out.submitted++;
    else if (res.outcome === 'dry_run_complete') out.dryRuns++;
    else if (res.outcome === 'needs_input') out.needsInput++;
    else if (res.outcome === 'failed') out.failed++;
    else if (res.outcome === 'deferred') {
      out.deferred++;
      if (/limit|paused/i.test(res.detail)) break;
    } else out.needsReview++;
    if (browserUsed && i < ids.length - 1) await new Promise((r) => setTimeout(r, automation.delayBetweenApplicationsSec * 1000));
  }
  if (browserUsed) await closeBrowser();
  return out;
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------
export async function runPipeline(opts: { steps?: PipelineStep[]; trigger: 'schedule' | 'manual' | 'tick' | 'cli'; force?: boolean; ctx?: SourceContext }): Promise<PipelineSummary & { runId: number }> {
  const steps = opts.steps ?? ALL_STEPS;
  const owner = `pipeline-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  const runId = run('INSERT INTO runs (kind, trigger, started_at, status) VALUES (?, ?, ?, ?)', ['pipeline', opts.trigger, nowIso(), 'running']).lastInsertRowid;
  const summary: PipelineSummary = { scored: 0, matched: 0, tailored: 0, prepared: 0, apply: { attempted: 0, submitted: 0, dryRuns: 0, needsReview: 0, needsInput: 0, failed: 0, deferred: 0 }, errors: [] };
  if (!acquireLock('pipeline', owner, 60 * 60_000)) {
    summary.skippedReason = 'Another pipeline run is in progress';
    run('UPDATE runs SET finished_at = ?, status = ?, summary_json = ? WHERE id = ?', [nowIso(), 'skipped', JSON.stringify(summary), runId]);
    return { ...summary, runId };
  }
  try {
    const hasProfile = Boolean(getProfileRecord());
    if (steps.includes('discover')) {
      summary.discovery = await discover({ force: opts.force, ctx: opts.ctx });
      summary.errors.push(...summary.discovery.errors.map((e) => `${e.source}: ${e.error}`));
      if (summary.discovery.sourcesFailed > 0 && summary.discovery.sourcesRun === 0) {
        notifySoon({ kind: 'source_error', title: 'All job sources failed', body: summary.discovery.errors.map((e) => `${e.source}: ${e.error}`).join('\n') });
      }
    }
    if (!hasProfile) {
      summary.skippedReason = 'Upload your resume to enable scoring, tailoring and applications';
    } else {
      if (steps.includes('score')) Object.assign(summary, scoreJobs());
      const { automation } = getSettings();
      if (steps.includes('tailor') && automation.autoTailor) {
        const t = await tailorMatched();
        summary.tailored = t.tailored;
        summary.errors.push(...t.errors);
      }
      if (steps.includes('prepare')) {
        const p = await prepareReady();
        summary.prepared = p.prepared;
        summary.errors.push(...p.errors);
      }
      if (steps.includes('apply')) {
        const a = await applyEligible();
        summary.apply = { attempted: a.attempted, submitted: a.submitted, dryRuns: a.dryRuns, needsReview: a.needsReview, needsInput: a.needsInput, failed: a.failed, deferred: a.deferred };
        summary.errors.push(...a.errors);
      }
    }
    run('UPDATE runs SET finished_at = ?, status = ?, summary_json = ? WHERE id = ?', [nowIso(), summary.errors.length ? 'partial' : 'success', JSON.stringify(summary), runId]);
  } catch (err) {
    logger.error('Pipeline failed', { error: safeErrorMessage(err) });
    run('UPDATE runs SET finished_at = ?, status = ?, summary_json = ?, error = ? WHERE id = ?', [nowIso(), 'error', JSON.stringify(summary), safeErrorMessage(err), runId]);
    summary.errors.push(safeErrorMessage(err));
  } finally {
    releaseLock('pipeline', owner);
  }
  return { ...summary, runId };
}

export function listRuns(limit = 30): Array<Record<string, unknown>> {
  return all('SELECT * FROM runs ORDER BY id DESC LIMIT ?', [limit]).map((r) => ({ ...r, summary: parseJson(r.summary_json, null) }));
}
