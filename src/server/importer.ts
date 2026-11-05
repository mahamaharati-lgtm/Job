import { z } from 'zod';
import { upsertJob } from './jobs.js';
import { inferEmploymentType, inferWorkMode, isoOrNull, type NormalizedJob } from './sources/common.js';
import { htmlToText } from './text.js';

/**
 * Import jobs found elsewhere (pasted job descriptions, LinkedIn/Naukri postings you found
 * yourself, or a JSON export from another tool/connector). Imported jobs go through the same
 * scoring, tailoring and tracking pipeline; they are applied to manually.
 */

export const ImportJobSchema = z.object({
  title: z.string().min(2).max(200),
  company: z.string().min(1).max(200),
  location: z.string().max(200).optional().nullable(),
  url: z.string().max(2000).optional().nullable(),
  applyUrl: z.string().max(2000).optional().nullable(),
  description: z.string().max(100_000).optional().default(''),
  postedAt: z.string().optional().nullable(),
  source: z.string().max(40).optional(),
  externalId: z.string().max(200).optional(),
  salary: z.string().max(200).optional().nullable(),
  employmentType: z.string().max(60).optional().nullable(),
  workMode: z.enum(['remote', 'hybrid', 'onsite', 'unknown']).optional(),
});

export type ImportJob = z.infer<typeof ImportJobSchema>;

export function normalizeImported(j: ImportJob, defaultSource: 'manual' | 'import'): NormalizedJob {
  const text = /<\/?[a-z][\s\S]*>/i.test(j.description) ? htmlToText(j.description) : j.description;
  const source = (j.source ?? defaultSource).toLowerCase().replace(/[^a-z0-9_-]/g, '') || defaultSource;
  return {
    sourceType: source,
    externalId: j.externalId ?? `${j.company}|${j.title}|${j.location ?? ''}|${j.url ?? ''}`.toLowerCase(),
    title: j.title.trim(),
    company: j.company.trim(),
    location: j.location?.trim() || null,
    workMode: j.workMode ?? inferWorkMode(j.location, text.slice(0, 1500), j.title),
    employmentType: inferEmploymentType(j.employmentType, j.title, text.slice(0, 1500)),
    salaryText: j.salary ?? null,
    sourceUrl: j.url ?? null,
    applyUrl: j.applyUrl ?? j.url ?? null,
    descriptionHtml: null,
    descriptionText: text,
    descriptionPartial: text.length < 400,
    postedAt: isoOrNull(j.postedAt),
  };
}

export function importJobs(items: unknown[], defaultSource: 'manual' | 'import' = 'import'): { inserted: number; updated: number; merged: number; errors: string[]; ids: number[] } {
  const out = { inserted: 0, updated: 0, merged: 0, errors: [] as string[], ids: [] as number[] };
  items.slice(0, 500).forEach((raw, i) => {
    const parsed = ImportJobSchema.safeParse(raw);
    if (!parsed.success) {
      out.errors.push(`#${i + 1}: ${parsed.error.issues.map((x) => `${x.path.join('.')} ${x.message}`).join(', ')}`);
      return;
    }
    const { id, outcome } = upsertJob(normalizeImported(parsed.data, defaultSource), null);
    out[outcome]++;
    out.ids.push(id);
  });
  return out;
}
