import { z } from 'zod';
import type {
  AllSettings,
  AutomationSettings,
  CandidateProfile,
  LlmSettings,
  NotificationSettings,
  ScheduleSettings,
  SearchPreferences,
} from '../shared/types.js';
import { getConfig } from './config.js';
import { decryptJson, encryptJson } from './crypto.js';
import { all, get, nowIso, run } from './db.js';

/**
 * User-editable settings, stored in the `settings` table (one JSON row per section).
 * Notification settings are encrypted because they contain chat ids / webhook URLs.
 */

const DEFAULT_FRONTEND_TITLES = [
  'Frontend Developer',
  'Frontend Engineer',
  'Front End Developer',
  'React Developer',
  'React.js Developer',
  'UI Engineer',
  'UI Developer',
  'JavaScript Developer',
  'TypeScript Developer',
  'Software Engineer, Frontend',
];

const DEFAULT_AI_TITLES = [
  'Prompt Engineer',
  'AI Prompt Specialist',
  'AI Application Developer',
  'AI Engineer (Applications)',
  'Generative AI Developer',
  'LLM Application Developer',
  'Conversational AI Developer',
];

export function defaultPreferences(): SearchPreferences {
  return {
    tracks: {
      frontend: { enabled: true, titles: DEFAULT_FRONTEND_TITLES },
      ai: { enabled: true, titles: DEFAULT_AI_TITLES },
    },
    keywords: ['react developer', 'frontend developer', 'frontend engineer', 'ui engineer', 'javascript developer', 'prompt engineer', 'ai application developer'],
    locations: [],
    country: '',
    workModes: ['remote', 'hybrid', 'onsite'],
    remoteRegions: ['Worldwide', 'Anywhere', 'Global'],
    relocation: { willing: false, locations: [] },
    experienceLevel: 'junior',
    yearsOfExperience: null,
    employmentTypes: ['full_time'],
    salary: { minimum: null, currency: '', period: 'year' },
    workAuthorization: [],
    excludedCompanies: [],
    excludedKeywords: [],
    maxJobAgeDays: 30,
  };
}

export function defaultAutomation(): AutomationSettings {
  return {
    mode: 'review',
    paused: false,
    dryRun: true,
    dailyLimit: 10,
    maxPerRun: 5,
    matchThreshold: 70,
    autoTracks: ['frontend'],
    captchaPolicy: 'pause_if_challenged',
    autoTailor: true,
    coverLetters: 'when_required',
    delayBetweenApplicationsSec: 45,
  };
}

export function defaultSchedule(): ScheduleSettings {
  let tz = getConfig().APP_TIMEZONE ?? 'UTC';
  if (!getConfig().APP_TIMEZONE) {
    try {
      tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    } catch {
      tz = 'UTC';
    }
  }
  return { timezone: tz, discoveryEveryHours: 6, digestTime: '09:00', enabled: true };
}

export function defaultNotifications(): NotificationSettings {
  return {
    email: { enabled: getConfig().smtpEnabled, to: '' },
    telegram: { enabled: false, chatId: '' },
    ntfy: { enabled: false, server: 'https://ntfy.sh', topic: '' },
    webhook: { enabled: false, url: '' },
    events: { needsInput: true, needsReview: true, submitted: true, failed: true, digest: true },
  };
}

export function defaultLlm(): LlmSettings {
  return { profileExtraction: true, tailoring: true, coverLetters: true };
}

// ---------------------------------------------------------------------------
// Validation schemas
// ---------------------------------------------------------------------------
const workMode = z.enum(['remote', 'hybrid', 'onsite', 'unknown']);
const employmentType = z.enum(['full_time', 'part_time', 'contract', 'internship', 'temporary', 'unknown']);
const track = z.enum(['frontend', 'ai', 'ml_research', 'other']);
const strList = z.array(z.string().trim().max(200)).max(200);

