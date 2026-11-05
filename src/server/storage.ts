import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { getConfig } from './config.js';
import { decryptBuffer, encryptBuffer, sha256 } from './crypto.js';
import { get, nowIso, run } from './db.js';

/**
 * Encrypted file storage. Every file (original resume, tailored PDFs/DOCX, evidence
 * screenshots) is encrypted with AES-256-GCM before it touches the disk.
 */

export type FileKind =
  | 'original_resume'
  | 'tailored_pdf'
  | 'tailored_docx'
  | 'tailored_txt'
  | 'cover_letter_pdf'
  | 'evidence_png'
  | 'evidence_html'
  | 'manual_evidence';

export interface StoredFile {
  id: number;
  kind: FileKind;
  filename: string;
  mime: string;
  size: number;
  sha256: string;
  path: string;
  created_at: string;
}

function safeName(name: string): string {
  return name.replace(/[^\w.\- ]+/g, '_').slice(0, 120) || 'file';
}

export function saveFile(kind: FileKind, filename: string, mime: string, data: Buffer): number {
  const cfg = getConfig();
  const rel = path.join(new Date().getUTCFullYear().toString(), `${crypto.randomUUID()}.bin`);
  const abs = path.join(cfg.filesDir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, encryptBuffer(data), { mode: 0o600 });
  const res = run(
    `INSERT INTO files (kind, filename, mime, size, sha256, path, created_at)
     VALUES (:kind, :filename, :mime, :size, :sha, :path, :now)`,
    { kind, filename: safeName(filename), mime, size: data.length, sha: sha256(data), path: rel, now: nowIso() },
  );
  return res.lastInsertRowid;
}

export function getFileMeta(id: number): StoredFile | undefined {
  return get<StoredFile>('SELECT * FROM files WHERE id = ?', [id]);
}

export function readFile(id: number): { meta: StoredFile; data: Buffer } {
  const meta = getFileMeta(id);
  if (!meta) throw new Error(`File ${id} not found`);
  const abs = path.join(getConfig().filesDir, meta.path);
  const data = decryptBuffer(fs.readFileSync(abs));
  return { meta, data };
}

export function deleteFile(id: number | null | undefined): void {
  if (!id) return;
  const meta = getFileMeta(id);
  if (!meta) return;
  try {
    fs.rmSync(path.join(getConfig().filesDir, meta.path), { force: true });
  } catch {
    /* already gone */
  }
  run('DELETE FROM files WHERE id = ?', [id]);
}

/** Delete every stored file from disk (used by "Delete all my data"). */
export function wipeAllFiles(): void {
  const cfg = getConfig();
  fs.rmSync(cfg.filesDir, { recursive: true, force: true });
  fs.rmSync(cfg.tmpDir, { recursive: true, force: true });
}
