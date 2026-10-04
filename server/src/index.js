// Local server (start-server.bat / npm start). On Vercel, api/index.mjs uses the same app.
import { createApp, ensureReady } from './app.js';
import { log } from './db.js';
import { getSettings } from './settings.js';
import { syncSheet } from './sheets.js';

const PORT = Number(process.env.PORT) || 4000;
if (!process.env.MONGODB_URI || !process.env.API_KEY) {
  console.error('Set MONGODB_URI and API_KEY in server/.env');
  process.exit(1);
}

ensureReady()
  .then(() => {
    createApp({ serveDashboard: true }).listen(PORT, () => console.log(`FB Ad Lead Finder server: http://localhost:${PORT}`));
    // Auto-sync to Google Sheet every 5 minutes (if enabled in Settings)
    setInterval(async () => {
      try {
        const s = await getSettings();
        if (s.autoSync && s.sheetUrl) await syncSheet(false);
      } catch (e) {
        log('warn', `Auto-sync: ${e.message}`);
      }
    }, 5 * 60 * 1000);
  })
  .catch((e) => {
    console.error('MongoDB connect failed:', e.message);
    console.error('Check that your IP (or 0.0.0.0/0) is allowed in Atlas → Network Access.');
    process.exit(1);
  });
