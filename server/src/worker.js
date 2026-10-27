// API for the Chrome extension (the worker). Mounted at /api/worker, authenticated with WORKER_KEY.
// There is one worker for everybody: it takes searches from every workspace (oldest first) and reads
// each Facebook page once; the result is copied into every workspace that has that page.
import express from 'express';
import { activity, col, log, pageActivity } from './db.js';
import { clampMaxAds, getSettings, updateSettings } from './settings.js';
import { getPc } from './pcs.js';
import { accountOf } from './billing.js';
import { applyResult, ingestAds, syncLeads } from './leads.js';
import { ensureProject, oid } from './projects.js';
import { workerInfo } from './worker-state.js';
import { pickProxy, proxyPool, proxyWorked, restProxy, restProxyBriefly } from './proxies.js';
import { claimPage, releasePage, wallOnPage } from './pageQueue.js';
import { aboutUrl, mainUrl, startOfToday, uniq } from './util.js';

const r = express.Router();
const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).then((out) => out !== undefined && !res.headersSent && res.json(out)).catch(next);

// The Ad Library tab reports every few seconds (ads, or a status check every 3 scrolls). Silent this long =
// the tab was closed, crashed or lost the extension (docs/ENGINE.md §4 #10).
export const COLLECT_SILENT_WARN_MS = 60 * 1000; // the Dashboard shows "not responding"
export const STALE_COLLECT_MS = 3 * 60 * 1000; // the search is closed with what arrived
export const SEARCH_GAP_MS = 30 * 1000; // short break between two searches on one computer (the owner wants no long waits)
// Gentle mode, per computer (admin: Settings → Worker → Computers): for a server/datacenter IP that Facebook
// limits sooner. It asks Facebook less and more slowly and, when told to slow down, rests instead of retrying -
// it follows the limit, it does not try to get around it. Normal computers are not affected.
/** Why this computer is not starting the next search yet (shown on the Searches page) - cleared when it starts one. */
const noteWait = (pcId, why, until) => col('pcs').updateOne({ _id: pcId }, { $set: { waitWhy: why, waitUntil: until } }).catch(() => {});

export const GENTLE = {
  maxAds: 2000, // per search
  gapMs: 10 * 60e3, // between two searches
  restAfterLimitMs: 60 * 60e3, // no new search for an hour after Facebook said "slow down"
  pageDelay: [8000, 14000], // between two pages of ads
  breakEvery: 20, // pages
  breakMs: [120000, 180000],
  limitWaits: [5, 10], // minutes; still limited after these: the search ends with what it has
};

// The pace of a normal computer (home internet), sent with every search — the extension (v3.6+) uses it instead of
// its own built-in slower pace (3–6 s a page, a 60–90 s break every 40 pages, up to ~1 h of waiting on "slow down"),
// which halved the ads per minute. This is the speed of v3.5.1 (1.5–3.5 s a page) with a short break now and then.
// On "Rate limit exceeded" it waits 2 min, then 5 min; still limited: the search ends with what it has (instead of
// waiting an hour for a few more ads) and that computer rests (LIMIT_REST_MS) so another one can take the next search.
export const NORMAL = {
  pageDelay: [1500, 3500],
  breakEvery: 100,
  breakMs: [20000, 40000],
  limitWaits: [2, 5],
};
/** After "slow down" a computer takes no new search for this long (another computer of the account can). */
export const LIMIT_REST_MS = 30 * 60e3;
export const paceFor = (pc) => (pc?.gentle === true ? GENTLE : NORMAL);
export const limitRestMs = (pc) => (pc?.gentle === true ? GENTLE.restAfterLimitMs : LIMIT_REST_MS);

