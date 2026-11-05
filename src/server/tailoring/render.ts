import path from 'node:path';
import PDFDocument from 'pdfkit';
import { AlignmentType, BorderStyle, Document, ExternalHyperlink, Packer, Paragraph, TabStopType, TextRun } from 'docx';
import type { TailoredResume } from '../../shared/types.js';
import { getConfig } from '../config.js';
import { formatMonth } from '../profile/parse.js';

/**
 * ATS-friendly renderers: single column, standard section headings, real selectable text,
 * no tables, images or text boxes. PDF embeds Inter (OFL) for full Unicode (₹, en dashes).
 */

const SECTION_TITLES: Record<string, string> = {
  summary: 'PROFESSIONAL SUMMARY',
  skills: 'TECHNICAL SKILLS',
  experience: 'PROFESSIONAL EXPERIENCE',
  projects: 'PROJECTS',
  education: 'EDUCATION',
  certifications: 'CERTIFICATIONS',
};

function dateRange(start: string, end: string | null): string {
  return `${formatMonth(start)} – ${formatMonth(end)}`;
}

function displayUrl(url: string): string {
  return url.replace(/^https?:\/\//, '').replace(/\/$/, '');
}

function contactLine(r: TailoredResume): string {
  return [r.contact.location, r.contact.phone, r.contact.email, ...r.contact.links.map((l) => displayUrl(l.url))].filter(Boolean).join(' | ');
}

function hasContent(r: TailoredResume, s: string): boolean {
  switch (s) {
    case 'summary':
      return Boolean(r.summary);
    case 'skills':
      return r.skillGroups.length > 0;
    case 'experience':
      return r.experience.length > 0;
    case 'projects':
      return r.projects.length > 0;
    case 'education':
      return r.education.length > 0;
    case 'certifications':
      return r.certifications.length > 0;
    default:
      return r.additional.length > 0;
  }
}

// ---------------------------------------------------------------------------
// Plain text (also used to paste into "resume text" fields)
// ---------------------------------------------------------------------------
export function renderText(r: TailoredResume): string {
  const out: string[] = [r.contact.name.toUpperCase(), r.headline, contactLine(r), ''];
  for (const s of r.sectionOrder) {
    if (!hasContent(r, s)) continue;
    if (s === 'additional') {
      for (const a of r.additional) out.push(a.title.toUpperCase(), ...a.items.map((i) => `• ${i}`), '');
      continue;
    }
    out.push(SECTION_TITLES[s]);
    if (s === 'summary') out.push(r.summary);
    if (s === 'skills') for (const g of r.skillGroups) out.push(`${g.name}: ${g.skills.join(', ')}`);
    if (s === 'experience')
      for (const e of r.experience) {
        out.push(`${e.title}, ${e.company}${e.location ? `, ${e.location}` : ''} — ${dateRange(e.startDate, e.endDate)}`);
        for (const b of e.bullets) out.push(`• ${b.text}`);
      }
    if (s === 'projects')
      for (const p of r.projects) {
        out.push(`${p.name}${p.subtitle ? ` — ${p.subtitle}` : ''}`);
        if (p.technologies.length) out.push(`Technologies: ${p.technologies.join(', ')}`);
        if (p.links.length) out.push(p.links.map((l) => `${l.label}: ${displayUrl(l.url)}`).join(' | '));
        for (const b of p.bullets) out.push(`• ${b.text}`);
      }
    if (s === 'education')
      for (const e of r.education) {
        out.push(`${e.degree}${e.dates ? ` — ${e.dates}` : ''}`);
        out.push([e.institution, e.grade].filter(Boolean).join(' | '));
        for (const d of e.details) out.push(`• ${d}`);
      }
    if (s === 'certifications') for (const c of r.certifications) out.push(`• ${[c.name, c.issuer, c.date].filter(Boolean).join(' — ')}`);
    out.push('');
  }
  return out.join('\n').trim() + '\n';
}

// ---------------------------------------------------------------------------
// PDF
// ---------------------------------------------------------------------------
function fontPath(name: string): string {
  return path.join(getConfig().appRoot, 'assets', 'fonts', name);
}

function pdfDoc(): PDFKit.PDFDocument {
  const doc = new PDFDocument({ size: 'A4', margins: { top: 42, bottom: 42, left: 48, right: 48 }, info: { Title: 'Resume', Creator: 'Job Autopilot' } });
  doc.registerFont('Body', fontPath('Inter-Regular.otf'));
  doc.registerFont('Bold', fontPath('Inter-Bold.otf'));
  doc.registerFont('Italic', fontPath('Inter-Italic.otf'));
  return doc;
}

function finish(doc: PDFKit.PDFDocument): Promise<Buffer> {
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  return new Promise((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.end();
  });
}

export async function renderPdf(r: TailoredResume): Promise<Buffer> {
  const doc = pdfDoc();
  doc.info.Title = `${r.contact.name} — Resume`;
  doc.info.Author = r.contact.name;
  const left = doc.page.margins.left;
  const width = doc.page.width - left - doc.page.margins.right;
  const body = 9.6;
  const ink = '#111111';
  const muted = '#333333';

  doc.font('Bold').fontSize(19).fillColor(ink).text(r.contact.name.toUpperCase(), { characterSpacing: 0.4 });
  doc.moveDown(0.15);
  doc.font('Body').fontSize(10.5).fillColor(muted).text(r.headline);
  doc.moveDown(0.15);
  doc.font('Body').fontSize(8.8).fillColor(muted).text(contactLine(r), { width });

  const heading = (title: string) => {
    doc.moveDown(0.7);
    doc.font('Bold').fontSize(10.5).fillColor(ink).text(title, left, doc.y, { characterSpacing: 0.6 });
    const y = doc.y + 1.5;
    doc.moveTo(left, y).lineTo(left + width, y).lineWidth(0.7).strokeColor('#222222').stroke();
    doc.y = y + 4;
  };
  const bullet = (text: string) => {
    const y = doc.y;
    doc.font('Body').fontSize(body).fillColor(ink).text('•', left + 6, y, { width: 8 });
    doc.text(text, left + 16, y, { width: width - 16, lineGap: 1.2 });
    doc.moveDown(0.12);
  };
  const rowWithDate = (boldPart: string, rest: string, date: string) => {
    const y = doc.y;
    doc.font('Body').fontSize(body);
    const dateW = doc.widthOfString(date) + 2;
    doc.text(date, left + width - dateW, y, { width: dateW, align: 'right' });
    doc.font('Bold').text(boldPart, left, y, { width: width - dateW - 8, continued: Boolean(rest) });
    if (rest) doc.font('Body').text(rest);
    doc.moveDown(0.25);
  };

  for (const s of r.sectionOrder) {
    if (!hasContent(r, s)) continue;
    if (s === 'additional') {
      for (const a of r.additional) {
        heading(a.title.toUpperCase());
        for (const i of a.items) bullet(i);
      }
      continue;
    }
    heading(SECTION_TITLES[s]);
    if (s === 'summary') doc.font('Body').fontSize(body).fillColor(ink).text(r.summary, left, doc.y, { width, lineGap: 1.4 });
    if (s === 'skills') {
      for (const g of r.skillGroups) {
        doc.font('Bold').fontSize(body).fillColor(ink).text(`${g.name}: `, left, doc.y, { continued: true, width });
        doc.font('Body').text(g.skills.join(', '), { lineGap: 1.2 });
        doc.moveDown(0.2);
      }
    }
    if (s === 'experience') {
      for (const e of r.experience) {
        rowWithDate(e.title, `, ${e.company}${e.location ? `, ${e.location}` : ''}`, dateRange(e.startDate, e.endDate));
        for (const b of e.bullets) bullet(b.text);
      }
    }
    if (s === 'projects') {
      for (const p of r.projects) {
        doc.font('Bold').fontSize(body).fillColor(ink).text(`${p.name}${p.subtitle ? ` — ${p.subtitle}` : ''}`, left, doc.y, { width });
        if (p.technologies.length) {
          doc.font('Italic').text('Technologies: ', { continued: true });
          doc.font('Body').text(p.technologies.join(', '), { width });
        }
        if (p.links.length) doc.font('Body').text(p.links.map((l) => `${l.label}: ${displayUrl(l.url)}`).join(' | '), { width });
        doc.moveDown(0.15);
        for (const b of p.bullets) bullet(b.text);
        doc.moveDown(0.2);
      }
    }
    if (s === 'education') {
      for (const e of r.education) {
        rowWithDate(e.degree, '', e.dates ?? '');
        doc.font('Body').fontSize(body).text([e.institution, e.grade].filter(Boolean).join(' | '), left, doc.y - 2, { width });
        for (const d of e.details) bullet(d);
        doc.moveDown(0.2);
      }
    }
    if (s === 'certifications') for (const c of r.certifications) bullet([c.name, c.issuer, c.date].filter(Boolean).join(' — '));
  }
  return finish(doc);
}

export async function renderCoverLetterPdf(name: string, letter: string): Promise<Buffer> {
  const doc = pdfDoc();
  doc.info.Title = `${name} — Cover letter`;
  doc.font('Body').fontSize(10.5).fillColor('#111111');
  for (const para of letter.split(/\n{2,}/)) {
    doc.text(para, { width: doc.page.width - 96, lineGap: 2 });
    doc.moveDown(0.8);
  }
  return finish(doc);
}

// ---------------------------------------------------------------------------
// DOCX (editable)
// ---------------------------------------------------------------------------
export async function renderDocx(r: TailoredResume): Promise<Buffer> {
  const FONT = 'Calibri';
  const size = 21; // half-points
  const children: Paragraph[] = [];
  const tabRight = 10466; // A4 width minus margins in twips (approx)
  const h = (text: string) =>
    new Paragraph({
      spacing: { before: 200, after: 80 },
      border: { bottom: { color: '222222', style: BorderStyle.SINGLE, size: 6, space: 1 } },
      children: [new TextRun({ text, bold: true, size: 22, font: FONT })],
    });
  const bulletP = (text: string) => new Paragraph({ bullet: { level: 0 }, spacing: { after: 40 }, children: [new TextRun({ text, size, font: FONT })] });

  children.push(new Paragraph({ children: [new TextRun({ text: r.contact.name.toUpperCase(), bold: true, size: 36, font: FONT })] }));
  children.push(new Paragraph({ children: [new TextRun({ text: r.headline, size: 22, font: FONT })] }));
  const contactRuns: Array<TextRun | ExternalHyperlink> = [];
  const plain = [r.contact.location, r.contact.phone, r.contact.email].filter(Boolean);
  contactRuns.push(new TextRun({ text: plain.join(' | '), size: 18, font: FONT }));
  for (const l of r.contact.links) {
    contactRuns.push(new TextRun({ text: ' | ', size: 18, font: FONT }));
    contactRuns.push(new ExternalHyperlink({ link: l.url, children: [new TextRun({ text: displayUrl(l.url), size: 18, font: FONT })] }));
  }
  children.push(new Paragraph({ spacing: { after: 120 }, children: contactRuns }));

  for (const s of r.sectionOrder) {
    if (!hasContent(r, s)) continue;
    if (s === 'additional') {
      for (const a of r.additional) {
        children.push(h(a.title.toUpperCase()));
        for (const i of a.items) children.push(bulletP(i));
      }
      continue;
    }
    children.push(h(SECTION_TITLES[s]));
    if (s === 'summary') children.push(new Paragraph({ children: [new TextRun({ text: r.summary, size, font: FONT })] }));
    if (s === 'skills')
      for (const g of r.skillGroups)
        children.push(new Paragraph({ spacing: { after: 40 }, children: [new TextRun({ text: `${g.name}: `, bold: true, size, font: FONT }), new TextRun({ text: g.skills.join(', '), size, font: FONT })] }));
    if (s === 'experience')
      for (const e of r.experience) {
        children.push(
          new Paragraph({
            tabStops: [{ type: TabStopType.RIGHT, position: tabRight }],
            spacing: { before: 60, after: 40 },
            children: [
              new TextRun({ text: e.title, bold: true, size, font: FONT }),
              new TextRun({ text: `, ${e.company}${e.location ? `, ${e.location}` : ''}`, size, font: FONT }),
              new TextRun({ text: `\t${dateRange(e.startDate, e.endDate)}`, size, font: FONT }),
            ],
          }),
        );
        for (const b of e.bullets) children.push(bulletP(b.text));
      }
    if (s === 'projects')
      for (const p of r.projects) {
        children.push(new Paragraph({ spacing: { before: 60 }, children: [new TextRun({ text: `${p.name}${p.subtitle ? ` — ${p.subtitle}` : ''}`, bold: true, size, font: FONT })] }));
        if (p.technologies.length)
          children.push(new Paragraph({ children: [new TextRun({ text: 'Technologies: ', italics: true, size, font: FONT }), new TextRun({ text: p.technologies.join(', '), size, font: FONT })] }));
        if (p.links.length) children.push(new Paragraph({ children: [new TextRun({ text: p.links.map((l) => `${l.label}: ${displayUrl(l.url)}`).join(' | '), size, font: FONT })] }));
        for (const b of p.bullets) children.push(bulletP(b.text));
      }
    if (s === 'education')
      for (const e of r.education) {
        children.push(
          new Paragraph({
            tabStops: [{ type: TabStopType.RIGHT, position: tabRight }],
            children: [new TextRun({ text: e.degree, bold: true, size, font: FONT }), new TextRun({ text: e.dates ? `\t${e.dates}` : '', size, font: FONT })],
          }),
        );
        children.push(new Paragraph({ children: [new TextRun({ text: [e.institution, e.grade].filter(Boolean).join(' | '), size, font: FONT })] }));
        for (const d of e.details) children.push(bulletP(d));
      }
    if (s === 'certifications') for (const c of r.certifications) children.push(bulletP([c.name, c.issuer, c.date].filter(Boolean).join(' — ')));
  }

  const doc = new Document({
    creator: 'Job Autopilot',
    title: `${r.contact.name} — Resume`,
    sections: [{ properties: { page: { size: { width: 11906, height: 16838 }, margin: { top: 720, bottom: 720, left: 720, right: 720 } } }, children }],
  });
  return Buffer.from(await Packer.toBuffer(doc));
}

export const _internal = { AlignmentType };
