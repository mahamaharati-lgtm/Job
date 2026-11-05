import fs from 'node:fs';
import { closeBrowser } from './applications/browser.js';
import { loadConfig } from './config.js';
import { hashPassword, randomToken } from './crypto.js';
import { closeDb, initDb, wipeAllTables } from './db.js';
import { buildDigest, renderDigest, sendDigest } from './digest.js';
import { importJobs } from './importer.js';
import { runPipeline, scoreJobs, type PipelineStep } from './pipeline.js';
import { ingestResume } from './resumes.js';
import { verifyProfile } from './profile/store.js';
import { seedSourcesIfEmpty } from './sources/registry.js';
import { wipeAllFiles } from './storage.js';

/**
 * Command-line tools:
 *   gen-key                     print a new DATA_ENCRYPTION_KEY / CRON_SECRET
 *   hash-password <password>    print ADMIN_PASSWORD_HASH
 *   run [steps...] [--force]    run the pipeline once (steps: discover score tailor prepare apply)
 *   upload-resume <file>        extract a profile from a resume file
 *   verify-profile              mark the extracted profile as verified
 *   import <jobs.json>          import jobs ({"jobs":[...]} or [...])
 *   digest [--send]             print (or send) the daily digest
 *   delete-all-data --yes       wipe the database and stored files
 */

const help = `Usage: npm run cli -- <command>
  gen-key | hash-password <pw> | run [discover|score|tailor|prepare|apply ...] [--force]
  upload-resume <file> | verify-profile | import <jobs.json> | digest [--send] | delete-all-data --yes`;

async function main(): Promise<void> {
  const [cmd, ...args] = process.argv.slice(2);
  if (cmd === 'gen-key') {
    console.log(`DATA_ENCRYPTION_KEY=${randomToken(32)}\nCRON_SECRET=${randomToken(24)}`);
    return;
  }
  if (cmd === 'hash-password') {
    if (!args[0]) throw new Error('Usage: hash-password <password>');
    console.log(`ADMIN_PASSWORD_HASH='${hashPassword(args[0])}'`);
    return;
  }
  loadConfig();
  initDb();
  seedSourcesIfEmpty();
  switch (cmd) {
    case 'run': {
      const steps = args.filter((a) => !a.startsWith('--')) as PipelineStep[];
      const res = await runPipeline({ trigger: 'cli', steps: steps.length ? steps : undefined, force: args.includes('--force') });
      console.log(JSON.stringify(res, null, 2));
      break;
    }
    case 'upload-resume': {
      const file = args[0];
      if (!file) throw new Error('Usage: upload-resume <file>');
      const ext = file.toLowerCase().split('.').pop();
      const mime = ext === 'pdf' ? 'application/pdf' : ext === 'docx' ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' : 'text/plain';
      const res = await ingestResume(fs.readFileSync(file), file.split('/').pop()!, mime);
      console.log(`Profile extracted (${res.method}). Warnings:\n- ${res.warnings.join('\n- ') || 'none'}\nReview it in the dashboard, then verify.`);
      break;
    }
    case 'verify-profile':
      verifyProfile();
      scoreJobs({ all: true });
      console.log('Profile verified.');
      break;
    case 'import': {
      const raw = JSON.parse(fs.readFileSync(args[0], 'utf8')) as unknown;
      const items = Array.isArray(raw) ? raw : ((raw as { jobs?: unknown[] }).jobs ?? []);
      const res = importJobs(items, 'import');
      scoreJobs({ jobIds: res.ids });
      console.log(JSON.stringify({ ...res, ids: undefined }, null, 2));
      break;
    }
    case 'digest':
      if (args.includes('--send')) await sendDigest();
      console.log(renderDigest(buildDigest()).text);
      break;
    case 'delete-all-data':
      if (!args.includes('--yes')) throw new Error('Add --yes to confirm deleting all data');
      wipeAllTables();
      wipeAllFiles();
      console.log('All data deleted.');
      break;
    default:
      console.log(help);
  }
  await closeBrowser();
  closeDb();
}

main().catch((err) => {
  console.error((err as Error).message);
  process.exit(1);
});
