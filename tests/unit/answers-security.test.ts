import fs from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { parseGreenhouseQuestions, parseLeverForm } from '../../src/server/applications/adapters.js';
import { classifyQuestion, matchOption, resolveAnswers, upsertSavedAnswer, listSavedAnswers } from '../../src/server/applications/answers.js';
import { decryptString, encryptString, hashPassword, verifyPassword } from '../../src/server/crypto.js';
import { getDb } from '../../src/server/db.js';
import { redact } from '../../src/server/logger.js';
import { saveFile, readFile } from '../../src/server/storage.js';
import type { FormQuestion } from '../../src/shared/types.js';
import { fixtureJson, sampleProfile, setupTestEnv, storeSampleProfile } from '../helpers.js';

const env = setupTestEnv();
afterAll(() => env.cleanup());

const ghQuestions = parseGreenhouseQuestions(fixtureJson('greenhouse-questions.json'));
const ctxBase = () => ({ profile: sampleProfile(), bank: listSavedAnswers(), userAnswers: {}, jobCountry: 'IN', jobSource: 'greenhouse', coverLetterPolicy: 'when_required' as const, coverLetterRequired: false });

describe('question classification', () => {
  it.each([
    ['Are you legally authorized to work in India?', 'work_authorization'],
    ['Will you now or in the future require visa sponsorship?', 'sponsorship'],
    ['What are your salary expectations?', 'salary_expectation'],
    ['Expected CTC (LPA)', 'salary_expectation'],
    ['Current CTC', 'current_compensation'],
    ['What is your notice period?', 'notice_period'],
    ['Gender', 'gender'],
    ['Are you a protected veteran?', 'veteran'],
    ['I certify that the information provided is accurate', 'legal_consent'],
    ['How did you hear about us?', 'how_heard'],
  ])('%s → %s', (label, category) => {
    expect(classifyQuestion({ id: 'q', label, type: 'text' })).toEqual({ kind: 'category', category });
  });
  it('detects contact fields and yes/no skill questions', () => {
    expect(classifyQuestion({ id: 'first_name', label: 'First Name', type: 'text' })).toMatchObject({ kind: 'contact', field: 'first_name' });
    expect(classifyQuestion({ id: 'q1', label: 'Do you have experience with TypeScript?', type: 'select' })).toEqual({ kind: 'skill_experience', skill: 'typescript' });
  });
});

