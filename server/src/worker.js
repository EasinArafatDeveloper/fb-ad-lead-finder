// API for the Chrome extension (the worker). Mounted at /api/worker, authenticated with WORKER_KEY.
// There is one worker for everybody: it takes searches from every workspace (oldest first) and reads
// each Facebook page once; the result is copied into every workspace that has that page.
import express from 'express';
import { activity, col, log, pageActivity } from './db.js';
import { getSettings, updateSettings } from './settings.js';
import { applyResult, ingestAds, syncLeads } from './leads.js';
import { ensureProject, oid } from './projects.js';
import { workerInfo } from './worker-state.js';
import { aboutUrl, mainUrl, startOfToday, uniq } from './util.js';

const r = express.Router();
const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).then((out) => out !== undefined && !res.headersSent && res.json(out)).catch(next);

const STALE_COLLECT_MS = 10 * 60 * 1000;
const STALE_WORK_MS = 5 * 60 * 1000;

/** Page visits today — failed attempts count too, Facebook saw them. */
const visitsToday = () => col('pages').countDocuments({ lastAttemptAt: { $gte: startOfToday() } });

/** Manual "Collect this search" from the Ad Library panel goes to the first admin's workspace. */
async function operatorWorkspace() {
  const u = await col('users').findOne({ role: 'admin', disabled: { $ne: true } }, { sort: { createdAt: 1 }, projection: { workspaceId: 1 } });
  return u?.workspaceId || null;
}

// popup: overall numbers
r.get('/status', ah(async () => {
  const s = await getSettings();
  const [pages, pending, doneToday, queuedJobs, collecting] = await Promise.all([
    col('pages').countDocuments({}),
    col('pages').countDocuments({ scrapeStatus: { $in: ['pending', 'working'] } }),
    visitsToday(),
    col('jobs').countDocuments({ phase: 'queued' }),
    col('jobs').countDocuments({ phase: 'collecting' }),
  ]);
  return {
    pages, pending, doneToday, dailyLimit: s.dailyLimit, queuedJobs, collecting, running: s.running, pausedReason: s.pausedReason, worker: await workerInfo(),
    proxy: { enabled: Boolean(s.proxyEnabled), host: s.proxyHost || '', port: Number(s.proxyPort) || 44445, user: s.proxyUser || '', pass: s.proxyPass || '' },
  };
}));

r.get('/next-collect', ah(async () => {
  const s = await getSettings();
  if (!s.running) return { job: null, reason: s.pausedReason || 'paused' };
  const now = new Date();
  await col('jobs').updateMany(
    { phase: 'collecting', lastActivity: { $lt: new Date(Date.now() - STALE_COLLECT_MS) } },
    { $set: { phase: 'collected', collectedAt: now, note: 'timeout' } },
  );
  if (await col('jobs').findOne({ phase: 'collecting', manual: { $ne: true } })) return { job: null, reason: 'busy' };
  const j = await col('jobs').findOneAndUpdate(
    { phase: 'queued' },
    { $set: { phase: 'collecting', startedAt: now, lastActivity: now } },
    { sort: { createdAt: 1 }, returnDocument: 'after' },
  );
  if (!j) return { job: null, reason: 'no-jobs' };
  await activity('collect', `Opened the Ad Library: "${j.keyword}" — collecting ads`, { workspaceId: j.workspaceId, projectId: j.projectId });
  return { job: { id: String(j._id), keyword: j.keyword, country: j.country, maxAds: j.maxAds || s.maxAds, minAds: j.minAds || 1, url: j.url }, closeAdTab: s.closeAdTab };
}));

r.post('/manual-job', ah(async (req, res) => {
  const ws = await operatorWorkspace();
  if (!ws) return res.status(409).json({ error: 'Create an admin account on the server first' });
  const b = req.body || {};
  const s = await getSettings();
  const now = new Date();
  const keyword = String(b.keyword || '').trim().slice(0, 200) || '(page search)';
  const country = String(b.country || 'ALL').toUpperCase().slice(0, 5);
  const doc = {
    workspaceId: ws, keyword, country, maxAds: Number(b.maxAds) || s.maxAds, minAds: Math.max(1, Number(b.minAds) || 1),
    projectId: await ensureProject(ws, keyword, country), url: String(b.url || '').slice(0, 2000), phase: 'collecting', manual: true,
    adsSeen: 0, pageIds: [], createdAt: now, startedAt: now, lastActivity: now,
  };
  const { insertedId } = await col('jobs').insertOne(doc);
  await activity('collect', `Manual collect from the Ad Library: "${keyword}"`, { workspaceId: ws, projectId: doc.projectId });
  return { job: { id: String(insertedId), keyword: doc.keyword, country: doc.country, maxAds: doc.maxAds, minAds: doc.minAds, url: doc.url, manual: true } };
}));

