import { afterAll, describe, expect, it } from 'vitest';
import { extractUntrusted } from '../unit-helpers.js';
import { extractRequirements, extractYears, scoreJob, type MatchJobInput } from '../../src/server/matching.js';
import { checkRewrite, verifyTailoredResume } from '../../src/server/tailoring/factcheck.js';
import { renderDocx, renderPdf, renderText } from '../../src/server/tailoring/render.js';
import { coverLetterTemplate, checkCoverLetter, tailorDeterministic, tailorResume } from '../../src/server/tailoring/tailor.js';
import { indiaPrefs, sampleProfile, setupTestEnv } from '../helpers.js';

const env = setupTestEnv();
afterAll(() => env.cleanup());
const profile = sampleProfile();
const NOW = new Date('2026-11-05T00:00:00Z');

const job = (over: Partial<MatchJobInput>): MatchJobInput => ({
  title: 'Frontend Engineer',
  company: 'Acme',
  location: 'Pune, India',
  workMode: 'hybrid',
  employmentType: 'full_time',
  descriptionText: 'Requirements:\n• 1+ years of experience with React and TypeScript\n• HTML, CSS, accessibility\nNice to have:\n• Next.js, GraphQL',
  postedAt: '2026-11-03T00:00:00Z',
  ...over,
});

describe('requirement extraction', () => {
  it('separates required and preferred skills and reads years', () => {
    const r = extractRequirements(job({}));
    expect(r.requiredSkills).toEqual(expect.arrayContaining(['react', 'typescript', 'html', 'css', 'accessibility']));
    expect(r.preferredSkills).toEqual(expect.arrayContaining(['nextjs', 'graphql']));
    expect(r.minYears).toBe(1);
  });
  it.each([
    ['3+ years of professional experience', 3],
    ['Minimum of 2 years experience in frontend', 2],
    ['0-2 years of experience', 0],
    ['two years of experience building UIs', 2],
    ['Total Exp : 6 - 8 Years', 6],
    ['Minimum 5 year(s) of experience is required', 5],
    ['Experience: 2–6 Years', 2],
    ['6 to 10 years of overall experience including 3 years in Python backend', 6],
  ])('years: %s', (text, n) => expect(extractYears(text).min).toBe(n));
});

describe('scoring & eligibility', () => {
  it('scores a junior React role in a preferred city highly with no conflicts', () => {
    const m = scoreJob(job({}), profile, indiaPrefs(), NOW);
    expect(m.eligible).toBe(true);
    expect(m.score).toBeGreaterThanOrEqual(75);
    expect(m.tracks).toContain('frontend');
    expect(m.missingPreferred).toEqual(expect.arrayContaining(['Next.js', 'GraphQL']));
    expect(m.conflicts.filter((c) => c.severity === 'hard')).toHaveLength(0);
  });

  it('flags senior roles and large experience gaps as hard conflicts', () => {
    const m = scoreJob(job({ title: 'Senior Frontend Engineer', descriptionText: 'Requirements: 6+ years of experience with React' }), profile, indiaPrefs(), NOW);
    expect(m.eligible).toBe(false);
    expect(m.conflicts.map((c) => c.code)).toEqual(expect.arrayContaining(['seniority', 'experience_years']));
    expect(m.score).toBeLessThanOrEqual(45);
  });

  it('rejects remote roles restricted to another country', () => {
    const m = scoreJob(job({ location: 'Remote (USA Only)', workMode: 'remote', descriptionText: 'React. Must be authorized to work in the United States.' }), profile, indiaPrefs(), NOW);
    expect(m.eligible).toBe(false);
    expect(m.conflicts.some((c) => c.code === 'remote_region' || c.code === 'work_authorization')).toBe(true);
  });

  it('accepts worldwide remote roles', () => {
    const m = scoreJob(job({ location: 'Remote (Worldwide)', workMode: 'remote' }), profile, indiaPrefs(), NOW);
    expect(m.eligible).toBe(true);
    expect(m.breakdown.location).toBe(15);
  });

  it('does not treat ML research roles as a fit just because of interest in AI', () => {
    const m = scoreJob(job({ title: 'Machine Learning Engineer', descriptionText: 'Requirements: PyTorch, deep learning, model fine-tuning. PhD required.' }), profile, indiaPrefs(), NOW);
    expect(m.tracks).toContain('ml_research');
    expect(m.eligible).toBe(false);
    expect(m.conflicts.some((c) => c.code === 'ml_research')).toBe(true);
  });

  it('keeps prompt-engineering roles in the AI track and flags the missing experience', () => {
    const m = scoreJob(job({ title: 'Prompt Engineer', location: 'Remote', workMode: 'remote', descriptionText: 'Requirements:\n• Prompt engineering with LLMs\n• Python' }), profile, indiaPrefs(), NOW);
    expect(m.tracks).toEqual(['ai']);
    expect(m.missingRequired).toEqual(expect.arrayContaining(['Prompt engineering', 'LLMs']));
    expect(m.explanation).toMatch(/no LLM\/prompt-engineering experience/);
  });

  it('on-site roles in other cities conflict unless relocation is allowed', () => {
    const blocked = scoreJob(job({ location: 'Hyderabad, India', workMode: 'onsite' }), profile, indiaPrefs(), NOW);
    expect(blocked.eligible).toBe(false);
    const ok = scoreJob(job({ location: 'Hyderabad, India', workMode: 'onsite' }), profile, indiaPrefs({ relocation: { willing: true, locations: [] } }), NOW);
    expect(ok.eligible).toBe(true);
  });

  it('honours excluded companies and keywords', () => {
    const m = scoreJob(job({ company: 'BadCorp' }), profile, indiaPrefs({ excludedCompanies: ['badcorp'] }), NOW);
    expect(m.eligible).toBe(false);
  });
});

