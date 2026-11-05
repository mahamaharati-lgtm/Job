/**
 * Domain types shared by the API server and the React dashboard.
 * Keep this file free of runtime imports so both bundles can use it.
 */

// ---------------------------------------------------------------------------
// Job pipeline statuses (user-facing)
// ---------------------------------------------------------------------------
export const JOB_STATUSES = [
  'found',
  'matched',
  'resume_ready',
  'needs_review',
  'needs_input',
  'submitted',
  'failed',
  'closed',
] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export const STATUS_LABELS: Record<JobStatus, string> = {
  found: 'Found',
  matched: 'Matched',
  resume_ready: 'Resume ready',
  needs_review: 'Needs review',
  needs_input: 'Needs input',
  submitted: 'Submitted',
  failed: 'Failed',
  closed: 'Closed',
};

/** Internal application states. The job status is derived from these. */
export const APPLICATION_STATES = [
  'draft', // created, questions not resolved yet
  'needs_input', // required answers missing
  'ready', // all answers available, waiting for gate (auto) or approval (review)
  'needs_review', // waiting for the user (review mode, dry-run done, blocked, manual apply)
  'approved', // user approved, queued for submission
  'submitting', // claimed by a worker; a browser may be filling the form
  'submitted', // evidence of successful submission saved
  'uncertain', // submit was clicked but confirmation could not be verified
  'failed', // failed before submission was attempted (safe to retry)
] as const;
export type ApplicationState = (typeof APPLICATION_STATES)[number];

export type ReviewReason =
  | 'review_mode'
  | 'dry_run_complete'
  | 'verify_submission'
  | 'captcha'
  | 'login_required'
  | 'verification_required'
  | 'manual_apply'
  | 'possible_duplicate'
  | 'below_threshold'
  | 'auto_disabled'
  | 'profile_unverified'
  | 'daily_limit'
  | 'unsupported_form'
  | 'eligibility'
  | 'paused';

export const REVIEW_REASON_LABELS: Record<ReviewReason, string> = {
  review_mode: 'Review mode: approve to submit',
  dry_run_complete: 'Dry run complete: form filled, not submitted',
  verify_submission: 'Submission uncertain: please verify',
  captcha: 'CAPTCHA challenge: manual action required',
  login_required: 'Login required on the employer site',
  verification_required: 'Email/identity verification required',
  manual_apply: 'Apply manually (no supported integration)',
  possible_duplicate: 'Possible duplicate of an earlier application',
  below_threshold: 'Below your match threshold',
  auto_disabled: 'Automatic mode is off',
  profile_unverified: 'Verify your profile to enable automatic submission',
  daily_limit: 'Daily application limit reached',
  unsupported_form: 'Form layout not supported for automation',
  eligibility: 'Eligibility conflict: review before applying',
  paused: 'Automation paused',
};

export type Track = 'frontend' | 'ai' | 'ml_research' | 'other';
export const TRACK_LABELS: Record<Track, string> = {
  frontend: 'Frontend / React',
  ai: 'AI / Prompting',
  ml_research: 'ML research',
  other: 'Other',
};

export type WorkMode = 'remote' | 'hybrid' | 'onsite' | 'unknown';
export type EmploymentType = 'full_time' | 'part_time' | 'contract' | 'internship' | 'temporary' | 'unknown';
export type ExperienceLevel = 'internship' | 'entry' | 'junior' | 'mid' | 'senior';

