import type { FastifyReply, FastifyRequest } from 'fastify';
import { getConfig } from '../config.js';
import { randomToken, safeEqual, sha256, verifyPassword } from '../crypto.js';
import { get, nowIso, run } from '../db.js';

/** Single-user dashboard authentication: password → httpOnly session cookie. */

export const COOKIE = 'ja_session';

export function authConfigured(): boolean {
  const cfg = getConfig();
  return Boolean(cfg.ADMIN_PASSWORD || cfg.ADMIN_PASSWORD_HASH);
}

export function checkPassword(password: string): boolean {
  const cfg = getConfig();
  if (cfg.ADMIN_PASSWORD_HASH) return verifyPassword(password, cfg.ADMIN_PASSWORD_HASH);
  if (cfg.ADMIN_PASSWORD) return safeEqual(password, cfg.ADMIN_PASSWORD);
  return false;
}

export function createSession(): { token: string; expires: Date } {
  const token = randomToken(32);
  const expires = new Date(Date.now() + getConfig().SESSION_TTL_HOURS * 3600_000);
  run('INSERT INTO sessions (id, created_at, expires_at, last_seen_at) VALUES (?, ?, ?, ?)', [sha256(token), nowIso(), expires.toISOString(), nowIso()]);
  run('DELETE FROM sessions WHERE expires_at < ?', [nowIso()]);
  return { token, expires };
}

export function destroySession(token: string | undefined): void {
  if (token) run('DELETE FROM sessions WHERE id = ?', [sha256(token)]);
}

export function validSession(token: string | undefined): boolean {
  if (!token) return false;
  const row = get<{ expires_at: string }>('SELECT expires_at FROM sessions WHERE id = ?', [sha256(token)]);
  if (!row || row.expires_at < nowIso()) return false;
  run('UPDATE sessions SET last_seen_at = ? WHERE id = ?', [nowIso(), sha256(token)]);
  return true;
}

export function cookieSecure(req: FastifyRequest): boolean {
  const mode = getConfig().COOKIE_SECURE;
  if (mode === 'true') return true;
  if (mode === 'false') return false;
  return req.protocol === 'https' || req.headers['x-forwarded-proto'] === 'https';
}

export function isAuthenticated(req: FastifyRequest): boolean {
  if (!authConfigured()) return !getConfig().isProduction; // dev convenience only
  return validSession(req.cookies[COOKIE]);
}

export async function requireAuth(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!isAuthenticated(req)) {
    await reply.code(401).send({ error: 'Not signed in' });
    return;
  }
  // CSRF: browsers cannot add custom headers cross-site without CORS (which we never enable).
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.headers['x-requested-with'] !== 'job-autopilot') {
    await reply.code(403).send({ error: 'Missing CSRF header' });
  }
}

// Simple in-memory login rate limit (per IP)
const attempts = new Map<string, { count: number; first: number }>();
export function loginRateLimited(ip: string): boolean {
  const now = Date.now();
  const a = attempts.get(ip);
  if (!a || now - a.first > 15 * 60_000) {
    attempts.set(ip, { count: 1, first: now });
    return false;
  }
  a.count++;
  return a.count > 10;
}
