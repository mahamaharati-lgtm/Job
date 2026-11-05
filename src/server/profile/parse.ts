import type {
  AdditionalSection,
  Bullet,
  CandidateProfile,
  CertificationItem,
  EducationItem,
  ExperienceItem,
  Link,
  ProjectItem,
  SkillGroup,
} from '../../shared/types.js';

/**
 * Rule-based resume parser. It only copies text that is present in the resume; it never
 * infers skills or achievements. Anything it is unsure about is reported as a warning so the
 * user can correct it in the profile editor before verifying.
 */

export interface ParseResult {
  profile: CandidateProfile;
  warnings: string[];
}

type SectionKey = 'summary' | 'skills' | 'experience' | 'projects' | 'education' | 'certifications' | 'other';

const SECTION_PATTERNS: Array<{ key: SectionKey; re: RegExp }> = [
  { key: 'summary', re: /^(professional\s+summary|summary|profile|about( me)?|objective|career objective|professional profile)$/i },
  { key: 'skills', re: /^(technical\s+skills|skills|core\s+skills|key\s+skills|skills\s*&\s*tools|technologies|tech\s+stack|core competencies)$/i },
  { key: 'experience', re: /^(professional\s+experience|work\s+experience|experience|employment(\s+history)?|work\s+history|internships?)$/i },
  { key: 'projects', re: /^(projects|personal\s+projects|key\s+projects|academic\s+projects|selected\s+projects)$/i },
  { key: 'education', re: /^(education|academic\s+background|qualifications|education\s*&\s*training)$/i },
  { key: 'certifications', re: /^(certifications?|licenses?\s*&\s*certifications|courses|certificates)$/i },
  { key: 'other', re: /^(achievements|awards|honou?rs|languages|interests|hobbies|activities|extracurricular( activities)?|publications|volunteering|leadership|positions of responsibility)$/i },
];

const BULLET_RE = /^\s*[•·▪●◦‣∙*\-–•-]\s*/;
const MONTHS: Record<string, string> = {
  jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06', jul: '07', aug: '08', sep: '09', sept: '09', oct: '10', nov: '11', dec: '12',
};
const MONTH_NAME = '(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
const DATE_TOKEN = `(?:${MONTH_NAME}\\.?\\s+\\d{4}|\\d{1,2}/\\d{4}|\\d{4})`;
const RANGE_RE = new RegExp(`(${DATE_TOKEN})\\s*(?:–|—|-|to)\\s*(${DATE_TOKEN}|present|current|now|till date|ongoing)`, 'i');
const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
const PHONE_RE = /\+?\d[\d\s().-]{7,}\d/;
const URL_RE = /\b((?:https?:\/\/)?(?:www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|io|in|dev|me|app|net|org|co|ai|xyz|tech|site|page|github\.io)(?:\/[^\s|,]*)?)/gi;

let idCounter = 0;
function newId(prefix: string): string {
  idCounter++;
  return `${prefix}${idCounter.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export function toIsoMonth(token: string): string | null {
  const t = token.trim().toLowerCase().replace(/\./g, '');
  if (/^(present|current|now|till date|ongoing)$/.test(t)) return null;
  let m = t.match(/^([a-z]+)\s+(\d{4})$/);
  if (m) {
    const mon = MONTHS[m[1].slice(0, 4)] ?? MONTHS[m[1].slice(0, 3)];
    if (mon) return `${m[2]}-${mon}`;
  }
  m = t.match(/^(\d{1,2})\/(\d{4})$/);
  if (m) return `${m[2]}-${m[1].padStart(2, '0')}`;
  m = t.match(/^(\d{4})$/);
  if (m) return `${m[1]}-01`;
  return null;
}

export function formatMonth(iso: string | null): string {
  if (!iso) return 'Present';
  const [y, mo] = iso.split('-');
  const name = Object.entries(MONTHS).find(([k, v]) => v === mo && k.length === 3)?.[0] ?? '';
  return name ? `${name[0].toUpperCase()}${name.slice(1)} ${y}` : y;
}

function detectSection(line: string): SectionKey | null {
  const clean = line.replace(/[:|]+$/, '').trim();
  if (clean.length > 40) return null;
  for (const s of SECTION_PATTERNS) if (s.re.test(clean)) return s.key;
  return null;
}

/** Split on commas that are not inside parentheses. */
export function splitList(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of s) {
    if (ch === '(') depth++;
    if (ch === ')') depth = Math.max(0, depth - 1);
    if ((ch === ',' || ch === ';') && depth === 0) {
      if (cur.trim()) out.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out.map((x) => x.replace(/\.$/, '').trim()).filter(Boolean);
}

function normalizeUrl(u: string): string {
  const s = u.trim().replace(/[.,;]+$/, '');
  return /^https?:\/\//i.test(s) ? s : `https://${s}`;
}

