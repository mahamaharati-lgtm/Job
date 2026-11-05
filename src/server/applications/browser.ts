import { chromium, type Browser, type Locator, type Page } from 'playwright';
import type { FormQuestion, ResolvedAnswer } from '../../shared/types.js';
import { getConfig } from '../config.js';

/**
 * Permitted browser automation for hosted application forms.
 * - Runs a normal, visible-to-the-site Chromium (no stealth plugins, no fingerprint spoofing).
 * - Never solves, bypasses or outsources CAPTCHAs: it stops and asks the user.
 * - Stops on login walls / verification steps.
 * - Calls onBeforeSubmit() (write-ahead marker) immediately before clicking submit.
 */

export interface FileInput {
  name: string;
  mimeType: string;
  buffer: Buffer;
}

export interface FillContext {
  url: string;
  questions: FormQuestion[];
  answers: ResolvedAnswer[];
  resumePdf: FileInput;
  resumeText: string;
  coverLetterPdf?: FileInput;
  coverLetterText?: string;
  dryRun: boolean;
  captchaPolicy: 'pause_if_present' | 'pause_if_challenged';
  /** Extra CSS selector for the form container, if known. */
  formSelector?: string;
  submitSelector?: string;
  confirmUrlPattern?: RegExp;
  onBeforeSubmit: () => void;
}

export type FillOutcome = 'submitted' | 'dry_run_complete' | 'uncertain' | 'blocked' | 'needs_input' | 'failed' | 'closed';

export interface FillResult {
  outcome: FillOutcome;
  submitClicked: boolean;
  detail: string;
  blockReason?: 'captcha' | 'login_required' | 'verification_required' | 'unsupported_form';
  confirmationText?: string;
  confirmationUrl?: string;
  screenshot?: Buffer;
  html?: string;
  unfilledRequired?: string[];
}

