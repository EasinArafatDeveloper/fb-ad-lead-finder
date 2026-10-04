// The Express app — used by both the local server (index.js) and Vercel (api/index.mjs).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import cors from 'cors';
import express from 'express';
import { col, connect, log } from './db.js';
import routes from './routes.js';
import projectRoutes from './projectRoutes.js';
import { migrateProjects } from './projects.js';
import { getSettings } from './settings.js';
import { syncSheet } from './sheets.js';

const here = path.dirname(fileURLToPath(import.meta.url));
// local: server/.env — on Vercel the variables come from the project settings
if (fs.existsSync(path.join(here, '..', '.env'))) dotenv.config({ path: path.join(here, '..', '.env') });

let migrated = null;
/** Connect to MongoDB (once) and run the one-time data migration (once per instance). */
export async function ensureReady() {
  await connect();
  if (!migrated) migrated = migrateProjects().catch((e) => ((migrated = null), Promise.reject(e)));
  await migrated;
}

// Which extension version is doing the work — kept in MongoDB (not memory) so it survives
// Vercel's short-lived instances. Written at most every 20 s per instance.
let lastWorkerWrite = 0;
function rememberWorker(version) {
  if (Date.now() - lastWorkerWrite < 20000) return;
  lastWorkerWrite = Date.now();
  col('settings')
    .updateOne({ _id: 'worker' }, { $set: { version: version || '', at: new Date() } }, { upsert: true })
    .catch(() => {});
}

export function createApp({ serveDashboard = true } = {}) {
  const API_KEY = process.env.API_KEY;
  const app = express();
  app.use(cors());
  app.use(express.json({ limit: '50mb' }));

  app.get('/api/health', (_req, res) => res.json({ ok: true }));

  app.get(['/apps-script.gs', '/api/apps-script.gs'], (_req, res) =>
    res.type('text/plain').sendFile(path.join(here, '..', '..', 'apps-script', 'Code.gs')),
  );

  // Vercel Cron calls this (daily on the free plan) — replaces the local 5-minute timer
  app.get('/api/cron/sync', async (req, res) => {
    if (!process.env.CRON_SECRET || req.get('authorization') !== `Bearer ${process.env.CRON_SECRET}`) return res.status(401).end();
    try {
      await ensureReady();
      const s = await getSettings();
      if (!s.autoSync || !s.sheetUrl) return res.json({ skipped: true });
      res.json(await syncSheet(false));
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.use('/api', async (req, res, next) => {
    if (!API_KEY) return res.status(500).json({ error: 'API_KEY is not set on the server' });
    const key = req.get('x-api-key') || req.query.key;
    if (key !== API_KEY) return res.status(401).json({ error: 'Wrong API key' });
    try {
      await ensureReady();
    } catch (e) {
      return res.status(503).json({ error: `Could not connect to the database: ${e.message}` });
    }
    if (req.path.startsWith('/worker/')) rememberWorker(req.get('x-ext-version'));
    next();
  });
  app.use('/api', routes);
  app.use('/api', projectRoutes);

  app.use((err, _req, res, _next) => {
    log('error', err.stack || err.message);
    res.status(500).json({ error: err.message || 'Server error' });
  });

  if (serveDashboard) {
    // local only — on Vercel the built dashboard is served as static files
    const dist = path.join(here, '..', '..', 'dashboard', 'dist');
    app.use(express.static(dist));
    app.get(/^(?!\/api).*/, (_req, res) => res.sendFile(path.join(dist, 'index.html')));
  }
  return app;
}
