import type { EmploymentType, SearchPreferences, WorkMode } from '../../shared/types.js';
import { getConfig } from '../config.js';

/** Shared types and HTTP helpers for job sources. */

export interface NormalizedJob {
  sourceType: string;
  externalId: string;
  title: string;
  company: string;
  location: string | null;
  workMode: WorkMode;
  employmentType: EmploymentType;
  salaryText?: string | null;
  salaryMin?: number | null;
  salaryMax?: number | null;
  salaryCurrency?: string | null;
  sourceUrl: string | null;
  applyUrl: string | null;
  ats?: 'greenhouse' | 'lever' | 'ashby' | 'smartrecruiters' | null;
  atsBoard?: string | null;
  atsJobId?: string | null;
  descriptionHtml?: string | null;
  descriptionText: string;
  descriptionPartial?: boolean;
  postedAt?: string | null;
}

export interface SourceContext {
  prefs: SearchPreferences;
  fetchJson: (url: string, init?: RequestInit) => Promise<unknown>;
  fetchText: (url: string, init?: RequestInit) => Promise<string>;
}

export interface SourceAdapter {
  type: string;
  label: string;
  kind: 'ats' | 'aggregator';
  /** True when the listing contains every open job of the board: absence means closed. */
  completeListing: boolean;
  defaultIntervalMinutes: number;
  /** Human-readable status of the integration (shown in the dashboard). */
  integration: 'official_api' | 'public_api' | 'api_key_required';
  terms?: string;
  configHelp: string;
  validateConfig(config: Record<string, unknown>): string | null;
  fetchJobs(config: Record<string, unknown>, ctx: SourceContext): Promise<NormalizedJob[]>;
}

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

async function doFetch(url: string, init: RequestInit = {}, attempt = 0): Promise<Response> {
  const cfg = getConfig();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.HTTP_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      ...init,
      signal: controller.signal,
      headers: { 'User-Agent': cfg.HTTP_USER_AGENT, Accept: 'application/json, text/html;q=0.9, */*;q=0.8', ...(init.headers ?? {}) },
    });
    if ((res.status === 429 || res.status >= 500) && attempt < 2) {
      const retryAfter = Number(res.headers.get('retry-after')) || 2 ** attempt * 2;
      await new Promise((r) => setTimeout(r, Math.min(retryAfter, 30) * 1000));
      return doFetch(url, init, attempt + 1);
    }
    return res;
  } catch (err) {
    if (attempt < 2 && (err as Error).name !== 'AbortError') {
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
      return doFetch(url, init, attempt + 1);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function describeUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname}`; // never include query strings (they can hold API keys)
  } catch {
    return 'request';
  }
}

export async function fetchJson(url: string, init?: RequestInit): Promise<unknown> {
  const res = await doFetch(url, init);
  if (!res.ok) throw new HttpError(res.status, `HTTP ${res.status} from ${describeUrl(url)}`);
  return res.json();
}

export async function fetchText(url: string, init?: RequestInit): Promise<string> {
  const res = await doFetch(url, init);
  if (!res.ok) throw new HttpError(res.status, `HTTP ${res.status} from ${describeUrl(url)}`);
  return res.text();
}

export function defaultContext(prefs: SearchPreferences): SourceContext {
  return { prefs, fetchJson, fetchText };
}

// ---------------------------------------------------------------------------
// Normalization helpers
// ---------------------------------------------------------------------------
export function inferWorkMode(...hints: Array<string | null | undefined | boolean>): WorkMode {
  const text = hints.filter((h) => typeof h === 'string').join(' ').toLowerCase();
  if (/\bhybrid\b/.test(text)) return 'hybrid';
  if (/\b(remote|work from home|wfh|anywhere|distributed)\b/.test(text) && !/\bnot remote\b|no remote/.test(text)) return 'remote';
  if (/\b(on-?site|onsite|in[- ]office|work from office|wfo)\b/.test(text)) return 'onsite';
  if (hints.includes(true)) return 'remote';
  return 'unknown';
}

export function inferEmploymentType(...hints: Array<string | null | undefined>): EmploymentType {
  const t = hints.filter(Boolean).join(' ').toLowerCase();
  if (/\bintern(ship)?\b/.test(t)) return 'internship';
  if (/\b(contract|contractor|freelance|fixed[- ]term)\b/.test(t)) return 'contract';
  if (/\bpart[- ]?time\b/.test(t)) return 'part_time';
  if (/\b(temporary|temp)\b/.test(t)) return 'temporary';
  if (/\b(full[- ]?time|permanent|fulltime)\b/.test(t)) return 'full_time';
  return 'unknown';
}

export function str(v: unknown): string {
  return typeof v === 'string' ? v : v == null ? '' : String(v);
}

export function isoOrNull(v: unknown): string | null {
  if (v == null || v === '') return null;
  const d = typeof v === 'number' ? new Date(v > 1e12 ? v : v * 1000) : new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export function requireString(config: Record<string, unknown>, key: string, label: string): string | null {
  const v = config[key];
  return typeof v === 'string' && v.trim() ? null : `${label} is required`;
}
