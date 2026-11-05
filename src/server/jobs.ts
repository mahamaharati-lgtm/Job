import type { JobListItem, JobStatus, MatchResult, Paged, Track, WorkMode } from '../shared/types.js';
import { sha256 } from './crypto.js';
import { all, get, nowIso, parseJson, run, tx } from './db.js';
import { getSection } from './settings.js';
import type { NormalizedJob } from './sources/common.js';
import { companyTitleKey, normalizeCompany, normalizeLocation, normalizeTitle } from './text.js';

/** Job records, deduplication keys, events and status derivation. */

export interface JobRow {
  id: number;
  fingerprint: string;
  company_title_key: string;
  source_type: string;
  source_id: number | null;
  external_id: string | null;
  title: string;
  company: string;
  location: string | null;
  work_mode: WorkMode;
  employment_type: string;
  salary_text: string | null;
  salary_min: number | null;
  salary_max: number | null;
  salary_currency: string | null;
  source_url: string | null;
  apply_url: string | null;
  ats: string | null;
  ats_board: string | null;
  ats_job_id: string | null;
  description_html: string | null;
  description_text: string | null;
  description_partial: number;
  posted_at: string | null;
  discovered_at: string;
  last_seen_at: string;
  last_checked_at: string | null;
  missed_runs: number;
  is_active: number;
  closed_at: string | null;
  closed_reason: string | null;
  status: JobStatus;
  status_reason: string | null;
  status_updated_at: string;
  tracks: string;
  score: number | null;
  eligible: number;
  match_json: string | null;
  scored_at: string | null;
  scoring_version: number | null;
  dismissed: number;
  notes: string | null;
}

export function jobFingerprint(company: string, title: string, location: string | null): string {
  return sha256(`${normalizeCompany(company)}|${normalizeTitle(title)}|${normalizeLocation(location)}`).slice(0, 32);
}

export function getJob(id: number): JobRow | undefined {
  return get<JobRow>('SELECT * FROM jobs WHERE id = ?', [id]);
}

export function jobMatch(job: JobRow): MatchResult | null {
  return parseJson<MatchResult | null>(job.match_json, null);
}

export function jobTracks(job: JobRow): Track[] {
  return parseJson<Track[]>(job.tracks, []);
}

export function addEvent(jobId: number | null, type: string, message: string, applicationId: number | null = null): void {
  run('INSERT INTO events (job_id, application_id, type, message, created_at) VALUES (?, ?, ?, ?, ?)', [jobId, applicationId, type, message, nowIso()]);
}

export type UpsertOutcome = 'inserted' | 'updated' | 'merged';

/**
 * Insert or update a job. Duplicates are detected by (source, external id), by previous
 * sightings, and by a company+title+location fingerprint across sources.
 */
export function upsertJob(j: NormalizedJob, sourceId: number | null): { id: number; outcome: UpsertOutcome } {
  const now = nowIso();
  return tx(() => {
    const bySource =
      get<{ id: number }>('SELECT id FROM jobs WHERE source_type = ? AND external_id = ?', [j.sourceType, j.externalId]) ??
      get<{ id: number }>('SELECT job_id AS id FROM job_sightings WHERE source_type = ? AND external_id = ?', [j.sourceType, j.externalId]);
    if (bySource) {
      run(
        `UPDATE jobs SET last_seen_at = :now, missed_runs = 0,
           description_html = COALESCE(:html, description_html),
           description_text = CASE WHEN length(:text) > length(COALESCE(description_text, '')) THEN :text ELSE description_text END,
           apply_url = COALESCE(apply_url, :apply), source_url = COALESCE(source_url, :src)
         WHERE id = :id`,
        { now, html: j.descriptionHtml ?? null, text: j.descriptionText ?? '', apply: j.applyUrl, src: j.sourceUrl, id: bySource.id },
      );
      run('UPDATE job_sightings SET last_seen_at = ? WHERE source_type = ? AND external_id = ?', [now, j.sourceType, j.externalId]);
      return { id: bySource.id, outcome: 'updated' as const };
    }
    const fp = jobFingerprint(j.company, j.title, j.location);
    const byFp = get<{ id: number; ats: string | null; description_partial: number }>('SELECT id, ats, description_partial FROM jobs WHERE fingerprint = ?', [fp]);
    if (byFp) {
      // Same job seen on another source: keep one record, prefer direct ATS links and full descriptions.
      run(
        `INSERT INTO job_sightings (job_id, source_type, external_id, url, first_seen_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(source_type, external_id) DO UPDATE SET last_seen_at = excluded.last_seen_at`,
        [byFp.id, j.sourceType, j.externalId, j.sourceUrl, now, now],
      );
      const upgrade = !byFp.ats && j.ats;
      const betterText = byFp.description_partial === 1 && !j.descriptionPartial;
      run(
        `UPDATE jobs SET last_seen_at = :now, missed_runs = 0
           ${upgrade ? ', ats = :ats, ats_board = :board, ats_job_id = :atsJob, apply_url = :apply' : ''}
           ${betterText ? ', description_html = :html, description_text = :text, description_partial = 0' : ''}
         WHERE id = :id`,
        {
          now,
          id: byFp.id,
          ...(upgrade ? { ats: j.ats, board: j.atsBoard, atsJob: j.atsJobId, apply: j.applyUrl } : {}),
          ...(betterText ? { html: j.descriptionHtml ?? null, text: j.descriptionText } : {}),
        },
      );
      return { id: byFp.id, outcome: 'merged' as const };
    }
    const res = run(
      `INSERT INTO jobs (fingerprint, company_title_key, source_type, source_id, external_id, title, company, location, work_mode,
         employment_type, salary_text, salary_min, salary_max, salary_currency, source_url, apply_url, ats, ats_board, ats_job_id,
         description_html, description_text, description_partial, posted_at, discovered_at, last_seen_at, status, status_updated_at)
       VALUES (:fp, :ctk, :st, :sid, :ext, :title, :company, :location, :wm, :et, :salText, :salMin, :salMax, :salCur, :src, :apply,
         :ats, :board, :atsJob, :html, :text, :partial, :posted, :now, :now, 'found', :now)`,
      {
        fp,
        ctk: companyTitleKey(j.company, j.title),
        st: j.sourceType,
        sid: sourceId,
        ext: j.externalId,
        title: j.title,
        company: j.company,
        location: j.location,
        wm: j.workMode,
        et: j.employmentType,
        salText: j.salaryText ?? null,
        salMin: j.salaryMin ?? null,
        salMax: j.salaryMax ?? null,
        salCur: j.salaryCurrency ?? null,
        src: j.sourceUrl,
        apply: j.applyUrl,
        ats: j.ats ?? null,
        board: j.atsBoard ?? null,
        atsJob: j.atsJobId ?? null,
        html: j.descriptionHtml ?? null,
        text: j.descriptionText,
        partial: j.descriptionPartial ? 1 : 0,
        posted: j.postedAt ?? null,
        now,
      },
    );
    run(
      'INSERT INTO job_sightings (job_id, source_type, external_id, url, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING',
      [res.lastInsertRowid, j.sourceType, j.externalId, j.sourceUrl, now, now],
    );
    addEvent(res.lastInsertRowid, 'discovered', `Discovered via ${j.sourceType}`);
    return { id: res.lastInsertRowid, outcome: 'inserted' as const };
  });
}

