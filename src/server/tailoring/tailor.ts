import type {
  AccuracyReport,
  CandidateProfile,
  MatchResult,
  ResumeSection,
  SkillGroup,
  TailoredResume,
  TailoringSummary,
} from '../../shared/types.js';
import { coverLetterWithLlm, rewriteForJob } from '../llm.js';
import { findSkills, skillLabel } from '../skills.js';
import { checkRewrite, verifyTailoredResume } from './factcheck.js';

/**
 * Builds a job-specific resume from the verified profile. The deterministic path only
 * reorders existing content (always factually identical). The optional LLM path may
 * rephrase bullets/summary; each rewrite is fact-checked and rejected if it adds anything.
 */

export interface TailorJob {
  title: string;
  company: string;
  descriptionText: string;
  match: MatchResult;
}

export interface TailorResult {
  resume: TailoredResume;
  summary: TailoringSummary;
  accuracy: AccuracyReport;
  coverLetter: string;
}

function relevance(text: string, weights: Map<string, number>): number {
  let s = 0;
  for (const id of findSkills(text)) s += weights.get(id) ?? 0;
  return s;
}

function stableSort<T>(arr: T[], score: (t: T) => number): T[] {
  return arr
    .map((item, idx) => ({ item, idx, s: score(item) }))
    .sort((a, b) => b.s - a.s || a.idx - b.idx)
    .map((x) => x.item);
}

export function tailorDeterministic(profile: CandidateProfile, job: TailorJob): { resume: TailoredResume; summary: TailoringSummary } {
  const req = job.match.requirements;
  const weights = new Map<string, number>();
  for (const s of req.requiredSkills) weights.set(s, 3);
  for (const s of req.preferredSkills) if (!weights.has(s)) weights.set(s, 2);
  for (const s of req.mentionedSkills) if (!weights.has(s)) weights.set(s, 1);
  const changes: string[] = [];

  // Headline: reorder existing parts so the most relevant comes first.
  const parts = profile.headline.split('|').map((p) => p.trim()).filter(Boolean);
  const titleLower = job.title.toLowerCase();
  const headScore = (p: string) => {
    const pl = p.toLowerCase();
    let s = relevance(p, weights);
    for (const w of titleLower.split(/\W+/).filter((x) => x.length > 2)) if (pl.includes(w)) s += 2;
    return s;
  };
  const sortedParts = stableSort(parts, headScore);
  const headline = sortedParts.join(' | ');
  if (headline !== parts.join(' | ')) changes.push(`Headline reordered to lead with “${sortedParts[0]}”.`);

  // Skills: within each group, skills the job asks for come first; groups with matches first.
  const skillGroups: SkillGroup[] = stableSort(
    profile.skillGroups.map((g) => {
      const sorted = stableSort(g.skills, (s) => relevance(s, weights));
      return { name: g.name, skills: sorted };
    }),
    (g) => g.skills.reduce((acc, s) => acc + relevance(s, weights), 0),
  );
  const movedSkills = profile.skillGroups
    .flatMap((g) => g.skills)
    .filter((s) => relevance(s, weights) > 0);
  if (movedSkills.length) changes.push(`Skills the posting asks for are listed first: ${movedSkills.slice(0, 8).join(', ')}.`);

  // Experience: keep chronological order; order bullets by relevance.
  const experience = profile.experience.map((e) => {
    const bullets = stableSort(e.bullets, (b) => relevance(b.text, weights));
    if (bullets.some((b, i) => b.id !== e.bullets[i]?.id)) changes.push(`Bullets for ${e.title} at ${e.company} reordered by relevance.`);
    return { sourceId: e.id, title: e.title, company: e.company, location: e.location, startDate: e.startDate, endDate: e.endDate, bullets: bullets.map((b) => ({ sourceId: b.id, text: b.text })) };
  });

  // Projects: most relevant first; bullets and technologies ordered by relevance.
  const projects = stableSort(profile.projects, (p) => relevance([p.name, p.subtitle, ...p.technologies, ...p.bullets.map((b) => b.text)].join(' '), weights)).map((p) => {
    const bullets = stableSort(p.bullets, (b) => relevance(b.text, weights));
    if (bullets.some((b, i) => b.id !== p.bullets[i]?.id)) changes.push(`${p.name} bullets reordered to lead with the most relevant work.`);
    return {
      sourceId: p.id,
      name: p.name,
      subtitle: p.subtitle,
      technologies: stableSort(p.technologies, (t) => relevance(t, weights)),
      links: p.links,
      bullets: bullets.map((b) => ({ sourceId: b.id, text: b.text })),
    };
  });
  if (profile.projects.length > 1 && projects[0].sourceId !== profile.projects[0].id) changes.push(`Moved “${projects[0].name}” to the top of Projects.`);

  // Section order: when experience entries carry no bullets, projects show the substance.
  const expBullets = profile.experience.reduce((n, e) => n + e.bullets.length, 0);
  const projRelevance = projects.reduce((n, p) => n + relevance(p.bullets.map((b) => b.text).join(' ') + p.technologies.join(' '), weights), 0);
  const sectionOrder: ResumeSection[] = ['summary', 'skills'];
  if (expBullets === 0 && projRelevance > 0 && profile.projects.length > 0) {
    sectionOrder.push('projects', 'experience');
    changes.push('Projects placed before Experience because they show the skills this role asks for.');
  } else sectionOrder.push('experience', 'projects');
  sectionOrder.push('education', 'certifications', 'additional');

  const have = new Set(findSkills(JSON.stringify(profile)));
  const matchedKeywords = [...weights.keys()].filter((s) => have.has(s)).map(skillLabel);
  const gaps = [...new Set([...job.match.missingRequired, ...job.match.missingPreferred])];
  if (gaps.length) changes.push(`Not added (not in your verified profile): ${gaps.slice(0, 10).join(', ')}.`);

  return {
    resume: {
      contact: { name: profile.name, email: profile.email, phone: profile.phone, location: profile.location, links: profile.links },
      headline,
      summary: profile.summary,
      sectionOrder,
      skillGroups,
      experience,
      projects,
      education: profile.education,
      certifications: profile.certifications,
      additional: profile.additional,
    },
    summary: { changes: changes.length ? changes : ['No reordering needed: your resume already leads with the relevant content.'], matchedKeywords, gaps, method: 'deterministic' },
  };
}

