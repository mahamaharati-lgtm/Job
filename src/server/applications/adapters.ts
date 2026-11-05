import * as cheerio from 'cheerio';
import type { FormQuestion, QuestionType } from '../../shared/types.js';
import type { JobRow } from '../jobs.js';
import { fetchJson, fetchText, HttpError } from '../sources/common.js';
import { getSource } from '../sources/registry.js';
import { fillAndSubmit, type FillContext, type FillResult } from './browser.js';

/**
 * Application adapters. Greenhouse and Lever hosted forms are automated (questions are read
 * up front so missing answers are known before a browser opens). Everything else uses the
 * manual adapter: the system prepares the package and the user submits it.
 */

export interface ApplyAdapter {
  id: 'greenhouse' | 'lever' | 'manual';
  label: string;
  supportsAutoSubmit: boolean;
  canHandle(job: JobRow): boolean;
  getQuestions(job: JobRow): Promise<FormQuestion[] | null>;
  /** null = unknown */
  isActive(job: JobRow): Promise<boolean | null>;
  formUrl(job: JobRow): string | null;
  submit(job: JobRow, ctx: Omit<FillContext, 'url' | 'formSelector' | 'submitSelector' | 'confirmUrlPattern'>): Promise<FillResult>;
}

function sourceConfig(job: JobRow): Record<string, unknown> {
  return job.source_id ? (getSource(job.source_id)?.config ?? {}) : {};
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : v == null ? '' : String(v);
}

// ---------------------------------------------------------------------------
// Greenhouse
// ---------------------------------------------------------------------------
const GH_TYPES: Record<string, QuestionType> = {
  input_text: 'text',
  textarea: 'textarea',
  input_file: 'file',
  multi_value_single_select: 'select',
  multi_value_multi_select: 'multi_select',
  input_hidden: 'hidden',
};

export function parseGreenhouseQuestions(data: Record<string, unknown>): FormQuestion[] {
  const out: FormQuestion[] = [];
  const pushQ = (q: Record<string, unknown>, section: string) => {
    const fields = Array.isArray(q.fields) ? (q.fields as Array<Record<string, unknown>>) : [];
    if (fields.length === 0) return;
    // Resume/cover letter offer "file or paste text": use the file field.
    const field = fields.find((f) => f.type === 'input_file') ?? fields[0];
    const values = Array.isArray(field.values) ? (field.values as Array<Record<string, unknown>>) : [];
    out.push({
      id: str(field.name),
      label: str(q.label),
      description: str(q.description) || undefined,
      required: q.required === true,
      type: GH_TYPES[str(field.type)] ?? 'text',
      options: values.length ? values.map((v) => ({ label: str(v.label), value: str(v.value) })) : undefined,
      section,
    });
  };
  for (const q of (data.questions as Array<Record<string, unknown>>) ?? []) pushQ(q, 'application');
  for (const q of (data.location_questions as Array<Record<string, unknown>>) ?? []) pushQ(q, 'location');
  for (const c of (data.compliance as Array<Record<string, unknown>>) ?? []) for (const q of (c.questions as Array<Record<string, unknown>>) ?? []) pushQ(q, 'eeo');
  const demo = data.demographic_questions as Record<string, unknown> | undefined;
  for (const q of (demo?.questions as Array<Record<string, unknown>>) ?? []) {
    const opts = Array.isArray(q.answer_options) ? (q.answer_options as Array<Record<string, unknown>>) : [];
    out.push({
      id: `demographic_${str(q.id)}`,
      label: str(q.label),
      required: q.required === true,
      type: str(q.type).includes('multi') ? 'multi_select' : 'select',
      options: opts.map((o) => ({ label: str(o.label), value: str(o.id) })),
      section: 'eeo',
    });
  }
  for (const d of (data.data_compliance as Array<Record<string, unknown>>) ?? []) {
    if (d.requires_consent === true) {
      out.push({ id: `gdpr_consent_${str(d.type)}`, label: 'I consent to the processing of my personal data (privacy notice)', required: true, type: 'checkbox', section: 'consent' });
    }
  }
  return out;
}

export const greenhouseAdapter: ApplyAdapter = {
  id: 'greenhouse',
  label: 'Greenhouse hosted form',
  supportsAutoSubmit: true,
  canHandle: (job) => job.ats === 'greenhouse' && Boolean(job.ats_board && job.ats_job_id),
  async getQuestions(job) {
    const cfg = sourceConfig(job);
    const api = str(cfg.apiBase) || 'https://boards-api.greenhouse.io';
    const data = (await fetchJson(`${api}/v1/boards/${job.ats_board}/jobs/${job.ats_job_id}?questions=true`)) as Record<string, unknown>;
    return parseGreenhouseQuestions(data);
  },
  async isActive(job) {
    const cfg = sourceConfig(job);
    const api = str(cfg.apiBase) || 'https://boards-api.greenhouse.io';
    try {
      await fetchJson(`${api}/v1/boards/${job.ats_board}/jobs/${job.ats_job_id}`);
      return true;
    } catch (err) {
      if (err instanceof HttpError && err.status === 404) return false;
      return null;
    }
  },
  formUrl(job) {
    const cfg = sourceConfig(job);
    const formBase = str(cfg.formBase) || 'https://job-boards.greenhouse.io';
    return `${formBase}/${job.ats_board}/jobs/${job.ats_job_id}`;
  },
  submit(job, ctx) {
    return fillAndSubmit({ ...ctx, url: this.formUrl(job)!, formSelector: 'form#application-form, form#application_form, form', confirmUrlPattern: /\/confirmation(\/|\?|$)/i });
  },
};