/** Searches whose Ad Library tab went silent: closed with everything collected so far (called every minute). */
export async function closeStaleCollects() {
  const stale = await col('jobs').find({ phase: 'collecting', lastActivity: { $lt: new Date(Date.now() - STALE_COLLECT_MS) } }).toArray();
  for (const j of stale) {
    const done = await col('jobs').findOneAndUpdate(
      { _id: j._id, phase: 'collecting' },
      { $set: { phase: 'collected', collectedAt: new Date(), note: 'tab stopped responding' } },
    );
    if (!done) continue;
    const pages = (j.pageIds || []).length;
    await activity('failed', `"${j.keyword}" — the Ad Library tab stopped responding, so collecting ended with ${pages} pages from ${j.adsSeen || 0} ads. Press "Collect more ads" to continue.`, { workspaceId: j.workspaceId, projectId: j.projectId });
  }
  return stale.length;
}

/** Page visits today — failed attempts count too, Facebook saw them. */
const visitsToday = () => col('pages').countDocuments({ lastAttemptAt: { $gte: startOfToday() } });

/** Manual "Collect this search" from the Ad Library panel goes to the first admin's workspace. */
async function operatorWorkspace() {
  const u = await col('users').findOne({ role: 'admin', disabled: { $ne: true } }, { sort: { createdAt: 1 }, projection: { workspaceId: 1 } });
  return u?.workspaceId || null;
}

// popup: overall numbers — a customer's extension gets only that account's own numbers (never the whole
// service's, and never the proxy list: it would carry the proxy password)
r.get('/status', ah(async (req) => {
  if (req.workerWs) {
    const ws = req.workerWs;
    const today = new Date(new Date().setHours(0, 0, 0, 0));
    const [leads, waiting, readToday, searches, acc] = await Promise.all([
      col('leads').countDocuments({ workspaceId: ws }),
      col('leads').countDocuments({ workspaceId: ws, scrapeStatus: { $in: ['pending', 'working'] } }),
      col('leads').countDocuments({ workspaceId: ws, chargedAt: { $gte: today } }),
      col('jobs').countDocuments({ workspaceId: ws, phase: { $in: ['queued', 'collecting'] } }),
      accountOf(ws),
    ]);
    return { customer: true, leads, waiting, readToday, searches, credits: acc.unlimited ? null : acc.credits, running: true };
  }
  const s = await getSettings();
  const [pages, pending, doneToday, queuedJobs, collecting] = await Promise.all([
    col('pages').countDocuments({}),
    col('pages').countDocuments({ scrapeStatus: { $in: ['pending', 'working'] } }),
    visitsToday(),
    col('jobs').countDocuments({ phase: 'queued' }),
    col('jobs').countDocuments({ phase: 'collecting' }),
  ]);
  const pick = await pickProxy(proxyPool(s)); // just a look — nothing is marked as used
  return {
    pages, pending, doneToday, dailyLimit: s.dailyLimit, maxAds: s.maxAds, queuedJobs, collecting, running: s.running, pausedReason: s.pausedReason, worker: await workerInfo(),
    proxy: pick.proxy || { enabled: false },
  };
}));

/**
 * Whose searches this extension runs: a customer's own extension → only that account's; the team's computers
 * (WORKER_KEY) → only the team's own (internal-plan) accounts. A customer's search never opens on another
 * customer's — or the team's — computer.
 */
async function searchScope(req) {
  if (req.workerWs) return { workspaceId: req.workerWs };
  const internal = await col('workspaces').find({ plan: 'internal' }).project({ _id: 1 }).toArray();
  return { workspaceId: { $in: internal.map((w) => w._id) } };
}
/** A customer's extension may only touch its own account's searches (a filter to add to every job query). */
const mine = (req) => (req.workerWs ? { workspaceId: req.workerWs } : {});

// Extensions older than this get no searches to collect: older ones could ask Facebook endlessly for empty
// pages and asked as the person's own Facebook account (which got an account limited for hours).
export const MIN_COLLECT_VERSION = '3.5.5';
const versionNum = (v) => String(v || '0').split('.').map((x) => Number(x) || 0).reduce((a, x) => a * 1000 + x, 0) * (String(v || '').split('.').length === 3 ? 1 : 0);
export const canCollect = (v) => versionNum(v) >= versionNum(MIN_COLLECT_VERSION);
const OUTDATED = `This extension is outdated — download version ${MIN_COLLECT_VERSION} or newer from the Connect page, then press Reload in chrome://extensions`;
const extVersion = (req) => String(req.get('x-ext-version') || '');