export function closeJob(id: number, reason: string): void {
  const job = getJob(id);
  if (!job || job.is_active === 0) return;
  run('UPDATE jobs SET is_active = 0, closed_at = ?, closed_reason = ? WHERE id = ?', [nowIso(), reason, id]);
  addEvent(id, 'closed', reason);
  recomputeStatus(id);
}

export function reopenJob(id: number): void {
  run('UPDATE jobs SET is_active = 1, closed_at = NULL, closed_reason = NULL, missed_runs = 0 WHERE id = ?', [id]);
  recomputeStatus(id);
}

interface StatusInputs {
  appState: string | null;
  reviewReason: string | null;
  lastError: string | null;
  missing: number;
  hasResume: boolean;
}

/** Derive the user-facing status from the job, its application and its tailored resume. */
export function recomputeStatus(jobId: number): JobStatus {
  const job = getJob(jobId);
  if (!job) return 'found';
  const app = get<{ state: string; review_reason: string | null; last_error: string | null; missing_count: number }>(
    'SELECT state, review_reason, last_error, missing_count FROM applications WHERE job_id = ?',
    [jobId],
  );
  const inputs: StatusInputs = {
    appState: app?.state ?? null,
    reviewReason: app?.review_reason ?? null,
    lastError: app?.last_error ?? null,
    missing: app?.missing_count ?? 0,
    hasResume: Boolean(get('SELECT 1 FROM resumes WHERE job_id = ? AND kind = ? AND is_current = 1', [jobId, 'tailored'])),
  };
  const threshold = getSection('automation').matchThreshold;
  let status: JobStatus = 'found';
  let reason: string | null = null;
  if (inputs.appState === 'submitted') {
    status = 'submitted';
    reason = job.is_active ? null : 'Posting has since closed';
  } else if (job.dismissed) {
    status = 'closed';
    reason = 'Dismissed by you';
  } else if (!job.is_active) {
    status = 'closed';
    reason = job.closed_reason;
  } else if (inputs.appState === 'needs_input') {
    status = 'needs_input';
    reason = `${inputs.missing} answer${inputs.missing === 1 ? '' : 's'} needed`;
  } else if (inputs.appState && ['needs_review', 'uncertain', 'approved', 'submitting'].includes(inputs.appState)) {
    status = 'needs_review';
    reason =
      inputs.appState === 'uncertain'
        ? 'verify_submission'
        : inputs.appState === 'submitting'
          ? 'Submitting…'
          : inputs.appState === 'approved'
            ? 'Approved — queued for submission'
            : inputs.reviewReason;
  } else if (inputs.appState === 'failed') {
    status = 'failed';
    reason = inputs.lastError;
  } else if (inputs.appState === 'ready' || inputs.hasResume) {
    status = 'resume_ready';
    reason = inputs.appState === 'ready' ? 'Answers complete' : null;
  } else if (job.score !== null && job.eligible === 1 && job.score >= threshold) {
    status = 'matched';
  } else if (job.score !== null && job.eligible === 0) {
    reason = 'Ineligible: see conflicts';
  } else if (job.score !== null) {
    reason = 'Below match threshold';
  }
  if (status !== job.status || reason !== job.status_reason) {
    run('UPDATE jobs SET status = ?, status_reason = ?, status_updated_at = ? WHERE id = ?', [status, reason, nowIso(), jobId]);
  }
  return status;
}

