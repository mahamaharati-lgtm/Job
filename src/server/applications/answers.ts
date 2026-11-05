import type {
  AnswerCategory,
  AnswerResolution,
  CandidateProfile,
  FormQuestion,
  ResolvedAnswer,
  SavedAnswer,
} from '../../shared/types.js';
import { SENSITIVE_CATEGORIES } from '../../shared/types.js';
import { decryptJson, encryptJson, shortId } from '../crypto.js';
import { all, nowIso, run } from '../db.js';
import { candidateSkillIds, findSkills } from '../skills.js';
import { similarity } from '../text.js';

/**
 * Question classification and answer resolution. Sensitive or material questions are only
 * ever answered from the saved answer bank (or explicit per-application answers); otherwise
 * the application goes to "Needs input". Nothing is guessed.
 */

// ---------------------------------------------------------------------------
// Answer bank
// ---------------------------------------------------------------------------
export function listSavedAnswers(): SavedAnswer[] {
  return all<{ id: string; category: AnswerCategory; data_enc: string; updated_at: string }>('SELECT * FROM answers ORDER BY category, updated_at').map((r) => {
    const d = decryptJson<{ question: string; answer: string; country?: string }>(r.data_enc);
    return { id: r.id, category: r.category, question: d.question, answer: d.answer, country: d.country, updatedAt: r.updated_at };
  });
}

export function upsertSavedAnswer(a: { id?: string; category: AnswerCategory; question?: string; answer: string; country?: string }): SavedAnswer {
  const id = a.id || shortId('ans_');
  const data = { question: (a.question ?? '').trim(), answer: a.answer.trim(), country: a.country?.trim().toUpperCase() || undefined };
  run(
    `INSERT INTO answers (id, category, data_enc, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET category = excluded.category, data_enc = excluded.data_enc, updated_at = excluded.updated_at`,
    [id, a.category, encryptJson(data), nowIso()],
  );
  return listSavedAnswers().find((x) => x.id === id)!;
}