describe('tailoring never fabricates', () => {
  const match = scoreJob(job({ descriptionText: 'Requirements:\n• Jest and automated testing\n• Accessibility (WCAG)\n• React, TypeScript\n• Next.js and GraphQL' }), profile, indiaPrefs(), NOW);
  const { resume, summary } = tailorDeterministic(profile, { title: 'Frontend Engineer', company: 'Acme', descriptionText: '', match });

  it('deterministic tailoring passes the fact-checker and keeps every job', () => {
    const report = verifyTailoredResume(profile, resume);
    expect(report.issues).toEqual([]);
    expect(report.ok).toBe(true);
    expect(resume.experience.map((e) => e.company)).toEqual(['Example Labs', 'Sample Systems']);
  });

  it('reorders relevant content and reports gaps instead of adding them', () => {
    expect(summary.gaps).toEqual(expect.arrayContaining(['Next.js', 'GraphQL']));
    const allSkills = resume.skillGroups.flatMap((g) => g.skills);
    expect(allSkills).not.toContain('Next.js');
    expect(allSkills).not.toContain('GraphQL');
    expect(resume.experience[0].bullets[0].text).toMatch(/Jest|TypeScript|React/);
    expect(summary.changes.join(' ')).toMatch(/Not added/);
  });

  it('fact-checker catches invented metrics, tools, employers, dates and inflated scope', () => {
    const bad = structuredClone(resume);
    bad.experience[0].bullets[0].text = 'Led a team of 5 to build React components with Next.js, improving load time by 40%.';
    bad.experience[1].startDate = '2023-01';
    bad.skillGroups[0].skills.push('GraphQL');
    bad.experience.push({ ...bad.experience[0], sourceId: 'fake', company: 'Google' });
    const report = verifyTailoredResume(profile, bad);
    expect(report.ok).toBe(false);
    const msgs = report.issues.map((i) => i.message).join(' | ');
    expect(msgs).toMatch(/number "5"|number "40"/);
    expect(msgs).toMatch(/nextjs/);
    expect(msgs).toMatch(/inflates scope/);
    expect(msgs).toMatch(/Dates changed/);
    expect(msgs).toMatch(/Skill "GraphQL" is not in the profile/);
    expect(msgs).toMatch(/Google/);
  });

  it('accepts a faithful rephrase and rejects an embellished one', () => {
    const src = 'Built reusable React components for an internal analytics dashboard used by 4 product teams.';
    expect(checkRewrite(src, 'Developed reusable React components for an internal analytics dashboard used by 4 product teams.', '')).toEqual([]);
    expect(checkRewrite(src, 'Architected reusable React components used by 12 product teams.', '').length).toBeGreaterThan(0);
  });

  it('full tailoring without an API key is deterministic and verified', async () => {
    const r = await tailorResume(profile, { title: 'Frontend Engineer', company: 'Acme', descriptionText: '', match }, { useLlm: false, llmCoverLetter: false });
    expect(r.accuracy.ok).toBe(true);
    expect(r.summary.method).toBe('deterministic');
    expect(r.coverLetter).toContain('Dear Hiring Team at Acme');
    expect(checkCoverLetter(profile, 'Acme', 'Frontend Engineer', coverLetterTemplate(profile, { title: 'Frontend Engineer', company: 'Acme', descriptionText: '', match }, r.summary.matchedKeywords))).toEqual([]);
  });

  it('renders ATS-friendly PDF/DOCX/TXT that contain the real text', async () => {
    const pdf = await renderPdf(resume);
    expect(pdf.subarray(0, 4).toString()).toBe('%PDF');
    const text = await extractUntrusted(pdf);
    for (const s of ['ASHA RAO', 'PROFESSIONAL EXPERIENCE', 'Example Labs', 'Jan 2025 – Present', 'Recipe Finder', 'CGPA: 8.4/10']) expect(text).toContain(s);
    const docx = await renderDocx(resume);
    expect(docx.subarray(0, 2).toString()).toBe('PK');
    const mammoth = (await import('mammoth')).default;
    const docText = (await mammoth.extractRawText({ buffer: docx })).value;
    expect(docText).toContain('Example Institute of Technology');
    expect(renderText(resume)).toContain('• Migrated 30 legacy pages from JavaScript to TypeScript with no production incidents.');
  });
});
