import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { getConfig } from './config.js';

/**
 * SQLite (built into Node >= 22.13) with WAL mode. One database file under DATA_DIR.
 * All personal content is encrypted before it is written (see crypto.ts).
 */

let db: DatabaseSync | null = null;

const MIGRATIONS: Array<{ version: number; sql: string }> = [
  {
    version: 1,
    sql: `
CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE profile (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  data_enc TEXT NOT NULL,
  verified INTEGER NOT NULL DEFAULT 0,
  verified_at TEXT,
  extraction_method TEXT NOT NULL DEFAULT 'heuristic',
  warnings TEXT NOT NULL DEFAULT '[]',
  source_resume_id INTEGER,
  updated_at TEXT NOT NULL
);

CREATE TABLE files (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL,
  filename TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  path TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE sources (
  id INTEGER PRIMARY KEY,
  type TEXT NOT NULL,
  name TEXT NOT NULL,
  config TEXT NOT NULL DEFAULT '{}',
  enabled INTEGER NOT NULL DEFAULT 1,
  min_interval_minutes INTEGER NOT NULL DEFAULT 0,
  last_run_at TEXT,
  last_status TEXT,
  last_error TEXT,
  last_count INTEGER,
  created_at TEXT NOT NULL,
  UNIQUE (type, name)
);

CREATE TABLE jobs (
  id INTEGER PRIMARY KEY,
  fingerprint TEXT NOT NULL UNIQUE,
  company_title_key TEXT NOT NULL,
  source_type TEXT NOT NULL,
  source_id INTEGER REFERENCES sources(id) ON DELETE SET NULL,
  external_id TEXT,
  title TEXT NOT NULL,
  company TEXT NOT NULL,
  location TEXT,
  work_mode TEXT NOT NULL DEFAULT 'unknown',
  employment_type TEXT NOT NULL DEFAULT 'unknown',
  salary_text TEXT,
  salary_min REAL,
  salary_max REAL,
  salary_currency TEXT,
  source_url TEXT,
  apply_url TEXT,
  ats TEXT,
  ats_board TEXT,
  ats_job_id TEXT,
  description_html TEXT,
  description_text TEXT,
  description_partial INTEGER NOT NULL DEFAULT 0,
  posted_at TEXT,
  discovered_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  last_checked_at TEXT,
  missed_runs INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1,
  closed_at TEXT,
  closed_reason TEXT,
  status TEXT NOT NULL DEFAULT 'found',
  status_reason TEXT,
  status_updated_at TEXT NOT NULL,
  tracks TEXT NOT NULL DEFAULT '[]',
  score REAL,
  eligible INTEGER NOT NULL DEFAULT 1,
  match_json TEXT,
  scored_at TEXT,
  scoring_version INTEGER,
  dismissed INTEGER NOT NULL DEFAULT 0,
  notes TEXT,
  UNIQUE (source_type, external_id)
);
CREATE INDEX idx_jobs_status ON jobs(status);
CREATE INDEX idx_jobs_score ON jobs(score);
CREATE INDEX idx_jobs_ctk ON jobs(company_title_key);
CREATE INDEX idx_jobs_discovered ON jobs(discovered_at);

CREATE TABLE job_sightings (
  id INTEGER PRIMARY KEY,
  job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  source_type TEXT NOT NULL,
  external_id TEXT NOT NULL,
  url TEXT,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  UNIQUE (source_type, external_id)
);

CREATE TABLE resumes (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('original', 'tailored')),
  job_id INTEGER REFERENCES jobs(id) ON DELETE CASCADE,
  original_file_id INTEGER REFERENCES files(id) ON DELETE SET NULL,
  pdf_file_id INTEGER REFERENCES files(id) ON DELETE SET NULL,
  docx_file_id INTEGER REFERENCES files(id) ON DELETE SET NULL,
  txt_file_id INTEGER REFERENCES files(id) ON DELETE SET NULL,
  cover_letter_file_id INTEGER REFERENCES files(id) ON DELETE SET NULL,
  content_enc TEXT,
  summary_json TEXT,
  accuracy_json TEXT,
  cover_letter_enc TEXT,
  cover_letter_required INTEGER NOT NULL DEFAULT 0,
  profile_hash TEXT,
  is_current INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_resumes_job ON resumes(job_id);

CREATE TABLE applications (
  id INTEGER PRIMARY KEY,
  job_id INTEGER NOT NULL UNIQUE REFERENCES jobs(id) ON DELETE CASCADE,
  company_title_key TEXT NOT NULL,
  resume_id INTEGER REFERENCES resumes(id) ON DELETE SET NULL,
  adapter TEXT NOT NULL,
  state TEXT NOT NULL,
  review_reason TEXT,
  questions_json TEXT,
  user_answers_enc TEXT,
  resolution_enc TEXT,
  missing_count INTEGER NOT NULL DEFAULT 0,
  idempotency_key TEXT NOT NULL UNIQUE,
  attempts INTEGER NOT NULL DEFAULT 0,
  submitted_at TEXT,
  submitted_via TEXT,
  confirmation_text TEXT,
  confirmation_url TEXT,
  evidence_file_id INTEGER REFERENCES files(id) ON DELETE SET NULL,
  evidence_html_file_id INTEGER REFERENCES files(id) ON DELETE SET NULL,
  last_error TEXT,
  next_action TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_app_state ON applications(state);
CREATE INDEX idx_app_ctk ON applications(company_title_key);

CREATE TABLE application_attempts (
  id INTEGER PRIMARY KEY,
  application_id INTEGER NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  dry_run INTEGER NOT NULL,
  trigger TEXT NOT NULL,
  worker_id TEXT NOT NULL,
  submit_clicked_at TEXT,
  outcome TEXT,
  detail TEXT,
  screenshot_file_id INTEGER REFERENCES files(id) ON DELETE SET NULL,
  html_file_id INTEGER REFERENCES files(id) ON DELETE SET NULL
);
CREATE INDEX idx_attempts_app ON application_attempts(application_id);

CREATE TABLE answers (
  id TEXT PRIMARY KEY,
  category TEXT NOT NULL,
  data_enc TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE prior_applications (
  id INTEGER PRIMARY KEY,
  company TEXT NOT NULL,
  title TEXT NOT NULL,
  company_title_key TEXT NOT NULL,
  applied_at TEXT,
  url TEXT,
  note TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_prior_ctk ON prior_applications(company_title_key);

CREATE TABLE runs (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL,
  trigger TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL DEFAULT 'running',
  summary_json TEXT,
  error TEXT
);

CREATE TABLE events (
  id INTEGER PRIMARY KEY,
  job_id INTEGER REFERENCES jobs(id) ON DELETE CASCADE,
  application_id INTEGER REFERENCES applications(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  message TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_events_job ON events(job_id);
CREATE INDEX idx_events_created ON events(created_at);

CREATE TABLE notifications (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  job_id INTEGER REFERENCES jobs(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  read_at TEXT,
  delivered TEXT NOT NULL DEFAULT '[]',
  delivery_errors TEXT NOT NULL DEFAULT '[]'
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);

CREATE TABLE locks (
  name TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
`,
  },
];