export function coverLetterTemplate(profile: CandidateProfile, job: TailorJob, matchedKeywords: string[]): string {
  const current = profile.experience.find((e) => e.endDate === null) ?? profile.experience[0];
  const previous = profile.experience.filter((e) => e !== current && e.company !== current?.company)[0];
  const headlinePart = profile.headline.split('|')[0]?.trim() || 'software engineer';
  const project = profile.projects[0];
  const keyBullet = project?.bullets[0]?.text.replace(/\.$/, '');
  const paras: string[] = [];
  let intro = `I am applying for the ${job.title} role at ${job.company}. I am a ${headlinePart}${profile.location ? ` based in ${profile.location}` : ''}`;
  if (current) intro += `, currently working as ${current.title} at ${current.company}`;
  if (previous) intro += `, and previously at ${previous.company}`;
  paras.push(intro + '.');
  if (project && keyBullet) {
    paras.push(
      `Recently I built ${project.name}${project.subtitle ? ` (${project.subtitle.toLowerCase()})` : ''}. ${keyBullet[0].toUpperCase()}${keyBullet.slice(1)}.${
        project.technologies.length ? ` It uses ${project.technologies.slice(0, 6).join(', ')}.` : ''
      }`,
    );
  }
  if (matchedKeywords.length) {
    paras.push(`Your posting highlights ${matchedKeywords.slice(0, 5).join(', ')}, which match the skills on my resume. I would welcome the chance to bring them to ${job.company}.`);
  } else {
    paras.push(`I would welcome the chance to contribute to ${job.company} and to learn from your team.`);
  }
  const links = profile.links.map((l) => `${l.label}: ${l.url.replace(/^https?:\/\//, '')}`).join(' · ');
  if (links) paras.push(`You can see my work here — ${links}. Thank you for your time and consideration.`);
  else paras.push('Thank you for your time and consideration.');
  return paras.join('\n\n');
}

