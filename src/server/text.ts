import * as cheerio from 'cheerio';

/** Text helpers shared by sources, matching and tailoring. */

export function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

/** Convert job-description HTML to readable plain text, keeping list items and headings on their own lines. */
export function htmlToText(html: string | null | undefined): string {
  if (!html) return '';
  let src = html;
  if (/&lt;\/?[a-z]/i.test(src) && !/<\/?[a-z]/i.test(src)) src = decodeEntities(src);
  const $ = cheerio.load(src);
  $('script, style, noscript').remove();
  $('br').replaceWith('\n');
  $('li').each((_, el) => {
    $(el).prepend('\n• ');
  });
  $('p, div, h1, h2, h3, h4, h5, h6, ul, ol, tr, section').each((_, el) => {
    $(el).append('\n');
  });
  return $.root()
    .text()
    .replace(/ /g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function normalizeWhitespace(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

const COMPANY_SUFFIXES = /\b(inc|inc\.|llc|ltd|ltd\.|limited|pvt|private|corp|corporation|co|gmbh|plc|technologies|technology|labs|software|solutions|india|group)\b\.?/g;

export function normalizeCompany(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .replace(COMPANY_SUFFIXES, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function normalizeTitle(s: string): string {
  return s
    .toLowerCase()
    .replace(/front[\s-]?end/g, 'frontend')
    .replace(/\breact\.?js\b/g, 'react')
    .replace(/\bsr\.?\b/g, 'senior')
    .replace(/\bjr\.?\b/g, 'junior')
    .replace(/\(.*?\)/g, ' ')
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const CITY_ALIASES: Record<string, string> = {
  bangalore: 'bengaluru',
  'bengaluru urban': 'bengaluru',
  blr: 'bengaluru',
  bombay: 'mumbai',
  gurgaon: 'gurugram',
  'new delhi': 'delhi',
  madras: 'chennai',
  calcutta: 'kolkata',
  mysore: 'mysuru',
  mangalore: 'mangaluru',
  cochin: 'kochi',
  trivandrum: 'thiruvananthapuram',
};

export function normalizeCity(s: string): string {
  const base = s.toLowerCase().replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim();
  return CITY_ALIASES[base] ?? base;
}

export function normalizeLocation(s: string | null | undefined): string {
  if (!s) return '';
  const first = s.split(/[,;/|]/)[0] ?? '';
  return normalizeCity(first.replace(/\b(remote|hybrid|on-?site|office)\b/gi, ''));
}

export function companyTitleKey(company: string, title: string): string {
  return `${normalizeCompany(company)}|${normalizeTitle(title)}`;
}

export function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Extract all numbers (including decimals, 50,000 style) from text as normalized strings. */
export function extractNumbers(s: string): string[] {
  const out: string[] = [];
  for (const m of s.matchAll(/\d[\d,]*(?:\.\d+)?/g)) out.push(m[0].replace(/,/g, ''));
  return out;
}

export function uniq<T>(arr: T[]): T[] {
  return [...new Set(arr)];
}

export function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + '…';
}

export function similarity(a: string, b: string): number {
  const ta = new Set(a.toLowerCase().split(/\W+/).filter((w) => w.length > 2));
  const tb = new Set(b.toLowerCase().split(/\W+/).filter((w) => w.length > 2));
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const w of ta) if (tb.has(w)) inter++;
  return inter / Math.max(ta.size, tb.size);
}
