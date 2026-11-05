import { all, get, nowIso, parseJson, run } from '../db.js';
import { getConfig } from '../config.js';
import { ADAPTERS } from './adapters.js';

/** Source records (which boards/APIs to poll) plus careers-URL detection and starter seeds. */

export interface SourceRow {
  id: number;
  type: string;
  name: string;
  config: Record<string, unknown>;
  enabled: boolean;
  minIntervalMinutes: number;
  lastRunAt: string | null;
  lastStatus: string | null;
  lastError: string | null;
  lastCount: number | null;
}

interface RawSourceRow {
  id: number;
  type: string;
  name: string;
  config: string;
  enabled: number;
  min_interval_minutes: number;
  last_run_at: string | null;
  last_status: string | null;
  last_error: string | null;
  last_count: number | null;
}

function map(r: RawSourceRow): SourceRow {
  return {
    id: r.id,
    type: r.type,
    name: r.name,
    config: parseJson<Record<string, unknown>>(r.config, {}),
    enabled: r.enabled === 1,
    minIntervalMinutes: r.min_interval_minutes,
    lastRunAt: r.last_run_at,
    lastStatus: r.last_status,
    lastError: r.last_error,
    lastCount: r.last_count,
  };
}

export function listSources(): SourceRow[] {
  return all<RawSourceRow>('SELECT * FROM sources ORDER BY type, name').map(map);
}

export function getSource(id: number): SourceRow | undefined {
  const r = get<RawSourceRow>('SELECT * FROM sources WHERE id = ?', [id]);
  return r ? map(r) : undefined;
}

export function addSource(type: string, name: string, config: Record<string, unknown>, enabled = true): SourceRow {
  const adapter = ADAPTERS[type];
  if (!adapter) throw new Error(`Unknown source type "${type}"`);
  const problem = adapter.validateConfig(config);
  if (problem) throw new Error(problem);
  run(
    `INSERT INTO sources (type, name, config, enabled, min_interval_minutes, created_at)
     VALUES (:type, :name, :config, :enabled, :interval, :now)
     ON CONFLICT(type, name) DO UPDATE SET config = excluded.config, enabled = excluded.enabled`,
    { type, name, config: JSON.stringify(config), enabled, interval: adapter.defaultIntervalMinutes, now: nowIso() },
  );
  return map(get<RawSourceRow>('SELECT * FROM sources WHERE type = ? AND name = ?', [type, name])!);
}

export function updateSource(id: number, patch: { enabled?: boolean; config?: Record<string, unknown>; minIntervalMinutes?: number }): SourceRow {
  const cur = getSource(id);
  if (!cur) throw new Error('Source not found');
  run('UPDATE sources SET enabled = :enabled, config = :config, min_interval_minutes = :interval WHERE id = :id', {
    id,
    enabled: patch.enabled ?? cur.enabled,
    config: JSON.stringify(patch.config ?? cur.config),
    interval: patch.minIntervalMinutes ?? cur.minIntervalMinutes,
  });
  return getSource(id)!;
}

export function deleteSource(id: number): void {
  run('DELETE FROM sources WHERE id = ?', [id]);
}

export function recordSourceRun(id: number, status: 'ok' | 'error', count: number | null, error: string | null): void {
  run('UPDATE sources SET last_run_at = ?, last_status = ?, last_error = ?, last_count = ? WHERE id = ?', [nowIso(), status, error, count, id]);
}

/**
 * Turn a careers / job-board URL into a source definition.
 * Supports Greenhouse, Lever, Ashby and SmartRecruiters hosted boards.
 */
