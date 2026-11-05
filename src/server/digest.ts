import type { JobStatus, OverviewStats } from '../shared/types.js';
import { JOB_STATUSES, REVIEW_REASON_LABELS, STATUS_LABELS, type ReviewReason } from '../shared/types.js';
import { submittedTodayCount } from './applications/engine.js';
import { all, get } from './db.js';
import { getConfig } from './config.js';
import { notify } from './notifications.js';
import { getSettings, getState, setState } from './settings.js';

/**
 * Daily digest. "Submitted" counts come exclusively from applications in the `submitted`
 * state (which requires confirmation evidence), never from attempts or dry runs.
 */

export interface DigestData {
  since: string;
  until: string;
  found: Array<{ id: number; title: string; company: string; score: number | null; tracks: string }>;
  foundCount: number;
  submitted: Array<{ id: number; title: string; company: string; submitted_at: string; submitted_via: string; confirmation_text: string | null }>;
  dryRuns: number;
  attention: Array<{ id: number; title: string; company: string; status: JobStatus; reason: string }>;
  sourceErrors: Array<{ name: string; type: string; error: string }>;
  automation: { mode: string; paused: boolean; dryRun: boolean; dailyLimit: number; submittedToday: number };
}

export function buildDigest(sinceIso?: string): DigestData {
  const until = new Date().toISOString();
  const since = sinceIso ?? new Date(Date.now() - 24 * 3600_000).toISOString();
  const found = all<{ id: number; title: string; company: string; score: number | null; tracks: string }>(
    `SELECT id, title, company, score, tracks FROM jobs WHERE discovered_at >= ? ORDER BY COALESCE(score, -1) DESC`,
    [since],
  );
  const submitted = all<DigestData['submitted'][number]>(
    `SELECT j.id, j.title, j.company, a.submitted_at, a.submitted_via, a.confirmation_text
     FROM applications a JOIN jobs j ON j.id = a.job_id
     WHERE a.state = 'submitted' AND a.submitted_at >= ? ORDER BY a.submitted_at`,
    [since],
  );
  const dryRuns = get<{ n: number }>(`SELECT COUNT(*) AS n FROM application_attempts WHERE dry_run = 1 AND outcome = 'dry_run_complete' AND finished_at >= ?`, [since])!.n;
  const attention = all<{ id: number; title: string; company: string; status: JobStatus; status_reason: string | null }>(
    `SELECT id, title, company, status, status_reason FROM jobs WHERE status IN ('needs_input', 'needs_review', 'failed') AND dismissed = 0 ORDER BY status, score DESC LIMIT 50`,
  ).map((r) => ({ ...r, reason: (REVIEW_REASON_LABELS[r.status_reason as ReviewReason] ?? r.status_reason ?? STATUS_LABELS[r.status]) as string }));
  const sourceErrors = all<{ name: string; type: string; last_error: string }>(`SELECT name, type, last_error FROM sources WHERE enabled = 1 AND last_status = 'error'`).map((s) => ({
    name: s.name,
    type: s.type,
    error: s.last_error,
  }));
  const { automation, schedule } = getSettings();
  return {
    since,
    until,
    found: found.slice(0, 15),
    foundCount: found.length,
    submitted,
    dryRuns,
    attention,
    sourceErrors,
    automation: { mode: automation.mode, paused: automation.paused, dryRun: automation.dryRun, dailyLimit: automation.dailyLimit, submittedToday: submittedTodayCount(schedule.timezone) },
  };
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function renderDigest(d: DigestData): { title: string; text: string; html: string } {
  const base = getConfig().PUBLIC_URL?.replace(/\/$/, '') ?? '';
  const url = (id: number) => (base ? `${base}/jobs/${id}` : `job #${id}`);
  const title = `Daily digest: ${d.foundCount} new job${d.foundCount === 1 ? '' : 's'}, ${d.submitted.length} submitted, ${d.attention.length} need you`;
  const lines: string[] = [];
  lines.push(`Automation: ${d.automation.paused ? 'PAUSED' : d.automation.mode === 'auto' ? 'automatic' : 'review-before-submit'}${d.automation.dryRun ? ' (dry run — nothing is submitted)' : ''}; ${d.automation.submittedToday}/${d.automation.dailyLimit} submitted today.`);
  lines.push('', `NEW JOBS (${d.foundCount})`);
  for (const j of d.found) lines.push(`• ${j.score ?? '–'} — ${j.title} at ${j.company} (${url(j.id)})`);
  if (d.foundCount === 0) lines.push('• None');
  lines.push('', `SUBMITTED WITH CONFIRMATION (${d.submitted.length})`);
  for (const s of d.submitted) lines.push(`• ${s.title} at ${s.company} — ${s.submitted_via}, ${s.submitted_at.slice(0, 16).replace('T', ' ')} UTC — "${s.confirmation_text ?? 'confirmation saved'}"`);
  if (d.submitted.length === 0) lines.push('• None');
  if (d.dryRuns) lines.push(`(${d.dryRuns} dry run(s) completed — these were NOT submitted.)`);
  lines.push('', `NEEDS YOUR ATTENTION (${d.attention.length})`);
  for (const a of d.attention) lines.push(`• [${STATUS_LABELS[a.status]}] ${a.title} at ${a.company} — ${a.reason} (${url(a.id)})`);
  if (d.attention.length === 0) lines.push('• Nothing');
  if (d.sourceErrors.length) {
    lines.push('', 'SOURCE ERRORS');
    for (const s of d.sourceErrors) lines.push(`• ${s.type}/${s.name}: ${s.error}`);
  }
  const text = lines.join('\n');
  const html = `<div style="font-family:system-ui,sans-serif;font-size:14px;line-height:1.5">${text
    .split('\n')
    .map((l) => (/^[A-Z ()0-9/]+$/.test(l.replace(/\(\d+\)/, '').trim()) && l.trim() ? `<h3 style="margin:16px 0 4px">${esc(l)}</h3>` : `<div>${esc(l) || '&nbsp;'}</div>`))
    .join('')}</div>`;
  return { title, text, html };
}

export async function sendDigest(): Promise<DigestData> {
  const last = getState<string | null>('lastDigestAt', null);
  const data = buildDigest(last ?? undefined);
  const r = renderDigest(data);
  await notify({ kind: 'digest', title: r.title, body: r.text, html: r.html });
  setState('lastDigestAt', data.until);
  return data;
}

export function overviewStats(): OverviewStats {
  const totals = Object.fromEntries(JOB_STATUSES.map((s) => [s, 0])) as Record<JobStatus, number>;
  for (const r of all<{ status: JobStatus; n: number }>('SELECT status, COUNT(*) AS n FROM jobs WHERE dismissed = 0 GROUP BY status')) totals[r.status] = r.n;
  const byTrack = { frontend: 0, ai: 0 };
  for (const r of all<{ value: string; n: number }>(
    `SELECT t.value AS value, COUNT(*) AS n FROM jobs j, json_each(j.tracks) t WHERE j.dismissed = 0 AND j.status != 'closed' GROUP BY t.value`,
  )) {
    if (r.value === 'frontend' || r.value === 'ai') byTrack[r.value] = r.n;
  }
  const { automation, schedule } = getSettings();
  return {
    totals,
    byTrack,
    foundLast24h: get<{ n: number }>('SELECT COUNT(*) AS n FROM jobs WHERE discovered_at >= ?', [new Date(Date.now() - 24 * 3600_000).toISOString()])!.n,
    submittedToday: submittedTodayCount(schedule.timezone),
    submittedTotal: get<{ n: number }>(`SELECT COUNT(*) AS n FROM applications WHERE state = 'submitted'`)!.n,
    dailyLimit: automation.dailyLimit,
  };
}