// ---------------------------------------------------------------------------
// Candidate profile (source of truth extracted from the uploaded resume)
// ---------------------------------------------------------------------------
export interface Link {
  label: string;
  url: string;
}
export interface Bullet {
  id: string;
  text: string;
}
export interface SkillGroup {
  name: string;
  skills: string[];
}
export interface ExperienceItem {
  id: string;
  title: string;
  company: string;
  location?: string;
  /** ISO month, e.g. "2025-07" */
  startDate: string;
  /** ISO month or null for "Present" */
  endDate: string | null;
  bullets: Bullet[];
}
export interface ProjectItem {
  id: string;
  name: string;
  subtitle?: string;
  technologies: string[];
  links: Link[];
  bullets: Bullet[];
}
export interface EducationItem {
  id: string;
  degree: string;
  institution: string;
  /** Free-form date text as written on the resume, e.g. "2025" or "2021 – 2025" */
  dates?: string;
  grade?: string;
  details: string[];
}
export interface CertificationItem {
  id: string;
  name: string;
  issuer?: string;
  date?: string;
}
export interface AdditionalSection {
  id: string;
  title: string;
  items: string[];
}
export interface CandidateProfile {
  name: string;
  headline: string;
  email: string;
  phone: string;
  location: string;
  links: Link[];
  summary: string;
  skillGroups: SkillGroup[];
  experience: ExperienceItem[];
  projects: ProjectItem[];
  education: EducationItem[];
  certifications: CertificationItem[];
  additional: AdditionalSection[];
}

