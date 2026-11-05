import nodemailer from 'nodemailer';
import type { NotificationSettings } from '../shared/types.js';
import { getConfig } from './config.js';
import { all, get, nowIso, run } from './db.js';
import { logger, safeErrorMessage } from './logger.js';
import { getProfile } from './profile/store.js';
import { getSection } from './settings.js';

/**
 * Notifications: always stored in-app; optionally delivered by email (SMTP), Telegram,
 * ntfy (phone push) or a generic webhook (Slack/Discord-compatible JSON).
 */

export type NotificationKind = 'needs_input' | 'needs_review' | 'submitted' | 'failed' | 'blocked' | 'digest' | 'source_error' | 'system' | 'test';

export interface NotifyInput {
  kind: NotificationKind;
  title: string;
  body: string;
  jobId?: number | null;
  html?: string;
}

function eventEnabled(kind: NotificationKind, s: NotificationSettings): boolean {
  switch (kind) {
    case 'needs_input':
      return s.events.needsInput;
    case 'needs_review':
    case 'blocked':
      return s.events.needsReview;
    case 'submitted':
      return s.events.submitted;
    case 'failed':
    case 'source_error':
      return s.events.failed;
    case 'digest':
      return s.events.digest;
    default:
      return true;
  }
}

function link(jobId?: number | null): string {
  const base = getConfig().PUBLIC_URL?.replace(/\/$/, '');
  if (!base) return '';
  return jobId ? `${base}/jobs/${jobId}` : base;
}

async function sendEmail(to: string, subject: string, text: string, html?: string): Promise<void> {
  const cfg = getConfig();
  if (!cfg.smtpEnabled) throw new Error('SMTP is not configured');
  const transport = nodemailer.createTransport({
    host: cfg.SMTP_HOST,
    port: cfg.SMTP_PORT,
    secure: cfg.SMTP_SECURE,
    auth: cfg.SMTP_USER ? { user: cfg.SMTP_USER, pass: cfg.SMTP_PASS } : undefined,
  });
  await transport.sendMail({ from: cfg.SMTP_FROM, to, subject, text, html });
}

async function postJson(url: string, body: unknown, headers: Record<string, string> = {}): Promise<void> {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

export async function deliver(n: NotifyInput, settings: NotificationSettings = getSection('notifications')): Promise<{ delivered: string[]; errors: string[] }> {
  const delivered: string[] = [];
  const errors: string[] = [];
  const url = link(n.jobId);
  const text = url ? `${n.body}\n\n${url}` : n.body;
  const subject = `[Job Autopilot] ${n.title}`;
  const tasks: Array<[string, () => Promise<void>]> = [];
  if (settings.email.enabled) {
    const to = settings.email.to || getProfile()?.email || '';
    if (to) tasks.push(['email', () => sendEmail(to, subject, text, n.html)]);
  }
  if (settings.telegram.enabled && settings.telegram.chatId) {
    const token = getConfig().TELEGRAM_BOT_TOKEN;
    if (token) tasks.push(['telegram', () => postJson(`https://api.telegram.org/bot${token}/sendMessage`, { chat_id: settings.telegram.chatId, text: `${n.title}\n\n${text}`.slice(0, 4000), disable_web_page_preview: true })]);
    else errors.push('telegram: TELEGRAM_BOT_TOKEN not set');
  }
  if (settings.ntfy.enabled && settings.ntfy.topic) {
    tasks.push([
      'ntfy',
      async () => {
        const res = await fetch(`${settings.ntfy.server.replace(/\/$/, '')}/${encodeURIComponent(settings.ntfy.topic)}`, {
          method: 'POST',
          headers: { Title: n.title.replace(/[^\x20-\x7E]/g, ''), ...(url ? { Click: url } : {}), Tags: n.kind },
          body: n.body.slice(0, 3500),
          signal: AbortSignal.timeout(15_000),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
      },
    ]);
  }
  if (settings.webhook.enabled && settings.webhook.url) {
    tasks.push(['webhook', () => postJson(settings.webhook.url, { text: `*${n.title}*\n${text}`, content: `**${n.title}**\n${text}`.slice(0, 1900), kind: n.kind, title: n.title, body: n.body, url })]);
  }
  await Promise.all(
    tasks.map(async ([name, fn]) => {
      try {
        await fn();
        delivered.push(name);
      } catch (err) {
        errors.push(`${name}: ${safeErrorMessage(err)}`);
        logger.warn('Notification delivery failed', { channel: name, error: safeErrorMessage(err) });
      }
    }),
  );
  return { delivered, errors };
}

export async function notify(n: NotifyInput): Promise<number> {
  const id = run('INSERT INTO notifications (kind, title, body, job_id, created_at) VALUES (?, ?, ?, ?, ?)', [n.kind, n.title, n.body, n.jobId ?? null, nowIso()]).lastInsertRowid;
  const settings = getSection('notifications');
  if (!eventEnabled(n.kind, settings)) return id;
  const { delivered, errors } = await deliver(n, settings);
  run('UPDATE notifications SET delivered = ?, delivery_errors = ? WHERE id = ?', [JSON.stringify(delivered), JSON.stringify(errors), id]);
  return id;
}

/** Fire-and-forget variant for code paths that must not wait on SMTP/HTTP. */
export function notifySoon(n: NotifyInput): void {
  notify(n).catch((err) => logger.warn('notify failed', { error: safeErrorMessage(err) }));
}

export function listNotifications(limit = 50): Array<Record<string, unknown>> {
  return all('SELECT * FROM notifications ORDER BY id DESC LIMIT ?', [limit]).map((r) => ({
    ...r,
    delivered: JSON.parse(String(r.delivered)),
    delivery_errors: JSON.parse(String(r.delivery_errors)),
  }));
}

export function unreadCount(): number {
  return get<{ n: number }>('SELECT COUNT(*) AS n FROM notifications WHERE read_at IS NULL')!.n;
}

export function markRead(id?: number): void {
  if (id) run('UPDATE notifications SET read_at = ? WHERE id = ? AND read_at IS NULL', [nowIso(), id]);
  else run('UPDATE notifications SET read_at = ? WHERE read_at IS NULL', [nowIso()]);
}