function linkLabel(url: string, hint?: string): string {
  if (hint) return hint;
  if (/linkedin\.com/i.test(url)) return 'LinkedIn';
  if (/github\.io/i.test(url)) return 'Portfolio';
  if (/github\.com/i.test(url)) return 'GitHub';
  if (/behance|dribbble/i.test(url)) return 'Design portfolio';
  return 'Portfolio';
}

function parseLinksFromText(text: string): Link[] {
  const links: Link[] = [];
  for (const part of text.split(/\s*\|\s*/)) {
    const labelMatch = part.match(/^\s*([A-Za-z ]{2,20}):\s*(.+)$/);
    const target = labelMatch ? labelMatch[2] : part;
    URL_RE.lastIndex = 0;
    const m = URL_RE.exec(target);
    if (m && !EMAIL_RE.test(target)) {
      const url = normalizeUrl(m[1]);
      links.push({ label: linkLabel(url, labelMatch?.[1]?.trim()), url });
    }
  }
  return links;
}

function cleanBullet(line: string): string {
  return line.replace(BULLET_RE, '').trim();
}

/** Merge wrapped lines into bullets. Lines that start with a bullet glyph begin a new bullet. */
function collectBullets(lines: string[]): Bullet[] {
  const bullets: string[] = [];
  for (const raw of lines) {
    const isBullet = BULLET_RE.test(raw);
    const text = cleanBullet(raw);
    if (!text) continue;
    const prev = bullets[bullets.length - 1];
    const continuesPrev = prev !== undefined && !isBullet && (!/[.!?]$/.test(prev) || /^[a-z(₹$0-9]/.test(text));
    if (continuesPrev) bullets[bullets.length - 1] = `${prev} ${text}`;
    else bullets.push(text);
  }
  return bullets.map((text) => ({ id: newId('b'), text }));
}

function parseHeader(lines: string[], profile: CandidateProfile, warnings: string[]): void {
  const nonEmpty = lines.map((l) => l.trim()).filter(Boolean);
  if (nonEmpty.length === 0) {
    warnings.push('Could not find your name at the top of the resume.');
    return;
  }
  profile.name = nonEmpty[0].replace(/\s{2,}.*/, '').trim();
  // "JANE DOE" -> "Jane Doe" (formatting only; initials stay upper-case)
  if (profile.name === profile.name.toUpperCase() && /[A-Z]{3,}/.test(profile.name)) {
    profile.name = profile.name
      .toLowerCase()
      .split(/\s+/)
      .map((w) => (w.length <= 1 ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1)))
      .join(' ');
  }
  const rest = nonEmpty.slice(1);
  const contactParts: string[] = [];
  for (const line of rest) {
    if (EMAIL_RE.test(line) || PHONE_RE.test(line) || URL_RE.test(line) || contactParts.length > 0) {
      URL_RE.lastIndex = 0;
      contactParts.push(line);
    } else if (!profile.headline) {
      profile.headline = line;
    } else {
      profile.headline += ` ${line}`;
    }
  }
  URL_RE.lastIndex = 0;
  const contact = contactParts.join(' | ').replace(/\|\s*\|/g, '|');
  const parts = contact.split(/\s*\|\s*/).map((p) => p.trim()).filter(Boolean);
  for (const part of parts) {
    const email = part.match(EMAIL_RE);
    if (email && !profile.email) {
      profile.email = email[0];
      continue;
    }
    if (PHONE_RE.test(part) && !/[a-z]{3,}/i.test(part.replace(/ext/i, '')) && !profile.phone) {
      profile.phone = part.match(PHONE_RE)![0].trim();
      continue;
    }
    URL_RE.lastIndex = 0;
    if (URL_RE.test(part)) {
      URL_RE.lastIndex = 0;
      profile.links.push(...parseLinksFromText(part));
      continue;
    }
    if (!profile.location && /[A-Za-z]/.test(part) && part.length < 60) profile.location = part;
  }
  if (!profile.email) warnings.push('No email address found in the header.');
  if (!profile.phone) warnings.push('No phone number found in the header.');
  if (!profile.location) warnings.push('No location found in the header.');
}

