import type { AccuracyReport, CandidateProfile, FactIssue, TailoredResume } from '../../shared/types.js';
import { findSkills } from '../skills.js';
import { extractNumbers } from '../text.js';

/**
 * Factual accuracy guard. A tailored resume may reorder and rephrase, but every employer,
 * title, date, school, skill, number and tool must trace back to the verified profile.
 */

const SCOPE_VERBS = /\b(led|lead|leading|managed|managing|mentored|mentoring|supervised|owned|spearheaded|headed|architected|directed|launched|scaled|increased|reduced|boosted|grew|drove|saved|improved by|oversaw|founded|pioneered)\b/gi;

function norm(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, ' ');
}

/** Tokens that look like named entities or tools: CamelCase, ALLCAPS, containing digits/dots. */
function entityTokens(s: string): Set<string> {
  const out = new Set<string>();
  const words = s.split(/[\s,;:()"“”]+/).filter(Boolean);
  words.forEach((w, i) => {
    const clean = w.replace(/^[^\w₹$]+|[^\w+#%]+$/g, '');
    if (!clean) return;
    const isStart = i === 0 || /[.!?]$/.test(words[i - 1] ?? '');
    if (/[A-Z].*[A-Z]/.test(clean) || /\d/.test(clean) || (/^[A-Z]/.test(clean) && !isStart && clean.length > 1)) out.add(clean.toLowerCase());
  });
  return out;
}

export function checkRewrite(source: string, rewrite: string, allowedContext: string): string[] {
  const reasons: string[] = [];
  const srcNums = new Set(extractNumbers(source));
  for (const n of extractNumbers(rewrite)) if (!srcNums.has(n)) reasons.push(`introduces the number "${n}"`);
  const srcSkills = new Set(findSkills(`${source}\n${allowedContext}`));
  for (const s of findSkills(rewrite)) if (!srcSkills.has(s)) reasons.push(`introduces the skill/tool "${s}"`);
  // Named things (capitalised words, acronyms, tokens with digits) must appear somewhere in the source.
  const sourceWords = new Set(`${source} ${allowedContext}`.toLowerCase().split(/[^\p{L}\p{N}+#.%₹$-]+/u).map((w) => w.replace(/^[.-]+|[.-]+$/g, '')).filter(Boolean));
  for (const t of entityTokens(rewrite)) {
    const clean = t.replace(/^[.-]+|[.-]+$/g, '');
    if (!sourceWords.has(clean) && !srcSkills.has(clean)) reasons.push(`introduces "${t}"`);
  }
  const srcVerbs = new Set((source.match(SCOPE_VERBS) ?? []).map((v) => v.toLowerCase()));
  for (const v of rewrite.match(SCOPE_VERBS) ?? []) if (!srcVerbs.has(v.toLowerCase())) reasons.push(`inflates scope with "${v}"`);
  if (rewrite.length > source.length * 1.4 + 40) reasons.push('is much longer than the original');
  if (/%/.test(rewrite) && !/%/.test(source)) reasons.push('adds a percentage');
  return [...new Set(reasons)];
}

export function verifyTailoredResume(profile: CandidateProfile, t: TailoredResume): AccuracyReport {
  const issues: FactIssue[] = [];
  const err = (path: string, message: string) => issues.push({ severity: 'error', path, message });

  // Contact details must be identical.
  if (t.contact.name !== profile.name) err('contact.name', 'Name differs from the profile');
  if (t.contact.email !== profile.email) err('contact.email', 'Email differs from the profile');
  if (t.contact.phone !== profile.phone) err('contact.phone', 'Phone differs from the profile');
  if (t.contact.location !== profile.location) err('contact.location', 'Location differs from the profile');
  const profileUrls = new Set(profile.links.map((l) => l.url));
  for (const l of t.contact.links) if (!profileUrls.has(l.url)) err('contact.links', `Link ${l.url} is not in the profile`);

  // Headline: only parts that exist in the profile headline.
  const headParts = new Set(profile.headline.split('|').map(norm));
  for (const part of t.headline.split('|').map(norm)) if (part && !headParts.has(part)) err('headline', `Headline part "${part}" is not in the profile`);

  // Skills: exact strings from the profile only.
  const profileSkills = new Set(profile.skillGroups.flatMap((g) => g.skills.map(norm)));
  for (const g of t.skillGroups) for (const s of g.skills) if (!profileSkills.has(norm(s))) err('skills', `Skill "${s}" is not in the profile`);

  // Experience: identical employers, titles, dates; bullets traceable.
  const expById = new Map(profile.experience.map((e) => [e.id, e]));
  const seenExp = new Set<string>();
  for (const [i, e] of t.experience.entries()) {
    const src = expById.get(e.sourceId);
    if (!src) {
      err(`experience[${i}]`, `Employer "${e.company}" is not in the profile`);
      continue;
    }
    if (seenExp.has(e.sourceId)) err(`experience[${i}]`, 'Duplicated experience entry');
    seenExp.add(e.sourceId);
    if (e.company !== src.company) err(`experience[${i}].company`, 'Employer name changed');
    if (e.title !== src.title) err(`experience[${i}].title`, 'Job title changed');
    if (e.startDate !== src.startDate || e.endDate !== src.endDate) err(`experience[${i}].dates`, 'Dates changed');
    if ((e.location ?? '') !== (src.location ?? '')) err(`experience[${i}].location`, 'Location changed');
    const bulletById = new Map(src.bullets.map((b) => [b.id, b.text]));
    for (const [j, b] of e.bullets.entries()) {
      const sb = bulletById.get(b.sourceId);
      if (!sb) err(`experience[${i}].bullets[${j}]`, 'Bullet has no source in the profile');
      else if (b.text !== sb) for (const r of checkRewrite(sb, b.text, '')) err(`experience[${i}].bullets[${j}]`, `Rewrite ${r}`);
    }
  }
  // Every profile job must still appear (omitting employment would misrepresent history).
  for (const e of profile.experience) if (!seenExp.has(e.id)) issues.push({ severity: 'warning', path: 'experience', message: `"${e.title}, ${e.company}" was omitted` });

  // Projects
  const projById = new Map(profile.projects.map((p) => [p.id, p]));
  for (const [i, p] of t.projects.entries()) {
    const src = projById.get(p.sourceId);
    if (!src) {
      err(`projects[${i}]`, `Project "${p.name}" is not in the profile`);
      continue;
    }
    if (p.name !== src.name) err(`projects[${i}].name`, 'Project name changed');
    const srcTech = new Set(src.technologies.map(norm));
    for (const tech of p.technologies) if (!srcTech.has(norm(tech))) err(`projects[${i}].technologies`, `Technology "${tech}" is not listed for this project`);
    const srcUrls = new Set(src.links.map((l) => l.url));
    for (const l of p.links) if (!srcUrls.has(l.url)) err(`projects[${i}].links`, `Link ${l.url} not in profile`);
    const bulletById = new Map(src.bullets.map((b) => [b.id, b.text]));
    for (const [j, b] of p.bullets.entries()) {
      const sb = bulletById.get(b.sourceId);
      if (!sb) err(`projects[${i}].bullets[${j}]`, 'Bullet has no source in the profile');
      else if (b.text !== sb) for (const r of checkRewrite(sb, b.text, src.technologies.join(', '))) err(`projects[${i}].bullets[${j}]`, `Rewrite ${r}`);
    }
  }

  // Education & certifications must be copied verbatim.
  const eduKeys = new Set(profile.education.map((e) => JSON.stringify([e.degree, e.institution, e.dates ?? '', e.grade ?? ''])));
  for (const [i, e] of t.education.entries()) {
    if (!eduKeys.has(JSON.stringify([e.degree, e.institution, e.dates ?? '', e.grade ?? '']))) err(`education[${i}]`, 'Education entry differs from the profile');
  }
  if (t.education.length < profile.education.length) issues.push({ severity: 'warning', path: 'education', message: 'Some education entries were omitted' });
  const certKeys = new Set(profile.certifications.map((c) => norm(c.name)));
  for (const c of t.certifications) if (!certKeys.has(norm(c.name))) err('certifications', `Certification "${c.name}" is not in the profile`);

  // Summary: only facts present in the profile.
  if (t.summary !== profile.summary) {
    const corpus = JSON.stringify(profile);
    for (const r of checkRewrite(profile.summary + ' ' + corpus, t.summary, '')) {
      if (!r.startsWith('is much longer')) err('summary', `Summary ${r}`);
    }
  }

  return {
    ok: !issues.some((i) => i.severity === 'error'),
    checkedAt: new Date().toISOString(),
    issues,
    rejectedRewrites: [],
  };
}