export function deleteSavedAnswer(id: string): void {
  run('DELETE FROM answers WHERE id = ?', [id]);
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------
export type QuestionKind =
  | { kind: 'contact'; field: 'first_name' | 'last_name' | 'full_name' | 'email' | 'phone' | 'location' | 'current_company' | 'current_title' }
  | { kind: 'link'; field: 'linkedin' | 'github' | 'portfolio' | 'website' | 'twitter' | 'other' }
  | { kind: 'resume' }
  | { kind: 'cover_letter' }
  | { kind: 'skill_experience'; skill: string }
  | { kind: 'category'; category: AnswerCategory }
  | { kind: 'unknown' };

const RULES: Array<[RegExp, QuestionKind]> = [
  [/^(legal )?first name|given name|preferred first name/, { kind: 'contact', field: 'first_name' }],
  [/^(legal )?last name|surname|family name/, { kind: 'contact', field: 'last_name' }],
  [/^(full |legal |your )?name\b(?!.*(company|employer|school|reference|referr))/, { kind: 'contact', field: 'full_name' }],
  [/e-?mail/, { kind: 'contact', field: 'email' }],
  [/phone|mobile|contact number|whatsapp/, { kind: 'contact', field: 'phone' }],
  [/linkedin/, { kind: 'link', field: 'linkedin' }],
  [/github/, { kind: 'link', field: 'github' }],
  [/portfolio/, { kind: 'link', field: 'portfolio' }],
  [/twitter|x\.com/, { kind: 'link', field: 'twitter' }],
  [/website|personal (site|url)|blog/, { kind: 'link', field: 'website' }],
  [/^resume|resume\/cv|^cv\b|curriculum vitae/, { kind: 'resume' }],
  [/cover letter/, { kind: 'cover_letter' }],
  [/sponsor|visa|h-?1b|immigration (status|support)/, { kind: 'category', category: 'sponsorship' }],
  [/authori[sz]ed to work|legally (authori[sz]ed|eligible|permitted)|right to work|work permit|eligible to work|work authori[sz]ation/, { kind: 'category', category: 'work_authorization' }],
  [/current (ctc|salary|compensation|pay)|present (ctc|salary)/, { kind: 'category', category: 'current_compensation' }],
  [/salary|compensation|pay (range|expectation)|expected ctc|\bectc\b|desired pay|remuneration|\bctc\b|rate expectation/, { kind: 'category', category: 'salary_expectation' }],
  [/notice period|serving notice|last working day/, { kind: 'category', category: 'notice_period' }],
  [/start date|when can you (start|join)|earliest|available to (start|join)|availability|joining date/, { kind: 'category', category: 'start_date' }],
  [/relocat/, { kind: 'category', category: 'relocation' }],
  [/on-?site|in (the )?office|commut|hybrid|days (a|per) week|work from (the )?office/, { kind: 'category', category: 'onsite_ok' }],
  [/years of (professional |relevant |total )?experience|how many years/, { kind: 'category', category: 'years_experience' }],
  [/how did you (hear|find|learn)|where did you (hear|find)|referral source|source of application/, { kind: 'category', category: 'how_heard' }],
  [/pronoun/, { kind: 'category', category: 'pronouns' }],
  [/sexual orientation|transgender|lgbt/, { kind: 'category', category: 'sexual_orientation' }],
  [/gender|\bsex\b/, { kind: 'category', category: 'gender' }],
  [/race|ethnic|hispanic|latin[oa]/, { kind: 'category', category: 'race_ethnicity' }],
  [/veteran|military|armed forces/, { kind: 'category', category: 'veteran' }],
  [/disabilit/, { kind: 'category', category: 'disability' }],
  [/date of birth|\bage\b|birth ?date/, { kind: 'category', category: 'age' }],
  [/background check|criminal|convicted|felony|drug (test|screen)/, { kind: 'category', category: 'background_check' }],
  [/i (certify|acknowledge|agree|consent|confirm|attest|understand)|privacy (policy|notice)|terms (of|and)|consent|declar|accurate and complete|gdpr|data processing|retain my/, { kind: 'category', category: 'legal_consent' }],
  [/^(current )?(location|city)|where are you (based|located)|current address|city of residence/, { kind: 'contact', field: 'location' }],
  [/current (company|employer)|^company$|^organi[sz]ation$|present employer/, { kind: 'contact', field: 'current_company' }],
  [/current (title|role|position|designation)/, { kind: 'contact', field: 'current_title' }],
];

export function classifyQuestion(q: Pick<FormQuestion, 'id' | 'label' | 'type'>): QuestionKind {
  const label = q.label.toLowerCase().replace(/[*✱]/g, '').trim();
  const id = q.id.toLowerCase();
  if (q.type === 'file') {
    if (/cover/.test(label) || /cover/.test(id)) return { kind: 'cover_letter' };
    if (/resume|cv/.test(label) || /resume|cv/.test(id)) return { kind: 'resume' };
  }
  // Well-known field names used by Greenhouse / Lever forms
  const byId: Record<string, QuestionKind> = {
    first_name: { kind: 'contact', field: 'first_name' },
    last_name: { kind: 'contact', field: 'last_name' },
    name: { kind: 'contact', field: 'full_name' },
    email: { kind: 'contact', field: 'email' },
    phone: { kind: 'contact', field: 'phone' },
    location: { kind: 'contact', field: 'location' },
    org: { kind: 'contact', field: 'current_company' },
    resume: { kind: 'resume' },
    cover_letter: { kind: 'cover_letter' },
    comments: { kind: 'cover_letter' },
    'urls[linkedin]': { kind: 'link', field: 'linkedin' },
    'urls[github]': { kind: 'link', field: 'github' },
    'urls[portfolio]': { kind: 'link', field: 'portfolio' },
    'urls[twitter]': { kind: 'link', field: 'twitter' },
    'urls[other]': { kind: 'link', field: 'other' },
    'eeo[gender]': { kind: 'category', category: 'gender' },
    'eeo[race]': { kind: 'category', category: 'race_ethnicity' },
    'eeo[veteran]': { kind: 'category', category: 'veteran' },
    'eeo[disability]': { kind: 'category', category: 'disability' },
    gender: { kind: 'category', category: 'gender' },
    race: { kind: 'category', category: 'race_ethnicity' },
    hispanic_ethnicity: { kind: 'category', category: 'race_ethnicity' },
    veteran_status: { kind: 'category', category: 'veteran' },
    disability_status: { kind: 'category', category: 'disability' },
  };
  if (byId[id]) return byId[id];
  if (/^eeo\[|^demographic/.test(id)) return { kind: 'category', category: 'gender' };
  for (const [re, kind] of RULES) if (re.test(label)) return kind;
  const skillQ = label.match(/(?:do you have|have you (?:worked|used)|are you (?:proficient|experienced|familiar)|experience (?:with|in|using))\s+(?:any\s+)?(?:professional\s+|hands-on\s+)?(?:experience\s+)?(?:with|in|using)?\s*(.+?)\??$/);
  if (skillQ && (q.type === 'select' || q.type === 'radio' || q.type === 'checkbox')) {
    const skills = findSkills(skillQ[1]);
    if (skills.length === 1) return { kind: 'skill_experience', skill: skills[0] };
  }
  return { kind: 'unknown' };
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------
export interface ResolveContext {
  profile: CandidateProfile;
  bank: SavedAnswer[];
  userAnswers: Record<string, string | string[]>;
  jobCountry: string | null;
  jobSource: string;
  coverLetterPolicy: 'when_required' | 'always' | 'never';
  coverLetterRequired: boolean;
}

function splitName(name: string): { first: string; last: string } {
  const parts = name.trim().split(/\s+/);
  return { first: parts[0] ?? '', last: parts.slice(1).join(' ') };
}

function findLink(profile: CandidateProfile, field: string): string | null {
  const links = profile.links;
  const by = (re: RegExp) => links.find((l) => re.test(l.url) || re.test(l.label))?.url ?? null;
  switch (field) {
    case 'linkedin':
      return by(/linkedin/i);
    case 'github':
      return by(/github\.com/i);
    case 'portfolio':
    case 'website':
      return links.find((l) => /portfolio|website|github\.io/i.test(l.label + l.url) && !/linkedin|github\.com/i.test(l.url))?.url ?? null;
    case 'twitter':
      return by(/twitter|x\.com/i);
    default:
      return null;
  }
}

const YES = /^(yes|y|true|i agree|agree|i do|i am|authorized|i consent)$/i;
const NO = /^(no|n|false|i do not|i don't|not authorized)$/i;

/** Map a free-text answer onto one of the question's options. Returns null if ambiguous. */
export function matchOption(answer: string, options: Array<{ label: string; value: string }>): string | null {
  const a = answer.trim().toLowerCase();
  if (!a) return null;
  const exact = options.find((o) => o.label.trim().toLowerCase() === a || o.value.trim().toLowerCase() === a);
  if (exact) return exact.label;
  if (YES.test(a)) {
    const yes = options.filter((o) => /^yes\b/i.test(o.label.trim()));
    if (yes.length === 1) return yes[0].label;
  }
  if (NO.test(a)) {
    const no = options.filter((o) => /^no\b/i.test(o.label.trim()));
    if (no.length === 1) return no[0].label;
  }
  if (/decline|prefer not|don't wish|do not wish|not to (say|answer|disclose)/i.test(a)) {
    const d = options.filter((o) => /decline|prefer not|don't wish|do not wish|not to (say|answer|disclose|self-identify)/i.test(o.label));
    if (d.length === 1) return d[0].label;
  }
  const starts = options.filter((o) => o.label.toLowerCase().startsWith(a) || a.startsWith(o.label.toLowerCase()));
  if (starts.length === 1) return starts[0].label;
  return null;
}

function bankLookup(bank: SavedAnswer[], category: AnswerCategory, country: string | null, label: string): SavedAnswer | null {
  if (category === 'custom') {
    let best: SavedAnswer | null = null;
    let bestScore = 0;
    for (const a of bank.filter((b) => b.category === 'custom')) {
      const s = similarity(a.question, label);
      if (s > bestScore) {
        best = a;
        bestScore = s;
      }
    }
    return bestScore >= 0.75 ? best : null;
  }
  const candidates = bank.filter((b) => b.category === category);
  if (country) {
    const specific = candidates.find((c) => c.country === country);
    if (specific) return specific;
  }
  return candidates.find((c) => !c.country) ?? (candidates.length === 1 && !country ? candidates[0] : null);
}

export function resolveAnswers(questions: FormQuestion[], ctx: ResolveContext): AnswerResolution {
  const answers: ResolvedAnswer[] = [];
  const skills = candidateSkillIds(ctx.profile);
  const { first, last } = splitName(ctx.profile.name);
  const current = ctx.profile.experience.find((e) => e.endDate === null) ?? null;

  for (const q of questions) {
    if (q.type === 'hidden') continue;
    const kind = classifyQuestion(q);
    const category: ResolvedAnswer['category'] =
      kind.kind === 'category' ? kind.category : kind.kind === 'contact' ? 'contact' : kind.kind === 'link' ? 'link' : kind.kind === 'resume' ? 'resume' : kind.kind === 'cover_letter' ? 'cover_letter' : kind.kind === 'skill_experience' ? 'skill_experience' : 'unknown';
    const sensitive = kind.kind === 'category' && SENSITIVE_CATEGORIES.includes(kind.category);
    const base: ResolvedAnswer = { questionId: q.id, label: q.label, category, value: null, source: null, sensitive, required: q.required };

    // 1. Explicit answer for this application always wins.
    const user = ctx.userAnswers[q.id];
    if (user !== undefined && user !== '' && !(Array.isArray(user) && user.length === 0)) {
      answers.push({ ...base, value: user, source: 'user' });
      continue;
    }

    let value: string | string[] | null = null;
    let source: ResolvedAnswer['source'] = null;
    let note: string | undefined;
    switch (kind.kind) {
      case 'contact': {
        const map: Record<string, string> = {
          first_name: first,
          last_name: last,
          full_name: ctx.profile.name,
          email: ctx.profile.email,
          phone: ctx.profile.phone,
          location: ctx.profile.location,
          current_company: current?.company ?? '',
          current_title: current?.title ?? '',
        };
        value = map[kind.field] || null;
        source = value ? 'profile' : null;
        if (!value) note = 'Not in your profile';
        break;
      }
      case 'link':
        value = findLink(ctx.profile, kind.field);
        source = value ? 'profile' : null;
        if (!value) note = `No ${kind.field} link in your profile`;
        break;
      case 'resume':
        value = q.type === 'file' ? 'tailored_resume.pdf' : null;
        source = 'resume_file';
        if (q.type !== 'file') {
          value = null;
          source = null;
          note = 'Text resume field: filled with the tailored plain-text resume';
          value = '__RESUME_TEXT__';
          source = 'resume_file';
        }
        break;
      case 'cover_letter': {
        const want = ctx.coverLetterPolicy === 'always' || (ctx.coverLetterPolicy === 'when_required' && (q.required || ctx.coverLetterRequired));
        if (want && ctx.coverLetterPolicy !== 'never') {
          value = q.type === 'file' ? 'cover_letter.pdf' : '__COVER_LETTER_TEXT__';
          source = 'cover_letter';
        } else if (q.required) note = 'Cover letter required but your settings say never attach one';
        break;
      }
      case 'skill_experience':
        if (skills.has(kind.skill)) {
          value = 'Yes';
          source = 'derived';
          note = 'Listed in your verified profile';
        } else note = 'Not in your verified profile — answer yourself';
        break;
      case 'category': {
        const saved = bankLookup(ctx.bank, kind.category, ctx.jobCountry, q.label);
        if (saved) {
          value = saved.answer;
          source = 'saved_answer';
        } else if (kind.category === 'how_heard') {
          value = ['greenhouse', 'lever', 'ashby', 'smartrecruiters'].includes(ctx.jobSource) ? 'Company careers page' : 'Job board';
          source = 'derived';
        } else note = sensitive ? 'Sensitive: answer it once in your Answer bank (never guessed)' : 'No saved answer';
        break;
      }
      case 'unknown': {
        const saved = bankLookup(ctx.bank, 'custom', null, q.label);
        if (saved) {
          value = saved.answer;
          source = 'saved_answer';
        } else note = 'Custom question: needs your answer';
        break;
      }
    }

    // Map onto select/radio options.
    if (value && typeof value === 'string' && q.options?.length && ['select', 'radio', 'multi_select', 'checkbox'].includes(q.type) && !value.startsWith('__')) {
      const opt = matchOption(value, q.options);
      if (opt) value = q.type === 'multi_select' || (q.type === 'checkbox' && q.options.length > 1) ? [opt] : opt;
      else {
        note = `Saved answer "${value}" does not match any option (${q.options.map((o) => o.label).slice(0, 5).join(' / ')})`;
        value = null;
        source = null;
      }
    }
    answers.push({ ...base, value, source, note });
  }
  const missing = answers.filter((a) => a.required && (a.value === null || (Array.isArray(a.value) && a.value.length === 0)));
  return { answers, missing, complete: missing.length === 0 };
}
