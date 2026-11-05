import { getConfig, secretValues } from './config.js';

/**
 * Small structured logger with aggressive redaction.
 * Never pass resume content, answers or credentials to the logger; redaction is a safety net,
 * not a licence to log personal data.
 */

type Level = 'debug' | 'info' | 'warn' | 'error';
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const PHONE_RE = /(?<![\w/.-])\+?\d[\d\s().-]{7,}\d(?![\w/-])/g;
const TOKEN_RE = /\b(?:sk-ant-[\w-]{10,}|[A-Za-z0-9_-]{40,})\b/g;
const KV_SECRET_RE = /((?:password|passwd|secret|token|api[_-]?key|authorization|cookie)\s*[=:]\s*)([^\s,;&"']+)/gi;

export function redact(input: string): string {
  let out = input;
  for (const s of secretValues()) out = out.split(s).join('[secret]');
  return out
    .replace(KV_SECRET_RE, '$1[redacted]')
    .replace(EMAIL_RE, '[email]')
    .replace(TOKEN_RE, '[token]')
    .replace(PHONE_RE, '[phone]');
}

function redactValue(value: unknown, depth = 0): unknown {
  if (depth > 4) return '[depth]';
  if (value == null) return value;
  if (typeof value === 'string') return redact(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (value instanceof Error) return { name: value.name, message: redact(value.message) };
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => redactValue(v, depth + 1));
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (/pass|secret|token|key|cookie|authorization|answer|resume|profile|phone|email/i.test(k)) {
        out[k] = '[redacted]';
      } else {
        out[k] = redactValue(v, depth + 1);
      }
    }
    return out;
  }
  return String(value);
}

export interface Logger {
  debug(msg: string, meta?: Record<string, unknown>): void;
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
  child(bindings: Record<string, unknown>): Logger;
}

function createLogger(bindings: Record<string, unknown> = {}): Logger {
  const write = (level: Level, msg: string, meta?: Record<string, unknown>) => {
    const cfg = getConfig();
    if (cfg.isTest && level !== 'error' && process.env.TEST_LOGS !== '1') return;
    if (ORDER[level] < ORDER[cfg.LOG_LEVEL]) return;
    const record = {
      time: new Date().toISOString(),
      level,
      msg: redact(msg),
      ...(redactValue({ ...bindings, ...(meta ?? {}) }) as Record<string, unknown>),
    };
    const line = cfg.isProduction
      ? JSON.stringify(record)
      : `${record.time.slice(11, 19)} ${level.toUpperCase().padEnd(5)} ${record.msg}${
          Object.keys(record).length > 3
            ? ' ' + JSON.stringify(Object.fromEntries(Object.entries(record).filter(([k]) => !['time', 'level', 'msg'].includes(k))))
            : ''
        }`;
    if (level === 'error' || level === 'warn') process.stderr.write(line + '\n');
    else process.stdout.write(line + '\n');
  };
  return {
    debug: (m, meta) => write('debug', m, meta),
    info: (m, meta) => write('info', m, meta),
    warn: (m, meta) => write('warn', m, meta),
    error: (m, meta) => write('error', m, meta),
    child: (b) => createLogger({ ...bindings, ...b }),
  };
}

export const logger = createLogger();

/** Convert an unknown error into a safe, redacted message for storage/UI. */
export function safeErrorMessage(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return redact(msg).slice(0, 500);
}
