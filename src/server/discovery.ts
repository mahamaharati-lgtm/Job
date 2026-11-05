import type { SearchPreferences } from '../shared/types.js';
import { all, nowIso, run } from './db.js';
import { closeJob, upsertJob } from './jobs.js';
import { logger, safeErrorMessage } from './logger.js';
import { getSection } from './settings.js';
import { ADAPTERS } from './sources/adapters.js';
import { defaultContext, HttpError, type NormalizedJob, type SourceContext } from './sources/common.js';
import { listSources, recordSourceRun, type SourceRow } from './sources/registry.js';
import { findSkills } from './skills.js';

/**
 * Discovery: poll enabled sources, keep relevant jobs, deduplicate, and detect closed postings.
 */

const RELEVANT_TITLE =
  /front[\s-]?end|react|\bui\b|user interface|javascript|typescript|web developer|web engineer|design engineer|full[\s-]?stack|software (engineer|developer)|sde|prompt|\bllm\b|gen(erative)?[\s-]?ai|\bai\b|artificial intelligence|machine learning|conversational|chatbot/i;
const IRRELEVANT_TITLE =
  /\b(sales|account (executive|manager)|recruit|talent|marketing|finance|legal|counsel|accountant|payroll|hr\b|people partner|customer success|support specialist|warehouse|driver|nurse|teacher)\b/i;

/** Cheap pre-filter so ATS boards (which list every department) don't flood the database. */
export function isPotentiallyRelevant(job: NormalizedJob, prefs: SearchPreferences): boolean {
  const title = job.title;
  if (!title || IRRELEVANT_TITLE.test(title)) return false;
  if (prefs.excludedCompanies.some((c) => c && job.company.toLowerCase().includes(c.toLowerCase()))) return false;
  if (RELEVANT_TITLE.test(title)) {
    // Generic engineering titles must mention frontend/AI-app skills in the description.
    if (/software (engineer|developer)|sde|full[\s-]?stack/i.test(title) && !/front|react|ui|prompt|llm|ai/i.test(title)) {
      const skills = findSkills(job.descriptionText.slice(0, 6000));
      return skills.some((s) => ['react', 'typescript', 'nextjs', 'prompt_engineering', 'llm', 'genai'].includes(s));
    }
    return true;
  }
  const customTitles = [...prefs.tracks.frontend.titles, ...prefs.tracks.ai.titles].map((t) => t.toLowerCase());
  return customTitles.some((t) => title.toLowerCase().includes(t));
}

export interface DiscoverySummary {
  sourcesRun: number;
  sourcesFailed: number;
  fetched: number;
  relevant: number;
  inserted: number;
  merged: number;
  updated: number;
  closed: number;
  errors: Array<{ source: string; error: string }>;
}

function isDue(s: SourceRow, force: boolean): boolean {
  if (force || !s.lastRunAt) return true;
  return Date.now() - new Date(s.lastRunAt).getTime() >= s.minIntervalMinutes * 60_000;
}

export async function runSource(source: SourceRow, ctx: SourceContext, summary: DiscoverySummary): Promise<void> {
  const adapter = ADAPTERS[source.type];
  if (!adapter) return;
  const startedAt = nowIso();
  try {
    const jobs = await adapter.fetchJobs(source.config, ctx);
    summary.fetched += jobs.length;
    const seenIds: number[] = [];
    for (const j of jobs) {
      if (!isPotentiallyRelevant(j, ctx.prefs)) continue;
      summary.relevant++;
      const { id, outcome } = upsertJob(j, source.id);
      seenIds.push(id);
      summary[outcome]++;
    }
    if (adapter.completeListing) {
      // Every open job of this board was listed; jobs we hold from it that were not listed are closing.
      const stale = all<{ id: number; missed_runs: number }>(
        `SELECT id, missed_runs FROM jobs WHERE source_id = ? AND is_active = 1 AND last_seen_at < ?`,
        [source.id, startedAt],
      );
      for (const s of stale) {
        if (s.missed_runs + 1 >= 2) {
          closeJob(s.id, `No longer listed on the ${adapter.label} board`);
          summary.closed++;
        } else run('UPDATE jobs SET missed_runs = missed_runs + 1 WHERE id = ?', [s.id]);
      }
    }
    recordSourceRun(source.id, 'ok', jobs.length, null);
    summary.sourcesRun++;
  } catch (err) {
    const msg =
      err instanceof HttpError && err.status === 404
        ? `Board not found (404). Check the ${adapter.configHelp.toLowerCase()}`
        : safeErrorMessage(err);
    recordSourceRun(source.id, 'error', null, msg);
    summary.sourcesFailed++;
    summary.errors.push({ source: `${adapter.label}: ${source.name}`, error: msg });
    logger.warn('Source failed', { source: source.type, name: source.name, error: msg });
  }
}

/** Close aggregator jobs that are too old or have not been seen for two weeks. */
export function expireStaleJobs(prefs: SearchPreferences): number {
  const cutoffSeen = new Date(Date.now() - 14 * 86_400_000).toISOString();
  const cutoffPosted = new Date(Date.now() - prefs.maxJobAgeDays * 2 * 86_400_000).toISOString();
  const rows = all<{ id: number }>(
    `SELECT j.id FROM jobs j LEFT JOIN applications a ON a.job_id = j.id
     WHERE j.is_active = 1 AND (a.state IS NULL OR a.state NOT IN ('submitted', 'submitting', 'uncertain'))
       AND j.source_type NOT IN ('manual', 'import')
       AND (j.last_seen_at < :seen OR (j.posted_at IS NOT NULL AND j.posted_at < :posted))`,
    { seen: cutoffSeen, posted: cutoffPosted },
  );
  for (const r of rows) closeJob(r.id, 'Expired: not seen recently or older than your maximum job age');
  return rows.length;
}

export async function discover(opts: { force?: boolean; sourceIds?: number[]; ctx?: SourceContext } = {}): Promise<DiscoverySummary> {
  const prefs = getSection('preferences');
  const ctx = opts.ctx ?? defaultContext(prefs);
  const summary: DiscoverySummary = { sourcesRun: 0, sourcesFailed: 0, fetched: 0, relevant: 0, inserted: 0, merged: 0, updated: 0, closed: 0, errors: [] };
  const sources = listSources().filter((s) => (opts.sourceIds ? opts.sourceIds.includes(s.id) : s.enabled && isDue(s, Boolean(opts.force))));
  for (const s of sources) await runSource(s, ctx, summary);
  summary.closed += expireStaleJobs(prefs);
  return summary;
}