r.get('/next-collect', ah(async (req) => {
  if (!canCollect(extVersion(req))) return { job: null, reason: OUTDATED };
  const s = await getSettings();
  if (!s.running) return { job: null, reason: s.pausedReason || 'paused' };
  // a computer the admin set to "doesn't run Dashboard searches" (Settings → Worker → Computers)
  const pc = req.pcId ? await getPc(req.pcId) : null;
  if (pc && pc.takeQueue === false) return { job: null, reason: 'this PC does not run Dashboard searches' };
  const now = new Date();
  await closeStaleCollects();
  const scope = await searchScope(req);
  // one search at a time per account (per scope) — the next starts when this one is collected
  if (await col('jobs').findOne({ phase: 'collecting', manual: { $ne: true }, ...scope })) return { job: null, reason: 'busy' };
  // a short break between two searches on the same computer: searches started back to back made Facebook
  // answer "Rate limit exceeded" (sooner on server/datacenter IPs)
  const gentle = pc?.gentle === true;
  // Facebook said "slow down" to this computer a short while ago (any computer, not only Gentle ones): it rests,
  // so the next search goes to another computer of the account instead of waiting on this IP's limit
  if (pc?.limitedAt && Date.now() - new Date(pc.limitedAt).getTime() < limitRestMs(pc)) {
    const until = new Date(new Date(pc.limitedAt).getTime() + limitRestMs(pc));
    await noteWait(req.pcId, 'rest', until);
    return { job: null, reason: `resting after Facebook asked to slow down - next search after ${fmtTime(until)}` };
  }
  if (req.pcId) {
    const since = new Date(Date.now() - (gentle ? GENTLE.gapMs : SEARCH_GAP_MS));
    const recent = await col('jobs').findOne({ collector: req.pcId, $or: [{ collectedAt: { $gt: since } }, { stoppedAt: { $gt: since } }] }, { projection: { collectedAt: 1, stoppedAt: 1 } });
    if (recent) {
      const ended = Math.max(new Date(recent.collectedAt || 0).getTime(), new Date(recent.stoppedAt || 0).getTime());
      await noteWait(req.pcId, 'gap', new Date(ended + (gentle ? GENTLE.gapMs : SEARCH_GAP_MS)));
      return { job: null, reason: 'a short break between searches (Facebook limits fast searching)' };
    }
  }
  if (req.pcId) await noteWait(req.pcId, null, null); // free to start: no wait to show
  const j = await col('jobs').findOneAndUpdate(
    { phase: 'queued', ...scope },
    { $set: { phase: 'collecting', startedAt: now, lastActivity: now, collector: req.pcId || null } },
    { sort: { createdAt: 1 }, returnDocument: 'after' },
  );
  if (!j) return { job: null, reason: 'no-jobs' };
  await activity('collect', `Opened the Ad Library: "${j.keyword}" — collecting ads`, { workspaceId: j.workspaceId, projectId: j.projectId });
  const maxAds = gentle ? Math.min(j.maxAds || s.maxAds, GENTLE.maxAds) : j.maxAds || s.maxAds;
  return { job: { id: String(j._id), keyword: j.keyword, country: j.country, maxAds, minAds: j.minAds || 1, url: j.url, projectId: j.projectId ? String(j.projectId) : null, pace: paceFor(pc) }, closeAdTab: s.closeAdTab };
}));

