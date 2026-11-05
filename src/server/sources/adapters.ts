import { getConfig } from '../config.js';
import { htmlToText } from '../text.js';
import {
  inferEmploymentType,
  inferWorkMode,
  isoOrNull,
  requireString,
  str,
  type NormalizedJob,
  type SourceAdapter,
  type SourceContext,
} from './common.js';

/**
 * Job source adapters. Each one uses an official/public API — no scraping of sites that
 * forbid it, no logins. ATS board APIs list every open job of one employer.
 */

type Obj = Record<string, unknown>;
const asObj = (v: unknown): Obj => (v && typeof v === 'object' ? (v as Obj) : {});
const asArr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

function base(config: Obj, fallback: string): string {
  return (typeof config.apiBase === 'string' && config.apiBase ? config.apiBase : fallback).replace(/\/$/, '');
}

// ---------------------------------------------------------------------------
// Greenhouse Job Board API (official, public): boards-api.greenhouse.io
// ---------------------------------------------------------------------------
export const greenhouse: SourceAdapter = {
  type: 'greenhouse',
  label: 'Greenhouse',
  kind: 'ats',
  completeListing: true,
  defaultIntervalMinutes: 180,
  integration: 'official_api',
  configHelp: 'Board token from boards.greenhouse.io/<token> or job-boards.greenhouse.io/<token>',
  validateConfig: (c) => requireString(c, 'board', 'Board token'),
  async fetchJobs(config, ctx) {
    const board = str(config.board).trim();
    const data = asObj(await ctx.fetchJson(`${base(config, 'https://boards-api.greenhouse.io')}/v1/boards/${encodeURIComponent(board)}/jobs?content=true`));
    return asArr(data.jobs).map((raw): NormalizedJob => {
      const j = asObj(raw);
      const html = str(j.content);
      const location = str(asObj(j.location).name) || null;
      const id = str(j.id);
      const text = htmlToText(html);
      return {
        sourceType: 'greenhouse',
        externalId: `${board}:${id}`,
        title: str(j.title).trim(),
        company: str(j.company_name) || str(config.companyName) || board,
        location,
        workMode: inferWorkMode(location, text.slice(0, 1500)),
        employmentType: inferEmploymentType(str(j.title), text.slice(0, 2000)),
        sourceUrl: str(j.absolute_url) || null,
        applyUrl: str(j.absolute_url) || null,
        ats: 'greenhouse',
        atsBoard: board,
        atsJobId: id,
        descriptionHtml: html,
        descriptionText: text,
        postedAt: isoOrNull(j.first_published) ?? isoOrNull(j.updated_at),
      };
    });
  },
};

// ---------------------------------------------------------------------------
// Lever Postings API (official, public): api.lever.co/v0/postings/<company>
// ---------------------------------------------------------------------------
export const lever: SourceAdapter = {
  type: 'lever',
  label: 'Lever',
  kind: 'ats',
  completeListing: true,
  defaultIntervalMinutes: 180,
  integration: 'official_api',
  configHelp: 'Company slug from jobs.lever.co/<company>. Set region "eu" for jobs.eu.lever.co.',
  validateConfig: (c) => requireString(c, 'company', 'Company slug'),
  async fetchJobs(config, ctx) {
    const company = str(config.company).trim();
    const fallback = config.region === 'eu' ? 'https://api.eu.lever.co' : 'https://api.lever.co';
    const data = await ctx.fetchJson(`${base(config, fallback)}/v0/postings/${encodeURIComponent(company)}?mode=json`);
    return asArr(data).map((raw): NormalizedJob => {
      const j = asObj(raw);
      const cats = asObj(j.categories);
      const lists = asArr(j.lists)
        .map((l) => `<h3>${str(asObj(l).text)}</h3><ul>${str(asObj(l).content)}</ul>`)
        .join('');
      const html = `${str(j.opening)}${str(j.description)}${lists}${str(j.additional)}`;
      const text = htmlToText(html) || [str(j.descriptionPlain), str(j.additionalPlain)].join('\n');
      const salary = asObj(j.salaryRange);
      const location = str(cats.location) || asArr(cats.allLocations).map(str).join(', ') || null;
      const workplace = str(j.workplaceType);
      return {
        sourceType: 'lever',
        externalId: `${company}:${str(j.id)}`,
        title: str(j.text).trim(),
        company: str(config.companyName) || company,
        location,
        workMode: workplace === 'remote' ? 'remote' : workplace === 'hybrid' ? 'hybrid' : workplace === 'on-site' ? 'onsite' : inferWorkMode(location, text.slice(0, 1500)),
        employmentType: inferEmploymentType(str(cats.commitment), str(j.text)),
        salaryText: str(j.salaryDescriptionPlain) || null,
        salaryMin: typeof salary.min === 'number' ? salary.min : null,
        salaryMax: typeof salary.max === 'number' ? salary.max : null,
        salaryCurrency: str(salary.currency) || null,
        sourceUrl: str(j.hostedUrl) || null,
        applyUrl: str(j.applyUrl) || (str(j.hostedUrl) ? `${str(j.hostedUrl)}/apply` : null),
        ats: 'lever',
        atsBoard: company,
        atsJobId: str(j.id),
        descriptionHtml: html,
        descriptionText: text,
        postedAt: isoOrNull(j.createdAt),
      };
    });
  },
};

