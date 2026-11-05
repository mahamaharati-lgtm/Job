import { afterAll, describe, expect, it } from 'vitest';
import { all, get } from '../../src/server/db.js';
import { discover, isPotentiallyRelevant } from '../../src/server/discovery.js';
import { importJobs } from '../../src/server/importer.js';
import { adzuna, ashby, greenhouse, lever, remoteok, remotive, smartrecruiters } from '../../src/server/sources/adapters.js';
import type { SourceContext } from '../../src/server/sources/common.js';
import { addSource, detectSourceFromUrl } from '../../src/server/sources/registry.js';
import { fixtureJson, indiaPrefs, setupTestEnv } from '../helpers.js';

const env = setupTestEnv({ ADZUNA_APP_ID: 'id', ADZUNA_APP_KEY: 'key' });
afterAll(() => env.cleanup());

function ctxFor(routes: Record<string, unknown>): SourceContext & { calls: string[] } {
  const calls: string[] = [];
  return {
    prefs: indiaPrefs(),
    calls,
    fetchJson: async (url: string) => {
      calls.push(url);
      const key = Object.keys(routes).find((k) => url.includes(k));
      if (!key) throw Object.assign(new Error(`HTTP 404 from ${url}`), { status: 404 });
      return structuredClone(routes[key]);
    },
    fetchText: async () => '',
  };
}

describe('source adapters (fixtures in each API’s documented format)', () => {
  it('greenhouse: unescapes HTML content and maps fields', async () => {
    const jobs = await greenhouse.fetchJobs({ board: 'acme' }, ctxFor({ '/v1/boards/acme/jobs': fixtureJson('greenhouse-jobs.json') }));
    expect(jobs).toHaveLength(3);
    expect(jobs[0]).toMatchObject({ externalId: 'acme:1001', title: 'Frontend Engineer', company: 'Acme', location: 'Pune, India', ats: 'greenhouse', atsJobId: '1001' });
    expect(jobs[0].descriptionText).toContain('1+ years of experience building web applications with React and TypeScript');
  });

  it('lever: workplace type, lists and apply URL', async () => {
    const jobs = await lever.fetchJobs({ company: 'globex' }, ctxFor({ '/v0/postings/globex': fixtureJson('lever-postings.json') }));
    expect(jobs[0]).toMatchObject({ title: 'React Developer', workMode: 'remote', employmentType: 'full_time', ats: 'lever' });
    expect(jobs[0].applyUrl).toMatch(/\/apply$/);
    expect(jobs[0].descriptionText).toContain('React and TypeScript');
  });

  it('ashby: skips unlisted jobs', async () => {
    const jobs = await ashby.fetchJobs({ org: 'initech' }, ctxFor({ '/posting-api/job-board/initech': fixtureJson('ashby-board.json') }));
    expect(jobs.map((j) => j.title)).toEqual(['Prompt Engineer']);
    expect(jobs[0].workMode).toBe('remote');
  });

  it('smartrecruiters: fetches details for the description', async () => {
    const jobs = await smartrecruiters.fetchJobs(
      { company: 'Stark', query: 'frontend' },
      ctxFor({ '/postings?': fixtureJson('smartrecruiters-list.json'), '/postings/744000001': fixtureJson('smartrecruiters-detail.json') }),
    );
    expect(jobs[0]).toMatchObject({ title: 'Frontend Developer', company: 'Stark Industries', workMode: 'hybrid' });
    expect(jobs[0].descriptionText).toContain('React and TypeScript UI work');
  });

  it('remotive, remoteok and adzuna map remote regions and snippets', async () => {
    const r = await remotive.fetchJobs({ search: 'react' }, ctxFor({ 'remote-jobs': fixtureJson('remotive.json') }));
    expect(r[0].location).toBe('Remote (USA Only)');
    const ok = await remoteok.fetchJobs({}, ctxFor({ '/api': fixtureJson('remoteok.json') }));
    expect(ok.map((j) => j.title)).toEqual(['UI Engineer']); // legal notice + non-matching tags skipped
    const az = await adzuna.fetchJobs({ what: 'react developer' }, ctxFor({ '/jobs/in/search/1': fixtureJson('adzuna.json') }));
    expect(az[0]).toMatchObject({ title: 'React Developer', company: 'Wayne Tech', descriptionPartial: true, salaryCurrency: 'INR' });
  });
});

