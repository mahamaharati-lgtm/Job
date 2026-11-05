import type {
  AccuracyReport,
  AllSettings,
  AnswerResolution,
  ApplicationState,
  CandidateProfile,
  FormQuestion,
  JobListItem,
  JobStatus,
  MatchResult,
  OverviewStats,
  Paged,
  ProfileRecord,
  ReviewReason,
  SavedAnswer,
  TailoredResume,
  TailoringSummary,
  Track,
  WorkMode,
} from '../shared/types';

/** Typed fetch wrapper. Every mutating request carries the CSRF header the server requires. */

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const init: RequestInit = { method, credentials: 'same-origin', headers: { 'X-Requested-With': 'job-autopilot' } };
  if (body instanceof FormData) init.body = body;
  else if (body !== undefined) {
    init.body = JSON.stringify(body);
    (init.headers as Record<string, string>)['Content-Type'] = 'application/json';
  }
  const res = await fetch(url, init);
  const text = await res.text();
  const data = text ? (JSON.parse(text) as unknown) : null;
  if (!res.ok) {
    const msg = (data as { error?: string } | null)?.error ?? `Request failed (${res.status})`;
    if (res.status === 401 && !url.includes('/auth/')) window.dispatchEvent(new Event('auth:required'));
    throw new ApiError(res.status, msg);
  }
  return data as T;
}

export const api = {
  get: <T>(url: string) => request<T>('GET', url),
  post: <T>(url: string, body?: unknown) => request<T>('POST', url, body ?? {}),
  put: <T>(url: string, body?: unknown) => request<T>('PUT', url, body ?? {}),
  del: <T>(url: string, body?: unknown) => request<T>('DELETE', url, body),
};

export const fileUrl = (id: number, download = false) => `/api/files/${id}${download ? '?download=1' : ''}`;

// ---------------------------------------------------------------------------
// Response types
// ---------------------------------------------------------------------------
export interface Me {
  authenticated: boolean;
  authConfigured: boolean;
  llmEnabled: boolean;
  smtpEnabled: boolean;
}

export interface EventRow {
  id: number;
  type: string;
  message: string;
  created_at: string;
  title?: string;
  company?: string;
  job_id?: number | null;
}

export interface RunRow {
  id: number;
  kind: string;
  trigger: string;
  started_at: string;
  finished_at: string | null;
  status: string;
  error: string | null;
  summary: {
    discovery?: { sourcesRun: number; sourcesFailed: number; fetched: number; relevant: number; inserted: number; merged: number; closed: number; errors: Array<{ source: string; error: string }> };
    scored: number;
    matched: number;
    tailored: number;
    prepared: number;
    apply: { attempted: number; submitted: number; dryRuns: number; needsReview: number; needsInput: number; failed: number; deferred: number };
    errors: string[];
    skippedReason?: string;
  } | null;
}

export interface Overview {
  stats: OverviewStats;
  automation: AllSettings['automation'];
  schedule: AllSettings['schedule'];
  profile: { name: string; verified: boolean; warnings: string[]; years: number } | null;
  attention: Array<{ id: number; title: string; company: string; status: JobStatus; status_reason: string | null; score: number | null }>;
  recent: EventRow[];
  runs: RunRow[];
  unread: number;
  pipelineRunning: boolean;
  nextRunHint: string;
}

export interface ResumeRecord {
  id: number;
  kind: 'original' | 'tailored';
  jobId: number | null;
  jobTitle?: string;
  company?: string;
  createdAt: string;
  isCurrent: boolean;
  files: { original?: number; pdf?: number; docx?: number; txt?: number; coverLetter?: number };
  summary: TailoringSummary | null;
  accuracy: AccuracyReport | null;
  coverLetterRequired: boolean;
  stale: boolean;
}

export interface JobDetail {
  job: {
    id: number;
    title: string;
    company: string;
    location: string | null;
    workMode: WorkMode;
    employmentType: string;
    salaryText: string | null;
    salaryMin: number | null;
    salaryMax: number | null;
    salaryCurrency: string | null;
    source: string;
    sourceUrl: string | null;
    applyUrl: string | null;
    ats: string | null;
    descriptionText: string | null;
    descriptionPartial: boolean;
    postedAt: string | null;
    discoveredAt: string;
    lastSeenAt: string;
    isActive: boolean;
    closedReason: string | null;
    status: JobStatus;
    statusReason: string | null;
    score: number | null;
    eligible: boolean;
    tracks: Track[];
    dismissed: boolean;
    notes: string | null;
    sightings: Array<{ source_type: string; url: string | null }>;
  };
  match: MatchResult | null;
  application: {
    id: number;
    adapter: string;
    adapterLabel: string;
    supportsAutoSubmit: boolean;
    state: ApplicationState;
    reviewReason: ReviewReason | null;
    questions: FormQuestion[];
    resolution: AnswerResolution | null;
    userAnswers: Record<string, string | string[]>;
    attempts: number;
    submittedAt: string | null;
    submittedVia: string | null;
    confirmationText: string | null;
    confirmationUrl: string | null;
    evidenceFileId: number | null;
    evidenceHtmlFileId: number | null;
    lastError: string | null;
    nextAction: string | null;
    lastAttempt: { outcome: string | null; detail: string | null; startedAt: string; finishedAt: string | null; dryRun: boolean; screenshotFileId: number | null; submitClicked: boolean } | null;
    history: Array<{ id: number; outcome: string | null; detail: string | null; startedAt: string; dryRun: boolean; trigger: string; screenshotFileId: number | null }>;
  } | null;
  resume: (ResumeRecord & { content: TailoredResume | null; coverLetter: string | null }) | null;
  events: EventRow[];
  busy: string | null;
}

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

export interface SourceType {
  type: string;
  label: string;
  kind: 'ats' | 'aggregator';
  integration: 'official_api' | 'public_api' | 'api_key_required';
  terms: string | null;
  configHelp: string;
}

export type SettingsResponse = AllSettings & {
  env: { llmEnabled: boolean; smtpEnabled: boolean; telegramConfigured: boolean; adzunaConfigured: boolean; publicUrl: string | null };
};

export type { JobListItem, Paged, ProfileRecord, CandidateProfile, SavedAnswer };