export function formatCoverLetter(profile: CandidateProfile, company: string, body: string): string {
  return `Dear Hiring Team at ${company},\n\n${body.trim()}\n\nSincerely,\n${profile.name}\n${[profile.email, profile.phone].filter(Boolean).join(' | ')}`;
}

export function checkCoverLetter(profile: CandidateProfile, company: string, title: string, body: string): string[] {
  const corpus = `${JSON.stringify(profile)} ${company} ${title}`;
  return checkRewrite(corpus, body, '').filter((r) => !r.startsWith('is much longer'));
}

export async function tailorResume(profile: CandidateProfile, job: TailorJob, opts: { useLlm: boolean; llmCoverLetter: boolean }): Promise<TailorResult> {
  const det = tailorDeterministic(profile, job);
  const resume = structuredClone(det.resume);
  const summary = det.summary;
  const rejected: AccuracyReport['rejectedRewrites'] = [];

  if (opts.useLlm) {
    const rewrite = await rewriteForJob({ profile, jobTitle: job.title, company: job.company, jobText: job.descriptionText, matchedKeywords: summary.matchedKeywords });
    if (rewrite) {
      let accepted = 0;
      const byId = new Map(rewrite.bullets.map((b) => [b.id, b.text.trim()]));
      const apply = (bullets: Array<{ sourceId: string; text: string }>, context: string, path: string) => {
        for (const b of bullets) {
          const proposed = byId.get(b.sourceId);
          if (!proposed || proposed === b.text) continue;
          const reasons = checkRewrite(b.text, proposed, context);
          if (reasons.length) rejected.push({ path, proposed, reasons });
          else {
            b.text = proposed;
            accepted++;
          }
        }
      };
      for (const e of resume.experience) apply(e.bullets, '', `${e.title} at ${e.company}`);
      for (const p of resume.projects) apply(p.bullets, p.technologies.join(', '), p.name);
      if (rewrite.summary && rewrite.summary.trim() !== profile.summary) {
        const trial = { ...resume, summary: rewrite.summary.trim() };
        const check = verifyTailoredResume(profile, trial).issues.filter((i) => i.path === 'summary');
        if (check.length) rejected.push({ path: 'summary', proposed: rewrite.summary, reasons: check.map((c) => c.message) });
        else {
          resume.summary = rewrite.summary.trim();
          accepted++;
          summary.changes.unshift('Summary reworded for this role (facts unchanged, verified).');
        }
      }
      if (accepted > 0) {
        summary.method = 'llm_assisted';
        summary.changes.push(`${accepted} item(s) reworded with job terminology; every rewrite passed the fact-checker.`);
      }
      if (rejected.length) summary.changes.push(`${rejected.length} proposed rewrite(s) rejected by the fact-checker; original wording kept.`);
    }
  }

  const accuracy = verifyTailoredResume(profile, resume);
  accuracy.rejectedRewrites = rejected;
  // Defence in depth: if anything slipped through, fall back to the verbatim deterministic resume.
  let finalResume = resume;
  if (!accuracy.ok) {
    finalResume = det.resume;
    summary.method = 'deterministic';
    summary.changes.push('Fact-check failed on the reworded version; using your original wording.');
    const retry = verifyTailoredResume(profile, finalResume);
    retry.rejectedRewrites = rejected;
    Object.assign(accuracy, retry);
  }

  let body = coverLetterTemplate(profile, job, summary.matchedKeywords);
  if (opts.llmCoverLetter) {
    const llmBody = await coverLetterWithLlm({ profile, jobTitle: job.title, company: job.company, jobText: job.descriptionText, matchedKeywords: summary.matchedKeywords });
    if (llmBody && checkCoverLetter(profile, job.company, job.title, llmBody).length === 0) body = llmBody;
  }

  return { resume: finalResume, summary, accuracy, coverLetter: formatCoverLetter(profile, job.company, body) };
}