r.post('/manual-job', ah(async (req, res) => {
  if (!canCollect(extVersion(req))) return res.status(426).json({ error: OUTDATED });
  // a customer's extension saves into that customer's account; the team's computers into the team's
  const ws = req.workerWs || (await operatorWorkspace());
  if (!ws) return res.status(409).json({ error: 'Create an admin account on the server first' });
  const b = req.body || {};
  const s = await getSettings();
  const now = new Date();
  const keyword = String(b.keyword || '').trim().slice(0, 200) || '(page search)';
  const country = String(b.country || 'ALL').toUpperCase().slice(0, 5);
  // a customer's plan limits apply here too: its max ads, and "N+ ads per page" only on a plan that has it
  const acc = await accountOf(ws);
  const doc = {
    workspaceId: ws, keyword, country,
    maxAds: Math.min(clampMaxAds(b.maxAds, acc.unlimited ? s.maxAds : acc.maxAdsPerSearch), acc.maxAdsPerSearch),
    minAds: acc.minAdsFilter ? Math.max(1, Number(b.minAds) || 1) : 1,
    projectId: await ensureProject(ws, keyword, country), url: String(b.url || '').slice(0, 2000), phase: 'collecting', manual: true, collector: req.pcId || null,
    adsSeen: 0, pageIds: [], createdAt: now, startedAt: now, lastActivity: now,
  };
  const { insertedId } = await col('jobs').insertOne(doc);
  // the same keyword still waiting in the queue would collect these ads a second time — this one replaces it
  const kw = new RegExp(`^\\s*${keyword.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'i');
  await col('jobs').deleteMany({ workspaceId: ws, country, phase: 'queued', keyword: kw });
  await activity('collect', `Manual collect from the Ad Library: "${keyword}"`, { workspaceId: ws, projectId: doc.projectId });
  // the same pace as a search from the Dashboard (without it the extension used its own slower one)
  const pc = req.pcId ? await getPc(req.pcId) : null;
  return { job: { id: String(insertedId), keyword: doc.keyword, country: doc.country, maxAds: doc.maxAds, minAds: doc.minAds, url: doc.url, manual: true, projectId: String(doc.projectId), pace: paceFor(pc) } };
}));

r.post('/ads', ah(async (req, res) => {
  const { jobId, ads } = req.body || {};
  const job = await col('jobs').findOne({ _id: oid(jobId), ...mine(req) });
  if (!job) return res.status(404).json({ error: 'Job not found' });
  if (job.phase === 'stopped') return res.status(409).json({ error: 'stopped', stopped: true });
  const out = await ingestAds({ id: String(job._id), workspaceId: job.workspaceId, keyword: job.keyword, country: job.country, projectId: job.projectId || null }, ads);
  const pageIds = uniq((ads || []).map((a) => a && a.pageId));
  await col('jobs').updateOne(
    { _id: job._id },
    // new ads arrived: whatever held the search up (a note) is over
    { $inc: { adsSeen: out.ads }, $addToSet: { pageIds: { $each: pageIds } }, $set: { lastActivity: new Date(), stuckNote: '' } },
  );
  return out;
}));

/** The Ad Library panel after collecting: how far the server is with reading this search's pages. */
r.get('/job/:id/progress', ah(async (req, res) => {
  const j = await col('jobs').findOne({ _id: oid(req.params.id), ...mine(req) }, { projection: { workspaceId: 1, projectId: 1, phase: 1, pageIds: 1 } });
  if (!j) return res.status(404).json({ error: 'Search not found' });
  const ids = j.pageIds || [];
  const leads = { workspaceId: j.workspaceId, pageId: { $in: ids } };
  const [read, withContact] = await Promise.all([
    col('leads').countDocuments({ ...leads, scrapeStatus: { $in: ['done', 'failed'] } }),
    col('leads').countDocuments({ ...leads, $or: [{ 'phones.0': { $exists: true } }, { 'emails.0': { $exists: true } }, { 'whatsapp.0': { $exists: true } }] }),
  ]);
  return { phase: j.phase, pages: ids.length, read, withContact, projectId: j.projectId ? String(j.projectId) : null };
}));

r.get('/job/:id', ah(async (req) => {
  // asked every few scrolls — also counts as "still working"
  // ?hidden=1: the Ad Library tab is in the background — Facebook loads no more ads there until it is in front
  const hidden = req.query.hidden === '1';
  // ?note=…: the tab can't get more ads and says why (Facebook's own error) — shown on the search
  const note = String(req.query.note || '').slice(0, 200);
  // Facebook said "slow down" on this computer: in Gentle mode it then rests an hour before the next search
  if (req.pcId && /rate limit/i.test(note)) await col('pcs').updateOne({ _id: req.pcId }, { $set: { limitedAt: new Date() } });
  const j = await col('jobs').findOneAndUpdate(
    { _id: oid(req.params.id), ...mine(req) },
    [
      {
        $set: {
          lastActivity: { $cond: [{ $eq: ['$phase', 'collecting'] }, '$$NOW', '$lastActivity'] },
          tabHidden: { $cond: [{ $eq: ['$phase', 'collecting'] }, hidden, false] },
          // a plain check-in (no note) keeps the last note — the 30 s check-ins during a long wait used to erase it;
          // the note is cleared when new ads arrive (POST /ads)
          stuckNote: { $cond: [{ $and: [{ $eq: ['$phase', 'collecting'] }, { $gt: [{ $literal: note }, ''] }] }, { $literal: note }, '$stuckNote'] },
        },
      },
    ],
    { projection: { phase: 1 }, returnDocument: 'after' },
  );
  return { phase: j ? j.phase : 'stopped' };
}));

/**
 * The Ad Library tab was reloaded (e.g. after the extension was updated) and asks to go on with its search.
 * Allowed while the search is still collecting, or if it was closed because the tab went silent (≤ 1 h ago).
 */
r.post('/job/:id/resume', ah(async (req, res) => {
  const j = await col('jobs').findOneAndUpdate(
    {
      _id: oid(req.params.id),
      ...mine(req),
      $or: [{ phase: 'collecting' }, { phase: 'collected', note: 'tab stopped responding', collectedAt: { $gt: new Date(Date.now() - 3600e3) } }],
    },
    // collecting goes on → it is announced again when it is really done
    { $set: { phase: 'collecting', lastActivity: new Date() }, $unset: { collectedAt: '', note: '', notifiedAt: '' } },
    { returnDocument: 'after' },
  );
  if (!j) return res.status(409).json({ error: 'This search has ended — start "Collect this search" again' });
  await activity('collect', `"${j.keyword}" — the Ad Library tab is back, collecting goes on`, { workspaceId: j.workspaceId, projectId: j.projectId });
  const pc = req.pcId ? await getPc(req.pcId) : null;
  const gentle = pc?.gentle === true;
  return { job: { id: String(j._id), keyword: j.keyword, country: j.country, maxAds: gentle ? Math.min(j.maxAds, GENTLE.maxAds) : j.maxAds, minAds: j.minAds || 1, url: j.url, manual: !!j.manual, projectId: j.projectId ? String(j.projectId) : null, pace: paceFor(pc) } };
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
  const j = await col('jobs').findOneAndUpdate({ _id: oid(jobId), phase: 'collecting', ...mine(req) }, { $set: set }, { returnDocument: 'after' });
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

/** Pages are read on the server (serverReader.js) when there's a proxy list — the extension only collects ads. */
export const serverReads = (s, pool = proxyPool(s)) => s.serverReader !== false && pool.length > 0;
const OFF = { enabled: false };

r.get('/next-scrape', ah(async (req) => {
  const s = await getSettings();
  const pool = proxyPool(s);
  const onServer = serverReads(s, pool);
  // Chrome has one proxy setting for every tab, so with a proxy pool pages are read one at a time
  // (each through its own IP) — the IPs share the load instead of the tabs
  const parallel = onServer || pool.length > 1 ? 1 : s.parallel;
  if (!s.running) return { lead: null, reason: s.pausedReason || 'paused', parallel };
  if (Number(req.query.slot) >= parallel) return { lead: null, reason: 'slot-off', parallel };
  // a customer's Chrome that got a login wall / checkpoint rests on its own (customerRest) — nobody else waits
  if (req.workerWs && req.pcId) {
    const pc = await getPc(req.pcId);
    if (pc?.readRestUntil && new Date(pc.readRestUntil) > new Date()) {
      return { lead: null, reason: `waiting until ${fmtTime(pc.readRestUntil)} (${pc.readRestWhy || 'Facebook login wall'})`, parallel, proxy: OFF };
    }
  }
  if (s.cooldownUntil && new Date(s.cooldownUntil) > new Date()) {
    return { lead: null, reason: `waiting until ${fmtTime(s.cooldownUntil)} (Facebook login wall)`, parallel };
  }
  const doneToday = await visitsToday();
  if (doneToday >= s.dailyLimit) return { lead: null, reason: 'daily-limit', doneToday, parallel };
  if (onServer) {
    // the server reads pages itself; Chrome only gets the few whose Intro card isn't in the HTML — without the proxy
    if (s.browserCooldownUntil && new Date(s.browserCooldownUntil) > new Date()) {
      return { lead: null, reason: `Chrome waits until ${fmtTime(s.browserCooldownUntil)} (login wall) — the server goes on reading`, parallel, proxy: OFF };
    }
    const p = await claimPage('chrome', { forChrome: true, wantedBy: req.workerWs });
    if (!p) return { lead: null, reason: 'pages are read on the server', doneToday, parallel, proxy: OFF };
    return {
      lead: { pageId: p.pageId, pageName: p.pageName, url: mainUrl(p) || aboutUrl(p), mainUrl: mainUrl(p) },
      delayMin: s.delayMin, delayMax: s.delayMax, parallel, fullDetails: s.fullDetails, doneToday, dailyLimit: s.dailyLimit, proxy: OFF,
    };
  }
  // a customer's own Chrome never gets the team's proxies (their login data would be in its hands)
  if (req.workerWs) return { lead: null, reason: 'pages are read on the server', doneToday, parallel, proxy: OFF };
  const pick = await pickProxy(pool);
  if (pick.waitUntil) return { lead: null, reason: `every proxy IP is resting until ${fmtTime(pick.waitUntil)} (login walls)`, parallel };
  const p = await claimPage('chrome', { wantedBy: req.workerWs });
  if (!p) return { lead: null, reason: 'queue-empty', doneToday, parallel, proxy: pick.proxy };
  const { proxy } = await pickProxy(pool, { take: true });
  return {
    lead: { pageId: p.pageId, pageName: p.pageName, url: mainUrl(p) || aboutUrl(p), mainUrl: mainUrl(p) },
    delayMin: s.delayMin, delayMax: s.delayMax, parallel, fullDetails: s.fullDetails, doneToday, dailyLimit: s.dailyLimit,
    proxy,
  };
}));

// ---------------- a customer's own extension (ext_ key) ----------------
// Pages are shared by every customer, and pausing/cooldowns affect the whole service. So a customer's
// extension may only report on a page its own Chrome is reading right now (given to it by /next-scrape),
// and its login walls / checkpoints rest only that computer — never the team's readers or the service.
export const CUSTOMER_WALL_REST_MIN = 30;
export const CUSTOMER_BLOCK_REST_MIN = 60;

/** True when this request may report on the page: the team's key always; a customer only for its own claim. */
async function ownsClaim(req, pageId) {
  if (!req.workerWs) return true;
  if (!pageId) return false;
  const p = await col('pages').findOne(
    { pageId: String(pageId), scrapeStatus: 'working', claimedBy: 'chrome', claimedFor: req.workerWs },
    { projection: { _id: 1 } },
  );
  return !!p;
}

/** This customer's computer stops reading pages for a while (shown in its popup as the reason). */
async function customerRest(req, minutes, why) {
  const until = new Date(Date.now() + minutes * 60e3);
  if (req.pcId) await col('pcs').updateOne({ _id: req.pcId }, { $set: { readRestUntil: until, readRestWhy: why } }, { upsert: true });
  return until;
}

r.post('/result', ah(async (req) => {
  const { pageId, result, proxyId } = req.body || {};
  if (!(await ownsClaim(req, pageId))) return { ok: false, ignored: 'not a page this extension is reading' };
  // a customer's Chrome never has the team's proxies
  await recordResult(String(pageId), result || {}, req.workerWs ? null : proxyId);
  return { ok: true };
}));

/** A page was read (by the extension or the server): save it, credit the IP, tell the workspaces. */
export async function recordResult(pageId, result, proxyId) {
  await applyResult(String(pageId), result || {});
  // read now — no longer one for Chrome
  await col('pages').updateOne({ pageId: String(pageId), needsBrowser: true, scrapeStatus: { $ne: 'pending' } }, { $unset: { needsBrowser: '' } });
  if (proxyId && !result?.error) await proxyWorked(String(proxyId));
  // a page read fine → the next login wall starts again with the shortest wait
  if (!result?.error) await col('settings').updateOne({ _id: 'main', cooldownMin: { $gt: 0 } }, { $set: { cooldownMin: 0 } });
  const p = await col('pages').findOne({ pageId: String(pageId) }, { projection: { pageName: 1, phones: 1, emails: 1, whatsapp: 1, scrapeStatus: 1, lastError: 1 } });
  if (p) {
    const found = [p.phones?.length && `${p.phones.length} phone`, p.whatsapp?.length && 'WhatsApp', p.emails?.length && `${p.emails.length} email`].filter(Boolean);
    const name = p.pageName || pageId;
    if (p.scrapeStatus === 'done') await pageActivity(p.pageId, found.length ? 'found' : 'empty', found.length ? `${name} — found ${found.join(', ')}` : `${name} — no contact info`);
    else if (p.scrapeStatus === 'failed') await pageActivity(p.pageId, 'failed', `${name} — could not be read after 3 tries (${p.lastError})`);
  }
}

const FIRST_WAIT_MIN = 30;
const MAX_WAIT_MIN = 240;
const fmtTime = (d) => new Date(d).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

/**
 * Facebook showed its login wall instead of the page (it does that when one IP opens pages quickly without
 * logging in). We don't push through it: the worker waits — 30 min, then 60, 120, up to 4 h if it keeps
 * happening — and continues by itself. A page that keeps asking for a login on its own is skipped.
 */
r.post('/wall', ah(async (req) => {
  const pageId = String(req.body?.pageId || '');
  if (req.workerWs) {
    if (!(await ownsClaim(req, pageId))) return { ok: false, ignored: 'not a page this extension is reading', until: null };
    // the page goes back to the queue as usual; only this customer's computer takes the break
    await wallOnPage(pageId, { pool: proxyPool(await getSettings()).length });
    const until = await customerRest(req, CUSTOMER_WALL_REST_MIN, 'Facebook login wall');
    await log('warn', `Login wall in a customer's Chrome (${req.workerUser?.email || req.workerWs}) — that computer waits ${CUSTOMER_WALL_REST_MIN} min`);
    return { ok: true, until };
  }
  return recordWall(pageId, String(req.body?.proxyId || ''), { fromBrowser: true });
}));