function parseSkills(lines: string[]): SkillGroup[] {
  const groups: SkillGroup[] = [];
  for (const raw of lines) {
    const line = cleanBullet(raw);
    if (!line) continue;
    const m = line.match(/^([^:]{2,40}):\s*(.+)$/);
    if (m) groups.push({ name: m[1].trim(), skills: splitList(m[2]) });
    else {
      const last = groups[groups.length - 1];
      if (last && last.name === 'Skills') last.skills.push(...splitList(line));
      else if (last && !/[:]/.test(line) && raw.startsWith(' ')) last.skills.push(...splitList(line));
      else groups.push({ name: 'Skills', skills: splitList(line) });
    }
  }
  return groups.filter((g) => g.skills.length > 0);
}

function splitTitleCompany(text: string): { title: string; company: string; location?: string } {
  const t = text.replace(/\s{2,}/g, ' ').trim();
  let m = t.match(/^(.+?)\s+(?:at|@)\s+(.+)$/i);
  if (m) return { title: m[1].trim(), company: m[2].trim() };
  // "Title, Company" — split on the LAST comma not inside parentheses
  let depth = 0;
  let idx = -1;
  for (let i = 0; i < t.length; i++) {
    if (t[i] === '(') depth++;
    else if (t[i] === ')') depth--;
    else if (t[i] === ',' && depth === 0) idx = i;
  }
  m = t.match(/^(.+?)\s+[|–—-]\s+(.+)$/);
  if (m) {
    const rest = m[2].split(/\s+[|–—-]\s+/);
    return { title: m[1].trim(), company: rest[0].trim(), location: rest[1]?.trim() };
  }
  if (idx > 0) {
    const first = t.slice(0, idx).trim();
    const second = t.slice(idx + 1).trim();
    // "Title, Company, City" → keep the first comma split
    const firstComma = (() => {
      let d = 0;
      for (let i = 0; i < t.length; i++) {
        if (t[i] === '(') d++;
        else if (t[i] === ')') d--;
        else if (t[i] === ',' && d === 0) return i;
      }
      return -1;
    })();
    if (firstComma !== idx) {
      return { title: t.slice(0, firstComma).trim(), company: t.slice(firstComma + 1, idx).trim(), location: second };
    }
    return { title: first, company: second };
  }
  return { title: t, company: '' };
}

function parseExperience(lines: string[], warnings: string[]): ExperienceItem[] {
  const items: ExperienceItem[] = [];
  let current: ExperienceItem | null = null;
  let bulletLines: string[] = [];
  const flush = () => {
    if (current) {
      current.bullets = collectBullets(bulletLines);
      items.push(current);
    }
    bulletLines = [];
  };
  let pendingTitleLine: string | null = null;
  for (const raw of lines) {
    if (!raw.trim()) continue;
    const range = raw.match(RANGE_RE);
    if (range && !BULLET_RE.test(raw)) {
      flush();
      const before = raw.slice(0, range.index).replace(/[|,–—-]\s*$/, '').trim();
      const after = raw.slice((range.index ?? 0) + range[0].length).replace(/^[|,–—-]\s*/, '').trim();
      const header = before || pendingTitleLine || '';
      const { title, company, location } = splitTitleCompany(header);
      current = {
        id: newId('x'),
        title,
        company,
        location: location || after || undefined,
        startDate: toIsoMonth(range[1]) ?? '',
        endDate: toIsoMonth(range[2]),
        bullets: [],
      };
      if (!company) warnings.push(`Could not separate job title and employer in "${header}". Please check it.`);
      pendingTitleLine = null;
      continue;
    }
    if (current && current.company === '' && !BULLET_RE.test(raw) && bulletLines.length === 0 && raw.trim().length < 60) {
      current.company = raw.trim();
      continue;
    }
    if (!current) {
      pendingTitleLine = raw.trim();
      continue;
    }
    bulletLines.push(raw);
  }
  flush();
  return items;
}

