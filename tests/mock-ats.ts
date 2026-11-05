import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { fixture } from './helpers.js';

/**
 * Local stand-in for Greenhouse/Lever APIs and hosted forms, used by end-to-end tests.
 * Records every form POST so tests can assert that dry runs never submit and that
 * duplicates are never sent.
 */

export interface MockAts {
  url: string;
  submissions: Array<{ path: string; body: string }>;
  close: () => Promise<void>;
}

const page = (body: string) => `<!doctype html><html><head><meta charset="utf-8"><title>Apply</title></head><body>${body}</body></html>`;

function greenhouseForm(action: string, extra = ''): string {
  return page(`
  <h1>Frontend Engineer</h1>
  <form id="application-form" method="POST" action="${action}" enctype="multipart/form-data">
    <label for="first_name">First Name *</label><input id="first_name" name="first_name" required>
    <label for="last_name">Last Name *</label><input id="last_name" name="last_name" required>
    <label for="email">Email *</label><input id="email" name="email" type="email" required>
    <label for="phone">Phone</label><input id="phone" name="phone">
    <label for="resume">Resume/CV *</label><input id="resume" name="resume" type="file" required>
    <label for="cover_letter">Cover Letter</label><input id="cover_letter" name="cover_letter" type="file">
    <label for="question_2001">GitHub Profile</label><input id="question_2001" name="question_2001">
    <label for="question_2002">Are you legally authorized to work in India? *</label>
    <select id="question_2002" name="question_2002" required><option value="">Select...</option><option value="1">Yes</option><option value="0">No</option></select>
    <label for="question_2003">Will you now or in the future require visa sponsorship? *</label>
    <select id="question_2003" name="question_2003" required><option value="">Select...</option><option value="1">Yes</option><option value="0">No</option></select>
    <label for="gender">Gender</label>
    <select id="gender" name="gender"><option value="">Select...</option><option>Male</option><option>Female</option><option>Decline To Self Identify</option></select>
    ${extra}
    <button type="submit">Submit application</button>
  </form>`);
}

const LEVER_FORM = (action: string) =>
  page(`
<form id="application-form" method="POST" action="${action}" enctype="multipart/form-data">
  <ul>
    <li class="application-question resume"><label><div class="application-label">Resume/CV<span class="required">✱</span></div>
      <div class="application-field"><input type="file" name="resume" id="resume-upload-input" required></div></label></li>
    <li class="application-question"><label><div class="application-label">Full name<span class="required">✱</span></div>
      <div class="application-field"><input type="text" name="name" required></div></label></li>
    <li class="application-question"><label><div class="application-label">Email<span class="required">✱</span></div>
      <div class="application-field"><input type="email" name="email" required></div></label></li>
    <li class="application-question"><label><div class="application-label">Phone</div>
      <div class="application-field"><input type="text" name="phone"></div></label></li>
    <li class="application-question"><label><div class="application-label">GitHub URL</div>
      <div class="application-field"><input type="text" name="urls[GitHub]"></div></label></li>
  </ul>
  <div class="application-additional"><ul>
    <li class="application-question custom-question">
      <div class="application-label"><div class="text">Why do you want to work at Globex?<span class="required">✱</span></div></div>
      <div class="application-field"><textarea name="cards[card-1][field0]" required></textarea></div>
    </li>
  </ul></div>
  <button type="submit" id="btn-submit">Submit application</button>
</form>`);

export async function startMockAts(): Promise<MockAts> {
  const submissions: MockAts['submissions'] = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const p = url.pathname;
    const send = (status: number, body: string, type = 'text/html; charset=utf-8', headers: Record<string, string> = {}) => {
      res.writeHead(status, { 'Content-Type': type, ...headers });
      res.end(body);
    };
    if (req.method === 'POST') {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        submissions.push({ path: p, body: Buffer.concat(chunks).toString('latin1') });
        if (p.startsWith('/silent')) return send(200, greenhouseForm(p));
        if (p.startsWith('/globex')) return send(303, '', 'text/plain', { Location: p.replace(/\/apply$/, '/thanks') });
        return send(303, '', 'text/plain', { Location: `${p}/confirmation` });
      });
      return;
    }
    // --- Greenhouse API
    if (p === '/v1/boards/acme/jobs') return send(200, fixture('greenhouse-jobs.json'), 'application/json');
    if (p === '/v1/boards/acme/jobs/1001') return send(200, url.searchParams.get('questions') ? fixture('greenhouse-questions.json') : '{"id":1001}', 'application/json');
    if (/^\/v1\/boards\/(captcha|login|silent)\/jobs\/1001$/.test(p)) return send(200, fixture('greenhouse-questions.json'), 'application/json');
    if (/^\/v1\/boards\/[^/]+\/jobs\/\d+$/.test(p)) return send(404, '{"status":404}', 'application/json');
    // --- Greenhouse hosted forms
    if (/^\/(acme|silent)\/jobs\/1001$/.test(p)) return send(200, greenhouseForm(p));
    if (/^\/[^/]+\/jobs\/1001\/confirmation$/.test(p)) return send(200, page('<h1>Thank you for applying.</h1><p>Your application has been submitted.</p>'));
    if (p === '/captcha/jobs/1001') return send(200, greenhouseForm(p, '<div class="g-recaptcha" data-sitekey="test" style="width:304px;height:78px;border:1px solid #ccc">I\'m not a robot</div>'));
    if (p === '/login/jobs/1001') return send(200, page('<h1>Sign in</h1><form><input name="user"><input type="password" name="pw"><button>Sign in</button></form>'));
    // --- Lever
    if (p === '/v0/postings/globex') return send(200, fixture('lever-postings.json').replaceAll('https://jobs.lever.co', `http://127.0.0.1:${(server.address() as AddressInfo).port}`), 'application/json');
    if (/^\/globex\/[\w-]+\/apply$/.test(p)) return send(200, LEVER_FORM(p));
    if (/^\/globex\/[\w-]+\/thanks$/.test(p)) return send(200, page('<h2>Application submitted!</h2><p>Thanks for applying.</p>'));
    send(404, page('<h1>Not found</h1>'));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    submissions,
    close: () => new Promise((r) => server.close(() => r())),
  };
}
