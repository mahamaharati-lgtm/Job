import { closeBrowser } from './applications/browser.js';
import { getConfig, loadConfig } from './config.js';
import { getDataKey } from './crypto.js';
import { closeDb, initDb } from './db.js';
import { buildApp } from './http/app.js';
import { authConfigured } from './http/auth.js';
import { logger, safeErrorMessage } from './logger.js';
import { startScheduler, stopScheduler } from './scheduler.js';
import { seedSourcesIfEmpty } from './sources/registry.js';

/**
 * Entry point. APP_MODE=all (default) runs the dashboard API and the scheduler in one process,
 * which suits a single small server with one persistent disk. APP_MODE=web / APP_MODE=worker split them.
 */

async function main(): Promise<void> {
  const modeArg = process.argv.find((a) => a.startsWith('--mode='))?.split('=')[1];
  const cfg = loadConfig(modeArg ? { APP_MODE: modeArg } : {});
  getDataKey(); // fail fast if the encryption key is missing in production
  initDb();
  const seeded = seedSourcesIfEmpty();
  if (seeded) logger.info(`Seeded ${seeded} starter job sources`);

  if (cfg.isProduction && !authConfigured()) {
    throw new Error('Set ADMIN_PASSWORD or ADMIN_PASSWORD_HASH before running in production.');
  }
  if (!authConfigured()) logger.warn('No ADMIN_PASSWORD set: dashboard login is disabled (development only).');

  let server: Awaited<ReturnType<typeof buildApp>> | null = null;
  if (cfg.APP_MODE === 'all' || cfg.APP_MODE === 'web') {
    server = await buildApp();
    await server.listen({ port: cfg.PORT, host: cfg.HOST });
    logger.info(`Dashboard listening on http://${cfg.HOST}:${cfg.PORT}`);
  }
  if (cfg.APP_MODE === 'all' || cfg.APP_MODE === 'worker') startScheduler();

  const shutdown = async (signal: string) => {
    logger.info(`Received ${signal}, shutting down`);
    stopScheduler();
    await server?.close().catch(() => undefined);
    await closeBrowser();
    closeDb();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  logger.error('Fatal startup error', { error: safeErrorMessage(err) });
  if (!getConfig().isTest) process.exit(1);
});