// ---------------------------------------------------------------------------
// Ashby Job Posting API (official, public): api.ashbyhq.com/posting-api/job-board/<org>
// ---------------------------------------------------------------------------
export const ashby: SourceAdapter = {
  type: 'ashby',
  label: 'Ashby',
  kind: 'ats',
  completeListing: true,
  defaultIntervalMinutes: 180,
  integration: 'official_api',
  configHelp: 'Job board name from jobs.ashbyhq.com/<org>',
  validateConfig: (c) => requireString(c, 'org', 'Job board name'),
  async fetchJobs(config, ctx) {
    const org = str(config.org).trim();
    const data = asObj(await ctx.fetchJson(`${base(config, 'https://api.ashbyhq.com')}/posting-api/job-board/${encodeURIComponent(org)}?includeCompensation=true`));
    return asArr(data.jobs)
      .filter((raw) => asObj(raw).isListed !== false)
      .map((raw): NormalizedJob => {
        const j = asObj(raw);
        const html = str(j.descriptionHtml);
        const text = htmlToText(html) || str(j.descriptionPlain);
        const workplace = str(j.workplaceType).toLowerCase();
        const secondary = asArr(j.secondaryLocations).map((l) => str(asObj(l).location)).filter(Boolean);
        const location = [str(j.location), ...secondary].filter(Boolean).join('; ') || null;
        const comp = asObj(j.compensation);
        return {
          sourceType: 'ashby',
          externalId: `${org}:${str(j.id)}`,
          title: str(j.title).trim(),
          company: str(config.companyName) || org,
          location,
          workMode: workplace === 'remote' || j.isRemote === true ? 'remote' : workplace === 'hybrid' ? 'hybrid' : workplace === 'onsite' ? 'onsite' : inferWorkMode(location, text.slice(0, 1500)),
          employmentType: inferEmploymentType(str(j.employmentType).replace(/([a-z])([A-Z])/g, '$1 $2')),
          salaryText: str(comp.scrapeableCompensationSalarySummary) || str(comp.compensationTierSummary) || null,
          sourceUrl: str(j.jobUrl) || null,
          applyUrl: str(j.applyUrl) || str(j.jobUrl) || null,
          ats: 'ashby',
          atsBoard: org,
          atsJobId: str(j.id),
          descriptionHtml: html,
          descriptionText: text,
          postedAt: isoOrNull(j.publishedAt),
        };
      });
  },
};