/** Returns { until } — when the worker continues (null = right away, with the next IP). */
export async function recordWall(pageId, proxyId, { fromBrowser = false } = {}) {
  const s = await getSettings();
  const pool = proxyPool(s);
  const inPool = proxyId && pool.some((p) => p.id === proxyId);
  // the IP first: it rests (12 h when it is bad) — and a bad IP's wall says nothing about the page
  const ip = inPool ? await restProxy(pool, proxyId) : null;
  // the page goes back to the queue — or is given up after walls on too many (good) IPs
  if (pageId) await wallOnPage(pageId, { pool: pool.length, count: !ip?.wasBad });
  // pages are read on the server and Chrome (no proxy, this PC's own IP) got the wall: only Chrome takes the
  // break — the server's IPs are not affected
  if (fromBrowser && !proxyId && serverReads(s, pool)) {
    const wait = 30;
    const until = new Date(Date.now() + wait * 60e3);
    await col('settings').updateOne({ _id: 'main' }, { $set: { browserCooldownUntil: until } }, { upsert: true });
    await log('warn', `Login wall in Chrome (this PC's own IP) — Chrome waits ${wait} min; the server goes on reading`);
    return { ok: true, until };
  }
  // proxy pool: only the IP that got the wall rests; the worker goes on with the next IP
  if (inPool) {
    const out = ip;
    const why = out.nowBad ? ' (a bad IP: Facebook asks it to log in most of the time — replace it in Webshare)' : '';
    await log('warn', `Login wall on proxy ${proxyId} — that IP rests ${out.wait} min${why}; ${out.left} of ${pool.length} IPs still working`);
    if (!out.allResting) return { ok: true, until: null };
    await activity('paused', `Facebook asked for a login on every proxy IP — continuing by itself at ${fmtTime(out.waitUntil)}`);
    return { ok: true, until: out.waitUntil };
  }
  if (s.cooldownUntil && new Date(s.cooldownUntil) > new Date()) return { ok: true, until: s.cooldownUntil }; // already waiting
  const wait = Math.min(MAX_WAIT_MIN, s.cooldownMin ? s.cooldownMin * 2 : FIRST_WAIT_MIN);
  const until = new Date(Date.now() + wait * 60e3);
  await col('settings').updateOne({ _id: 'main' }, { $set: { cooldownUntil: until, cooldownMin: wait, cooldownReason: 'Facebook asked for a login' } }, { upsert: true });
  const pagesBefore = await col('pages').countDocuments({ lastAttemptAt: { $gte: new Date(Date.now() - 60 * 60e3) } });
  await log('warn', `Login wall after ${pagesBefore} pages in the last hour — waiting ${wait} min (until ${fmtTime(until)})`);
  await activity('paused', `Facebook asked for a login — taking a ${wait} min break, continuing by itself at ${fmtTime(until)}`);
  return { ok: true, until };
}