export function recomputeAllStatuses(): void {
  for (const { id } of all<{ id: number }>('SELECT id FROM jobs')) recomputeStatus(id);
}

export interface JobFilters {
  track?: string;
  status?: string;
  q?: string;
  minScore?: number;
  source?: string;
  includeDismissed?: boolean;
  includeClosed?: boolean;
  eligibleOnly?: boolean;
  sort?: 'score' | 'newest' | 'posted';
  page?: number;
  pageSize?: number;
}

export function toListItem(r: JobRow & { has_resume?: number }): JobListItem {
  return {
    id: r.id,
    title: r.title,
    company: r.company,
    location: r.location,
    workMode: r.work_mode,
    source: r.source_type,
    status: r.status,
    statusReason: r.status_reason,
    score: r.score,
    eligible: r.eligible === 1,
    tracks: parseJson<Track[]>(r.tracks, []),
    postedAt: r.posted_at,
    discoveredAt: r.discovered_at,
    isActive: r.is_active === 1,
    dismissed: r.dismissed === 1,
    applyUrl: r.apply_url,
    hasTailoredResume: r.has_resume === 1,
  };
}

export function listJobs(f: JobFilters): Paged<JobListItem> {
  const where: string[] = [];
  const params: Record<string, unknown> = {};
  if (!f.includeDismissed) where.push('j.dismissed = 0');
  if (f.status) {
    where.push('j.status = :status');
    params.status = f.status;
  } else if (!f.includeClosed) where.push("j.status != 'closed'");
  if (f.track) {
    where.push(`EXISTS (SELECT 1 FROM json_each(j.tracks) WHERE value = :track)`);
    params.track = f.track;
  }
  if (f.q) {
    where.push('(j.title LIKE :q OR j.company LIKE :q OR j.location LIKE :q)');
    params.q = `%${f.q}%`;
  }
  if (typeof f.minScore === 'number' && f.minScore > 0) {
    where.push('j.score >= :minScore');
    params.minScore = f.minScore;
  }
  if (f.source) {
    where.push('j.source_type = :source');
    params.source = f.source;
  }
  if (f.eligibleOnly) where.push('j.eligible = 1');
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const order =
    f.sort === 'newest' ? 'j.discovered_at DESC' : f.sort === 'posted' ? 'COALESCE(j.posted_at, j.discovered_at) DESC' : 'COALESCE(j.score, -1) DESC, j.discovered_at DESC';
  const pageSize = Math.min(Math.max(f.pageSize ?? 50, 1), 200);
  const page = Math.max(f.page ?? 1, 1);
  const total = get<{ n: number }>(`SELECT COUNT(*) AS n FROM jobs j ${clause}`, params)!.n;
  const rows = all<JobRow & { has_resume: number }>(
    `SELECT j.*, EXISTS (SELECT 1 FROM resumes r WHERE r.job_id = j.id AND r.kind = 'tailored' AND r.is_current = 1) AS has_resume
     FROM jobs j ${clause} ORDER BY ${order} LIMIT :limit OFFSET :offset`,
    { ...params, limit: pageSize, offset: (page - 1) * pageSize },
  );
  return { items: rows.map(toListItem), total, page, pageSize };
}

export function listEvents(jobId: number): Array<{ id: number; type: string; message: string; created_at: string }> {
  return all('SELECT id, type, message, created_at FROM events WHERE job_id = ? ORDER BY id DESC LIMIT 100', [jobId]);
}

/** Has the user already applied to this company+title (here or before using this tool)? */
export function findPriorApplication(ctk: string, excludeJobId?: number): { source: 'app' | 'prior'; date: string | null; jobId?: number } | null {
  const app = get<{ job_id: number; submitted_at: string | null; state: string }>(
    `SELECT job_id, submitted_at, state FROM applications WHERE company_title_key = ? AND state IN ('submitted', 'submitting', 'uncertain') AND job_id != ? LIMIT 1`,
    [ctk, excludeJobId ?? -1],
  );
  if (app) return { source: 'app', date: app.submitted_at, jobId: app.job_id };
  const prior = get<{ applied_at: string | null }>('SELECT applied_at FROM prior_applications WHERE company_title_key = ? LIMIT 1', [ctk]);
  if (prior) return { source: 'prior', date: prior.applied_at };
  return null;
}

export function addPriorApplication(company: string, title: string, appliedAt: string | null, url: string | null, note: string | null): void {
  run('INSERT INTO prior_applications (company, title, company_title_key, applied_at, url, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [
    company,
    title,
    companyTitleKey(company, title),
    appliedAt,
    url,
    note,
    nowIso(),
  ]);
}