// ---------------------------------------------------------------------------
// SmartRecruiters Posting API (official, public)
// ---------------------------------------------------------------------------
export const smartrecruiters: SourceAdapter = {
  type: 'smartrecruiters',
  label: 'SmartRecruiters',
  kind: 'ats',
  completeListing: false, // listing is filtered by query, so absence does not prove closure
  defaultIntervalMinutes: 360,
  integration: 'official_api',
  configHelp: 'Company identifier from jobs.smartrecruiters.com/<Company>. Optional "query" filter (default: frontend OR react).',
  validateConfig: (c) => requireString(c, 'company', 'Company identifier'),
  async fetchJobs(config, ctx) {
    const company = str(config.company).trim();
    const api = base(config, 'https://api.smartrecruiters.com');
    const queries = str(config.query) ? [str(config.query)] : ['frontend', 'react', 'prompt', 'ui developer'];
    const seen = new Map<string, Obj>();
    for (const q of queries) {
      const data = asObj(await ctx.fetchJson(`${api}/v1/companies/${encodeURIComponent(company)}/postings?limit=100&q=${encodeURIComponent(q)}`));
      for (const p of asArr(data.content)) seen.set(str(asObj(p).id), asObj(p));
    }
    const out: NormalizedJob[] = [];
    for (const [id, p] of [...seen.entries()].slice(0, 40)) {
      let detail: Obj = {};
      try {
        detail = asObj(await ctx.fetchJson(`${api}/v1/companies/${encodeURIComponent(company)}/postings/${encodeURIComponent(id)}`));
      } catch {
        /* keep summary data */
      }
      const sections = asObj(asObj(detail.jobAd).sections);
      const html = ['companyDescription', 'jobDescription', 'qualifications', 'additionalInformation']
        .map((k) => {
          const s = asObj(sections[k]);
          return s.text ? `<h3>${str(s.title)}</h3>${str(s.text)}` : '';
        })
        .join('');
      const loc = asObj(p.location);
      const location = str(loc.fullLocation) || [str(loc.city), str(loc.country).toUpperCase()].filter(Boolean).join(', ') || null;
      out.push({
        sourceType: 'smartrecruiters',
        externalId: `${company}:${id}`,
        title: str(p.name).trim(),
        company: str(asObj(p.company).name) || company,
        location,
        workMode: loc.remote === true ? 'remote' : loc.hybrid === true ? 'hybrid' : inferWorkMode(location),
        employmentType: inferEmploymentType(str(asObj(p.typeOfEmployment).label)),
        sourceUrl: str(detail.postingUrl) || `https://jobs.smartrecruiters.com/${company}/${id}`,
        applyUrl: str(detail.applyUrl) || str(detail.postingUrl) || `https://jobs.smartrecruiters.com/${company}/${id}`,
        ats: 'smartrecruiters',
        atsBoard: company,
        atsJobId: id,
        descriptionHtml: html || null,
        descriptionText: htmlToText(html),
        descriptionPartial: !html,
        postedAt: isoOrNull(p.releasedDate),
      });
    }
    return out;
  },
};

// ---------------------------------------------------------------------------
// Remotive public API (remote jobs). Terms: link back to Remotive and credit it as the source;
// do not poll more than a few times a day.
// ---------------------------------------------------------------------------
export const remotive: SourceAdapter = {
  type: 'remotive',
  label: 'Remotive',
  kind: 'aggregator',
  completeListing: false,
  defaultIntervalMinutes: 360,
  integration: 'public_api',
  terms: 'Jobs link back to Remotive, credited as the source. Polled at most every 6 hours.',
  configHelp: 'Optional "search" (default: your keywords) and "category" (default: software-dev).',
  validateConfig: () => null,
  async fetchJobs(config, ctx) {
    const searches = str(config.search) ? [str(config.search)] : ['react', 'frontend', 'prompt'];
    const category = str(config.category) || 'software-dev';
    const out = new Map<string, NormalizedJob>();
    for (const search of searches) {
      const url = `${base(config, 'https://remotive.com')}/api/remote-jobs?category=${encodeURIComponent(category)}&search=${encodeURIComponent(search)}&limit=100`;
      const data = asObj(await ctx.fetchJson(url));
      for (const raw of asArr(data.jobs)) {
        const j = asObj(raw);
        const html = str(j.description);
        const region = str(j.candidate_required_location);
        out.set(str(j.id), {
          sourceType: 'remotive',
          externalId: str(j.id),
          title: str(j.title).trim(),
          company: str(j.company_name),
          location: region ? `Remote (${region})` : 'Remote',
          workMode: 'remote',
          employmentType: inferEmploymentType(str(j.job_type).replace('_', ' ')),
          salaryText: str(j.salary) || null,
          sourceUrl: str(j.url) || null,
          applyUrl: str(j.url) || null,
          descriptionHtml: html,
          descriptionText: htmlToText(html),
          postedAt: isoOrNull(j.publication_date),
        });
      }
    }
    return [...out.values()];
  },
};

