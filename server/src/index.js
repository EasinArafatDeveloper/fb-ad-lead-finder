// Server entry: `node src/index.js` (in Docker: see Dockerfile / docker-compose.yml).
import { createApp } from './app.js';
import { col, connect, log } from './db.js';
import { autoSyncAll } from './sheets.js';

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
  })
  .catch((e) => {
    console.error('MongoDB connect failed:', e.message);
    process.exit(1);
  });