r.post('/net-error', ah(async (req) => {
  if (req.workerWs) {
    const pageId = String(req.body?.pageId || '');
    if (!(await ownsClaim(req, pageId))) return { ok: false, ignored: 'not a page this extension is reading' };
    await recordNetError(pageId, '', String(req.body?.error || 'network error').slice(0, 100));
    return { ok: true };
  }
  await recordNetError(String(req.body?.pageId || ''), String(req.body?.proxyId || ''), String(req.body?.error || 'network error').slice(0, 100));
  return { ok: true };
}));

/** The page never loaded (network / proxy error). Back in the queue, no retry used; a proxy IP rests 10 min. */
export async function recordNetError(pageId, proxyId, error) {
  if (pageId) await releasePage(pageId);
  const pool = proxyPool(await getSettings());
  if (proxyId && pool.some((p) => p.id === proxyId)) {
    const { dead } = await restProxyBriefly(proxyId);
    await log('warn', dead ? `Proxy ${proxyId}: ${error} — failed 10 times in a row, looks dead: it rests 12 h (replace it in the proxy list)` : `Proxy ${proxyId}: ${error} — that IP rests 10 min`);
  } else {
    await log('warn', `Network error while opening a page: ${error}`);
  }
}

r.post('/blocked', ah(async (req) => {
  const { pageId, reason } = req.body || {};
  const why = String(reason || 'blocked').slice(0, 200);
  if (req.workerWs) {
    // a customer's own Facebook / internet trouble: that computer rests, the service keeps running
    if (pageId && (await ownsClaim(req, pageId))) await releasePage(String(pageId));
    const until = await customerRest(req, CUSTOMER_BLOCK_REST_MIN, why);
    await log('warn', `Customer's Chrome stopped (${req.workerUser?.email || req.workerWs}): ${why} — that computer rests ${CUSTOMER_BLOCK_REST_MIN} min`);
    await activity('paused', `This computer stopped reading pages: ${why}. It tries again by itself at ${fmtTime(until)}.`, { workspaceId: req.workerWs });
    return { ok: true, until };
  }
  if (pageId) await releasePage(String(pageId));
  await updateSettings({ running: false, pausedReason: why });
  await log('error', `Paused: ${why}`);
  await activity('paused', `Paused: ${why}`); // system event — every workspace sees it
  return { ok: true };
}));

export default r;
