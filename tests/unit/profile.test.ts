import PDFDocument from 'pdfkit';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { extractResumeText } from '../../src/server/profile/extract.js';
import { parseResumeText, toIsoMonth } from '../../src/server/profile/parse.js';
import { experienceYears } from '../../src/server/profile/store.js';
import { candidateSkillIds, findSkills } from '../../src/server/skills.js';
import { fixture, ROOT, setupTestEnv } from '../helpers.js';

const env = setupTestEnv();
afterAll(() => env.cleanup());

describe('resume parsing', () => {
  const { profile, warnings } = parseResumeText(fixture('resume-sample.txt'));

  it('extracts contact details and links', () => {
    expect(profile.name).toBe('Asha Rao');
    expect(profile.headline).toBe('Frontend Engineer | React Developer | Accessibility');
    expect(profile.email).toBe('asha.rao@example.com');
    expect(profile.phone).toBe('+91 90000 00000');
    expect(profile.location).toBe('Pune, Maharashtra');
    expect(profile.links.map((l) => l.url)).toEqual(['https://asharao.example.dev', 'https://github.com/asharao-example']);
  });

  it('extracts skills, experience with dates and bullets, projects, education, certifications', () => {
    expect(profile.skillGroups.map((g) => g.name)).toEqual(['Languages', 'Frameworks & Libraries', 'UI Engineering', 'Tools', 'Methodologies']);
    expect(profile.skillGroups[0].skills).toContain('JavaScript (ES6+)');
    expect(profile.experience).toHaveLength(2);
    expect(profile.experience[0]).toMatchObject({ title: 'Software Engineer (Frontend)', company: 'Example Labs', startDate: '2025-01', endDate: null });
    expect(profile.experience[0].bullets).toHaveLength(3);
    expect(profile.experience[1]).toMatchObject({ title: 'Frontend Intern', company: 'Sample Systems', startDate: '2024-06', endDate: '2024-12' });
    expect(profile.projects[0]).toMatchObject({ name: 'Recipe Finder', subtitle: 'Accessible Search App' });
    expect(profile.projects[0].technologies).toEqual(['React', 'TypeScript', 'Vite', 'Tailwind CSS', 'Playwright']);
    expect(profile.projects[0].bullets).toHaveLength(2);
    expect(profile.education[0]).toMatchObject({ degree: 'Bachelor of Technology, Computer Science', institution: 'Example Institute of Technology', dates: '2024', grade: 'CGPA: 8.4/10' });
    expect(profile.certifications[0].name).toBe('Responsive Web Design — freeCodeCamp');
    expect(warnings).toEqual([]);
  });

  it('never invents skills: candidate skills come only from resume text', () => {
    const ids = candidateSkillIds(profile);
    expect(ids.has('react')).toBe(true);
    expect(ids.has('typescript')).toBe(true);
    expect(ids.has('nextjs')).toBe(false);
    expect(ids.has('prompt_engineering')).toBe(false);
  });

  it('computes years of experience with and without internships', () => {
    const now = new Date('2026-11-05T00:00:00Z');
    expect(experienceYears(profile, { now })).toBeCloseTo(2.5, 1);
    expect(experienceYears(profile, { now, excludeInternships: true })).toBeCloseTo(1.9, 1);
  });

  it('parses month tokens', () => {
    expect(toIsoMonth('Jul 2025')).toBe('2025-07');
    expect(toIsoMonth('September 2024')).toBe('2024-09');
    expect(toIsoMonth('Present')).toBeNull();
    expect(toIsoMonth('03/2023')).toBe('2023-03');
  });
});

describe('PDF extraction', () => {
  it('reads a text PDF line by line and parses it', async () => {
    const doc = new PDFDocument({ size: 'A4' });
    doc.registerFont('R', path.join(ROOT, 'assets/fonts/Inter-Regular.otf'));
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    const done = new Promise<void>((r) => doc.on('end', () => r()));
    doc.font('R').fontSize(10);
    for (const line of fixture('resume-sample.txt').split('\n')) {
      if (line.includes('    ')) {
        const [left, right] = line.split(/\s{3,}/);
        const y = doc.y;
        doc.text(left, 50, y);
        doc.text(right, 400, y);
      } else doc.text(line || ' ', 50);
    }
    doc.end();
    await done;
    const text = await extractResumeText(Buffer.concat(chunks), 'resume.pdf', 'application/pdf');
    expect(text).toMatch(/Software Engineer \(Frontend\), Example Labs\s+Jan 2025 – Present/);
    const { profile } = parseResumeText(text);
    expect(profile.experience[0].company).toBe('Example Labs');
    expect(profile.projects[0].technologies).toContain('Playwright');
  });

  it('rejects files without text', async () => {
    await expect(extractResumeText(Buffer.from('hello'), 'r.txt', 'text/plain')).rejects.toThrow(/enough text/);
  });
});

describe('skill detection', () => {
  it('does not confuse Java with JavaScript or C with C++', () => {
    expect(findSkills('We use JavaScript and React.js')).toEqual(expect.arrayContaining(['javascript', 'react']));
    expect(findSkills('We use JavaScript')).not.toContain('java');
    expect(findSkills('Experience with C++ is a plus')).not.toContain('c');
    expect(findSkills('Languages: Python, C, SQL')).toContain('c');
    expect(findSkills('Series C funded startup')).toContain('c'); // acceptable ambiguity, but only matched in uppercase
  });
});
