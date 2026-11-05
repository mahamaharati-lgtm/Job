import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/server/http/app.js';
import { fixture, setupTestEnv } from '../helpers.js';

const env = setupTestEnv({ ADMIN_PASSWORD: 'test-password-123' });
let app: FastifyInstance;
let cookie = '';
const H = () => ({ cookie, 'x-requested-with': 'job-autopilot' });

beforeAll(async () => {
  app = await buildApp();
});
afterAll(async () => {
  await app.close();
  env.cleanup();
});

function multipart(filename: string, content: string, mime: string): { payload: Buffer; headers: Record<string, string> } {
  const boundary = '----testboundary' + Math.random().toString(16).slice(2);
  const payload = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${mime}\r\n\r\n`),
    Buffer.from(content),
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return { payload, headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}

describe('HTTP API', () => {
  it('requires authentication and sets secure session cookies', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/overview' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/api/auth/login', payload: { password: 'nope' } })).statusCode).toBe(401);
    const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { password: 'test-password-123' } });
    expect(res.statusCode).toBe(200);
    const set = String(res.headers['set-cookie']);
    expect(set).toMatch(/HttpOnly/i);
    expect(set).toMatch(/SameSite=Strict/i);
    cookie = set.split(';')[0];
    expect(res.headers['content-security-policy']).toContain("default-src 'self'");
  });

  it('rejects state-changing requests without the CSRF header', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/automation/pause', headers: { cookie }, payload: { paused: true } });
    expect(res.statusCode).toBe(403);
  });

  it('uploads a resume, extracts an unverified profile, then verifies it', async () => {
    const { payload, headers } = multipart('resume.txt', fixture('resume-sample.txt'), 'text/plain');
    const res = await app.inject({ method: 'POST', url: '/api/resumes/upload', headers: { ...H(), ...headers }, payload });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json();
    expect(body.profile.name).toBe('Asha Rao');
    expect(body.record.verified).toBe(false);
    // preferences suggested from the resume location
    const settings = (await app.inject({ method: 'GET', url: '/api/settings', headers: H() })).json();
    expect(settings.preferences.country).toBe('IN');
    expect(settings.preferences.locations).toEqual(['Pune']);
    const v = await app.inject({ method: 'POST', url: '/api/profile/verify', headers: H(), payload: {} });
    expect(v.json().record.verified).toBe(true);
    // the original file can be downloaded (decrypted) by the signed-in user only
    const resumes = (await app.inject({ method: 'GET', url: '/api/resumes', headers: H() })).json();
    const fileId = resumes[0].files.original;
    expect((await app.inject({ method: 'GET', url: `/api/files/${fileId}` })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: `/api/files/${fileId}`, headers: H() })).body).toContain('ASHA RAO');
  });

  it('adds a pasted job, scores it, tailors a resume and exposes the fit explanation', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/jobs/manual',
      headers: H(),
      payload: { title: 'React Developer', company: 'Wayne Tech', location: 'Pune, India', description: 'Requirements:\n• React, TypeScript, CSS\n• 0-2 years of experience\nNice to have: Next.js' },
    });
    const { id } = res.json();
    const t = await app.inject({ method: 'POST', url: `/api/jobs/${id}/tailor`, headers: H(), payload: {} });
    expect(t.statusCode, t.body).toBe(200);
    const d = t.json();
    expect(d.match.score).toBeGreaterThanOrEqual(70);
    expect(d.resume.accuracy.ok).toBe(true);
    expect(d.resume.summary.gaps).toContain('Next.js');
    expect(d.job.status).toBe('resume_ready');
    const p = await app.inject({ method: 'POST', url: `/api/jobs/${id}/prepare`, headers: H(), payload: {} });
    expect(p.json().application.reviewReason).toBe('manual_apply');
    // manual submission requires evidence
    expect((await app.inject({ method: 'POST', url: `/api/jobs/${id}/mark-submitted`, headers: H(), payload: { note: '' } })).statusCode).toBe(400);
    const ok = await app.inject({ method: 'POST', url: `/api/jobs/${id}/mark-submitted`, headers: H(), payload: { note: 'Confirmation email received' } });
    expect(ok.json().job.status).toBe('submitted');
  });

  it('validates settings', async () => {
    const bad = await app.inject({ method: 'PUT', url: '/api/settings/automation', headers: H(), payload: { matchThreshold: 500 } });
    expect(bad.statusCode).toBe(400);
    const ok = await app.inject({ method: 'PUT', url: '/api/settings/automation', headers: H(), payload: { matchThreshold: 75 } });
    expect(ok.json().matchThreshold).toBe(75);
  });

  it('deletes all data only with the exact confirmation phrase', async () => {
    expect((await app.inject({ method: 'DELETE', url: '/api/data', headers: H(), payload: { confirm: 'yes' } })).statusCode).toBe(400);
    const res = await app.inject({ method: 'DELETE', url: '/api/data', headers: H(), payload: { confirm: 'DELETE MY DATA' } });
    expect(res.statusCode).toBe(200);
    // session table was wiped too → signed out
    expect((await app.inject({ method: 'GET', url: '/api/profile', headers: H() })).statusCode).toBe(401);
  });

  it('protects the external scheduler endpoint', async () => {
    expect((await app.inject({ method: 'POST', url: '/api/internal/tick' })).statusCode).toBe(401);
  });
});
