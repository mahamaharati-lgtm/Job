import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

/**
 * Runtime configuration from environment variables.
 * Secrets are only ever read from the environment (or a local .env file that is gitignored).
 */

const bool = z
  .union([z.boolean(), z.string()])
  .transform((v) => (typeof v === 'boolean' ? v : ['1', 'true', 'yes', 'on'].includes(v.toLowerCase())));

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().positive().default(8080),
  HOST: z.string().default('0.0.0.0'),
  DATA_DIR: z.string().default('./data'),
  APP_ROOT: z.string().optional(),
  PUBLIC_URL: z.string().optional(),
  APP_TIMEZONE: z.string().optional(),
  APP_MODE: z.enum(['all', 'web', 'worker']).default('all'),

  ADMIN_PASSWORD: z.string().optional(),
  ADMIN_PASSWORD_HASH: z.string().optional(),
  DATA_ENCRYPTION_KEY: z.string().optional(),
  SESSION_TTL_HOURS: z.coerce.number().positive().default(168),
  COOKIE_SECURE: z.enum(['auto', 'true', 'false']).default('auto'),
  CRON_SECRET: z.string().optional(),

  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_MODEL: z.string().default('claude-opus-5-5'),
  ANTHROPIC_EFFORT: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).default('medium'),

  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().positive().default(587),
  SMTP_SECURE: bool.default(false),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  SMTP_FROM: z.string().optional(),
  TELEGRAM_BOT_TOKEN: z.string().optional(),

  ADZUNA_APP_ID: z.string().optional(),
  ADZUNA_APP_KEY: z.string().optional(),

  CHROMIUM_EXECUTABLE_PATH: z.string().optional(),
  BROWSER_HEADLESS: bool.default(true),
  BROWSER_TIMEOUT_MS: z.coerce.number().int().positive().default(45_000),
  SUBMIT_CONFIRM_TIMEOUT_MS: z.coerce.number().int().positive().default(25_000),
  HTTP_USER_AGENT: z.string().default('JobAutopilot/1.0 (personal job search; contact via repository)'),
  HTTP_TIMEOUT_MS: z.coerce.number().int().positive().default(20_000),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
});

export type Env = z.infer<typeof EnvSchema>;

export interface AppConfig extends Env {
  appRoot: string;
  dataDir: string;
  dbPath: string;
  filesDir: string;
  tmpDir: string;
  isProduction: boolean;
  isTest: boolean;
  llmEnabled: boolean;
  smtpEnabled: boolean;
}

let current: AppConfig | null = null;

function loadDotEnv(): void {
  const file = path.resolve(process.cwd(), '.env');
  if (fs.existsSync(file) && typeof process.loadEnvFile === 'function') {
    try {
      process.loadEnvFile(file);
    } catch {
      // A malformed .env should not crash the process; validation below reports missing values.
    }
  }
}

export function loadConfig(overrides: Partial<Record<keyof Env, string>> = {}): AppConfig {
  if (!overrides.NODE_ENV || overrides.NODE_ENV !== 'test') loadDotEnv();
  const raw: Record<string, unknown> = { ...process.env, ...overrides };
  // Treat empty strings as unset so `KEY=` in .env does not count as configured.
  for (const [k, v] of Object.entries(raw)) if (v === '') delete raw[k];
  const env = EnvSchema.parse(raw);
  const appRoot = path.resolve(env.APP_ROOT ?? process.cwd());
  const dataDir = path.resolve(appRoot, env.DATA_DIR);
  const cfg: AppConfig = {
    ...env,
    appRoot,
    dataDir,
    dbPath: path.join(dataDir, 'app.db'),
    filesDir: path.join(dataDir, 'files'),
    tmpDir: path.join(dataDir, 'tmp'),
    isProduction: env.NODE_ENV === 'production',
    isTest: env.NODE_ENV === 'test',
    llmEnabled: Boolean(env.ANTHROPIC_API_KEY),
    smtpEnabled: Boolean(env.SMTP_HOST && env.SMTP_FROM),
  };
  current = cfg;
  return cfg;
}

export function getConfig(): AppConfig {
  return current ?? loadConfig();
}

/** Secret values that must never appear in logs. */
export function secretValues(cfg: AppConfig = getConfig()): string[] {
  return [
    cfg.ADMIN_PASSWORD,
    cfg.ADMIN_PASSWORD_HASH,
    cfg.DATA_ENCRYPTION_KEY,
    cfg.CRON_SECRET,
    cfg.ANTHROPIC_API_KEY,
    cfg.SMTP_PASS,
    cfg.TELEGRAM_BOT_TOKEN,
    cfg.ADZUNA_APP_KEY,
  ].filter((v): v is string => typeof v === 'string' && v.length >= 6);
}