// ---------------------------------------------------------------------------
// Lever
// ---------------------------------------------------------------------------
export function parseLeverForm(html: string): FormQuestion[] {
  const $ = cheerio.load(html);
  const form = $('form#application-form, form').first();
  const out: FormQuestion[] = [];
  const seen = new Set<string>();
  form.find('.application-question, li.application-question, .application-additional li').each((_, el) => {
    const block = $(el);
    const labelEl = block.find('.application-label').first();
    const label = (labelEl.find('.text').text() || labelEl.text() || block.find('label').first().text()).replace(/[✱*]/g, '').replace(/\s+/g, ' ').trim();
    const inputs = block.find('input, textarea, select').filter((__, i) => {
      const t = ($(i).attr('type') ?? '').toLowerCase();
      return t !== 'hidden' && t !== 'submit' && Boolean($(i).attr('name'));
    });
    if (!inputs.length) return;
    const first = inputs.first();
    const name = first.attr('name')!;
    if (seen.has(name)) return;
    seen.add(name);
    const tag = first.prop('tagName')?.toLowerCase();
    const t = (first.attr('type') ?? '').toLowerCase();
    let type: QuestionType = tag === 'textarea' ? 'textarea' : tag === 'select' ? 'select' : (['file', 'email', 'tel', 'url', 'checkbox', 'radio', 'number', 'date'].includes(t) ? t : 'text') as QuestionType;
    let options: FormQuestion['options'];
    if (tag === 'select') {
      options = first
        .find('option')
        .toArray()
        .map((o) => ({ label: $(o).text().trim(), value: $(o).attr('value') ?? $(o).text().trim() }))
        .filter((o) => o.value !== '' && !/^select/i.test(o.label));
    } else if (t === 'radio' || t === 'checkbox') {
      options = inputs.toArray().map((i) => {
        const v = $(i).attr('value') ?? '';
        const lbl = $(i).closest('label').text().trim() || v;
        return { label: lbl.replace(/\s+/g, ' '), value: v };
      });
      if (t === 'checkbox' && options.length > 1) type = 'checkbox';
    }
    const required = block.find('.required').length > 0 || first.attr('required') !== undefined || first.attr('aria-required') === 'true';
    out.push({ id: name, label: label || name, required, type, options, section: name.startsWith('eeo') ? 'eeo' : name.startsWith('cards') ? 'custom' : 'application' });
  });
  return out;
}

function leverApplyUrl(job: JobRow): string | null {
  if (job.apply_url && /\/apply\/?$/.test(job.apply_url)) return job.apply_url;
  if (job.apply_url) return job.apply_url.replace(/\/$/, '') + '/apply';
  if (job.source_url) return job.source_url.replace(/\/$/, '') + '/apply';
  return null;
}

export const leverAdapter: ApplyAdapter = {
  id: 'lever',
  label: 'Lever hosted form',
  supportsAutoSubmit: true,
  canHandle: (job) => job.ats === 'lever' && Boolean(leverApplyUrl(job)),
  async getQuestions(job) {
    const url = leverApplyUrl(job);
    if (!url) return null;
    return parseLeverForm(await fetchText(url));
  },
  async isActive(job) {
    const url = leverApplyUrl(job);
    if (!url) return null;
    try {
      await fetchText(url);
      return true;
    } catch (err) {
      if (err instanceof HttpError && err.status === 404) return false;
      return null;
    }
  },
  formUrl: (job) => leverApplyUrl(job),
  submit(job, ctx) {
    return fillAndSubmit({ ...ctx, url: leverApplyUrl(job)!, formSelector: 'form#application-form, form', submitSelector: '#btn-submit, button[type="submit"]', confirmUrlPattern: /\/thanks(\/|\?|$)/i });
  },
};

// ---------------------------------------------------------------------------
// Manual (no supported integration)
// ---------------------------------------------------------------------------
export const manualAdapter: ApplyAdapter = {
  id: 'manual',
  label: 'Manual (you submit)',
  supportsAutoSubmit: false,
  canHandle: () => true,
  getQuestions: async () => null,
  isActive: async () => null,
  formUrl: (job) => job.apply_url ?? job.source_url,
  async submit() {
    return { outcome: 'blocked', blockReason: 'unsupported_form', submitClicked: false, detail: 'No supported integration: apply manually with the prepared resume.' };
  },
};

export const APPLY_ADAPTERS: ApplyAdapter[] = [greenhouseAdapter, leverAdapter, manualAdapter];

export function adapterFor(job: JobRow): ApplyAdapter {
  return APPLY_ADAPTERS.find((a) => a.canHandle(job)) ?? manualAdapter;
}

export function adapterById(id: string): ApplyAdapter {
  return APPLY_ADAPTERS.find((a) => a.id === id) ?? manualAdapter;
}
