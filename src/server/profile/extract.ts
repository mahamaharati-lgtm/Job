import mammoth from 'mammoth';
import { getDocumentProxy } from 'unpdf';

/**
 * Extract plain text from an uploaded resume. PDF text is rebuilt line-by-line from glyph
 * positions so that "Title, Company      Jul 2025 – Present" stays on one line.
 */

export const SUPPORTED_RESUME_TYPES: Record<string, string> = {
  'application/pdf': 'pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'text/plain': 'txt',
  'text/markdown': 'txt',
};

export function detectResumeType(filename: string, mime: string): 'pdf' | 'docx' | 'txt' | null {
  const ext = filename.toLowerCase().split('.').pop() ?? '';
  if (ext === 'pdf' || mime === 'application/pdf') return 'pdf';
  if (ext === 'docx' || mime.includes('wordprocessingml')) return 'docx';
  if (['txt', 'md', 'markdown'].includes(ext) || mime.startsWith('text/')) return 'txt';
  return null;
}

interface PdfTextItem {
  str: string;
  transform: number[];
  width: number;
  hasEOL?: boolean;
}

async function pdfToText(data: Buffer): Promise<string> {
  const pdf = await getDocumentProxy(new Uint8Array(data));
  const pages: string[] = [];
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const content = await page.getTextContent();
    const items = (content.items as unknown as PdfTextItem[]).filter((i) => typeof i.str === 'string' && i.str.length > 0);
    // Group by baseline (y), tolerant to small differences.
    const lines: Array<{ y: number; items: PdfTextItem[] }> = [];
    for (const it of items) {
      const y = it.transform[5];
      let line = lines.find((l) => Math.abs(l.y - y) < 2.5);
      if (!line) {
        line = { y, items: [] };
        lines.push(line);
      }
      line.items.push(it);
    }
    lines.sort((a, b) => b.y - a.y);
    const out: string[] = [];
    for (const line of lines) {
      line.items.sort((a, b) => a.transform[4] - b.transform[4]);
      let text = '';
      let lastEnd: number | null = null;
      for (const it of line.items) {
        const x = it.transform[4];
        const fontSize = Math.abs(it.transform[0]) || 10;
        if (lastEnd !== null) {
          const gap = x - lastEnd;
          if (gap > fontSize * 3) text += '    ';
          else if (gap > fontSize * 0.15 && !text.endsWith(' ') && !it.str.startsWith(' ')) text += ' ';
        }
        text += it.str;
        lastEnd = x + it.width;
      }
      out.push(text.replace(/\s+$/, ''));
    }
    pages.push(out.join('\n'));
  }
  return pages.join('\n');
}

export async function extractResumeText(data: Buffer, filename: string, mime: string): Promise<string> {
  const type = detectResumeType(filename, mime);
  if (!type) throw new Error('Unsupported file type. Upload a PDF, DOCX or TXT resume.');
  let text: string;
  if (type === 'pdf') text = await pdfToText(data);
  else if (type === 'docx') text = (await mammoth.extractRawText({ buffer: data })).value;
  else text = data.toString('utf8');
  text = text.replace(/\r\n?/g, '\n').replace(/ /g, ' ').replace(/[ \t]+\n/g, '\n');
  if (text.replace(/\s/g, '').length < 100) {
    throw new Error('Could not read enough text from this file. If it is a scanned image PDF, export a text-based PDF or DOCX instead.');
  }
  return text.trim();
}
