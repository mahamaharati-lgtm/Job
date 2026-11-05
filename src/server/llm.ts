import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import { z } from 'zod';
import type { CandidateProfile } from '../shared/types.js';
import { getConfig } from './config.js';
import { logger, safeErrorMessage } from './logger.js';

/**
 * Optional Claude integration. Every function returns null when the API key is missing,
 * the request fails, or the model declines — callers then use the deterministic path.
 * All model output is validated with Zod and then fact-checked by the caller.
 */

let client: Anthropic | null = null;

export function llmAvailable(): boolean {
  return getConfig().llmEnabled;
}

function getClient(): Anthropic {
  if (!client) client = new Anthropic({ apiKey: getConfig().ANTHROPIC_API_KEY, timeout: 120_000, maxRetries: 2 });
  return client;
}

async function structured<T extends z.ZodType>(schema: T, system: string, user: string, maxTokens = 16_000): Promise<z.infer<T> | null> {
  if (!llmAvailable()) return null;
  const cfg = getConfig();
  try {
    const response = await getClient().beta.messages.parse({
      model: cfg.ANTHROPIC_MODEL,
      max_tokens: maxTokens,
      // Server-side fallback: if the model declines for policy reasons, the API retries on its default fallback.
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { format: betaZodOutputFormat(schema), effort: cfg.ANTHROPIC_EFFORT },
      system,
      messages: [{ role: 'user', content: user }],
    });
    if (response.stop_reason === 'refusal') {
      logger.warn('LLM declined the request; using deterministic fallback');
      return null;
    }
    if (response.stop_reason === 'max_tokens') {
      logger.warn('LLM output truncated; using deterministic fallback');
      return null;
    }
    return (response.parsed_output as z.infer<T> | null) ?? null;
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) logger.error('Anthropic API key rejected; LLM features disabled for this call');
    else if (err instanceof Anthropic.RateLimitError) logger.warn('Anthropic rate limit hit; using deterministic fallback');
    else if (err instanceof Anthropic.APIError) logger.warn('Anthropic API error', { status: err.status, message: safeErrorMessage(err) });
    else logger.warn('LLM call failed', { message: safeErrorMessage(err) });
    return null;
  }
}

// ---------------------------------------------------------------------------
// 1. Profile extraction
// ---------------------------------------------------------------------------
const LinkZ = z.object({ label: z.string(), url: z.string() });
const BulletZ = z.object({ id: z.string(), text: z.string() });
const ProfileZ = z.object({
  name: z.string(),
  headline: z.string(),
  email: z.string(),
  phone: z.string(),
  location: z.string(),
  links: z.array(LinkZ),
  summary: z.string(),
  skillGroups: z.array(z.object({ name: z.string(), skills: z.array(z.string()) })),
  experience: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      company: z.string(),
      location: z.string().optional(),
      startDate: z.string().describe('YYYY-MM'),
      endDate: z.string().nullable().describe('YYYY-MM or null when the role is current'),
      bullets: z.array(BulletZ),
    }),
  ),
  projects: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      subtitle: z.string().optional(),
      technologies: z.array(z.string()),
      links: z.array(LinkZ),
      bullets: z.array(BulletZ),
    }),
  ),
  education: z.array(
    z.object({ id: z.string(), degree: z.string(), institution: z.string(), dates: z.string().optional(), grade: z.string().optional(), details: z.array(z.string()) }),
  ),
  certifications: z.array(z.object({ id: z.string(), name: z.string(), issuer: z.string().optional(), date: z.string().optional() })),
  additional: z.array(z.object({ id: z.string(), title: z.string(), items: z.array(z.string()) })),
});

const EXTRACTION_SYSTEM = `You convert resume text into structured JSON for a job-application tool.
Copy facts exactly as written. Do not add, infer, embellish or summarize skills, achievements, dates, metrics or employers.
Keep bullet text verbatim (only rejoin lines that were wrapped). If a field is not present in the resume, use an empty string or empty array.
Dates: convert to YYYY-MM; use null for "Present". Give every list item a short unique id.`;

