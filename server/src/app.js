// The Express app: dashboard (static) + API.
//   /api/worker/*  the Chrome extension — WORKER_KEY
//   /api/auth/*    login / logout / me
//   /api/admin/*   admins only
//   /api/*         logged-in users, limited to their own workspace
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { col, connect, log } from './db.js';
import { authRoutes, loadUser, requireAdmin, requireUser, requireVerified, requireWorker, sameOrigin } from './auth.js';
import routes from './routes.js';
import projectRoutes from './projectRoutes.js';
import adminRoutes from './admin.js';
import workerRoutes from './worker.js';
import { touchPc } from './pcs.js';
import { publicRoutes, userRoutes as billingUserRoutes } from './billingRoutes.js';

const here = path.dirname(fileURLToPath(import.meta.url));

// Which extension versions are doing the work (several PCs can run one) — each version's last contact,
// written at most every 20 s per version.
const lastWorkerWrite = new Map();
function rememberWorker(req, _res, next) {
  const version = String(req.get('x-ext-version') || 'old').slice(0, 20).replace(/[^0-9A-Za-z.-]/g, '') || 'old';
  req.pcId = touchPc(req, version); // which computer (pcs.js)
  if (Date.now() - (lastWorkerWrite.get(version) || 0) > 20000) {
    lastWorkerWrite.set(version, Date.now());
    const at = new Date();
    const key = version.replace(/\./g, '_');
    // where it runs: this server's own PC (localhost) or another PC over the internet (through the tunnel)
    const via = req.get('cf-connecting-ip') ? `internet (${req.get('host') || 'domain'})` : 'this PC (localhost)';
    // which computer: its internet address and browser — to find the PC that runs a search nobody sees
    const ip = String(req.get('cf-connecting-ip') || req.ip || '').slice(0, 60);
    const ua = String(req.get('user-agent') || '').slice(0, 200);
    col('settings')
      .updateOne({ _id: 'worker' }, { $set: { version, at, [`seen.${key}`]: at, [`via.${key}`]: via, [`ip.${key}`]: ip, [`ua.${key}`]: ua } }, { upsert: true })
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

// A saved workbook can be hundreds of MB once unpacked. Only a logged-in user may send one, and only a few are
// unpacked at the same time (the others wait their turn) — so a burst of big saves can't run the server out of memory.
const SHEET_SAVES_AT_ONCE = 3;
const SHEET_SAVES_WAITING = 50;
function sheetSaveGate() {
  let running = 0;
  const waiting = [];
  const done = () => {
    running--;
    const next = waiting.shift();
    if (next) next();
  };
  return (req, res, next) => {
    if (['GET', 'HEAD'].includes(req.method)) return next();
    const go = () => {
      // the browser gave up while waiting: no turn taken, the next one goes
      if (res.destroyed || req.socket?.destroyed) {
        const after = waiting.shift();
        if (after) after();
        return;
      }
      running++;
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        done();
      };
      res.on('finish', release);
      res.on('close', release);
      next();
    };
    if (running < SHEET_SAVES_AT_ONCE) return go();
    if (waiting.length >= SHEET_SAVES_WAITING) return res.status(503).json({ error: 'The server is busy saving sheets. Try again in a minute.' });
    waiting.push(go);
  };
}

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  // requests arrive through Cloudflare Tunnel (a container on the private Docker network) or the local port
  app.set('trust proxy', 'loopback, uniquelocal');
  app.use(securityHeaders);
  // big bodies only where they are needed: a saved workbook and the ads the extension sends
  // a workbook has no size limit: the browser sends it gzipped, this is the size once unpacked
  // the login is checked BEFORE the big body is read (a stranger can't make the server unpack 400 MB)
  app.use('/api/sheets', dbReady, loadUser, sameOrigin, requireUser, requireVerified, sheetSaveGate(), express.json({ limit: '400mb' }));
  app.use(['/api/worker', '/api/dev'], express.json({ limit: '25mb' }));
  app.use(express.json({ limit: '1mb' }));

  app.get('/api/health', (_req, res) => res.json({ ok: true }));
  app.get(['/apps-script.gs', '/api/apps-script.gs'], (_req, res) =>
    res.type('text/plain').sendFile(path.join(here, '..', '..', 'apps-script', 'Code.gs')),
  );

  // the Chrome extension
  app.use('/api/worker', requireWorker, dbReady, rememberWorker, workerRoutes);

  // anybody: the plans for the pricing page, payment webhooks
  app.use('/api/public', dbReady, publicRoutes);

  // people
  app.use('/api', dbReady, loadUser, sameOrigin);
  app.use('/api', authRoutes);
  app.use('/api', requireUser);
  app.use('/api', requireVerified); // a new account: only the code page until the email is confirmed
  app.use('/api/admin', requireAdmin, adminRoutes);
  app.use('/api', billingUserRoutes);
  app.use('/api', routes);
  app.use('/api', projectRoutes);
  app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    const status = err.status || (err.type === 'entity.too.large' ? 413 : err.type === 'entity.parse.failed' ? 400 : 500);
    if (status >= 500) log('error', err.stack || err.message);
    if (res.headersSent) return res.destroy(); // a download that broke halfway — end it, don't leave it hanging
    res.status(status).json({ error: status >= 500 ? 'Something went wrong on the server. It has been logged.' : err.message });
  });

  // the built dashboard
  const dist = path.join(here, '..', '..', 'dashboard', 'dist');
  app.use(
    express.static(dist, {
      index: false,
      maxAge: '1h',
      setHeaders: (res, p) => {
        if (/[\\/]assets[\\/]/.test(p)) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        else if (/[\\/]sw\.js$/.test(p)) res.setHeader('Cache-Control', 'no-cache'); // the push service worker updates at once
        else if (/[\\/]downloads[\\/]/.test(p)) res.setHeader('Cache-Control', 'no-cache'); // always the latest extension
        else if (/[\\/]sitemap\.xml$/i.test(p)) res.setHeader('Content-Type', 'application/xml; charset=utf-8');
        else if (/[\\/]robots\.txt$/i.test(p)) res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        else if (/[\\/]site\.webmanifest$/i.test(p)) res.setHeader('Content-Type', 'application/manifest+json; charset=utf-8');
      },
    }),
  );
  app.get(/^(?!\/api).*/, (_req, res) => {
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(path.join(dist, 'index.html'));
  });
  return app;
}
