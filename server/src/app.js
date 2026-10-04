// The Express app: dashboard (static) + API.
//   /api/worker/*  the Chrome extension — WORKER_KEY
//   /api/auth/*    login / logout / me
//   /api/admin/*   admins only
//   /api/*         logged-in users, limited to their own workspace
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { col, connect, log } from './db.js';
import { authRoutes, loadUser, requireAdmin, requireUser, requireWorker, sameOrigin } from './auth.js';
import routes from './routes.js';
import projectRoutes from './projectRoutes.js';
import adminRoutes from './admin.js';
import workerRoutes from './worker.js';

const here = path.dirname(fileURLToPath(import.meta.url));

// Which extension version is doing the work — written at most every 20 s.
let lastWorkerWrite = 0;
function rememberWorker(req, _res, next) {
  if (Date.now() - lastWorkerWrite > 20000) {
    lastWorkerWrite = Date.now();
    col('settings')
      .updateOne({ _id: 'worker' }, { $set: { version: String(req.get('x-ext-version') || '').slice(0, 20), at: new Date() } }, { upsert: true })
      .catch(() => {});
  }
  next();
}

const dbReady = (_req, res, next) =>
  connect().then(
    () => next(),
    (e) => {
      log('error', `Database: ${e.message}`);
      res.status(503).json({ error: 'The database is not reachable right now. Try again in a minute.' });
    },
  );

function securityHeaders(_req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "font-src 'self' data: https://fonts.gstatic.com",
      "img-src 'self' data: blob: https:",
      "connect-src 'self'",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
    ].join('; '),
  );
  next();
}

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  // requests arrive through Cloudflare Tunnel (a container on the private Docker network) or the local port
  app.set('trust proxy', 'loopback, uniquelocal');
  app.use(securityHeaders);
  app.use(express.json({ limit: '25mb' }));

  app.get('/api/health', (_req, res) => res.json({ ok: true }));
  app.get(['/apps-script.gs', '/api/apps-script.gs'], (_req, res) =>
    res.type('text/plain').sendFile(path.join(here, '..', '..', 'apps-script', 'Code.gs')),
  );

  // the Chrome extension
  app.use('/api/worker', requireWorker, dbReady, rememberWorker, workerRoutes);

  // people
  app.use('/api', dbReady, loadUser, sameOrigin);
  app.use('/api', authRoutes);
  app.use('/api', requireUser);
  app.use('/api/admin', requireAdmin, adminRoutes);
  app.use('/api', routes);
  app.use('/api', projectRoutes);
  app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    const status = err.status || (err.type === 'entity.too.large' ? 413 : err.type === 'entity.parse.failed' ? 400 : 500);
    if (status >= 500) log('error', err.stack || err.message);
    if (res.headersSent) return;
    res.status(status).json({ error: status >= 500 ? 'Something went wrong on the server. It has been logged.' : err.message });
  });

  // the built dashboard
  const dist = path.join(here, '..', '..', 'dashboard', 'dist');
  app.use(express.static(dist, { index: false, maxAge: '1h', setHeaders: (res, p) => /[\\/]assets[\\/]/.test(p) && res.setHeader('Cache-Control', 'public, max-age=31536000, immutable') }));
  app.get(/^(?!\/api).*/, (_req, res) => {
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(path.join(dist, 'index.html'));
  });
  return app;
}