r.post('/ads', ah(async (req, res) => {
  const { jobId, ads } = req.body || {};
  const job = await col('jobs').findOne({ _id: oid(jobId) });
  if (!job) return res.status(404).json({ error: 'Job not found' });
  if (job.phase === 'stopped') return res.status(409).json({ error: 'stopped', stopped: true });
  const out = await ingestAds({ id: String(job._id), workspaceId: job.workspaceId, keyword: job.keyword, country: job.country, projectId: job.projectId || null }, ads);
  const pageIds = uniq((ads || []).map((a) => a && a.pageId));
  await col('jobs').updateOne(
    { _id: job._id },
    { $inc: { adsSeen: out.ads }, $addToSet: { pageIds: { $each: pageIds } }, $set: { lastActivity: new Date() } },
  );
  return out;
}));

r.get('/job/:id', ah(async (req) => {
  // asked every few scrolls — also counts as "still working"
  const j = await col('jobs').findOneAndUpdate(
    { _id: oid(req.params.id) },
    [{ $set: { lastActivity: { $cond: [{ $eq: ['$phase', 'collecting'] }, '$$NOW', '$lastActivity'] } } }],
    { projection: { phase: 1 }, returnDocument: 'after' },
  );
  return { phase: j ? j.phase : 'stopped' };
}));

r.post('/collect-done', ah(async (req) => {
  const { jobId, reason, stats } = req.body || {};
  const set = { phase: 'collected', collectedAt: new Date(), note: String(reason || '').slice(0, 100) };
  if (stats && typeof stats === 'object') {
    set.captured = Number(stats.captured) || 0;
    set.pagesTotal = Number(stats.pagesTotal) || 0;
    set.pagesMatched = Number(stats.pagesMatched) || 0;
    set.minAds = Math.max(1, Number(stats.minAds) || 1);
  }
  const j = await col('jobs').findOneAndUpdate({ _id: oid(jobId), phase: 'collecting' }, { $set: set }, { returnDocument: 'after' });
  if (j) {
    const pages = (j.pageIds || []).length;
    const closed = reason === 'tab closed' ? ' (tab was closed)' : '';
    const msg =
      j.minAds > 1
        ? `"${j.keyword}" collected — ${j.captured} ads; ${j.pagesMatched} of ${j.pagesTotal} pages run ${j.minAds}+ ads. Only those were kept${closed}`
        : `"${j.keyword}" collected — ${pages} pages from ${j.adsSeen || 0} ads${closed}`;
    await activity('collected', msg, { workspaceId: j.workspaceId, projectId: j.projectId });
  }
  return { ok: true };
}));

r.get('/next-scrape', ah(async (req) => {
  const s = await getSettings();
  if (!s.running) return { lead: null, reason: s.pausedReason || 'paused', parallel: s.parallel };
  if (Number(req.query.slot) >= s.parallel) return { lead: null, reason: 'slot-off', parallel: s.parallel };
  if (s.cooldownUntil && new Date(s.cooldownUntil) > new Date()) {
    return { lead: null, reason: `waiting until ${fmtTime(s.cooldownUntil)} (Facebook login wall)`, parallel: s.parallel };
  }
  const doneToday = await visitsToday();
  if (doneToday >= s.dailyLimit) return { lead: null, reason: 'daily-limit', doneToday, parallel: s.parallel };
  const stale = await col('pages').find({ scrapeStatus: 'working', claimedAt: { $lt: new Date(Date.now() - STALE_WORK_MS) } }).project({ pageId: 1 }).toArray();
  if (stale.length) {
    await col('pages').updateMany({ pageId: { $in: stale.map((p) => p.pageId) } }, { $set: { scrapeStatus: 'pending' } });
    await syncLeads(stale.map((p) => p.pageId));
  }
  const p = await col('pages').findOneAndUpdate(
    { scrapeStatus: 'pending' },
    { $set: { scrapeStatus: 'working', claimedAt: new Date() } },
    { sort: { createdAt: 1 }, returnDocument: 'after' },
  );
  if (!p) return { lead: null, reason: 'queue-empty', doneToday, parallel: s.parallel };
  await syncLeads([p.pageId]);
  return {
    lead: { pageId: p.pageId, pageName: p.pageName, url: mainUrl(p) || aboutUrl(p), mainUrl: mainUrl(p) },
    delayMin: s.delayMin, delayMax: s.delayMax, parallel: s.parallel, fullDetails: s.fullDetails, doneToday, dailyLimit: s.dailyLimit,
    proxy: { enabled: Boolean(s.proxyEnabled), host: s.proxyHost || '', port: Number(s.proxyPort) || 44445, user: s.proxyUser || '', pass: s.proxyPass || '' },
  };
}));

