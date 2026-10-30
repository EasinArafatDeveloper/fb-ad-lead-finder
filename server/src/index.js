// Server entry: `node src/index.js` (in Docker: see Dockerfile / docker-compose.yml).
import { createApp } from './app.js';
import { col, connect, log } from './db.js';
import { autoSyncAll } from './sheets.js';
import { kickServerReader } from './serverReader.js';
import { kickAdlibCollector, resetServerCollects } from './adlibCollector.js';
import { janitor, resetServerClaims } from './pageQueue.js';
import { closeStaleCollects } from './worker.js';
import { notifyFinishedSearches } from './notify.js';
import { chargeReadPages, ensurePlans, expirePlans, migrateBilling } from './billing.js';

const PORT = Number(process.env.PORT) || 4000;
for (const k of ['MONGODB_URI', 'WORKER_KEY']) {
  if (!process.env[k]) {
    console.error(`${k} is not set (see .env.example)`);
    process.exit(1);
  }
}

connect()
  .then(async () => {
    createApp().listen(PORT, () => console.log(`FB Ad Lead Finder: http://localhost:${PORT}  (TZ=${process.env.TZ || 'system'})`));
    if (!(await col('users').countDocuments({}))) {
      console.log('No users yet — create the first admin:  docker compose exec app node src/create-admin.js you@example.com "Your Name"');
    }
    // Google Sheet auto-sync every 5 minutes (workspaces that turned it on)
    setInterval(() => autoSyncAll().catch((e) => log('warn', `Auto-sync: ${e.message}`)), 5 * 60 * 1000);
    // pages the server was reading when it stopped go straight back to the queue (docs/ENGINE.md §4 #6)
    const back = await resetServerClaims();
    if (back) log('info', `Server start: ${back} pages that were being read went back to the queue`);
    const backJobs = await resetServerCollects();
    if (backJobs) log('info', `Server start: ${backJobs} searches that were collecting on the server went back to the queue`);
    // searches queued → collect them in the background on the server through the proxy pool
    setInterval(() => kickAdlibCollector().catch((e) => log('warn', `Adlib collector: ${e.message}`)), 4000);
    // pages queued → read them on the server through the proxy list (picks up new pages within 5 s)
    setInterval(() => kickServerReader().catch((e) => log('warn', `Server reader: ${e.message}`)), 5000);
    // self-healing: lost pages back to the queue, pages Chrome never read given up (§4 #7, #8)
    setInterval(() => janitor().catch((e) => log('warn', `Janitor: ${e.message}`)), 60 * 1000);
    // an Ad Library tab that went silent ends its search with what arrived (§4 #10)
    setInterval(() => closeStaleCollects().catch((e) => log('warn', `Stale searches: ${e.message}`)), 30 * 1000);
    // a search fully done (ads collected, every page read) → email + push to its workspace (notify.js)
    setInterval(() => notifyFinishedSearches().catch((e) => log('warn', `Notifications: ${e.message}`)), 30 * 1000);
    // billing: plans exist, old data is free, the team is unlimited (once); then 1 credit per page read, every 10 s
    await ensurePlans();
    await migrateBilling();
    setInterval(() => chargeReadPages().catch((e) => log('warn', `Credits: ${e.message}`)), 10 * 1000);
    setInterval(() => expirePlans().catch((e) => log('warn', `Plans: ${e.message}`)), 60 * 60 * 1000);
  })
  .catch((e) => {
    console.error('MongoDB connect failed:', e.message);
    process.exit(1);
  });
