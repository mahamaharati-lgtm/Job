import type {
  CandidateProfile,
  Conflict,
  EmploymentType,
  JobRequirements,
  MatchResult,
  ScoreBreakdown,
  SearchPreferences,
  Track,
  WorkMode,
} from '../shared/types.js';
import { experienceYears } from './profile/store.js';
import { candidateSkillIds, findSkills, skillCategory, skillLabel } from './skills.js';
import { normalizeCity } from './text.js';

/**
 * Scores a job against the verified profile and preferences, explains the fit, lists missing
 * requirements and flags hard eligibility conflicts. Deterministic and explainable.
 */

export const SCORING_VERSION = 4;

export interface MatchJobInput {
  title: string;
  company: string;
  location: string | null;
  workMode: WorkMode;
  employmentType: string;
  descriptionText: string;
  postedAt: string | null;
  salaryMin?: number | null;
  salaryMax?: number | null;
  salaryCurrency?: string | null;
}

// ---------------------------------------------------------------------------
// Requirements extraction
// ---------------------------------------------------------------------------
const REQUIRED_HEAD = /(requirements|required|must[- ]have|what you('ll)? (need|bring)|you (have|bring|should have)|qualifications|who you are|what we('re)? look(ing)? for|minimum qualifications|skills|about you|your profile|key skills)/i;
const PREFERRED_HEAD = /(nice[- ]to[- ]have|bonus|preferred|plus|good[- ]to[- ]have|desirable|extra credit|ideally|it would be great)/i;
const OTHER_HEAD = /(benefits|perks|about us|about the company|who we are|our values|compensation|why join|what we offer|equal opportunity|eeo)/i;

function sectionedLines(text: string): Array<{ line: string; ctx: 'required' | 'preferred' | 'other' | 'body' }> {
  const out: Array<{ line: string; ctx: 'required' | 'preferred' | 'other' | 'body' }> = [];
  let ctx: 'required' | 'preferred' | 'other' | 'body' = 'body';
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const isHeading = line.length < 70 && !/^[•\-*]/.test(line) && (/:$/.test(line) || line.split(' ').length <= 7);
    if (isHeading) {
      if (PREFERRED_HEAD.test(line)) ctx = 'preferred';
      else if (OTHER_HEAD.test(line)) ctx = 'other';
      else if (REQUIRED_HEAD.test(line)) ctx = 'required';
    }
    const inlinePreferred = PREFERRED_HEAD.test(line) && line.length > 30;
    out.push({ line, ctx: inlinePreferred && ctx !== 'other' ? 'preferred' : ctx });
  }
  return out;
}

const NUM_WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };

export function extractYears(text: string): { min: number | null; max: number | null } {
  const t = text
    .toLowerCase()
    .replace(/\b(one|two|three|four|five|six|seven|eight|nine|ten)\b/g, (w) => String(NUM_WORDS[w]))
    .replace(/year\(s\)/g, 'years');
  const found: Array<{ min: number; max: number | null }> = [];
  const push = (a: number, b: number | null) => {
    if (a <= 20 && (b === null || b <= 25)) found.push({ min: a, max: b });
  };
  // "3+ years of (professional) experience", "0-2 years experience", "minimum of 2 years in frontend"
  const re = /(?:(?:at least|minimum(?: of)?|min\.?)\s*)?(\d{1,2})(?:\.\d)?\s*(?:\+|plus)?\s*(?:(?:-|–|to)\s*(\d{1,2})\s*)?\+?\s*(?:years?|yrs?)(?:'|’)?\s*(?:of\s+)?(?:[\w\s/-]{0,40}?)?(?:experience|exp\b|working|building|developing|professional)/g;
  for (const m of t.matchAll(re)) push(Number(m[1]), m[2] ? Number(m[2]) : null);
  // "Experience: 2–6 Years", "Total Exp : 6 - 8 Years", "Exp - 3+ yrs"
  const re2 = /\b(?:total\s+)?(?:experience|exp)\b\.?\s*(?:required|level)?\s*[:\-–]\s*(\d{1,2})\s*\+?\s*(?:(?:-|–|to)\s*(\d{1,2})\s*)?\+?\s*(?:years?|yrs?)/g;
  for (const m of t.matchAll(re2)) push(Number(m[1]), m[2] ? Number(m[2]) : null);
  if (found.length === 0) return { min: null, max: null };
  // The overall requirement is the largest minimum ("5+ years overall, 2+ with React" → 5).
  const best = found.reduce((a, b) => (b.min > a.min ? b : a));
  return { min: best.min, max: best.max };
}

export function extractRequirements(job: MatchJobInput): JobRequirements {
  const text = job.descriptionText || '';
  const lines = sectionedLines(text);
  const required = new Set<string>();
  const preferred = new Set<string>();
  const mentioned = new Set<string>();
  for (const { line, ctx } of lines) {
    if (ctx === 'other') continue;
    for (const s of findSkills(line)) {
      if (ctx === 'required') required.add(s);
      else if (ctx === 'preferred') preferred.add(s);
      else mentioned.add(s);
    }
  }
  for (const s of findSkills(job.title)) required.add(s);
  for (const s of required) {
    preferred.delete(s);
    mentioned.delete(s);
  }
  for (const s of preferred) mentioned.delete(s);
  // Generic or ubiquitous tokens are not requirements by themselves.
  for (const generic of ['npm', 'vscode', 'devtools']) {
    required.delete(generic);
    preferred.delete(generic);
  }

  const lower = `${job.title}\n${text}`.toLowerCase();
  const { min, max } = extractYears(text);
  const title = job.title.toLowerCase();
  let seniority: JobRequirements['seniority'] = 'unknown';
  if (/\bintern(ship)?\b|trainee|apprentice/.test(title)) seniority = 'intern';
  else if (/\b(staff|principal|lead|head|director|manager|architect|vp)\b/.test(title)) seniority = 'lead';
  else if (/\b(senior|sr)\b|\biii\b|\bsde[- ]?3\b|\bl5\b/.test(title)) seniority = 'senior';
  else if (/\bii\b|\bsde[- ]?2\b|mid[- ]level|\bmid\b/.test(title)) seniority = 'mid';
  else if (/\b(junior|jr|associate|entry|graduate|fresher|new grad|early career)\b|\bsde[- ]?1\b|\bi\b$/.test(title)) seniority = 'junior';
  else if (min !== null) seniority = min <= 1 ? 'entry' : min <= 3 ? 'junior' : min <= 5 ? 'mid' : 'senior';

  let visaRestriction: string | null = null;
  const visa = lower.match(
    /(must be (legally )?(authorized|eligible) to work in (the )?([a-z .]+?)(?=[,.;\n]| without| and)|(?:no|not able to|unable to|cannot|can't|will not|won't) (?:provide |offer )?(?:visa )?sponsor(?:ship)?|(?:us|u\.s\.) citizens? only|green card|security clearance required)/,
  );
  if (visa) visaRestriction = visa[0].slice(0, 120);

  const remoteRegions: string[] = [];
  const regionMatch = lower.match(/remote[^.\n]{0,40}?\b(us|usa|united states|canada|uk|united kingdom|europe|eu|emea|latam|americas|apac|asia|india|worldwide|anywhere|global)\b/g);
  if (regionMatch) for (const m of regionMatch) remoteRegions.push(m.replace(/^remote[^a-z]*/, '').split(/\s+/).pop() ?? '');
  const locRegion = (job.location ?? '').match(/\((.+)\)/)?.[1];
  if (locRegion) remoteRegions.push(...locRegion.split(/[,/]| or /).map((s) => s.trim()).filter(Boolean));

  const normRegion = (r: string) =>
    r
      .toLowerCase()
      .replace(/\b(only|based|remote|candidates|residents|within|in)\b/g, ' ')
      .replace(/u\.s\.a?\.?|\busa\b|united states( of america)?/g, 'us')
      .replace(/\s+/g, ' ')
      .trim();
  return {
    requiredSkills: [...required],
    preferredSkills: [...preferred],
    mentionedSkills: [...mentioned],
    minYears: min,
    maxYears: max,
    seniority,
    workMode: job.workMode,
    employmentType: (job.employmentType as EmploymentType) || 'unknown',
    remoteRegions: [...new Set(remoteRegions.map(normRegion).filter(Boolean))],
    visaRestriction,
    requiresPhd: /\bph\.?d\b|doctorate/.test(lower) && /(required|must|need)/.test(lower.match(/.{0,80}ph\.?d.{0,80}/)?.[0] ?? ''),
    requiresClearance: /security clearance|secret clearance|ts\/sci/.test(lower),
    educationRequired: /bachelor|b\.?\s?tech|b\.?e\b|degree in computer/i.test(text) ? 'Bachelor’s degree' : null,
    coverLetterRequired: /cover letter (is )?(required|mandatory)|(include|attach|submit) a cover letter/.test(lower),
  };
}

// ---------------------------------------------------------------------------
// Track classification
// ---------------------------------------------------------------------------
const FRONTEND_TITLE = /front[\s-]?end|frontend|react|\bui\b|user interface|javascript|typescript|web (developer|engineer)|design engineer|ui\/ux|full[\s-]?stack/i;
const AI_TITLE = /prompt|\bllm\b|gen(erative)?[\s-]?ai|\bai\b|artificial intelligence|conversational|chatbot|ai[\s/-]?ml/i;
const ML_RESEARCH_TITLE =
  /machine learning|\bml\b|data scientist|research (scientist|engineer)|applied scientist|deep learning|computer vision|nlp (engineer|scientist)|ai research|mlops|model training/i;

export function classifyTracks(title: string, req: JobRequirements): Track[] {
  const tracks = new Set<Track>();
  if (FRONTEND_TITLE.test(title)) tracks.add('frontend');
  if (ML_RESEARCH_TITLE.test(title)) tracks.add('ml_research');
  else if (AI_TITLE.test(title)) tracks.add('ai');
  if (tracks.size === 0) {
    const all = [...req.requiredSkills, ...req.preferredSkills];
    const fe = all.filter((s) => ['react', 'typescript', 'javascript', 'nextjs', 'css', 'html', 'tailwind'].includes(s)).length;
    const ai = all.filter((s) => skillCategory(s) === 'ai').length;
    if (fe >= 2) tracks.add('frontend');
    if (ai >= 2) tracks.add('ai');
  }
  // "Software Engineer, AI products (React)" style roles count for both tracks.
  if (tracks.has('frontend') && req.requiredSkills.some((s) => skillCategory(s) === 'ai')) tracks.add('ai');
  if (tracks.size === 0) tracks.add('other');
  return [...tracks];
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------
const COUNTRY_NAMES: Record<string, string[]> = {
  IN: ['india', 'bengaluru', 'bangalore', 'mumbai', 'pune', 'hyderabad', 'chennai', 'delhi', 'gurugram', 'gurgaon', 'noida', 'kolkata', 'ahmedabad', 'kochi', 'mysuru', 'mangaluru', 'coimbatore', 'jaipur', 'indore', 'chandigarh', 'thiruvananthapuram'],
  US: ['united states', 'usa', 'u.s.', 'new york', 'san francisco', 'seattle', 'austin', 'boston', 'chicago', 'los angeles'],
  GB: ['united kingdom', 'uk', 'london', 'manchester'],
  CA: ['canada', 'toronto', 'vancouver'],
  DE: ['germany', 'berlin', 'munich'],
  SG: ['singapore'],
};
const REGION_INCLUDES: Record<string, string[]> = {
  IN: ['india', 'apac', 'asia', 'asia pacific', 'worldwide', 'anywhere', 'global', 'emea or apac'],
};
const RESTRICTED_REGIONS = ['us', 'usa', 'united states', 'canada', 'uk', 'united kingdom', 'europe', 'eu', 'emea', 'latam', 'americas', 'north america'];

function locationCountry(location: string | null): string | null {
  const l = (location ?? '').toLowerCase();
  for (const [code, names] of Object.entries(COUNTRY_NAMES)) if (names.some((n) => new RegExp(`\\b${n.replace('.', '\\.')}\\b`).test(l))) return code;
  return null;
}

function scoreLocation(job: MatchJobInput, req: JobRequirements, prefs: SearchPreferences, conflicts: Conflict[], highlights: string[]): number {
  const mode = job.workMode;
  const home = prefs.country || '';
  const prefCities = prefs.locations.map((c) => normalizeCity(c));
  const jobLoc = (job.location ?? '').toLowerCase();
  const inPreferredCity = prefCities.some((c) => c && (normalizeCity(jobLoc).includes(c) || jobLoc.split(/[,;/()]/).some((p) => normalizeCity(p) === c)));
  const country = locationCountry(job.location);

  if (mode !== 'unknown' && !prefs.workModes.includes(mode)) {
    conflicts.push({ code: 'location', severity: 'hard', message: `${mode === 'onsite' ? 'On-site' : mode[0].toUpperCase() + mode.slice(1)} role; you accept ${prefs.workModes.join(', ')}` });
    return 0;
  }
  if (mode === 'remote') {
    const regions = req.remoteRegions;
    const accepted = [...prefs.remoteRegions.map((r) => r.toLowerCase()), ...(REGION_INCLUDES[home] ?? [])];
    if (regions.length === 0) {
      if (country && home && country !== home) {
        conflicts.push({ code: 'remote_region', severity: 'soft', message: `Remote role listed in ${job.location}; check that candidates in your country are eligible` });
        return 6;
      }
      highlights.push('Remote role (region not restricted in the posting)');
      return 11;
    }
    if (regions.some((r) => accepted.includes(r))) {
      highlights.push(`Remote role open to ${regions.join(', ')}`);
      return 15;
    }
    if (regions.some((r) => RESTRICTED_REGIONS.includes(r))) {
      conflicts.push({ code: 'remote_region', severity: 'hard', message: `Remote role restricted to ${regions.join(', ')}` });
      return 0;
    }
    return 9;
  }
  if (inPreferredCity) {
    highlights.push(`Located in ${job.location}`);
    return 15;
  }
  if (!job.location || mode === 'unknown' && !country) return 7;
  if (home && country === home) {
    if (prefs.relocation.willing) return 11;
    conflicts.push({ code: 'location', severity: 'hard', message: `${mode === 'hybrid' ? 'Hybrid' : 'On-site'} in ${job.location}; outside your preferred locations and you are not open to relocation` });
    return 2;
  }
  if (country && home && country !== home) {
    const auth = prefs.workAuthorization.find((a) => a.country === country);
    if (!prefs.relocation.willing) {
      conflicts.push({ code: 'location', severity: 'hard', message: `Role based in ${job.location}; you are not open to relocating abroad` });
      return 0;
    }
    if (!auth || auth.status !== 'authorized') {
      conflicts.push({ code: 'work_authorization', severity: auth?.status === 'not_authorized' ? 'hard' : 'soft', message: `Requires work authorization for ${country}; not confirmed in your preferences` });
    }
    return 6;
  }
  return 7;
}

export function scoreJob(job: MatchJobInput, profile: CandidateProfile, prefs: SearchPreferences, now = new Date()): MatchResult {
  const req = extractRequirements(job);
  const tracks = classifyTracks(job.title, req);
  const conflicts: Conflict[] = [];
  const highlights: string[] = [];
  const have = candidateSkillIds(profile);

  // --- Skills (0-40)
  const weights = new Map<string, number>();
  for (const s of req.requiredSkills) weights.set(s, 1);
  for (const s of req.preferredSkills) if (!weights.has(s)) weights.set(s, 0.5);
  for (const s of req.mentionedSkills) if (!weights.has(s)) weights.set(s, 0.35);
  let total = 0;
  let got = 0;
  for (const [s, w] of weights) {
    total += w;
    if (have.has(s)) got += w;
  }
  const skills = weights.size === 0 ? 18 : Math.round((40 * got) / total);
  const matchedSkills = [...weights.keys()].filter((s) => have.has(s)).map(skillLabel);
  const missingRequired = req.requiredSkills.filter((s) => !have.has(s)).map(skillLabel);
  const missingPreferred = [...req.preferredSkills, ...req.mentionedSkills].filter((s) => !have.has(s)).map(skillLabel);

  // --- Title / track relevance (0-25)
  const titleLower = job.title.toLowerCase();
  const enabledTitles = [
    ...(prefs.tracks.frontend.enabled ? prefs.tracks.frontend.titles : []),
    ...(prefs.tracks.ai.enabled ? prefs.tracks.ai.titles : []),
  ].map((t) => t.toLowerCase());
  let title = 0;
  if (enabledTitles.some((t) => titleLower.includes(t) || t.includes(titleLower))) title = 25;
  else if (tracks.includes('frontend') && prefs.tracks.frontend.enabled) title = /front|react|\bui\b/.test(titleLower) ? 23 : 16;
  else if (tracks.includes('ai') && prefs.tracks.ai.enabled) title = /prompt|llm|ai application|generative/.test(titleLower) ? 22 : 14;
  else if (/software|developer|engineer/.test(titleLower)) title = 8;

  // --- Experience & seniority (0-15)
  const years = prefs.yearsOfExperience ?? experienceYears(profile, { now });
  let experience = 12;
  const juniorTarget = ['internship', 'entry', 'junior'].includes(prefs.experienceLevel);
  if (req.seniority === 'lead' || (req.seniority === 'senior' && juniorTarget)) {
    conflicts.push({ code: 'seniority', severity: 'hard', message: `${req.seniority === 'lead' ? 'Lead/staff-level' : 'Senior'} role; you are targeting ${prefs.experienceLevel}-level roles (~${years} yrs experience)` });
    experience = 0;
  } else if (req.seniority === 'intern' && !prefs.employmentTypes.includes('internship')) {
    conflicts.push({ code: 'employment_type', severity: 'hard', message: 'Internship; you are not looking for internships' });
    experience = 4;
  } else if (['junior', 'entry'].includes(req.seniority)) {
    experience = 15;
    highlights.push('Entry/junior-level role');
  } else if (req.seniority === 'mid' && juniorTarget) experience = 8;
  if (req.minYears !== null) {
    const gap = req.minYears - years;
    if (gap > 2.5) {
      conflicts.push({ code: 'experience_years', severity: 'hard', message: `Requires ${req.minYears}+ years; you have about ${years}` });
      experience = Math.min(experience, 0);
    } else if (gap > 0.6) {
      conflicts.push({ code: 'experience_years', severity: 'soft', message: `Asks for ${req.minYears}+ years; you have about ${years}` });
      experience = Math.min(experience, 7);
    } else if (req.minYears <= years + 0.5) {
      highlights.push(req.minYears === 0 ? 'No minimum experience required' : `Meets the ${req.minYears}+ year requirement`);
      experience = Math.max(experience, 13);
    }
  }

  // --- Location (0-15)
  const location = scoreLocation(job, req, prefs, conflicts, highlights);

  // --- Recency (0-5)
  let recency = 2;
  if (job.postedAt) {
    const days = (now.getTime() - new Date(job.postedAt).getTime()) / 86_400_000;
    recency = days <= 3 ? 5 : days <= 7 ? 4 : days <= 14 ? 3 : days <= 30 ? 1 : 0;
    if (days > prefs.maxJobAgeDays) conflicts.push({ code: 'stale', severity: 'soft', message: `Posted ${Math.round(days)} days ago` });
  }

  // --- Other eligibility rules
  if (tracks.includes('ml_research')) {
    const mlSkills = ['machine_learning', 'deep_learning', 'pytorch', 'tensorflow', 'fine_tuning', 'statistics'];
    if (!mlSkills.some((s) => have.has(s))) {
      conflicts.push({ code: 'ml_research', severity: 'hard', message: 'ML/research role: needs machine-learning experience that is not in your verified profile' });
    }
  }
  if (req.requiresPhd && !profile.education.some((e) => /ph\.?d|doctor/i.test(e.degree))) {
    conflicts.push({ code: 'phd', severity: 'hard', message: 'Requires a PhD' });
  }
  if (req.requiresClearance) conflicts.push({ code: 'clearance', severity: 'hard', message: 'Requires a security clearance' });
  if (req.employmentType !== 'unknown' && req.employmentType !== 'internship' && !prefs.employmentTypes.includes(req.employmentType)) {
    conflicts.push({ code: 'employment_type', severity: 'hard', message: `${req.employmentType.replace('_', '-')} role; you want ${prefs.employmentTypes.join(', ').replace(/_/g, '-')}` });
  }
  if (req.visaRestriction) {
    const country = locationCountry(job.location);
    const home = prefs.country;
    if (country && home && country !== home) {
      const auth = prefs.workAuthorization.find((a) => a.country === country);
      if (!auth || auth.status !== 'authorized') {
        conflicts.push({ code: 'work_authorization', severity: auth?.status === 'not_authorized' || auth?.status === 'needs_sponsorship' ? 'hard' : 'soft', message: `Posting says: "${req.visaRestriction}"` });
      }
    }
    const authCountry = /authori[sz]ed to work in (the )?(us|united states|u\.s\.)|us citizens|green card/.test(req.visaRestriction)
      ? 'US'
      : /authori[sz]ed to work in (the )?(uk|united kingdom)/.test(req.visaRestriction)
        ? 'GB'
        : /authori[sz]ed to work in canada/.test(req.visaRestriction)
          ? 'CA'
          : null;
    if (authCountry && authCountry !== home && !conflicts.some((c) => c.code === 'work_authorization')) {
      const auth = prefs.workAuthorization.find((a) => a.country === authCountry);
      if (!auth || auth.status !== 'authorized') {
        conflicts.push({ code: 'work_authorization', severity: 'hard', message: `Requires authorization to work in ${authCountry} (not confirmed in your preferences): "${req.visaRestriction}"` });
      }
    }
  }
  const hay = `${job.title} ${job.company} ${job.descriptionText}`.toLowerCase();
  const excludedCompany = prefs.excludedCompanies.find((c) => c && job.company.toLowerCase().includes(c.toLowerCase()));
  if (excludedCompany) conflicts.push({ code: 'excluded', severity: 'hard', message: `Excluded company (${excludedCompany})` });
  const excludedKw = prefs.excludedKeywords.find((k) => k && hay.includes(k.toLowerCase()));
  if (excludedKw) conflicts.push({ code: 'excluded', severity: 'hard', message: `Contains excluded keyword "${excludedKw}"` });
  if (prefs.salary.minimum && job.salaryMax && (!job.salaryCurrency || !prefs.salary.currency || job.salaryCurrency === prefs.salary.currency) && job.salaryMax < prefs.salary.minimum) {
    conflicts.push({ code: 'salary', severity: 'soft', message: `Listed salary (up to ${job.salaryMax.toLocaleString()}) is below your minimum` });
  }
  const trackEnabled = tracks.some((t) => (t === 'frontend' && prefs.tracks.frontend.enabled) || (t === 'ai' && prefs.tracks.ai.enabled));

  const breakdown: ScoreBreakdown = { title, skills, experience, location, recency };
  let score = title + skills + experience + location + recency;
  const hard = conflicts.filter((c) => c.severity === 'hard');
  if (hard.length) score = Math.min(score, 45);
  if (!trackEnabled) score = Math.min(score, 40);
  score = Math.max(0, Math.min(100, Math.round(score)));

  if (matchedSkills.length) highlights.unshift(`Matches ${matchedSkills.slice(0, 6).join(', ')}`);
  const parts: string[] = [];
  parts.push(
    `${score}/100 — ${hard.length ? 'not eligible as configured' : score >= 75 ? 'strong match' : score >= 60 ? 'reasonable match' : 'weak match'}.`,
  );
  if (matchedSkills.length) parts.push(`You have ${matchedSkills.length} of ${weights.size} skills the posting mentions.`);
  if (missingRequired.length) parts.push(`Missing required: ${missingRequired.slice(0, 6).join(', ')}.`);
  if (hard.length) parts.push(`Conflicts: ${hard.map((c) => c.message).join('; ')}.`);
  if (tracks.includes('ai') && !have.has('prompt_engineering') && !have.has('llm') && !have.has('genai')) {
    parts.push('Your verified profile lists no LLM/prompt-engineering experience; add it to your resume first if you have it.');
  }

  return {
    score,
    eligible: hard.length === 0 && trackEnabled,
    tracks,
    breakdown,
    matchedSkills,
    missingRequired,
    missingPreferred: [...new Set(missingPreferred)],
    conflicts,
    highlights,
    explanation: parts.join(' '),
    requirements: req,
    version: SCORING_VERSION,
  };
}