r.post('/result', ah(async (req) => {
  const { pageId, result } = req.body || {};
  await applyResult(String(pageId), result || {});
  // a page read fine → the next login wall starts again with the shortest wait
  if (!result?.error) await col('settings').updateOne({ _id: 'main', cooldownMin: { $gt: 0 } }, { $set: { cooldownMin: 0 } });
  const p = await col('pages').findOne({ pageId: String(pageId) }, { projection: { pageName: 1, phones: 1, emails: 1, whatsapp: 1, scrapeStatus: 1, lastError: 1 } });
  if (p) {
    const found = [p.phones?.length && `${p.phones.length} phone`, p.whatsapp?.length && 'WhatsApp', p.emails?.length && `${p.emails.length} email`].filter(Boolean);
    const name = p.pageName || pageId;
    if (p.scrapeStatus === 'done') await pageActivity(p.pageId, found.length ? 'found' : 'empty', found.length ? `${name} — found ${found.join(', ')}` : `${name} — no contact info`);
    else if (p.scrapeStatus === 'failed') await pageActivity(p.pageId, 'failed', `${name} — could not be read after 3 tries (${p.lastError})`);
  }
  return { ok: true };
}));

const FIRST_WAIT_MIN = 30;
const MAX_WAIT_MIN = 240;
const PAGE_WALLS_BEFORE_SKIP = 3;
const fmtTime = (d) => new Date(d).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

/**
 * Facebook showed its login wall instead of the page (it does that when one IP opens pages quickly without
 * logging in). We don't push through it: the worker waits — 30 min, then 60, 120, up to 4 h if it keeps
 * happening — and continues by itself. A page that keeps asking for a login on its own is skipped.
 */
r.post('/wall', ah(async (req) => {
  const pageId = String(req.body?.pageId || '');
  if (pageId) {
    const p = await col('pages').findOneAndUpdate(
      { pageId },
      { $set: { scrapeStatus: 'pending', updatedAt: new Date() }, $inc: { loginWalls: 1 } },
      { returnDocument: 'after' },
    );
    if (p && p.loginWalls >= PAGE_WALLS_BEFORE_SKIP) {
      await col('pages').updateOne({ pageId }, { $set: { scrapeStatus: 'failed', lastError: 'Facebook asks to log in for this page' } });
      await pageActivity(pageId, 'failed', `${p.pageName || pageId} — Facebook only shows this page after login, skipped`);
    }
    await syncLeads([pageId]);
  }
  const s = await getSettings();
  if (s.cooldownUntil && new Date(s.cooldownUntil) > new Date()) return { ok: true, until: s.cooldownUntil }; // already waiting
  const wait = Math.min(MAX_WAIT_MIN, s.cooldownMin ? s.cooldownMin * 2 : FIRST_WAIT_MIN);
  const until = new Date(Date.now() + wait * 60e3);
  await col('settings').updateOne({ _id: 'main' }, { $set: { cooldownUntil: until, cooldownMin: wait } }, { upsert: true });
  const pagesBefore = await col('pages').countDocuments({ lastAttemptAt: { $gte: new Date(Date.now() - 60 * 60e3) } });
  await log('warn', `Login wall after ${pagesBefore} pages in the last hour — waiting ${wait} min (until ${fmtTime(until)})`);
  await activity('paused', `Facebook asked for a login — taking a ${wait} min break, continuing by itself at ${fmtTime(until)}`);
  return { ok: true, until };
}));

r.post('/blocked', ah(async (req) => {
  const { pageId, reason } = req.body || {};
  const why = String(reason || 'blocked').slice(0, 200);
  if (pageId) {
    await col('pages').updateOne({ pageId: String(pageId) }, { $set: { scrapeStatus: 'pending' } });
    await syncLeads([String(pageId)]);
  }
  await updateSettings({ running: false, pausedReason: why });
  await log('error', `Paused: ${why}`);
  await activity('paused', `Paused: ${why}`); // system event — every workspace sees it
  return { ok: true };
}));

export default r;