function parseProjects(lines: string[]): ProjectItem[] {
  const items: ProjectItem[] = [];
  let current: ProjectItem | null = null;
  let bulletLines: string[] = [];
  const flush = () => {
    if (current) {
      current.bullets = collectBullets(bulletLines);
      items.push(current);
    }
    bulletLines = [];
  };
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const tech = line.match(/^(?:technologies|tech stack|stack|tools|built with)\s*:\s*(.+)$/i);
    if (tech && current) {
      current.technologies.push(...splitList(tech[1]));
      continue;
    }
    if (current && /^(live|demo|github|code|link|links|url|repo|repository|website)\s*:/i.test(line)) {
      current.links.push(...parseLinksFromText(line));
      continue;
    }
    const isBullet = BULLET_RE.test(raw);
    const startsNewProject =
      !isBullet &&
      (current === null ||
        (bulletLines.length > 0 && /[.!?)]$/.test(bulletLines[bulletLines.length - 1].trim()) && line.length < 90 && !/^[a-z(]/.test(line) && /\s[—–|-]\s|^[A-Z][\w .'-]+$/.test(line)));
    if (startsNewProject) {
      flush();
      const nameParts = line.split(/\s+[—–|]\s+|\s+-\s+/);
      const linkInHeader = parseLinksFromText(line);
      current = {
        id: newId('p'),
        name: nameParts[0].trim(),
        subtitle: nameParts.slice(1).join(' — ').trim() || undefined,
        technologies: [],
        links: linkInHeader,
        bullets: [],
      };
      continue;
    }
    bulletLines.push(raw);
  }
  flush();
  return items;
}

const DEGREE_RE = /\b(bachelor|master|b\.?\s?e\b|b\.?\s?tech|m\.?\s?tech|b\.?\s?sc|m\.?\s?sc|bca|mca|mba|b\.?com|diploma|ph\.?d|doctor|associate|high school|higher secondary|senior secondary|class (x|xii|10|12)|puc|ssc|hsc|degree)/i;
const GRADE_RE = /\b(aggregate|cgpa|gpa|percentage|grade|score)\b\s*:?\s*([\d.]+\s*%?(?:\s*\/\s*[\d.]+)?)/i;

function parseEducation(lines: string[]): EducationItem[] {
  const items: EducationItem[] = [];
  let current: EducationItem | null = null;
  for (const raw of lines) {
    const line = cleanBullet(raw);
    if (!line) continue;
    const yearMatch = line.match(new RegExp(`(${DATE_TOKEN}(?:\\s*(?:–|—|-|to)\\s*(?:${DATE_TOKEN}|present))?)\\s*$`, 'i'));
    const withoutYear = yearMatch ? line.slice(0, yearMatch.index).trim() : line;
    if (DEGREE_RE.test(withoutYear) && (!current || current.degree)) {
      if (current) items.push(current);
      current = { id: newId('e'), degree: withoutYear.replace(/[,|]\s*$/, ''), institution: '', dates: yearMatch?.[1], details: [] };
      continue;
    }
    if (!current) {
      current = { id: newId('e'), degree: '', institution: withoutYear, dates: yearMatch?.[1], details: [] };
      continue;
    }
    const grade = line.match(GRADE_RE);
    const parts = line.split(/\s*\|\s*/);
    if (!current.institution) {
      current.institution = (grade ? parts.filter((p) => !GRADE_RE.test(p)).join(' | ') : withoutYear).trim();
      if (yearMatch && !current.dates) current.dates = yearMatch[1];
    } else if (!grade) {
      current.details.push(line);
    }
    if (grade) current.grade = parts.find((p) => GRADE_RE.test(p))?.trim() ?? grade[0];
  }
  if (current) items.push(current);
  return items.filter((e) => e.degree || e.institution);
}

function parseCertifications(lines: string[]): CertificationItem[] {
  return lines
    .map((l) => cleanBullet(l))
    .filter(Boolean)
    .map((name) => ({ id: newId('c'), name }));
}

export function emptyProfile(): CandidateProfile {
  return {
    name: '',
    headline: '',
    email: '',
    phone: '',
    location: '',
    links: [],
    summary: '',
    skillGroups: [],
    experience: [],
    projects: [],
    education: [],
    certifications: [],
    additional: [],
  };
}

export function parseResumeText(text: string): ParseResult {
  const warnings: string[] = [];
  const profile = emptyProfile();
  const lines = text.split('\n');
  const sections: Array<{ key: SectionKey; title: string; lines: string[] }> = [];
  const header: string[] = [];
  let cur: { key: SectionKey; title: string; lines: string[] } | null = null;
  for (const line of lines) {
    const key = detectSection(line.trim());
    if (key) {
      cur = { key, title: line.trim().replace(/:$/, ''), lines: [] };
      sections.push(cur);
    } else if (cur) cur.lines.push(line);
    else header.push(line);
  }
  parseHeader(header, profile, warnings);
  // Avoid duplicated links
  const seen = new Set<string>();
  profile.links = profile.links.filter((l) => (seen.has(l.url) ? false : (seen.add(l.url), true)));

  for (const s of sections) {
    switch (s.key) {
      case 'summary':
        profile.summary = s.lines.map((l) => l.trim()).filter(Boolean).join(' ').replace(/\s+/g, ' ');
        break;
      case 'skills':
        profile.skillGroups.push(...parseSkills(s.lines));
        break;
      case 'experience':
        profile.experience.push(...parseExperience(s.lines, warnings));
        break;
      case 'projects':
        profile.projects.push(...parseProjects(s.lines));
        break;
      case 'education':
        profile.education.push(...parseEducation(s.lines));
        break;
      case 'certifications':
        profile.certifications.push(...parseCertifications(s.lines));
        break;
      default: {
        const items = s.lines.map((l) => cleanBullet(l)).filter(Boolean);
        if (items.length) profile.additional.push({ id: newId('a'), title: s.title, items } satisfies AdditionalSection);
      }
    }
  }
  // Pull links mentioned in projects into the global list if absent (e.g. GitHub)
  if (!sections.some((s) => s.key === 'experience')) warnings.push('No experience section detected.');
  if (profile.skillGroups.length === 0) warnings.push('No skills section detected.');
  for (const e of profile.experience) {
    if (e.bullets.length === 0) {
      warnings.push(`"${e.title} at ${e.company}" has no bullet points. Adding real responsibilities/achievements (in your resume) will improve matching; the system will not invent them.`);
    }
  }
  return { profile, warnings };
}

/** Basic structural validation used before saving an edited profile. */
export function profileProblems(p: CandidateProfile): string[] {
  const problems: string[] = [];
  if (!p.name.trim()) problems.push('Name is required.');
  if (!p.email.trim()) problems.push('Email is required.');
  for (const e of p.experience) {
    if (!e.title || !e.company) problems.push('Each experience entry needs a title and an employer.');
    if (e.startDate && !/^\d{4}-\d{2}$/.test(e.startDate)) problems.push(`Start date "${e.startDate}" must be YYYY-MM.`);
    if (e.endDate && !/^\d{4}-\d{2}$/.test(e.endDate)) problems.push(`End date "${e.endDate}" must be YYYY-MM or empty for Present.`);
  }
  return [...new Set(problems)];
}

/** Ensure every list item has an id (for profiles edited by hand or produced by an LLM). */
export function ensureIds(p: CandidateProfile): CandidateProfile {
  const fixB = (bs: Bullet[]) => bs.map((b) => ({ id: b.id || newId('b'), text: b.text }));
  return {
    ...p,
    links: p.links ?? [],
    skillGroups: p.skillGroups ?? [],
    experience: (p.experience ?? []).map((e) => ({ ...e, id: e.id || newId('x'), bullets: fixB(e.bullets ?? []) })),
    projects: (p.projects ?? []).map((e) => ({ ...e, id: e.id || newId('p'), technologies: e.technologies ?? [], links: e.links ?? [], bullets: fixB(e.bullets ?? []) })),
    education: (p.education ?? []).map((e) => ({ ...e, id: e.id || newId('e'), details: e.details ?? [] })),
    certifications: (p.certifications ?? []).map((c) => ({ ...c, id: c.id || newId('c') })),
    additional: (p.additional ?? []).map((a) => ({ ...a, id: a.id || newId('a') })),
  };
}