export const PreferencesSchema = z.object({
  tracks: z.object({
    frontend: z.object({ enabled: z.boolean(), titles: strList }),
    ai: z.object({ enabled: z.boolean(), titles: strList }),
  }),
  keywords: strList,
  locations: strList,
  country: z.string().trim().max(2).transform((s) => s.toUpperCase()),
  workModes: z.array(workMode),
  remoteRegions: strList,
  relocation: z.object({ willing: z.boolean(), locations: strList }),
  experienceLevel: z.enum(['internship', 'entry', 'junior', 'mid', 'senior']),
  yearsOfExperience: z.number().min(0).max(60).nullable(),
  employmentTypes: z.array(employmentType),
  salary: z.object({
    minimum: z.number().min(0).nullable(),
    currency: z.string().trim().max(8),
    period: z.enum(['year', 'month', 'hour']),
  }),
  workAuthorization: z.array(
    z.object({
      country: z.string().trim().length(2).transform((s) => s.toUpperCase()),
      status: z.enum(['authorized', 'needs_sponsorship', 'not_authorized']),
    }),
  ),
  excludedCompanies: strList,
  excludedKeywords: strList,
  maxJobAgeDays: z.number().int().min(1).max(365),
});

export const AutomationSchema = z.object({
  mode: z.enum(['review', 'auto']),
  paused: z.boolean(),
  dryRun: z.boolean(),
  dailyLimit: z.number().int().min(0).max(100),
  maxPerRun: z.number().int().min(0).max(50),
  matchThreshold: z.number().int().min(0).max(100),
  autoTracks: z.array(track),
  captchaPolicy: z.enum(['pause_if_present', 'pause_if_challenged']),
  autoTailor: z.boolean(),
  coverLetters: z.enum(['when_required', 'always', 'never']),
  delayBetweenApplicationsSec: z.number().int().min(5).max(3600),
});

export const ScheduleSchema = z.object({
  timezone: z.string().refine((tz) => {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: tz });
      return true;
    } catch {
      return false;
    }
  }, 'Unknown timezone'),
  discoveryEveryHours: z.number().int().min(1).max(168),
  digestTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  enabled: z.boolean(),
});

export const NotificationsSchema = z.object({
  email: z.object({ enabled: z.boolean(), to: z.union([z.literal(''), z.email()]) }),
  telegram: z.object({ enabled: z.boolean(), chatId: z.string().trim().max(64) }),
  ntfy: z.object({ enabled: z.boolean(), server: z.url(), topic: z.string().trim().max(128) }),
  webhook: z.object({ enabled: z.boolean(), url: z.union([z.literal(''), z.url()]) }),
  events: z.object({
    needsInput: z.boolean(),
    needsReview: z.boolean(),
    submitted: z.boolean(),
    failed: z.boolean(),
    digest: z.boolean(),
  }),
});

export const LlmSchema = z.object({
  profileExtraction: z.boolean(),
  tailoring: z.boolean(),
  coverLetters: z.boolean(),
});

const SECTIONS = {
  preferences: { schema: PreferencesSchema, defaults: defaultPreferences, encrypted: false },
  automation: { schema: AutomationSchema, defaults: defaultAutomation, encrypted: false },
  schedule: { schema: ScheduleSchema, defaults: defaultSchedule, encrypted: false },
  notifications: { schema: NotificationsSchema, defaults: defaultNotifications, encrypted: true },
  llm: { schema: LlmSchema, defaults: defaultLlm, encrypted: false },
} as const;

export type SettingsSection = keyof typeof SECTIONS;

function deepMerge<T>(base: T, patch: unknown): T {
  if (patch === null || patch === undefined) return base;
  if (Array.isArray(base) || typeof base !== 'object' || base === null) return (patch as T) ?? base;
  if (typeof patch !== 'object' || Array.isArray(patch)) return base;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
    const b = (base as Record<string, unknown>)[k];
    out[k] = b !== undefined && typeof b === 'object' && b !== null && !Array.isArray(b) ? deepMerge(b, v) : v;
  }
  return out as T;
}