const CONFIRM_TEXT = /(thank(s| you) for (applying|your application|your interest)|application (has been |was )?(submitted|received)|we('ve| have) received your application|successfully (submitted|applied)|your application is (in|complete))/i;
const CLOSED_TEXT = /(no longer (accepting|available|open)|job (is )?(closed|not found)|position has been filled|this posting (has )?(closed|expired))/i;
const VERIFY_TEXT = /(verify your email|enter the (code|verification code)|we sent (you )?a (code|link)|confirm your email address)/i;

let browserPromise: Promise<Browser> | null = null;

export async function getBrowser(): Promise<Browser> {
  if (!browserPromise) {
    const cfg = getConfig();
    browserPromise = chromium.launch({
      headless: cfg.BROWSER_HEADLESS,
      executablePath: cfg.CHROMIUM_EXECUTABLE_PATH || undefined,
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    });
  }
  return browserPromise;
}

export async function closeBrowser(): Promise<void> {
  if (browserPromise) {
    const b = await browserPromise.catch(() => null);
    browserPromise = null;
    await b?.close().catch(() => undefined);
  }
}

async function visible(loc: Locator): Promise<boolean> {
  try {
    return (await loc.count()) > 0 && (await loc.first().isVisible());
  } catch {
    return false;
  }
}

export async function detectCaptcha(page: Page): Promise<{ present: boolean; challengeVisible: boolean; kind: string | null }> {
  const widgets = [
    { kind: 'reCAPTCHA', sel: '.g-recaptcha, iframe[src*="recaptcha"], [data-sitekey][class*="recaptcha"]' },
    { kind: 'hCaptcha', sel: '.h-captcha, iframe[src*="hcaptcha"], [data-hcaptcha-widget-id]' },
    { kind: 'Turnstile', sel: '.cf-turnstile, iframe[src*="challenges.cloudflare.com"]' },
    { kind: 'CAPTCHA', sel: '[id*="captcha" i]:not(input[type=hidden]), [class*="captcha" i]:not(input[type=hidden])' },
  ];
  let present = false;
  let challengeVisible = false;
  let kind: string | null = null;
  for (const w of widgets) {
    const loc = page.locator(w.sel);
    const count = await loc.count().catch(() => 0);
    if (count === 0) continue;
    present = true;
    kind = kind ?? w.kind;
    for (let i = 0; i < Math.min(count, 5); i++) {
      const el = loc.nth(i);
      const size = await el.getAttribute('data-size').catch(() => null);
      if (size === 'invisible') continue;
      const box = await el.boundingBox().catch(() => null);
      if (box && box.width > 40 && box.height > 30 && (await el.isVisible().catch(() => false))) {
        challengeVisible = true;
        kind = w.kind;
      }
    }
  }
  // Challenge popups (image grids) rendered after submit
  if (await visible(page.locator('iframe[src*="recaptcha/api2/bframe"], iframe[src*="hcaptcha.com"][src*="challenge"]'))) challengeVisible = true;
  return { present, challengeVisible, kind };
}

async function detectLogin(page: Page): Promise<boolean> {
  const url = page.url().toLowerCase();
  if (/\/(login|signin|sign-in|auth|sso)(\/|\?|$)/.test(url)) return true;
  const pwd = await visible(page.locator('input[type="password"]'));
  const fileInput = (await page.locator('input[type="file"]').count().catch(() => 0)) > 0;
  return pwd && !fileInput;
}

function cssEscape(id: string): string {
  return id.replace(/([ !"#$%&'()*+,./:;<=>?@[\\\]^`{|}~])/g, '\\$1');
}

async function locateControl(page: Page, q: FormQuestion, scope: string): Promise<Locator | null> {
  const candidates = [
    page.locator(`${scope} [name="${q.id.replace(/"/g, '\\"')}"]`),
    page.locator(`${scope} #${cssEscape(q.id)}`),
  ];
  for (const c of candidates) if ((await c.count().catch(() => 0)) > 0) return c;
  const byLabel = page.getByLabel(q.label.replace(/[*✱]/g, '').trim(), { exact: false });
  if ((await byLabel.count().catch(() => 0)) > 0) return byLabel;
  return null;
}

async function fillOne(page: Page, q: FormQuestion, a: ResolvedAnswer, ctx: FillContext, scope: string): Promise<string | null> {
  const loc = await locateControl(page, q, scope);
  if (!loc) return `field not found on page`;
  const first = loc.first();
  let value = a.value;
  if (value === '__RESUME_TEXT__') value = ctx.resumeText;
  if (value === '__COVER_LETTER_TEXT__') value = ctx.coverLetterText ?? '';
  const tag = (await first.evaluate((el) => el.tagName.toLowerCase()).catch(() => '')) as string;
  const type = ((await first.getAttribute('type').catch(() => '')) ?? '').toLowerCase();
  const role = (await first.getAttribute('role').catch(() => '')) ?? '';
  try {
    if (type === 'file') {
      const file = a.category === 'cover_letter' ? ctx.coverLetterPdf : ctx.resumePdf;
      if (!file) return 'no file available';
      await first.setInputFiles(file);
      return null;
    }
    if (tag === 'select') {
      const vals = Array.isArray(value) ? value : [String(value)];
      await first.selectOption(vals.map((label) => ({ label })));
      return null;
    }
    if (type === 'radio' || type === 'checkbox') {
      const vals = Array.isArray(value) ? value : [String(value)];
      const count = await loc.count();
      if (count === 1 && type === 'checkbox') {
        if (vals.some((v) => /^(yes|true|i agree|agree|checked|1)$/i.test(v) || v.length > 0)) await first.check();
        return null;
      }
      let done = 0;
      for (let i = 0; i < count; i++) {
        const el = loc.nth(i);
        const v = (await el.getAttribute('value')) ?? '';
        const id = await el.getAttribute('id');
        const label = id ? ((await page.locator(`label[for="${id}"]`).first().textContent().catch(() => '')) ?? '') : '';
        const parentText = (await el.evaluate((n) => n.parentElement?.textContent ?? '').catch(() => '')) as string;
        if (vals.some((x) => [v, label.trim(), parentText.trim()].some((t) => t && t.toLowerCase() === x.toLowerCase()))) {
          await el.check();
          done++;
        }
      }
      return done > 0 ? null : 'no matching option';
    }
    if (role === 'combobox' || (await first.getAttribute('aria-autocomplete')) === 'list') {
      const text = Array.isArray(value) ? value[0] : String(value);
      await first.click();
      await first.fill(text);
      const option = page.getByRole('option', { name: text, exact: false }).first();
      if (await visible(option)) await option.click();
      else await first.press('Enter');
      return null;
    }
    await first.fill(Array.isArray(value) ? value.join(', ') : String(value ?? ''));
    return null;
  } catch (err) {
    return (err as Error).message.split('\n')[0].slice(0, 160);
  }
}

async function unfilledRequired(page: Page, scope: string): Promise<string[]> {
  return page
    .locator(`${scope} [required], ${scope} [aria-required="true"]`)
    .evaluateAll((els) => {
      const out: string[] = [];
      const seenGroups = new Set<string>();
      for (const el of els as HTMLInputElement[]) {
        if (el.type === 'hidden' || el.disabled || (el.offsetParent === null && el.type !== 'file')) continue;
        let empty = false;
        if (el.type === 'checkbox' || el.type === 'radio') {
          const name = el.name;
          if (seenGroups.has(name)) continue;
          seenGroups.add(name);
          const group = Array.from(document.getElementsByName(name)) as HTMLInputElement[];
          empty = !group.some((g) => g.checked);
        } else if (el.type === 'file') empty = !el.files || el.files.length === 0;
        else empty = !String(el.value ?? '').trim();
        if (empty) {
          const label = (el.id && document.querySelector(`label[for="${el.id}"]`)?.textContent) || el.getAttribute('aria-label') || el.name || el.id;
          out.push(String(label).replace(/\s+/g, ' ').trim().slice(0, 120));
        }
      }
      return out;
    })
    .catch(() => []);
}

async function capture(page: Page): Promise<{ screenshot: Buffer; html: string }> {
  const screenshot = await page.screenshot({ fullPage: true, type: 'png' }).catch(async () => page.screenshot({ type: 'png' }));
  const html = await page.content().catch(() => '');
  return { screenshot, html };
}

export async function fillAndSubmit(ctx: FillContext): Promise<FillResult> {
  const cfg = getConfig();
  const browser = await getBrowser();
  const context = await browser.newContext({ viewport: { width: 1280, height: 1600 }, locale: 'en-US' });
  context.setDefaultTimeout(cfg.BROWSER_TIMEOUT_MS);
  const page = await context.newPage();
  let submitClicked = false;
  try {
    const resp = await page.goto(ctx.url, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => undefined);
    if (resp && resp.status() === 404) return { outcome: 'closed', submitClicked, detail: 'Application page returned 404 (posting closed)' };
    const bodyText = (await page.locator('body').innerText().catch(() => '')) ?? '';
    if (CLOSED_TEXT.test(bodyText) && (await page.locator('input[type="file"]').count()) === 0) {
      return { outcome: 'closed', submitClicked, detail: 'The employer page says the posting is closed' };
    }
    if (await detectLogin(page)) {
      const c = await capture(page);
      return { outcome: 'blocked', blockReason: 'login_required', submitClicked, detail: 'The application page requires signing in', ...c };
    }
    // Resolve the form container to ONE selector (a selector list cannot be used as a prefix).
    let scope = 'form';
    for (const candidate of (ctx.formSelector ?? '').split(',').map((s) => s.trim()).filter(Boolean)) {
      if ((await page.locator(candidate).count()) > 0) {
        scope = candidate;
        break;
      }
    }
    if ((await page.locator(scope).count()) === 0) {
      const c = await capture(page);
      return { outcome: 'blocked', blockReason: 'unsupported_form', submitClicked, detail: 'No application form found on the page', ...c };
    }
    const captchaBefore = await detectCaptcha(page);
    if (captchaBefore.challengeVisible || (captchaBefore.present && ctx.captchaPolicy === 'pause_if_present')) {
      const c = await capture(page);
      return { outcome: 'blocked', blockReason: 'captcha', submitClicked, detail: `${captchaBefore.kind ?? 'CAPTCHA'} on the form: complete this application manually`, ...c };
    }

    const problems: string[] = [];
    for (const q of ctx.questions) {
      const a = ctx.answers.find((x) => x.questionId === q.id);
      if (!a || a.value === null || (Array.isArray(a.value) && a.value.length === 0)) continue;
      const err = await fillOne(page, q, a, ctx, scope);
      if (err && q.required) problems.push(`${q.label}: ${err}`);
    }
    if (problems.length) {
      const c = await capture(page);
      return { outcome: 'blocked', blockReason: 'unsupported_form', submitClicked, detail: `Could not fill required fields — ${problems.slice(0, 4).join('; ')}`, ...c };
    }
    const empty = await unfilledRequired(page, scope);
    if (empty.length) {
      const c = await capture(page);
      return { outcome: 'needs_input', submitClicked, detail: `Form has required fields the system has no answer for: ${empty.join('; ')}`, unfilledRequired: empty, ...c };
    }
    const filled = await capture(page);
    if (ctx.dryRun) {
      return { outcome: 'dry_run_complete', submitClicked, detail: 'Dry run: every field was filled; the form was NOT submitted.', ...filled };
    }

    const submit = page
      .locator(ctx.submitSelector ?? `${scope} button[type="submit"], ${scope} input[type="submit"], ${scope} button:has-text("Submit")`)
      .first();
    if (!(await visible(submit))) return { outcome: 'blocked', blockReason: 'unsupported_form', submitClicked, detail: 'Submit button not found', ...filled };
    const startUrl = page.url();
    ctx.onBeforeSubmit();
    submitClicked = true;
    await submit.click();

    const deadline = Date.now() + cfg.SUBMIT_CONFIRM_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await page.waitForTimeout(700);
      const url = page.url();
      const text = (await page.locator('body').innerText().catch(() => '')) ?? '';
      const confirmMatch = text.match(CONFIRM_TEXT);
      const urlConfirms = (ctx.confirmUrlPattern ?? /\/(confirmation|thanks|thank-you|success|applied)(\/|\?|$)/i).test(url) && url !== startUrl;
      if (confirmMatch || urlConfirms) {
        const c = await capture(page);
        return {
          outcome: 'submitted',
          submitClicked,
          detail: 'Confirmation page detected',
          confirmationText: confirmMatch ? confirmMatch[0] : `Redirected to ${new URL(url).pathname}`,
          confirmationUrl: url,
          ...c,
        };
      }
      if (VERIFY_TEXT.test(text)) {
        const c = await capture(page);
        return { outcome: 'blocked', blockReason: 'verification_required', submitClicked, detail: 'The site asks for email/identity verification to finish', ...c };
      }
      const captchaAfter = await detectCaptcha(page);
      if (captchaAfter.challengeVisible) {
        const c = await capture(page);
        return { outcome: 'uncertain', blockReason: 'captcha', submitClicked, detail: 'A CAPTCHA challenge appeared after clicking submit; the application was most likely not sent. Verify and finish manually.', ...c };
      }
    }
    const c = await capture(page);
    return { outcome: 'uncertain', submitClicked, detail: 'Submit was clicked but no confirmation was detected in time. Check your email or the employer site before retrying.', ...c };
  } catch (err) {
    let c: { screenshot?: Buffer; html?: string } = {};
    try {
      c = await capture(page);
    } catch {
      /* page gone */
    }
    return {
      outcome: submitClicked ? 'uncertain' : 'failed',
      submitClicked,
      detail: `${submitClicked ? 'Error after clicking submit' : 'Browser error before submitting'}: ${(err as Error).message.split('\n')[0].slice(0, 200)}`,
      ...c,
    };
  } finally {
    await context.close().catch(() => undefined);
  }
}