describe('answer resolution never guesses sensitive answers', () => {
  it('sends sensitive required questions to Needs input when no saved answer exists', () => {
    const r = resolveAnswers(ghQuestions, ctxBase());
    expect(r.complete).toBe(false);
    expect(r.missing.map((m) => m.label)).toEqual(['Are you legally authorized to work in India?', 'Will you now or in the future require visa sponsorship?']);
    expect(r.missing.every((m) => m.sensitive)).toBe(true);
    // optional voluntary demographic question is left blank, not guessed
    expect(r.answers.find((a) => a.questionId === 'gender')).toMatchObject({ value: null, required: false });
    // contact info comes from the verified profile
    expect(r.answers.find((a) => a.questionId === 'first_name')).toMatchObject({ value: 'Asha', source: 'profile' });
    expect(r.answers.find((a) => a.questionId === 'question_2001')).toMatchObject({ value: 'https://github.com/asharao-example' });
    expect(r.answers.find((a) => a.questionId === 'resume')).toMatchObject({ source: 'resume_file' });
  });

  it('uses saved answers (country-specific first) and maps them onto options', () => {
    upsertSavedAnswer({ category: 'work_authorization', answer: 'Yes', country: 'IN' });
    upsertSavedAnswer({ category: 'work_authorization', answer: 'No', country: 'US' });
    upsertSavedAnswer({ category: 'sponsorship', answer: 'No' });
    upsertSavedAnswer({ category: 'gender', answer: 'Decline to self-identify' });
    const r = resolveAnswers(ghQuestions, ctxBase());
    expect(r.complete).toBe(true);
    expect(r.answers.find((a) => a.questionId === 'question_2002')).toMatchObject({ value: 'Yes', source: 'saved_answer' });
    expect(r.answers.find((a) => a.questionId === 'question_2003')).toMatchObject({ value: 'No' });
    expect(r.answers.find((a) => a.questionId === 'gender')).toMatchObject({ value: 'Decline To Self Identify' });
    const us = resolveAnswers(ghQuestions, { ...ctxBase(), jobCountry: 'US' });
    expect(us.answers.find((a) => a.questionId === 'question_2002')?.value).toBe('No');
  });

  it('marks a saved answer that matches no option as missing instead of picking one', () => {
    expect(matchOption('Maybe later', [{ label: 'Yes', value: '1' }, { label: 'No', value: '0' }])).toBeNull();
    const q: FormQuestion[] = [{ id: 'x', label: 'Are you willing to relocate?', required: true, type: 'select', options: [{ label: 'Yes', value: '1' }, { label: 'No', value: '0' }] }];
    upsertSavedAnswer({ category: 'relocation', answer: 'Only to Pune' });
    const r = resolveAnswers(q, { ...ctxBase(), bank: listSavedAnswers() });
    expect(r.complete).toBe(false);
    expect(r.missing[0].note).toMatch(/does not match any option/);
  });

  it('answers skill yes/no questions only when the skill is in the profile', () => {
    const qs: FormQuestion[] = [
      { id: 'a', label: 'Do you have experience with TypeScript?', required: true, type: 'select', options: [{ label: 'Yes', value: 'y' }, { label: 'No', value: 'n' }] },
      { id: 'b', label: 'Do you have experience with GraphQL?', required: true, type: 'select', options: [{ label: 'Yes', value: 'y' }, { label: 'No', value: 'n' }] },
    ];
    const r = resolveAnswers(qs, ctxBase());
    expect(r.answers[0].value).toBe('Yes');
    expect(r.missing.map((m) => m.questionId)).toEqual(['b']);
  });

  it('parses Lever forms including custom required questions', () => {
    const html = `<form id="application-form"><ul><li class="application-question"><label><div class="application-label">Full name<span class="required">✱</span></div><div class="application-field"><input name="name"></div></label></li></ul>
      <div class="application-additional"><ul><li class="application-question"><div class="application-label"><div class="text">Why us?<span class="required">✱</span></div></div><div class="application-field"><textarea name="cards[c1][field0]"></textarea></div></li></ul></div></form>`;
    const qs = parseLeverForm(html);
    expect(qs).toEqual([
      expect.objectContaining({ id: 'name', label: 'Full name', required: true }),
      expect.objectContaining({ id: 'cards[c1][field0]', label: 'Why us?', required: true, type: 'textarea', section: 'custom' }),
    ]);
  });
});

describe('security', () => {
  it('encrypts and authenticates data (tampering is detected)', () => {
    const enc = encryptString('secret resume text');
    expect(enc).not.toContain('secret');
    expect(decryptString(enc)).toBe('secret resume text');
    const tampered = enc.slice(0, -4) + (enc.endsWith('A') ? 'B' : 'A') + enc.slice(-3);
    expect(() => decryptString(tampered)).toThrow();
  });

  it('hashes passwords with scrypt', () => {
    const h = hashPassword('correct horse');
    expect(verifyPassword('correct horse', h)).toBe(true);
    expect(verifyPassword('wrong', h)).toBe(false);
  });

  it('stores profile, answers and files encrypted at rest', () => {
    storeSampleProfile();
    upsertSavedAnswer({ category: 'salary_expectation', answer: '12 LPA' });
    const id = saveFile('original_resume', 'r.txt', 'text/plain', Buffer.from('asha.rao@example.com'));
    expect(readFile(id).data.toString()).toBe('asha.rao@example.com');
    getDb().exec('PRAGMA wal_checkpoint(TRUNCATE)');
    const dbBytes = fs.readFileSync(path.join(env.dataDir, 'app.db')).toString('latin1');
    expect(dbBytes).not.toContain('asha.rao@example.com');
    expect(dbBytes).not.toContain('12 LPA');
    const filesDir = path.join(env.dataDir, 'files');
    const all = fs.readdirSync(filesDir, { recursive: true }).map(String).filter((f) => f.endsWith('.bin'));
    for (const f of all) expect(fs.readFileSync(path.join(filesDir, f)).toString('latin1')).not.toContain('asha.rao');
  });

  it('redacts emails, phones and tokens from logs', () => {
    const out = redact('mail asha.rao@example.com phone +91 90000 00000 key sk-ant-abcdefghijklmnop password=hunter2');
    expect(out).not.toMatch(/asha\.rao|90000|sk-ant|hunter2/);
  });
});
