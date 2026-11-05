import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { getConfig } from './config.js';
import { logger } from './logger.js';

/**
 * Encryption at rest (AES-256-GCM) for resumes, profile data, answers, evidence files
 * and notification settings, plus password hashing (scrypt) for dashboard login.
 */

const VERSION = 'v1';
let cachedKey: Buffer | null = null;

function deriveKey(secret: string): Buffer {
  return crypto.scryptSync(secret, 'job-autopilot:data-key:v1', 32, { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
}

/**
 * Returns the data-encryption key. In production DATA_ENCRYPTION_KEY is required.
 * In development/test a random key is generated once and stored in DATA_DIR/.encryption-key.
 */
export function getDataKey(): Buffer {
  if (cachedKey) return cachedKey;
  const cfg = getConfig();
  if (cfg.DATA_ENCRYPTION_KEY) {
    if (cfg.DATA_ENCRYPTION_KEY.length < 24) {
      throw new Error('DATA_ENCRYPTION_KEY is too short. Generate one with: openssl rand -base64 32');
    }
    cachedKey = deriveKey(cfg.DATA_ENCRYPTION_KEY);
    return cachedKey;
  }
  if (cfg.isProduction) {
    throw new Error(
      'DATA_ENCRYPTION_KEY must be set in production. Generate one with: openssl rand -base64 32 (keep it safe: without it your stored data cannot be decrypted).',
    );
  }
  const keyFile = path.join(cfg.dataDir, '.encryption-key');
  fs.mkdirSync(cfg.dataDir, { recursive: true });
  let secret: string;
  if (fs.existsSync(keyFile)) {
    secret = fs.readFileSync(keyFile, 'utf8').trim();
  } else {
    secret = crypto.randomBytes(32).toString('base64');
    fs.writeFileSync(keyFile, secret + '\n', { mode: 0o600 });
    if (!cfg.isTest) logger.warn('Generated a development encryption key in DATA_DIR/.encryption-key. Set DATA_ENCRYPTION_KEY for production.');
  }
  cachedKey = deriveKey(secret);
  return cachedKey;
}

/** Test helper: forget the cached key (e.g. after switching DATA_DIR). */
export function resetDataKeyCache(): void {
  cachedKey = null;
}

export function encryptBuffer(plain: Buffer): Buffer {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getDataKey(), iv);
  const enc = Buffer.concat([cipher.update(plain), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([Buffer.from(VERSION), iv, tag, enc]);
}

export function decryptBuffer(payload: Buffer): Buffer {
  const version = payload.subarray(0, 2).toString();
  if (version !== VERSION) throw new Error('Unsupported encryption payload version');
  const iv = payload.subarray(2, 14);
  const tag = payload.subarray(14, 30);
  const data = payload.subarray(30);
  const decipher = crypto.createDecipheriv('aes-256-gcm', getDataKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]);
}

export function encryptString(plain: string): string {
  return `${VERSION}:` + encryptBuffer(Buffer.from(plain, 'utf8')).subarray(2).toString('base64');
}

export function decryptString(value: string): string {
  if (!value.startsWith(`${VERSION}:`)) throw new Error('Value is not encrypted with a supported version');
  const raw = Buffer.concat([Buffer.from(VERSION), Buffer.from(value.slice(VERSION.length + 1), 'base64')]);
  return decryptBuffer(raw).toString('utf8');
}

export function encryptJson(value: unknown): string {
  return encryptString(JSON.stringify(value));
}

export function decryptJson<T>(value: string): T {
  return JSON.parse(decryptString(value)) as T;
}

// ---------------------------------------------------------------------------
// Passwords, tokens, hashing
// ---------------------------------------------------------------------------
export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16);
  const N = 2 ** 15;
  const hash = crypto.scryptSync(password, salt, 64, { N, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return `scrypt$${N}$8$1$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, nStr, rStr, pStr, saltB64, hashB64] = parts;
  const expected = Buffer.from(hashB64, 'base64');
  const actual = crypto.scryptSync(password, Buffer.from(saltB64, 'base64'), expected.length, {
    N: Number(nStr),
    r: Number(rStr),
    p: Number(pStr),
    maxmem: 64 * 1024 * 1024,
  });
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

export function randomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString('base64url');
}

export function sha256(value: string | Buffer): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(sha256(a));
  const bb = Buffer.from(sha256(b));
  return crypto.timingSafeEqual(ba, bb);
}

export function shortId(prefix = ''): string {
  return prefix + crypto.randomBytes(6).toString('hex');
}
