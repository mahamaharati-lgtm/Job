import type { CandidateProfile, ProfileRecord } from '../../shared/types.js';
import { decryptJson, encryptJson, sha256 } from '../crypto.js';
import { get, nowIso, run } from '../db.js';
import { ensureIds } from './parse.js';

/** The single candidate profile (encrypted at rest). */

interface ProfileRow {
  data_enc: string;
  verified: number;
  verified_at: string | null;
  extraction_method: string;
  warnings: string;
  source_resume_id: number | null;
  updated_at: string;
}

export function getProfileRecord(): ProfileRecord | null {
  const row = get<ProfileRow>('SELECT * FROM profile WHERE id = 1');
  if (!row) return null;
  return {
    profile: ensureIds(decryptJson<CandidateProfile>(row.data_enc)),
    verified: row.verified === 1,
    verifiedAt: row.verified_at,
    updatedAt: row.updated_at,
    sourceResumeId: row.source_resume_id,
    extractionMethod: row.extraction_method as ProfileRecord['extractionMethod'],
    warnings: JSON.parse(row.warnings) as string[],
  };
}

export function getProfile(): CandidateProfile | null {
  return getProfileRecord()?.profile ?? null;
}

/**
 * Save the profile. Any change to its content resets verification, because tailoring and
 * automatic applications may only use facts the user has confirmed.
 */
export function saveProfile(
  profile: CandidateProfile,
  opts: { method?: ProfileRecord['extractionMethod']; warnings?: string[]; sourceResumeId?: number | null; keepVerification?: boolean } = {},
): ProfileRecord {
  const existing = getProfileRecord();
  const clean = ensureIds(profile);
  const changed = !existing || profileHash(existing.profile) !== profileHash(clean);
  const verified = opts.keepVerification && existing?.verified && !changed ? 1 : 0;
  run(
    `INSERT INTO profile (id, data_enc, verified, verified_at, extraction_method, warnings, source_resume_id, updated_at)
     VALUES (1, :data, :verified, :verifiedAt, :method, :warnings, :src, :now)
     ON CONFLICT(id) DO UPDATE SET data_enc = excluded.data_enc, verified = excluded.verified, verified_at = excluded.verified_at,
       extraction_method = excluded.extraction_method, warnings = excluded.warnings,
       source_resume_id = COALESCE(excluded.source_resume_id, profile.source_resume_id), updated_at = excluded.updated_at`,
    {
      data: encryptJson(clean),
      verified,
      verifiedAt: verified ? existing?.verifiedAt ?? nowIso() : null,
      method: opts.method ?? existing?.extractionMethod ?? 'manual',
      warnings: JSON.stringify(opts.warnings ?? existing?.warnings ?? []),
      src: opts.sourceResumeId ?? null,
      now: nowIso(),
    },
  );
  return getProfileRecord()!;
}

export function verifyProfile(): ProfileRecord {
  const rec = getProfileRecord();
  if (!rec) throw new Error('Upload a resume first.');
  run('UPDATE profile SET verified = 1, verified_at = ? WHERE id = 1', [nowIso()]);
  return getProfileRecord()!;
}

/** Stable hash of the factual content (ids excluded) — used to detect stale tailored resumes. */
export function profileHash(p: CandidateProfile): string {
  const strip = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(strip);
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(v).sort()) if (k !== 'id') out[k] = strip((v as Record<string, unknown>)[k]);
      return out;
    }
    return v;
  };
  return sha256(JSON.stringify(strip(p))).slice(0, 16);
}

/** Months of experience between ISO months (inclusive), merging overlaps. */
export function experienceYears(profile: CandidateProfile, opts: { excludeInternships?: boolean; now?: Date } = {}): number {
  const now = opts.now ?? new Date();
  const nowIdx = now.getUTCFullYear() * 12 + now.getUTCMonth();
  const ranges: Array<[number, number]> = [];
  for (const e of profile.experience) {
    if (opts.excludeInternships && /\bintern(ship)?\b|trainee|apprentice/i.test(e.title)) continue;
    const s = e.startDate.match(/^(\d{4})-(\d{2})$/);
    if (!s) continue;
    const start = Number(s[1]) * 12 + Number(s[2]) - 1;
    const en = e.endDate?.match(/^(\d{4})-(\d{2})$/);
    const end = en ? Number(en[1]) * 12 + Number(en[2]) - 1 : nowIdx;
    if (end >= start) ranges.push([start, Math.min(end, nowIdx)]);
  }
  ranges.sort((a, b) => a[0] - b[0]);
  let months = 0;
  let curS = -1;
  let curE = -2;
  for (const [s, e] of ranges) {
    if (s > curE + 1) {
      if (curE >= curS && curS >= 0) months += curE - curS + 1;
      curS = s;
      curE = e;
    } else curE = Math.max(curE, e);
  }
  if (curS >= 0) months += curE - curS + 1;
  return Math.round((months / 12) * 10) / 10;
}