export async function extractProfileWithLlm(resumeText: string): Promise<CandidateProfile | null> {
  const out = await structured(ProfileZ, EXTRACTION_SYSTEM, `Resume text:\n<resume>\n${resumeText}\n</resume>`);
  return out ? ({ ...out, experience: out.experience.map((e) => ({ ...e, endDate: e.endDate ?? null })) } as CandidateProfile) : null;
}

// ---------------------------------------------------------------------------
// 2. Bullet rephrasing for a specific job (validated by the fact-checker afterwards)
// ---------------------------------------------------------------------------
const RewriteZ = z.object({
  summary: z.string().describe('Rewritten professional summary using only facts from the profile'),
  bullets: z.array(z.object({ id: z.string(), text: z.string() })),
});

const REWRITE_SYSTEM = `You tailor a candidate's resume wording to a job description WITHOUT changing any facts.
Rules (a strict automated fact-checker rejects any violation):
- Rephrase only. Each output bullet must state the same facts as the input bullet with the same id.
- Never add technologies, tools, numbers, metrics, percentages, employers, titles, dates, team sizes or outcomes that are not in that bullet.
- Never upgrade scope (no "led", "managed", "owned", "architected", "spearheaded" unless the input says so).
- You may reorder clauses and use the job's terminology for things the bullet already describes.
- Keep each bullet about the same length as the original. Keep it in English, past tense where the original is.
- The summary may only use facts present anywhere in the profile, and must not claim skills that are not listed in it.`;

export async function rewriteForJob(input: {
  profile: CandidateProfile;
  jobTitle: string;
  company: string;
  jobText: string;
  matchedKeywords: string[];
}): Promise<z.infer<typeof RewriteZ> | null> {
  const bullets = [
    ...input.profile.experience.flatMap((e) => e.bullets.map((b) => ({ id: b.id, context: `${e.title} at ${e.company}`, text: b.text }))),
    ...input.profile.projects.flatMap((p) => p.bullets.map((b) => ({ id: b.id, context: `Project: ${p.name} (technologies: ${p.technologies.join(', ')})`, text: b.text }))),
  ];
  const user = `Job: ${input.jobTitle} at ${input.company}
Keywords from the job that the candidate genuinely has: ${input.matchedKeywords.join(', ') || '(none)'}

Job description (truncated):
<job>
${input.jobText.slice(0, 6000)}
</job>

Candidate profile (the only source of facts):
<profile>
${JSON.stringify({ headline: input.profile.headline, summary: input.profile.summary, skills: input.profile.skillGroups, experience: input.profile.experience.map((e) => ({ title: e.title, company: e.company, start: e.startDate, end: e.endDate })), education: input.profile.education }, null, 1)}
</profile>

Bullets to rephrase (return every id exactly once):
<bullets>
${JSON.stringify(bullets, null, 1)}
</bullets>`;
  return structured(RewriteZ, REWRITE_SYSTEM, user);
}

// ---------------------------------------------------------------------------
// 3. Cover letter
// ---------------------------------------------------------------------------
const CoverZ = z.object({ body: z.string().describe('Cover letter body paragraphs without greeting or signature') });

const COVER_SYSTEM = `You write concise, sincere cover letters (150-220 words, 3 short paragraphs) for a job application.
Only use facts from the candidate profile. Never invent experience, years of experience, metrics, employers, skills or achievements,
and never claim skills the profile does not list. Do not mention salary, visa or personal circumstances. No greeting and no signature.`;

export async function coverLetterWithLlm(input: { profile: CandidateProfile; jobTitle: string; company: string; jobText: string; matchedKeywords: string[] }): Promise<string | null> {
  const user = `Job: ${input.jobTitle} at ${input.company}
Relevant keywords the candidate genuinely has: ${input.matchedKeywords.join(', ')}
<job>
${input.jobText.slice(0, 5000)}
</job>
<profile>
${JSON.stringify(input.profile, null, 1)}
</profile>`;
  const out = await structured(CoverZ, COVER_SYSTEM, user, 4000);
  return out?.body?.trim() || null;
}
