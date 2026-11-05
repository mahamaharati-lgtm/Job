import { recoverInterrupted } from './applications/engine.js';
import { sendDigest } from './digest.js';
import { logger, safeErrorMessage } from './logger.js';
import { runPipeline } from './pipeline.js';
import { getSettings, getState, setState } from './settings.js';

/**
 * Persistent scheduler. A one-minute tick decides what is due from timestamps stored in the
 * database, so restarts never skip or double-run work. The same tick can be triggered
 * externally (POST /api/internal/tick with CRON_SECRET) for hosts that sleep when idle.
 */

let timer: NodeJS.Timeout | null = null;
let ticking = false;

function localParts(d: Date, tz: string): { date: string; minutes: number } {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '00';
  return { date: `${get('year')}-${get('month')}-${get('day')}`, minutes: Number(get('hour')) * 60 + Number(get('minute')) };
}

export interface TickResult {
  ranPipeline: boolean;
  sentDigest: boolean;
  skipped?: string;
}

export async function tick(trigger: 'schedule' | 'tick' = 'schedule'): Promise<TickResult> {
  if (ticking) return { ranPipeline: false, sentDigest: false, skipped: 'tick already running' };
  ticking = true;
  const result: TickResult = { ranPipeline: false, sentDigest: false };
  try {
    const { schedule } = getSettings();
    if (!schedule.enabled) return { ...result, skipped: 'schedule disabled' };
    const now = new Date();
    const lastRun = getState<string | null>('lastPipelineAt', null);
    if (!lastRun || now.getTime() - new Date(lastRun).getTime() >= schedule.discoveryEveryHours * 3600_000) {
      setState('lastPipelineAt', now.toISOString());
      await runPipeline({ trigger });
      result.ranPipeline = true;
    }
    const local = localParts(now, schedule.timezone);
    const [h, m] = schedule.digestTime.split(':').map(Number);
    const lastDigestDate = getState<string | null>('lastDigestLocalDate', null);
    if (local.minutes >= h * 60 + m && lastDigestDate !== local.date) {
      setState('lastDigestLocalDate', local.date);
      await sendDigest();
      result.sentDigest = true;
    }
  } catch (err) {
    logger.error('Scheduler tick failed', { error: safeErrorMessage(err) });
  } finally {
    ticking = false;
  }
  return result;
}

export function startScheduler(): void {
  const recovered = recoverInterrupted();
  if (recovered) logger.warn(`Recovered ${recovered} interrupted application attempt(s)`);
  if (timer) return;
  setTimeout(() => void tick(), 15_000).unref();
  timer = setInterval(() => void tick(), 60_000);
  logger.info('Scheduler started (1-minute tick)');
}

export function stopScheduler(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