describe('careers URL detection', () => {
  it.each([
    ['https://boards.greenhouse.io/acme', 'greenhouse', { board: 'acme' }],
    ['https://job-boards.greenhouse.io/acme/jobs/123', 'greenhouse', { board: 'acme' }],
    ['https://boards.greenhouse.io/embed/job_board?for=acme', 'greenhouse', { board: 'acme' }],
    ['jobs.lever.co/globex', 'lever', { company: 'globex' }],
    ['https://jobs.eu.lever.co/globex/abc', 'lever', { company: 'globex', region: 'eu' }],
    ['https://jobs.ashbyhq.com/initech', 'ashby', { org: 'initech' }],
    ['https://jobs.smartrecruiters.com/Stark/744000001', 'smartrecruiters', { company: 'Stark' }],
  ])('%s', (url, type, config) => {
    const d = detectSourceFromUrl(url)!;
    expect(d.type).toBe(type);
    expect(d.config).toEqual(config);
  });
  it('returns null for unknown sites', () => expect(detectSourceFromUrl('https://example.com/careers')).toBeNull());
});

describe('discovery: relevance, dedup and closure', () => {
  it('filters irrelevant departments', () => {
    const base = { sourceType: 'x', externalId: '1', company: 'A', location: null, workMode: 'unknown' as const, employmentType: 'unknown' as const, sourceUrl: null, applyUrl: null, descriptionText: '' };
    expect(isPotentiallyRelevant({ ...base, title: 'Account Executive' }, indiaPrefs())).toBe(false);
    expect(isPotentiallyRelevant({ ...base, title: 'Frontend Engineer' }, indiaPrefs())).toBe(true);
    expect(isPotentiallyRelevant({ ...base, title: 'Software Engineer', descriptionText: 'Backend in Go and Kafka' }, indiaPrefs())).toBe(false);
    expect(isPotentiallyRelevant({ ...base, title: 'Software Engineer', descriptionText: 'React and TypeScript web UI' }, indiaPrefs())).toBe(true);
  });

  it('does not create duplicates across runs or across sources, and closes jobs removed from a board', async () => {
    const gh = addSource('greenhouse', 'acme', { board: 'acme' });
    let data = fixtureJson<{ jobs: unknown[] }>('greenhouse-jobs.json');
    const ctx = (): SourceContext => ({ prefs: indiaPrefs(), fetchJson: async () => structuredClone(data), fetchText: async () => '' });

    const first = await discover({ sourceIds: [gh.id], ctx: ctx() });
    expect(first.inserted).toBe(2); // Account Executive filtered out
    const second = await discover({ sourceIds: [gh.id], ctx: ctx() });
    expect(second.inserted).toBe(0);
    expect(second.updated).toBe(2);
    expect(get<{ n: number }>('SELECT COUNT(*) AS n FROM jobs')!.n).toBe(2);

    // Same job pasted manually → merged into the existing record, not duplicated
    const imp = importJobs([{ title: 'Frontend Engineer', company: 'Acme Inc.', location: 'Pune, India', description: 'React role' }]);
    expect(imp.merged).toBe(1);
    expect(get<{ n: number }>('SELECT COUNT(*) AS n FROM jobs')!.n).toBe(2);

    // Job disappears from the board: closed after two consecutive misses
    data = { ...data, jobs: data.jobs.filter((j) => (j as { id: number }).id !== 1002) };
    await discover({ sourceIds: [gh.id], ctx: ctx() });
    expect(get<{ is_active: number }>("SELECT is_active FROM jobs WHERE external_id = 'acme:1002'")!.is_active).toBe(1);
    const third = await discover({ sourceIds: [gh.id], ctx: ctx() });
    expect(third.closed).toBe(1);
    const closed = get<{ is_active: number; status: string }>("SELECT is_active, status FROM jobs WHERE external_id = 'acme:1002'")!;
    expect(closed).toMatchObject({ is_active: 0, status: 'closed' });
  });

  it('records a clear error for a missing board', async () => {
    const bad = addSource('greenhouse', 'nope', { board: 'nope' });
    const ctx: SourceContext = {
      prefs: indiaPrefs(),
      fetchJson: async () => {
        const { HttpError } = await import('../../src/server/sources/common.js');
        throw new HttpError(404, 'HTTP 404');
      },
      fetchText: async () => '',
    };
    const res = await discover({ sourceIds: [bad.id], ctx });
    expect(res.sourcesFailed).toBe(1);
    const row = all<{ last_error: string }>('SELECT last_error FROM sources WHERE id = ?', [bad.id])[0];
    expect(row.last_error).toMatch(/Board not found/);
  });
});