export interface ProfileRecord {
  profile: CandidateProfile;
  verified: boolean;
  verifiedAt: string | null;
  updatedAt: string;
  sourceResumeId: number | null;
  extractionMethod: 'heuristic' | 'llm' | 'manual';
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Preferences and settings
// ---------------------------------------------------------------------------
export interface WorkAuthorizationEntry {
  /** ISO country code, e.g. "IN", "US" */
  country: string;
  status: 'authorized' | 'needs_sponsorship' | 'not_authorized';
}

export interface SearchPreferences {
  tracks: {
    frontend: { enabled: boolean; titles: string[] };
    ai: { enabled: boolean; titles: string[] };
  };
  /** Free-text search keywords for aggregator sources (Adzuna, Remotive, ...) */
  keywords: string[];
  /** Preferred cities/regions for on-site or hybrid work */
  locations: string[];
  /** Home country, ISO code (used for remote eligibility and aggregator search) */
  country: string;
  workModes: WorkMode[];
  /** Remote-eligibility regions that include you, e.g. ["India", "APAC", "Worldwide"] */
  remoteRegions: string[];
  relocation: { willing: boolean; locations: string[] };
  experienceLevel: ExperienceLevel;
  /** Override computed years of experience; null = compute from profile */
  yearsOfExperience: number | null;
  employmentTypes: EmploymentType[];
  salary: { minimum: number | null; currency: string; period: 'year' | 'month' | 'hour' };
  /** Used only for eligibility matching. Application answers come from the answer bank. */
  workAuthorization: WorkAuthorizationEntry[];
  excludedCompanies: string[];
  excludedKeywords: string[];
  maxJobAgeDays: number;
}

export interface AutomationSettings {
  mode: 'review' | 'auto';
  /** Global kill switch: nothing is submitted or filled while paused. */
  paused: boolean;
  /** When true, forms are filled and screenshotted but never submitted. */
  dryRun: boolean;
  dailyLimit: number;
  maxPerRun: number;
  matchThreshold: number;
  autoTracks: Track[];
  captchaPolicy: 'pause_if_present' | 'pause_if_challenged';
  autoTailor: boolean;
  coverLetters: 'when_required' | 'always' | 'never';
  delayBetweenApplicationsSec: number;
}

export interface ScheduleSettings {
  timezone: string;
  discoveryEveryHours: number;
  /** Local time "HH:MM" for the daily digest */
  digestTime: string;
  enabled: boolean;
}

export interface NotificationSettings {
  email: { enabled: boolean; to: string };
  telegram: { enabled: boolean; chatId: string };
  ntfy: { enabled: boolean; server: string; topic: string };
  webhook: { enabled: boolean; url: string };
  events: {
    needsInput: boolean;
    needsReview: boolean;
    submitted: boolean;
    failed: boolean;
    digest: boolean;
  };
}

export interface LlmSettings {
  /** Use Claude (if ANTHROPIC_API_KEY is configured) for these steps. */
  profileExtraction: boolean;
  tailoring: boolean;
  coverLetters: boolean;
}

export interface AllSettings {
  preferences: SearchPreferences;
  automation: AutomationSettings;
  schedule: ScheduleSettings;
  notifications: NotificationSettings;
  llm: LlmSettings;
}

// ---------------------------------------------------------------------------
// Answer bank (saved answers for application questions)
// ---------------------------------------------------------------------------
export const ANSWER_CATEGORIES = [
  'work_authorization',
  'sponsorship',
  'salary_expectation',
  'current_compensation',
  'notice_period',
  'start_date',
  'relocation',
  'onsite_ok',
  'years_experience',
  'how_heard',
  'gender',
  'race_ethnicity',
  'veteran',
  'disability',
  'pronouns',
  'sexual_orientation',
  'age',
  'legal_consent',
  'background_check',
  'custom',
] as const;
export type AnswerCategory = (typeof ANSWER_CATEGORIES)[number];

/** Categories that are never guessed. They require an explicit saved answer. */
export const SENSITIVE_CATEGORIES: AnswerCategory[] = [
  'work_authorization',
  'sponsorship',
  'salary_expectation',
  'current_compensation',
  'notice_period',
  'start_date',
  'relocation',
  'onsite_ok',
  'years_experience',
  'gender',
  'race_ethnicity',
  'veteran',
  'disability',
  'pronouns',
  'sexual_orientation',
  'age',
  'legal_consent',
  'background_check',
];

export const ANSWER_CATEGORY_LABELS: Record<AnswerCategory, string> = {
  work_authorization: 'Work authorization',
  sponsorship: 'Visa sponsorship',
  salary_expectation: 'Salary expectation',
  current_compensation: 'Current compensation (CTC)',
  notice_period: 'Notice period',
  start_date: 'Earliest start date',
  relocation: 'Willing to relocate',
  onsite_ok: 'OK with on-site / hybrid',
  years_experience: 'Years of experience',
  how_heard: 'How did you hear about us',
  gender: 'Gender (voluntary)',
  race_ethnicity: 'Race / ethnicity (voluntary)',
  veteran: 'Veteran status (voluntary)',
  disability: 'Disability status (voluntary)',
  pronouns: 'Pronouns (voluntary)',
  sexual_orientation: 'Sexual orientation (voluntary)',
  age: 'Age / date of birth',
  legal_consent: 'Legal declarations & consent',
  background_check: 'Background check questions',
  custom: 'Custom question',
};

export interface SavedAnswer {
  id: string;
  category: AnswerCategory;
  /** For custom answers: the question text it answers. For others: optional note. */
  question: string;
  answer: string;
  /** Optional ISO country this answer applies to (e.g. work authorization for "IN"). */
  country?: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Application form questions
// ---------------------------------------------------------------------------
export type QuestionType =
  | 'text'
  | 'textarea'
  | 'select'
  | 'multi_select'
  | 'radio'
  | 'checkbox'
  | 'file'
  | 'email'
  | 'tel'
  | 'url'
  | 'number'
  | 'date'
  | 'hidden';

export interface QuestionOption {
  label: string;
  value: string;
}

export interface FormQuestion {
  /** Stable id within the form (field name). */
  id: string;
  label: string;
  description?: string;
  required: boolean;
  type: QuestionType;
  options?: QuestionOption[];
  /** Section of the form (e.g. "eeo", "custom", "contact") */
  section?: string;
}

export type AnswerSource = 'profile' | 'saved_answer' | 'resume_file' | 'cover_letter' | 'user' | 'derived';

export interface ResolvedAnswer {
  questionId: string;
  label: string;
  category: AnswerCategory | 'contact' | 'link' | 'resume' | 'cover_letter' | 'skill_experience' | 'unknown';
  value: string | string[] | null;
  source: AnswerSource | null;
  sensitive: boolean;
  required: boolean;
  /** Human-readable explanation of why the answer is missing or where it came from */
  note?: string;
}

export interface AnswerResolution {
  answers: ResolvedAnswer[];
  missing: ResolvedAnswer[];
  complete: boolean;
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------
export interface JobRequirements {
  requiredSkills: string[];
  preferredSkills: string[];
  mentionedSkills: string[];
  minYears: number | null;
  maxYears: number | null;
  seniority: 'intern' | 'entry' | 'junior' | 'mid' | 'senior' | 'lead' | 'unknown';
  workMode: WorkMode;
  employmentType: EmploymentType;
  remoteRegions: string[];
  visaRestriction: string | null;
  requiresPhd: boolean;
  requiresClearance: boolean;
  educationRequired: string | null;
  coverLetterRequired: boolean;
}

export interface Conflict {
  code:
    | 'seniority'
    | 'experience_years'
    | 'location'
    | 'remote_region'
    | 'work_authorization'
    | 'employment_type'
    | 'excluded'
    | 'ml_research'
    | 'phd'
    | 'clearance'
    | 'salary'
    | 'stale';
  severity: 'hard' | 'soft';
  message: string;
}

export interface ScoreBreakdown {
  title: number;
  skills: number;
  experience: number;
  location: number;
  recency: number;
}

export interface MatchResult {
  score: number;
  eligible: boolean;
  tracks: Track[];
  breakdown: ScoreBreakdown;
  matchedSkills: string[];
  missingRequired: string[];
  missingPreferred: string[];
  conflicts: Conflict[];
  highlights: string[];
  explanation: string;
  requirements: JobRequirements;
  version: number;
}

// ---------------------------------------------------------------------------
// Tailored resume
// ---------------------------------------------------------------------------
export type ResumeSection = 'summary' | 'skills' | 'experience' | 'projects' | 'education' | 'certifications' | 'additional';

export interface TailoredBullet {
  sourceId: string;
  text: string;
}

export interface TailoredResume {
  contact: { name: string; email: string; phone: string; location: string; links: Link[] };
  headline: string;
  summary: string;
  sectionOrder: ResumeSection[];
  skillGroups: SkillGroup[];
  experience: Array<Omit<ExperienceItem, 'bullets' | 'id'> & { sourceId: string; bullets: TailoredBullet[] }>;
  projects: Array<Omit<ProjectItem, 'bullets' | 'id'> & { sourceId: string; bullets: TailoredBullet[] }>;
  education: EducationItem[];
  certifications: CertificationItem[];
  additional: AdditionalSection[];
}

export interface FactIssue {
  severity: 'error' | 'warning';
  path: string;
  message: string;
}

export interface AccuracyReport {
  ok: boolean;
  checkedAt: string;
  issues: FactIssue[];
  /** LLM rewrites rejected by the fact-checker (original text kept) */
  rejectedRewrites: Array<{ path: string; proposed: string; reasons: string[] }>;
}

export interface TailoringSummary {
  changes: string[];
  matchedKeywords: string[];
  gaps: string[];
  method: 'deterministic' | 'llm_assisted';
}

// ---------------------------------------------------------------------------
// API DTOs
// ---------------------------------------------------------------------------
export interface JobListItem {
  id: number;
  title: string;
  company: string;
  location: string | null;
  workMode: WorkMode;
  source: string;
  status: JobStatus;
  statusReason: string | null;
  score: number | null;
  eligible: boolean;
  tracks: Track[];
  postedAt: string | null;
  discoveredAt: string;
  isActive: boolean;
  dismissed: boolean;
  applyUrl: string | null;
  hasTailoredResume: boolean;
}

export interface Paged<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export interface OverviewStats {
  totals: Record<JobStatus, number>;
  byTrack: Record<'frontend' | 'ai', number>;
  foundLast24h: number;
  submittedToday: number;
  submittedTotal: number;
  dailyLimit: number;
}
