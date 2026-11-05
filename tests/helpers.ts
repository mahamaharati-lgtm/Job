import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/server/config.js';
import { resetDataKeyCache } from '../src/server/crypto.js';
import { closeDb, initDb } from '../src/server/db.js';
import { parseResumeText } from '../src/server/profile/parse.js';
import { getProfileRecord, saveProfile, verifyProfile } from '../src/server/profile/store.js';
import type { CandidateProfile, SearchPreferences } from '../src/shared/types.js';
import { defaultPreferences } from '../src/server/settings.js';

export const ROOT = path.resolve(import.meta.dirname, '..');
export const FIXTURES = path.join(ROOT, 'tests', 'fixtures');

/** Read a fixture; date placeholders become "now" so tests never go stale. */
export function fixture(name: string): string {
  const now = Date.now() - 3600_000;
  return fs
    .readFileSync(path.join(FIXTURES, name), 'utf8')
    .replaceAll('"__NOW_MS__"', String(now))
    .replaceAll('"__NOW_S__"', String(Math.floor(now / 1000)))
    .replaceAll('__NOW_ISO__', new Date(now).toISOString());
}

export function fixtureJson<T = unknown>(name: string): T {
  return JSON.parse(fixture(name)) as T;
}

/** Fresh config + database in a temporary directory for each test file. */
export function setupTestEnv(extra: Record<string, string> = {}): { dataDir: string; cleanup: () => void } {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'job-autopilot-test-'));
  loadConfig({ NODE_ENV: 'test', DATA_DIR: dataDir, APP_ROOT: ROOT, ANTHROPIC_API_KEY: '', ...extra } as never);
  resetDataKeyCache();
  initDb();
  return {
    dataDir,
    cleanup: () => {
      closeDb();
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

export function sampleProfile(): CandidateProfile {
  return parseResumeText(fixture('resume-sample.txt')).profile;
}

export function storeSampleProfile(verified = true): CandidateProfile {
  const p = sampleProfile();
  saveProfile(p, { method: 'heuristic' });
  if (verified) verifyProfile();
  return getProfileRecord()!.profile;
}

export function indiaPrefs(over: Partial<SearchPreferences> = {}): SearchPreferences {
  return {
    ...defaultPreferences(),
    locations: ['Pune'],
    country: 'IN',
    remoteRegions: ['India', 'APAC', 'Asia', 'Worldwide', 'Anywhere', 'Global'],
    ...over,
  };
}