function readSection<K extends SettingsSection>(key: K): AllSettings[K] {
  const def = SECTIONS[key];
  const row = get<{ value: string }>('SELECT value FROM settings WHERE key = ?', [key]);
  const defaults = def.defaults() as AllSettings[K];
  if (!row) return defaults;
  try {
    const stored = def.encrypted ? decryptJson<unknown>(row.value) : JSON.parse(row.value);
    return deepMerge(defaults, stored);
  } catch {
    return defaults;
  }
}

export function getSettings(): AllSettings {
  return {
    preferences: readSection('preferences'),
    automation: readSection('automation'),
    schedule: readSection('schedule'),
    notifications: readSection('notifications'),
    llm: readSection('llm'),
  };
}

export function getSection<K extends SettingsSection>(key: K): AllSettings[K] {
  return readSection(key);
}

/** Validate and persist a full section (merged over current values). */
export function updateSection<K extends SettingsSection>(key: K, patch: unknown): AllSettings[K] {
  const def = SECTIONS[key];
  const merged = deepMerge(readSection(key), patch);
  const parsed = def.schema.parse(merged) as AllSettings[K];
  const value = def.encrypted ? encryptJson(parsed) : JSON.stringify(parsed);
  run(
    `INSERT INTO settings (key, value, updated_at) VALUES (:key, :value, :now)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    { key, value, now: nowIso() },
  );
  return parsed;
}

export function isSectionCustomized(key: SettingsSection): boolean {
  return Boolean(get('SELECT 1 FROM settings WHERE key = ?', [key]));
}

/** Internal key/value state (scheduler timestamps etc.) stored alongside settings. */
export function getState<T>(key: string, fallback: T): T {
  const row = get<{ value: string }>('SELECT value FROM settings WHERE key = ?', [`state:${key}`]);
  if (!row) return fallback;
  try {
    return JSON.parse(row.value) as T;
  } catch {
    return fallback;
  }
}

export function setState(key: string, value: unknown): void {
  run(
    `INSERT INTO settings (key, value, updated_at) VALUES (:key, :value, :now)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    { key: `state:${key}`, value: JSON.stringify(value), now: nowIso() },
  );
}

export function listStateKeys(): string[] {
  return all<{ key: string }>("SELECT key FROM settings WHERE key LIKE 'state:%'").map((r) => r.key.slice(6));
}

// ---------------------------------------------------------------------------
// Profile-derived suggestions (applied once, only if the user has not edited preferences)
// ---------------------------------------------------------------------------
const INDIA_HINTS = /\b(india|karnataka|maharashtra|tamil nadu|telangana|kerala|delhi|haryana|uttar pradesh|gujarat|west bengal|bengaluru|bangalore|mumbai|pune|hyderabad|chennai|kolkata|gurugram|gurgaon|noida|kochi|mysuru|mangaluru)\b/i;

export function suggestPreferencesFromProfile(profile: CandidateProfile): Partial<SearchPreferences> {
  const out: Partial<SearchPreferences> = {};
  const loc = profile.location.trim();
  if (loc) {
    const city = loc.split(/[,|]/)[0].trim();
    if (city) out.locations = [city];
  }
  const isIndia = INDIA_HINTS.test(loc) || /^\+91/.test(profile.phone.replace(/\s/g, ''));
  if (isIndia) {
    out.country = 'IN';
    out.remoteRegions = ['India', 'APAC', 'Asia', 'Worldwide', 'Anywhere', 'Global'];
    out.salary = { minimum: null, currency: 'INR', period: 'year' };
  }
  return out;
}

export function applyProfileSuggestions(profile: CandidateProfile): void {
  if (isSectionCustomized('preferences')) return;
  const suggestion = suggestPreferencesFromProfile(profile);
  if (Object.keys(suggestion).length === 0) return;
  updateSection('preferences', suggestion);
  if (suggestion.country === 'IN' && !isSectionCustomized('schedule') && !getConfig().APP_TIMEZONE) {
    updateSection('schedule', { timezone: 'Asia/Kolkata' });
  }
}