// ---------------------------------------------------------------------------
// Remote OK public API. Terms: link back to Remote OK and mention it as the source.
// ---------------------------------------------------------------------------
export const remoteok: SourceAdapter = {
  type: 'remoteok',
  label: 'Remote OK',
  kind: 'aggregator',
  completeListing: false,
  defaultIntervalMinutes: 360,
  integration: 'public_api',
  terms: 'Jobs link back to Remote OK, credited as the source.',
  configHelp: 'Optional "tags" list (default: react, frontend, javascript, typescript, ai).',
  validateConfig: () => null,
  async fetchJobs(config, ctx) {
    const tags = Array.isArray(config.tags) && config.tags.length ? (config.tags as string[]) : ['react', 'frontend', 'javascript', 'typescript', 'ai'];
    const data = asArr(await ctx.fetchJson(`${base(config, 'https://remoteok.com')}/api`));
    return data
      .map(asObj)
      .filter((j) => j.id && j.position)
      .filter((j) => {
        const jt = asArr(j.tags).map((t) => str(t).toLowerCase());
        return tags.some((t) => jt.includes(t.toLowerCase())) || tags.some((t) => str(j.position).toLowerCase().includes(t.toLowerCase()));
      })
      .map((j): NormalizedJob => {
        const html = str(j.description);
        const location = str(j.location);
        return {
          sourceType: 'remoteok',
          externalId: str(j.id),
          title: str(j.position).trim(),
          company: str(j.company),
          location: location ? `Remote (${location})` : 'Remote',
          workMode: 'remote',
          employmentType: inferEmploymentType(htmlToText(html).slice(0, 800)),
          salaryMin: Number(j.salary_min) || null,
          salaryMax: Number(j.salary_max) || null,
          salaryCurrency: Number(j.salary_min) ? 'USD' : null,
          sourceUrl: str(j.url) || null,
          applyUrl: str(j.apply_url) || str(j.url) || null,
          descriptionHtml: html,
          descriptionText: htmlToText(html),
          postedAt: isoOrNull(j.date) ?? isoOrNull(j.epoch),
        };
      });
  },
};

// ---------------------------------------------------------------------------
// Adzuna API (free key: developer.adzuna.com). Good coverage for India, UK, US, EU.
// Descriptions are snippets; full text lives on the linked page.
// ---------------------------------------------------------------------------
export const adzuna: SourceAdapter = {
  type: 'adzuna',
  label: 'Adzuna',
  kind: 'aggregator',
  completeListing: false,
  defaultIntervalMinutes: 360,
  integration: 'api_key_required',
  terms: 'Requires ADZUNA_APP_ID and ADZUNA_APP_KEY. Links go to the original postings via Adzuna.',
  configHelp: 'country (ISO, e.g. "in"), optional "where" (default: your locations) and "what" (default: your keywords).',
  validateConfig: () => null,
  async fetchJobs(config, ctx: SourceContext) {
    const cfg = getConfig();
    if (!cfg.ADZUNA_APP_ID || !cfg.ADZUNA_APP_KEY) throw new Error('Adzuna needs ADZUNA_APP_ID and ADZUNA_APP_KEY environment variables');
    const country = (str(config.country) || ctx.prefs.country || 'in').toLowerCase();
    const whats = str(config.what) ? [str(config.what)] : ctx.prefs.keywords.slice(0, 5);
    const where = str(config.where) || ctx.prefs.locations[0] || '';
    const out = new Map<string, NormalizedJob>();
    for (const what of whats) {
      const params = new URLSearchParams({
        app_id: cfg.ADZUNA_APP_ID,
        app_key: cfg.ADZUNA_APP_KEY,
        what,
        results_per_page: '50',
        max_days_old: String(ctx.prefs.maxJobAgeDays),
        'content-type': 'application/json',
      });
      if (where) params.set('where', where);
      const data = asObj(await ctx.fetchJson(`${base(config, 'https://api.adzuna.com')}/v1/api/jobs/${country}/search/1?${params}`));
      for (const raw of asArr(data.results)) {
        const j = asObj(raw);
        const location = str(asObj(j.location).display_name) || null;
        const desc = str(j.description);
        out.set(str(j.id), {
          sourceType: 'adzuna',
          externalId: str(j.id),
          title: htmlToText(str(j.title)).trim(),
          company: str(asObj(j.company).display_name) || 'Unknown company',
          location,
          workMode: inferWorkMode(location, desc, str(j.title)),
          employmentType: inferEmploymentType(str(j.contract_time).replace('_', ' '), str(j.contract_type), str(j.title)),
          salaryMin: Number(j.salary_min) || null,
          salaryMax: Number(j.salary_max) || null,
          salaryCurrency: country === 'in' ? 'INR' : null,
          salaryText: j.salary_is_predicted === '1' ? 'Estimated by Adzuna' : null,
          sourceUrl: str(j.redirect_url) || null,
          applyUrl: str(j.redirect_url) || null,
          descriptionHtml: null,
          descriptionText: htmlToText(desc),
          descriptionPartial: true,
          postedAt: isoOrNull(j.created),
        });
      }
    }
    return [...out.values()];
  },
};

export const ADAPTERS: Record<string, SourceAdapter> = { greenhouse, lever, ashby, smartrecruiters, remotive, remoteok, adzuna };