export type Params = Record<string, unknown> | unknown[];

function normalizeValue(v: unknown): SQLInputValue {
  if (v === undefined || v === null) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'number' || typeof v === 'string' || typeof v === 'bigint') return v;
  if (v instanceof Uint8Array) return v;
  if (v instanceof Date) return v.toISOString();
  return JSON.stringify(v);
}

function normalize(params?: Params): SQLInputValue[] | Record<string, SQLInputValue> {
  if (!params) return [];
  if (Array.isArray(params)) return params.map(normalizeValue);
  const out: Record<string, SQLInputValue> = {};
  for (const [k, v] of Object.entries(params)) out[k] = normalizeValue(v);
  return out;
}

export function openDb(file?: string): DatabaseSync {
  const cfg = getConfig();
  const dbPath = file ?? cfg.dbPath;
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const conn = new DatabaseSync(dbPath);
  conn.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA synchronous = NORMAL;');
  migrate(conn);
  if (dbPath !== ':memory:') {
    try {
      fs.chmodSync(dbPath, 0o600);
    } catch {
      /* best effort */
    }
  }
  return conn;
}

function migrate(conn: DatabaseSync): void {
  conn.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
  const applied = new Set(
    (conn.prepare('SELECT version FROM schema_migrations').all() as Array<{ version: number }>).map((r) => r.version),
  );
  for (const m of MIGRATIONS) {
    if (applied.has(m.version)) continue;
    conn.exec('BEGIN IMMEDIATE');
    try {
      conn.exec(m.sql);
      conn.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(m.version, new Date().toISOString());
      conn.exec('COMMIT');
    } catch (err) {
      conn.exec('ROLLBACK');
      throw err;
    }
  }
}

export function initDb(file?: string): DatabaseSync {
  if (db) db.close();
  db = openDb(file);
  return db;
}

export function getDb(): DatabaseSync {
  if (!db) db = openDb();
  return db;
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}

export function run(sql: string, params?: Params): { changes: number; lastInsertRowid: number } {
  const stmt = getDb().prepare(sql);
  const p = normalize(params);
  const res = Array.isArray(p) ? stmt.run(...p) : stmt.run(p);
  return { changes: Number(res.changes), lastInsertRowid: Number(res.lastInsertRowid) };
}

export function get<T = Record<string, unknown>>(sql: string, params?: Params): T | undefined {
  const stmt = getDb().prepare(sql);
  const p = normalize(params);
  const row = Array.isArray(p) ? stmt.get(...p) : stmt.get(p);
  return (row ? { ...row } : undefined) as T | undefined;
}

export function all<T = Record<string, unknown>>(sql: string, params?: Params): T[] {
  const stmt = getDb().prepare(sql);
  const p = normalize(params);
  const rows = Array.isArray(p) ? stmt.all(...p) : stmt.all(p);
  return rows.map((r) => ({ ...r })) as T[];
}

let txDepth = 0;
/** Run fn inside an IMMEDIATE transaction (write lock acquired up front). Nested calls join the outer transaction. */
export function tx<T>(fn: () => T): T {
  const conn = getDb();
  if (txDepth > 0) return fn();
  conn.exec('BEGIN IMMEDIATE');
  txDepth++;
  try {
    const result = fn();
    conn.exec('COMMIT');
    return result;
  } catch (err) {
    try {
      conn.exec('ROLLBACK');
    } catch {
      /* ignore */
    }
    throw err;
  } finally {
    txDepth--;
  }
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string' || value === '') return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

/** Remove every row from every application table (used by "Delete all my data"). */
export function wipeAllTables(): void {
  const conn = getDb();
  conn.exec('PRAGMA foreign_keys = OFF');
  try {
    tx(() => {
      for (const table of [
        'application_attempts',
        'applications',
        'resumes',
        'job_sightings',
        'events',
        'notifications',
        'jobs',
        'files',
        'answers',
        'prior_applications',
        'profile',
        'runs',
        'sources',
        'settings',
        'sessions',
        'locks',
      ]) {
        conn.exec(`DELETE FROM ${table}`);
      }
    });
  } finally {
    conn.exec('PRAGMA foreign_keys = ON');
  }
  conn.exec('VACUUM');
}