export function detectSourceFromUrl(input: string): { type: string; name: string; config: Record<string, unknown> } | null {
  let url: URL;
  try {
    url = new URL(input.trim().startsWith('http') ? input.trim() : `https://${input.trim()}`);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  const seg = url.pathname.split('/').filter(Boolean);
  const gh = url.searchParams.get('for');
  if (/(^|\.)greenhouse\.io$/.test(host)) {
    const board = gh ?? (seg[0] === 'embed' ? null : seg[0]);
    if (board) return { type: 'greenhouse', name: board, config: { board } };
  }
  if (/(^|\.)lever\.co$/.test(host) && seg[0]) {
    return { type: 'lever', name: seg[0], config: { company: seg[0], ...(host.includes('.eu.') ? { region: 'eu' } : {}) } };
  }
  if (host === 'jobs.ashbyhq.com' && seg[0]) return { type: 'ashby', name: seg[0], config: { org: seg[0] } };
  if (/smartrecruiters\.com$/.test(host) && seg[0]) {
    const company = host.startsWith('careers.') || host.startsWith('jobs.') ? seg[0] : seg[seg.length - 1];
    return { type: 'smartrecruiters', name: company, config: { company } };
  }
  return null;
}

/**
 * Starter sources. ATS boards are employers known to use these systems and hire frontend
 * engineers in India or remotely; board tokens change occasionally, so each run reports
 * "board not found" clearly in the dashboard instead of failing silently.
 */
export const SEED_SOURCES: Array<{ type: string; name: string; config: Record<string, unknown>; enabled: boolean }> = [
  { type: 'remotive', name: 'Remotive (frontend/react/prompt)', config: {}, enabled: true },
  { type: 'remoteok', name: 'Remote OK (frontend/AI tags)', config: {}, enabled: true },
  { type: 'adzuna', name: 'Adzuna (your country & keywords)', config: {}, enabled: true },
  { type: 'greenhouse', name: 'postman', config: { board: 'postman', companyName: 'Postman' }, enabled: true },
  { type: 'greenhouse', name: 'browserstack', config: { board: 'browserstack', companyName: 'BrowserStack' }, enabled: true },
  { type: 'greenhouse', name: 'gitlab', config: { board: 'gitlab', companyName: 'GitLab' }, enabled: true },
  { type: 'greenhouse', name: 'stripe', config: { board: 'stripe', companyName: 'Stripe' }, enabled: true },
  { type: 'greenhouse', name: 'cloudflare', config: { board: 'cloudflare', companyName: 'Cloudflare' }, enabled: true },
  { type: 'greenhouse', name: 'databricks', config: { board: 'databricks', companyName: 'Databricks' }, enabled: true },
  { type: 'greenhouse', name: 'anthropic', config: { board: 'anthropic', companyName: 'Anthropic' }, enabled: false },
  { type: 'lever', name: 'plaid', config: { company: 'plaid', companyName: 'Plaid' }, enabled: false },
  { type: 'lever', name: 'palantir', config: { company: 'palantir', companyName: 'Palantir' }, enabled: false },
  { type: 'ashby', name: 'notion', config: { org: 'notion', companyName: 'Notion' }, enabled: true },
  { type: 'ashby', name: 'supabase', config: { org: 'supabase', companyName: 'Supabase' }, enabled: true },
  { type: 'ashby', name: 'posthog', config: { org: 'posthog', companyName: 'PostHog' }, enabled: true },
  { type: 'ashby', name: 'openai', config: { org: 'openai', companyName: 'OpenAI' }, enabled: false },
  { type: 'ashby', name: 'cohere', config: { org: 'cohere', companyName: 'Cohere' }, enabled: false },
  { type: 'smartrecruiters', name: 'Visa', config: { company: 'Visa', companyName: 'Visa' }, enabled: false },
];

export function seedSourcesIfEmpty(): number {
  const count = get<{ n: number }>('SELECT COUNT(*) AS n FROM sources')!.n;
  if (count > 0) return 0;
  const hasAdzuna = Boolean(getConfig().ADZUNA_APP_ID && getConfig().ADZUNA_APP_KEY);
  let n = 0;
  for (const s of SEED_SOURCES) {
    addSource(s.type, s.name, s.config, s.type === 'adzuna' ? hasAdzuna : s.enabled);
    n++;
  }
  return n;
}
